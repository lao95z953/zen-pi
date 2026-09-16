import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { loadConfig } from "../shared/config.ts";

/** `PI_STUDY_VAULT` 沒有名字，列進清單時用這個保留名稱；設定檔可以用同名蓋掉它。 */
export const ENV_WIKI = "default";
export type Wiki = { name: string; path: string; ready: boolean };
/** 掛載控制面，由 extension 主體提供當前 session 的狀態。 */
export type WikiMounts = { list: () => Wiki[]; current: () => string; use: (name: string) => void };

const expand = (path: string) => path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

/**
 * 可掛載的 wiki：`~/.pi/agent/ronny.json` 的 wikis 加上 `PI_STUDY_VAULT`。
 * 路徑不存在的仍然列出（ready=false），否則使用者看不出是名字打錯還是 vault 被搬走。
 */
export function listWikis(): Wiki[] {
  const wikis: Wiki[] = [];
  const add = (name: string, raw: string) => {
    const path = expand(raw);
    if (!isAbsolute(path) || wikis.some(w => w.name === name)) return;
    wikis.push({ name, path, ready: existsSync(path) });
  };
  for (const [name, path] of Object.entries(loadConfig().wikis)) if (name && typeof path === "string") add(name, path);
  if (process.env.PI_STUDY_VAULT) add(ENV_WIKI, process.env.PI_STUDY_VAULT);
  return wikis;
}

/** 新對話的預設掛載：設定檔指名的那個，否則清單第一個。 */
export function defaultWikiName(): string {
  const wikis = listWikis(), preferred = loadConfig().defaultWiki;
  if (preferred && wikis.some(w => w.name === preferred)) return preferred;
  return wikis[0]?.name ?? ENV_WIKI;
}

export function knownWiki(name: string): boolean {
  return listWikis().some(w => w.name === name);
}

/** 解析成 realpath。失敗時把可用名稱一起講出來，否則使用者只能猜。 */
export function resolveWiki(name: string): string {
  const wikis = listWikis();
  if (!wikis.length) throw new Error("沒有可掛載的 Wiki：請設定 PI_STUDY_VAULT，或在 ~/.pi/agent/ronny.json 的 wikis 填入 vault 絕對路徑。");
  const hit = wikis.find(w => w.name === name);
  if (!hit) throw new Error(`找不到 Wiki「${name}」。可用：${wikis.map(w => w.name).join("、")}`);
  try {
    return realpathSync(hit.path);
  } catch {
    throw new Error(`Wiki「${name}」的路徑無法讀取：${hit.path}`);
  }
}
