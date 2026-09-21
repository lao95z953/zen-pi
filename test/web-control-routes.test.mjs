import './isolate.mjs';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createWebServer } from '../web/server.mjs';

const root = await mkdtemp(join(tmpdir(), 'pi-control-routes-'));
const workspace = join(root, 'workspace'), dataDir = join(root, 'data');
const controls = join(root, 'controls'), auditFile = join(root, 'audit.jsonl'), fixtureFile = join(root, 'control-rpc.mjs');
const secret = 'PRIVATE_RPC_SENTINEL';
const exportHtml = '<!doctype html><html><body><h1>Fixture conversation</h1><p>Saved answer</p></body></html>';
let app, base;

// No provider or network client exists in this fixture. A release file controls
// long-running compaction so its progress and cancellation can be checked.
const fixture = String.raw`
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2), sessionDir = args[args.indexOf('--session-dir') + 1];
const file = join(sessionDir, randomUUID() + '.jsonl'), id = randomUUID();
const secret = 'PRIVATE_RPC_SENTINEL';
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (request, data) => emit({ type: 'response', command: request.type, id: request.id, success: true, data });
const reject = (request, error) => emit({ type: 'response', command: request.type, id: request.id, success: false, error });
const custom = (customType, value) => emit({ type: 'message_end', message: { role: 'custom', customType, content: JSON.stringify(value) } });
const audit = value => appendFileSync(process.env.CONTROL_AUDIT, JSON.stringify(value) + '\n');
const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }], provider: 'fixture', model: 'reasoner', api: 'openai-completions', stopReason: 'stop', timestamp: Date.now() });
const messages = [{ role: 'user', content: [{ type: 'text', text: 'Saved question' }], timestamp: Date.now() }, assistant('Saved answer')];
writeFileSync(file, [
  { type: 'session', version: 3, id, cwd: process.cwd(), timestamp: new Date().toISOString() },
  ...messages.map((message, index) => ({ type: 'message', id: 'message-' + index, parentId: index ? 'message-0' : null, timestamp: new Date().toISOString(), message }))
].map(value => JSON.stringify(value)).join('\n') + '\n', { mode: 0o600 });
const models = [
  { provider: 'fixture', id: 'reasoner', name: 'Reasoner', reasoning: true, contextWindow: 64000 },
  { provider: 'fixture', id: 'plain', name: 'Plain', reasoning: false, contextWindow: 32000 }
].map(model => ({ ...model, headers: { Authorization: secret }, baseUrl: 'https://' + secret + '.invalid', apiKey: secret }));
let model = models[0], thinkingLevel = 'low', mode = 'general', busy = false, pendingCompact = null, compactCount = 0, compacted = false;
let queue = { steering: [], followUp: [] };
const compactResult = () => ({ summary: 'Keep the saved decision and next step.', tokensBefore: 50000, estimatedTokensAfter: 1400,
  firstKeptEntryId: secret, details: { path: secret, headers: { Authorization: secret } }, sessionFile: secret,
  usage: { input: 50000, output: 600, cacheRead: 0, cacheWrite: 0, totalTokens: 50600,
    cost: { input: 0.1, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.12, private: secret }, headers: { Authorization: secret } } });
const timer = setInterval(() => {
  if (pendingCompact && existsSync(join(process.env.CONTROL_DIR, 'compact-' + compactCount + '.release'))) {
    const request = pendingCompact; pendingCompact = null; compacted = true; reply(request, compactResult());
  }
}, 15);
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line); audit(request);
  switch (request.type) {
    case 'get_state': reply(request, { sessionId: id, sessionFile: file, model, thinkingLevel, isStreaming: busy, isCompacting: !!pendingCompact,
      sessionName: 'Control fixture', apiKey: secret, messageCount: messages.length }); break;
    case 'get_messages': reply(request, { messages }); break;
    case 'get_commands': reply(request, { commands: ['mode', 'study', 'study-status', 'study-notes', 'browser'].map(name => ({ name, source: 'extension', path: secret })) }); break;
    case 'get_available_models': reply(request, { models, headers: { Authorization: secret } }); break;
    case 'set_model': model = models.find(value => value.id === request.modelId); thinkingLevel = model.reasoning ? 'low' : 'off'; reply(request, model); break;
    case 'get_available_thinking_levels': reply(request, { levels: model.reasoning ? ['low', 'high', 'high', secret, null] : ['off'], sessionFile: secret }); break;
    case 'set_thinking_level': thinkingLevel = request.level; reply(request, { level: thinkingLevel, headers: secret }); break;
    case 'get_session_stats': reply(request, existsSync(join(process.env.CONTROL_DIR, 'unknown-stats')) ? { sessionFile: secret, tokens: {}, cost: null } : {
      sessionId: secret, sessionFile: secret, userMessages: 4, assistantMessages: 3, toolCalls: 5, toolResults: 5, totalMessages: 12,
      tokens: { input: 30000, output: 1200, cacheRead: 300, cacheWrite: 10, total: 31510, headers: secret }, cost: 0.13,
      contextUsage: { tokens: compacted ? null : 24000, contextWindow: model.contextWindow, percent: compacted ? null : 37.5, path: secret }, headers: { Authorization: secret }
    }); break;
    case 'compact': pendingCompact = request; compactCount++; break;
    case 'export_html': {
      const outputDir = join(request.outputPath, '..');
      audit({ type: 'export_destination', outputPath: request.outputPath, directoryMode: statSync(outputDir).mode & 0o777 });
      writeFileSync(request.outputPath, '<!doctype html><html><body><h1>Fixture conversation</h1><p>Saved answer</p></body></html>');
      reply(request, { path: request.outputPath, headers: { Authorization: secret } }); break;
    }
    case 'get_last_assistant_text': reply(request, { text: 'Saved answer', sessionFile: secret, headers: { Authorization: secret } }); break;
    case 'steer': case 'follow_up': {
      if (request.message === 'fixture-reject-queue') { reject(request, 'Fixture rejected queue item'); break; }
      queue[request.type === 'steer' ? 'steering' : 'followUp'].push(request.message); reply(request); break;
    }
    case 'clear_queue': { const removed = queue; queue = { steering: [], followUp: [] }; reply(request, { ...removed, sessionFile: secret }); break; }
    case 'abort':
      if (pendingCompact) { const pending = pendingCompact; pendingCompact = null; reject(pending, 'Compaction aborted'); }
      if (busy) { busy = false; emit({ type: 'agent_settled' }); }
      reply(request); break;
    case 'prompt':
      if (request.message.startsWith('/mode ')) { if (request.message !== '/mode status') mode = request.message.slice(6); custom('pi-mode-state', { mode }); reply(request); }
      else if (request.message === '/study-status') { custom('pi-study-state', { mode, focus: { mode: 'auto' }, current: null }); reply(request); }
      else if (request.message === '/browser stop') { audit({ type: 'browser_stopped' }); reply(request); }
      else if (request.message === 'hold:queue') { busy = true; emit({ type: 'agent_start' }); reply(request); }
      else { audit({ type: 'unexpected_model_prompt', message: request.message }); reject(request, 'No model access permitted'); }
      break;
    default: reply(request);
  }
}
clearInterval(timer);
`;

async function call(path, body, status = 200) {
  const response = await fetch(`${base}/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { Origin: base, 'Content-Type': 'application/json', 'X-Pi-Web': '1' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const result = await response.json();
  assert.equal(response.status, status, `${path}: ${JSON.stringify(result)}`);
  assert.ok(!JSON.stringify(result).includes(secret), `${path} projects private RPC fields out of the response`);
  return result;
}
async function audit() { return (await readFile(auditFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
async function count(type) { return (await audit()).filter(entry => entry.type === type).length; }
async function until(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt++) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 15)); }
  throw Error(`Timed out: ${label}`);
}

try {
  await mkdir(workspace); await mkdir(controls); await writeFile(fixtureFile, fixture);
  app = await createWebServer({ dataDir, workspace, sessionRoots: [], piBin: process.execPath, piArgs: [fixtureFile],
    env: { PATH: process.env.PATH, HOME: root, LANG: 'C.UTF-8', CONTROL_AUDIT: auditFile, CONTROL_DIR: controls }, publicOrigin: '', tailscaleUser: '' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  let state = await call('sessions', {}); const sessionId = state.sessionId;
  const initialMessages = state.messages;
  const slash = (message, status = 200) => call('prompt', { sessionId, message }, status);

  let result = await slash('/thinking');
  assert.deepEqual(result.command, { type: 'thinking', levels: ['low', 'high'], current: 'low' });
  const setsBefore = await count('set_thinking_level');
  await call('thinking', { sessionId, level: 'max' }, 400);
  await slash('/thinking off', 400);
  assert.equal(await count('set_thinking_level'), setsBefore, 'Unsupported levels never reach Pi');
  result = await call('thinking', { sessionId, level: 'high' });
  assert.equal(result.command.current, 'high'); assert.equal(result.state.thinkingLevel, 'high');
  await call('model', { sessionId, provider: 'fixture', modelId: 'plain' });
  result = await call('thinking', { sessionId });
  assert.deepEqual(result.command, { type: 'thinking', levels: ['off'], current: 'off' });
  await call('thinking', { sessionId, level: 'high' }, 400);
  await call('model', { sessionId, provider: 'fixture', modelId: 'reasoner' });

  const info = (await call('stats', { sessionId })).command.info;
  assert.deepEqual(info, { userMessages: 4, assistantMessages: 3, messageCount: 7, toolCalls: 5, toolResults: 5, totalMessages: 12,
    tokens: { input: 30000, output: 1200, cacheRead: 300, cacheWrite: 10, total: 31510 }, cost: 0.13,
    contextTokens: 24000, contextWindow: 64000, contextPercent: 37.5, thinkingLevel: 'low', title: state.sessions.find(item => item.id === sessionId).title, workspace, model: 'fixture / Reasoner' });
  assert.deepEqual((await slash('/session')).command.info, info);
  await writeFile(join(controls, 'unknown-stats'), 'unknown');
  const unknown = (await call('stats', { sessionId })).command.info;
  for (const key of ['userMessages', 'assistantMessages', 'messageCount', 'toolCalls', 'toolResults', 'totalMessages', 'cost', 'contextTokens', 'contextWindow', 'contextPercent']) assert.equal(unknown[key], null, key);
  assert.deepEqual(unknown.tokens, { input: null, output: null, cacheRead: null, cacheWrite: null, total: null });
  await rm(join(controls, 'unknown-stats'));

  const beforeCompact = await count('compact');
  result = await slash('/compact Keep decisions');
  assert.deepEqual(result.command, { type: 'compact', customInstructions: 'Keep decisions' });
  assert.equal(await count('compact'), beforeCompact, 'The slash command requests confirmation without starting compaction');
  assert.deepEqual(result.state.messages, initialMessages); assert.equal(result.state.busy, false);
  await call('compact', { sessionId, customInstructions: 'x'.repeat(8001) }, 400);
  assert.equal(await count('compact'), beforeCompact);
  const completed = call('compact', { sessionId, customInstructions: '  Keep decisions  ' });
  state = await until(async () => { const value = await call('state'); return value.operation === 'compact' && value.busy && value; }, 'compact progress');
  assert.deepEqual(state.messages, initialMessages);
  await call('queue', { sessionId, action: 'steer', message: 'Do not queue during compaction' }, 409);
  await until(async () => await count('compact') === beforeCompact + 1, 'compact RPC request');
  assert.equal((await audit()).filter(entry => entry.type === 'compact').at(-1).customInstructions, 'Keep decisions');
  await writeFile(join(controls, 'compact-1.release'), 'finish');
  result = await completed;
  assert.equal(result.command.type, 'compaction');
  assert.deepEqual(result.command.result, { summary: 'Keep the saved decision and next step.', tokensBefore: 50000, estimatedTokensAfter: 1400,
    usage: { input: 50000, output: 600, cacheRead: 0, cacheWrite: 0, totalTokens: 50600, cost: { input: 0.1, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.12 } } });
  assert.equal(result.state.operation, null); assert.equal(result.state.busy, false);
  const postCompact = (await call('stats', { sessionId })).command.info;
  assert.equal(postCompact.contextTokens, null); assert.equal(postCompact.contextPercent, null); assert.equal(postCompact.contextWindow, 64000);
  assert.equal(postCompact.tokens.total, 31510, 'Cumulative usage does not substitute for unknown current context');

  const cancelled = call('compact', { sessionId }, 500);
  await until(async () => await count('compact') === beforeCompact + 2, 'second compact request');
  state = await call('state'); assert.equal(state.operation, 'compact'); assert.equal(state.busy, true);
  result = await call('stop', { sessionId }); assert.equal(result.ok, true); assert.equal(result.restored, '');
  assert.equal(await count('browser_stopped'), 1, 'Web Stop also revokes the registered browser task while Pi is busy');
  assert.match((await cancelled).error, /Compaction aborted/);
  state = await call('state'); assert.equal(state.operation, null); assert.equal(state.busy, false);
  assert.equal(await count('abort'), 1, 'Stop reaches Pi while the compact HTTP request is still pending');

  const forbiddenPath = join(root, 'caller-controlled.html'); await writeFile(forbiddenPath, 'leave intact');
  result = await call('export', { sessionId, outputPath: forbiddenPath, path: forbiddenPath });
  assert.deepEqual(result.command, { type: 'export', html: exportHtml, filename: `pi-${sessionId}.html` });
  const destination = (await audit()).find(entry => entry.type === 'export_destination');
  assert.equal(basename(destination.outputPath), 'session.html');
  assert.match(relative(dataDir, destination.outputPath), /^export-[^/]+\/session\.html$/);
  assert.equal(destination.directoryMode, 0o700);
  assert.equal(await readFile(forbiddenPath, 'utf8'), 'leave intact', 'Client-supplied export paths cannot select the destination');
  await assert.rejects(access(dirname(destination.outputPath)), { code: 'ENOENT' });
  assert.equal(JSON.stringify(result).includes(destination.outputPath), false);
  result = await slash(`/export ${forbiddenPath}`); assert.equal(result.command.html, exportHtml);
  assert.equal(await readFile(forbiddenPath, 'utf8'), 'leave intact');
  assert.deepEqual((await call('copy', { sessionId })).command, { type: 'copy', text: 'Saved answer' });
  assert.deepEqual((await slash('/copy')).command, { type: 'copy', text: 'Saved answer' });

  await call('queue', { sessionId, action: 'steer', message: 'idle' }, 409);
  await slash('hold:queue'); state = await call('state'); assert.equal(state.busy, true);
  const steerBefore = await count('steer'), followBefore = await count('follow_up');
  for (const message of ['/model', ' \t/mode\tstudy', '/compact\nKeep it']) await call('queue', { sessionId, action: 'steer', message }, 400);
  assert.equal(await count('steer'), steerBefore); assert.equal(await count('follow_up'), followBefore);
  await call('queue', { sessionId, action: 'invalid', message: 'invalid' }, 400);
  await call('queue', { sessionId, action: 'steer', message: 'First direction\nwith detail' });
  result = await call('queue', { sessionId, action: 'follow_up', message: 'Summarize afterwards' });
  assert.deepEqual(result.state.queue, { steering: ['First direction\nwith detail'], followUp: ['Summarize afterwards'] });
  assert.equal(result.state.busy, true);
  await call('queue', { sessionId, action: 'steer', message: 'fixture-reject-queue' }, 500);
  assert.deepEqual((await call('state')).queue, result.state.queue, 'A rejected RPC item is removed from the displayed queue');
  result = await call('queue', { sessionId, action: 'clear' });
  assert.deepEqual(result.restored, { steering: ['First direction\nwith detail'], followUp: ['Summarize afterwards'] });
  assert.deepEqual(result.state.queue, { steering: [], followUp: [] }); assert.equal(result.state.busy, true);
  assert.deepEqual((await slash('/copy')).command, { type: 'copy', text: 'Saved answer' });
  await call('queue', { sessionId, action: 'steer', message: 'Retain this draft' });
  await call('queue', { sessionId, action: 'follow_up', message: 'And this follow-up' });
  result = await call('stop', { sessionId });
  assert.equal(result.restored, 'Retain this draft\n\nAnd this follow-up');
  state = await call('state'); assert.equal(state.busy, false); assert.deepEqual(state.queue, { steering: [], followUp: [] });
  assert.equal(await count('unexpected_model_prompt'), 0, 'Native controls and rejected queued slash commands never fall through to a model prompt');
  const content = messages => messages.map(({ id: _id, ...message }) => message);
  assert.deepEqual(content(state.messages), content(initialMessages), 'Control operations do not append artificial chat messages');
  console.log('Control routes: supported thinking, projected stats, compact confirmation/progress/abort, fixed-path HTML export, copy and busy queues passed without model access');
} finally {
  await app?.close(); await rm(root, { recursive: true, force: true });
}
