import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebServer } from '../web/server.mjs';

const fixture = String.raw`
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
let file = option('--session'), id = JSON.parse(readFileSync(file, 'utf8').split('\n')[0]).id;
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const audit = value => appendFileSync(process.env.RACE_AUDIT, JSON.stringify(value) + '\n');
const reply = (request, data) => emit({ type: 'response', command: request.type, id: request.id, success: true, data });
const custom = (customType, value) => emit({ type: 'message_end', message: { role: 'custom', customType, content: JSON.stringify(value) } });
let firstRead = true, heldState = false;
async function handle(request) {
  audit({ type: request.type });
  if (request.type === 'get_messages') {
    if (firstRead) {
      firstRead = false; audit({ type: 'open-held' });
      while (!existsSync(process.env.RACE_RELEASE)) await new Promise(resolve => setTimeout(resolve, 5));
    }
    reply(request, { messages: [] });
  } else if (request.type === 'get_state') {
    const state = { sessionId: id, sessionFile: file,
      model: { provider: 'fixture', id: 'race', name: 'Race fixture' }, thinkingLevel: 'off', isStreaming: false, isCompacting: false };
    if (!heldState && process.env.RACE_STATE_HOLD && existsSync(process.env.RACE_STATE_HOLD)) {
      heldState = true; audit({ type: 'state-held' });
      while (!existsSync(process.env.RACE_STATE_RELEASE)) await new Promise(resolve => setTimeout(resolve, 5));
    }
    reply(request, state);
  }
  else if (request.type === 'get_commands') reply(request, { commands: ['mode', 'study', 'study-status', 'study-notes'].map(name => ({ name, source: 'extension' })) });
  else if (request.type === 'prompt') {
    if (request.message.startsWith('/mode ')) { custom('pi-mode-state', { mode: 'general' }); reply(request); }
    else if (request.message === '/study-status') { custom('pi-study-state', { focus: { mode: 'auto' }, current: null }); reply(request); }
    else throw Error('No model prompt is allowed');
  } else if (request.type === 'clone') {
    const source = file; file = join(option('--session-dir'), randomUUID() + '.jsonl'); id = randomUUID();
    writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id, cwd: process.cwd(), timestamp: new Date().toISOString(), parentSessionPath: source }) + '\n');
    reply(request, { cancelled: false });
  } else reply(request);
}
for await (const line of createInterface({ input: process.stdin })) void handle(JSON.parse(line));
`;

const until = async (condition, label) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error(`Timed out: ${label}`);
};

test('A delete queued behind open cannot await a later clone that itself waits for deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-management-race-'));
  const workspace = join(root, 'workspace'), dataDir = join(root, 'data'), sessions = join(dataDir, 'sessions');
  const release = join(root, 'release'), auditFile = join(root, 'audit.jsonl'), fixtureFile = join(root, 'rpc.mjs');
  const parentId = randomUUID(), file = join(sessions, 'parent.jsonl'), timestamp = new Date().toISOString();
  let app;
  try {
    await mkdir(workspace); await mkdir(sessions, { recursive: true }); await writeFile(fixtureFile, fixture);
    await writeFile(file, JSON.stringify({ type: 'session', version: 3, id: randomUUID(), cwd: workspace, timestamp }) + '\n');
    await writeFile(join(dataDir, 'sessions.json'), JSON.stringify({ version: 3, sessions: [{ id: parentId, file, cwd: workspace, title: 'Parent', createdAt: timestamp, updatedAt: timestamp }],
      activeId: null, workspaceId: null, workspacePaths: [], sessionPreferences: {} }));
    app = await createWebServer({ dataDir, workspace, sessionRoots: [], piBin: process.execPath, piArgs: [fixtureFile],
      env: { PATH: process.env.PATH, HOME: root, RACE_AUDIT: auditFile, RACE_RELEASE: release }, publicOrigin: '', tailscaleUser: '' });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const call = async (path, body) => {
      try {
        const response = await fetch(`${base}/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
          headers: body === undefined ? {} : { Origin: base, 'Content-Type': 'application/json', 'X-Pi-Web': '1' },
          body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000) });
        return { status: response.status, result: await response.json() };
      } catch (error) { return { error: error.name }; }
    };
    // Observe the request body's end after the server's parser, so requests are
    // admitted in order without assuming a fixed localhost delivery delay.
    const admitted = path => new Promise(resolve => {
      const observe = request => {
        if (request.url !== `/api/${path}`) return;
        app.server.off('request', observe);
        request.on('end', () => setImmediate(resolve));
      };
      app.server.on('request', observe);
    });
    const workspaceId = (await call('state')).result.workspaceId;
    const opening = call('open', { id: parentId });
    await until(async () => { try { return (await readFile(auditFile, 'utf8')).includes('open-held'); } catch { return false; } }, 'open held before startup is complete');
    const deleteAdmitted = admitted('session/delete');
    const deleting = call('session/delete', { id: parentId, workspaceId }); await deleteAdmitted;
    const cloneAdmitted = admitted('clone');
    const cloning = call('clone', { sessionId: parentId }); await cloneAdmitted;
    await writeFile(release, 'finish startup');
    assert.equal((await opening).status, 200);
    const removed = await deleting;
    assert.equal(removed.status, 409, `Deletion should release navigation when a later target operation has been admitted; got ${JSON.stringify(removed)}`);
    const cloned = await cloning;
    assert.equal(cloned.status, 200, `Clone must proceed after deletion rejects: ${JSON.stringify(cloned)}`);
    assert.notEqual(cloned.result.state.sessionId, parentId);
    assert.equal(cloned.result.state.sessions.find(session => session.id === cloned.result.state.sessionId).parentId, parentId);
    assert.ok(cloned.result.state.sessions.some(session => session.id === parentId));
    const returned = await call('workspace', { workspaceId });
    assert.equal(returned.status, 200, 'Later navigation remains usable');
    assert.equal(returned.result.sessionId, null);
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
});

test('A subagent admission waiting for state stays bound to its original parent across clone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-management-admission-race-'));
  const workspace = join(root, 'workspace'), dataDir = join(root, 'data'), sessions = join(dataDir, 'sessions');
  const release = join(root, 'release'), auditFile = join(root, 'audit.jsonl'), fixtureFile = join(root, 'rpc.mjs');
  const stateHold = join(root, 'state-hold'), stateRelease = join(root, 'state-release');
  const parentId = randomUUID(), file = join(sessions, 'parent.jsonl'), timestamp = new Date().toISOString();
  let app;
  try {
    await mkdir(workspace); await mkdir(sessions, { recursive: true }); await writeFile(fixtureFile, fixture); await writeFile(release, 'open normally');
    await writeFile(file, JSON.stringify({ type: 'session', version: 3, id: randomUUID(), cwd: workspace, timestamp }) + '\n');
    await writeFile(join(dataDir, 'sessions.json'), JSON.stringify({ version: 3, sessions: [{ id: parentId, file, cwd: workspace, title: 'Original parent', createdAt: timestamp, updatedAt: timestamp }],
      activeId: null, workspaceId: null, workspacePaths: [], sessionPreferences: {} }));
    app = await createWebServer({ dataDir, workspace, sessionRoots: [], piBin: process.execPath, piArgs: [fixtureFile], subagentPiArgs: [fixtureFile],
      env: { PATH: process.env.PATH, HOME: root, RACE_AUDIT: auditFile, RACE_RELEASE: release, RACE_STATE_HOLD: stateHold, RACE_STATE_RELEASE: stateRelease }, publicOrigin: '', tailscaleUser: '' });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const call = async (path, body) => {
      try {
        const response = await fetch(`${base}/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
          headers: body === undefined ? {} : { Origin: base, 'Content-Type': 'application/json', 'X-Pi-Web': '1' },
          body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000) });
        return { status: response.status, result: await response.json() };
      } catch (error) { return { error: error.name }; }
    };
    const opened = await call('open', { id: parentId }); assert.equal(opened.status, 200);
    const workspaceId = opened.result.workspaceId;
    await writeFile(stateHold, 'hold the admission state response');
    const starting = call('subagents', { sessionId: parentId, task: 'Synthetic ownership test', kind: 'read' });
    await until(async () => (await readFile(auditFile, 'utf8')).includes('state-held'), 'subagent admission state held');
    const cloned = await call('clone', { sessionId: parentId }); assert.equal(cloned.status, 200);
    const cloneId = cloned.result.state.sessionId; assert.notEqual(cloneId, parentId);
    assert.match(cloned.result.state.sessions.find(session => session.id === parentId).deleteBlockedReason, /Sub Agent/,
      'Pending admission remains associated with the original ID after its runtime moves to the clone');
    assert.equal((await call('session/delete', { id: parentId, workspaceId })).status, 409);
    await writeFile(stateRelease, 'release the obsolete original state');
    const started = await starting;
    assert.equal(started.status, 409, `An ownership change must reject admission instead of reparenting it: ${JSON.stringify(started)}`);
    const state = (await call('state')).result;
    assert.equal(state.sessionId, cloneId); assert.deepEqual(state.subagents, [], 'No job or child process is created for a stale admission');
    assert.equal(state.sessions.find(session => session.id === parentId).deleteBlockedReason, '', 'The immutable-parent admission counter is released after rejection');
    const deleted = await call('session/delete', { id: parentId, workspaceId });
    assert.equal(deleted.status, 200); assert.equal(deleted.result.state.sessionId, cloneId);
  } finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
});
