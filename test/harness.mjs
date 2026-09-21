import './isolate.mjs';
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PKG = "@earendil-works/pi-coding-agent";

/** 找出 pi 裝在哪。允許用 PI_PKG 覆蓋。 */
export function piPackageDir() {
  if (process.env.PI_PKG) return process.env.PI_PKG;
  const root = execSync("npm root -g", { encoding: "utf8" }).trim();
  const dir = join(root, ...PKG.split("/"));
  if (!existsSync(dir)) {
    throw new Error(`找不到 ${PKG}(找過 ${dir})。先 npm install -g ${PKG},或設 PI_PKG。`);
  }
  return dir;
}

/** 從 package.json 挖出真正的入口檔。typebox 這類 ESM-only 套件不能只給目錄。 */
function resolveEntry(dir) {
  const pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const pick = (v) => {
    if (typeof v === "string") return v;
    if (v && typeof v === "object") return pick(v.import ?? v.default ?? v.require ?? v.node);
    return undefined;
  };
  const rel =
    pick(typeof pj.exports === "string" ? pj.exports : pj.exports?.["."]) ??
    pj.module ??
    pj.main ??
    "index.js";
  return join(dir, rel);
}

/** 建一個能解析 pi 內建套件的 jiti loader。 */
export async function makeLoader() {
  const pkgDir = piPackageDir();
  const require = createRequire(join(pkgDir, "package.json"));
  const { createJiti } = require("jiti");

  const alias = { [PKG]: resolveEntry(pkgDir) };
  for (const dep of ["typebox", "@earendil-works/pi-ai", "@earendil-works/pi-tui"]) {
    const dir = join(pkgDir, "node_modules", ...dep.split("/"));
    if (existsSync(join(dir, "package.json"))) alias[dep] = resolveEntry(dir);
  }

  return createJiti(import.meta.url, { interopDefault: true, alias });
}

/** 假的 ExtensionAPI,把註冊的東西留著讓測試檢查。 */
export function makeApi() {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  const sent = [];
  const entries = [];
  return {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    registerCommand(name, opts) { commands.set(name, opts); },
    registerTool(def) { tools.set(def.name, def); },
    registerShortcut() {},
    registerFlag() {},
    registerProvider() {},
    registerEntryRenderer() {},
    appendEntry(customType, data) { entries.push({ customType, data }); },
    sendMessage(msg, opts) { sent.push({ kind: "custom", msg, opts }); },
    sendUserMessage(content, opts) { sent.push({ kind: "user", content, opts }); },
    setSessionName() {},
    setThinkingLevel() {},
    async exec() { return { stdout: "", stderr: "", code: 0, killed: false }; },
    getActiveTools() { return []; },
    getAllTools() { return []; },
    setActiveTools() {},
    getCommands() { return []; },
    _handlers: handlers,
    _commands: commands,
    _tools: tools,
    _sent: sent,
    _entries: entries,
  };
}

/** 假的 ExtensionContext。notify/confirm 的結果都留下來讓測試檢查。 */
export function makeCtx(overrides = {}) {
  const notices = [];
  const statuses = new Map();
  const ctx = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    signal: undefined,
    ui: {
      notify(text, level) { notices.push({ text, level }); },
      setStatus(id, text) { statuses.set(id, text); },
      setWidget() {},
      setTitle() {},
      async confirm() { return false; },
      async select() { return null; },
      async input() { return null; },
    },
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
      buildContextEntries: () => [],
      getSessionId: () => "test-session-0000",
      getLeafId: () => null,
    },
    isProjectTrusted: () => true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    abort() {},
    shutdown() {},
    getSystemPrompt: () => "",
    _notices: notices,
    _statuses: statuses,
    ...overrides,
  };
  return ctx;
}

/** 觸發某個事件,回傳最後一個非 undefined 的結果。 */
export async function fire(api, eventName, event, ctx) {
  const hs = api._handlers.get(eventName) ?? [];
  let result;
  for (const h of hs) {
    const r = await h(event, ctx);
    if (r !== undefined) result = r;
  }
  return result;
}

/* --------------------------- 極簡測試框架 --------------------------- */

const results = [];

export async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err });
  }
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assert failed");
}

export function assertIncludes(haystack, needle, msg) {
  const s = String(haystack ?? "");
  if (!s.includes(needle)) {
    throw new Error(`${msg || "should include"}: 找不到 ${JSON.stringify(needle)}\n實際內容: ${s.slice(0, 400)}`);
  }
}

export function report() {
  let failed = 0;
  for (const r of results) {
    if (r.ok) {
      console.log(`  ok   ${r.name}`);
    } else {
      failed++;
      console.log(`  FAIL ${r.name}`);
      console.log(`       ${r.err?.message ?? r.err}`);
    }
  }
  const total = results.length;
  console.log(`\n${total - failed}/${total} passed`);
  if (failed > 0) process.exitCode = 1;
}
