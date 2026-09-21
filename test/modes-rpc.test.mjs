import './isolate.mjs';
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, assert, report } from "./harness.mjs";

const temp = mkdtempSync(join(tmpdir(), "pi-modes-rpc-")), vault = join(temp, "vault"), agent = join(temp, "agent");
mkdirSync(vault); mkdirSync(agent);
writeFileSync(join(vault, "NAT.md"), "# NAT\n這是私有筆記內容，清單不應包含這句。\n");
let modelCalls = 0;
const server = createServer((_req, res) => { modelCalls++; res.writeHead(500); res.end("Mode commands must not invoke a model"); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [resolve(".")], defaultProvider: "mock", defaultModel: "mode-mock" }));
writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "test-placeholder", models: [{ id: "mode-mock", reasoning: false, input: ["text"], contextWindow: 64000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));

try {
  await test("真實 Pi RPC：模式和筆記清單可用 custom message 讀取，全程不呼叫模型", async () => {
    const commands = ["/mode status", "/study-notes NAT", "/study NAT.md", "/study-status", "/mode research", "/research off", "/mode invalid"];
    const events = [];
    await new Promise((resolveRun, reject) => {
      const child = spawn("pi", ["--mode", "rpc", "--no-session", "--no-context-files", "--no-skills"], { cwd: vault, env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_STUDY_VAULT: vault }, stdio: ["pipe", "pipe", "pipe"] });
      let buffer = "", stderr = "", next = 0;
      const send = () => child.stdin.write(JSON.stringify({ id: `command-${next}`, type: "prompt", message: commands[next++] }) + "\n");
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Pi RPC timed out: " + stderr.slice(0, 800))); }, 25000);
      child.stderr.on("data", chunk => stderr += chunk);
      child.stdout.on("data", chunk => {
        buffer += chunk; let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let event; try { event = JSON.parse(line); } catch { continue; }
          events.push(event);
          if (event.type === "response" && event.id === `command-${next - 1}`) {
            if (!event.success) { clearTimeout(timer); child.kill(); reject(new Error(JSON.stringify(event))); return; }
            if (next < commands.length) send(); else child.stdin.end();
          }
        }
      });
      child.on("error", reject);
      child.on("close", code => { clearTimeout(timer); code === 0 && next === commands.length ? resolveRun() : reject(new Error(`Pi exited ${code}: ${stderr.slice(0, 800)}`)); });
      send();
    });
    const messages = events.filter(e => e.type === "message_end" && e.message?.role === "custom").map(e => e.message);
    const payloads = type => messages.filter(m => m.customType === type).map(m => JSON.parse(m.content));
    const modes = payloads("pi-mode-state");
    assert(modes.some(m => m.mode === "general") && modes.some(m => m.mode === "study") && modes.some(m => m.mode === "research"), JSON.stringify(events).slice(0, 2000));
    assert(modes.at(-1).mode === "general");
    const list = payloads("pi-note-list").at(-1);
    assert(list.notes.some(n => n.path === "NAT.md") && !JSON.stringify(list).includes("私有筆記內容"));
    assert(payloads("pi-study-state").at(-1).current.path === "NAT.md");
    assert(payloads("pi-mode-error").at(-1).error.includes("用法"));
    assert(modelCalls === 0, `${modelCalls} unintended model calls`);
  });
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(temp, { recursive: true, force: true }); }
report();
