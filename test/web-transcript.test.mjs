import './isolate.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transcript } from '../web/transcript.mjs';
import { createWebServer, ConversationView } from '../web/server.mjs';
const trace = new Transcript();
trace.message({ role: 'assistant', content: [], usage: { totalTokens: 0, input: 0, output: 0 } }, 'zero');
trace.message({ role: 'assistant', content: [] }, 'unknown');
assert.equal(trace.usage.reported, 1); assert.equal(trace.usage.missing, 1); assert.equal(trace.usage.totals.totalTokens, 0);
trace.message({ role: 'assistant', content: [{ type: 'thinking', thinking: 'Never show redacted block', redacted: true, thinkingSignature: 'HIDDEN' }] }, 'redacted');
assert.equal(trace.entries.get('redacted').thinking, ''); assert.ok(!JSON.stringify(trace.snapshot()).includes('HIDDEN'));
trace.tool({ type: 'tool_execution_start', toolCallId: 'long', toolName: 'bash', args: { command: 'curl -H "Authorization: Bearer test-secret"', password: 'DO-NOT-EXPOSE' } });
trace.tool({ type: 'tool_execution_update', toolCallId: 'long', partialResult: { content: [{ type: 'text', text: 'start' + 'x'.repeat(30000) + 'end' }, { type: 'image', data: 'PRIVATE-IMAGE' }] } });
assert.match(trace.entries.get('tool:long').output, /已省略中段/); assert.match(trace.entries.get('tool:long').output, /end/);
assert.ok(!JSON.stringify(trace.snapshot()).match(/test-secret|DO-NOT-EXPOSE|PRIVATE-IMAGE/));
trace.settle(); assert.equal(trace.entries.get('tool:long').state, 'interrupted');
for (let i = 0; i < 300; i++) trace.message({ role: 'user', content: 'x'.repeat(30000) }, `bound-${i}`);
assert.ok(trace.omitted > 0); assert.ok(JSON.stringify(trace.snapshot()).length < 410000); assert.ok(trace.entries.size <= 160);
trace.message({ role: 'bashExecution', command: 'echo test', output: 'test', exitCode: 0 }, 'manual-bash');
assert.equal(trace.entries.get('manual-bash').input, 'echo test');

const turns = new Transcript();
const usageMessage = { role: 'assistant', content: [], usage: { input: 30, output: 10, cacheRead: 20000, cacheWrite: 0, totalTokens: 20040, reasoning: 4 } };
turns.message({ role: 'user', content: 'first turn' }, 'u1');
turns.message(usageMessage, 'a1', false);
assert.equal(turns.usage.currentTurn.requests, 0, 'Do not settle tokens while streaming');
turns.message(usageMessage, 'a1'); turns.message(usageMessage, 'a2');
assert.equal(turns.usage.currentTurn.requests, 2);
assert.equal(turns.usage.currentTurn.totals.output, 20, 'Count every model call after the latest user message');
assert.equal(turns.usage.currentTurn.totals.totalTokens, 40080, 'Reasoning is a subset of output, never an additional total');
turns.message({ role: 'user', content: 'next turn' }, 'u2');
assert.equal(turns.usage.currentTurn.totals.output, null, 'A new user message clears turn metrics, not branch history');
assert.equal(turns.usage.totals.output, 20);
turns.message({ role: 'assistant', content: [], usage: { output: 0, totalTokens: 0 } }, 'a3');
turns.message({ role: 'assistant', content: [] }, 'a4');
assert.equal(turns.usage.currentTurn.totals.output, 0);
assert.equal(turns.usage.currentTurn.missing, 1);
const view = new ConversationView();
assert.equal(view.message(usageMessage).streaming, false);
assert.equal(view.message(usageMessage, false).streaming, true);
const browserView = new ConversationView();
browserView.message({ role: 'custom', customType: 'browser-status', content: 'Choose connection.json', display: true });
assert.equal(browserView.messages[0].text, 'Choose connection.json');
assert.equal(browserView.transcript.snapshot().entries[0].text, 'Choose connection.json');
assert.equal(browserView.transcript.usage.requests, 0, 'Browser command output is not counted as a model call');
browserView.message({ role: 'custom', customType: 'browser-task', content: 'INTERNAL-POLICY', display: false });
assert(!JSON.stringify(browserView.transcript.snapshot()).includes('INTERNAL-POLICY'));

const root = await mkdtemp(join(tmpdir(), 'pi-transcript-'));
let app, base;
const options = { dataDir: join(root, 'data'), workspace: root, sessionRoots: [], piBin: process.execPath, piArgs: [fileURLToPath(new URL('./fixtures/pi-rpc.mjs', import.meta.url))], env: { ...process.env, HOME: root } };
async function launch() { app = await createWebServer(options); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`; }
async function api(path, body) {
  const response = await fetch(`${base}/api/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pi-Web': '1', Origin: base }, body: JSON.stringify(body) });
  assert.equal(response.status, 200); return response.json();
}
try {
  await launch(); const state = await api('sessions', {});
  await api('prompt', { sessionId: state.sessionId, workspaceId: state.workspaceId, message: 'trace-test' });
  const running = await api('state');
  assert.equal(running.busy, true);
  const live = running.transcript.entries.find(entry => entry.kind === 'tool');
  assert.equal(live.state, 'running'); assert.equal(live.output, 'first line'); assert.match(live.input, /printf fixture/);
  assert.equal(running.transcript.usage.totals.totalTokens, 60);
  assert.ok(!JSON.stringify(running).match(/PRIVATE-KEY|PRIVATE-SIGNATURE/));
  let final;
  for (let i = 0; i < 100; i++) { final = await api('state'); if (!final.busy) break; await new Promise(resolve => setTimeout(resolve, 15)); }
  assert.equal(final.busy, false);
  const tool = final.transcript.entries.find(entry => entry.kind === 'tool');
  assert.equal(tool.state, 'error'); assert.equal(tool.exitCode, 7); assert.match(tool.output, /fixture failure/);
  assert.equal(final.transcript.entries.filter(entry => entry.kind === 'tool').length, 1, 'Tool event and toolResult hydrate the same record');
  assert.equal(final.transcript.usage.requests, 1); assert.equal(final.transcript.usage.totals.reasoning, 4);
  assert.ok(!JSON.stringify(final).includes('PRIVATE-RESULT'));
  assert.equal(JSON.parse(final.transcript.entries.find(entry => entry.model === 'Zen Pi / Browser').text).active, false);
  await app.close(); await launch();
  const restored = await api('state');
  assert.equal(JSON.parse(restored.transcript.entries.find(entry => entry.model === 'Zen Pi / Browser').text).active, false,
    'Persisted browser status is projected after Session reload');
  assert.equal(restored.transcript.usage.totals.totalTokens, 60, 'Usage survives process restart without a model request');
  const restoredTool = restored.transcript.entries.find(entry => entry.kind === 'tool');
  assert.match(restoredTool.input, /printf fixture/); assert.match(restoredTool.output, /fixture failure/); assert.equal(restoredTool.state, 'error');
  await api('prompt', { sessionId: state.sessionId, workspaceId: state.workspaceId, message: 'hold' });
  const scope = { sessionId: state.sessionId, workspaceId: state.workspaceId };
  const context = await api('usage', scope);
  assert.equal(context.contextTokens, 120); assert.equal(context.contextWindow, 1000); assert.equal(context.contextPercent, 12);
  assert.ok(!JSON.stringify(context).match(/PRIVATE-USAGE|sessionFile|9231931/));
  assert.equal((await api('state')).busy, true, 'Reading context does not stop the active model');
  for (const changed of [{ sessionId: 'stale-session' }, { workspaceId: 'stale-workspace' }]) {
    const result = await fetch(`${base}/api/usage`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pi-Web': '1', Origin: base }, body: JSON.stringify({ ...scope, ...changed }) });
    assert.equal(result.status, 409);
  }
  await api('stop', scope);
  const other = await api('sessions', {}); assert.equal(other.transcript.entries.length, 0);
  const original = await api('open', { id: state.sessionId }); assert.equal(original.transcript.usage.totals.totalTokens, 60);
  // A response from the old selection must fail even if its RPC is still alive.
  await app.close(); options.env.FAKE_STATS_GATE = join(root, 'stats-gate'); options.env.FAKE_UNKNOWN_CONTEXT = '1'; await launch();
  const loaded = await api('state');
  const delayed = fetch(`${base}/api/usage`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pi-Web': '1', Origin: base }, body: JSON.stringify({ sessionId: loaded.sessionId, workspaceId: loaded.workspaceId }) });
  let waiting = false;
  for (let i = 0; i < 200; i++) {
    try { await access(options.env.FAKE_STATS_GATE + '.waiting'); waiting = true; break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(waiting, true, 'The old request reached Pi before changing selection');
  await api('open', { id: other.sessionId });
  await writeFile(options.env.FAKE_STATS_GATE + '.release', 'ready');
  assert.equal((await delayed).status, 409);
  const unknown = await api('usage', { sessionId: other.sessionId, workspaceId: other.workspaceId });
  assert.equal(unknown.contextTokens, null); assert.equal(unknown.contextWindow, 1000);
  assert.equal(unknown.contextPercent, null, 'Unknown context must never fall back to accumulated tokens');
  console.log('Transcript event/history parity, partial and failed tool output, redaction, bounds, usage and Session isolation passed');
} finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
