import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSubagentManager } from '../web/subagents.mjs';

const exec = promisify(execFile);
const until = async (condition, message = 'Timed out waiting for fixture state') => {
  const limit = Date.now() + 5000;
  while (!condition()) { if (Date.now() > limit) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 5)); }
};
function rpcFactory(custom = {}) {
  const instances = [];
  const createRpc = async options => {
    const rpc = { options, requests: [], closed: false,
      emit(event) { options.onEvent(event); },
      async request(type, payload, timeout) {
        this.requests.push({ type, payload, timeout });
        if (custom.request) return custom.request.call(this, type, payload, timeout);
        if (type === 'prompt') this.emit({ type: 'agent_start' });
        return {};
      },
      send(value) { this.requests.push({ type: 'send', payload: value }); },
      close() { this.closed = true; options.onExit(new Error('Fixture process closed')); },
    };
    instances.push(rpc);
    if (custom.create) await custom.create(rpc);
    return rpc;
  };
  return { instances, createRpc };
}
async function setup(t, options = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'pi-subagents-test-'));
  const dataDir = join(root, 'data'), cwd = join(root, 'workspace'); await fs.mkdir(cwd);
  const factory = options.factory || rpcFactory();
  const manager = await createSubagentManager({ dataDir, createRpc: factory.createRpc, env: { PATH: process.env.PATH, HOME: root }, ...options.manager });
  t.after(async () => { await manager.close(); await fs.rm(root, { recursive: true, force: true }); });
  const input = { workspaceId: 'ws-fixture', cwd, parentSessionId: 'parent-fixture', task: 'Review the temporary files.', kind: 'read', model: { provider: 'fixture', id: 'fixture-model' } };
  return { root, dataDir, cwd, factory, manager, input, start: patch => manager.start({ ...input, ...patch }) };
}
const answer = (rpc, text = 'Fixture completed.', reason = 'stop', errorMessage) => rpc.emit({ type: 'message_end', message: {
  role: 'assistant', content: [{ type: 'text', text }], stopReason: reason, errorMessage } });
const settle = rpc => { answer(rpc); rpc.emit({ type: 'agent_settled' }); };

test('read jobs select tools and model before one prompt, disable recursion and wait for agent_settled', async t => {
  const s = await setup(t, { manager: { piArgs: ['fixture.mjs'], env: { PATH: process.env.PATH, PI_WEB_SUBAGENT_SOCKET: '/private/socket', PRIVATE_KEY: 'not-for-the-browser' } } });
  const created = await s.start({ context: '', thinkingLevel: 'low', model: { provider: 'fixture', id: 'fixture-model', headers: { Authorization: 'PRIVATE_HEADER' } } });
  await until(() => s.factory.instances[0]?.requests.some(r => r.type === 'prompt'));
  const rpc = s.factory.instances[0], args = rpc.options.args;
  assert.equal(args[0], 'fixture.mjs'); assert.ok(args.includes('--no-extensions'));
  assert.equal(args[args.indexOf('--tools') + 1], 'read,grep,find,ls');
  assert.ok(!args.includes('--no-skills') && !args.includes('--no-context-files'));
  assert.equal(rpc.options.cwd, s.cwd); assert.ok(!('PI_WEB_SUBAGENT_SOCKET' in rpc.options.env));
  assert.deepEqual(rpc.requests.map(r => r.type), ['set_auto_retry', 'set_model', 'set_thinking_level', 'prompt']);
  assert.deepEqual(rpc.requests[0].payload, { enabled: false });
  assert.deepEqual(rpc.requests[1].payload, { provider: 'fixture', modelId: 'fixture-model' });
  assert.match(rpc.requests[3].payload.message, /不是作業系統沙箱/);
  rpc.emit({ type: 'tool_execution_start', toolName: 'read', args: { path: 'PRIVATE_TOOL_ARGUMENT' } });
  assert.equal(s.manager.get(created.id).progress, '正在使用 read');
  assert.ok(!JSON.stringify(s.manager.get(created.id)).includes('PRIVATE_TOOL_ARGUMENT'));
  rpc.emit({ type: 'tool_execution_end', toolName: 'read', isError: false, result: { content: 'PRIVATE_TOOL_RESULT' } });
  assert.equal(s.manager.get(created.id).progress, 'read 已完成');
  assert.ok(!JSON.stringify(s.manager.get(created.id)).includes('PRIVATE_TOOL_RESULT'));
  rpc.emit({ type: 'agent_end' }); assert.equal(s.manager.get(created.id).status, 'running');
  answer(rpc, 'An intermediate assistant answer.'); assert.equal(s.manager.get(created.id).status, 'running');
  rpc.emit({ type: 'agent_settled' });
  assert.equal(s.manager.get(created.id).status, 'completed'); assert.equal(rpc.closed, true);
  const publicState = s.manager.get(created.id);
  assert.equal(publicState.result, 'An intermediate assistant answer.');
  assert.deepEqual(publicState.model, { provider: 'fixture', id: 'fixture-model' });
  assert.ok(!('cwd' in publicState) && !('env' in publicState));
  assert.ok(!JSON.stringify(s.manager.snapshot()).includes('PRIVATE_HEADER'));
  publicState.model.id = 'mutated'; assert.equal(s.manager.get(created.id).model.id, 'fixture-model');
  assert.equal(s.manager.list({ parentSessionId: 'another' }).length, 0);
  assert.equal(s.manager.list({ workspaceId: 'ws-fixture' }).length, 1);
  await s.manager.cancel(created.id); assert.equal(s.manager.get(created.id).status, 'completed');
});

test('three active jobs, twenty queued jobs and cancellation release capacity without dispatching cancelled work', async t => {
  const s = await setup(t), jobs = [];
  for (let i = 0; i < 23; i++) jobs.push(await s.start({ task: `Fixture task ${i}` }));
  await until(() => s.factory.instances.length === 3);
  assert.equal(s.manager.snapshot().filter(job => job.status === 'running').length, 3);
  assert.equal(s.manager.snapshot().filter(job => job.status === 'queued').length, 20);
  await assert.rejects(s.start(), error => error.status === 429);
  await s.manager.cancel(jobs[3].id);
  assert.equal(s.manager.get(jobs[3].id).status, 'cancelled'); assert.equal(s.factory.instances.length, 3);
  await until(() => s.factory.instances[0].requests.some(r => r.type === 'prompt'));
  settle(s.factory.instances[0]); await until(() => s.factory.instances.length === 4);
  assert.equal(s.manager.get(jobs[4].id).status, 'running');
  await s.manager.cancel(jobs[1].id); assert.equal(s.factory.instances[1].closed, true);
  await s.manager.close();
  assert.ok(s.factory.instances.every(rpc => rpc.closed));
  assert.ok(s.manager.snapshot().every(job => ['completed', 'cancelled', 'interrupted'].includes(job.status)));
  await assert.rejects(s.start(), error => error.status === 503);
});

test('a provider error is failed once, preserves a redacted error and cannot become completed later', async t => {
  const s = await setup(t), job = await s.start();
  await until(() => s.factory.instances[0]?.requests.some(r => r.type === 'prompt'));
  const rpc = s.factory.instances[0];
  answer(rpc, '', 'error', '403 blocked; Authorization: Bearer abcdefghij; api_key=secret-fixture');
  rpc.emit({ type: 'agent_settled' });
  const result = s.manager.get(job.id);
  assert.equal(result.status, 'failed'); assert.match(result.error, /403 blocked/);
  assert.ok(!result.error.includes('abcdefghij') && !result.error.includes('secret-fixture'));
  assert.equal(rpc.requests.filter(r => r.type === 'prompt').length, 1); assert.equal(s.factory.instances.length, 1);
});

test('model aborts, child exits and interactive requests fail rather than waiting or retrying', async t => {
  const s = await setup(t);
  for (const kind of ['aborted', 'exit', 'ui', 'extension']) {
    const job = await s.start();
    await until(() => s.factory.instances.at(-1)?.requests.some(r => r.type === 'prompt') && !s.factory.instances.at(-1).closed);
    const rpc = s.factory.instances.at(-1);
    if (kind === 'aborted') answer(rpc, '', 'aborted');
    else if (kind === 'exit') rpc.options.onExit(new Error('Fixture provider exited'));
    else if (kind === 'extension') rpc.emit({ type: 'extension_error', error: 'Fixture extension error' });
    else rpc.emit({ type: 'extension_ui_request', id: 'ui-fixture', method: 'confirm', title: 'Need confirmation' });
    assert.equal(s.manager.get(job.id).status, 'failed'); assert.equal(rpc.closed, true);
    if (kind === 'ui') {
      assert.match(s.manager.get(job.id).error, /需要互動/);
      assert.deepEqual(rpc.requests.at(-1), { type: 'send', payload: { type: 'extension_ui_response', id: 'ui-fixture', cancelled: true } });
    }
  }
});

test('both a matching prompt acknowledgement and a started, settled agent run are required', async t => {
  let acceptPrompt;
  const factory = rpcFactory({ request(type) {
    if (type === 'prompt') { this.emit({ type: 'agent_start' }); answer(this, 'Finished before acknowledgement.'); this.emit({ type: 'agent_settled' }); return new Promise(resolve => { acceptPrompt = resolve; }); }
    this.emit({ type: 'agent_settled' }); return {};
  } });
  const s = await setup(t, { factory }), job = await s.start();
  await until(() => acceptPrompt);
  assert.equal(s.manager.get(job.id).status, 'running');
  acceptPrompt({}); await until(() => s.manager.get(job.id).status === 'completed');
});

test('output and elapsed-time limits stop the child and preserve bounded diagnostic results', async t => {
  const s = await setup(t), job = await s.start();
  await until(() => s.factory.instances[0]?.requests.some(r => r.type === 'prompt'));
  answer(s.factory.instances[0], 'x'.repeat(60001));
  const result = s.manager.get(job.id);
  assert.equal(result.status, 'failed'); assert.equal(result.truncated, true);
  assert.equal(result.output.length, 60000); assert.equal(result.result.length, 60000);
  assert.equal(s.factory.instances[0].closed, true);
  const timed = await setup(t, { manager: { timeoutMs: 60 } }), timedJob = await timed.start();
  await until(() => timed.manager.get(timedJob.id).status === 'failed');
  assert.match(timed.manager.get(timedJob.id).error, /時間上限/);
  assert.ok(timed.factory.instances.every(rpc => rpc.closed));
});

test('empty assistant turns are bounded even when they do not reach the text limit', async t => {
  const s = await setup(t), job = await s.start();
  await until(() => s.factory.instances[0]?.requests.some(r => r.type === 'prompt'));
  for (let index = 0; index < 101; index++) answer(s.factory.instances[0], '');
  assert.equal(s.manager.get(job.id).status, 'failed');
  assert.match(s.manager.get(job.id).error, /回合上限/);
  assert.equal(s.factory.instances[0].closed, true);
});

test('code jobs fork committed HEAD into a preserved worktree and leave dirty source files untouched', async t => {
  const s = await setup(t);
  const git = async args => (await exec('git', ['-C', s.cwd, ...args], { env: { ...process.env,
    GIT_AUTHOR_NAME: 'Fixture User', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture User', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } })).stdout.trim();
  await git(['init', '-b', 'main']); await fs.writeFile(join(s.cwd, 'tracked.txt'), 'Committed fixture\n');
  await git(['add', 'tracked.txt']); await git(['commit', '-m', 'Synthetic fixture']); const head = await git(['rev-parse', 'HEAD']);
  await fs.writeFile(join(s.cwd, 'tracked.txt'), 'Uncommitted user fixture\n');
  await fs.writeFile(join(s.cwd, 'untracked.txt'), 'Untracked user fixture\n');
  const job = await s.start({ kind: 'code' });
  await until(() => s.factory.instances[0]?.requests.some(r => r.type === 'prompt'));
  const rpc = s.factory.instances[0], current = s.manager.get(job.id);
  assert.equal(current.sourceHead, head); assert.equal(current.branch, `pi/subagent/${job.id}`);
  assert.equal(rpc.options.cwd, current.worktree);
  assert.equal(await fs.readFile(join(current.worktree, 'tracked.txt'), 'utf8'), 'Committed fixture\n');
  await assert.rejects(fs.stat(join(current.worktree, 'untracked.txt')), error => error.code === 'ENOENT');
  await fs.writeFile(join(current.worktree, 'tracked.txt'), 'Sub Agent change\n');
  await s.manager.cancel(job.id);
  assert.equal(await fs.readFile(join(s.cwd, 'tracked.txt'), 'utf8'), 'Uncommitted user fixture\n');
  assert.equal(await fs.readFile(join(s.cwd, 'untracked.txt'), 'utf8'), 'Untracked user fixture\n');
  assert.equal(await git(['branch', '--show-current']), 'main'); assert.equal(await git(['rev-parse', 'HEAD']), head);
  assert.equal(await fs.readFile(join(current.worktree, 'tracked.txt'), 'utf8'), 'Sub Agent change\n');
  assert.ok((await git(['worktree', 'list', '--porcelain'])).includes(current.worktree));
  assert.equal(rpc.options.env.GIT_AUTHOR_NAME, undefined);
});

test('code jobs reject non-Git workspaces and repositories without commits before creating a child', async t => {
  const s = await setup(t);
  await assert.rejects(s.start({ kind: 'code' }), error => error.status === 400);
  await exec('git', ['-C', s.cwd, 'init']);
  await assert.rejects(s.start({ kind: 'code' }), error => error.status === 400);
  assert.equal(s.factory.instances.length, 0); assert.deepEqual(s.manager.snapshot(), []);
});

test('atomic private persistence retains results and marks unfinished jobs interrupted without replay', async t => {
  const s = await setup(t, { manager: { maxConcurrent: 1 } });
  const complete = await s.start();
  await until(() => s.factory.instances[0]?.requests.some(r => r.type === 'prompt'));
  settle(s.factory.instances[0]);
  const running = await s.start(), queued = await s.start();
  await until(() => s.factory.instances[1]?.requests.some(r => r.type === 'prompt'));
  const index = join(s.dataDir, 'subagents', 'jobs.json');
  await until(() => s.manager.get(running.id).status === 'running');
  // Capture what was durable while the child was still active, then simulate a crash on disk.
  let crashed;
  for (let i = 0; i < 100; i++) {
    crashed = await fs.readFile(index, 'utf8');
    if (JSON.parse(crashed).jobs.find(job => job.id === running.id)?.status === 'running' && JSON.parse(crashed).jobs.some(job => job.id === queued.id)) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(JSON.parse(crashed).jobs.find(job => job.id === queued.id).status, 'queued');
  assert.equal((await fs.stat(index)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(join(s.dataDir, 'subagents'))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(join(s.dataDir, 'subagents', 'sessions', running.id))).mode & 0o777, 0o700);
  await s.manager.close(); await fs.writeFile(index, crashed, { mode: 0o600 });
  const restoredFactory = rpcFactory();
  const restored = await createSubagentManager({ dataDir: s.dataDir, createRpc: restoredFactory.createRpc });
  try {
    assert.equal(restored.get(complete.id).status, 'completed'); assert.equal(restored.get(complete.id).result, 'Fixture completed.');
    assert.equal(restored.get(running.id).status, 'interrupted'); assert.equal(restored.get(queued.id).status, 'interrupted');
    assert.equal(restoredFactory.instances.length, 0); assert.match(restored.get(running.id).error, /未自動重送/);
    assert.ok(!(await fs.readdir(join(s.dataDir, 'subagents'))).some(name => name.endsWith('.tmp')));
  } finally { await restored.close(); }
});

test('startup failures and cancellation during asynchronous creation close late children', async t => {
  let release;
  const factory = rpcFactory({ create() { return new Promise(resolve => { release = resolve; }); } });
  const s = await setup(t, { factory }), job = await s.start();
  await until(() => release); await s.manager.cancel(job.id); release();
  await until(() => factory.instances[0].closed);
  assert.equal(factory.instances[0].requests.length, 0); assert.equal(s.manager.get(job.id).status, 'cancelled');
  const rejected = await setup(t, { factory: rpcFactory({ request(type) { if (type === 'set_model') throw new Error('Model unavailable'); return {}; } }) });
  const failed = await rejected.start(); await until(() => rejected.manager.get(failed.id).status === 'failed');
  assert.equal(rejected.factory.instances[0].closed, true);
  assert.equal(rejected.factory.instances[0].requests.filter(request => request.type === 'prompt').length, 0);
});

test('storage symlinks and explicit extension flags are rejected without reading their targets', async t => {
  const s = await setup(t); await s.manager.close();
  const outside = join(s.root, 'outside.json'); await fs.writeFile(outside, 'PRIVATE_TARGET');
  await fs.symlink(outside, join(s.dataDir, 'subagents', 'jobs.json'));
  await assert.rejects(createSubagentManager({ dataDir: s.dataDir, createRpc: s.factory.createRpc }));
  assert.equal(await fs.readFile(outside, 'utf8'), 'PRIVATE_TARGET');
  await assert.rejects(createSubagentManager({ dataDir: join(s.root, 'invalid'), createRpc: s.factory.createRpc, piArgs: ['--extension', 'bridge.ts'] }), /cannot explicitly enable extensions/);
  await assert.rejects(createSubagentManager({ dataDir: join(s.root, 'invalid'), createRpc: s.factory.createRpc, piArgs: ['--session', 'parent.jsonl'] }), /reuse sessions/);
  await assert.rejects(createSubagentManager({ dataDir: join(s.root, 'invalid'), createRpc: s.factory.createRpc, maxConcurrent: 4 }), /between 1 and 3/);
});

test('real Pi reads a fixture with exactly the allowed tools, no extensions and the selected model', async t => {
  const { PiRpc } = await import('../web/server.mjs');
  const root = await fs.mkdtemp(join(tmpdir(), 'pi-subagents-real-'));
  const cwd = join(root, 'workspace'), agent = join(root, 'agent'), dataDir = join(root, 'data'), marker = join(root, 'extension-loaded');
  await fs.mkdir(cwd); await fs.mkdir(join(agent, 'extensions'), { recursive: true });
  await fs.mkdir(join(agent, 'skills', 'fixture-skill'), { recursive: true });
  await fs.writeFile(join(cwd, 'Fixture.md'), '# Fixture\nREAL_PI_READ_FIXTURE\n');
  await fs.writeFile(join(cwd, 'AGENTS.md'), '# Workspace instructions\nREAL_PI_CONTEXT_FIXTURE\n');
  await fs.writeFile(join(agent, 'skills', 'fixture-skill', 'SKILL.md'), '---\nname: fixture-skill\ndescription: REAL_PI_SKILL_FIXTURE\n---\nOnly a synthetic skill.\n');
  await fs.writeFile(join(agent, 'extensions', 'forbidden.ts'), `import { writeFileSync } from 'node:fs';\nexport default function() { writeFileSync(${JSON.stringify(marker)}, 'loaded'); }\n`);
  let manager, providerError;
  const requests = [], progress = [];
  const provider = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); requests.push(body);
      assert.equal(body.model, 'selected-fixture-model'); assert.equal(body.stream, true);
      assert.deepEqual(body.tools.map(tool => tool.function.name).sort(), ['find', 'grep', 'ls', 'read']);
      assert.match(JSON.stringify(body.messages), /REAL_PI_CONTEXT_FIXTURE/);
      assert.match(JSON.stringify(body.messages), /REAL_PI_SKILL_FIXTURE/);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'subagent-fixture', object: 'chat.completion.chunk', created: 1,
        model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (requests.length === 1) {
        emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'Fixture.md' }) } }] });
        emit({}, 'tool_calls');
      } else {
        assert.equal(requests.length, 2, 'The local fake provider should need only the tool round and final answer');
        assert.ok(body.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('REAL_PI_READ_FIXTURE')));
        emit({ role: 'assistant', content: 'The fixture was read successfully.' }); emit({}, 'stop');
      }
      response.end('data: [DONE]\n\n');
    } catch (error) { providerError = error; if (!response.headersSent) response.writeHead(500); response.end(JSON.stringify({ error: { message: error.message } })); }
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  try {
    const model = id => ({ id, reasoning: false, input: ['text'], contextWindow: 64000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    await fs.writeFile(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'other-fixture-model', retry: { enabled: false } }));
    await fs.writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions',
      apiKey: 'local-test-placeholder', models: [model('other-fixture-model'), model('selected-fixture-model')] } } }));
    manager = await createSubagentManager({ dataDir, createRpc: options => new PiRpc(options), env: { PATH: process.env.PATH, HOME: root, LANG: 'C.UTF-8', PI_CODING_AGENT_DIR: agent },
      timeoutMs: 15000, onChange: jobs => progress.push(...jobs.map(job => job.progress)) });
    const job = await manager.start({ workspaceId: 'real-fixture', parentSessionId: 'parent-fixture', cwd, task: 'Read Fixture.md and report whether the marker is present.',
      kind: 'read', model: { provider: 'fixture', id: 'selected-fixture-model' } });
    await until(() => providerError || ['completed', 'failed'].includes(manager.get(job.id).status), 'Real Pi read job did not finish');
    if (providerError) throw providerError;
    const finished = manager.get(job.id);
    assert.equal(finished.status, 'completed', JSON.stringify(finished));
    assert.equal(finished.result, 'The fixture was read successfully.'); assert.equal(requests.length, 2);
    assert.ok(progress.some(value => value === '正在使用 read')); assert.ok(progress.some(value => value === 'read 已完成'));
    await assert.rejects(fs.stat(marker), error => error.code === 'ENOENT');
    assert.equal(await fs.readFile(join(cwd, 'Fixture.md'), 'utf8'), '# Fixture\nREAL_PI_READ_FIXTURE\n');
    const sessionFiles = await fs.readdir(join(dataDir, 'subagents', 'sessions', job.id));
    assert.equal(sessionFiles.filter(file => file.endsWith('.jsonl')).length, 1, 'The child persists into its own session directory');
  } finally {
    await manager?.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
