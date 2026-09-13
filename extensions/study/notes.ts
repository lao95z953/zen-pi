import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export const MAX_NOTE_BYTES = 512 * 1024;
export const LIVE_TTL = 45_000;
export type Note = { path: string; title: string; text: string; score?: number };
const noteCache = new Map<string, { stamp: string; note: Note }>();
export const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex");
export type Focus = { mode: "auto" } | { mode: "manual"; path: string } |
  { mode: "pending"; query: string; candidates: string[] };
export type Intent = { mode: "auto" } | { mode: "manual"; query: string };

export function vaultRoot() {
  const configured = process.env.PI_STUDY_VAULT;
  if (!configured) throw new Error("請設定 PI_STUDY_VAULT 為 Obsidian vault 的絕對路徑。");
  return realpathSync(configured);
}

export function bridgeFile(vault: string, agentDir = join(homedir(), ".pi", "agent")) {
  const id = createHash("sha256").update(realpathSync(vault)).digest("hex").slice(0, 24);
  return join(agentDir, "obsidian", `${id}.json`);
}

function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Resolve both lexical paths and symlinks before reading vault content. */
export function notePath(vault: string, path: string) {
  const root = realpathSync(vault);
  const candidate = resolve(root, path.replace(/^@/, ""));
  if (!inside(root, candidate) || !candidate.toLowerCase().endsWith(".md")) {
    throw new Error("只能讀取筆記庫內的 Markdown 筆記。");
  }
  const real = realpathSync(candidate);
  if (!inside(root, real) || !statSync(real).isFile()) throw new Error("筆記路徑超出筆記庫。");
  return candidate;
}

export function readNote(vault: string, path: string): Note {
  const file = notePath(vault, path);
  if (statSync(file).size > MAX_NOTE_BYTES) throw new Error("筆記超過 512 KiB，請拆成較小的頁面。");
  const text = readFileSync(file, "utf8");
  return { path: relative(vault, file), title: text.match(/^#\s+(.+)$/m)?.[1] || basename(file, ".md"), text };
}

export function listNotes(vault: string): Note[] {
  const notes: Note[] = [];
  const seen = new Set<string>();
  const visit = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.name.startsWith(".") || ["node_modules", "90-模板", "95-腳本", "07-Agent-Wiki"].includes(ent.name)) continue;
      const path = join(dir, ent.name);
      if (ent.isDirectory()) visit(path);
      else if (ent.isFile() && ent.name.endsWith(".md")) {
        if (notes.length >= 2000) throw new Error("筆記數超過 2000，需縮小 PI_STUDY_VAULT 或升級索引。");
        try {
          const stat = statSync(path); const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
          seen.add(path);
          const cached = noteCache.get(path);
          const note = cached?.stamp === stamp ? cached.note : readNote(vault, path);
          noteCache.set(path, { stamp, note }); notes.push(note);
        } catch { /* A removed/oversized file cannot be indexed. */ }
      }
    }
  };
  visit(vault);
  for (const path of noteCache.keys()) if (inside(vault, path) && !seen.has(path)) noteCache.delete(path);
  return notes;
}

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s_&\-]/g, "");
const segmenter = new Intl.Segmenter("zh-TW", { granularity: "word" });
const stopWords = new Set("我 你 的 是 了 在 和 與 就 有 嗎 呢 這 那 現在 目前 為什麼 怎麼 請 幫我 這個 那個 理解 概念 筆記 the a an is of to and why how".split(" "));
const aliases = [
  ["reverse shell", "反向shell", "反彈shell", "反向連線", "回連"],
  ["nat", "網路位址轉換", "网络地址转换"],
  ["smb", "samba", "檔案共享", "文件共享"],
  ["privilege escalation", "提權", "權限提升"],
  ["authentication", "身分驗證", "身份驗證"],
  ["authorization", "授權"],
  ["dns", "域名", "網域名稱"],
  ["kerberos", "票據", "票證"],
];
export function tokens(text: string): string[] {
  return [...segmenter.segment(text.normalize("NFKC").toLowerCase())]
    .filter(s => s.isWordLike && !stopWords.has(s.segment)).map(s => s.segment);
}
function queryTerms(query: string) {
  let expanded = query.toLowerCase();
  const originalTokens = new Set(tokens(expanded));
  for (const group of aliases) {
    if (group.some(alias => /^[a-z]+$/.test(alias) ? originalTokens.has(alias) : expanded.includes(alias))) expanded += ` ${group.join(" ")}`;
  }
  return [...new Set(tokens(expanded))];
}

/** Title/path matching for selection; body matching is only for retrieval. */
export function candidates(notes: Note[], query: string): Note[] {
  const q = norm(query.replace(/^\[\[|\]\]$/g, "").replace(/\.md$/i, ""));
  if (!q) return [];
  const exactPath = notes.filter(n => norm(n.path.replace(/\.md$/i, "")) === q);
  if (exactPath.length) return exactPath;
  const exactTitle = notes.filter(n => norm(n.title) === q || norm(basename(n.path, ".md")) === q);
  if (exactTitle.length) return exactTitle;
  return notes.filter(n => norm(n.path).includes(q) || norm(n.title).includes(q));
}

export function searchNotes(notes: Note[], query: string, limit = 6): Note[] {
  const terms = queryTerms(query);
  const docs = notes.map(n => {
    const words = tokens(`${n.title} ${n.title} ${n.title} ${n.path} ${n.text}`);
    const tf = new Map<string, number>(); for (const word of words) tf.set(word, (tf.get(word) || 0) + 1);
    return { n, tf, length: words.length };
  });
  const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / (docs.length || 1) || 1;
  const idf = new Map(terms.map(t => { const df = docs.filter(d => d.tf.has(t)).length;
    return [t, Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))]; }));
  return docs.map(({ n, tf, length }) => ({ ...n, score: terms.reduce((score, t) => {
    const freq = tf.get(t) || 0;
    return score + (idf.get(t) || 0) * freq * 2.2 / (freq + 1.2 * (0.25 + 0.75 * length / avgLength));
  }, 0) }))
    .filter(n => n.score > 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

/** Offsets refer to the original string, so a snippet can always be checked against its saved record. */
export function matchingSnippet(text: string, maxChars: number, query: string) {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error("片段字數需為正整數。");
  let startOffset = 0;
  const terms = new Set(queryTerms(query));
  const hits = [...segmenter.segment(text)].filter(s => s.isWordLike && tokens(s.segment).some(t => terms.has(t)))
    .map(s => ({ offset: s.index, term: s.segment.normalize("NFKC").toLowerCase() }));
  if (text.length > maxChars && hits.length) {
    let best = -1;
    // At most 200 candidate windows, even for long repetitive notes.
    const stride = Math.max(1, Math.ceil(hits.length / 200));
    for (let i = 0; i < hits.length; i += stride) {
      const start = Math.max(0, Math.min(text.length - maxChars, hits[i].offset - Math.floor(maxChars / 4)));
      const window = hits.filter(hit => hit.offset >= start && hit.offset < start + maxChars);
      const score = new Set(window.map(hit => hit.term)).size * 100 + Math.min(window.length, 10);
      if (score > best) { best = score; startOffset = start; }
    }
    // Prefer a nearby paragraph boundary when it still leaves the selected hit visible.
    const boundary = text.lastIndexOf("\n\n", startOffset);
    if (boundary >= 0 && startOffset - boundary < Math.min(160, maxChars / 10)) startOffset = boundary + 2;
  }
  const endOffset = Math.min(text.length, startOffset + maxChars);
  const firstHit = hits.find(hit => hit.offset >= startOffset && hit.offset < endOffset)?.offset ?? startOffset;
  const headings = [...text.matchAll(/^#{1,6}[^\S\n]+[^\n]+/gm)].filter(heading => heading.index! <= firstHit);
  const heading = headings.at(-1);
  return { content: text.slice(startOffset, endOffset), startOffset, endOffset, totalChars: text.length,
    truncated: startOffset > 0 || endOffset < text.length,
    heading: heading ? { text: heading[0].slice(0, 200), startOffset: heading.index!, truncated: heading[0].length > 200 } : undefined };
}

/** Deliberately narrow fast path. Unusual phrasing is handled by the study_focus tool. */
export function parseIntent(text: string): Intent | undefined {
  const s = text.trim();
  if (/^(?:請|幫我)?(?:切回|恢復|改回)?(?:自動跟隨|跟隨 Obsidian|跟著 Obsidian)(?:[。！!]|$)/i.test(s)) return { mode: "auto" };
  const match = s.match(/^(?:我(?:現在|目前|今天)?(?:正在|在)(?:讀|閱讀|看|寫|編輯|學習)|(?:請)?(?:切換到|切到))\s*(.+)$/s);
  if (!match) return;
  let q = match[1].split(/[，,。！!？?\n]/)[0].trim();
  const linked = q.match(/^\[\[([^\]]+)\]\]/);
  const quoted = q.match(/^[「『"“](.+?)[」』"”]/);
  q = linked?.[1] || quoted?.[1] || q.replace(/(?:的)?(?:那|這|這一|那一)篇(?:筆記)?$/, "").replace(/(?:的)?筆記$/, "");
  q = q.trim();
  if (!q || /^(?:這|那|目前|現在|這一)篇?$/.test(q) || /^(?:哪|什麼)/.test(q)) return;
  return { mode: "manual", query: q };
}

export function selectFocus(notes: Note[], query: string): Focus {
  const matches = candidates(notes, query);
  return matches.length === 1 ? { mode: "manual", path: matches[0].path } :
    { mode: "pending", query, candidates: matches.map(n => n.path).slice(0, 12) };
}

export function liveNote(vault: string, stateFile = bridgeFile(vault), now = Date.now()):
  { note?: Note; status: string; cursorLine?: number } {
  try {
    if (statSync(stateFile).size > MAX_NOTE_BYTES * 2) throw new Error("state too large");
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    if (state.version !== 1 || state.vault !== realpathSync(vault)) throw new Error("wrong vault");
    const age = now - state.updatedAt;
    if (!Number.isFinite(age) || age < -5000 || age > LIVE_TTL || !state.running) {
      return { status: "Obsidian 連線已過期；請開啟筆記庫或指定筆記。" };
    }
    if (!state.path) return { status: "Obsidian 目前沒有開啟 Markdown 筆記。" };
    const disk = readNote(vault, state.path);
    const text = typeof state.text === "string" && state.text.length <= MAX_NOTE_BYTES ? state.text : disk.text;
    return { note: { ...disk, text }, status: state.text === undefined ? "跟隨（已儲存內容）" : "跟隨（編輯器內容）",
      cursorLine: Number.isInteger(state.cursorLine) && state.cursorLine >= 0 ? state.cursorLine : undefined };
  } catch {
    return { status: "尚未連到 Obsidian bridge；可以先用語言或 /study 指定筆記。" };
  }
}

/** A workspace snapshot is a hint, never evidence of a currently open editor. */
export function lastWorkspaceNote(vault: string): string | undefined {
  try {
    const workspace = JSON.parse(readFileSync(join(vault, ".obsidian", "workspace.json"), "utf8"));
    const find = (node: any): string | undefined => {
      if (node?.id === workspace.active && node.state?.type === "markdown") return node.state.state?.file;
      for (const child of node?.children || []) { const path = find(child); if (path) return path; }
    };
    const path = find(workspace.main);
    return path ? readNote(vault, path).path : undefined;
  } catch { return; }
}

export function excerpt(note: Note, maxChars: number, query = "", cursorLine?: number) {
  const lines = note.text.split("\n");
  let start = 0;
  if (note.text.length > maxChars) {
    const terms = queryTerms(query);
    let hit = cursorLine;
    if (hit === undefined) {
      let best = -1;
      for (let i = 0; i < lines.length; i += 24) {
        const words = new Set(tokens(lines.slice(i, i + 48).join("\n")));
        const score = terms.filter(t => words.has(t)).length;
        if (score > best) { best = score; hit = i; }
      }
    }
    start = Math.max(0, Math.min(lines.length - 1, hit || 0) - 12);
  }
  const output: string[] = [];
  let size = 0;
  for (let i = start; i < lines.length; i++) {
    const line = `${i + 1}: ${lines[i]}`;
    if (size + line.length > maxChars) {
      if (output.length === 0) output.push(line.slice(0, maxChars - 1) + "…");
      break;
    }
    output.push(line); size += line.length + 1;
  }
  return { path: note.path, title: note.title, sha256: fingerprint(note.text), startLine: start + 1, totalLines: lines.length,
    truncated: start > 0 || output.length < lines.length || output.some(line => line.endsWith("…")), content: output.join("\n") };
}

export function relatedNotes(notes: Note[], current: Note, query: string): Note[] {
  const linked = new Set<string>();
  for (const m of current.text.matchAll(/\[\[([^\]|#]+)(?:[^\]]*)\]\]/g)) {
    for (const note of candidates(notes, m[1])) linked.add(note.path);
  }
  // A link strengthens a relevant result; unrelated links cannot occupy all three slots.
  return searchNotes(notes.filter(n => n.path !== current.path), `${current.title} ${query}`, notes.length)
    .map(n => ({ ...n, score: (n.score || 0) * (linked.has(n.path) ? 1.25 : 1) }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 3);
}
