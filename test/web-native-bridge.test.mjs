import './isolate.mjs';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionSyncBridge } from '../extensions/session-sync/bridge.mjs';
import { createWebServer } from '../web/server.mjs';
import { workspaceControls, agentControls, modelDisabledReason } from '../web/public/state.js';

const root = await mkdtemp(join(tmpdir(), 'zen-pi-native-web-'));
const runtimeDir = join(root, 'runtime'), workspace = join(root, 'workspace'), cliRoot = join(root, 'cli');
const dataDir = join(root, 'web'), agentDir = join(root, 'agent'), vault = join(root, 'vault');
const sessionFile = join(cliRoot, 'one.jsonl');
const otherFile = join(cliRoot, 'other.jsonl');
const nativeId = '01900000-0000-7000-8000-000000000011';
const otherNativeId = '01900000-0000-7000-8000-000000000022';
const stamp = '2026-01-01T00:00:00.000Z';
const user = text => ({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.parse(stamp) });
const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: Date.parse(stamp), stopReason: 'stop' });
const entry = (id, parentId, message) => ({ type: 'message', id, parentId, timestamp: stamp, message });
const entries = [{ type: 'session', version: 3, id: nativeId, cwd: workspace, timestamp: stamp },
  entry('root-user', null, user('原生 Pi 開始')), entry('root-answer', 'root-user', assistant('原生 Pi 回覆'))];
let app, bridge, base, eventsAbort, readGate;
const sent = [];
async function waitFor(predicate, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function api(path, body) {
  const response = await fetch(`${base}/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { Origin: base, 'Content-Type': 'application/json', 'X-Pi-Web': '1' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
const save = () => writeFile(sessionFile, entries.map(value => JSON.stringify(value)).join('\n') + '\n');
function pauseNextNativeRead() {
  const originalOpen = fs.open;
  let enteredResolve, finishedResolve, releaseResolve, armed = true;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const finished = new Promise(resolve => { finishedResolve = resolve; });
  const releaseSignal = new Promise(resolve => { releaseResolve = resolve; });
  fs.open = async function (...args) {
    const stack = new Error().stack || '';
    const handle = await originalOpen.apply(this, args);
    if (!armed || args[0] !== sessionFile || !stack.includes('Object.read')) return handle;
    armed = false;
    return new Proxy(handle, { get(target, key) {
      if (key === 'readFile') return async (...parameters) => {
        enteredResolve(); await releaseSignal; return target.readFile(...parameters);
      };
      if (key === 'close') return async (...parameters) => {
        try { return await target.close(...parameters); } finally { finishedResolve(); }
      };
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  return {
    entered, finished, release: () => releaseResolve(), restore: () => { fs.open = originalOpen; releaseResolve(); },
  };
}
async function waitPromise(promise, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5000);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
try {
  await Promise.all([runtimeDir, workspace, cliRoot, dataDir, agentDir, vault].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  await save();
  await writeFile(otherFile, [
    { type: 'session', version: 3, id: otherNativeId, cwd: workspace, timestamp: stamp },
    entry('other-user', null, user('另一段對話')), entry('other-answer', 'other-user', assistant('另一段回覆')),
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  bridge = await createSessionSyncBridge({ sessionFile, sessionId: nativeId,
    getState: () => ({ busy: false, leafId: 'root-answer' }),
    sendPrompt: text => sent.push(text), abort: () => sent.push('ABORT') });
  app = await createWebServer({ dataDir, workspace, sessionRoots: [cliRoot], piBin: join(root, 'no-pi'),
    env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_STUDY_VAULT: vault }, restore: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  eventsAbort = new AbortController();
  const events = await fetch(`${base}/api/events`, { signal: eventsAbort.signal });
  assert.equal(events.status, 200);
  let state = (await api('state')).data;
  const record = state.sessions.find(item => item.origin === 'local' && item.title === '原生 Pi 開始');
  assert(record, 'native CLI Session appears in Web catalog');
  state = (await api('open', { id: record.id })).data;
  assert.equal(state.nativeBridge, true);
  assert.equal(state.readOnly, false);
  assert.equal(state.online, true);
  assert.equal(state.messages.at(-1).text, '原生 Pi 回覆');
  assert.equal(workspaceControls(state, { connected: true, working: false }).send, true);
  assert.equal(workspaceControls(state, { connected: true, working: false }).mode, false);
  assert.equal(agentControls(state, { connected: true, working: false }).createAgent, false);
  assert.match(modelDisabledReason(state, { connected: true, working: false }), /原生 Pi 終端/);
  const body = { sessionId: record.id, workspaceId: state.workspaceId };
  assert.equal((await api('mode', { ...body, mode: 'study' })).status, 409, 'RPC-only controls are unavailable on native writer');
  assert.equal((await api('prompt', { ...body, message: '/new' })).status, 400, 'native slash commands never become model prompts');
  assert.equal((await api('prompt', { ...body, message: '從 Web 傳來' })).status, 200);
  assert.deepEqual(sent, ['從 Web 傳來']);
  bridge.publish({ type: 'agent_start' });
  bridge.publish({ type: 'message_start', message: user('從 Web 傳來') });
  bridge.publish({ type: 'message_end', message: user('從 Web 傳來') });
  bridge.publish({ type: 'message_start', message: { ...assistant(''), content: [] } });
  bridge.publish({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '即時', content: '即時' } });
  await waitFor(async () => (await api('state')).data.messages.at(-1)?.text === '即時', 'native streaming text');
  assert.equal((await api('stop', body)).status, 200);
  assert.deepEqual(sent, ['從 Web 傳來', 'ABORT']);
  entries.push(entry('next-user', 'root-answer', user('從 Web 傳來')), entry('next-answer', 'next-user', assistant('即時回覆')));
  await writeFile(sessionFile, entries.map(value => JSON.stringify(value)).join('\n') + '\n');
  bridge.publish({ type: 'message_end', message: assistant('即時回覆') });
  bridge.publish({ type: 'agent_settled', sessionSyncLeafId: 'next-answer' });
  await waitFor(async () => (await api('state')).data.messages.at(-1)?.text === '即時回覆', 'native completed reply');
  state = (await api('refresh', {})).data;
  assert.equal(state.messages.at(-1)?.text, '即時回覆', 'settled native turn keeps its advanced leaf after reread');
  await bridge.close(); bridge = null;
  state = await waitFor(async () => { const next = (await api('state')).data; return next.readOnly ? next : null; }, 'native disconnect');
  assert.equal(state.nativeBridge, false);
  assert.equal(state.online, false);
  bridge = await createSessionSyncBridge({ sessionFile, sessionId: nativeId,
    getState: () => ({ busy: false, leafId: 'next-answer' }), sendPrompt: text => sent.push(text) });
  state = await waitFor(async () => { const next = (await api('state')).data; return next.nativeBridge ? next : null; }, 'native reconnect without changing JSONL');
  assert.equal(state.readOnly, false);
  const other = state.sessions.find(item => item.origin === 'local' && item.title === '另一段對話');
  assert(other, 'second native session is available for navigation race');

  // A native tree refresh may be reading the just-finished turn when Pi starts
  // the next one. The delayed read must not erase the newer streaming state.
  entries.push(entry('finished-user', 'next-answer', user('上一輪問題')),
    entry('finished-answer', 'finished-user', assistant('第一輪完成')));
  await save();
  readGate = pauseNextNativeRead();
  bridge.publish({ type: 'session_tree', newLeafId: 'finished-answer', oldLeafId: 'next-answer' });
  await waitPromise(readGate.entered, 'native reread gate');
  bridge.publish({ type: 'agent_start' });
  bridge.publish({ type: 'message_start', message: { ...assistant(''), content: [] } });
  bridge.publish({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '第二輪正在寫' } });
  await waitFor(async () => { const next = (await api('state')).data; return next.busy && next.messages.at(-1)?.text === '第二輪正在寫'; }, 'second native turn starts during reread');
  readGate.release(); await waitPromise(readGate.finished, 'native reread finishes'); readGate.restore(); readGate = null;
  await new Promise(resolve => setImmediate(resolve));
  state = (await api('state')).data;
  assert.equal(state.busy, true, 'the delayed reread cannot clear a newer native agent_start');
  assert.equal(state.messages.at(-1)?.text, '第二輪正在寫', 'the delayed reread cannot erase newer streamed text');

  // A stale read belongs to its original Session. Navigating while it is
  // blocked must leave the newly selected Session and Workspace untouched.
  entries.push(entry('second-user', 'finished-answer', user('第二輪問題')),
    entry('second-answer', 'second-user', assistant('第二輪完成')));
  await save();
  bridge.publish({ type: 'message_end', message: assistant('第二輪完成') });
  bridge.publish({ type: 'agent_settled' });
  await waitFor(async () => !(await api('state')).data.busy, 'second native turn settled');
  readGate = pauseNextNativeRead();
  bridge.publish({ type: 'session_tree', newLeafId: 'second-answer', oldLeafId: 'finished-answer' });
  await waitPromise(readGate.entered, 'navigation reread gate');
  state = (await api('open', { id: other.id })).data;
  assert.equal(state.sessionId, other.id);
  assert.equal(state.messages.at(-1)?.text, '另一段回覆');
  readGate.release(); await waitPromise(readGate.finished, 'stale reread finishes'); readGate.restore(); readGate = null;
  await new Promise(resolve => setImmediate(resolve));
  state = (await api('state')).data;
  assert.equal(state.sessionId, other.id, 'old reread cannot switch Web back to its source Session');
  assert.equal(state.messages.at(-1)?.text, '另一段回覆');

  state = (await api('open', { id: record.id })).data;
  assert.equal(state.nativeBridge, true);
  bridge.publish({ type: 'agent_start' });
  bridge.publish({ type: 'message_start', message: { ...assistant(''), content: [] } });
  bridge.publish({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '斷線前片段' } });
  await waitFor(async () => (await api('state')).data.messages.at(-1)?.text === '斷線前片段', 'stream before native disconnect');
  entries.push(entry('closed-user', 'second-answer', user('斷線前問題')),
    entry('closed-answer', 'closed-user', assistant('斷線前已寫入完整回覆')));
  await save();
  await bridge.close(); bridge = null;
  state = await waitFor(async () => {
    const next = (await api('state')).data;
    return next.readOnly && !next.busy && next.messages.at(-1)?.text === '斷線前已寫入完整回覆' ? next : null;
  }, 'socket close converges to complete JSONL');
  assert.equal(state.messages.at(-1).streaming, false);

  // Pi can navigate an existing tree without appending a message. The native
  // leaf, not the last line in JSONL, determines which branch Web should show.
  entries.push(entry('branch-a-user', 'closed-answer', user('分支 A 問題')),
    entry('branch-a-answer', 'branch-a-user', assistant('分支 A 回覆')),
    entry('branch-b-user', 'closed-answer', user('分支 B 問題')),
    entry('branch-b-answer', 'branch-b-user', assistant('分支 B 回覆')));
  await save();
  let leafId = 'branch-b-answer';
  bridge = await createSessionSyncBridge({ sessionFile, sessionId: nativeId,
    getState: () => ({ busy: false, leafId }), sendPrompt: text => sent.push(text) });
  await waitFor(async () => (await api('state')).data.nativeBridge, 'branch bridge reconnect');
  leafId = 'branch-a-answer';
  bridge.publish({ type: 'session_tree', newLeafId: leafId, oldLeafId: 'branch-b-answer' });
  state = await waitFor(async () => {
    const next = (await api('state')).data;
    return next.messages.at(-1)?.text === '分支 A 回覆' ? next : null;
  }, 'terminal selects non-last branch leaf');
  assert(!state.messages.some(message => message.text === '分支 B 回覆'), 'inactive branch stays hidden');
  state = (await api('refresh', {})).data;
  assert.equal(state.messages.at(-1)?.text, '分支 A 回覆', 'catalog refresh retains the native terminal leaf');
  console.log('Native Pi writer and Web share live messages; unsupported controls and concurrent writes remain blocked.');
} finally {
  readGate?.restore();
  eventsAbort?.abort();
  await app?.close(); await bridge?.close(); await rm(root, { recursive: true, force: true });
}
