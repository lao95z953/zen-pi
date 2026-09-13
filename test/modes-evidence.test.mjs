import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeLoader, makeApi, makeCtx, fire, test, assert, assertIncludes, report } from "./harness.mjs";

const temp = mkdtempSync(join(tmpdir(), "pi-mode-evidence-")), vault = join(temp, "vault");
mkdirSync(vault); process.env.PI_STUDY_VAULT = vault;
const j = await makeLoader();
const { default: factory, boundedContext } = await j.import(resolve("extensions/study/index.ts"));
const { createReadEvidence } = await j.import(resolve("extensions/study/provenance.ts"));
const n = await j.import(resolve("extensions/study/notes.ts"));
const boot = () => { const api = makeApi(); factory(api); return { api, ctx: makeCtx() }; };
const command = (a, name, arg = "") => a.api._commands.get(name).handler(arg, a.ctx);
const exec = (a, name, params) => a.api._tools.get(name).execute("test", params, undefined, undefined, a.ctx);
const context = (a, prompt = "NAT") => fire(a.api, "before_agent_start", { prompt, systemPrompt: "BASE" }, a.ctx);
const write = (path, text) => { writeFileSync(join(vault, path), text); return { path, title: path, text }; };
const cite = (note, startLine, endLine = startLine, quote = note.text.split("\n")[startLine - 1]) => ({ path: note.path, sha256: n.fingerprint(note.text), startLine, endLine, quote });
const wiki = (source, topic = "evidence") => ({ topic, title: topic, body: "來源整理", sources: [source] });
const custom = (a, type) => a.api._sent.filter(m => m.kind === "custom" && m.msg.customType === type).map(m => JSON.parse(m.msg.content));
async function rejects(fn, needle) { let error; try { await fn(); } catch (err) { error = err; } assert(error, "expected rejection"); if (needle) assertIncludes(error.message, needle); }

try {
  await test("新對話一般模式不依賴 vault，status 不啟動模型且提供 RPC 狀態", async () => {
    const a = boot(); process.env.PI_STUDY_VAULT = join(temp, "missing-vault");
    try {
      await fire(a.api, "session_start", {}, a.ctx);
      await command(a, "mode", "status");
      const result = await context(a), data = JSON.parse(result.message.content);
      assert(data.mode === "general" && data.current === null && !data.memory && !data.vault);
      const filtered = await fire(a.api, "context", { messages: [{ role: "custom", customType: "study-context", content: JSON.stringify({ mode: "study", current: { content: "private" } }) }] }, a.ctx);
      assert(filtered.messages.length === 0, "一般模式移除舊的學習快照");
      assert(!result.systemPrompt.includes("你需要主動維護 Wiki"));
      assert(custom(a, "pi-mode-state").every(m => m.mode === "general"));
      assert(!custom(a, "pi-mode-error").length && !a.api._sent.some(m => m.kind === "user"));
    } finally { process.env.PI_STUDY_VAULT = vault; }
  });
  await test("明確選擇三種模式、off、自然語言與無 UI 狀態", async () => {
    write("NAT.md", "# NAT\nNAT 保存轉譯對應。\n");
    const a = boot(); a.ctx.hasUI = false;
    await command(a, "study", "NAT.md"); assert(custom(a, "pi-mode-state").at(-1).mode === "study");
    assert(JSON.parse((await context(a)).message.content).current.path === "NAT.md");
    await command(a, "research"); assert(custom(a, "pi-mode-state").at(-1).mode === "research");
    await command(a, "research", "off"); assert(custom(a, "pi-mode-state").at(-1).mode === "general");
    await command(a, "mode", "study"); await command(a, "study", "off");
    assert(custom(a, "pi-mode-state").at(-1).mode === "general");
    await fire(a.api, "input", { source: "interactive", text: "進入學習模式" }, a.ctx);
    assert(JSON.parse((await context(a)).message.content).mode === "study");
    await fire(a.api, "input", { source: "interactive", text: "回到一般模式" }, a.ctx);
    await fire(a.api, "input", { source: "extension", text: "進入研究模式" }, a.ctx);
    assert(JSON.parse((await context(a)).message.content).mode === "general");
    await command(a, "mode", "invalid"); assertIncludes(custom(a, "pi-mode-error").at(-1).error, "用法");
  });
  await test("Web 筆記清單只回傳可用筆記 metadata，選取前不改模式", async () => {
    const a = boot();
    await command(a, "study-notes", "NAT");
    const list = custom(a, "pi-note-list").at(-1).notes;
    assert(list.some(n => n.path === "NAT.md") && list.every(n => Object.keys(n).sort().join() === "path,title"));
    assert(JSON.parse((await context(a)).message.content).mode === "general");
    await command(a, "study", "NAT.md"); await command(a, "study-status");
    assert(custom(a, "pi-study-state").at(-1).current.path === "NAT.md");
    assert(!a.api._sent.some(m => m.kind === "user"));
  });
  await test("一般與研究模式不能存理解評量，明確 study 後才驗證回答", async () => {
    const a = boot(); await rejects(() => exec(a, "study_observe", {}), "學習模式");
    await command(a, "mode", "research"); await rejects(() => exec(a, "study_observe", {}), "學習模式");
    await command(a, "mode", "study");
    await rejects(() => exec(a, "study_observe", { messageId: "current", evidence: "不存在的回答" }), "證據");
  });
  await test("模式從目前分支恢復，舊 study 意圖保留，新一般模式不被舊 focus 覆蓋", async () => {
    const a = boot();
    const branch = [{ type: "custom", customType: "pi-research-mode-v1", data: { vault, state: { mode: "research", question: "原研究問題" } } }];
    a.ctx.sessionManager.getBranch = () => branch;
    await fire(a.api, "session_start", {}, a.ctx); assert(custom(a, "pi-mode-state").at(-1).question === "原研究問題");
    branch.splice(0, 1, { type: "custom", customType: "pentest-study-focus-v1", data: { vault, focus: { mode: "manual", path: "NAT.md" } } });
    await fire(a.api, "session_tree", {}, a.ctx); assert(custom(a, "pi-mode-state").at(-1).mode === "study");
    branch.unshift({ type: "custom", customType: "pi-agent-mode-v2", data: { state: { mode: "general" } } });
    await fire(a.api, "session_tree", {}, a.ctx); assert(custom(a, "pi-mode-state").at(-1).mode === "general");
    branch.splice(0); await fire(a.api, "session_tree", {}, a.ctx); assert(custom(a, "pi-mode-state").at(-1).mode === "general");
  });
  await test("只讀 1–20 行不能引用第 100 行，補讀後可保存", async () => {
    const note = write("Long.md", Array.from({ length: 120 }, (_, i) => `evidence line ${i + 1}`).join("\n"));
    const a = boot(), source = cite(note, 100);
    await exec(a, "study_read", { path: note.path, maxLines: 20 });
    await rejects(() => exec(a, "study_wiki", wiki(source)), "行段尚未讀取");
    await exec(a, "study_read", { path: note.path, startLine: 100, maxLines: 1 });
    const saved = JSON.parse((await exec(a, "study_wiki", wiki(source))).content[0].text); assert(saved.id);
  });
  await test("長單行只可引用實際顯示部分，ellipsis 不提供尾端證據", async () => {
    const note = write("Wide.md", "readable prefix " + "x".repeat(25000) + " hidden tail");
    const a = boot(); await exec(a, "study_read", { path: note.path });
    await rejects(() => exec(a, "study_wiki", wiki(cite(note, 1, 1, "hidden tail"), "hidden-tail")), "未展示");
    assert(JSON.parse((await exec(a, "study_wiki", wiki(cite(note, 1, 1, "readable prefix"), "shown-prefix"))).content[0].text).id);
    const evidence = createReadEvidence(), fragment = n.excerpt(note, 25);
    evidence.markRead(note, fragment.content); evidence.assert(cite(note, 1, 1, "readable prefix"), note);
    await rejects(() => evidence.assert(cite(note, 1, 1, "x".repeat(50)), note), "未展示");
  });
  await test("來源版本變更與分支切換會撤回先前已讀行段", async () => {
    const note = write("Version.md", "first line\nsecond line");
    const a = boot(); await exec(a, "study_read", { path: note.path });
    const updated = write(note.path, "changed first line\nsecond line");
    await exec(a, "study_read", { path: note.path, maxLines: 1 });
    await rejects(() => exec(a, "study_wiki", wiki(cite(updated, 2), "version-tail")), "行段尚未讀取");
    await fire(a.api, "session_tree", {}, a.ctx);
    await rejects(() => exec(a, "study_wiki", wiki(cite(updated, 1), "branch-read")), "尚未讀取");
  });
  await test("context 裁掉關聯來源後不能引用；移除 snapshot 後須重新讀取", async () => {
    const note = write("Focus.md", "# Focus\n[[Related]]\nfocus mechanism"), related = write("Related.md", "# Related\nfocus mechanism related evidence");
    const a = boot(); await command(a, "study", note.path);
    const start = await context(a, "focus mechanism"), data = JSON.parse(start.message.content);
    assert(data.related.some(n => n.path === related.path), "initial context must contain Related.md");
    const limit = JSON.stringify({ ...data, related: [] }).length;
    const trimmed = boundedContext(data, limit); assert(!JSON.parse(trimmed).related.some(n => n.path === related.path), "budget must remove Related.md");
    await fire(a.api, "context", { messages: [{ role: "custom", customType: "study-context", content: trimmed }] }, a.ctx);
    await rejects(() => exec(a, "study_wiki", wiki(cite(related, 2), "removed-related")), "尚未讀取");
    await fire(a.api, "context", { messages: [] }, a.ctx);
    await rejects(() => exec(a, "study_wiki", wiki(cite(note, 3), "removed-current")), "尚未讀取");
    await exec(a, "study_read", { path: note.path });
    await fire(a.api, "context", { messages: [] }, a.ctx);
    assert(JSON.parse((await exec(a, "study_wiki", wiki(cite(note, 3), "explicit-remains"))).content[0].text).id);
  });
  await test("新工具讀取不會被同一輪的舊 snapshot 撤銷；下一輪新版會使舊工具範圍失效", async () => {
    const original = write("Updating.md", "# Updating\nold fact\nlast fact");
    const a = boot(); await command(a, "study", original.path);
    const oldSnapshot = await context(a, "Updating");
    const updated = write(original.path, "# Updating\nnew fact\nlast fact");
    await exec(a, "study_read", { path: original.path, startLine: 2, maxLines: 1 });
    await fire(a.api, "context", { messages: [{ role: "custom", customType: "study-context", content: oldSnapshot.message.content }] }, a.ctx);
    assert(JSON.parse((await exec(a, "study_wiki", wiki(cite(updated, 2), "updated-source"))).content[0].text).id);
    const e = createReadEvidence();
    e.markRead(original, "2: old fact\n3: last fact");
    e.markContext(updated, "2: new fact", true);
    await rejects(() => e.assert(cite(updated, 3), updated), "行段尚未讀取");
  });
  await test("跨行引文需讀完整前行，重複引文以實際出現位置驗證，CRLF 可追蹤", async () => {
    const note = { path: "multiline.md", text: "prefix hidden\nnext line\nrepeated repeated\r\n", title: "source" };
    const e = createReadEvidence(); e.markRead(note, "1: prefix\n2: next line\n3: repeated repeated\r");
    await rejects(() => e.assert(cite(note, 1, 2, "hidden\nnext"), note), "未展示");
    e.assert(cite(note, 3, 3, "repeated\r"), note);
    e.markRead(note, "1: prefix hidden"); e.assert(cite(note, 1, 2, "hidden\nnext"), note);
  });
} finally { rmSync(temp, { recursive: true, force: true }); }
report();
