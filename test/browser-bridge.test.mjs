import './isolate.mjs';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createBrowserBridge } from '../browser/bridge.mjs';
import { request } from '../browser/client.mjs';
import { BrowserRuntime } from '../browser/runtime.mjs';
import { suggest } from '../browser/decisions.mjs';
import { makeLoader } from './harness.mjs';
const jiti = await makeLoader();
const { default: extension } = await jiti.import(new URL('../extensions/browser/index.mjs', import.meta.url).pathname);

const token = 'a'.repeat(48), peer = 'fixture-browser-1234';
const bridge = await createBrowserBridge({ token, port: 0, timeout: 300, leaseMs: 5000 });
const config = { endpoint: `http://127.0.0.1:${bridge.port}`, token };
async function addon(path, body) {
  const response = await fetch(config.endpoint + '/extension/' + path, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...body, peer }) });
  return { status: response.status, value: await response.json() };
}
async function exchange(body, result) {
  const poll = addon('poll', {}), answer = request(config, body);
  const { value } = await poll;
  assert(value.command.id);
  await addon('result', { id: value.command.id, result });
  return answer;
}
try {
  const unauthorized = await fetch(config.endpoint + '/client', { method: 'POST', body: '{}' });
  assert.equal(unauthorized.status, 401);
  const hostile = await fetch(config.endpoint + '/client', { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(hostile.status, 403);
  const rebound = await new Promise((resolve, reject) => {
    const req = httpRequest(config.endpoint + '/client', { method: 'POST', headers: { Authorization: `Bearer ${token}`, Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(rebound, 403);
  await assert.rejects(request(config, { op: 'begin', url: 'file:///etc/passwd' }), /HTTP/);
  assert.deepEqual(await exchange({ op: 'tabs' }, [{ id: 4, title: 'Fixture', url: 'http://fixture/' }]), [{ id: 4, title: 'Fixture', url: 'http://fixture/' }]);
  const started = await exchange({ op: 'begin', tabId: 4 }, { snapshot: 'one', actions: [] });
  await assert.rejects(request(config, { op: 'begin', tabId: 5 }), /另一個/);
  await assert.rejects(request(config, { op: 'act', lease: 'wrong' }), /未啟用/);
  const poll = addon('poll', {});
  const pending = request(config, { op: 'act', lease: started.lease, snapshot: 'one', action: '1:click' });
  const rejected = assert.rejects(pending, /已停止/);
  const { value } = await poll;
  await request(config, { op: 'stop', lease: started.lease }); await rejected;
  assert.equal((await addon('result', { id: value.command.id, result: { executed: true } })).status, 400);
  const next = await exchange({ op: 'begin', tabId: 4 }, { snapshot: 'two', actions: [] });
  const timeoutPoll = addon('poll', {});
  const timedOut = assert.rejects(request(config, { op: 'act', lease: next.lease, action: '1:click' }), /結果不確定/);
  await timeoutPoll; await timedOut;
  assert.equal((await request(config, { op: 'status' })).busy, false);
} finally { await bridge.close(); }

const page = { tabId: 4, snapshot: 'snapshot1', url: 'https://fixture.test/result', title: 'Fixture', text: 'Found result', actions: [{ id: '1:fill', kind: 'fill', label: 'Search', value: '' }] };
const calls = [];
const worker = { close() {}, async predict(_state, questions) { return { answers: Object.fromEntries(Object.entries(questions).map(([id, q]) => {
  const keys = Object.keys(q.criteria), choice = keys.includes('1:fill') ? '1:fill' : keys[0];
  return [id, { choice, confidence: .9, probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? 1 : 0])) }];
})) }; } };
const runtime = new BrowserRuntime({ connect: async () => config, worker, call: async (_c, body) => {
  calls.push(body);
  if (body.op === 'begin') return { lease: 'lease', page };
  if (body.op === 'observe') return page;
  return {};
} });
await assert.rejects(runtime.run({ op: 'observe' }), /使用者/);
await runtime.begin({ tabId: 4 }, 'Search something');
const suggestion = await runtime.run({ op: 'step' });
assert(suggestion.needsText); assert(!calls.some(c => c.op === 'act'));
await assert.rejects(runtime.run({ op: 'act', snapshot: 'stale', action: '1:fill', text: 'hello' }), /snapshot/);
await assert.rejects(runtime.run({ op: 'act', snapshot: page.snapshot, action: 'invented' }), /選項/);
await runtime.run({ op: 'act', snapshot: page.snapshot, action: '1:fill', text: 'hello' });
assert.equal(calls.filter(c => c.op === 'act').length, 1);
await assert.rejects(runtime.run({ op: 'finish', outcome: 'completed', verify: { text: 'missing' } }), /未符合/);
assert(runtime.status().active);
await runtime.run({ op: 'finish', outcome: 'completed', verify: { url: page.url, text: 'Found result' } });
assert(!runtime.status().active);
await assert.rejects(suggest({ predict: async () => ({ answers: {} }) }, page, 'Search'), /無效選項/);

const events = {}, commands = {}, tools = {}, messages = []; let active = ['read', 'browser'];
extension({ on: (name, fn) => events[name] = fn, registerCommand: (name, fn) => commands[name] = fn, registerTool: tool => tools[tool.name] = tool,
  getActiveTools: () => active, setActiveTools: names => active = names, sendMessage: value => messages.push(value) }, { runtime });
await events.session_start(); assert.deepEqual(active, ['read']);
await commands.browser.handler('4 Search', { isIdle: () => true });
assert(active.includes('browser'));
await commands.browser.handler('stop', { isIdle: () => false });
assert(!active.includes('browser')); assert(!runtime.status().active);
await assert.rejects(tools.browser.execute('id', { op: 'observe' }), /使用者/);
await events.session_shutdown();
await commands.browser.handler('4 Search', { isIdle: () => true });
await events.session_start(); assert(!runtime.status().active); assert(!active.includes('browser'));

const proposalCalls = [], clickPage = { ...page, actions: [{ id: '1:click', kind: 'click', label: 'Next' }] };
const advisory = new BrowserRuntime({ connect: async () => config, worker, call: async (_c, body) => {
  proposalCalls.push(body); return body.op === 'begin' ? { lease: 'proposal', page: clickPage } : clickPage;
} });
await advisory.begin({ tabId: 4 }, 'Next');
assert.equal((await advisory.run({ op: 'step' })).proposal.id, '1:click');
assert(!proposalCalls.some(body => body.op === 'act'), 'A Laya click suggestion must wait for Pi to invoke act');
await advisory.stop();

// Stop during begin must release a late lease; a transport failure must not leave a live tool.
let resolveBegin, beginIssued;
const issued = new Promise(resolve => beginIssued = resolve), raceCalls = [];
const racing = new BrowserRuntime({ connect: async () => config, worker, call: async (_c, body) => {
  raceCalls.push(body);
  if (body.op === 'begin') { beginIssued(); return new Promise(resolve => resolveBegin = resolve); }
  return {};
} });
const beginning = racing.begin({ tabId: 4 }, 'fixture');
await issued; await racing.stop(); resolveBegin({ lease: 'late-lease', page });
await assert.rejects(beginning, /停止/);
assert(raceCalls.some(c => c.op === 'stop' && c.lease === 'late-lease')); assert(!racing.status().active);
await runtime.begin({ tabId: 4 }, 'fixture');
runtime.call = async (_c, body) => { if (body.op === 'observe') throw new Error('Disconnected'); return {}; };
await assert.rejects(runtime.run({ op: 'observe' }), /Disconnected/); assert(!runtime.status().active);
console.log('Browser bridge: origin/auth, task ownership, timeout/cancel, one-shot actions, model contract, text handoff, finish checks and command gating pass. No real browser or model used.');
