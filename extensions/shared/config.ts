import { readFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { join } from "node:path";

/**
 * 個人設定。預設值寫死在這裡,要覆蓋就在 ~/.pi/agent/ronny.json 放同名欄位,
 * 不用改 code —— 這樣兩台機器可以裝同一份 package 但行為不同。
 */
export interface RonnyConfig {
  /** Workstation 的 hostname。在別台跑實驗指令就會被攔。 */
  workstationHost: string;
  /** 連 workstation 用的 ssh alias。 */
  workstationSsh: string;
  /** CTF 根目錄。 */
  ctfRoot: string;
  /** injection lab 的 trace 落地目錄。 */
  labDir: string;
  /** trace 是否記下完整的 provider payload。關掉只留統計欄位。 */
  labFullPayload: boolean;
  /** 個別護欄開關,填 false 就關掉。 */
  rules: Record<string, boolean>;
  /** 額外的「這是實驗、該去 ws 跑」判斷式,字串會當 RegExp source 編譯。 */
  extraExperimentPatterns: string[];
  /** 可掛載的 LLM Wiki:短名 → vault 絕對路徑,可用 ~/ 開頭。 */
  wikis: Record<string, string>;
  /** 新對話預設掛載哪個短名。留空就用清單第一個。 */
  defaultWiki: string;
}

const DEFAULTS: RonnyConfig = {
  workstationHost: "tuf-fedora",
  workstationSsh: "ws",
  ctfRoot: join(homedir(), "ctf"),
  labDir: join(homedir(), ".pi", "agent", "lab"),
  labFullPayload: true,
  rules: {},
  extraExperimentPatterns: [],
  wikis: {},
  defaultWiki: "",
};

let cached: RonnyConfig | undefined;

export function loadConfig(): RonnyConfig {
  if (cached) return cached;
  let overrides: Partial<RonnyConfig> = {};
  // PI_RONNY_CONFIG 可以指到別的設定檔,測試和臨時實驗用。
  const path = process.env.PI_RONNY_CONFIG || join(homedir(), ".pi", "agent", "ronny.json");
  try {
    const raw = readFileSync(path, "utf8");
    overrides = JSON.parse(raw) as Partial<RonnyConfig>;
  } catch {
    // 沒有設定檔是正常情況,用預設值。
  }
  cached = {
    ...DEFAULTS,
    ...overrides,
    rules: { ...DEFAULTS.rules, ...(overrides.rules ?? {}) },
    wikis: { ...DEFAULTS.wikis, ...(overrides.wikis ?? {}) },
  };
  return cached;
}

/** 護欄預設全開,只有明確設成 false 才關。 */
export function ruleEnabled(cfg: RonnyConfig, name: string): boolean {
  return cfg.rules[name] !== false;
}

export function onWorkstation(cfg: RonnyConfig): boolean {
  return hostname().toLowerCase().includes(cfg.workstationHost.toLowerCase());
}

export function shortHost(): string {
  return hostname().split(".")[0];
}
