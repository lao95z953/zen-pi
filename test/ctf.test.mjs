import './isolate.mjs';
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve as presolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeLoader, makeApi, makeCtx, fire, test, assert, assertIncludes, report } from "./harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const EXT = presolve(here, "..", "extensions", "ctf", "index.ts");
const TARGET_MOD = presolve(here, "..", "extensions", "ctf", "target.ts");

const jiti = await makeLoader();
const factory = await jiti.import(EXT, { default: true });
const { parseTarget, describeTarget, envExports } = await jiti.import(TARGET_MOD);

const tmp = mkdtempSync(join(tmpdir(), "zen-pi-ctf-"));

function boot() {
  const api = makeApi();
  factory(api);
  return { api, ctx: makeCtx({ cwd: tmp }) };
}

async function setChallenge(api, ctx, args) {
  await api._commands.get("ctf").handler(args, ctx);
}

/* ---------------------------- target 解析 ---------------------------- */

await test("`nc host port` 解成 host + port", () => {
  const t = parseTarget("nc chal.example.com 1337");
  assert(t.host === "chal.example.com", `host 錯:${t.host}`);
  assert(t.port === 1337, `port 錯:${t.port}`);
});

await test("`host:port` 解成 host + port", () => {
  const t = parseTarget("chal.example.com:1337");
  assert(t.host === "chal.example.com" && t.port === 1337);
});

await test("空白分隔的 `host port` 也認得", () => {
  const t = parseTarget("chal.example.com 1337");
  assert(t.host === "chal.example.com" && t.port === 1337);
});

await test("https URL 會補上 443", () => {
  const t = parseTarget("https://chal.example.com/admin");
  assert(t.host === "chal.example.com", `host 錯:${t.host}`);
  assert(t.port === 443, `port 錯:${t.port}`);
  assert(t.url === "https://chal.example.com/admin");
});

await test("只給主機名時 port 留空", () => {
  const t = parseTarget("chal.example.com");
  assert(t.host === "chal.example.com" && t.port === undefined);
});

await test("describeTarget 有 URL 就顯示 URL", () => {
  assert(describeTarget(parseTarget("http://a.b/c")) === "http://a.b/c");
  assert(describeTarget(parseTarget("a.b:99")) === "a.b:99");
});

await test("envExports 會把單引號跳脫掉", () => {
  const lines = envExports({ raw: "x", host: "a'b" });
  const hostLine = lines.find((l) => l.startsWith("export TARGET_HOST="));
  assert(!/[^\\]'[^\\']*'[^\\']*'$/.test(hostLine) || hostLine.includes("\\'"), `沒跳脫:${hostLine}`);
  assertIncludes(hostLine, "\\'");
});

/* ------------------------------ /ctf 指令 ------------------------------ */

await test("/ctf <名字> <目標> 會設好狀態列和 session 名稱", async () => {
  const { api, ctx } = boot();
  await setChallenge(api, ctx, "buggy-dotnet https://chal.example.com/");
  const status = ctx._statuses.get("ronny-ctf");
  assertIncludes(status, "buggy-dotnet");
  assertIncludes(status, "https://chal.example.com/");
});

await test("/ctf clear 會清掉狀態列", async () => {
  const { api, ctx } = boot();
  await setChallenge(api, ctx, "x a.b:1");
  await setChallenge(api, ctx, "clear");
  assert(ctx._statuses.get("ronny-ctf") === "", `沒清乾淨:${ctx._statuses.get("ronny-ctf")}`);
});

await test("/ctf target 只改目標,題目名留著", async () => {
  const { api, ctx } = boot();
  await setChallenge(api, ctx, "rich nc old.host 1");
  await setChallenge(api, ctx, "target nc new.host 2222");
  const status = ctx._statuses.get("ronny-ctf");
  assertIncludes(status, "rich");
  assertIncludes(status, "new.host:2222");
});

/* --------------------------- 注進 bash 和提示 --------------------------- */

await test("設好目標後,bash 指令前面會被塞 export", async () => {
  const { api, ctx } = boot();
  await setChallenge(api, ctx, "rich nc chal.example.com 1337");
  const event = { toolName: "bash", toolCallId: "t1", input: { command: "nc $TARGET_HOST $TARGET_PORT" } };
  await fire(api, "tool_call", event, ctx);
  assertIncludes(event.input.command, "export TARGET_HOST='chal.example.com'");
  assertIncludes(event.input.command, "export TARGET_PORT='1337'");
  assertIncludes(event.input.command, "nc $TARGET_HOST $TARGET_PORT");
});

await test("沒設目標時不動 bash 指令", async () => {
  const { api, ctx } = boot();
  const event = { toolName: "bash", toolCallId: "t2", input: { command: "ls" } };
  await fire(api, "tool_call", event, ctx);
  assert(event.input.command === "ls", `被改壞了:${event.input.command}`);
});

await test("before_agent_start 會把題目資訊接到系統提示後面", async () => {
  const { api, ctx } = boot();
  await setChallenge(api, ctx, "rich nc chal.example.com 1337");
  const r = await fire(api, "before_agent_start", { prompt: "go", systemPrompt: "BASE" }, ctx);
  assertIncludes(r.systemPrompt, "BASE");
  assertIncludes(r.systemPrompt, "rich");
  assertIncludes(r.systemPrompt, "chal.example.com:1337");
  assertIncludes(r.systemPrompt, "$TARGET_HOST");
});

await test("沒設題目時不碰系統提示", async () => {
  const { api, ctx } = boot();
  const r = await fire(api, "before_agent_start", { prompt: "go", systemPrompt: "BASE" }, ctx);
  assert(r === undefined, `不該改,卻回了 ${JSON.stringify(r)}`);
});

/* -------------------------------- 工具 -------------------------------- */

await test("ctf_note 會把結論追加到 NOTES.md", async () => {
  const { api, ctx } = boot();
  await setChallenge(api, ctx, "rich");
  const tool = api._tools.get("ctf_note");
  const r = await tool.execute("t", { note: "後端是 .NET 8,序列化走 BinaryFormatter" }, undefined, undefined, ctx);
  const path = join(tmp, "NOTES.md");
  assert(existsSync(path), "NOTES.md 沒建出來");
  const body = readFileSync(path, "utf8");
  assertIncludes(body, "BinaryFormatter");
  assertIncludes(body, "rich ·");
  assertIncludes(r.content[0].text, "NOTES.md");
});

await test("ctf_flag 拒絕不像 flag 的字串", async () => {
  const { api, ctx } = boot();
  const tool = api._tools.get("ctf_flag");
  let threw = false;
  try {
    await tool.execute("t", { flag: "TODO" }, undefined, undefined, ctx);
  } catch (err) {
    threw = true;
    assertIncludes(err.message, "不是 flag");
  }
  assert(threw, "應該要丟錯");
});

await test("ctf_flag 收下正常 flag 並寫進 FLAG.txt", async () => {
  const { api, ctx } = boot();
  await setChallenge(api, ctx, "rich");
  const tool = api._tools.get("ctf_flag");
  const r = await tool.execute("t", { flag: "hitcon{a_real_flag_here}" }, undefined, undefined, ctx);
  assert(r.details.duplicate === false);
  const body = readFileSync(join(tmp, "FLAG.txt"), "utf8");
  assertIncludes(body, "hitcon{a_real_flag_here}");
  assertIncludes(body, "rich");
});

await test("同一個 flag 記第二次會被認出是重複的", async () => {
  const { api, ctx } = boot();
  const tool = api._tools.get("ctf_flag");
  const r = await tool.execute("t", { flag: "hitcon{a_real_flag_here}" }, undefined, undefined, ctx);
  assert(r.details.duplicate === true, "應該要標成重複");
});

rmSync(tmp, { recursive: true, force: true });
report();
