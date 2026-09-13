import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { loadConfig, onWorkstation, ruleEnabled, shortHost } from "../shared/config.ts";
import {
  EMPTY_LISTING_NOTE,
  checkDestructive,
  checkExperiment,
  checkFfufMatcher,
  checkSymlinkRedirect,
  dpiNote,
  isSwallowProneListing,
  matchDpiSignatures,
} from "./rules.ts";

/**
 * 護欄。規則全部來自使用者實際踩過的坑,不是通用的 best practice。
 *
 * 攔截分兩種力道:
 *   硬擋   —— 會弄壞東西的(穿寫 symlink、破壞性指令),要嘛擋掉要嘛問。
 *   減速丘 —— 會浪費時間但不會弄壞東西的(ffuf matcher、在筆電跑實驗)。
 *             第一次擋下來並說明,同一條指令原封不動再送一次就放行,
 *             這樣模型能被糾正,但使用者堅持時不會卡住。
 */

interface ContentPart {
  type: string;
  text?: string;
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as ContentPart[])
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n");
}

function normalize(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

export default function (pi: ExtensionAPI) {
  const cfg = loadConfig();
  const extraExperiment = cfg.extraExperimentPatterns.map((p) => new RegExp(p));

  /** 已經對某條指令提過某個減速丘,再送一次就放行。 */
  const bumped = new Map<string, Set<string>>();
  /** 帶了會被網路吞掉的 payload 的 tool call,等結果出來再決定要不要註記。 */
  const dpiFlagged = new Map<string, string>();

  function passedBump(command: string, rule: string): boolean {
    const key = normalize(command);
    const seen = bumped.get(key);
    if (seen?.has(rule)) return true;
    if (seen) seen.add(rule);
    else bumped.set(key, new Set([rule]));
    return false;
  }

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    const where = onWorkstation(cfg) ? "workstation" : shortHost();
    ctx.ui.setStatus("ronny-guardrails", `護欄 on · ${where}`);
  });

  pi.on("session_shutdown", async () => {
    bumped.clear();
    dpiFlagged.clear();
  });

  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    if (!isToolCallEventType("bash", event)) return;
    const command = event.input.command;
    if (!command) return;

    // --- 硬擋:穿寫 symlink ---
    if (ruleEnabled(cfg, "symlinkRedirect")) {
      const hit = checkSymlinkRedirect(command, ctx.cwd);
      if (hit) return { block: true, reason: hit.reason };
    }

    // --- 硬擋:破壞性指令。有 UI 就問,沒 UI 就擋。 ---
    if (ruleEnabled(cfg, "destructive")) {
      const hit = checkDestructive(command);
      if (hit) {
        if (!ctx.hasUI) {
          return { block: true, reason: `破壞性指令,非互動模式一律擋下:${hit.reason}` };
        }
        const ok = await ctx.ui.confirm("破壞性指令", hit.reason);
        if (!ok) return { block: true, reason: "使用者不同意執行" };
      }
    }

    // --- 減速丘:ffuf 沒設 matcher ---
    if (ruleEnabled(cfg, "ffufMatcher")) {
      const hit = checkFfufMatcher(command);
      if (hit && !passedBump(command, hit.rule)) {
        return { block: true, reason: hit.reason };
      }
    }

    // --- 減速丘:在筆電上跑實驗 ---
    if (ruleEnabled(cfg, "experimentOnLaptop") && !onWorkstation(cfg)) {
      const hit = checkExperiment(command, extraExperiment, cfg.workstationSsh);
      if (hit && !passedBump(command, hit.rule)) {
        return { block: true, reason: hit.reason };
      }
    }

    // --- 只標記不擋:payload 會被本地網路吞掉 ---
    if (ruleEnabled(cfg, "dpiPayload")) {
      const sigs = matchDpiSignatures(command);
      if (sigs.length > 0) {
        dpiFlagged.set(event.toolCallId, dpiNote(sigs));
        if (ctx.hasUI) {
          ctx.ui.notify(`payload 含 ${sigs.map((s) => s.label).join("、")},本地網路可能直接吞掉`, "warn");
        }
      }
    }
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "bash") return;
    const input = event.input as { command?: string } | undefined;
    const command = input?.command ?? "";
    const text = contentText(event.content);
    const notes: string[] = [];

    // payload 被標記過,而且結果看起來就是「沒有回應」——這正是被吞掉的樣子。
    const dpi = dpiFlagged.get(event.toolCallId);
    if (dpi) {
      dpiFlagged.delete(event.toolCallId);
      const looksSwallowed = /timed?\s*out|timeout|Connection timed out|Operation timed out/i.test(text) || text.trim() === "";
      if (looksSwallowed) notes.push(dpi);
    }

    // ls / grep -r 回空的:在這台是已知的假陰性。
    if (ruleEnabled(cfg, "emptyListing") && isSwallowProneListing(command) && text.trim() === "") {
      notes.push(EMPTY_LISTING_NOTE);
    }

    if (notes.length === 0) return;
    const existing = Array.isArray(event.content) ? event.content : [];
    return {
      content: [...existing, { type: "text", text: notes.join("\n\n") }],
    };
  });

  // 手動查目前狀態,順便看規則有沒有被設定檔關掉。
  pi.registerCommand("guardrails", {
    description: "顯示護欄狀態與各規則開關",
    handler: async (_args, ctx) => {
      const names = [
        "symlinkRedirect",
        "destructive",
        "ffufMatcher",
        "experimentOnLaptop",
        "dpiPayload",
        "emptyListing",
      ];
      const lines = names.map((n) => `${ruleEnabled(cfg, n) ? "on " : "off"}  ${n}`);
      lines.unshift(`主機 ${shortHost()}${onWorkstation(cfg) ? "(workstation)" : ""}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
