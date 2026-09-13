import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebServer } from '../web/server.mjs';

const until = async (condition, label) => {
  for (let attempt = 0; attempt < 500; attempt++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`Timed out: ${label}`);
};
const exists = async file => { try { await fs.stat(file); return true; } catch { return false; } };
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'pi-runtime-races-')), dataDir = join(root, 'data'), cwd = join(root, 'workspace');
  await fs.mkdir(cwd);
  const executable = join(root, 'rpc-fixture.mjs');
  await fs.writeFile(executable, `
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
const args = process.argv.slice(2), option = name => args[args.indexOf(name)+1];
const sessionDir = option('--session-dir'), root = process.env.RACE_FIXTURE_ROOT;
let nativeId = randomUUID(), sessionFile = args.includes('--session') ? option('--session') : join(sessionDir, nativeId + '.jsonl');
let mode = 'general', model = { provider: 'fixture', id: 'alpha', name: 'Alpha' }, streaming = false, name = '', delayState = false;
const models = [model, {provider:'fixture',id:'beta',name:'Beta'}];
const timestamp = '2026-01-01T00:00:00.000Z';
function save() {
  const entries = [{type:'session',version:3,id:nativeId,cwd:process.cwd(),timestamp},
    {type:'message',id:'fixture-user',parentId:null,timestamp,message:{role:'user',content:'Synthetic history',timestamp:1}}];
  if (name) entries.push({type:'session_info',id:'fixture-name',parentId:'fixture-user',timestamp,name});
  writeFileSync(sessionFile,entries.map(value=>JSON.stringify(value)).join('\\n')+'\\n');
}
if (!existsSync(sessionFile)) save();
const emit = value => process.stdout.write(JSON.stringify(value)+'\\n');
const reply = (request,data) => emit({type:'response',id:request.id,command:request.type,success:true,data});
const state = () => ({sessionId:nativeId,sessionFile,model,thinkingLevel:'off',sessionName:name,isStreaming:streaming,isCompacting:false});
const custom = (type,value) => emit({type:'message_end',message:{role:'custom',customType:type,content:JSON.stringify(value)}});
async function gate(name) { while(!existsSync(join(root,name))) await new Promise(resolve=>setTimeout(resolve,5)); }
async function handle(request) {
  appendFileSync(join(root,'audit.jsonl'),JSON.stringify({nativeId,sessionFile,type:request.type,payload:request})+'\\n');
  if(request.type==='get_state') {
    const before=state();
    if(delayState) { delayState=false; writeFileSync(join(root,'save-waiting'),'yes'); await gate('release-save'); reply(request,before); writeFileSync(join(root,'save-released'),'yes'); }
    else reply(request,before);
  } else if(request.type==='get_messages') {
    if(args.includes('--fork') && existsSync(join(root,'delay-side'))) { writeFileSync(join(root,'side-waiting'),'yes'); await gate('release-side'); }
    reply(request,{messages:[{role:'user',content:'Synthetic history',timestamp:1}]});
  } else if(request.type==='get_commands') reply(request,{commands:['mode','study','study-status','study-notes','race-autosave'].map(name=>({name,source:'extension'}))});
  else if(request.type==='get_available_models') reply(request,{models});
  else if(request.type==='set_model') {model=models.find(model=>model.provider===request.provider && model.id===request.modelId);reply(request,model);}
  else if(request.type==='set_session_name') {name=request.name;save();reply(request);}
  else if(request.type==='get_fork_messages') reply(request,{messages:[{entryId:'fixture-user',text:'Synthetic history'}]});
  else if(request.type==='clone' || request.type==='fork') {nativeId=randomUUID();sessionFile=join(sessionDir,nativeId+'.jsonl');save();reply(request,{cancelled:false,text:'Synthetic history'});}
  else if(request.type==='prompt') {
    if(request.message==='/race-autosave') {
      streaming=true;emit({type:'agent_start'});reply(request);
      setTimeout(()=>{streaming=false;delayState=true;emit({type:'agent_settled'});},20);
    } else {
      if(request.message.startsWith('/mode ')) {if(request.message!=='/mode status')mode=request.message.slice(6);custom('pi-mode-state',{mode});}
      if(request.message==='/study-status')custom('pi-study-state',{focus:{mode:'auto'},status:'Fixture'});
      reply(request);
    }
  } else reply(request,{});
}
for await(const line of createInterface({input:process.stdin})) { void handle(JSON.parse(line)); }
`);
  const app = await createWebServer({ dataDir, workspace: cwd, sessionRoots: [], piBin: process.execPath, piArgs: [executable],
    env: { PATH: process.env.PATH, HOME: root, RACE_FIXTURE_ROOT: root }, publicOrigin: '', tailscaleUser: '' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (route, body) => {
    const response = await fetch(`${base}/api/${route}`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-Pi-Web': '1' }, body: JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.status, 200, `${route}: ${JSON.stringify(result)}`); return result;
  };
  const manifest = async () => JSON.parse(await fs.readFile(join(dataDir, 'sessions.json'), 'utf8'));
  return { root, app, post, manifest };
}

test('a delayed pre-clone autosave cannot attach the source file to its new branch', async t => {
  const s = await fixture(t), source = await s.post('sessions', {});
  const originalFile = (await s.manifest()).sessions.find(record => record.id === source.sessionId).file;
  await s.post('prompt', { sessionId: source.sessionId, message: '/race-autosave' });
  await until(() => exists(join(s.root, 'save-waiting')), 'old get_state captured before cloning');
  const clone = await s.post('clone', { sessionId: source.sessionId });
  const branchId = clone.state.sessionId, branchFile = (await s.manifest()).sessions.find(record => record.id === branchId).file;
  assert.notEqual(branchId, source.sessionId); assert.notEqual(branchFile, originalFile);
  const revision = s.app.snapshot().revision;
  await fs.writeFile(join(s.root, 'release-save'), 'yes');
  await until(() => s.app.snapshot().revision > revision, 'late autosave handler finished');
  const saved = await s.manifest();
  assert.equal(saved.sessions.find(record => record.id === source.sessionId).file, originalFile);
  assert.equal(saved.sessions.find(record => record.id === branchId).file, branchFile,
    'The delayed old state must not overwrite the fork record with the source file');
  assert.equal(s.app.snapshot().sessionId, branchId);
});

test('slash Side Chat and navigation keep model/name updates attached to the new side runtime', async t => {
  const s = await fixture(t), source = await s.post('sessions', {}), other = await s.post('sessions', {});
  await s.post('model', { sessionId: other.sessionId, provider: 'fixture', modelId: 'beta' });
  await s.post('prompt', { sessionId: other.sessionId, message: '/name Other conversation' });
  await s.post('open', { id: source.sessionId });
  await fs.writeFile(join(s.root, 'delay-side'), 'yes');
  const sideRequest = s.post('prompt', { sessionId: source.sessionId, message: '/side Compare this independently.' });
  await until(() => exists(join(s.root, 'side-waiting')), 'side runtime loading');
  let navigationFinished = false;
  const navigate = s.post('open', { id: other.sessionId }).then(value => { navigationFinished = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(navigationFinished, false, 'A slash navigation command participates in the same navigation queue');
  await fs.writeFile(join(s.root, 'release-side'), 'yes');
  const side = await sideRequest; await navigate;
  assert.equal(side.restoredPrompt, 'Compare this independently.');
  assert.equal(s.app.snapshot().sessionId, other.sessionId, 'The later explicit navigation remains selected');
  const menu = await s.post('prompt', { sessionId: other.sessionId, message: '/model' });
  assert.deepEqual(menu.command.current, { provider: 'fixture', id: 'beta' }, 'Side Chat must not change another conversation model');
  assert.equal(menu.command.sessionId, other.sessionId);
  const saved = await s.manifest(), sideRecord = saved.sessions.find(record => record.kind === 'side');
  assert.ok(sideRecord); assert.notEqual(sideRecord.id, other.sessionId);
  assert.equal(saved.sessions.find(record => record.id === other.sessionId).title, 'Other conversation');
  await s.post('open', { id: sideRecord.id });
  const sideModel = await s.post('prompt', { sessionId: sideRecord.id, message: '/model' });
  assert.deepEqual(sideModel.command.current, { provider: 'fixture', id: 'alpha' });
});

test('deleting after settlement invalidates a delayed autosave and preserves the recoverable file', async t => {
  const s = await fixture(t), source = await s.post('sessions', {});
  const originalFile = (await s.manifest()).sessions.find(record => record.id === source.sessionId).file;
  await s.post('prompt', { sessionId: source.sessionId, message: '/race-autosave' });
  await until(() => exists(join(s.root, 'save-waiting')), 'settled autosave awaiting get_state');
  const result = await s.post('session/delete', { id: source.sessionId, workspaceId: source.workspaceId });
  assert.equal(result.state.sessionId, null);
  assert.equal(result.state.messages.length, 0);
  assert.equal(result.state.sessions.some(item => item.id === source.sessionId), false);
  assert.equal(result.state.deletedSessions.find(item => item.id === source.sessionId).id, source.sessionId);
  assert.ok(await exists(originalFile), 'Deleting does not remove the native JSONL file');
  await fs.writeFile(join(s.root, 'release-save'), 'yes');
  await s.post('refresh', {});
  const saved = await s.manifest();
  assert.ok(saved.sessionPreferences[source.sessionId].deletedAt);
  assert.equal(saved.sessions.find(record => record.id === source.sessionId).file, originalFile);
  assert.equal(s.app.snapshot().sessions.length, 0, 'A scanned deleted Web file must not reappear as a CLI alias');
  const restored = await s.post('session/restore', { id: source.sessionId, workspaceId: source.workspaceId });
  assert.equal(restored.state.sessionId, null, 'Restoring does not steal the current selection');
  assert.equal(restored.state.sessions[0].id, source.sessionId);
  const opened = await s.post('open', { id: source.sessionId });
  assert.equal(opened.sessionId, source.sessionId);
  assert.ok(opened.messages.some(message => message.text === 'Synthetic history'));
});
