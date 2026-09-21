import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { loadConfig } from "../shared/config.ts";
import { checkedDirectory, WIKI_DIR } from "./storage.ts";

export type Wiki = { name: string; path: string; ready: boolean; legacy?: boolean };
export type WikiMount = { path: string; name?: string };
export type WikiMounts = { list: () => Wiki[]; current: () => string; use: (name: string, cwd: string) => void; reset: () => void };
const expand = (path: string) => path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
const ready = (path: string) => { try { return statSync(checkedDirectory(path)).isDirectory(); } catch { return false; } };

export function defaultWikiPath(): string {
  const path = expand(process.env.PI_LLM_WIKI || join(homedir(), ".pi", "llm-wiki"));
  if (!isAbsolute(path)) throw new Error("PI_LLM_WIKI 必須是絕對路徑。");
  return resolve(path);
}

/** New aliases point directly at a Wiki. Legacy aliases still point at vault/07-Agent-Wiki. */
export function listWikis(): Wiki[] {
  const config = loadConfig(true), path = defaultWikiPath();
  const all: Wiki[] = [{ name: "default", path, ready: ready(path) }];
  const add = (name: string, raw: unknown, legacy = false) => {
    if (!name || typeof raw !== "string" || !isAbsolute(expand(raw)) || all.some(w => w.name === name)) return;
    const path = resolve(expand(raw), ...(legacy ? [WIKI_DIR] : []));
    all.push({ name, path, ready: ready(path), ...(legacy ? { legacy: true } : {}) });
  };
  for (const [name, path] of Object.entries(config.llmWikis)) add(name, path);
  for (const [name, path] of Object.entries(config.wikis)) add(name, path, true);
  return all;
}

export function mountWiki(input: string, cwd: string): WikiMount {
  const target = input.trim();
  const alias = listWikis().find(w => w.name === target);
  if (alias) return { path: checkedDirectory(alias.path, true), name: alias.name };
  if (!isAbsolute(target) && !/^(?:\.\.?\/|~\/)/.test(target)) throw new Error("請用 /wiki use ./llm-wiki、絕對路徑或 /wiki list 中的名稱。");
  return { path: checkedDirectory(resolve(cwd, expand(target)), true) };
}

/** Saved paths never follow cwd, an edited alias, or a removed alias to a different folder. */
export function resolveMount(mount: WikiMount): string {
  if (mount.name && mount.name !== "default") {
    const alias = listWikis().find(w => w.name === mount.name);
    if (!alias || alias.path !== mount.path) throw new Error(`Wiki「${mount.name}」的設定已移除或改變，請重新 /wiki use；未切換到其他資料夾。`);
  }
  if (!ready(mount.path)) throw new Error(`Wiki 掛載無法使用：${mount.path}。請確認目錄或重新 /wiki use；未改用預設位置。`);
  return realpathSync(mount.path);
}

/** Source notes remain independent of the LLM Wiki mount. */
export function sourceVaultPath(): string | undefined {
  const config = loadConfig(true);
  const raw = process.env.PI_STUDY_VAULT || (config.defaultWiki ? config.wikis[config.defaultWiki] : undefined);
  if (!raw) return undefined;
  const path = expand(raw);
  if (!isAbsolute(path)) throw new Error("PI_STUDY_VAULT 必須是絕對路徑。");
  return resolve(path);
}
export function resolveSourceVault(path = sourceVaultPath()): string {
  if (!path || !existsSync(path) || !statSync(path).isDirectory()) throw new Error("來源筆記庫尚未就緒，請設定 PI_STUDY_VAULT；LLM Wiki 掛載不會改變來源筆記庫。");
  return realpathSync(path);
}
