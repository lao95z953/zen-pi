import './isolate.mjs';
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { test, assert, assertIncludes, report } from "./harness.mjs";

const tmp = mkdtempSync(join(tmpdir(), "pi-study-bridge-"));
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const realRequire = createRequire(import.meta.url);
const events = new Map(); let heartbeat; let active; let status = "";
class Plugin {
  registerEvent() {} registerInterval() {}
  addStatusBarItem() { return { setText: text => status = text }; }
}
class MarkdownView {}
class FileSystemAdapter { getBasePath() { return tmp; } }
const module = { exports: {} };
vm.runInNewContext(readFileSync(join(project, "obsidian/pi-study-bridge/main.js"), "utf8"), {
  module, require: name => name === "obsidian" ? { Plugin, MarkdownView, FileSystemAdapter } :
    name === "node:os" ? { homedir: () => tmp } : realRequire(name),
  setTimeout, clearTimeout, setInterval: fn => { heartbeat = fn; return 1; }, process, console,
});
const plugin = new module.exports();
plugin.app = { vault: { adapter: new FileSystemAdapter(), on: (event, fn) => events.set(event, fn) }, workspace: {
  on: (event, fn) => events.set(event, fn), onLayoutReady: fn => fn(), getActiveViewOfType: () => active,
} };
const snapshot = () => {
  const dir = join(tmp, ".pi/agent/obsidian");
  const file = join(dir, readdirSync(dir).find(f => f.endsWith(".json")));
  return { file, data: JSON.parse(readFileSync(file, "utf8")) };
};
try {
  await test("Obsidian 外掛註冊分頁與編輯事件，發布即時 buffer", () => {
    active = { file: { path: "SMB.md", extension: "md" }, editor: { getValue: () => "尚未儲存", getCursor: () => ({ line: 9 }) } };
    plugin.onload();
    const { file, data } = snapshot();
    assert(data.path === "SMB.md" && data.text === "尚未儲存" && data.cursorLine === 9);
    assert(events.has("active-leaf-change") && events.has("editor-change"));
    assert((statSync(file).mode & 0o777) === 0o600); assertIncludes(status, "連線");
  });
  await test("切換頁面與 heartbeat 都更新快照；非筆記分頁清空來源", () => {
    active = { file: { path: "NAT.md", extension: "md" }, editor: { getValue: () => "新版", getCursor: () => ({ line: 0 }) } };
    events.get("active-leaf-change")(); assert(snapshot().data.path === "NAT.md");
    heartbeat(); assert(snapshot().data.running);
    active = null; events.get("file-open")(); assert(snapshot().data.path === null);
  });
  await test("停用外掛立即標記離線，清除 buffer", () => {
    plugin.onunload(); const { data } = snapshot();
    assert(!data.running && data.path === null && data.text === undefined);
  });
} finally { rmSync(tmp, { recursive: true, force: true }); }
report();
