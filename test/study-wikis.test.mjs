import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { makeLoader, makeApi, makeCtx, fire, test, assert, assertIncludes, report } from "./harness.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIKIS = join(root, "extensions/study/wikis.ts");
const tmp = mkdtempSync(join(tmpdir(), "pi-wiki-mount-"));
const cpts = join(tmp, "cpts"), lab = join(tmp, "lab"), envVault = join(tmp, "env");
for (const dir of [cpts, lab, envVault]) mkdirSync(dir);

const config = join(tmp, "ronny.json");
writeFileSync(config, JSON.stringify({
  wikis: { cpts, lab, gone: join(tmp, "missing"), relative: "not/absolute" },
  defaultWiki: "lab",
}));
process.env.PI_RONNY_CONFIG = config;
process.env.PI_STUDY_VAULT = envVault;

// loadConfig 的快取是 module 層級的，同一個 process 只讀得到一組設定，
// 連換一個 jiti loader 都繞不過去。需要別組設定的情境只能開子程序。
let serial = 0;
const child = (env, body) => {
  const script = join(tmp, `child-${serial++}.mjs`);
  writeFileSync(script, `import { makeLoader } from ${JSON.stringify(join(root, "test/harness.mjs"))};
const jiti = await makeLoader();
const wikis = await jiti.import(${JSON.stringify(WIKIS)});
${body}
`);
  return spawnSync(process.execPath, [script], { env: { ...process.env, ...env }, encoding: "utf8" });
};

const jiti = await makeLoader();
const { listWikis, defaultWikiName, resolveWiki, knownWiki, ENV_WIKI } = await jiti.import(WIKIS);

await test("設定檔的 wikis 與 PI_STUDY_VAULT 一起列入清單", () => {
  const names = listWikis().map(w => w.name);
  assert(names.includes("cpts") && names.includes("lab"), `設定檔的項目要在清單裡：${names}`);
  assert(names.includes(ENV_WIKI), `PI_STUDY_VAULT 要以 ${ENV_WIKI} 列入：${names}`);
});

await test("相對路徑不算有效掛載點", () => {
  assert(!listWikis().some(w => w.name === "relative"), "非絕對路徑必須被忽略，否則解析結果會跟著 cwd 跑");
});

await test("路徑不存在的仍然列出，只是標成未就緒", () => {
  const gone = listWikis().find(w => w.name === "gone");
  assert(gone, "路徑不存在不該讓項目整個消失，否則看不出是打錯名字還是 vault 被搬走");
  assert(gone.ready === false, "不存在的路徑要標 ready=false");
  assert(listWikis().find(w => w.name === "cpts").ready === true, "存在的路徑要標 ready=true");
});

await test("defaultWiki 決定新對話掛哪一個", () => {
  assert(defaultWikiName() === "lab", `設定檔指名 lab，實際 ${defaultWikiName()}`);
});

await test("resolveWiki 回傳 realpath", () => {
  assert(resolveWiki("cpts") === realpathSync(cpts), "掛載路徑要解析成 realpath");
});

await test("找不到名稱時要把可用選項一起講出來", () => {
  let message = "";
  try { resolveWiki("nope"); } catch (err) { message = err.message; }
  assertIncludes(message, "nope");
  assertIncludes(message, "cpts", "錯誤訊息要列出可用名稱，否則使用者只能猜");
});

await test("路徑壞掉的掛載點要明講是哪一條路徑", () => {
  let message = "";
  try { resolveWiki("gone"); } catch (err) { message = err.message; }
  assertIncludes(message, join(tmp, "missing"));
});

await test("knownWiki 只認清單內的名稱", () => {
  assert(knownWiki("cpts") === true);
  assert(knownWiki("relative") === false, "被忽略的項目不能算已知，否則 session 還原會掛上解析不了的名字");
});

await test("完全沒有設定時，錯誤要指出兩個可以設定的位置", () => {
  const run = child({ PI_RONNY_CONFIG: join(tmp, "nonexistent.json"), PI_STUDY_VAULT: "" },
    `try { wikis.resolveWiki("default"); console.log("NO_THROW"); } catch (err) { console.log(err.message); }`);
  assert(run.status === 0, `子程序失敗：${run.stderr}`);
  assertIncludes(run.stdout, "PI_STUDY_VAULT");
  assertIncludes(run.stdout, "ronny.json");
});

await test("設定檔可以用同名項目蓋掉 PI_STUDY_VAULT", () => {
  const override = join(tmp, "override.json");
  writeFileSync(override, JSON.stringify({ wikis: { [ENV_WIKI]: cpts } }));
  const run = child({ PI_RONNY_CONFIG: override, PI_STUDY_VAULT: envVault },
    `console.log(JSON.stringify(wikis.listWikis()));`);
  assert(run.status === 0, `子程序失敗：${run.stderr}`);
  const list = JSON.parse(run.stdout);
  assert(list.length === 1, `同名不該出現兩筆：${JSON.stringify(list)}`);
  assert(list[0].path === cpts, `設定檔要優先於環境變數，實際 ${list[0].path}`);
});

const ENTRY = "pentest-study-focus-v1";
const factory = await jiti.import(join(root, "extensions/study/index.ts"), { default: true });
const boot = (branch = []) => {
  const api = makeApi();
  factory(api);
  const ctx = makeCtx({ sessionManager: {
    getEntries: () => branch, getBranch: () => branch, buildContextEntries: () => [],
    getSessionId: () => "wiki-mount-test", getLeafId: () => null,
  } });
  return { api, ctx };
};
const entryOf = (name, data) => ({ type: "custom", customType: name, data });
const lastNotice = ctx => ctx._notices[ctx._notices.length - 1]?.text ?? "";
const mountedIn = async (api, ctx) => { await api._commands.get("wiki").handler("list", ctx); return lastNotice(ctx); };

await test("切換掛載會寫進 session entry", async () => {
  const { api, ctx } = boot();
  await fire(api, "session_start", {}, ctx);
  await api._commands.get("wiki").handler("use cpts", ctx);
  const entry = api._entries.filter(e => e.customType === ENTRY).pop();
  assert(entry?.data?.wiki === "cpts", `entry 要記下掛載名稱，實際 ${JSON.stringify(entry?.data)}`);
  assert(entry?.data?.vault === realpathSync(cpts), "entry 的 vault 要跟著掛載走");
});

await test("重開對話會還原上次的掛載", async () => {
  const branch = [entryOf(ENTRY, { wiki: "cpts", vault: realpathSync(cpts), focus: { mode: "auto" } })];
  const { api, ctx } = boot(branch);
  await fire(api, "session_start", {}, ctx);
  assertIncludes(await mountedIn(api, ctx), "→ cpts", "還原後當前掛載要是 cpts 而不是預設的 lab");
});

await test("舊的 session entry 沒有 wiki 欄位也不會壞", async () => {
  const branch = [entryOf(ENTRY, { vault: realpathSync(lab), focus: { mode: "auto" } })];
  const { api, ctx } = boot(branch);
  await fire(api, "session_start", {}, ctx);
  assertIncludes(await mountedIn(api, ctx), "→ lab", "沒有 wiki 欄位就退回設定檔預設值");
});

await test("還原時會略過已經不存在的掛載名稱", async () => {
  const branch = [entryOf(ENTRY, { wiki: "removed-wiki", vault: "/nowhere", focus: { mode: "auto" } })];
  const { api, ctx } = boot(branch);
  await fire(api, "session_start", {}, ctx);
  assertIncludes(await mountedIn(api, ctx), "→ lab", "設定檔已移除的名稱不能卡住 session");
});

await test("掛到不存在的名稱要報錯，而且不動到目前掛載", async () => {
  const { api, ctx } = boot();
  await fire(api, "session_start", {}, ctx);
  await api._commands.get("wiki").handler("use nope", ctx);
  const failure = ctx._notices[ctx._notices.length - 1];
  assert(failure?.level === "error", `應該是錯誤通知，實際 ${JSON.stringify(failure)}`);
  assertIncludes(await mountedIn(api, ctx), "→ lab", "失敗的切換不能留下半套狀態");
});

report();
