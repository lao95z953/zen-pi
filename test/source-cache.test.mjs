import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeLoader, test, assert, assertIncludes, report } from "./harness.mjs";

const temp = mkdtempSync(join(tmpdir(), "pi-source-cache-"));
const j = await makeLoader(), c = await j.import(resolve("extensions/study/source-cache.ts")), m = await j.import(resolve("extensions/study/memory.ts")), p = await j.import(resolve("extensions/study/papers.ts"));
let serial = 0;
const fixture = () => { const vault = join(temp, `vault-${++serial}`); mkdirSync(vault); return vault; };
const pdf = (value = "v1") => Buffer.from(`%PDF-1.4\n${value}\n%%EOF`);
const response = (bytes = pdf()) => ({ url: "https://example.org/paper.pdf", bytes, contentType: "application/pdf" });
const cacheDir = vault => join(vault, "07-Agent-Wiki", ".cache", "pdf");
const now = date => () => new Date(date);
function textPDF() {
  const stream = number => `BT /F1 12 Tf 72 720 Td (Page ${number} source evidence) Tj ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    ...[6, 7].map(content => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents ${content} 0 R >>`),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", ...[1, 2].map(number => `<< /Length ${stream(number).length} >>\nstream\n${stream(number)}\nendstream`)];
  let text = "%PDF-1.4\n"; const offsets = [];
  for (const [index, object] of objects.entries()) { offsets.push(text.length); text += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = text.length;
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}
async function rejects(fn, needle) { let error; try { await fn(); } catch (err) { error = err; } assert(error, "expected rejection"); if (needle) assertIncludes(error.message, needle); }
try {
  await test("同 URL 換頁共用原 PDF，重复頁面沿用來源 ID", async () => {
    const vault = fixture(); let calls = 0;
    const options = { fetchBytes: async () => { calls++; return response(); }, now: now("2026-01-01T00:00:00Z") };
    const extract = async (_bytes, startPage) => ({ text: `## PDF 第 ${startPage} 頁\n\nPage ${startPage}`, totalPages: 3, startPage, endPage: startPage, truncated: false, partialDocument: true, warning: "fixture 文字抽取" });
    const first = await p.readPDFSource(vault, "https://example.org/paper.pdf", "paper", 1, 1, options, extract);
    const second = await p.readPDFSource(vault, "https://example.org/paper.pdf", "paper", 2, 1, options, extract);
    const repeated = await p.readPDFSource(vault, "https://example.org/paper.pdf", "paper", 1, 1, options, extract);
    assert(calls === 1 && second.data.cacheHit && repeated.data.cacheHit);
    assert(first.data.sourceId === repeated.data.sourceId && repeated.data.sourceReused && first.data.sourceId !== second.data.sourceId);
    assert(m.records(vault).length === 2 && first.data.sourceSha256 === second.data.sourceSha256);
    assertIncludes(second.data.freshness, "未查詢網站"); assertIncludes(second.data.content, "Page 2");
  });
  await test("真實 Poppler 讀取兩頁 PDF fixture，cache 內容仍可逐頁抽取", async () => {
    const vault = fixture(); let calls = 0;
    const options = { fetchBytes: async () => { calls++; return response(textPDF()); } };
    const first = await p.readPDFSource(vault, "https://example.org/paper.pdf", "actual-extraction", 1, 1, options);
    const second = await p.readPDFSource(vault, "https://example.org/paper.pdf", "actual-extraction", 2, 1, options);
    assert(calls === 1 && first.data.totalPages === 2 && second.data.startPage === 2);
    assertIncludes(first.data.content, "Page 1 source evidence"); assertIncludes(second.data.content, "Page 2 source evidence");
  });
  await test("同 URL 並行分頁在第一次下載後重查 cache，只下載一次", async () => {
    const vault = fixture(); let calls = 0;
    const options = { fetchBytes: async () => { calls++; await Promise.resolve(); return response(textPDF()); } };
    const [first, second] = await Promise.all([
      p.readPDFSource(vault, "https://example.org/paper.pdf", "parallel", 1, 1, options),
      p.readPDFSource(vault, "https://example.org/paper.pdf", "parallel", 2, 1, options),
    ]);
    assert(calls === 1 && !first.data.cacheHit && second.data.cacheHit);
    assert(first.data.sourceSha256 === second.data.sourceSha256 && first.data.sourceId !== second.data.sourceId);
  });
  await test("下載失敗會釋放下一個等候者；後續正常請求可重試", async () => {
    const vault = fixture(); let calls = 0;
    const fetchBytes = async () => { if (++calls === 1) throw new Error("temporary failure"); return response(); };
    const results = await Promise.allSettled([
      c.cachedPDF(vault, "https://example.org/paper.pdf", { fetchBytes }),
      c.cachedPDF(vault, "https://example.org/paper.pdf", { fetchBytes }),
    ]);
    assert(results[0].status === "rejected" && results[1].status === "fulfilled" && calls === 2);
    assert((await c.cachedPDF(vault, "https://example.org/paper.pdf", { fetchBytes })).cacheHit);
  });
  await test("取消等候者不取消其他下載，也不讓後來請求繞過進行中的下載", async () => {
    const vault = fixture(); let calls = 0, release, started;
    const began = new Promise(resolve => { started = resolve; });
    const fetchBytes = async () => { calls++; started(); await new Promise(resolve => { release = resolve; }); return response(); };
    const first = c.cachedPDF(vault, "https://example.org/paper.pdf", { fetchBytes });
    await began;
    const controller = new AbortController();
    const waiting = c.cachedPDF(vault, "https://example.org/paper.pdf", { fetchBytes, signal: controller.signal });
    controller.abort(new Error("cancelled waiter"));
    await rejects(() => waiting, "cancelled waiter");
    const third = c.cachedPDF(vault, "https://example.org/paper.pdf", { fetchBytes });
    release();
    const [a, b] = await Promise.all([first, third]);
    assert(calls === 1 && !a.cacheHit && b.cacheHit);
  });
  await test("取消正在下載的請求會釋放序列，其他請求仍可完成", async () => {
    const vault = fixture(); let calls = 0, started;
    const began = new Promise(resolve => { started = resolve; });
    const fetchBytes = async (_url, signal) => {
      if (++calls === 1) { started(); await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); }
      return response();
    };
    const controller = new AbortController();
    const first = c.cachedPDF(vault, "https://example.org/paper.pdf", { fetchBytes, signal: controller.signal });
    await began;
    const second = c.cachedPDF(vault, "https://example.org/paper.pdf", { fetchBytes });
    controller.abort(new Error("cancelled owner"));
    const results = await Promise.allSettled([first, second]);
    assert(results[0].status === "rejected" && results[1].status === "fulfilled" && calls === 2);
  });
  await test("排隊的 refresh 不因前一個請求填入 cache 而跳過重新抓取", async () => {
    const vault = fixture(); let calls = 0;
    const fetchBytes = async () => response(pdf(`version-${++calls}`));
    const [a, b, cResult] = await Promise.all([
      c.cachedPDF(vault, "https://example.org/paper.pdf", { fetchBytes }),
      c.cachedPDF(vault, "https://example.org/paper.pdf", { fetchBytes, refresh: true }),
      c.cachedPDF(vault, "https://example.org/paper.pdf", { fetchBytes }),
    ]);
    assert(calls === 2 && a.sha256 !== b.sha256 && b.refreshed && !b.cacheHit && cResult.cacheHit && cResult.sha256 === b.sha256);
  });
  await test("refresh 重新抓取；相同內容保存初次抓取日，新版使用新 hash", async () => {
    const vault = fixture(); let bytes = pdf(), calls = 0;
    const fetchBytes = async () => { calls++; return response(bytes); };
    const first = await c.cachedPDF(vault, "https://example.org/paper.pdf", { fetchBytes, now: now("2026-01-01") });
    const same = await c.cachedPDF(vault, "https://example.org/paper.pdf", { fetchBytes, refresh: true, now: now("2026-01-02") });
    bytes = pdf("v2");
    const changed = await c.cachedPDF(vault, "https://example.org/paper.pdf", { fetchBytes, refresh: true, now: now("2026-01-03") });
    assert(calls === 3 && same.refreshed && !same.cacheHit && same.sha256 === first.sha256);
    assert(same.fetchedAt === first.fetchedAt && same.checkedAt !== first.checkedAt);
    assert(changed.sha256 !== first.sha256 && changed.fetchedAt === changed.checkedAt);
  });
  await test("不同 URL 的相同內容只保存一份 binary，檔案為 0600", async () => {
    const vault = fixture(), fetchBytes = async url => ({ ...response(), url });
    await c.cachedPDF(vault, "https://example.org/a.pdf", { fetchBytes });
    await c.cachedPDF(vault, "https://example.org/b.pdf", { fetchBytes });
    const files = readdirSync(cacheDir(vault));
    assert(files.filter(f => f.endsWith(".pdf")).length === 1 && files.filter(f => f.endsWith(".json")).length === 2);
    assert(files.every(f => (statSync(join(cacheDir(vault), f)).mode & 0o777) === 0o600));
    assert((statSync(cacheDir(vault)).mode & 0o777) === 0o700);
  });
  await test("超過 URL 與容量上限會淘汰 cache，不刪不可變來源紀錄", async () => {
    const vault = fixture(), fetchBytes = async url => ({ ...response(pdf(url)), url });
    const saved = m.saveSourceSnapshot(vault, { kind: "web", topic: "retained", title: "保留來源", body: "原始內容", url: "https://example.org/old.pdf" }).record;
    await c.cachedPDF(vault, "https://example.org/a.pdf", { fetchBytes, maxEntries: 1 });
    await c.cachedPDF(vault, "https://example.org/b.pdf", { fetchBytes, maxEntries: 1 });
    assert(readdirSync(cacheDir(vault)).filter(f => f.endsWith(".json")).length === 1);
    assert(m.records(vault).some(r => r.id === saved.id));
    await c.cachedPDF(vault, "https://example.org/c.pdf", { fetchBytes, maxCacheBytes: 64 });
    assert(readdirSync(cacheDir(vault)).filter(f => f.endsWith(".pdf")).reduce((sum, name) => sum + statSync(join(cacheDir(vault), name)).size, 0) <= 64);
  });
  await test("來源超過 12 MiB、偽裝 PDF 與取消請求不進 cache", async () => {
    const vault = fixture(); let calls = 0;
    await rejects(() => c.cachedPDF(vault, "https://example.org/paper.pdf", { fetchBytes: async () => response(Buffer.alloc(c.MAX_PDF_BYTES + 1)) }), "12 MiB");
    await rejects(() => c.cachedPDF(vault, "https://example.org/paper.pdf", { fetchBytes: async () => response(Buffer.from("<html>login</html>")) }), "不是 PDF");
    const abort = new AbortController(); abort.abort();
    await rejects(() => c.cachedPDF(vault, "https://example.org/paper.pdf", { signal: abort.signal, fetchBytes: async () => { calls++; return response(); } }));
    assert(calls === 0 && readdirSync(cacheDir(vault)).length === 0);
  });
  await test("私有 URL 在 fetch 前拒絕，含 redirect 的回應也需公開 URL", async () => {
    const vault = fixture(); let calls = 0;
    const fetchBytes = async () => { calls++; return response(); };
    for (const url of ["http://127.0.0.1/a.pdf", "http://192.168.1.2/a.pdf", "http://[::1]/a.pdf", "file:///etc/passwd"]) await rejects(() => c.cachedPDF(vault, url, { fetchBytes }));
    assert(calls === 0);
    await rejects(() => c.cachedPDF(vault, "https://example.org/paper.pdf", { fetchBytes: async () => ({ ...response(), url: "http://10.0.0.1/private.pdf" }) }), "私有");
  });
  await test("cache 路徑與 dangling symlink 都會拒絕，不寫到外部", async () => {
    const vault = fixture(), outside = join(temp, "outside"); mkdirSync(outside);
    mkdirSync(join(vault, "07-Agent-Wiki")); symlinkSync(outside, join(vault, "07-Agent-Wiki", ".cache"));
    await rejects(() => c.cachedPDF(vault, "https://example.org/paper.pdf", { fetchBytes: async () => response() }), "symlink");
    const other = fixture(); symlinkSync(join(temp, "not-created"), join(other, "07-Agent-Wiki"));
    await rejects(() => c.cachedPDF(other, "https://example.org/paper.pdf", { fetchBytes: async () => response() }), "symlink");
    assert(readdirSync(outside).length === 0);
  });
  await test("cache binary 的 symlink 與內容篡改不會被當成原 PDF", async () => {
    const vault = fixture(), fetchBytes = async () => response();
    const entry = await c.cachedPDF(vault, "https://example.org/paper.pdf", { fetchBytes });
    const path = join(cacheDir(vault), `${entry.sha256}.pdf`), outside = join(temp, "secret.pdf"); writeFileSync(outside, pdf("secret"));
    unlinkSync(path); symlinkSync(outside, path);
    await rejects(() => c.cachedPDF(vault, "https://example.org/paper.pdf", { fetchBytes }), "symlink");
    unlinkSync(path); writeFileSync(path, pdf("v9"));
    await rejects(() => c.cachedPDF(vault, "https://example.org/paper.pdf", { fetchBytes }), "hash");
    assert(readFileSync(outside).equals(pdf("secret")));
  });
  await test("不合法 cache hash 不能跳脫目錄", async () => {
    const vault = fixture(); await c.cachedPDF(vault, "https://example.org/paper.pdf", { fetchBytes: async () => response() });
    const name = readdirSync(cacheDir(vault)).find(n => n.endsWith(".json")), path = join(cacheDir(vault), name);
    const entry = JSON.parse(readFileSync(path)); entry.sha256 = "../../private"; writeFileSync(path, JSON.stringify(entry));
    await rejects(() => c.cachedPDF(vault, "https://example.org/paper.pdf"), "索引損壞");
  });
  await test("相同 source snapshot 去重，內容、PDF version、頁碼與撤回各自區別", () => {
    const vault = fixture(), data = { kind: "web", topic: "snapshot", title: "來源", body: "相同段落", url: "https://example.org/paper.pdf", sourceVersion: { sha256: createHash("sha256").update("v1").digest("hex"), fetchedAt: "2026-01-01", startPage: 1, endPage: 1 } };
    const first = m.saveSourceSnapshot(vault, data), same = m.saveSourceSnapshot(vault, { ...data, sourceVersion: { ...data.sourceVersion, fetchedAt: "2026-01-02" } });
    assert(same.reused && same.record.id === first.record.id && same.record.sourceVersion.fetchedAt === "2026-01-01");
    assert(!m.saveSourceSnapshot(vault, { ...data, sourceVersion: { ...data.sourceVersion, sha256: createHash("sha256").update("v2").digest("hex") } }).reused);
    assert(!m.saveSourceSnapshot(vault, { ...data, sourceVersion: { ...data.sourceVersion, startPage: 2, endPage: 2 } }).reused);
    assert(!m.saveSourceSnapshot(vault, { ...data, body: "不同內容" }).reused);
    m.saveRecord(vault, { kind: "retraction", topic: "snapshot", title: "撤回", body: "停止檢索", target: first.record.id });
    assert(!m.saveSourceSnapshot(vault, data).reused);
  });
} finally { rmSync(temp, { recursive: true, force: true }); }
report();
