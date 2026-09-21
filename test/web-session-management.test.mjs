import './isolate.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebServer } from '../web/server.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const timestamp = '2026-01-01T00:00:00.000Z';
const stateOf = value => value.state || value;
const until = async (condition, label) => {
  for (let attempt = 0; attempt < 1000; attempt++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Timed out: ${label}`);
};
const conversation = (cwd, title) => [{ type: 'session', version: 3, id: randomUUID(), cwd, timestamp },
  { type: 'message', id: 'user', parentId: null, timestamp, message: { role: 'user', content: `${title} question`, timestamp: 1 } },
  { type: 'message', id: 'assistant', parentId: 'user', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: `${title} answer` }], timestamp: 2, stopReason: 'stop' } },
  { type: 'session_info', id: 'name', parentId: 'assistant', timestamp, name: title }];
async function serverFixture(t, { fake = false } = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'pi-session-management-'));
  const workspaceA = join(root, 'workspace-a'), workspaceB = join(root, 'workspace-b'), dataDir = join(root, 'data'), cliRoot = join(root, 'cli');
  const sessions = join(dataDir, 'sessions'), controls = join(root, 'controls'), audit = join(root, 'audit.jsonl'), rpcFile = join(root, 'rpc.mjs');
  await Promise.all([workspaceA, workspaceB, sessions, cliRoot, controls].map(path => fs.mkdir(path, { recursive: true })));
  const options = { dataDir, workspace: workspaceA, sessionRoots: [cliRoot], piBin: fake ? process.execPath : join(root, 'missing-pi'),
    piArgs: fake ? [rpcFile] : [], subagentPiArgs: fake ? [rpcFile] : [],
    env: { PATH: process.env.PATH, HOME: root, MANAGEMENT_CONTROLS: controls, MANAGEMENT_AUDIT: audit }, publicOrigin: '', tailscaleUser: '' };
  if (fake) await fs.writeFile(rpcFile, fakeRpc);
  let app, base;
  const launch = async () => {
    app = await createWebServer(options); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.server.address().port}`;
  };
  const close = async () => { if (app) { await app.close(); app = undefined; } };
  t.after(async () => { await close(); await fs.rm(root, { recursive: true, force: true }); });
  const call = async (path, body, status = 200) => {
    const response = await fetch(`${base}/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { Origin: base, 'Content-Type': 'application/json', 'X-Pi-Web': '1' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const result = await response.json(); assert.equal(response.status, status, `${path}: ${JSON.stringify(result)}`); return result;
  };
  return { root, workspaceA, workspaceB, dataDir, cliRoot, sessions, controls, audit, launch, close, call, get app() { return app; } };
}

test('Web and local metadata aliases, soft deletion and restore persist without Pi or native file changes', async t => {
  const s = await serverFixture(t), originals = new Map();
  const save = async (file, title, cwd, trailingLF = true) => {
    const contents = conversation(cwd, title).map(item => JSON.stringify(item)).join('\n') + (trailingLF ? '\n' : '');
    await fs.writeFile(file, contents); originals.set(file, hash(contents)); return file;
  };
  const nativeA = await save(join(s.cliRoot, 'local-a.jsonl'), 'Local A', s.workspaceA, false);
  await save(join(s.cliRoot, 'local-b.jsonl'), 'Local B', s.workspaceB);
  const nativeId = `local-${hash(nativeA).slice(0, 32)}`;
  const parentId = randomUUID(), childId = randomUUID(), localChildId = randomUUID(), otherId = randomUUID();
  const records = [];
  for (const [id, title, cwd, parent] of [[parentId, 'Web parent', s.workspaceA], [childId, 'Web child', s.workspaceA, parentId],
    [localChildId, 'Local continuation', s.workspaceA, nativeId], [otherId, 'Other workspace', s.workspaceB]]) {
    const file = await save(join(s.sessions, `${id}.jsonl`), title, cwd);
    records.push({ id, file, cwd, title, parentId: parent, kind: parent ? 'fork' : 'chat', createdAt: timestamp, updatedAt: timestamp });
  }
  await fs.writeFile(join(s.dataDir, 'sessions.json'), JSON.stringify({ version: 2, activeId: null, workspaceId: null, workspacePaths: [], sessions: records }));
  const unchanged = async () => { for (const [file, before] of originals) assert.equal(hash(await fs.readFile(file)), before, `Metadata management changed native source: ${file}`); };
  await s.launch();
  let state = await s.call('state');
  const wsA = state.workspaces.find(workspace => workspace.path === s.workspaceA).id, wsB = state.workspaces.find(workspace => workspace.path === s.workspaceB).id;
  assert.equal(state.sessions.length, 6); assert.deepEqual(state.deletedSessions, []);
  assert.equal(state.sessions.find(session => session.title === 'Local A').id, nativeId);
  state = await s.call('open', { id: nativeId });
  const transcript = state.messages;
  assert.equal(state.readOnly, true); assert.equal(state.online, false);
  let result = await s.call('session/rename', { id: nativeId, workspaceId: wsA, title: '本機對話別名' });
  assert.equal(result.ok, true); state = result.state;
  assert.equal(state.sessionId, nativeId); assert.deepEqual(state.messages, transcript);
  assert.equal(state.sessions.find(session => session.id === nativeId).title, '本機對話別名');
  result = await s.call('session/rename', { id: parentId, workspaceId: wsA, title: 'Web metadata alias' });
  assert.equal(result.state.sessionId, nativeId, 'Renaming an explicit background ID keeps the current selection');
  assert.equal(result.state.sessions.find(session => session.id === parentId).title, 'Web metadata alias');
  await unchanged();
  state = stateOf(await s.call('refresh', {}));
  assert.equal(state.sessions.find(session => session.id === nativeId).title, '本機對話別名');
  assert.equal(state.sessions.find(session => session.id === parentId).title, 'Web metadata alias');

  for (const title of ['', ' ', 'x'.repeat(161), 'line\nbreak', 'line\rbreak', 'tab\tname', 'nul\0name', 'escape\u001bname', 'delete\u007fname',
    'next\u0085line', 'unicode\u2028line', 'unicode\u2029paragraph']) {
    await s.call('session/rename', { id: nativeId, workspaceId: wsA, title }, 400);
  }
  await s.call('session/rename', { id: nativeId, workspaceId: wsA, title: '名'.repeat(160) });
  await s.call('session/rename', { id: nativeId, workspaceId: wsA, title: '本機對話別名' });
  for (const action of ['rename', 'delete', 'restore']) {
    await s.call(`session/${action}`, { id: 'not-a-session-id', workspaceId: wsA, title: 'Alias' }, 400);
    await s.call(`session/${action}`, { id: randomUUID(), workspaceId: wsA, title: 'Alias' }, 404);
    if (action !== 'restore') {
      await s.call(`session/${action}`, { id: nativeId, workspaceId: wsB, title: 'Alias' }, 409);
      await s.call(`session/${action}`, { id: otherId, workspaceId: wsB, title: 'Alias' }, 409);
    }
  }
  result = await s.call('session/delete', { id: parentId, workspaceId: wsA }); state = result.state;
  assert.equal(result.ok, true); assert.equal(state.sessionId, nativeId); assert.equal(state.workspaceId, wsA);
  assert.ok(!state.sessions.some(session => session.id === parentId));
  assert.equal(state.sessions.find(session => session.id === childId).parentId, parentId, 'Deleting a parent preserves the child and its parent relationship');
  const deletedParent = state.deletedSessions.find(session => session.id === parentId);
  assert.equal(deletedParent.title, 'Web metadata alias'); assert.ok(Number.isFinite(Date.parse(deletedParent.deletedAt)));
  assert.ok(!('file' in deletedParent) && !('cwd' in deletedParent), 'Trash metadata does not expose source filenames');
  await s.call('session/restore', { id: parentId, workspaceId: wsB }, 409);
  await s.call('open', { id: parentId }, 404);
  state = stateOf(await s.call('refresh', {})); assert.ok(!state.sessions.some(session => session.id === parentId));
  await s.close(); await s.launch(); state = await s.call('state');
  assert.equal(state.sessionId, nativeId); assert.ok(!state.sessions.some(session => session.id === parentId));
  assert.equal(state.deletedSessions.find(session => session.id === parentId).title, 'Web metadata alias');
  await unchanged();
  state = (await s.call('session/restore', { id: parentId, workspaceId: wsA })).state;
  assert.equal(state.sessionId, nativeId); assert.equal(state.sessions.find(session => session.id === childId).parentId, parentId);
  assert.equal(state.sessions.find(session => session.id === parentId).title, 'Web metadata alias');
  assert.ok(!state.deletedSessions.some(session => session.id === parentId));

  state = (await s.call('session/delete', { id: nativeId, workspaceId: wsA })).state;
  assert.equal(state.sessionId, null); assert.equal(state.workspaceId, wsA); assert.deepEqual(state.messages, []);
  assert.equal(state.readOnly, false); assert.equal(state.online, false);
  assert.ok(!state.sessions.some(session => session.id === nativeId));
  assert.equal(state.sessions.find(session => session.id === localChildId).parentId, nativeId);
  await s.call('open', { id: nativeId }, 404);
  state = stateOf(await s.call('refresh', {})); assert.ok(!state.sessions.some(session => session.id === nativeId));
  await s.close(); await s.launch(); state = await s.call('state');
  assert.equal(state.sessionId, null); assert.equal(state.workspaceId, wsA);
  assert.ok(!state.sessions.some(session => session.id === nativeId));
  assert.equal(state.deletedSessions.find(session => session.id === nativeId).title, '本機對話別名');
  state = (await s.call('session/restore', { id: nativeId, workspaceId: wsA })).state;
  assert.equal(state.sessionId, null); assert.equal(state.sessions.find(session => session.id === nativeId).title, '本機對話別名');
  assert.equal(state.sessions.find(session => session.id === localChildId).parentId, nativeId);
  state = await s.call('open', { id: nativeId }); assert.deepEqual(state.messages.map(message => message.text), transcript.map(message => message.text));
  await unchanged(); assert.equal((await fs.readFile(nativeA, 'utf8')).endsWith('\n'), false);
});

test('more than 1000 managed records retain the oldest deleted Web ID and parent links across restarts', async t => {
  const s = await serverFixture(t), firstId = randomUUID(), records = [];
  for (let index = 0; index < 1001; index++) {
    const id = index === 0 ? firstId : randomUUID();
    records.push({ id, file: join(s.sessions, `${id}.jsonl`), cwd: s.workspaceA, title: `Metadata fixture ${index}`, parentId: index === 1 ? firstId : undefined,
      kind: index === 1 ? 'fork' : 'chat', draft: true, draftState: { mode: 'general', focus: { mode: 'auto' } }, createdAt: timestamp, updatedAt: timestamp });
  }
  await fs.writeFile(join(s.dataDir, 'sessions.json'), JSON.stringify({ version: 3, activeId: null, workspaceId: null, workspacePaths: [], sessions: records,
    sessionPreferences: { [firstId]: { title: 'Oldest deleted alias', deletedAt: timestamp } } }));
  for (let round = 0; round < 2; round++) {
    await s.launch();
    const state = await s.call('state');
    assert.equal(state.sessions.length, 1000); assert.equal(state.deletedSessions.length, 1);
    assert.equal(state.deletedSessions[0].id, firstId); assert.equal(state.deletedSessions[0].origin, 'web');
    assert.equal(state.deletedSessions[0].title, 'Oldest deleted alias');
    assert.equal(state.sessions.find(session => session.id === records[1].id).parentId, firstId);
    assert.equal(state.sessionId, null); assert.equal(state.online, false);
    const refreshed = stateOf(await s.call('refresh', {}));
    assert.ok(!refreshed.sessions.some(session => session.id === firstId));
    assert.equal(refreshed.deletedSessions[0].id, firstId);
    await s.close();
  }
  const saved = JSON.parse(await fs.readFile(join(s.dataDir, 'sessions.json'), 'utf8'));
  assert.equal(saved.sessions.length, 1001); assert.equal(saved.sessions[0].id, firstId);
});

const fakeRpc = String.raw`
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args=process.argv.slice(2), option=name=>args.includes(name)?args[args.indexOf(name)+1]:null;
const sessionDir=option('--session-dir'), child=args.includes('--no-extensions'), nativeId=randomUUID();
const file=option('--session') || join(sessionDir,nativeId+'.jsonl');
const controls=process.env.MANAGEMENT_CONTROLS, audit=value=>appendFileSync(process.env.MANAGEMENT_AUDIT,JSON.stringify({nativeId,file,child,...value})+'\n');
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n'), reply=(request,data)=>emit({type:'response',id:request.id,command:request.type,success:true,data});
let busy=false, mode='general';
if(!existsSync(file))writeFileSync(file,JSON.stringify({type:'session',version:3,id:nativeId,cwd:process.cwd(),timestamp:new Date().toISOString()})+'\n',{mode:0o600});
const model={provider:'fixture',id:'management',name:'Management fixture'};
const custom=(customType,value)=>emit({type:'message_end',message:{role:'custom',customType,content:JSON.stringify(value)}});
async function gate(name){audit({event:name});while(!existsSync(join(controls,name+'.release')))await new Promise(resolve=>setTimeout(resolve,5));}
async function handle(request){
  audit({event:'request',type:request.type,message:request.message});
  if(request.type==='get_state'){
    const delay=join(controls,'delay-state-'+nativeId);
    if(existsSync(delay)){unlinkSync(delay);await gate('state-'+nativeId);}
    reply(request,{sessionId:nativeId,sessionFile:file,model,thinkingLevel:'off',isStreaming:busy,isCompacting:false});
  }
  else if(request.type==='get_messages')reply(request,{messages:[]});
  else if(request.type==='get_commands')reply(request,{commands:['mode','study','study-status','study-notes'].map(name=>({name,source:'extension'}))});
  else if(request.type==='get_available_models')reply(request,{models:[model]});
  else if(request.type==='clear_queue')reply(request,{steering:[],followUp:[]});
  else if(request.type==='abort') {busy=false;emit({type:'agent_settled'});await gate('stop-'+nativeId);reply(request);}
  else if(request.type==='compact') {emit({type:'agent_settled'});await gate('compact-'+nativeId);reply(request,{summary:'Synthetic compaction result',tokensBefore:0,estimatedTokensAfter:0});}
  else if(request.type==='set_session_name') {if(existsSync(join(controls,'delay-name-'+nativeId)))await gate('name-'+nativeId);reply(request);}
  else if(request.type==='prompt'){
    if(request.message.startsWith('/mode ')){if(request.message!=='/mode status')mode=request.message.slice(6);custom('pi-mode-state',{mode});reply(request);}
    else if(request.message==='/study-status'){custom('pi-study-state',{focus:{mode:'auto'},status:'Fixture'});reply(request);}
    else {busy=true;emit({type:'agent_start'});reply(request);}
  } else reply(request,{});
}
audit({event:'started'});
process.on('SIGTERM',()=>{audit({event:'terminated'});process.exit(0);});
for await(const line of createInterface({input:process.stdin}))void handle(JSON.parse(line));
`;

test('deletion blocks only the targeted running conversation or its queued/running children; rename stays metadata-only', async t => {
  const s = await serverFixture(t, { fake: true }); await s.launch();
  const audit = async () => (await fs.readFile(s.audit, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const record = async id => JSON.parse(await fs.readFile(join(s.dataDir, 'sessions.json'), 'utf8')).sessions.find(record => record.id === id);
  let state = await s.call('sessions', {}); const firstId = state.sessionId, workspaceId = state.workspaceId;
  const firstFile = (await record(firstId)).file;
  state = await s.call('sessions', {}); const secondId = state.sessionId;
  await s.call('open', { id: firstId });
  await s.call('prompt', { sessionId: firstId, message: 'Hold this synthetic response.' });
  assert.equal((await s.call('state')).busy, true);
  const beforeRename = hash(await fs.readFile(firstFile));
  state = (await s.call('session/rename', { id: firstId, workspaceId, title: 'Renamed while running' })).state;
  assert.equal(state.sessions.find(session => session.id === firstId).title, 'Renamed while running');
  assert.equal(hash(await fs.readFile(firstFile)), beforeRename);
  assert.ok(!(await audit()).some(item => item.type === 'set_session_name'), 'Metadata aliases must not dispatch native rename commands');
  await s.call('session/delete', { id: firstId, workspaceId }, 409);
  state = await s.call('open', { id: secondId });
  await s.call('session/delete', { id: firstId, workspaceId }, 409);
  assert.equal((await s.call('state')).sessionId, secondId);
  // An unrelated idle conversation can still be deleted while another is busy.
  const idle = await s.call('sessions', {});
  state = (await s.call('session/delete', { id: secondId, workspaceId })).state;
  assert.equal(state.sessionId, idle.sessionId); assert.equal(state.sessions.find(session => session.id === firstId).busy, true);
  await s.call('session/restore', { id: secondId, workspaceId });
  await s.call('open', { id: firstId });
  const native = (await audit()).find(item => item.event === 'started' && item.file === firstFile).nativeId;
  const stop = s.call('stop', { sessionId: firstId });
  await until(async () => (await audit()).some(item => item.event === `stop-${native}`), 'delayed abort response');
  await until(async () => (await s.call('state')).busy === false, 'settled event while abort remains pending');
  await s.call('session/delete', { id: firstId, workspaceId }, 409);
  await fs.writeFile(join(s.controls, `stop-${native}.release`), 'release'); await stop;
  const compact = s.call('compact', { sessionId: firstId });
  await until(async () => (await audit()).some(item => item.event === `compact-${native}`), 'compaction operation');
  state = await s.call('state'); assert.equal(state.operation, 'compact');
  await s.call('session/delete', { id: firstId, workspaceId }, 409);
  await fs.writeFile(join(s.controls, `compact-${native}.release`), 'release'); await compact;

  const jobs = [];
  for (let index = 0; index < 4; index++) jobs.push((await s.call('subagents', { sessionId: firstId, kind: 'read', task: `Hold synthetic child ${index}` })).job);
  await until(async () => (await s.call('state')).subagents.filter(job => job.status === 'running').length === 3, 'three running children');
  state = await s.call('state'); assert.equal(state.subagents.filter(job => job.status === 'queued').length, 1);
  await s.call('open', { id: secondId });
  await s.call('session/delete', { id: firstId, workspaceId }, 409);
  // Put a queued child under a different idle parent to exercise the queued guard independently.
  const queuedOnly = (await s.call('subagents', { sessionId: secondId, kind: 'read', task: 'Queued child for the other parent' })).job;
  assert.equal(queuedOnly.status, 'queued');
  await s.call('session/delete', { id: secondId, workspaceId }, 409);
  await s.call('subagents/cancel', { id: queuedOnly.id, workspaceId });
  for (const job of jobs) await s.call('subagents/cancel', { id: job.id, workspaceId });
  state = (await s.call('session/delete', { id: firstId, workspaceId })).state;
  assert.equal(state.sessionId, secondId); assert.ok(!state.sessions.some(session => session.id === firstId));
  assert.ok(state.subagents.filter(job => job.parentSessionId === firstId).every(job => job.status === 'cancelled'), 'Completed cancellation permits soft deletion without deleting child results');
  state = (await s.call('session/restore', { id: firstId, workspaceId })).state;
  assert.equal(state.sessions.find(session => session.id === firstId).title, 'Renamed while running');
  assert.equal(hash(await fs.readFile(firstFile)), beforeRename);
  assert.ok(!(await audit()).some(item => item.type === 'set_session_name'));
});

test('pending Sub Agent admission blocks deleting its parent before any child exists', async t => {
  const s = await serverFixture(t, { fake: true }); await s.launch();
  const parent = await s.call('sessions', {}), { sessionId: id, workspaceId } = parent;
  const events = async () => (await fs.readFile(s.audit, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const native = (await events()).find(event => event.event === 'started' && !event.child).nativeId;
  await fs.writeFile(join(s.controls, `delay-state-${native}`), 'delay');
  const pending = s.call('subagents', { sessionId: id, kind: 'read', task: 'A synthetic child waiting for admission' });
  await until(async () => (await events()).some(event => event.event === `state-${native}`), 'admission waiting for parent model state');
  let state = await s.call('state');
  assert.deepEqual(state.subagents, [], 'The child has not reached jobs.set yet');
  assert.equal(state.busy, false, 'The parent model is idle during child admission');
  await s.call('session/delete', { id, workspaceId }, 409);
  assert.equal((await s.call('state')).sessionId, id);
  await fs.writeFile(join(s.controls, `state-${native}.release`), 'release');
  const admitted = await pending;
  assert.equal(admitted.job.parentSessionId, id);
  await s.call('subagents/cancel', { id: admitted.job.id, workspaceId });
  state = (await s.call('session/delete', { id, workspaceId })).state;
  assert.equal(state.sessionId, null); assert.ok(state.deletedSessions.some(session => session.id === id));
});

test('a delayed slash name reply cannot replace a later metadata rename', async t => {
  const s = await serverFixture(t, { fake: true }); await s.launch();
  const parent = await s.call('sessions', {}), { sessionId: id, workspaceId } = parent;
  const events = async () => (await fs.readFile(s.audit, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const native = (await events()).find(event => event.event === 'started' && !event.child).nativeId;
  await fs.writeFile(join(s.controls, `delay-name-${native}`), 'delay');
  const older = s.call('prompt', { sessionId: id, message: '/name Earlier slash name' });
  await until(async () => (await events()).some(event => event.event === `name-${native}`), 'delayed native name response');
  let state = (await s.call('session/rename', { id, workspaceId, title: 'Latest metadata name' })).state;
  assert.equal(state.sessions.find(session => session.id === id).title, 'Latest metadata name');
  await fs.writeFile(join(s.controls, `name-${native}.release`), 'release'); await older;
  state = await s.call('state');
  assert.equal(state.sessions.find(session => session.id === id).title, 'Latest metadata name', 'The later row rename remains authoritative after the earlier RPC reply');
  const saved = JSON.parse(await fs.readFile(join(s.dataDir, 'sessions.json'), 'utf8'));
  assert.equal(saved.sessionPreferences[id].title, 'Latest metadata name');
  await s.close(); await s.launch(); state = await s.call('state');
  assert.equal(state.sessions.find(session => session.id === id).title, 'Latest metadata name');
});
