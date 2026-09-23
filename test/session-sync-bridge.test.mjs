import './isolate.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extension from '../extensions/session-sync/index.mjs';
import { canonicalSessionFile, createSessionSyncBridge, socketPathForSession, socketRoot, StaleSessionSocketError } from '../extensions/session-sync/bridge.mjs';
import { fire, makeApi, makeCtx } from './harness.mjs';

const temporary = mkdtempSync(join(tmpdir(), 'zen-pi-session-sync-test-'));
const originalRuntime = process.env.XDG_RUNTIME_DIR;
const runtimeDir = join(temporary, 'r');
mkdirSync(runtimeDir, { mode: 0o700 });
process.env.XDG_RUNTIME_DIR = runtimeDir;
const sessionFile = join(temporary, 'example.jsonl');
writeFileSync(sessionFile, '{"type":"session","id":"fixture"}\n', { mode: 0o600 });

function connect(path) {
  return new Promise((resolve, reject) => {
    const peer = createConnection(path);
    let incoming = '';
    const frames = [];
    const waiters = [];
    peer.on('data', chunk => {
      incoming += chunk.toString('utf8');
      let at;
      while ((at = incoming.indexOf('\n')) !== -1) {
        const frame = JSON.parse(incoming.slice(0, at));
        incoming = incoming.slice(at + 1);
        const next = waiters.shift();
        if (next) next(frame);
        else frames.push(frame);
      }
    });
    peer.once('error', reject);
    peer.once('connect', () => resolve({
      send: value => peer.write(JSON.stringify(value) + '\n'),
      raw: value => peer.write(value),
      next: () => new Promise(done => frames.length ? done(frames.shift()) : waiters.push(done)),
      close: () => peer.destroy(),
    }));
  });
}

function fixture() {
  const api = makeApi();
  extension(api);
  let shutdown = false;
  let aborted = false;
  const ctx = makeCtx({
    model: { provider: 'fake', id: 'fixture' },
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => 'fixture',
      getLeafId: () => 'leaf-1',
    },
    shutdown: () => { shutdown = true; },
    abort: () => { aborted = true; },
  });
  return { api, ctx, didShutdown: () => shutdown, didAbort: () => aborted };
}

try {
  assert.equal(canonicalSessionFile(join(temporary, 'new.jsonl')), join(temporary, 'new.jsonl'));
  assert.equal(socketPathForSession(sessionFile), socketPathForSession(join(temporary, '.', 'example.jsonl')));
  const owner = fixture();
  await fire(owner.api, 'session_start', { type: 'session_start', reason: 'startup' }, owner.ctx);
  const socket = socketPathForSession(sessionFile);
  assert.equal(lstatSync(socket).mode & 0o777, 0o600);
  assert.equal(lstatSync(join(socket, '..')).mode & 0o777, 0o700);
  const web = await connect(socket);
  const hello = await web.next();
  assert.equal(hello.type, 'hello');
  assert.equal(hello.owner, 'native');
  assert.equal(hello.sessionFile, sessionFile);
  assert.equal(hello.sessionId, 'fixture');
  assert.equal(hello.leafId, 'leaf-1');
  assert.equal(hello.busy, false);

  web.send({ id: 'one', type: 'prompt', text: 'Hello from Web' });
  assert.deepEqual(await web.next(), { type: 'ack', id: 'one', status: 'queued' });
  assert.deepEqual(owner.api._sent.at(-1), { kind: 'user', content: 'Hello from Web', opts: { deliverAs: 'followUp' } });
  web.send({ id: 'one', type: 'prompt', text: 'Do not duplicate' });
  assert.equal((await web.next()).status, 'queued');
  assert.equal(owner.api._sent.length, 1);
  web.send({ id: 'stop', type: 'abort' });
  assert.equal((await web.next()).status, 'requested');
  assert.equal(owner.didAbort(), true);
  await fire(owner.api, 'message_start', { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'Hello from Web' }] } }, owner.ctx);
  assert.equal((await web.next()).event.type, 'message_start');
  const unicode = Buffer.from(JSON.stringify({ id: 'unicode', type: 'prompt', text: '中文訊息' }) + '\n');
  const split = unicode.indexOf(Buffer.from('中')) + 1;
  web.raw(unicode.subarray(0, split));
  web.raw(unicode.subarray(split));
  assert.equal((await web.next()).status, 'queued');
  assert.equal(owner.api._sent.at(-1).content, '中文訊息');
  web.send({ id: 'slash', type: 'prompt', text: '/resume' });
  assert.match((await web.next()).error, /slash commands/);

  const duplicate = fixture();
  await fire(duplicate.api, 'session_start', { type: 'session_start', reason: 'startup' }, duplicate.ctx);
  assert.equal((await fire(duplicate.api, 'input', { type: 'input', text: 'unsafe', source: 'interactive' }, duplicate.ctx)).action, 'handled');
  await new Promise(done => setImmediate(done));
  assert.equal(duplicate.didShutdown(), true);
  assert.match(duplicate.ctx._notices.at(-1).text, /已在另一個/);
  const competingRpc = fixture();
  competingRpc.ctx.mode = 'rpc';
  await fire(competingRpc.api, 'session_start', { type: 'session_start', reason: 'startup' }, competingRpc.ctx);
  await new Promise(done => setImmediate(done));
  assert.equal(competingRpc.didShutdown(), true);
  web.send({ id: 'two', type: 'prompt', text: 'Owner remains live' });
  assert.equal((await web.next()).status, 'queued');
  assert.equal(owner.api._sent.at(-1).content, 'Owner remains live');
  web.close();
  await fire(duplicate.api, 'session_shutdown', { type: 'session_shutdown', reason: 'quit' }, duplicate.ctx);
  await fire(competingRpc.api, 'session_shutdown', { type: 'session_shutdown', reason: 'quit' }, competingRpc.ctx);
  await fire(owner.api, 'session_shutdown', { type: 'session_shutdown', reason: 'quit' }, owner.ctx);
  assert.throws(() => lstatSync(socket), /ENOENT/);

  const rpc = fixture();
  rpc.ctx.mode = 'rpc';
  await fire(rpc.api, 'session_start', { type: 'session_start', reason: 'startup' }, rpc.ctx);
  assert.throws(() => lstatSync(socket), /ENOENT/);
  await fire(rpc.api, 'session_shutdown', { type: 'session_shutdown', reason: 'quit' }, rpc.ctx);

  const sentinel = await createSessionSyncBridge({ sessionFile, sessionId: 'fixture', owner: 'web' });
  const attached = await connect(sentinel.path);
  assert.equal((await attached.next()).owner, 'web');
  attached.send({ id: 'not-owner', type: 'prompt', text: 'Unsafe' });
  assert.match((await attached.next()).error, /owned by Web/);
  const nativeAgainstWeb = fixture();
  await fire(nativeAgainstWeb.api, 'session_start', { type: 'session_start', reason: 'startup' }, nativeAgainstWeb.ctx);
  await new Promise(done => setImmediate(done));
  assert.equal(nativeAgainstWeb.didShutdown(), true);
  attached.close();
  await fire(nativeAgainstWeb.api, 'session_shutdown', { type: 'session_shutdown', reason: 'quit' }, nativeAgainstWeb.ctx);
  await sentinel.close();

  const stale = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(socket)}, () => process.stdout.write('ready\\n'))`], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolveReady, rejectReady) => {
    stale.stdout.once('data', resolveReady);
    stale.once('error', rejectReady);
    stale.once('exit', code => rejectReady(new Error(`Stale socket fixture exited: ${code}`)));
  });
  stale.kill('SIGKILL');
  await once(stale, 'exit');
  assert.equal(lstatSync(socket).isSocket(), true);
  const contenders = await Promise.allSettled([1, 2].map(() =>
    createSessionSyncBridge({ sessionFile, sessionId: 'fixture', owner: 'web' })));
  assert(contenders.every(result => result.status === 'rejected' && result.reason instanceof StaleSessionSocketError && result.reason.message.includes(socket)));
  assert.equal(lstatSync(socket).isSocket(), true, 'A stale socket is never removed automatically');
  rmSync(socket);
  const reclaimed = await createSessionSyncBridge({ sessionFile, sessionId: 'fixture', owner: 'web' });
  await reclaimed.close();

  const safeRoot = socketRoot();
  rmSync(safeRoot, { recursive: true, force: true });
  const unsafeTarget = join(temporary, 'unsafe-target');
  mkdirSync(unsafeTarget, { mode: 0o700 });
  symlinkSync(unsafeTarget, safeRoot);
  const cannotLock = fixture();
  await fire(cannotLock.api, 'session_start', { type: 'session_start', reason: 'startup' }, cannotLock.ctx);
  await new Promise(done => setImmediate(done));
  assert.equal(cannotLock.didShutdown(), true);
  assert.match(cannotLock.ctx._notices.at(-1).text, /無法鎖定/);
  await fire(cannotLock.api, 'session_shutdown', { type: 'session_shutdown', reason: 'quit' }, cannotLock.ctx);
  rmSync(safeRoot);

  const external = join(temporary, 'external');
  mkdirSync(external, { mode: 0o700 });
  const badRoot = join(temporary, 'link');
  symlinkSync(external, badRoot);
  await assert.rejects(createSessionSyncBridge({ sessionFile, sessionId: 'fixture', getState: () => ({}), sendPrompt: () => {}, root: badRoot }), /Unsafe Session bridge directory/);
  chmodSync(external, 0o755);
  await assert.rejects(createSessionSyncBridge({ sessionFile, sessionId: 'fixture', getState: () => ({}), sendPrompt: () => {}, root: external }), /Unsafe Session bridge directory/);
} finally {
  if (originalRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = originalRuntime;
  rmSync(temporary, { recursive: true, force: true });
}

console.log('Session sync bridge: native/Web ownership, live events, prompt/abort forwarding, collision shutdown, stale fail-closed and socket permissions pass.');
