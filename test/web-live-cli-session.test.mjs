import './isolate.mjs';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebServer } from '../web/server.mjs';

const root = await mkdtemp(join(tmpdir(), 'pi-web-live-cli-'));
const workspace = join(root, 'workspace'), cliRoot = join(root, 'cli'), dataDir = join(root, 'web');
const first = join(cliRoot, 'first.jsonl'), second = join(cliRoot, 'second.jsonl');
const timestamp = '2026-01-01T00:00:00.000Z';
const header = id => ({ type: 'session', version: 3, id, cwd: workspace, timestamp });
const message = (id, parentId, role, text) => ({ type: 'message', id, parentId, timestamp,
  message: { role, content: [{ type: 'text', text }], timestamp: Date.parse(timestamp),
    ...(role === 'assistant' ? { provider: 'fixture', model: 'none', stopReason: 'stop' } : {}) } });
const jsonl = entries => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const found = predicate(); if (found) return found; await delay(25); }
  throw new Error(`Timed out: ${label}`);
}

let app, eventsController, eventsPump;
try {
  await Promise.all([workspace, cliRoot].map(path => mkdir(path, { recursive: true })));
  const initial = jsonl([header('native-first'), message('u1', null, 'user', 'First CLI question'), message('a1', 'u1', 'assistant', 'First CLI answer')]);
  await writeFile(first, initial);
  app = await createWebServer({ dataDir, workspace, sessionRoots: [cliRoot], piBin: join(root, 'no-pi'),
    env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: join(root, 'agent') } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (path, body) => {
    const response = await fetch(`${base}/api/${path}`, { method: body ? 'POST' : 'GET',
      headers: body ? { Origin: base, 'Content-Type': 'application/json', 'X-Pi-Web': '1' } : {},
      body: body ? JSON.stringify(body) : undefined });
    const data = await response.json();
    assert.equal(response.status, 200, `${path}: ${JSON.stringify(data)}`);
    return data;
  };
  const initialState = await api('state');
  const localId = initialState.sessions.find(session => session.title === 'First CLI question')?.id;
  assert.ok(localId);
  const opened = await api('open', { id: localId });
  assert.equal(opened.readOnly, true);
  assert.deepEqual(opened.messages.map(item => item.text), ['First CLI question', 'First CLI answer']);

  const frames = [];
  eventsController = new AbortController();
  const eventsResponse = await fetch(`${base}/api/events`, { signal: eventsController.signal });
  assert.equal(eventsResponse.status, 200);
  const reader = eventsResponse.body.getReader(), decoder = new TextDecoder();
  eventsPump = (async () => {
    let pending = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) return;
      pending += decoder.decode(value, { stream: true });
      let end;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, end); pending = pending.slice(end + 2);
        if (/^event: snapshot$/m.test(frame)) {
          const data = frame.match(/^data: (.+)$/m)?.[1]; if (data) frames.push(JSON.parse(data));
        }
      }
    }
  })().catch(error => { if (error.name !== 'AbortError') throw error; });
  await until(() => frames.length > 0, 'initial SSE frame');
  await delay(400);

  const added = JSON.stringify(message('u2', 'a1', 'user', 'Live CLI update')) + '\n';
  const split = added.length - 4;
  await appendFile(first, added.slice(0, split));
  await delay(900);
  const incomplete = await api('state');
  assert.equal(incomplete.libraryIssueCount, 0, 'A partially appended JSONL line must not mark the CLI session broken');
  assert.deepEqual(incomplete.messages.map(item => item.text), ['First CLI question', 'First CLI answer'], 'Keep the last complete branch while CLI writes');
  await appendFile(first, added.slice(split));
  const updated = await until(() => frames.find(frame => frame.sessionId === localId && frame.messages?.some(item => item.text === 'Live CLI update')), 'CLI append SSE');
  assert.equal(updated.origin, 'local'); assert.equal(updated.readOnly, true); assert.equal(updated.libraryIssueCount, 0);
  assert.deepEqual(updated.messages.map(item => item.text), ['First CLI question', 'First CLI answer', 'Live CLI update']);
  assert.equal(await readFile(first, 'utf8'), initial + added, 'The Web follower must never rewrite the CLI file');

  await writeFile(second, jsonl([header('native-second'), message('another', null, 'user', 'Another CLI session')]));
  const discovered = await until(() => frames.find(frame => frame.sessions?.some(session => session.title === 'Another CLI session')), 'new CLI session SSE');
  assert.equal(discovered.sessionId, localId); assert.equal(discovered.readOnly, true);
  assert.equal(discovered.sessions.filter(session => session.origin === 'local').length, 2);
  console.log('Live CLI session watcher: catalog SSE, complete-branch follow, partial-write deferral and read-only source preservation passed');
} finally {
  eventsController?.abort(); await eventsPump;
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
