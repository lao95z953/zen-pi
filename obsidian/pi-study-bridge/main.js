const { Plugin, MarkdownView, FileSystemAdapter } = require("obsidian");
const { mkdirSync, realpathSync, writeFileSync, renameSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { homedir } = require("node:os");
const { join } = require("node:path");

module.exports = class PiStudyBridge extends Plugin {
  onload() {
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) return;
    this.vaultPath = realpathSync(this.app.vault.adapter.getBasePath());
    const id = createHash("sha256").update(this.vaultPath).digest("hex").slice(0, 24);
    const dir = join(homedir(), ".pi", "agent", "obsidian");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.stateFile = join(dir, `${id}.json`);
    this.statusEl = this.addStatusBarItem();
    const update = () => this.publish(true);
    this.registerEvent(this.app.workspace.on("active-leaf-change", update));
    this.registerEvent(this.app.workspace.on("file-open", update));
    this.registerEvent(this.app.workspace.on("editor-change", () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(update, 250);
    }));
    this.registerEvent(this.app.vault.on("rename", update));
    this.registerEvent(this.app.vault.on("delete", update));
    this.registerInterval(setInterval(update, 10000));
    this.app.workspace.onLayoutReady(update);
  }

  publish(running) {
    if (!this.stateFile) return;
    const view = running ? this.app.workspace.getActiveViewOfType(MarkdownView) : null;
    const state = { version: 1, vault: this.vaultPath, updatedAt: Date.now(), running, path: null };
    if (view?.file?.extension === "md") {
      state.path = view.file.path;
      const value = view.editor?.getValue();
      if (typeof value === "string" && value.length <= 512 * 1024) state.text = value;
      state.cursorLine = view.editor?.getCursor()?.line;
    }
    try {
      const temp = `${this.stateFile}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
      renameSync(temp, this.stateFile);
      this.statusEl?.setText(running ? "Pi 筆記連線" : "");
    } catch (err) {
      this.statusEl?.setText("Pi 筆記連線失敗");
      console.error("Zen Pi Study Bridge could not publish state", err);
    }
  }

  onunload() { clearTimeout(this.timer); this.publish(false); }
};
