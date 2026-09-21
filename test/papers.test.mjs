import './isolate.mjs';
import { resolve } from "node:path";
import { makeLoader, test, assert, assertIncludes, report } from "./harness.mjs";
const j = await makeLoader(), p = await j.import(resolve("extensions/study/papers.ts"));

await test("arXiv metadata 保留版本、日期、作者與預印本標記", () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom"><entry><id>http://arxiv.org/abs/2401.12345v2</id><title>Test Paper</title><published>2024-01-01T00:00:00Z</published><updated>2024-03-01T00:00:00Z</updated><summary>Only an abstract.</summary><author><name>A Author</name></author><arxiv:doi>10.1234/test</arxiv:doi></entry></feed>`;
  const paper = p.parseArxiv(xml)[0];
  assert(paper.id === "2401.12345v2" && paper.doi === "10.1234/test");
  assert(paper.authors[0] === "A Author" && paper.updated.startsWith("2024-03"));
  assertIncludes(paper.publicationType, "不能據此認定");
});
await test("Crossref 缺摘要不補寫，保留未知年份與機構作者", () => {
  const paper = p.parseCrossref({ DOI: "10.1234/example", title: ["An <i>Example</i>"], author: [{ name: "Research Group" }], type: "journal-article" });
  assert(paper.title === "An Example" && paper.abstract === undefined && paper.published === undefined);
  assert(paper.authors[0] === "Research Group");
  assert(!p.bibtex(paper).includes("year ="));
});
await test("Crossref 摘要只抽標記內文字，日期不混成查阅日期", () => {
  const paper = p.parseCrossref({ DOI: "10.1234/example", title: ["Title"], published: { "date-parts": [[2025, 2]] }, abstract: "<jats:p>Abstract content.</jats:p>" });
  assert(paper.published === "2025-02" && paper.abstract === "Abstract content.");
});
await test("論文 ID 不接受任意 URL，合法 DOI 和 arXiv URL 正規化", () => {
  assert(p.paperId("arxiv", "https://arxiv.org/pdf/1706.03762v7.pdf") === "1706.03762v7");
  assert(p.paperId("crossref", "https://doi.org/10.1234/example") === "10.1234/example");
  for (const value of ["http://127.0.0.1/x", "../models.json", "not-a-paper"]) {
    let failed = false; try { p.paperId("arxiv", value); } catch { failed = true; } assert(failed);
  }
});
await test("近期與相關性查詢可重現，日期錯誤被拒絕", () => {
  const arxiv = new URL(p.searchURL("arxiv", "agent memory", "2025-09-11", "newest"));
  assert(arxiv.searchParams.get("sortBy") === "submittedDate");
  assertIncludes(arxiv.searchParams.get("search_query"), "202509110000");
  const crossref = new URL(p.searchURL("crossref", "agent memory", undefined, "relevance"));
  assert(crossref.searchParams.get("query.bibliographic") === "agent memory" && !crossref.searchParams.has("filter"));
  for (const since of ["2025-02-30", "today", "2025-2-3"]) { let failed = false; try { p.searchURL("arxiv", "agent", since); } catch { failed = true; } assert(failed); }
});
await test("API 錯誤不是空搜尋；書目特殊字元不當成 TeX 命令", () => {
  for (const xml of ["<html>captcha</html>", "<feed><entry><id>http://arxiv.org/api/errors#bad</id><summary>bad query</summary></entry></feed>"]) {
    let failed = false; try { p.parseArxiv(xml); } catch { failed = true; } assert(failed);
  }
  const bib = p.bibtex({ provider: "arxiv", id: "2401.12345v2", title: "A {title} 50% \\input", authors: ["A & B"], url: "https://arxiv.org/abs/2401.12345v2", publicationType: "preprint" });
  assertIncludes(bib, "\\{title\\}"); assertIncludes(bib, "50\\%"); assertIncludes(bib, "\\textbackslash{}input");
});
await test("PDF 解析拒絕偽裝 HTML，不會把登入頁當論文", async () => {
  let failed = false; try { await p.extractPDF(Buffer.from("<html>login</html>"), 1, 5); } catch (err) { failed = true; assertIncludes(err.message, "不是 PDF"); } assert(failed);
});
report();
