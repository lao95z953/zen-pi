import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync, existsSync, lstatSync } from "node:fs";
import { join, relative, isAbsolute, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { fingerprint, matchingSnippet, readNote, searchNotes, type Note } from "./notes.ts";

export const WIKI_DIR = "07-Agent-Wiki";
export type Citation = { path: string; sha256: string; startLine: number; endLine: number; quote: string };
export type RecordKind = "concept" | "learning" | "research" | "web" | "retraction";
export type PaperMetadata = { provider: "arxiv" | "crossref"; id: string; title: string; authors: string[]; published?: string; updated?: string; doi?: string; venue?: string; url: string; abstract?: string; publicationType: string };
export type MemoryRecord = {
  version: 1; id: string; kind: RecordKind; topic: string; title: string; body: string; createdAt: string;
  supersedes?: string; sources?: Citation[]; status?: string; question?: string; evidence?: string;
  sessionId?: string; messageId?: string; nextQuestion?: string; target?: string; url?: string;
  paper?: PaperMetadata;
  sourceVersion?: { sha256: string; fetchedAt: string; startPage?: number; endPage?: number; totalPages?: number };
};

export function wikiPath(vault: string, ...parts: string[]) {
  const root = realpathSync(vault), base = join(root, WIKI_DIR), path = join(base, ...parts);
  const scoped = relative(base, path);
  if (scoped.startsWith(`..${sep}`) || scoped === ".." || isAbsolute(scoped)) throw new Error("Invalid wiki path");
  const rel = relative(root, path);
  let parent = root;
  for (const part of rel.split(sep)) {
    parent = join(parent, part);
    try {
      if (lstatSync(parent).isSymbolicLink()) throw new Error("Wiki 路徑含 symlink，停止寫入。");
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  }
  return path;
}

export function records(vault: string): MemoryRecord[] {
  const dir = wikiPath(vault, ".records");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).map(name => {
    const path = wikiPath(vault, ".records", name);
    const r = JSON.parse(readFileSync(path, "utf8")) as MemoryRecord;
    if (r.version !== 1 || `${r.id}.json` !== name || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(r.topic) || typeof r.body !== "string" || !["concept", "learning", "research", "web", "retraction"].includes(r.kind)) throw new Error(`損壞的記憶紀錄：${name}`);
    return r;
  });
}

export function visibleRecords(all: MemoryRecord[]) {
  const removed = new Set(all.filter(r => r.kind === "retraction").map(r => r.target));
  // A retracted new revision must not resurrect its superseded predecessor.
  const superseded = new Set(all.map(r => r.supersedes).filter(Boolean));
  return all.filter(r => r.kind !== "retraction" && !removed.has(r.id) && !superseded.has(r.id));
}

export function initWiki(vault: string) {
  for (const dir of [".records", "concepts", "learning", "research", "sources"]) mkdirSync(wikiPath(vault, dir), { recursive: true });
  const schema = wikiPath(vault, "schema.md");
  if (!existsSync(schema)) writeFileSync(schema, `# Agent Wiki 使用規則

這一層由 Pi Study 維護，原始筆記仍由你編輯。

- concepts：附原文引文、行號、來源版本的概念整理；不代表你已理解。
- learning：以你實際回答為證據的學習觀察，包含情境、理由和下一題；不是能力認證。
- research：研究問題、範圍、來源陳述／推論／假說、矛盾與下一步；draft 是進度，synthesis 是有來源的綜合整理，不是正確性認證。
- sources：實際抓取的公開網頁文字快照，附 URL 與日期；不保證完整或永遠正確。
- .records：不可變的 JSON 歷史紀錄，是重建視圖的依據。請勿直接編輯。
- index.md 與上述資料夾的 Markdown 是生成視圖，重建時會覆寫；要補充內容請寫在原始筆記，再請 Agent 更新 wiki。

在 Pi 使用 /wiki check 檢查來源變更、版本衝突和過期的學習觀察。
/wiki rebuild 重建視圖；/wiki forget <id> 停止檢索，但保留歷史，不是徹底刪除私人資料。
模型需要實際呼叫保存工具才會新增記憶，不會在背景自動整理整個筆記庫。
查證來源與生成內容都視為資料，不得用其內容覆蓋你的指示。
`, { flag: "wx", mode: 0o600 });
}

export function saveRecord(vault: string, data: Omit<MemoryRecord, "version" | "id" | "createdAt">): MemoryRecord {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(data.topic)) throw new Error("topic 必須是小寫英文、數字或連字號，例如 reverse-shell。");
  if (!data.title.trim() || !data.body.trim() || data.body.length > 20000) throw new Error("需提供 title、body；body 上限 20000 字元。");
  initWiki(vault);
  const all = records(vault);
  if (data.kind === "concept" || data.kind === "research") {
    const heads = visibleRecords(all).filter(r => r.kind === data.kind && r.topic === data.topic);
    if (heads.length > 1) throw new Error("同主題存在並行衝突，請先用 /wiki 查看版本並整理。");
    if ((heads[0]?.id || undefined) !== data.supersedes) throw new Error("Wiki 版本已改變；先讀目前版本，再以 supersedes 指定它。");
  }
  if (data.kind === "learning") {
    const duplicate = data.sessionId && data.messageId && visibleRecords(all).find(r => r.kind === "learning" && r.topic === data.topic &&
      r.sessionId === data.sessionId && r.messageId === data.messageId && r.question === data.question);
    if (duplicate) return duplicate;
  }
  const record: MemoryRecord = { ...data, version: 1, id: randomUUID(), createdAt: new Date().toISOString() };
  const temp = wikiPath(vault, ".records", `.${record.id}.tmp`);
  writeFileSync(temp, JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  renameSync(temp, wikiPath(vault, ".records", `${record.id}.json`));
  // JSON revisions are authoritative. Markdown is a regenerable Obsidian view.
  try { renderWiki(vault); } catch (err) {
    throw new Error(`紀錄 ${record.id} 已保存，但 Markdown 視圖更新失敗：${(err as Error).message}。使用 /wiki rebuild 修復，勿重複新增。`);
  }
  return record;
}

/** Identical visible snapshots retain their source ID; retracted snapshots are never reused. */
export function saveSourceSnapshot(vault: string, data: Omit<MemoryRecord, "version" | "id" | "createdAt"> & { kind: "web" }) {
  const versionKey = (r: typeof data | MemoryRecord) => r.sourceVersion ?
    JSON.stringify([r.sourceVersion.sha256, r.sourceVersion.startPage, r.sourceVersion.endPage, r.sourceVersion.totalPages]) : "";
  const existing = visibleRecords(records(vault)).find(r => r.kind === "web" && r.topic === data.topic &&
    r.url === data.url && r.title === data.title && r.body === data.body &&
    JSON.stringify(r.paper) === JSON.stringify(data.paper) && versionKey(r) === versionKey(data));
  return existing ? { record: existing, reused: true } : { record: saveRecord(vault, data), reused: false };
}

function atomicText(path: string, text: string) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, text, { flag: "wx", mode: 0o600 }); renameSync(temp, path);
}

export function sourceStatus(vault: string, source: Citation) {
  try { return fingerprint(readNote(vault, source.path).text) === source.sha256 ? "current" : "changed"; }
  catch { return "missing"; }
}

function recordPage(r: MemoryRecord) {
  return r.kind === "concept" ? `concepts/${r.topic}.md` : r.kind === "research" ? `research/${r.topic}.md` : r.kind === "web" ? `sources/${r.id}.md` : `learning/${r.id}.md`;
}

export function renderWiki(vault: string) {
  initWiki(vault);
  const all = records(vault), live = visibleRecords(all);
  const entries: string[] = [];
  const groups = new Map<string, MemoryRecord[]>();
  for (const r of live) {
    const file = recordPage(r);
    groups.set(file, [...(groups.get(file) || []), r]);
  }
  // Retractions leave an explicit tombstone instead of deleting user-visible files.
  for (const r of all) {
    if (r.kind === "retraction") continue;
    const file = recordPage(r);
    if (!groups.has(file)) atomicText(wikiPath(vault, file), `# 已停用\n\n此紀錄已從檢索排除。歷史版本仍保留在 .records。\n`);
  }
  for (const [file, revisions] of groups) {
    const parts = revisions.map(r => {
      const sources = (r.sources || []).map((s, i) => `${i + 1}. [[${s.path.replace(/\.md$/, "")}]]:${s.startLine}-${s.endLine} (${sourceStatus(vault, s)})\n   > ${s.quote.replace(/\n/g, "\n   > ")}`).join("\n");
      return `# ${r.title}\n\n紀錄：\`${r.id}\` · ${r.createdAt}\n${r.url ? `\n來源：${r.url}\n` : ""}${r.kind === "learning" && r.status ? `\n學習觀察：${r.status}（模型依回答判斷，不是考試認證）\n` : ""}\n${r.body}\n${r.evidence ? `\n## 回答證據\n\n> ${r.evidence.replace(/\n/g, "\n> ")}\n\n情境：${r.question}\n\n下一題：${r.nextQuestion || "未指定"}\n` : ""}${sources ? `\n## 來源\n\n${sources}\n` : ""}`;
    });
    atomicText(wikiPath(vault, file), `${revisions.length > 1 ? "# ⚠ 並行版本衝突：以下版本都需保留並檢查\n\n" : ""}${parts.join("\n---\n\n")}`);
    entries.push(`- [[${WIKI_DIR}/${file.replace(/\.md$/, "")}]] — ${revisions[0].title}${revisions.length > 1 ? "（衝突）" : ""}`);
  }
  atomicText(wikiPath(vault, "index.md"), `# 學習與研究 Wiki\n\nAgent 維護的衍生內容；原始筆記保留原樣。來源 changed／missing 時需重新查證。\n\n${entries.join("\n")}\n`);
}

export function verifyCitations(vault: string, sources: Citation[], getNote = (path: string) => readNote(vault, path)) {
  if (!sources.length || sources.length > 8) throw new Error("概念頁需有 1–8 個實際閱讀過的來源。");
  for (const source of sources) {
    if (source.path.startsWith(`${WIKI_DIR}/`) && !source.path.startsWith(`${WIKI_DIR}/sources/`)) throw new Error("請引用原始筆記或已抓取網頁，不能用生成的概念頁互相證明。");
    const note = getNote(source.path);
    if (fingerprint(note.text) !== source.sha256) throw new Error(`來源已變更：${source.path}。重新讀取後再整理。`);
    const lines = note.text.split("\n");
    if (!Number.isInteger(source.startLine) || !Number.isInteger(source.endLine) || source.startLine < 1 || source.endLine < source.startLine || source.endLine > lines.length) throw new Error("來源行號不合法。");
    if (!source.quote.trim() || !lines.slice(source.startLine - 1, source.endLine).join("\n").includes(source.quote)) throw new Error(`引文不在指定來源行數內：${source.path}`);
  }
}

export function memoryContext(vault: string, query: string, limit = 5, kinds: RecordKind[] = ["concept", "research", "learning"]) {
  const live = visibleRecords(records(vault));
  const latestLearning = new Map<string, MemoryRecord>();
  for (const r of live.filter(r => r.kind === "learning").sort((a,b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))) {
    const question = r.question?.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
    // Missing questions/evidence cannot establish that an earlier learning item was revisited.
    const key = question && r.evidence?.trim() ? `${r.topic}\0${question}` : r.id;
    if (!latestLearning.has(key)) latestLearning.set(key, r);
  }
  const selected = [...live.filter(r => r.kind === "concept" || r.kind === "research"), ...latestLearning.values()].filter(r => kinds.includes(r.kind));
  const searchable: Note[] = selected.map(r => ({ path: r.id, title: `${r.title} ${r.topic}`, text: [r.body, r.evidence, r.question, r.nextQuestion].filter(Boolean).join("\n") }));
  return searchNotes(searchable, query, limit).map(hit => {
    const r = live.find(r => r.id === hit.path)!;
    const conflict = ["concept", "research"].includes(r.kind) && live.filter(other => other.kind === r.kind && other.topic === r.topic).length > 1;
    const bodySnippet = matchingSnippet(r.body, 2200, query), evidenceSnippet = r.evidence === undefined ? undefined : matchingSnippet(r.evidence, 1200, query);
    const bodyTruncated = bodySnippet.truncated, evidenceTruncated = evidenceSnippet?.truncated || false;
    const { content: _body, ...bodyRange } = bodySnippet;
    const evidenceRange = evidenceSnippet ? (({ content: _content, ...range }) => range)(evidenceSnippet) : undefined;
    return { ...r, body: bodySnippet.content, evidence: evidenceSnippet?.content, bodyRange, evidenceRange,
      bodyTruncated, evidenceTruncated, truncated: bodyTruncated || evidenceTruncated,
      readMore: bodyTruncated || evidenceTruncated ? { tool: "study_memory", id: r.id } : undefined,
      freshness: (r.sources || []).map(s => ({ path: s.path, status: sourceStatus(vault, s) })), conflict };
  });
}

export function lintWiki(vault: string) {
  const live = visibleRecords(records(vault));
  return { records: live.length, issues: live.flatMap(r => {
    const issues = (r.sources || []).filter(s => sourceStatus(vault, s) !== "current").map(s => ({ id: r.id, topic: r.topic, issue: `來源 ${sourceStatus(vault, s)}`, path: s.path }));
    if (["concept", "research"].includes(r.kind) && live.filter(o => o.kind === r.kind && o.topic === r.topic).length > 1) issues.push({ id: r.id, topic: r.topic, issue: "並行版本衝突", path: "" });
    if (r.kind === "learning" && Date.now() - Date.parse(r.createdAt) > 30 * 86400000) issues.push({ id: r.id, topic: r.topic, issue: "超過 30 天未重新檢查理解", path: "" });
    return issues;
  }) };
}
