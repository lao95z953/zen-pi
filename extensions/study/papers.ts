import { readStoredNote, type WikiStorage } from "./storage.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { load } from "cheerio";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fetchPublic } from "./web.ts";
import { saveSourceSnapshot, type PaperMetadata } from "./memory.ts";
import { excerpt, type Note } from "./notes.ts";
import { cachedPDF } from "./source-cache.ts";

const run = promisify(execFile);
const clean = (text: string) => text.replace(/\s+/g, " ").trim();
const plain = (text: string) => clean(load(text, { xmlMode: true }).root().text());
const result = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], details: {} });
export function paperId(provider: "arxiv" | "crossref", value: string) {
  const id = value.trim().replace(provider === "arxiv" ? /^(?:arxiv:|https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf)\/)/i : /^(?:doi:|https?:\/\/(?:dx\.)?doi\.org\/)/i, "").replace(provider === "arxiv" ? /\.pdf$/ : /$^/, "");
  if (!(provider === "arxiv" ? /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/ : /^10\.\d{4,9}\/\S+$/i).test(id) || id.length > 200) throw new Error("請提供有效 arXiv ID 或 DOI，不接受任意 API 網址。");
  return id;
}

export function parseArxiv(xml: string): PaperMetadata[] {
  const $ = load(xml, { xmlMode: true });
  if (!$("feed").length) throw new Error("arXiv 未回傳 Atom，可能被限流或暫時不可用。");
  return $("entry").toArray().map(entry => {
    const e = $(entry), raw = e.children("id").text();
    if (/\/api\/errors/.test(raw)) throw new Error(`arXiv 查詢失敗：${clean(e.children("summary").text()).slice(0, 300)}`);
    const id = paperId("arxiv", raw);
    return { provider: "arxiv", id, title: clean(e.children("title").text()), authors: e.find("author > name").toArray().map(a => clean($(a).text())),
      published: e.children("published").text(), updated: e.children("updated").text(), doi: e.find("arxiv\\:doi").text() || undefined,
      venue: e.find("arxiv\\:journal_ref").text() || undefined, url: `https://arxiv.org/abs/${id}`, abstract: clean(e.children("summary").text()).slice(0, 12000), publicationType: "arXiv preprint；不能據此認定已通過同儕審查" };
  });
}

export function parseCrossref(work: any): PaperMetadata {
  const id = paperId("crossref", work.DOI || "");
  const date = work.published?.["date-parts"]?.[0] || work.issued?.["date-parts"]?.[0];
  return { provider: "crossref", id, doi: id, title: plain(work.title?.[0] || "Untitled"), authors: (work.author || []).map((a: any) => clean(a.name || `${a.given || ""} ${a.family || ""}`)),
    published: Array.isArray(date) ? date.map((n: number, i: number) => i ? String(n).padStart(2, "0") : String(n)).join("-") : undefined,
    venue: work["container-title"]?.[0], url: `https://doi.org/${id}`, abstract: work.abstract ? plain(work.abstract).slice(0, 12000) : undefined,
    publicationType: `${work.type || "unknown"}（出版商提交的 metadata；不是品質認證）` };
}

export function searchURL(provider: "arxiv" | "crossref", query: string, since?: string, sort: "relevance" | "newest" = "relevance") {
  if (!query.trim() || query.length > 400) throw new Error("請用 1–400 字元的公開研究關鍵字，勿上傳整份未公開草稿。");
  if (since && (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !Number.isFinite(Date.parse(since)) || new Date(since).toISOString().slice(0, 10) !== since)) throw new Error("since 需為有效 YYYY-MM-DD 日期。");
  if (provider === "arxiv") {
    const url = new URL("https://export.arxiv.org/api/query");
    const terms = query.match(/[\p{L}\p{N}-]+/gu)?.map(term => `all:${term}`).join(" AND ");
    if (!terms) throw new Error("搜尋詞沒有可用詞彙。");
    url.searchParams.set("search_query", `${terms}${since ? ` AND submittedDate:[${since.replace(/-/g, "")}0000 TO 999912312359]` : ""}`);
    url.searchParams.set("max_results", "6"); url.searchParams.set("sortBy", sort === "newest" ? "submittedDate" : "relevance"); url.searchParams.set("sortOrder", "descending");
    return url.href;
  }
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query.bibliographic", query); url.searchParams.set("rows", "6");
  if (since) url.searchParams.set("filter", `from-pub-date:${since}`);
  if (sort === "newest") { url.searchParams.set("sort", "published"); url.searchParams.set("order", "desc"); }
  return url.href;
}

let arxivQueue: Promise<unknown> = Promise.resolve(), lastArxiv = 0;
function arxivFetch(url: string, signal?: AbortSignal) {
  const task = arxivQueue.catch(() => {}).then(async () => {
    const wait = Math.max(0, 3100 - (Date.now() - lastArxiv));
    if (wait) await delay(wait, undefined, { signal });
    signal?.throwIfAborted(); lastArxiv = Date.now(); return fetchPublic(url, signal);
  });
  arxivQueue = task; return task;
}

export async function searchPapers(provider: "arxiv" | "crossref", query: string, since?: string, sort: "relevance" | "newest" = "relevance", signal?: AbortSignal) {
  const url = searchURL(provider, query, since, sort);
  const response = provider === "arxiv" ? await arxivFetch(url, signal) : await fetchPublic(url, signal);
  const papers = provider === "arxiv" ? parseArxiv(response.text) : JSON.parse(response.text).message?.items?.map(parseCrossref);
  if (!Array.isArray(papers)) throw new Error("論文服務回應格式錯誤。");
  return { provider, query, since, sort, searchedAt: new Date().toISOString(), searchUrl: url, coverage: "最多六筆，非完整文獻回顧；新近不等於前沿或最佳。結果僅 metadata／摘要，不是全文。", papers };
}

export async function getPaper(provider: "arxiv" | "crossref", rawId: string, signal?: AbortSignal): Promise<PaperMetadata> {
  const id = paperId(provider, rawId);
  if (provider === "arxiv") {
    const response = await arxivFetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`, signal);
    const papers = parseArxiv(response.text);
    if (papers.length !== 1 || papers[0].id.replace(/v\d+$/, "") !== id.replace(/v\d+$/, "") || /v\d+$/.test(id) && papers[0].id !== id) throw new Error("未取得指定 arXiv 論文／版本。");
    return papers[0];
  }
  const response = await fetchPublic(`https://api.crossref.org/works/${encodeURIComponent(id)}`, signal);
  const paper = parseCrossref(JSON.parse(response.text).message);
  if (paper.id.toLowerCase() !== id.toLowerCase()) throw new Error("DOI 回應不符合請求。");
  return paper;
}

export function bibtex(paper: PaperMetadata) {
  // Escape literal metadata instead of interpreting it as TeX commands.
  const escape = (s: string) => s.replace(/[\\{}%&#_$~^]/g, c => ({ "\\": "\\textbackslash{}", "~": "\\textasciitilde{}", "^": "\\textasciicircum{}" }[c] || `\\${c}`)).replace(/[\r\n]/g, " ");
  const key = `${paper.provider}_${paper.id.replace(/[^a-zA-Z0-9]/g, "_")}`;
  const fields: Record<string, string> = { title: paper.title, author: paper.authors.join(" and "), url: paper.url };
  if (paper.published) fields.year = paper.published.slice(0, 4);
  if (paper.doi) fields.doi = paper.doi;
  if (paper.venue) fields.note = paper.venue;
  if (paper.provider === "arxiv") { fields.eprint = paper.id; fields.archivePrefix = "arXiv"; }
  return `@misc{${key},\n${Object.entries(fields).map(([k, v]) => `  ${k} = {${escape(v)}}`).join(",\n")}\n}`;
}

export async function extractPDF(bytes: Buffer, startPage: number, maxPages: number, signal?: AbortSignal) {
  if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw new Error("回應不是 PDF。");
  if (!Number.isInteger(startPage) || startPage < 1 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10) throw new Error("一次讀 1–10 頁，startPage 從 1 開始。");
  const temp = await mkdtemp(join(tmpdir(), "pi-paper-pdf-"));
  try {
    const file = join(temp, "source.pdf"); await writeFile(file, bytes, { mode: 0o600 });
    const info = await run("pdfinfo", [file], { timeout: 10000, maxBuffer: 1024 * 1024, signal, env: { ...process.env, LC_ALL: "C" } });
    const totalPages = Number(info.stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
    if (!totalPages || startPage > totalPages) throw new Error("PDF 頁碼超出範圍或無法取得頁數。");
    const endPage = Math.min(totalPages, startPage + maxPages - 1);
    const extracted = await run("pdftotext", ["-f", String(startPage), "-l", String(endPage), "-layout", "-enc", "UTF-8", file, "-"], { timeout: 15000, maxBuffer: 4 * 1024 * 1024, signal });
    if (!extracted.stdout.trim()) throw new Error("PDF 沒有可抽取文字；掃描頁需 OCR，本工具未實作 OCR。");
    const pages = extracted.stdout.split("\f").slice(0, endPage - startPage + 1);
    const text = pages.map((p, i) => `## PDF 第 ${startPage + i} 頁\n\n${p.trim()}`).join("\n\n");
    return { totalPages, startPage, endPage, text: text.slice(0, 18000), truncated: text.length > 18000, partialDocument: startPage !== 1 || endPage < totalPages, warning: "僅文字抽取，未做視覺閱讀；雙欄順序、公式、表格與圖可能失真，重要數值需核對原 PDF。" };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error("讀 PDF 需要系統的 pdfinfo 與 pdftotext（Poppler）；目前未安裝。");
    throw err;
  } finally { await rm(temp, { recursive: true, force: true }); }
}

export async function readPDFSource(vault: WikiStorage, url: string, topic: string, startPage = 1, maxPages = 5,
  options: Parameters<typeof cachedPDF>[2] = {}, extract = extractPDF) {
  if (!Number.isInteger(startPage) || startPage < 1 || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10) throw new Error("一次讀 1–10 頁，startPage 從 1 開始。");
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(topic)) throw new Error("topic 必須是小寫英文、數字或連字號。");
  const response = await cachedPDF(vault, url, options), extracted = await extract(response.bytes, startPage, maxPages, options.signal);
  const body = `閱讀層級：PDF 文字片段，第 ${extracted.startPage}–${extracted.endPage} 頁／共 ${extracted.totalPages} 頁。\n${extracted.warning}\n${extracted.truncated ? "[文字超過上限已截斷；請減少 maxPages 重讀，不代表整個頁段已讀完]" : ""}\n\n${extracted.text}`;
  const { record, reused } = saveSourceSnapshot(vault, { kind: "web", topic, title: `PDF ${new URL(response.url).pathname.split("/").pop()} p${extracted.startPage}-${extracted.endPage}`, body, url: response.url,
    sourceVersion: { sha256: response.sha256, fetchedAt: response.fetchedAt, startPage: extracted.startPage, endPage: extracted.endPage, totalPages: extracted.totalPages } });
  const note = readStoredNote(vault, `07-Agent-Wiki/sources/${record.id}.md`), displayed = excerpt(note, 14000);
  const { text: _text, ...reading } = extracted;
  return { note, data: { ...reading, url: response.url, sourceId: record.id, sourceReused: reused,
    sourceSha256: response.sha256, fetchedAt: record.sourceVersion!.fetchedAt, checkedAt: response.checkedAt,
    cacheHit: response.cacheHit, refreshed: response.refreshed,
    freshness: response.cacheHit ? "cached；未查詢網站，refresh=true 才會檢查目前版本" : "fetched；此時間點實際取得的版本",
    ...displayed, extractionTruncated: extracted.truncated, truncated: extracted.truncated || displayed.truncated } };
}

export function registerPapers(pi: ExtensionAPI, vault: () => WikiStorage, markRead: (note: Note, displayedContent: string) => void) {
  const provider = Type.Union([Type.Literal("arxiv"), Type.Literal("crossref")]);
  pi.registerTool({ name: "research_papers", label: "搜尋研究論文", description: "用公开关键词搜尋 arXiv 預印本或 Crossref 出版 metadata。since 日期＋sort=newest 找近期候選；relevance 找相近／經典。不是完整文獻回顧或全文檢索，不要傳未公開草稿。", parameters: Type.Object({ provider, query: Type.String({ minLength: 1, maxLength: 400 }), since: Type.Optional(Type.String()), sort: Type.Optional(Type.Union([Type.Literal("relevance"), Type.Literal("newest")])) }),
    async execute(_id, p, signal) { return result(await searchPapers(p.provider, p.query, p.since, p.sort, signal)); } });
  pi.registerTool({ name: "research_paper", label: "保存論文摘要與書目", description: "以 arXiv ID 或 DOI 核對並保存作者、標題、日期、摘要、BibTeX。僅 metadata／摘要，不是全文；方法細節用 study_web_read 讀 HTML 正文或 research_pdf_read 讀公開 PDF。", parameters: Type.Object({ provider, id: Type.String(), topic: Type.String() }),
    async execute(_id, p, signal) {
      const paper = await getPaper(p.provider, p.id, signal), bib = bibtex(paper);
      const body = `閱讀層級：${paper.abstract ? "metadata + abstract" : "metadata only（服務未提供摘要）"}，未讀全文。\n\n作者：${paper.authors.join("；")}\n日期：${paper.published || "未提供"}\n更新：${paper.updated || "未提供"}\n類型：${paper.publicationType}\n刊物：${paper.venue || "未提供"}\nDOI：${paper.doi || "未提供"}\n\n## 摘要\n\n${paper.abstract || "未提供，不得補寫為原文摘要。"}\n\n## BibTeX（核對正式投稿格式後使用）\n\n\`\`\`bibtex\n${bib}\n\`\`\`\n`;
      const { record, reused } = saveSourceSnapshot(vault(), { kind: "web", topic: p.topic, title: paper.title, body, url: paper.url, paper });
      const note = readStoredNote(vault(), `07-Agent-Wiki/sources/${record.id}.md`), displayed = excerpt(note, 14000);
      markRead(note, displayed.content);
      const { abstract: _abstract, ...metadata } = paper;
      return result({ paper: metadata, sourceId: record.id, sourceReused: reused, fetchedAt: record.createdAt,
        checkedAt: new Date().toISOString(), readMore: { tool: "study_memory", id: record.id }, ...displayed });
    } });
  pi.registerTool({ name: "research_pdf_read", label: "閱讀論文 PDF 頁面", description: "抓取公開 PDF（12 MiB 上限），抽取指定 1–10 頁文字，保存帶頁碼的來源快照。同 URL 換頁使用本機已抓版本；refresh=true 重新抓取檢查版本。需要 Poppler；不含 OCR／圖表視覺理解，不繞登入或付費牆。頁面截斷時縮小頁數重讀。", parameters: Type.Object({ url: Type.String(), topic: Type.String(), startPage: Type.Optional(Type.Integer({ minimum: 1 })), maxPages: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })), refresh: Type.Optional(Type.Boolean()) }),
    async execute(_id, p, signal) {
      const { note, data } = await readPDFSource(vault(), p.url, p.topic, p.startPage ?? 1, p.maxPages ?? 5, { signal, refresh: p.refresh });
      markRead(note, data.content);
      return result(data);
    } });
}
