import './isolate.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeLoader, makeApi, makeCtx, test, assert, assertIncludes, report } from "./harness.mjs";

const temp = mkdtempSync(join(tmpdir(), "pi-memory-retrieval-")), vault = join(temp, "vault");
mkdirSync(vault); process.env.PI_STUDY_VAULT = vault; process.env.PI_LLM_WIKI = join(vault, "07-Agent-Wiki");
const j = await makeLoader(), m = await j.import(resolve("extensions/study/memory.ts")), n = await j.import(resolve("extensions/study/notes.ts"));
const { default: factory } = await j.import(resolve("extensions/study/index.ts"));
let serial = 0;
function learning(data, day = ++serial) {
  const record = m.saveRecord(vault, { kind: "learning", topic: "networking", title: "網路回答", body: "待確認的問題", evidence: "使用者的回答", sessionId: "retrieval", messageId: String(++serial), ...data });
  record.createdAt = new Date(Date.UTC(2026, 0, day)).toISOString();
  writeFileSync(join(vault, "07-Agent-Wiki", ".records", `${record.id}.json`), JSON.stringify(record));
  return record;
}
try {
  await test("記憶搜尋回傳命中的後段、標題與可核對的 offset", () => {
    const body = "# 機制\n\n" + "一般介紹。\n\n".repeat(600) + "## 限制條件\n\nECN feedback 只在接收端提供標記時成立。\n\n" + "其他敘述。\n\n".repeat(150);
    const saved = m.saveRecord(vault, { kind: "concept", topic: "ecn-memory", title: "記憶後段", body });
    const hit = m.memoryContext(vault, "ECN feedback", 10).find(r => r.id === saved.id);
    assertIncludes(hit.body, "ECN feedback"); assert(hit.bodyRange.startOffset > 0 && hit.body.length <= 2200);
    assert(hit.body === body.slice(hit.bodyRange.startOffset, hit.bodyRange.endOffset));
    assertIncludes(hit.bodyRange.heading.text, "限制條件");
    assert(hit.bodyTruncated && hit.truncated && hit.readMore.id === saved.id);
  });
  await test("單一長段落的命中也不會固定回傳開頭", () => {
    const text = "背景內容".repeat(1000) + " retransmission timeout " + "補充內容".repeat(500);
    const hit = n.matchingSnippet(text, 300, "retransmission");
    assertIncludes(hit.content, "retransmission"); assert(hit.content.length === 300 && hit.startOffset > 0);
  });
  await test("證據片段命中後段且 ID 可還原原始全文", async () => {
    const evidence = "這是我先前的回答。".repeat(250) + " MTU mismatch 會導致封包分段問題。";
    const saved = learning({ topic: "mtu-evidence", evidence });
    const hit = m.memoryContext(vault, "MTU mismatch", 20).find(r => r.id === saved.id);
    assertIncludes(hit.evidence, "MTU mismatch"); assert(hit.evidenceTruncated && hit.evidenceRange.startOffset > 0);
    const api = makeApi(); factory(api);
    const recall = JSON.parse((await api._tools.get("study_memory").execute("t", { id: hit.readMore.id }, undefined, undefined, makeCtx())).content[0].text);
    assert(recall.records[0].evidence === evidence && recall.records[0].id === saved.id);
  });
  await test("同 topic 的新 NAT 答案不會遮掉尚未釐清的路由問題", () => {
    const old = learning({ question: "如何確認 return route？", status: "partial", nextQuestion: "路由表的 gateway 是哪個？" }, 1);
    learning({ question: "NAT 的 port mapping 如何保存？", status: "supported", evidence: "NAT 會保存對應的 port。" }, 2);
    const hit = m.memoryContext(vault, "return route", 20).find(r => r.id === old.id);
    assert(hit?.status === "partial" && hit.question === old.question);
    assert(m.memoryContext(vault, "gateway", 20).some(r => r.id === old.id), "nextQuestion 必須可搜尋");
  });
  await test("同一道具體問題以新回答為準，不會竄改舊紀錄", () => {
    const question = "SYN retransmission 的觸發條件？";
    const old = learning({ question, status: "partial", evidence: "還不知道觸發條件。" }, 3);
    const latest = learning({ question, status: "supported", evidence: "沒有收到 ACK 才會依 timer 重送。" }, 4);
    const hits = m.memoryContext(vault, "SYN retransmission", 20);
    assert(hits.some(r => r.id === latest.id) && !hits.some(r => r.id === old.id));
    assert(m.records(vault).find(r => r.id === old.id).status === "partial");
  });
  await test("缺乏回答證據的新紀錄不能把舊問題當成已解決", () => {
    const question = "ARP stale entry 如何處理？", old = learning({ question, status: "partial" }, 5);
    learning({ question, status: "supported", evidence: undefined }, 6);
    assert(m.memoryContext(vault, "ARP stale entry", 20).some(r => r.id === old.id));
  });
  await test("沒有 question 的舊版紀錄各自保留，不按 topic 丟棄", () => {
    const a = learning({ topic: "legacy", body: "legacy zebra 問題一", question: undefined }, 7);
    const b = learning({ topic: "legacy", body: "legacy zebra 問題二", question: undefined }, 8);
    const hits = m.memoryContext(vault, "legacy zebra", 20);
    assert(hits.some(r => r.id === a.id) && hits.some(r => r.id === b.id));
  });
  await test("同一則回答內不同問題可分開記錄，重試同一問題仍去重", () => {
    const data = { kind: "learning", topic: "two-questions", title: "一次回答", body: "觀察", sessionId: "same-session", messageId: "same-message", evidence: "原話" };
    const a = m.saveRecord(vault, { ...data, question: "TCP？" }), b = m.saveRecord(vault, { ...data, question: "UDP？" });
    assert(a.id !== b.id && m.saveRecord(vault, { ...data, question: "TCP？" }).id === a.id);
  });
  await test("無關 wiki links 不佔據前三筆，相關 links 仍加分", () => {
    const current = { path: "current.md", title: "總覽", text: "[[Cooking]] [[Music]] [[Painting]] [[NAT Related]]" };
    const notes = [current, ...["Cooking", "Music", "Painting"].map(title => ({ path: `${title}.md`, title, text: title })),
      { path: "nat-related.md", title: "NAT Related", text: "NAT routing" }, { path: "routing.md", title: "NAT Routing", text: "NAT routing" }];
    const hits = n.relatedNotes(notes, current, "NAT routing");
    assert(hits.length === 2 && hits.every(r => !/Cooking|Music|Painting/.test(r.path)));
    assert(hits.some(r => r.path === "nat-related.md"));
  });
  await test("片段邊界與空 query 的截斷 metadata 一致", () => {
    for (const length of [2199, 2200, 2201]) {
      const s = n.matchingSnippet("字".repeat(length), 2200, "");
      assert(s.content.length === Math.min(length, 2200) && s.truncated === (length > 2200));
      assert(s.startOffset === 0 && s.endOffset === s.content.length && s.totalChars === length);
    }
  });
} finally { rmSync(temp, { recursive: true, force: true }); }
report();
