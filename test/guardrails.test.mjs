import './isolate.mjs';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve as presolve } from "node:path";
import { makeLoader, makeApi, makeCtx, fire, test, assert, assertIncludes, report } from "./harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const EXT = presolve(here, "..", "extensions", "guardrails", "index.ts");

const jiti = await makeLoader();
const factory = await jiti.import(EXT, { default: true });

/** 每個測試給一份乾淨的 extension 實例,減速丘的狀態才不會互相污染。 */
function boot(ctxOverrides = {}) {
  const api = makeApi();
  factory(api);
  return { api, ctx: makeCtx(ctxOverrides) };
}

const bash = (command, toolCallId = "tc-" + Math.random().toString(36).slice(2)) => ({
  toolName: "bash",
  toolCallId,
  input: { command },
});

/* ------------------------------ symlink ------------------------------ */

const tmp = mkdtempSync(join(tmpdir(), "zen-pi-test-"));
mkdirSync(join(tmp, "real"), { recursive: true });
writeFileSync(join(tmp, "real", "tool.sh"), "#!/bin/sh\necho hi\n");
symlinkSync(join(tmp, "real", "tool.sh"), join(tmp, "link.sh"));
writeFileSync(join(tmp, "plain.txt"), "x");

await test("`> symlink` 被擋下,並指出真正會被蓋掉的檔案", async () => {
  const { api, ctx } = boot({ cwd: tmp });
  const r = await fire(api, "tool_call", bash("echo hello > link.sh"), ctx);
  assert(r?.block === true, "應該要擋");
  assertIncludes(r.reason, "real/tool.sh", "reason 要點出 symlink 指向哪");
});

await test("寫進普通檔案不受影響", async () => {
  const { api, ctx } = boot({ cwd: tmp });
  const r = await fire(api, "tool_call", bash("echo hello > plain.txt"), ctx);
  assert(r === undefined, `不該擋,卻回了 ${JSON.stringify(r)}`);
});

await test("寫進還不存在的新檔案不受影響", async () => {
  const { api, ctx } = boot({ cwd: tmp });
  const r = await fire(api, "tool_call", bash("echo hello > brand-new.txt"), ctx);
  assert(r === undefined, `不該擋,卻回了 ${JSON.stringify(r)}`);
});

await test("2>&1 和 /dev/null 不會被誤判成重導向目標", async () => {
  const { api, ctx } = boot({ cwd: tmp });
  const r = await fire(api, "tool_call", bash("make 2>&1 > /dev/null"), ctx);
  assert(r === undefined, `不該擋,卻回了 ${JSON.stringify(r)}`);
});

/* -------------------------------- ffuf -------------------------------- */

await test("ffuf 沒設 matcher:第一次擋下並解釋 404 的坑", async () => {
  const { api, ctx } = boot();
  const r = await fire(api, "tool_call", bash("ffuf -u http://t/FUZZ -w list.txt"), ctx);
  assert(r?.block === true, "第一次應該要擋");
  assertIncludes(r.reason, "404");
  assertIncludes(r.reason, "-mc all");
});

await test("ffuf 同一條指令再送一次就放行(減速丘不是牆)", async () => {
  const { api, ctx } = boot();
  const cmd = "ffuf -u http://t/FUZZ -w list.txt";
  const first = await fire(api, "tool_call", bash(cmd), ctx);
  assert(first?.block === true, "第一次應該要擋");
  const second = await fire(api, "tool_call", bash(cmd), ctx);
  assert(second === undefined, `第二次應該放行,卻回了 ${JSON.stringify(second)}`);
});

await test("ffuf 有設 matcher 就不擋", async () => {
  const { api, ctx } = boot();
  const r = await fire(api, "tool_call", bash("ffuf -u http://t/FUZZ -w l.txt -mc all -fc 302"), ctx);
  assert(r === undefined, `不該擋,卻回了 ${JSON.stringify(r)}`);
});

/* ------------------------------ 破壞性指令 ------------------------------ */

await test("破壞性指令在非互動模式直接擋", async () => {
  const { api, ctx } = boot({ hasUI: false });
  const r = await fire(api, "tool_call", bash("rm -rf /home/example/projects/x"), ctx);
  assert(r?.block === true, "應該要擋");
  assertIncludes(r.reason, "遞迴");
});

await test("破壞性指令在互動模式問使用者,使用者說不就擋", async () => {
  const { api, ctx } = boot();
  let asked = false;
  ctx.ui.confirm = async () => { asked = true; return false; };
  const r = await fire(api, "tool_call", bash("git push --force origin main"), ctx);
  assert(asked, "應該要問過使用者");
  assert(r?.block === true, "使用者說不就該擋");
});

await test("破壞性指令使用者同意就放行", async () => {
  const { api, ctx } = boot();
  ctx.ui.confirm = async () => true;
  const r = await fire(api, "tool_call", bash("rm -rf build/"), ctx);
  assert(r === undefined, `同意後不該擋,卻回了 ${JSON.stringify(r)}`);
});

/* ------------------------------ 在筆電跑實驗 ------------------------------ */

await test("在筆電上跑訓練被擋,並提示改用 ssh ws", async () => {
  const { api, ctx } = boot();
  const r = await fire(api, "tool_call", bash("torchrun --nproc_per_node 2 train.py"), ctx);
  assert(r?.block === true, "應該要擋(這台不是 workstation)");
  assertIncludes(r.reason, "ssh ws");
});

await test("一般 python 指令不會被誤判成實驗", async () => {
  const { api, ctx } = boot();
  const r = await fire(api, "tool_call", bash("python3 -m pytest tests/"), ctx);
  assert(r === undefined, `不該擋,卻回了 ${JSON.stringify(r)}`);
});

/* ------------------------- 網路吞掉 payload ------------------------- */

await test("帶 SQLi payload 的請求不擋,但會提醒", async () => {
  const { api, ctx } = boot();
  const r = await fire(api, "tool_call", bash("curl 'http://t/?id=1 union select 1,2'"), ctx);
  assert(r === undefined, "只提醒不擋");
  assert(ctx._notices.length === 1, `應該要有一則提醒,實際 ${ctx._notices.length} 則`);
  assertIncludes(ctx._notices[0].text, "union select");
});

await test("payload timeout 之後,結果會被附上「先換條線」的說明", async () => {
  const { api, ctx } = boot();
  const id = "tc-dpi-1";
  await fire(api, "tool_call", bash("curl 'http://t/?id=1 union select 1'", id), ctx);
  const r = await fire(api, "tool_result", {
    toolName: "bash",
    toolCallId: id,
    input: { command: "curl 'http://t/?id=1 union select 1'" },
    content: [{ type: "text", text: "curl: (28) Operation timed out after 30000 ms" }],
    details: {},
    isError: false,
  }, ctx);
  assert(r?.content, "應該要回傳改過的 content");
  const appended = r.content[r.content.length - 1].text;
  assertIncludes(appended, "timeout 不等於目標有 WAF");
  assertIncludes(appended, "換網路");
});

await test("payload 有正常回應時不會亂加註記", async () => {
  const { api, ctx } = boot();
  const id = "tc-dpi-2";
  await fire(api, "tool_call", bash("curl 'http://t/?id=1 union select 1'", id), ctx);
  const r = await fire(api, "tool_result", {
    toolName: "bash",
    toolCallId: id,
    input: { command: "curl 'http://t/?id=1 union select 1'" },
    content: [{ type: "text", text: "<html>syntax error near 'union'</html>" }],
    details: {},
    isError: false,
  }, ctx);
  assert(r === undefined, `有回應就不該註記,卻回了 ${JSON.stringify(r)?.slice(0, 200)}`);
});

/* --------------------------- ls / grep 空輸出 --------------------------- */

await test("ls 回空的會被標成可能的假陰性", async () => {
  const { api, ctx } = boot();
  const r = await fire(api, "tool_result", {
    toolName: "bash",
    toolCallId: "tc-ls",
    input: { command: "ls -la /home/example/projects" },
    content: [{ type: "text", text: "" }],
    details: {},
    isError: false,
  }, ctx);
  assert(r?.content, "應該要回傳改過的 content");
  assertIncludes(r.content[r.content.length - 1].text, "find");
});

await test("ls 有輸出時不加註記", async () => {
  const { api, ctx } = boot();
  const r = await fire(api, "tool_result", {
    toolName: "bash",
    toolCallId: "tc-ls2",
    input: { command: "ls /tmp" },
    content: [{ type: "text", text: "a\nb\n" }],
    details: {},
    isError: false,
  }, ctx);
  assert(r === undefined, `有輸出就不該註記,卻回了 ${JSON.stringify(r)?.slice(0, 200)}`);
});

/* ------------------------------- 註冊項目 ------------------------------- */

await test("註冊了 /guardrails 指令", async () => {
  const { api } = boot();
  assert(api._commands.has("guardrails"), "找不到 /guardrails");
});

await test("session_start 會設定 footer 狀態", async () => {
  const { api, ctx } = boot();
  await fire(api, "session_start", { reason: "startup" }, ctx);
  const status = ctx._statuses.get("ronny-guardrails");
  assert(status, "沒設 status");
  assertIncludes(status, "護欄 on");
});

rmSync(tmp, { recursive: true, force: true });
report();
