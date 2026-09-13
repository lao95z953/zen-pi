import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

export interface Hit {
  /** 規則代號,對應設定檔 rules 裡的 key。 */
  rule: string;
  /** 要給模型看的說明。寫清楚「該改成什麼」,不然它只會換個寫法再撞一次。 */
  reason: string;
}

/* ------------------------------------------------------------------ *
 * 1. `>` 會穿寫到 symlink 目標
 * ------------------------------------------------------------------ */

const REDIRECT_RE = /(?:^|[^0-9&>])(>{1,2})\s*("[^"]+"|'[^']+'|[^\s;|&<>()]+)/g;

function unquote(s: string): string {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
    return s.slice(1, -1);
  }
  return s;
}

/** 抽出指令裡所有 stdout 重導向的目標路徑。跳過 fd 重導向和 /dev/*。 */
export function redirectTargets(command: string): string[] {
  const out: string[] = [];
  REDIRECT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REDIRECT_RE.exec(command)) !== null) {
    const target = unquote(m[2]);
    if (!target || target.startsWith("&") || target.startsWith("/dev/")) continue;
    if (target.startsWith("$")) continue; // 變數展開,靜態看不出來
    out.push(target);
  }
  return out;
}

export function checkSymlinkRedirect(command: string, cwd: string): Hit | undefined {
  for (const target of redirectTargets(command)) {
    const abs = resolve(cwd, target);
    let isLink = false;
    try {
      isLink = lstatSync(abs).isSymbolicLink();
    } catch {
      continue; // 不存在就是要新建,沒問題
    }
    if (!isLink) continue;
    let real = "(解不開)";
    try {
      real = realpathSync(abs);
    } catch {
      /* 斷掉的 symlink */
    }
    return {
      rule: "symlinkRedirect",
      reason:
        `\`${target}\` 是 symlink,\`>\` 會穿寫到它指的 ${real},把那個檔案的內容蓋掉。\n` +
        `要把它變成獨立檔案的話,先 \`rm ${target}\` 再寫入;` +
        `真的要改目標檔就直接寫 ${real},別靠 symlink 轉一手。`,
    };
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * 2. ffuf 沒設 matcher
 * ------------------------------------------------------------------ */

const FFUF_FILTER_FLAGS = ["-mc", "-ms", "-ml", "-mw", "-mr", "-fc", "-fs", "-fl", "-fw", "-fr"];

export function checkFfufMatcher(command: string): Hit | undefined {
  if (!/(^|[\s;|&(])ffuf\b/.test(command)) return undefined;
  if (FFUF_FILTER_FLAGS.some((f) => new RegExp(`\\s${f}(\\s|=)`).test(command))) return undefined;
  return {
    rule: "ffufMatcher",
    reason:
      "這個 ffuf 沒指定 matcher,會套預設 `-mc 200,204,301,302,307,401,403,405,500` —— **不含 404**。\n" +
      "打「未授權一律 302 到 /login」那種站(Spring Security 之類),permitAll 但沒 controller 的路徑回 404 會被整批漏掉,掃出來一片空白。\n" +
      "改成 `-mc all -fc <大宗的重導向碼>`,讓「回應碼跟大宗不一樣」的路徑浮出來。真的要用預設就原封不動再送一次。",
  };
}

/* ------------------------------------------------------------------ *
 * 3. 已知會被本地網路在封包層吞掉的 payload
 * ------------------------------------------------------------------ */

interface DpiSig {
  re: RegExp;
  label: string;
  /** cgnat = 家用那條、school = 學校那條、both = 兩條都中 */
  where: string;
}

const DPI_SIGS: DpiSig[] = [
  { re: /union\s+all\s+select/i, label: "union all select", where: "both" },
  { re: /union\s+select/i, label: "union select", where: "both" },
  { re: /\bor\s+1\s*=\s*1/i, label: "or 1=1", where: "cgnat" },
  { re: /'\s*(or|and)\b/i, label: "引號緊接 or/and", where: "school" },
  { re: /select\b[\s\S]{0,80}?\bfrom\b/i, label: "select … from", where: "school" },
  { re: /\border\s+by\b/i, label: "order by", where: "school" },
  { re: /<script\b/i, label: "<script>", where: "cgnat" },
  { re: /etc\/passwd/i, label: "etc/passwd", where: "cgnat" },
  { re: /@@version/i, label: "@@version", where: "cgnat" },
  { re: /waitfor\s+delay/i, label: "waitfor delay", where: "cgnat" },
  { re: /pg_sleep\s*\(/i, label: "pg_sleep(", where: "cgnat" },
  { re: /\?-s(\b|&|$)/, label: "query string ?-s", where: "cgnat" },
];

const OUTBOUND_RE = /(^|[\s;|&(])(curl|wget|ffuf|feroxbuster|gobuster|nc|ncat|nmap|sqlmap|httpx|python3?\s+-c)\b/;

/** 回傳命中的簽名。只在指令看起來會對外送封包時才判。 */
export function matchDpiSignatures(command: string): DpiSig[] {
  if (!OUTBOUND_RE.test(command)) return [];
  return DPI_SIGS.filter((s) => s.re.test(command));
}

export function dpiNote(sigs: DpiSig[]): string {
  const list = sigs.map((s) => `\`${s.label}\`(${s.where})`).join("、");
  return (
    `⚠ 這個請求帶了 ${list} —— 使用者的兩條網路都會在**封包層**靜默吞掉這類 payload:` +
    "不回 RST、不回 403,純 timeout,伺服器收得到但回應永遠不到。\n" +
    "**timeout 不等於目標有 WAF。** 先拿同一個 payload 打一台不相干的主機/port,確認是本地還是目標在擋;" +
    "是本地就請使用者換網路(手機熱點),不要花時間研究繞過。\n" +
    "它會做 TCP 重組、URL decode、`/./` 正規化、chunked 解碼,所以分段送、百分號編碼、chunked 都繞不過。"
  );
}

/* ------------------------------------------------------------------ *
 * 4. 在筆電上跑實驗
 * ------------------------------------------------------------------ */

const EXPERIMENT_RES = [
  /\b(torchrun|deepspeed)\b/,
  /\baccelerate\s+launch\b/,
  /\bpython3?\b[^|;]*\b(train|finetune|fine_tune|pretrain|sweep)\b[^|;]*\.py/,
  /\buv\s+run\b[^|;]*\b(train|eval|benchmark|sweep|finetune)\b/,
  /\bwandb\s+(agent|sweep)\b/,
];

export function checkExperiment(command: string, extra: RegExp[], sshAlias: string): Hit | undefined {
  const all = [...EXPERIMENT_RES, ...extra];
  if (!all.some((re) => re.test(command))) return undefined;
  return {
    rule: "experimentOnLaptop",
    reason:
      `這看起來是實驗/訓練,而現在不是在 Workstation 上。使用者的規矩是實驗一律在 Workstation 跑,筆電只寫 code。\n` +
      `改成 \`ssh ${sshAlias} '<指令>'\`,或先確認這真的只是幾秒鐘的小東西 —— 是的話原封不動再送一次就會放行。`,
  };
}

/* ------------------------------------------------------------------ *
 * 5. 破壞性指令
 * ------------------------------------------------------------------ */

const DESTRUCTIVE: Array<{ re: RegExp; what: string }> = [
  { re: /\brm\s+(-\w*[rf]\w*\s+)+/, what: "遞迴/強制刪除" },
  { re: /\bdd\b[^|;]*\bof=\/dev\//, what: "dd 寫進區塊裝置" },
  { re: /\bmkfs(\.\w+)?\b/, what: "格式化" },
  { re: /\bshred\b/, what: "shred 覆寫" },
  { re: />\s*\/dev\/(sd|nvme|vd)/, what: "重導向到區塊裝置" },
  { re: /\bgit\s+push\b[^|;]*(--force\b|(^|\s)-f(\s|$))/, what: "git force push" },
  { re: /\bgit\s+(reset\s+--hard|clean\s+-\w*f)/, what: "丟棄工作區改動" },
];

export function checkDestructive(command: string): Hit | undefined {
  for (const d of DESTRUCTIVE) {
    if (d.re.test(command)) {
      return { rule: "destructive", reason: `${d.what}:\`${command.trim().slice(0, 200)}\`` };
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * 6. ls / grep 的空輸出是假陰性
 * ------------------------------------------------------------------ */

export function isSwallowProneListing(command: string): boolean {
  return /(^|[\s;|&(])(ls|grep\s+-\w*[rR])\b/.test(command);
}

export const EMPTY_LISTING_NOTE =
  "⚠ 這個 `ls`/`grep -r` 回了空的。在這台機器上這類輸出**會被吞掉**,空輸出是已知的假陰性。\n" +
  "下結論之前先用 `find <dir> -maxdepth 1` 交叉驗證,或直接挑一個檔案 cat 出來對照。" +
  "尤其在覆蓋任何檔案之前 —— 使用者已經因為誤信空輸出而蓋掉過檔案。";
