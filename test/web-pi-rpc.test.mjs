import './isolate.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createWebServer } from '../web/server.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'pi-web-real-rpc-'));
const vault = join(root, 'vault'), agent = join(root, 'agent');
await mkdir(vault); await mkdir(agent);
await writeFile(join(vault, 'NAT.md'), '# NAT\n私有原始筆記；清單不能包含這句。\n');
let modelCalls = 0, app, base, allowModel = false, modelError, releaseStream, eventsController, eventsPump;
const firstText = '這是由本機假模型傳來的第一段。';
const answerText = `${firstText}\n第二段確認完整回覆已保存。`;
const streamRelease = new Promise(resolve => { releaseStream = resolve; });
const model = createServer(async (req, res) => {
  modelCalls++;
  try {
    assert.ok(allowModel, 'Mode-only actions must not issue model requests');
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    assert.equal(request.model, 'web-smoke');
    assert.equal(request.stream, true);
    assert.ok(request.messages.some(m => JSON.stringify(m.content).includes('測試真 Pi 的 Web 串流')));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'local-web-completion', object: 'chat.completion.chunk', created: 1, model: 'web-smoke', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    emit({ role: 'assistant', content: firstText });
    // The test releases the second chunk only after seeing the first via Web SSE.
    await streamRelease;
    emit({ content: answerText.slice(firstText.length) }); emit({}, 'stop'); res.end('data: [DONE]\n\n');
  } catch (error) { modelError = error; if (!res.headersSent) res.writeHead(500); res.end(JSON.stringify({ error: { message: error.message } })); }
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const pkg = process.env.PI_WEB_TEST_PACKAGE || resolve(here, '..');
await writeFile(join(agent, 'settings.json'), JSON.stringify({ packages: [pkg], defaultProvider: 'mock', defaultModel: 'web-smoke' }));
await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, api: 'openai-completions', apiKey: 'test-placeholder', models: [{ id: 'web-smoke', reasoning: false, input: ['text'], contextWindow: 64000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
const options = { dataDir: join(root, 'data'), workspace: vault, piBin: 'pi', piArgs: ['--no-context-files', '--no-skills'], env: { PATH: process.env.PATH, HOME: root, LANG: 'C.UTF-8', PI_CODING_AGENT_DIR: agent, PI_STUDY_VAULT: vault }, publicOrigin: '', tailscaleUser: '' };
async function launch() { app = await createWebServer(options); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`; }
async function call(path, body) {
  const response = await fetch(`${base}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { Origin: base, 'Content-Type': 'application/json', 'X-Pi-Web': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data;
}
const frames = [];
async function until(predicate, label) {
  for (let i = 0; i < 400; i++) {
    if (modelError) throw modelError;
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
}
async function connectEvents() {
  eventsController = new AbortController();
  const response = await fetch(`${base}/api/events`, { signal: eventsController.signal });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  eventsPump = (async () => {
    let pending = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) return;
      pending += decoder.decode(value, { stream: true }); let end;
      while ((end = pending.indexOf('\n\n')) !== -1) {
        const frame = pending.slice(0, end); pending = pending.slice(end + 2);
        const type = frame.match(/^event: (.+)$/m)?.[1], data = frame.match(/^data: (.+)$/m)?.[1];
        if (type && data) frames.push({ type, data: JSON.parse(data) });
      }
    }
  })().catch(error => { if (error.name !== 'AbortError') modelError = error; });
  await until(() => frames.some(f => f.type === 'snapshot'), 'initial SSE snapshot');
}
try {
  await launch();
  let state = await call('sessions', {}), id = state.sessionId;
  assert.equal(state.mode, 'general');
  assert.equal(state.notice, '', 'Real Pi status JSON does not appear as a terminal notice in the browser');
  state = await call('mode', { sessionId: id, mode: 'study' }); assert.equal(state.mode, 'study');
  assert.equal(state.notice, '', 'Study mode cannot retain a general status notice');
  const list = await call('notes', { sessionId: id, query: 'NAT' });
  assert.equal(list.notes[0].path, 'NAT.md'); assert.ok(!JSON.stringify(list).includes('私有原始筆記'));
  state = await call('note', { sessionId: id, path: 'NAT.md' });
  assert.equal(state.context.current, 'NAT.md'); assert.equal(state.sources.length, 0, 'Choosing a note alone does not expose source text');
  const fresh = await call('sessions', {}); assert.equal(fresh.mode, 'general');
  state = await call('open', { id }); assert.equal(state.mode, 'study'); assert.equal(state.context.current, 'NAT.md');
  state = await call('mode', { sessionId: id, mode: 'research' }); assert.equal(state.mode, 'research');
  await app.close(); await launch();
  state = await call('state'); assert.equal(state.sessionId, id); assert.equal(state.mode, 'research');
  assert.equal(modelCalls, 0, 'Mode / note HTTP actions and startup must not issue model requests');
  allowModel = true;
  await connectEvents();
  await call('prompt', { sessionId: id, message: '測試真 Pi 的 Web 串流' });
  await until(() => frames.some(f => f.type === 'delta' && f.data.delta.includes(firstText)), 'first model chunk reaches Web SSE before completion');
  state = await call('state');
  assert.equal(state.busy, true);
  assert.equal(state.messages.filter(m => m.role === 'assistant').at(-1).text, firstText);
  assert.ok(frames.some(f => f.type === 'snapshot' && f.data.busy));
  releaseStream();
  await until(() => frames.some(f => f.type === 'snapshot' && !f.data.busy && f.data.messages.some(m => m.role === 'assistant' && m.text === answerText)), 'authoritative full answer and agent_settled');
  state = await call('state'); assert.equal(state.busy, false); assert.equal(state.error, '');
  assert.equal(state.messages.filter(m => m.role === 'assistant').at(-1).text, answerText);
  assert.equal(modelCalls, 1, 'Only one local fake-provider request is needed');
  eventsController.abort(); await eventsPump; eventsController = null;
  await app.close(); await launch();
  state = await call('state'); assert.equal(state.sessionId, id); assert.equal(state.busy, false);
  assert.equal(state.messages.filter(m => m.role === 'assistant').at(-1).text, answerText);
  assert.ok(state.messages.some(m => m.role === 'user' && m.text === '測試真 Pi 的 Web 串流'));
  await call('sessions', {});
  state = await call('open', { id }); assert.equal(state.mode, 'research');
  assert.equal(state.messages.filter(m => m.role === 'assistant').at(-1).text, answerText);
  assert.equal(modelCalls, 1, 'Restarting and reopening saved conversations do not call a model');
  assert.equal(await readFile(join(vault, 'NAT.md'), 'utf8'), '# NAT\n私有原始筆記；清單不能包含這句。\n');
  console.log('Real Pi Web RPC: modes / notes use zero model calls; streaming and persistence pass with one local fake-provider request');
} finally { releaseStream(); eventsController?.abort(); await eventsPump; await app?.close(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); await rm(root, { recursive: true, force: true }); }
