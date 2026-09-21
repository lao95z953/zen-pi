import './isolate.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSubagentBridge } from '../web/subagent-bridge.mjs';
import { createWebServer } from '../web/server.mjs';

function socketRequest(socketPath, body, { path = '/subagent', method = 'POST' } = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path, method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, response => {
      let output = ''; response.on('data', chunk => { output += chunk; }); response.on('error', reject);
      response.on('end', () => { try { resolve({ status: response.statusCode, value: JSON.parse(output) }); } catch (error) { reject(error); } });
    });
    request.setTimeout(10000, () => request.destroy(new Error('Fixture socket request timed out')));
    request.on('error', reject); request.end(data);
  });
}
async function until(predicate, label) {
  for (let index = 0; index < 1500; index++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(`Timed out: ${label}`);
}

test('bridge is a private bounded local socket and removes its directory when closed', async () => {
  let called = 0;
  const bridge = await createSubagentBridge(body => { called++; return { action: body.action }; });
  const directory = dirname(bridge.socketPath);
  try {
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(bridge.socketPath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(bridge.socketPath)).isSocket(), true);
    assert.deepEqual(await socketRequest(bridge.socketPath, { action: 'list' }), { status: 200, value: { ok: true, data: { action: 'list' } } });
    assert.equal(called, 1);
    for (const body of ['null', '[]', '{broken', JSON.stringify({ huge: 'x'.repeat(129 * 1024) })]) {
      const response = await socketRequest(bridge.socketPath, body);
      assert.equal(response.status, 400); assert.equal(response.value.ok, false);
    }
    assert.equal((await socketRequest(bridge.socketPath, {}, { path: '/elsewhere' })).status, 400);
    assert.equal(called, 1, 'Malformed requests must never reach the scope handler');
  } finally { await bridge.close(); }
  await assert.rejects(fs.stat(directory), error => error.code === 'ENOENT');
});

test('real main Pi delegates through the scoped tool while child Pi cannot load that extension', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'pi-subagent-bridge-test-'));
  const workspace = join(root, 'workspace'), agent = join(root, 'agent'), dataDir = join(root, 'data'), proofFile = join(root, 'parent-scope.json');
  await fs.mkdir(workspace); await fs.mkdir(join(agent, 'extensions'), { recursive: true });
  await fs.writeFile(join(workspace, 'Fixture.md'), '# Fixture\nA temporary note.\n');
  await fs.writeFile(join(agent, 'extensions', 'scope-proof.ts'), `import { writeFileSync } from 'node:fs';\nexport default function(pi) { pi.on('session_start', (_event, ctx) => { writeFileSync(${JSON.stringify(proofFile)}, JSON.stringify({ socketPath: process.env.PI_WEB_SUBAGENT_SOCKET, nativeSessionId: ctx.sessionManager.getSessionId() })); }); }\n`);
  const pkg = process.env.PI_WEB_TEST_PACKAGE || resolve(dirname(fileURLToPath(import.meta.url)), '..');
  await fs.writeFile(join(agent, 'settings.json'), JSON.stringify({ packages: [pkg], defaultProvider: 'fixture', defaultModel: 'bridge-fixture', retry: { enabled: false } }));
  let app, base, providerError, mainCalls = 0, childCalls = 0;
  const provider = http.createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw), isMain = body.tools.some(tool => tool.function.name === 'subagent');
      assert.equal(body.model, 'bridge-fixture');
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'bridge-fixture', object: 'chat.completion.chunk', created: 1,
        model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (isMain) {
        mainCalls++;
        if (mainCalls === 1) {
          emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'delegate-fixture', type: 'function', function: { name: 'subagent',
            arguments: JSON.stringify({ action: 'start', task: 'Return a short synthetic result.', context: 'Only temporary fixtures.', kind: 'read' }) } }] });
          emit({}, 'tool_calls');
        } else {
          assert.equal(mainCalls, 2);
          assert.ok(body.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('parentSessionId')),
            'The main Pi receives a public job from the actual subagent tool');
          emit({ role: 'assistant', content: 'The independent task was started.' }); emit({}, 'stop');
        }
      } else {
        childCalls++; assert.equal(childCalls, 1);
        assert.deepEqual(body.tools.map(tool => tool.function.name).sort(), ['find', 'grep', 'ls', 'read']);
        emit({ role: 'assistant', content: 'Synthetic child result.' }); emit({}, 'stop');
      }
      response.end('data: [DONE]\n\n');
    } catch (error) { providerError = error; if (!response.headersSent) response.writeHead(500); response.end(JSON.stringify({ error: { message: error.message } })); }
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  try {
    await fs.writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions',
      apiKey: 'local-test-placeholder', models: [{ id: 'bridge-fixture', reasoning: false, input: ['text'], contextWindow: 64000, maxTokens: 1000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    app = await createWebServer({ dataDir, workspace, sessionRoots: [], piBin: 'pi', piArgs: ['--no-context-files', '--no-skills'],
      env: { PATH: process.env.PATH, HOME: root, LANG: 'C.UTF-8', PI_CODING_AGENT_DIR: agent, PI_STUDY_VAULT: workspace }, publicOrigin: '', tailscaleUser: '' });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
    const post = async (path, body) => {
      const response = await fetch(`${base}/api/${path}`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-Pi-Web': '1' }, body: JSON.stringify(body) });
      const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
    };
    const first = await post('sessions', {}), scope = JSON.parse(await fs.readFile(proofFile, 'utf8'));
    assert.equal(typeof scope.socketPath, 'string'); assert.equal(typeof scope.nativeSessionId, 'string');
    assert.equal((await fs.stat(scope.socketPath)).mode & 0o777, 0o600);
    let response = await socketRequest(scope.socketPath, { action: 'list', nativeSessionId: 'invalid-scope' });
    assert.equal(response.status, 409); assert.equal(response.value.ok, false);
    response = await socketRequest(scope.socketPath, { action: 'list', nativeSessionId: scope.nativeSessionId });
    assert.deepEqual(response.value.data, []);
    await post('prompt', { sessionId: first.sessionId, message: 'Delegate the synthetic independent task.' });
    await until(() => providerError || (app.snapshot().subagents.some(job => job.status === 'completed') && !app.snapshot().busy), 'parent and child completion');
    if (providerError) throw providerError;
    const job = app.snapshot().subagents[0];
    assert.equal(job.parentSessionId, first.sessionId); assert.equal(job.workspaceId, first.workspaceId);
    assert.equal(job.status, 'completed'); assert.equal(job.result, 'Synthetic child result.');
    assert.equal(mainCalls, 2); assert.equal(childCalls, 1);
    assert.deepEqual(JSON.parse(await fs.readFile(proofFile, 'utf8')), scope, 'The child must not load the parent proof extension or inherit its socket');
    response = await socketRequest(scope.socketPath, { action: 'status', nativeSessionId: scope.nativeSessionId, id: job.id });
    assert.equal(response.value.data.id, job.id);
    await post('sessions', { workspaceId: first.workspaceId });
    const other = JSON.parse(await fs.readFile(proofFile, 'utf8'));
    assert.notEqual(other.nativeSessionId, scope.nativeSessionId);
    for (const action of ['status', 'cancel']) {
      response = await socketRequest(other.socketPath, { action, nativeSessionId: other.nativeSessionId, id: job.id });
      assert.equal(response.status, 404); assert.equal(response.value.ok, false, 'Another parent cannot read or cancel a job by guessing its ID');
    }
    response = await socketRequest(other.socketPath, { action: 'list', nativeSessionId: other.nativeSessionId });
    assert.deepEqual(response.value.data, []);
    assert.equal(await fs.readFile(join(workspace, 'Fixture.md'), 'utf8'), '# Fixture\nA temporary note.\n');
  } finally {
    await app?.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
