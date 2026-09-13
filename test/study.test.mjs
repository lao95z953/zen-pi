import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeLoader, makeApi, makeCtx, fire, test, assert, assertIncludes, report } from "./harness.mjs";

const tmp = mkdtempSync(join(tmpdir(), "pi-study-test-"));
const vault = join(tmp, "vault");
mkdirSync(join(vault, "03-概念"), { recursive: true });
mkdirSync(join(vault, "02-指令庫"), { recursive: true });
mkdirSync(join(vault, ".obsidian"), { recursive: true });
writeFileSync(join(vault, "03-概念", "SMB&Samba.md"), "# SMB & Samba\n自己的理解\n[[SMB-Enumeration]]\n");
writeFileSync(join(vault, "02-指令庫", "SMB-Enumeration.md"), "# SMB Enumeration\n指令參考\n");
writeFileSync(join(vault, "03-概念", "NAT&Reverse-Shell.md"), "# NAT 與 Reverse Shell\n連線方向\n");
writeFileSync(join(vault, "secret.ovpn"), "should not load");
writeFileSync(join(vault, ".obsidian", "private.md"), "should not load");
process.env.PI_STUDY_VAULT = vault;
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = await makeLoader();
const n = await jiti.import(join(project, "extensions/study/notes.ts"));
const factory = await jiti.import(join(project, "extensions/study/index.ts"), { default: true });
const notes = n.listNotes(vault);
const stateFile = join(tmp, "state.json");
const now = Date.now();
const bridge = (extra = {}) => writeFileSync(stateFile, JSON.stringify({ version: 1, vault, running: true, updatedAt: now,
  path: "03-概念/SMB&Samba.md", text: "# SMB live\n尚未儲存的理解", cursorLine: 1, ...extra }));
const boot = () => { const api = makeApi(); factory(api); return { api, ctx: makeCtx() }; };

try {
  await test("語言指定完整篇名與引號標題", () => {
    assert(n.parseIntent("我現在在讀 NAT&Reverse-Shell 那篇，幫我檢查理解").query === "NAT&Reverse-Shell");
    assert(n.parseIntent("我正在閱讀「SMB & Samba」").query === "SMB & Samba");
    assert(n.parseIntent("切回自動跟隨").mode === "auto");
  });
  await test("提到、否定、引述與無關句子不切換", () => {
    for (const s of ["我在想這件事", "我不是在讀 SMB", "假設我在讀 SMB", "筆記寫著：我在讀 SMB", "我之前在讀 SMB", "我在讀這篇"]) {
      assert(n.parseIntent(s) === undefined, s);
    }
  });
  await test("SMB 兩篇產生候選，不擅自選概念頁", () => {
    const focus = n.selectFocus(notes, "SMB");
    assert(focus.mode === "pending" && focus.candidates.length === 2);
    assert(n.selectFocus(notes, "03-概念/SMB&Samba.md").mode === "manual");
    assert(n.selectFocus(notes, "不存在").mode === "pending");
  });
  await test("排除非 Markdown 與 Obsidian 內部檔案", () => assert(notes.length === 3));
  await test("wiki link 指向指令庫，關聯檢索帶回來源", () => {
    const current = n.readNote(vault, "03-概念/SMB&Samba.md");
    assert(n.relatedNotes(notes, current, "")[0].path === "02-指令庫/SMB-Enumeration.md");
  });
  await test("fresh bridge 讀到未儲存內容與游標", () => {
    bridge(); const live = n.liveNote(vault, stateFile, now);
    assertIncludes(live.note.text, "尚未儲存"); assert(live.cursorLine === 1);
  });
  await test("過期、關閉、錯 vault 與非筆記分頁不冒充目前筆記", () => {
    for (const extra of [{ updatedAt: now - 46000 }, { running: false }, { vault: tmp }, { path: null }, { updatedAt: now + 60000 }]) {
      bridge(extra); assert(!n.liveNote(vault, stateFile, now).note, JSON.stringify(extra));
    }
  });
  await test("路徑跳脫及外部 symlink 不可讀", () => {
    writeFileSync(join(tmp, "outside.md"), "private");
    symlinkSync(join(tmp, "outside.md"), join(vault, "outside.md"));
    for (const path of ["../outside.md", "outside.md", "secret.ovpn"]) {
      let denied = false; try { n.readNote(vault, path); } catch { denied = true; }
      assert(denied, path);
    }
  });
  await test("workspace 只返回 active 主頁的歷史提示", () => {
    writeFileSync(join(vault, ".obsidian", "workspace.json"), JSON.stringify({ active: "chosen", main: { children: [
      { id: "other", state: { type: "markdown", state: { file: "03-概念/NAT&Reverse-Shell.md" } } },
      { id: "chosen", state: { type: "markdown", state: { file: "03-概念/SMB&Samba.md" } } }
    ] }, lastOpenFiles: ["secret.ovpn"] }));
    assert(n.lastWorkspaceNote(vault) === "03-概念/SMB&Samba.md");
  });
  await test("每輪必讀：指定筆記、關聯來源和政策確實注入", async () => {
    const { api, ctx } = boot();
    await fire(api, "input", { source: "interactive", text: "我現在在讀 SMB&Samba 那篇" }, ctx);
    const r = await fire(api, "before_agent_start", { prompt: "我的理解對嗎", systemPrompt: "BASE" }, ctx);
    const data = JSON.parse(r.message.content);
    assert(data.focus.mode === "manual"); assertIncludes(data.current.content, "自己的理解");
    assert(data.related.some(r => r.path.includes("Enumeration")));
    assertIncludes(r.systemPrompt, "沒有使用者回答證據");
  });
  await test("指定模式維持、檔案變更重讀、指令可切回 auto", async () => {
    const { api, ctx } = boot();
    await api._commands.get("study").handler("NAT&Reverse-Shell", ctx);
    writeFileSync(join(vault, "03-概念", "NAT&Reverse-Shell.md"), "# NAT\n剛剛改過\n");
    const r = await fire(api, "before_agent_start", { prompt: "继续", systemPrompt: "" }, ctx);
    assertIncludes(JSON.parse(r.message.content).current.content, "剛剛改過");
    await api._commands.get("study").handler("auto", ctx);
    const next = await fire(api, "before_agent_start", { prompt: "看看", systemPrompt: "" }, ctx);
    assert(JSON.parse(next.message.content).focus.mode === "auto");
  });
  await test("模糊指定會清掉舊目前筆記並要求選擇", async () => {
    const { api, ctx } = boot();
    await api._commands.get("study").handler("NAT&Reverse-Shell", ctx);
    await fire(api, "input", { source: "interactive", text: "我在讀 SMB 那篇" }, ctx);
    const r = await fire(api, "before_agent_start", { prompt: "看看", systemPrompt: "" }, ctx);
    const data = JSON.parse(r.message.content);
    assert(data.current === null && data.focus.mode === "pending");
  });
  await test("恢復當前分支的指定，不讀其他分支歷史", async () => {
    const { api, ctx } = boot();
    ctx.sessionManager.getBranch = () => [{ type: "custom", customType: "pentest-study-focus-v1", data: { vault, focus: { mode: "manual", path: "03-概念/SMB&Samba.md" } } }];
    ctx.sessionManager.getEntries = () => { throw new Error("不應讀所有分支"); };
    await fire(api, "session_start", {}, ctx);
    const r = await fire(api, "before_agent_start", { prompt: "看看", systemPrompt: "" }, ctx);
    assert(JSON.parse(r.message.content).current.path === "03-概念/SMB&Samba.md");
  });
  await test("模型選擇工具回傳新筆記實文，延伸來源不觸發語言指定", async () => {
    const { api, ctx } = boot();
    const r = await api._tools.get("study_focus").execute("t", { query: "SMB&Samba" }, undefined, undefined, ctx);
    assertIncludes(r.content[0].text, "自己的理解");
    await fire(api, "input", { source: "extension", text: "我在讀 NAT&Reverse-Shell 那篇" }, ctx);
    const next = await fire(api, "before_agent_start", { prompt: "看看", systemPrompt: "" }, ctx);
    assert(JSON.parse(next.message.content).current.path.includes("SMB"));
  });
  await test("舊快照不會反覆占用 model context", async () => {
    const { api, ctx } = boot();
    await api._commands.get("mode").handler("study", ctx);
    const r = await fire(api, "context", { messages: [
      { role: "custom", customType: "study-context", content: "old" },
      { role: "user", content: "hello" },
      { role: "custom", customType: "study-context", content: "new" }
    ] }, ctx);
    assert(r.messages.length === 2 && r.messages[1].content === "new");
  });
  await test("長筆記片段標註行號和截斷，能定位游標附近", () => {
    const note = { path: "long.md", title: "Long", text: Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n") };
    const e = n.excerpt(note, 800, "", 300);
    assert(e.truncated && e.startLine === 289); assertIncludes(e.content, "301: line 301");
  });
} finally { rmSync(tmp, { recursive: true, force: true }); }
report();
