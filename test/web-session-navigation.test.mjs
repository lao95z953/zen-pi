import './isolate.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWebServer } from '../web/server.mjs';

const root = await mkdtemp(join(tmpdir(), 'pi-session-navigation-'));
const workspaceA = join(root, 'workspace-a'), workspaceB = join(root, 'workspace-b');
const dataDir = join(root, 'data'), controlsDir = join(root, 'controls'), auditFile = join(root, 'rpc-audit.jsonl');
const fixtureFile = join(root, 'navigation-rpc.mjs');
let app, base, eventsController, eventsPump, eventsError;
const frames = [];
const hash = value => createHash('sha256').update(value).digest('hex');
const transcript = state => state.messages.map(message => `${message.role}: ${message.text}`);
const stateOf = result => result.state || result;

// This fixture implements real JSONL persistence and independently running RPC
// processes. Test-controlled release files make background completion deterministic.
const fixture = String.raw`
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2), sessionDir = args[args.indexOf('--session-dir') + 1];
const argument = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
const timestamp = () => new Date().toISOString();
const parse = path => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let file, entries, busy = false, pending = null, mode = 'general', thinkingLevel = 'off';
const model = { provider: 'fixture', id: 'navigation', name: 'Navigation fixture', reasoning: false, contextWindow: 64000 };
const audit = value => appendFileSync(process.env.NAVIGATION_AUDIT, JSON.stringify({ pid: process.pid, file, cwd: process.cwd(), ...value }) + '\n');
const save = () => writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', { mode: 0o600 });
function create(entriesToCopy = [], parentSessionPath) {
  file = join(sessionDir, randomUUID() + '.jsonl');
  entries = [{ type: 'session', version: 3, id: randomUUID(), cwd: process.cwd(), timestamp: timestamp(), ...(parentSessionPath ? { parentSessionPath } : {}) }, ...structuredClone(entriesToCopy)];
  save();
}
if (argument('--session')) { file = argument('--session'); entries = parse(file); }
else if (argument('--fork')) { const source = argument('--fork'); create(parse(source).slice(1), source); }
else create();
const branch = () => {
  const byId = new Map(entries.slice(1).map(entry => [entry.id, entry])), path = [];
  let entry = entries.at(-1);
  while (entry && entry.type !== 'session') { path.push(entry); entry = byId.get(entry.parentId); }
  return path.reverse();
};
const messages = () => branch().filter(entry => entry.type === 'message').map(entry => entry.message);
const append = (type, value) => { entries.push({ type, id: randomUUID(), parentId: entries.length > 1 ? entries.at(-1).id : null, timestamp: timestamp(), ...value }); save(); };
const user = text => ({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() });
const assistant = (text, stopReason = 'stop') => ({ role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'fixture', model: 'navigation', stopReason, timestamp: Date.now(),
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const reply = (request, data) => emit({ type: 'response', command: request.type, id: request.id, success: true, data });
const custom = (customType, value) => emit({ type: 'message_end', message: { role: 'custom', customType, content: JSON.stringify(value) } });
function finish(aborted = false) {
  if (!pending) return;
  const label = pending.label, message = assistant((aborted ? 'Aborted:' : 'Finished:') + label, aborted ? 'aborted' : 'stop');
  pending = null; append('message', { message }); busy = false;
  emit({ type: 'message_end', message }); emit({ type: 'agent_settled' }); audit({ event: 'finished', label, aborted });
}
audit({ event: 'started' });
const timer = setInterval(() => {
  if (pending && existsSync(join(process.env.NAVIGATION_CONTROLS, pending.label + '.release'))) finish();
}, 20);
process.on('SIGTERM', () => { audit({ event: 'terminated', busy }); clearInterval(timer); process.exit(0); });
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line); audit({ event: 'request', type: request.type, message: request.message });
  if (request.type === 'get_state') reply(request, { sessionId: entries[0].id, sessionFile: file, sessionName: branch().filter(entry => entry.type === 'session_info').at(-1)?.name,
    model, thinkingLevel, isStreaming: busy, isCompacting: false, autoCompactionEnabled: true, messageCount: messages().length });
  else if (request.type === 'get_messages') reply(request, { messages: [...messages(), ...(pending ? [assistant('Partial:' + pending.label)] : [])] });
  else if (request.type === 'get_entries') reply(request, { entries: entries.slice(1), leafId: entries.length > 1 ? entries.at(-1).id : null });
  else if (request.type === 'get_commands') reply(request, { commands: ['mode', 'study', 'study-status', 'study-notes'].map(name => ({ name, source: 'extension' })) });
  else if (request.type === 'get_available_models') reply(request, { models: [model] });
  else if (request.type === 'get_available_thinking_levels') reply(request, { levels: ['off'] });
  else if (request.type === 'get_session_stats') { const all = messages(); reply(request, { userMessages: all.filter(message => message.role === 'user').length,
    assistantMessages: all.filter(message => message.role === 'assistant').length, totalMessages: all.length, toolCalls: 0, toolResults: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }); }
  else if (request.type === 'set_session_name') { append('session_info', { name: request.name }); reply(request); }
  else if (request.type === 'set_model') reply(request, model);
  else if (request.type === 'set_thinking_level') { thinkingLevel = request.level; reply(request); }
  else if (request.type === 'get_fork_messages') reply(request, { messages: branch().filter(entry => entry.type === 'message' && entry.message.role === 'user').map(entry => ({ entryId: entry.id, text: entry.message.content.map(block => block.text || '').join('\n') })) });
  else if (request.type === 'fork' || request.type === 'clone') {
    const source = file, path = branch(), index = path.findIndex(entry => entry.id === request.entryId);
    const text = request.type === 'fork' ? path[index]?.message?.content.map(block => block.text || '').join('\n') : '';
    if (request.type === 'fork' && index < 0) throw Error('Unknown fixture entry');
    create(request.type === 'clone' ? path : path.slice(0, index), source); reply(request, { cancelled: false, text });
  }
  else if (request.type === 'switch_session') { file = request.sessionPath; entries = parse(file); reply(request, { cancelled: false }); }
  else if (request.type === 'clear_queue') reply(request, { steering: [], followUp: [] });
  else if (request.type === 'abort') { finish(true); reply(request); }
  else if (request.type === 'prompt') {
    if (request.message.startsWith('/mode ')) { if (request.message !== '/mode status') mode = request.message.slice(6); custom('pi-mode-state', { mode }); reply(request); }
    else if (request.message === '/study-status') { custom('pi-study-state', { mode, focus: { mode: 'auto' }, current: null }); reply(request); }
    else {
      const label = request.message.split(':').slice(1).join(':');
      if (!label || !/^[a-z-]+$/.test(label)) throw Error('Unexpected fixture prompt');
      const message = user(request.message); append('message', { message }); emit({ type: 'message_end', message });
      busy = true; pending = { label }; emit({ type: 'agent_start' });
      emit({ type: 'message_start', message: assistant('') });
      emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Partial:' + label } });
      reply(request);
      if (!request.message.startsWith('hold:')) finish();
    }
  } else reply(request);
}
clearInterval(timer);
`;

async function launch() {
  app = await createWebServer({ dataDir, workspace: workspaceA, sessionRoots: [], piBin: process.execPath, piArgs: [fixtureFile],
    env: { PATH: process.env.PATH, HOME: root, LANG: 'C.UTF-8', NAVIGATION_AUDIT: auditFile, NAVIGATION_CONTROLS: controlsDir },
    publicOrigin: '', tailscaleUser: '' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
}
async function call(path, body, status = 200) {
  const response = await fetch(`${base}/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { Origin: base, 'Content-Type': 'application/json', 'X-Pi-Web': '1' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const result = await response.json(); assert.equal(response.status, status, `${path}: ${JSON.stringify(result)}`); return result;
}
async function until(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (eventsError) throw eventsError;
    const value = await predicate(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw Error(`Timed out: ${label}`);
}
async function manifestRecord(id) {
  return JSON.parse(await readFile(join(dataDir, 'sessions.json'), 'utf8')).sessions.find(session => session.id === id);
}
async function audit() { return (await readFile(auditFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }
async function connectEvents() {
  eventsController = new AbortController();
  const response = await fetch(`${base}/api/events`, { signal: eventsController.signal });
  const reader = response.body.getReader(), decoder = new TextDecoder();
  eventsPump = (async () => {
    let pending = '';
    while (true) {
      const { value, done } = await reader.read(); if (done) return;
      pending += decoder.decode(value, { stream: true }); let end;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, end); pending = pending.slice(end + 2);
        const type = frame.match(/^event: (.+)$/m)?.[1], data = frame.match(/^data: (.+)$/m)?.[1];
        if (type && data) frames.push({ type, data: JSON.parse(data) });
      }
    }
  })().catch(error => { if (error.name !== 'AbortError') eventsError = error; });
  await until(() => frames.some(frame => frame.type === 'snapshot'), 'initial SSE snapshot');
}

try {
  await Promise.all([workspaceA, workspaceB, controlsDir].map(path => mkdir(path)));
  await writeFile(fixtureFile, fixture);
  await launch(); await connectEvents();
  let state = await call('state'); const wsA = state.workspaceId;
  state = await call('workspaces', { path: workspaceB }); const wsB = state.workspaceId;
  await call('workspace', { workspaceId: wsA });
  state = await call('sessions', { workspaceId: wsA }); const idA = state.sessionId;
  await call('prompt', { sessionId: idA, message: 'hold:a' });
  state = await call('state'); assert.equal(state.busy, true);
  assert.ok(transcript(state).includes('assistant: Partial:a'));
  const originalA = await manifestRecord(idA);
  state = await call('sessions', { workspaceId: wsA }); const idB = state.sessionId;
  assert.notEqual(idB, idA); assert.equal(state.busy, false); assert.deepEqual(state.messages, []);
  assert.equal(state.sessions.find(session => session.id === idA).busy, true, 'A new conversation does not interrupt the background conversation');
  await call('prompt', { sessionId: idB, message: 'hold:b' });
  state = await call('state'); assert.equal(state.busy, true);
  state = await call('workspace', { workspaceId: wsB });
  assert.equal(state.workspaceId, wsB); assert.equal(state.sessionId, null); assert.deepEqual(state.messages, []);
  assert.equal(state.busy, false, 'Workspace navigation is independent of an active response');
  assert.equal(state.sessions.find(session => session.id === idA).busy, true); assert.equal(state.sessions.find(session => session.id === idB).busy, true);
  state = await call('sessions', { workspaceId: wsB }); const idC = state.sessionId;
  await call('prompt', { sessionId: idC, message: 'answer:c' });
  state = await until(async () => { const current = await call('state'); return !current.busy && current.messages.some(message => message.text === 'Finished:c') && current; }, 'C completion');
  const transcriptC = ['user: answer:c', 'assistant: Finished:c'];
  assert.deepEqual(transcript(state), transcriptC);
  await until(() => frames.some(frame => frame.type === 'snapshot' && frame.data.sessionId === idC && frame.data.messages?.some(message => message.text === 'Finished:c')), 'C authoritative SSE');
  const beforeBackground = frames.length;
  await writeFile(join(controlsDir, 'a.release'), 'release');
  state = await until(async () => { const current = await call('state'); return current.sessions.find(session => session.id === idA)?.busy === false && current; }, 'A completes in background');
  assert.equal(state.sessionId, idC); assert.equal(state.workspaceId, wsB); assert.deepEqual(transcript(state), transcriptC);
  assert.ok(!frames.slice(beforeBackground).some(frame => ['message', 'delta'].includes(frame.type) && JSON.stringify(frame.data).includes('Finished:a')), 'Background message events are not streamed into the selected conversation');
  const starts = (await audit()).filter(entry => entry.event === 'started');
  assert.equal(new Set(starts.map(entry => entry.pid)).size, 3, 'Three conversations keep independent RPC processes');
  assert.equal(starts.find(entry => entry.file === originalA.file).cwd, workspaceA);
  assert.ok(starts.some(entry => entry.cwd === workspaceB));
  assert.ok(!(await audit()).some(entry => entry.event === 'terminated' || entry.type === 'abort'), 'Navigation does not kill or abort a running conversation');
  state = await call('open', { id: idA });
  const transcriptA = ['user: hold:a', 'assistant: Finished:a'];
  assert.deepEqual(transcript(state), transcriptA); assert.equal(state.busy, false); assert.equal(state.workspaceId, wsA);

  state = await call('open', { id: idB }); assert.equal(state.busy, true);
  const originalB = await manifestRecord(idB), beforeSide = hash(await readFile(originalB.file));
  const side = await call('side-chat', { sessionId: idB, message: 'A question to finish in Side Chat' });
  state = stateOf(side); const sideId = state.sessionId;
  assert.equal(side.ok, true); assert.equal(side.restoredPrompt, 'A question to finish in Side Chat');
  assert.notEqual(sideId, idB); assert.equal(state.workspaceId, wsA); assert.equal(state.busy, false);
  assert.equal(state.sessions.find(session => session.id === sideId).parentId, idB); assert.equal(state.sessions.find(session => session.id === sideId).kind, 'side');
  assert.equal(state.sessions.find(session => session.id === idB).busy, true);
  assert.deepEqual(transcript(state), ['user: hold:b'], 'Side Chat captures saved history without copying an unfinished assistant response');
  assert.equal(hash(await readFile(originalB.file)), beforeSide, 'Creating a Side Chat never rewrites the parent file');
  assert.notEqual((await manifestRecord(sideId)).file, originalB.file);
  await call('prompt', { sessionId: sideId, message: 'answer:side' });
  state = await until(async () => { const current = await call('state'); return !current.busy && current.messages.some(message => message.text === 'Finished:side') && current; }, 'Side Chat completion');
  const sideTranscript = transcript(state);
  await writeFile(join(controlsDir, 'b.release'), 'release');
  state = await until(async () => { const current = await call('state'); return current.sessions.find(session => session.id === idB)?.busy === false && current; }, 'B completes behind Side Chat');
  assert.equal(state.sessionId, sideId); assert.deepEqual(transcript(state), sideTranscript);
  state = await call('open', { id: idB });
  assert.deepEqual(transcript(state), ['user: hold:b', 'assistant: Finished:b']);
  assert.equal((await manifestRecord(idB)).file, originalB.file, 'Parent metadata still points to its original conversation');

  await call('open', { id: idA });
  const beforeFork = hash(await readFile(originalA.file));
  const menu = await call('fork', { sessionId: idA });
  assert.equal(menu.command.type, 'forks');
  const forkTarget = menu.command.messages.find(message => message.text === 'hold:a'); assert.ok(forkTarget);
  const forked = await call('fork', { sessionId: idA, entryId: forkTarget.entryId });
  state = stateOf(forked); const forkId = state.sessionId;
  assert.equal(forked.ok, true); assert.equal(forked.restoredPrompt, 'hold:a'); assert.notEqual(forkId, idA);
  assert.equal(state.sessions.find(session => session.id === forkId).parentId, idA); assert.deepEqual(state.messages, []);
  assert.notEqual((await manifestRecord(forkId)).file, originalA.file);
  assert.equal((await manifestRecord(idA)).file, originalA.file); assert.equal(hash(await readFile(originalA.file)), beforeFork);
  await call('prompt', { sessionId: forkId, message: 'answer:fork' });
  await until(async () => (await call('state')).messages.some(message => message.text === 'Finished:fork'), 'Fork completion');
  assert.equal(hash(await readFile(originalA.file)), beforeFork, 'Messages sent to the fork do not overwrite the source history');
  state = await call('open', { id: idA }); assert.deepEqual(transcript(state), transcriptA);
  const cloned = await call('clone', { sessionId: idA });
  state = stateOf(cloned); const cloneId = state.sessionId;
  assert.equal(cloned.ok, true); assert.equal(cloned.restoredPrompt, ''); assert.notEqual(cloneId, idA);
  assert.equal(state.sessions.find(session => session.id === cloneId).parentId, idA); assert.deepEqual(transcript(state), transcriptA);
  assert.notEqual((await manifestRecord(cloneId)).file, originalA.file);
  assert.equal((await manifestRecord(idA)).file, originalA.file); assert.equal(hash(await readFile(originalA.file)), beforeFork);
  assert.ok((await audit()).filter(entry => entry.event === 'finished').every(entry => !entry.aborted));

  eventsController.abort(); await eventsPump; eventsController = null;
  await app.close(); app = undefined; await launch();
  state = await call('state'); assert.equal(state.sessionId, cloneId); assert.deepEqual(transcript(state), transcriptA);
  for (const [childId, parentId] of [[sideId, idB], [forkId, idA], [cloneId, idA]]) assert.equal(state.sessions.find(session => session.id === childId)?.parentId, parentId);
  assert.equal((await manifestRecord(idA)).file, originalA.file);
  assert.equal(hash(await readFile(originalA.file)), beforeFork);
  console.log('Session navigation: concurrent RPC processes, background SSE isolation, Workspace switching, saved-history Side Chat, fork/clone parent integrity and restart persistence passed without model access');
} finally {
  eventsController?.abort(); await eventsPump;
  // The fixture may still append its SIGTERM audit after the HTTP server closes.
  await app?.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
}
