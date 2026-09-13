import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWebServer } from '../web/server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'pi-workspace-sessions-'));
const workspaceA = join(root, 'project-a'), workspaceB = join(root, 'project-b');
const deletedWorkspace = join(root, 'deleted-project'), addedWorkspace = join(root, 'added-project');
const vault = join(root, 'vault'), agent = join(root, 'agent'), cliRoot = join(root, 'cli-sessions');
const dataDir = join(root, 'data'), webSessions = join(dataDir, 'sessions'), cwdProof = join(root, 'cwd-proof.json');
const timestamp = '2026-01-01T00:00:00.000Z';
const hash = content => createHash('sha256').update(content).digest('hex');
const jsonl = entries => entries.map(entry => JSON.stringify(entry)).join('\n');
const user = text => ({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.parse(timestamp) });
const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'mock', model: 'workspace-test',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'stop', timestamp: Date.parse(timestamp) });
const message = (id, parentId, value) => ({ type: 'message', id, parentId, timestamp, message: value });
function conversation(cwd, title, { branches = false, id = '01900000-0000-7000-8000-000000000001' } = {}) {
  const entries = [{ type: 'session', version: 3, id, cwd, timestamp },
    message('root-user', null, user(`${title} root question`)), message('root-answer', 'root-user', assistant(`${title} root answer`))];
  if (branches) entries.push(message('abandoned-user', 'root-answer', user('Abandoned branch question')),
    message('abandoned-answer', 'abandoned-user', assistant('Abandoned branch answer')),
    message('active-user', 'root-answer', user('Selected branch question')),
    message('active-answer', 'active-user', assistant('Selected branch answer')));
  entries.push({ type: 'session_info', id: 'name', parentId: branches ? 'active-answer' : 'root-answer', timestamp, name: title });
  return entries;
}

let app, base, modelCalls = 0;
const model = createServer((_req, res) => {
  modelCalls++;
  res.writeHead(500, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'This integration test must never call a model.' } }));
});
const originalHashes = new Map();
async function fixture(file, entries, finalLF = true) {
  await mkdir(dirname(file), { recursive: true });
  const content = jsonl(entries) + (finalLF ? '\n' : '');
  await writeFile(file, content);
  originalHashes.set(file, hash(content));
  return file;
}
async function assertOriginalsUnchanged() {
  for (const [file, before] of originalHashes) assert.equal(hash(await readFile(file)), before, `CLI source changed: ${file}`);
}
const options = { dataDir, workspace: workspaceA, sessionRoots: [cliRoot], piArgs: ['--no-context-files', '--no-skills'],
  env: { PATH: process.env.PATH, HOME: root, LANG: 'C.UTF-8', PI_CODING_AGENT_DIR: agent, PI_STUDY_VAULT: vault, PI_WORKSPACE_TEST_CWD_FILE: cwdProof },
  publicOrigin: '', tailscaleUser: '' };
async function launch(piBin = join(root, 'no-such-pi-executable')) {
  app = await createWebServer({ ...options, piBin });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
}
async function close() { if (app) { await app.close(); app = undefined; } }
async function call(path, body, status = 200) {
  const response = await fetch(`${base}/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { Origin: base, 'Content-Type': 'application/json', 'X-Pi-Web': '1' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  assert.equal(response.status, status, `${path}: ${JSON.stringify(result)}`);
  return result;
}
async function assertNativeCwd(expected) {
  const proof = JSON.parse(await readFile(cwdProof, 'utf8'));
  assert.deepEqual(proof, { processCwd: expected, contextCwd: expected }, 'Both the real Pi process and its extension context must use the selected Workspace');
}
const transcript = state => state.messages.map(message => `${message.role}: ${message.text}`);
const findSession = (state, title) => {
  const matches = state.sessions.filter(session => session.title === title);
  assert.equal(matches.length, 1, `Expected one session named ${title}`);
  return matches[0];
};

try {
  await Promise.all([workspaceA, workspaceB, deletedWorkspace, addedWorkspace, vault, agent, cliRoot, webSessions].map(path => mkdir(path, { recursive: true })));
  await rm(deletedWorkspace, { recursive: true });
  await writeFile(join(vault, 'Fixture.md'), '# Fixture\nA synthetic study note.\n');
  const cliA = await fixture(join(cliRoot, '--misleading-workspace-b--', 'branch.jsonl'), conversation(workspaceA, 'CLI branch A', { branches: true }), false);
  const cliB = await fixture(join(cliRoot, '--misleading-workspace-a--', 'other.jsonl'), conversation(workspaceB, 'CLI B', { id: '01900000-0000-7000-8000-000000000002' }));
  await fixture(join(cliRoot, 'deleted.jsonl'), conversation(deletedWorkspace, 'CLI deleted'));
  await fixture(join(cliRoot, 'unknown-cwd.jsonl'), conversation(undefined, 'CLI unknown cwd'));
  await fixture(join(cliRoot, 'ledger.jsonl'), [{ observationId: 'synthetic-observation', timestamp }]);
  await fixture(join(cliRoot, 'sol-pi', 'ledger.jsonl'), [{ observationId: 'nested-observation', timestamp }]);
  await fixture(join(cliRoot, 'node_modules', 'ignored.jsonl'), conversation(workspaceA, 'Ignored package fixture'));
  const managedFile = await fixture(join(webSessions, 'managed.jsonl'), conversation(workspaceB, 'Managed Web history'));
  const managedId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', draftId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await writeFile(join(dataDir, 'sessions.json'), JSON.stringify({ version: 2, activeId: null, workspaceId: null, workspacePaths: [], sessions: [
    { id: managedId, file: managedFile, cwd: workspaceB, title: 'Managed Web history', createdAt: timestamp, updatedAt: timestamp },
    { id: draftId, file: join(webSessions, 'missing-draft.jsonl'), cwd: workspaceB, title: 'Existing Web draft', createdAt: timestamp, updatedAt: timestamp,
      draft: true, draftState: { mode: 'study', focus: { mode: 'auto' } } },
  ] }));

  await launch();
  let state = await call('state');
  assert.equal(state.sessions.length, 6, 'Four CLI records, one saved Web record and one unsaved Web draft are listed once');
  assert.equal(state.libraryIssueCount, 0, 'Missing cwd is readable history; observation ledgers are not sessions');
  assert.equal(state.workspaces.length, 4);
  const workspaceByPath = new Map(state.workspaces.map(workspace => [workspace.path, workspace]));
  const wsA = workspaceByPath.get(workspaceA), wsB = workspaceByPath.get(workspaceB), wsDeleted = workspaceByPath.get(deletedWorkspace), wsUnknown = workspaceByPath.get(null);
  assert.ok(wsA.available && wsB.available); assert.equal(wsDeleted.available, false);
  assert.equal(wsA.sessionCount, 1); assert.equal(wsB.sessionCount, 3); assert.equal(wsDeleted.sessionCount, 1);
  assert.equal(wsUnknown.available, false); assert.equal(wsUnknown.sessionCount, 1); assert.equal(wsUnknown.name, '未分類');
  assert.equal(state.workspaceId, wsA.id); assert.equal(state.sessionId, null);
  const localA = findSession(state, 'CLI branch A'), localB = findSession(state, 'CLI B'), localDeleted = findSession(state, 'CLI deleted'), localUnknown = findSession(state, 'CLI unknown cwd');
  assert.equal(localA.workspaceId, wsA.id, 'Grouping comes from header.cwd, not the encoded directory name');
  assert.equal(localB.workspaceId, wsB.id);
  for (const session of [localA, localB, localDeleted, localUnknown]) {
    assert.equal(session.origin, 'local');
    assert.match(session.id, /^local-[0-9a-f]{32}$/);
    assert.ok(!('file' in session) && !('cwd' in session), 'Catalog exposes opaque handles rather than source filenames');
  }
  assert.equal(findSession(state, 'Managed Web history').id, managedId);
  assert.equal(findSession(state, 'Managed Web history').origin, 'web');
  assert.equal(findSession(state, 'Existing Web draft').origin, 'web');
  assert.ok(!JSON.stringify(state.sessions).includes('Selected branch answer'), 'Listing metadata does not include transcript bodies');
  const catalogIds = state.sessions.map(session => session.id).sort();
  state = await call('refresh', {});
  assert.deepEqual(state.sessions.map(session => session.id).sort(), catalogIds, 'Refresh retains opaque IDs');

  state = await call('open', { id: localA.id });
  assert.equal(state.readOnly, true); assert.equal(state.canContinue, true); assert.equal(state.online, false);
  assert.equal(state.error, '', 'Read-only open works even though piBin does not exist');
  const selectedTranscript = ['user: CLI branch A root question', 'assistant: CLI branch A root answer', 'user: Selected branch question', 'assistant: Selected branch answer'];
  assert.deepEqual(transcript(state), selectedTranscript, 'Only the active native Pi branch is displayed');
  for (const [route, body] of [['prompt', { message: 'Must not be sent' }], ['mode', { mode: 'study' }], ['note', { path: 'auto' }]]) {
    await call(route, { sessionId: localA.id, ...body }, 409);
  }
  state = await call('state'); assert.deepEqual(transcript(state), selectedTranscript); assert.equal(state.readOnly, true);
  await assertOriginalsUnchanged();
  await close(); await launch();
  state = await call('state');
  assert.equal(state.sessionId, localA.id); assert.equal(state.workspaceId, wsA.id); assert.equal(state.readOnly, true); assert.equal(state.error, '');
  assert.deepEqual(transcript(state), selectedTranscript, 'Restart restores local history without spawning Pi');
  assert.deepEqual(state.sessions.map(session => session.id).sort(), catalogIds, 'IDs survive server restart');

  state = await call('open', { id: localB.id });
  const beforeAppend = await readFile(cliB, 'utf8'), beforeAppendTranscript = transcript(state);
  try {
    await writeFile(cliB, `${beforeAppend}${JSON.stringify(message('live-update', 'name', user('A new message from the local CLI')))}\n`);
    const staleContinuation = await call('continue', { sessionId: localB.id }, 500);
    assert.match(staleContinuation.error, /已更新/, 'Continuation rejects source content that has not yet been displayed');
    state = await call('state');
    assert.equal(state.sessionId, localB.id); assert.equal(state.readOnly, true); assert.equal(state.sessions.length, 6);
    assert.deepEqual(transcript(state), beforeAppendTranscript, 'A stale continuation creates no Web Session and preserves the current read-only view');
    state = await call('refresh', {});
    assert.equal(state.sessionId, localB.id); assert.equal(state.workspaceId, wsB.id); assert.equal(state.readOnly, true); assert.equal(state.online, false);
    assert.equal(state.sessions.find(session => session.id === localB.id).messageCount, 3);
    assert.deepEqual(transcript(state), [...beforeAppendTranscript, 'user: A new message from the local CLI'], 'Refreshing an active CLI file updates the displayed branch as well as catalog metadata');
  } finally { await writeFile(cliB, beforeAppend); }
  state = await call('refresh', {});
  assert.deepEqual(transcript(state), beforeAppendTranscript, 'Replacing a local source also replaces the displayed branch');
  await assertOriginalsUnchanged();

  state = await call('open', { id: localA.id });
  const revisionBeforeFailedOpen = state.revision, movedManaged = `${managedFile}.moved`;
  await rename(managedFile, movedManaged);
  try {
    await call('open', { id: managedId }, 500);
    state = await call('state');
    assert.equal(state.sessionId, managedId); assert.equal(state.workspaceId, wsB.id);
    assert.equal(state.online, false); assert.equal(state.readOnly, false); assert.deepEqual(state.messages, []);
    assert.ok(state.error, 'A failed Web open exposes a recoverable error in the authoritative snapshot');
    assert.ok(state.revision > revisionBeforeFailedOpen, 'A failed Web open broadcasts the changed active Session instead of leaving other clients on the previous Session');
    assert.equal(JSON.parse(await readFile(join(dataDir, 'sessions.json'), 'utf8')).activeId, managedId, 'Failed-open selection is persisted so the same Session can be retried');
  } finally { await rename(movedManaged, managedFile); }
  state = await call('open', { id: localA.id });
  assert.equal(state.error, ''); assert.deepEqual(transcript(state), selectedTranscript, 'Opening another local Session recovers cleanly after a Web open failure');
  await assertOriginalsUnchanged();

  state = await call('open', { id: localDeleted.id });
  assert.equal(state.readOnly, true); assert.equal(state.canContinue, false); assert.equal(state.workspaceId, wsDeleted.id);
  assert.ok(state.messages.some(message => message.text === 'CLI deleted root answer'), 'Deleted cwd does not hide readable history');
  await call('continue', { sessionId: localDeleted.id }, 400);
  await call('sessions', { workspaceId: wsDeleted.id }, 400);
  state = await call('open', { id: localUnknown.id });
  assert.equal(state.readOnly, true); assert.equal(state.canContinue, false); assert.equal(state.workspaceId, wsUnknown.id);
  assert.ok(state.messages.some(message => message.text === 'CLI unknown cwd root answer'), 'Unknown cwd remains readable without falling back to a real directory');
  await call('continue', { sessionId: localUnknown.id }, 400);
  await call('sessions', { workspaceId: wsUnknown.id }, 400);
  state = await call('workspace', { workspaceId: wsB.id });
  assert.equal(state.sessionId, null); assert.equal(state.workspaceId, wsB.id); assert.deepEqual(state.messages, []); assert.equal(state.online, false);
  await close(); await launch();
  state = await call('state'); assert.equal(state.workspaceId, wsB.id); assert.equal(state.sessionId, null);
  state = await call('workspaces', { path: addedWorkspace });
  const wsAdded = state.workspaces.find(workspace => workspace.path === addedWorkspace);
  assert.ok(wsAdded?.available); assert.equal(wsAdded.sessionCount, 0); assert.equal(state.workspaceId, wsAdded.id); assert.equal(state.sessionId, null);
  await close(); await launch();
  state = await call('state'); assert.equal(state.workspaceId, wsAdded.id); assert.ok(state.workspaces.some(workspace => workspace.path === addedWorkspace));
  assert.equal(state.sessions.length, 6, 'Selecting or adding a Workspace creates no conversation');
  await assertOriginalsUnchanged();
  await close();
  console.log('Workspace catalog and local history: classification, branch display, stable IDs, missing cwd, read-only guards and selection persistence pass without a Pi executable');

  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const pkg = process.env.PI_WEB_TEST_PACKAGE || resolve(here, '..');
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ packages: [pkg], defaultProvider: 'mock', defaultModel: 'workspace-test' }));
  await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: { mock: {
    baseUrl: `http://127.0.0.1:${model.address().port}/v1`, api: 'openai-completions', apiKey: 'test-placeholder',
    models: [{ id: 'workspace-test', reasoning: false, input: ['text'], contextWindow: 64000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  await mkdir(join(agent, 'extensions'));
  await writeFile(join(agent, 'extensions', 'cwd-proof.ts'), `import { writeFileSync } from 'node:fs';\nexport default function(pi) { pi.on('session_start', (_event, ctx) => { writeFileSync(process.env.PI_WORKSPACE_TEST_CWD_FILE, JSON.stringify({ processCwd: process.cwd(), contextCwd: ctx.cwd })); }); }\n`);

  await launch('pi');
  state = await call('open', { id: draftId });
  assert.equal(state.readOnly, false); assert.equal(state.online, true); assert.equal(state.mode, 'study'); assert.equal(state.workspaceId, wsB.id);
  await assertNativeCwd(workspaceB);
  state = await call('sessions', { workspaceId: wsA.id });
  const freshA = state.sessionId;
  assert.equal(state.mode, 'general'); assert.equal(state.readOnly, false); assert.equal(state.workspaceId, wsA.id);
  await assertNativeCwd(workspaceA);
  await call('mode', { sessionId: freshA, mode: 'research' });
  state = await call('sessions', { workspaceId: wsB.id });
  const freshB = state.sessionId;
  assert.notEqual(freshB, freshA); assert.equal(state.mode, 'general'); assert.equal(state.workspaceId, wsB.id);
  await assertNativeCwd(workspaceB);
  await call('open', { id: freshA });
  await close(); await launch('pi');
  state = await call('state'); assert.equal(state.sessionId, freshA); assert.equal(state.mode, 'research'); assert.equal(state.workspaceId, wsA.id);
  await assertNativeCwd(workspaceA);
  assert.ok(state.sessions.some(session => session.id === freshB && session.workspaceId === wsB.id), 'History in another Workspace survives restart');

  state = await call('open', { id: localA.id }); assert.equal(state.readOnly, true); assert.equal(state.online, false);
  state = await call('continue', { sessionId: localA.id });
  const continuationId = state.sessionId;
  assert.notEqual(continuationId, localA.id); assert.equal(state.readOnly, false); assert.equal(state.origin, 'web'); assert.equal(state.online, true);
  assert.equal(state.workspaceId, wsA.id); assert.equal(state.sessions.find(session => session.id === continuationId).parentId, localA.id);
  assert.deepEqual(transcript(state), selectedTranscript, 'Native fork preserves the selected branch');
  await assertNativeCwd(workspaceA);
  await assertOriginalsUnchanged();
  assert.equal((await readFile(cliA, 'utf8')).endsWith('\n'), false, 'Native --fork must never append a newline to the original CLI source');
  const imported = (await readdir(join(dataDir, 'imports'))).filter(name => name.endsWith('.jsonl'));
  assert.equal(imported.length, 1);
  const importedFile = join(dataDir, 'imports', imported[0]);
  assert.equal(await readFile(importedFile, 'utf8'), `${await readFile(cliA, 'utf8')}\n`, 'Continuation gives native Pi a private normalized capture');
  const manifest = JSON.parse(await readFile(join(dataDir, 'sessions.json'), 'utf8'));
  const continued = manifest.sessions.find(session => session.id === continuationId);
  assert.ok(continued.file.startsWith(`${webSessions}/`)); assert.notEqual(continued.file, cliA);
  const nativeHeader = JSON.parse((await readFile(continued.file, 'utf8')).split('\n')[0]);
  assert.equal(nativeHeader.cwd, workspaceA);
  await call('mode', { sessionId: continuationId, mode: 'study' });
  await close(); await launch('pi');
  state = await call('state'); assert.equal(state.sessionId, continuationId); assert.equal(state.readOnly, false); assert.equal(state.mode, 'study');
  assert.deepEqual(transcript(state), selectedTranscript, 'Editable continuation history survives restart');
  assert.equal(state.sessions.filter(session => session.id === localA.id).length, 1, 'Original remains separately available after continuation');
  assert.equal(state.sessions.filter(session => session.id === continuationId).length, 1, 'Saved Web file is not duplicated as a local session');
  await call('open', { id: localA.id });
  await assertOriginalsUnchanged();

  state = await call('open', { id: localB.id });
  assert.equal(state.readOnly, true); assert.equal(state.workspaceId, wsB.id); assert.ok(state.messages.length > 0);
  const movedCLI = `${cliB}.moved`;
  await rename(cliB, movedCLI);
  try {
    state = await call('refresh', {});
    assert.equal(state.sessionId, null, 'Removing the active local file clears its stale selection');
    assert.deepEqual(state.messages, [], 'Removing the active local file clears its displayed transcript');
    assert.equal(state.readOnly, false); assert.equal(state.canContinue, false); assert.equal(state.origin, null);
    assert.equal(state.online, false); assert.equal(state.model, '');
    assert.equal(state.workspaceId, wsB.id, 'Refresh retains the original non-default Workspace');
    assert.ok(!state.sessions.some(session => session.id === localB.id));
    state = await call('sessions', { workspaceId: wsB.id });
    assert.ok(state.sessionId); assert.notEqual(state.sessionId, localB.id);
    assert.equal(state.readOnly, false); assert.equal(state.online, true); assert.equal(state.workspaceId, wsB.id);
    assert.deepEqual(state.messages, []);
    await assertNativeCwd(workspaceB);
  } finally { await rename(movedCLI, cliB); }
  state = await call('refresh', {});
  assert.equal(findSession(state, 'CLI B').id, localB.id, 'Restoring the fixture restores the same opaque ID');
  await assertOriginalsUnchanged();
  assert.equal(await readFile(join(vault, 'Fixture.md'), 'utf8'), '# Fixture\nA synthetic study note.\n');
  assert.equal(modelCalls, 0, 'Creating, opening, changing Mode, restoring and forking sessions must never call a model');
  console.log('Real Pi Workspace sessions: process cwd, Web drafts, native fork captures, restart history and moved local session recovery pass with 0 model requests');
} finally {
  await close();
  if (model.listening) { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); }
  await rm(root, { recursive: true, force: true });
}
