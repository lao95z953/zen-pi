import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWebServer } from '../web/server.mjs';

const root = await mkdtemp(join(tmpdir(), 'zen-pi-thinking-'));
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/pi-rpc.mjs');
const gate = join(root, 'thinking.release');
const options = { dataDir: join(root, 'data'), workspace: root, piBin: process.execPath, piArgs: [fixture], env: { ...process.env, HOME: root, FAKE_THINKING_GATE: gate } };
let app, base, controller;
async function launch() {
  app = await createWebServer(options);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
}
async function api(path, body) {
  const response = await fetch(`${base}/api/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pi-Web': '1', Origin: base }, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  return response.json();
}
async function until(predicate) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const state = await api('state');
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for thinking state');
}
try {
  await launch();
  const session = await api('sessions', {});
  controller = new AbortController();
  const stream = await fetch(`${base}/api/events`, { signal: controller.signal });
  const reader = stream.body.getReader();
  await api('prompt', { sessionId: session.sessionId, workspaceId: session.workspaceId, message: 'thinking-stream' });
  const partial = await until(state => state.busy && state.messages.at(-1)?.thinking === '先核對前提');
  assert.equal(partial.messages.at(-1).text, '', 'The advanced message_start must not duplicate later deltas');
  assert.equal(partial.transcript.entries.at(-1).thinking, '先核對前提');
  await writeFile(gate, 'continue');
  const final = await until(state => !state.busy && state.messages.at(-1)?.text === '結論已核對。');
  assert.equal(final.messages.at(-1).thinking, '先核對前提與證據。');
  assert.equal(final.transcript.entries.at(-1).thinking, '先核對前提與證據。');
  assert.ok(!JSON.stringify(final).includes('PRIVATE-SIGNATURE'));
  let frames = '';
  for (let attempt = 0; attempt < 25 && !frames.includes('event: thinking'); attempt++) {
    const next = await Promise.race([reader.read(), new Promise((_, reject) => setTimeout(() => reject(new Error('SSE timeout')), 2000))]);
    if (next.done) break;
    frames += new TextDecoder().decode(next.value);
  }
  assert.match(frames, /event: thinking/);
  assert.ok(!frames.includes('PRIVATE-SIGNATURE'));
  controller.abort(); controller = null;
  await app.close(); await launch();
  const restored = await api('state');
  assert.equal(restored.messages.at(-1).thinking, '先核對前提與證據。');
  assert.equal(restored.messages.at(-1).text, '結論已核對。');
  console.log('Live thinking deltas, SSE, final transcript and restored Session passed');
} finally {
  controller?.abort();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
