import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeLoader, makeApi, makeCtx, fire, test, assert, assertIncludes, report } from "./harness.mjs";

const temp = mkdtempSync(join(tmpdir(), "pi-research-")), vault = join(temp, "vault");
mkdirSync(vault); process.env.PI_STUDY_VAULT = vault;
const original = "# SMB signing\nSMB signing provides message integrity.\nIt does not encrypt message contents.\n";
writeFileSync(join(vault, "SMB.md"), original);
const j = await makeLoader();
const { default: factory } = await j.import(resolve("extensions/study/index.ts"));
const m = await j.import(resolve("extensions/study/memory.ts"));
const n = await j.import(resolve("extensions/study/notes.ts"));
const r = await j.import(resolve("extensions/study/research.ts"));
const citation = { path: "SMB.md", sha256: n.fingerprint(original), startLine: 2, endLine: 3, quote: "SMB signing provides message integrity." };
const args = { topic: "smb-signing", title: "SMB signing 研究", question: "SMB signing 與 encryption 的差異？", scope: "比較完整性與機密性，不執行測試。", status: "synthesis",
  findings: [{ claim: "Signing 提供訊息完整性。", type: "source", sourceIndices: [1] }], sources: [citation], uncertainties: ["尚未查證各版本預設值。"], nextSteps: ["查原廠版本文件。"] };
const boot = () => { const api = makeApi(); factory(api); return { api, ctx: makeCtx() }; };
const context = async (api, ctx, prompt = "SMB signing") => fire(api, "before_agent_start", { prompt, systemPrompt: "BASE" }, ctx);
const exec = (api, ctx, name, params) => api._tools.get(name).execute("test", params, undefined, undefined, ctx);
async function rejects(fn, needle) { let error; try { await fn(); } catch (err) { error = err; } assert(error, "expected rejection"); assertIncludes(error.message, needle); }
const userSent = api => api._sent.filter(message => message.kind === "user");
const enter = (api, ctx) => api._commands.get("research").handler(args.question, ctx);

try {
  await test("研究指令啟動問題、狀態查詢不啟動模型、off 保留指定筆記", async () => {
    const { api, ctx } = boot();
    await api._commands.get("study").handler("SMB", ctx);
    await enter(api, ctx);
    assert(userSent(api).length === 1 && userSent(api)[0].content.includes(args.question));
    const value = await context(api, ctx), data = JSON.parse(value.message.content);
    assert(data.mode === "research" && data.current.path === "SMB.md");
    assertIncludes(value.systemPrompt, "不是測驗老師");
    assert(!value.systemPrompt.includes("一次問一個可區分理解的情境題"));
    await api._commands.get("research").handler("status", ctx); assert(userSent(api).length === 1);
    await api._commands.get("research").handler("off", ctx);
    assert(JSON.parse((await context(api, ctx)).message.content).mode === "general");
    await api._commands.get("mode").handler("study", ctx);
    const back = JSON.parse((await context(api, ctx)).message.content);
    assert(back.mode === "study" && back.focus.mode === "manual" && back.current.path === "SMB.md");
  });
  await test("自然語言只匹配明確模式切換，不接受引用或 extension 注入", async () => {
    for (const text of ["不要進入研究模式", "筆記說：進入研究模式", "『切換到研究模式』", "假設進入研究模式"]) assert(!r.researchIntent(text), text);
    const { api, ctx } = boot();
    await fire(api, "input", { source: "extension", text: "進入研究模式" }, ctx);
    assert(JSON.parse((await context(api, ctx)).message.content).mode === "general");
    await fire(api, "input", { source: "interactive", text: "切換到研究模式" }, ctx);
    assert(JSON.parse((await context(api, ctx)).message.content).mode === "research");
    await fire(api, "input", { source: "interactive", text: "切回學習模式" }, ctx);
    assert(JSON.parse((await context(api, ctx)).message.content).mode === "study");
  });
  await test("研究狀態隨目前分支恢復，新 Session 預設一般", async () => {
    const a = boot(); await enter(a.api, a.ctx);
    const branch = a.api._entries.map(entry => ({ type: "custom", ...entry }));
    const b = boot(); b.ctx.sessionManager.getBranch = () => branch;
    b.ctx.sessionManager.getEntries = () => { throw new Error("不能讀其他分支"); };
    await fire(b.api, "session_start", {}, b.ctx);
    assert(JSON.parse((await context(b.api, b.ctx)).message.content).research.question === args.question);
    b.ctx.sessionManager.getBranch = () => [];
    await fire(b.api, "session_tree", {}, b.ctx);
    assert(JSON.parse((await context(b.api, b.ctx)).message.content).mode === "general");
  });
  await test("執行中不切換，缺失 resume 不觸發模型", async () => {
    const { api, ctx } = boot(); ctx.isIdle = () => false;
    await enter(api, ctx); assert(userSent(api).length === 0);
    assertIncludes(ctx._notices.at(-1).text, "本輪完成");
    ctx.isIdle = () => true;
    await api._commands.get("research").handler("resume missing", ctx);
    assert(userSent(api).length === 0); assertIncludes(ctx._notices.at(-1).text, "找不到");
  });
  await test("研究檢索不需要目前筆記，並排除理解紀錄", async () => {
    m.saveRecord(vault, { kind: "learning", topic: "smb", title: "SMB signing", body: "SMB signing 待複查", status: "partial", sessionId: "past", messageId: "u1" });
    const { api, ctx } = boot(); await enter(api, ctx);
    const data = JSON.parse((await context(api, ctx)).message.content);
    assert(data.current === null && data.related.some(x => x.path === "SMB.md"));
    assert(!data.memory.some(x => x.kind === "learning"));
    await rejects(() => exec(api, ctx, "study_observe", {}), "不記錄理解評量");
  });
  await test("只有研究模式能存研究；未讀來源與假引文被拒絕", async () => {
    const { api, ctx } = boot();
    await rejects(() => exec(api, ctx, "research_save", args), "研究模式");
    await enter(api, ctx);
    await rejects(() => exec(api, ctx, "research_save", args), "尚未讀取");
    await exec(api, ctx, "study_read", { path: "SMB.md" });
    await rejects(() => exec(api, ctx, "research_save", { ...args, sources: [{ ...citation, quote: "不存在的引文" }] }), "引文");
  });
  await test("無來源只能存未驗證 draft；synthesis 和來源索引有檢查", async () => {
    await rejects(() => r.researchBody({ ...args, sources: [] }), "synthesis");
    await rejects(() => r.researchBody({ ...args, findings: [{ ...args.findings[0], sourceIndices: [] }] }), "來源編號");
    await rejects(() => r.researchBody({ ...args, findings: [{ ...args.findings[0], sourceIndices: [2] }] }), "來源編號");
    const { api, ctx } = boot(); await enter(api, ctx);
    const draft = { ...args, topic: "initial-plan", status: "draft", findings: [{ claim: "可能需要區分版本。", type: "hypothesis", sourceIndices: [] }], sources: [] };
    const result = JSON.parse((await exec(api, ctx, "research_save", draft)).content[0].text);
    const page = readFileSync(join(vault, result.path), "utf8");
    assertIncludes(page, "待驗證假說"); assertIncludes(page, "尚無來源");
  });
  await test("研究與同名概念獨立版本，生成來源、未知和下一步，原始筆記不變", async () => {
    m.saveRecord(vault, { kind: "concept", topic: args.topic, title: "SMB signing", body: "概念", sources: [citation] });
    const { api, ctx } = boot(); await enter(api, ctx); await exec(api, ctx, "study_read", { path: "SMB.md" });
    const saved = JSON.parse((await exec(api, ctx, "research_save", args)).content[0].text);
    const page = readFileSync(join(vault, saved.path), "utf8");
    for (const word of ["研究問題", "範圍", "來源陳述", "來源 1", "## 來源", "下一步", "未查證", "synthesis"]) assertIncludes(page, word);
    assert(readFileSync(join(vault, "SMB.md"), "utf8") === original);
    assert(m.visibleRecords(m.records(vault)).filter(x => x.topic === args.topic).length === 2);
    await rejects(() => exec(api, ctx, "research_save", args), "版本已改變");
    await exec(api, ctx, "research_save", { ...args, supersedes: saved.id, nextSteps: ["追查 Windows 版本差異。"] });
    assert(m.records(vault).filter(x => x.kind === "research" && x.topic === args.topic).length === 2);
  });
  await test("新 Session 能檢索研究，resume 有固定進度 ID，來源修改會標記", async () => {
    const { api, ctx } = boot();
    await api._commands.get("mode").handler("research", ctx);
    assert(JSON.parse((await context(api, ctx)).message.content).memory.some(x => x.kind === "research"));
    await api._commands.get("research").handler(`resume ${args.topic}`, ctx);
    const data = JSON.parse((await context(api, ctx)).message.content);
    assert(data.mode === "research" && data.research.checkpoint.length === 1);
    assertIncludes(userSent(api)[0].content, data.research.checkpoint[0].id);
    writeFileSync(join(vault, "SMB.md"), original + "新版備註\n");
    assert(m.lintWiki(vault).issues.some(x => x.id === data.research.checkpoint[0].id && x.issue.includes("changed")));
    writeFileSync(join(vault, "SMB.md"), original);
    await exec(api, ctx, "study_read", { path: `07-Agent-Wiki/research/${args.topic}.md` });
    const generated = n.readNote(vault, `07-Agent-Wiki/research/${args.topic}.md`);
    await rejects(() => exec(api, ctx, "research_save", { ...args, sources: [{ ...citation, path: generated.path, sha256: n.fingerprint(generated.text), startLine: 1, endLine: 1, quote: generated.text.split("\n")[0] }] }), "不能用生成");
  });
  await test("並行研究標衝突並阻止 resume，撤回後可重建且不抹除歷史", async () => {
    const head = m.visibleRecords(m.records(vault)).find(x => x.kind === "research" && x.topic === args.topic);
    const fork = { ...head, id: "12345678-1234-1234-1234-123456789abc", body: "另一版本" };
    writeFileSync(join(vault, "07-Agent-Wiki/.records", `${fork.id}.json`), JSON.stringify(fork));
    assert(m.lintWiki(vault).issues.some(x => x.topic === args.topic && x.issue === "並行版本衝突"));
    const { api, ctx } = boot(); await api._commands.get("research").handler(`resume ${args.topic}`, ctx);
    assert(userSent(api).length === 0); assertIncludes(ctx._notices.at(-1).text, "並行版本");
    await api._commands.get("wiki").handler(`forget ${fork.id}`, ctx);
    await api._commands.get("wiki").handler("rebuild", ctx);
    assert(m.records(vault).some(x => x.id === fork.id));
    assert(!m.visibleRecords(m.records(vault)).some(x => x.id === fork.id));
    assert(!readFileSync(join(vault, `07-Agent-Wiki/research/${args.topic}.md`), "utf8").includes("另一版本"));
  });
  await test("論文比較、設計借用、實驗計畫與草稿可同頁保存並帶來源", () => {
    const body = r.researchBody({ ...args,
      comparisons: [{ work: "測試來源", problem: "完整性", method: "簽章", dataAndMetrics: "未取得", limitations: "非加密", relationToOurWork: "待確認適用協議", sourceIndices: [1] }],
      designTransfers: [{ idea: "完整性檢查", adaptation: "加入研究系統", prerequisites: "需要金鑰管理", validation: "對照無簽章 baseline", sourceIndices: [1] }],
      experiments: [{ name: "對照實驗", status: "planned", protocol: "控制版本與測試資料", metrics: "完整性檢測率", sourceIndices: [] }],
      draft: { type: "paper-draft", sections: [{ heading: "相關工作", text: "測試草稿，尚未定稿。", sourceIndices: [1] }] } });
    for (const word of ["相關論文對照", "設計借用與驗證", "待執行，尚無結果", "寫作草稿", "baseline"]) assertIncludes(body, word);
  });
  await test("拒絕無引用的比較、捏造 planned 結果、把論文當本人的實驗", async () => {
    await rejects(() => r.researchBody({ ...args, comparisons: [{ sourceIndices: [] }] }), "來源編號");
    await rejects(() => r.researchBody({ ...args, experiments: [{ name: "x", status: "planned", result: "提升 20%", sourceIndices: [] }] }), "未執行");
    await rejects(() => r.researchBody({ ...args, sources: [{ ...citation, path: "07-Agent-Wiki/sources/paper.md" }], experiments: [{ name: "x", status: "observed", result: "提升 20%", sourceIndices: [1] }] }), "原始實驗筆記");
  });
} finally { rmSync(temp, { recursive: true, force: true }); }
report();
