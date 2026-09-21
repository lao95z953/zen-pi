import './isolate.mjs';
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, assert, assertIncludes, piPackageDir, report } from "./harness.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const solPi = resolve(process.env.PI_SOL_PI_ROOT || join(homedir(), ".pi/agent/git/github.com/NVlabs/SoL-Pi"));
if (!existsSync(join(solPi, "src/sol-pi/index.ts"))) {
  if (process.env.PI_SOL_PI_ROOT) throw new Error(`PI_SOL_PI_ROOT 找不到 SoL-Pi extension：${solPi}`);
  console.log(`  SKIP SoL-Pi runtime：尚未安裝 ${solPi}；可用 PI_SOL_PI_ROOT 指定官方原始碼。`);
  process.exit(0);
}

const textOf = message => typeof message?.content === "string" ? message.content
  : (message?.content || []).filter(block => block.type === "text").map(block => block.text).join("\n");
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const nodeCommand = code => `${shellQuote(process.execPath)} -e ${shellQuote(code)}`;

await test("真正 Pi + 本機 provider：AF 驗證結果、OP 原文回讀與最新 study-context", async () => {
  const temp = mkdtempSync(join(tmpdir(), "pi-sol-runtime-"));
  const vault = join(temp, "vault"), agent = join(temp, "agent"), home = join(temp, "home");
  for (const dir of [vault, agent, home, join(vault, "blocked")]) mkdirSync(dir);
  const focusPath = join(vault, "Focus.md");
  writeFileSync(focusPath, "# Focus\nCONTEXT-V1\n");
  const source = Array.from({ length: 130 }, (_, i) => `來源 ${String(i + 1).padStart(3, "0")}: ${"原始引文-αβγ|".repeat(4)}`).join("\n");
  writeFileSync(join(vault, "Evidence.md"), source);
  const numberedSource = source.split("\n").map((line, i) => `${i + 1}: ${line}`).join("\n");
  const revisedFocus = "# Focus\nCONTEXT-V2：新的來源快照\n";
  let calls = 0, original, placeholder, observationId, serverError, child;
  const executionResults = new Map();

  function respond(res, tool, args, id) {
    const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id, type: "function",
      function: { name: tool, arguments: JSON.stringify(args) } }] }
      : { role: "assistant", content: "本機整合測試完成。" };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (data, finish) => res.write(`data: ${JSON.stringify({ id: "sol-pi-fixture", object: "chat.completion.chunk",
      created: 1, model: "sol-pi-mock", choices: [{ index: 0, delta: data, finish_reason: finish }] })}\n\n`);
    emit(delta, null);
    emit({}, tool ? "tool_calls" : "stop");
    res.end("data: [DONE]\n\n");
  }

  const server = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      calls++;
      const contexts = request.messages.flatMap(message => {
        try {
          const parsed = JSON.parse(textOf(message));
          return parsed.current !== undefined && parsed.focus ? [parsed] : [];
        } catch { return []; }
      });
      assert(contexts.length === 1, `每次 provider request 只能保留最新 study-context，實際 ${contexts.length}`);
      assert(contexts[0].current?.path === "Focus.md", "目前筆記必須來自臨時 vault");
      assertIncludes(contexts[0].current.content, calls === 7 ? "CONTEXT-V2" : "CONTEXT-V1");
      const result = id => {
        const message = request.messages.find(message => message.role === "tool" && message.tool_call_id === id);
        assert(message, `缺少工具結果 ${id}`);
        return textOf(message);
      };

      if (calls === 1) {
        const writeTool = request.tools.find(tool => tool.function.name === "write");
        assert(writeTool?.function.parameters.properties.then_run, "AF 必須擴充真正 Pi 的 write schema");
        assert(request.tools.some(tool => tool.function.name === "obs_recall"), "OP 必須註冊 recall 工具");
        respond(res, "study_read", { path: "Evidence.md", startLine: 1, maxLines: 200 }, "call_read");
      } else if (calls === 2) {
        original = result("call_read");
        const page = JSON.parse(original);
        assert(page.content === numberedSource && page.truncated === false, "study_read 必須保留原文與行號");
        assert(page.sha256 === createHash("sha256").update(source).digest("hex"), "來源指紋必須正確");
        const bytes = Buffer.byteLength(original);
        assert(bytes > 10 * 1024 && bytes < 15 * 1024, `fixture 必須超過 OP 門檻且一頁可回讀，實際 ${bytes} bytes`);
        respond(res, "write", { path: "fused.txt", content: "validated\n", then_run: { timeout: 5,
          command: nodeCommand('const fs=require("node:fs"); if(fs.readFileSync("fused.txt","utf8")!=="validated\\n") process.exit(1); fs.writeFileSync("validated.txt","ok\\n"); console.log("VALIDATION_OK")') } }, "call_write_ok");
      } else if (calls === 3) {
        assert(result("call_read") === original, "OP 第 2 次傳送必須仍是完整原文");
        assertIncludes(result("call_write_ok"), "[then_run:succeeded]");
        assertIncludes(result("call_write_ok"), "VALIDATION_OK");
        assert(readFileSync(join(vault, "validated.txt"), "utf8") === "ok\n", "驗證命令必須在寫入完成後執行");
        respond(res, "write", { path: "fused-failure.txt", content: "mutation remains\n", then_run: { timeout: 5,
          command: nodeCommand('process.stderr.write("EXPECTED_VALIDATION_FAILURE\\n"); process.exit(7)') } }, "call_write_fail");
      } else if (calls === 4) {
        placeholder = result("call_read");
        assertIncludes(placeholder, "[large tool result replaced after its first 2 provider requests]");
        assert(placeholder !== original, "OP 第 3 次傳送必須改用 placeholder");
        observationId = placeholder.match(/^id: (obs_[a-f0-9]{24})$/m)?.[1];
        assert(observationId, "placeholder 必須包含可回讀的 observation id");
        assertIncludes(result("call_write_fail"), "[then_run:failed]");
        assertIncludes(result("call_write_fail"), "EXPECTED_VALIDATION_FAILURE");
        assert(readFileSync(join(vault, "fused-failure.txt"), "utf8") === "mutation remains\n", "後續驗證失敗不應隱藏已完成的寫入");
        respond(res, "obs_recall", { id: observationId, offset: 0 }, "call_recall");
      } else if (calls === 5) {
        assert(result("call_read") === placeholder, "後續 request 的 placeholder 必須穩定");
        const recalled = result("call_recall");
        const header = recalled.match(/^\[obs_recall id=(obs_[a-f0-9]{24}) offset=0 next_offset=(\d+) eof=true\]\n\[chunk_bytes=(\d+) chunk_lines=\d+; use next_offset to continue\]\n/);
        assert(header?.[1] === observationId, "obs_recall 必須回報來源 id 與完整單頁範圍");
        assert(Number(header[2]) === Buffer.byteLength(original) && header[2] === header[3], "recall 必須使用實際 UTF-8 byte offset");
        assert(recalled.slice(header[0].length) === original, "recall 必須逐字回傳 archived study_read JSON、引文和行號");
        respond(res, "write", { path: "blocked", content: "cannot replace a directory", then_run: { timeout: 5,
          command: nodeCommand('require("node:fs").writeFileSync("must-not-run.txt","unexpected")') } }, "call_write_skip");
      } else if (calls === 6) {
        assertIncludes(result("call_write_skip"), "[then_run:skipped]");
        assert(!existsSync(join(vault, "must-not-run.txt")), "mutation 失敗時不得執行 then_run");
        assertIncludes(result("call_write_fail"), "EXPECTED_VALIDATION_FAILURE");
        respond(res);
      } else if (calls === 7) {
        assert(contexts[0].current.sha256 === createHash("sha256").update(revisedFocus).digest("hex"), "下一輪必須使用更新後的來源指紋");
        assert(!contexts[0].current.content.includes("CONTEXT-V1"), "舊 study-context 不得覆蓋本輪快照");
        assert(result("call_read") === placeholder, "換輪後仍應能辨識已封存來源");
        assertIncludes(result("call_write_fail"), "EXPECTED_VALIDATION_FAILURE");
        respond(res);
      } else {
        throw new Error(`出現非預期 provider request：${calls}`);
      }
    } catch (err) {
      serverError ||= err;
      // End the local turn normally so Pi does not retry a failed fixture for minutes.
      respond(res);
    }
  });

  try {
    await new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [project, solPi],
      defaultProvider: "mock", defaultModel: "sol-pi-mock", compaction: { enabled: false } }));
    writeFileSync(join(agent, "sol-pi.json"), JSON.stringify({ version: 1, actionFusion: true,
      observationPack: true, evidencePreservingReducer: false, onlineContextCompact: false }));
    writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { mock: {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "local-fixture-only",
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, models: [{ id: "sol-pi-mock",
        reasoning: false, input: ["text"], contextWindow: 64000, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    const piDir = piPackageDir();
    const piPackage = JSON.parse(readFileSync(join(piDir, "package.json"), "utf8"));
    const piEntry = join(piDir, typeof piPackage.bin === "string" ? piPackage.bin : piPackage.bin.pi);
    await new Promise((resolveRun, reject) => {
      child = spawn(process.execPath, [piEntry, "--mode", "rpc", "--session-dir", join(agent, "sessions"), "--no-context-files", "--no-skills"], {
        cwd: vault,
        env: { PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8", PI_CODING_AGENT_DIR: agent,
          PI_STUDY_VAULT: vault, XDG_CONFIG_HOME: join(temp, "config"), XDG_CACHE_HOME: join(temp, "cache") },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let buffer = "", stderr = "", ended = 0, runError;
      const stop = error => { runError ||= error; child.kill("SIGKILL"); };
      const timer = setTimeout(() => stop(new Error(`Pi 本機測試逾時：${stderr.slice(0, 800)}`)), 30000);
      const send = (id, message) => child.stdin.write(JSON.stringify({ id, type: "prompt", message }) + "\n");
      child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-6000); });
      child.stdin.on("error", error => stop(error));
      child.stdout.on("data", chunk => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          if (event.type === "response" && event.success === false) { stop(new Error(JSON.stringify(event))); continue; }
          if (event.type === "response" && event.id === "select") send("first", "請讀取測試來源並驗證臨時檔案。");
          if (event.type === "tool_execution_end") executionResults.set(event.toolCallId, event);
          if (event.type === "agent_end") {
            ended++;
            if (ended === 1 && !serverError) {
              writeFileSync(focusPath, revisedFocus);
              send("second", "請依目前筆記的最新內容繼續。");
            } else { child.stdin.end(); }
          }
        }
      });
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("close", code => {
        clearTimeout(timer);
        if (serverError || runError) reject(new Error(`${(serverError || runError).message}\nPi stderr：${stderr.slice(-1500)}`));
        else if (code !== 0 || ended !== 2) reject(new Error(`Pi 結束碼 ${code}、完成輪數 ${ended}：${stderr.slice(0, 800)}`));
        else resolveRun();
      });
      send("select", "/study Focus");
    });
    assert(calls === 7, `必須完成全部 7 個本機 provider requests，實際 ${calls}`);
    assert(executionResults.get("call_write_ok")?.isError === false, "成功的 fused write 必須保留成功狀態");
    assert(executionResults.get("call_write_fail")?.isError === true, "驗證失敗必須回報真正的 tool error");
    assert(executionResults.get("call_write_skip")?.isError === true, "mutation 失敗必須回報真正的 tool error");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise(resolveClose => child.once("close", resolveClose));
    }
    server.closeAllConnections();
    if (server.listening) await new Promise(resolveClose => server.close(resolveClose));
    rmSync(temp, { recursive: true, force: true });
  }
});
report();
