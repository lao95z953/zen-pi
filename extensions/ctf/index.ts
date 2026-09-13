import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../shared/config.ts";
import { describeTarget, envExports, parseTarget, type Target } from "./target.ts";

/**
 * CTF 工作區。刻意不幫你建目錄 —— 你的 ~/ctf 已經有自己的分類方式
 * (comps/<賽事>/<類別>/),自動 mkdir 只會多生出對不上的路徑。
 * 這裡只做三件事:記住現在在打哪一題、把 target 送進 shell 和系統提示、
 * 把 finding 和 flag 落到當前目錄的檔案裡。
 */

const ENTRY_TYPE = "ronny-ctf";
const FLAG_RE = /^[A-Za-z0-9_.-]{2,32}\{[^}]{1,512}\}$/;

interface CtfState {
  name?: string;
  target?: Target;
}

export default function (pi: ExtensionAPI) {
  loadConfig();
  let state: CtfState = {};

  function render(ctx: ExtensionContext) {
    if (!state.name && !state.target) {
      ctx.ui.setStatus("ronny-ctf", "");
      return;
    }
    const parts = [state.name ? `⚑ ${state.name}` : "⚑"];
    if (state.target) parts.push(describeTarget(state.target));
    ctx.ui.setStatus("ronny-ctf", parts.join(" · "));
  }

  function persist() {
    pi.appendEntry(ENTRY_TYPE, state as unknown as Record<string, unknown>);
  }

  // 從 session 記錄還原,這樣 /resume 回來題目還在。
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    state = {};
    for (const entry of ctx.sessionManager.getEntries()) {
      const e = entry as { type?: string; customType?: string; data?: CtfState };
      if (e.type === "custom" && e.customType === ENTRY_TYPE && e.data) {
        state = e.data;
      }
    }
    render(ctx);
  });

  // 把 target 灌進 bash 環境,exploit 腳本就不用到處硬寫主機名。
  pi.on("tool_call", async (event) => {
    if (!state.target) return;
    if (!isToolCallEventType("bash", event)) return;
    if (!event.input.command) return;
    event.input.command = `${envExports(state.target).join("\n")}\n${event.input.command}`;
  });

  // 讓模型每一輪都知道現在在打哪一題。
  pi.on("before_agent_start", async (event) => {
    if (!state.name && !state.target) return;
    const lines = ["## 目前的 CTF 題目"];
    if (state.name) lines.push(`題目:${state.name}`);
    if (state.target) {
      lines.push(`目標:${describeTarget(state.target)}`);
      lines.push(
        "bash 工具裡已經有 `$TARGET`" +
          (state.target.host ? "、`$TARGET_HOST`" : "") +
          (state.target.port !== undefined ? "、`$TARGET_PORT`" : "") +
          (state.target.url ? "、`$TARGET_URL`" : "") +
          ",寫指令和 exploit 直接用這些變數,不要把主機名硬寫進去。",
      );
    }
    lines.push("有結論就用 ctf_note 記下來,拿到 flag 就用 ctf_flag 收好。");
    return { systemPrompt: `${event.systemPrompt}\n\n${lines.join("\n")}` };
  });

  pi.registerCommand("ctf", {
    description: "設定/查看目前的 CTF 題目與目標。用法:/ctf <題目名> [目標] | /ctf target <目標> | /ctf clear",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();

      if (!arg) {
        const lines = [
          state.name ? `題目:${state.name}` : "還沒設題目",
          state.target ? `目標:${describeTarget(state.target)}` : "還沒設目標",
          `工作目錄:${ctx.cwd}`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (arg === "clear") {
        state = {};
        persist();
        render(ctx);
        ctx.ui.notify("已清掉題目設定", "info");
        return;
      }

      const targetOnly = arg.match(/^target\s+(.+)$/s);
      if (targetOnly) {
        state.target = parseTarget(targetOnly[1]);
        persist();
        render(ctx);
        ctx.ui.notify(`目標:${describeTarget(state.target)}`, "info");
        return;
      }

      // `/ctf <name> [target...]` —— 第一個 token 是題目名,剩下的是目標。
      const m = arg.match(/^(\S+)(?:\s+(.+))?$/s);
      if (!m) return;
      state.name = m[1];
      if (m[2]) state.target = parseTarget(m[2]);
      persist();
      render(ctx);
      pi.setSessionName(`CTF ${state.name}`);
      ctx.ui.notify(
        state.target ? `題目 ${state.name} · 目標 ${describeTarget(state.target)}` : `題目 ${state.name}`,
        "info",
      );
    },
  });

  pi.registerTool({
    name: "ctf_note",
    label: "CTF Note",
    description:
      "把一條調查結論寫進當前目錄的 NOTES.md,附時間戳。用在確認了某件事之後 —— " +
      "版本、可用的 gadget、被擋掉的 payload、排除掉的路線。不要拿來記還沒驗證的猜測。",
    promptSnippet: "把已驗證的 CTF 調查結論追加到 NOTES.md",
    promptGuidelines: [
      "確認一件關於題目的事實之後就呼叫 ctf_note,尤其是排除掉某條路線的時候 —— 這樣重開 session 也不會重走一次。",
    ],
    parameters: Type.Object({
      note: Type.String({ description: "要記下來的結論,一到三句話" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const path = resolve(ctx.cwd, "NOTES.md");
      const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
      const head = state.name ? `${state.name} · ` : "";
      return withFileMutationQueue(path, async () => {
        if (!existsSync(path)) writeFileSync(path, "# Notes\n\n", "utf8");
        appendFileSync(path, `- \`${stamp}\` ${head}${params.note}\n`, "utf8");
        return {
          content: [{ type: "text", text: `記到 ${path}` }],
          details: { path, note: params.note },
        };
      });
    },
  });

  pi.registerTool({
    name: "ctf_flag",
    label: "CTF Flag",
    description:
      "收下一個拿到的 flag,寫進當前目錄的 FLAG.txt。格式不像 flag 會直接報錯 —— " +
      "與其收下一個其實是 placeholder 的字串,不如當場失敗。",
    promptSnippet: "把拿到的 flag 記進 FLAG.txt",
    promptGuidelines: ["拿到 flag 就馬上呼叫 ctf_flag,不要只印在輸出裡。"],
    parameters: Type.Object({
      flag: Type.String({ description: "完整的 flag,含大括號" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const flag = params.flag.trim();
      if (!FLAG_RE.test(flag)) {
        throw new Error(
          `\`${flag}\` 看起來不是 flag(要長成 prefix{...})。` +
            "如果這是題目給的範例或 placeholder,那就還沒解出來,別記下去。",
        );
      }
      const path = resolve(ctx.cwd, "FLAG.txt");
      const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
      const label = state.name ?? "unknown";
      return withFileMutationQueue(path, async () => {
        const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
        if (existing.includes(flag)) {
          return {
            content: [{ type: "text", text: `這個 flag 已經在 ${path} 裡了` }],
            details: { path, flag, duplicate: true },
          };
        }
        appendFileSync(path, `${stamp}\t${label}\t${flag}\n`, "utf8");
        return {
          content: [{ type: "text", text: `🚩 ${flag} → ${path}` }],
          details: { path, flag, duplicate: false },
        };
      });
    },
  });
}
