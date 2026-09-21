import './isolate.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createWebServer } from '../web/server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'pi-web-commands-'));
const vault = join(root, 'workspace'), agent = join(root, 'agent'), dataDir = join(root, 'data');
const sentinels = ['PRIVATE_MODEL_HEADER_SENTINEL', 'PRIVATE_MODEL_KEY_SENTINEL', 'PRIVATE_MODEL_ENDPOINT_SENTINEL', 'PRIVATE_COMMAND_SOURCE_SENTINEL'];
let app, base, modelCalls = 0;
const provider = createServer((_request, response) => {
  modelCalls++;
  response.writeHead(500, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: { message: 'Web command tests must never call a model.' } }));
});
const options = { dataDir, workspace: vault, sessionRoots: [], piBin: 'pi', piArgs: ['--no-context-files', '--no-skills'],
  env: { PATH: process.env.PATH, HOME: root, LANG: 'C.UTF-8', PI_CODING_AGENT_DIR: agent, PI_STUDY_VAULT: vault },
  publicOrigin: '', tailscaleUser: '' };
async function launch(overrides = {}) {
  app = await createWebServer({ ...options, ...overrides });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
}
async function close() { if (app) { await app.close(); app = undefined; } }
function assertPublic(value) {
  const text = JSON.stringify(value);
  for (const sentinel of sentinels) assert.ok(!text.includes(sentinel), 'The Web API must not expose private model configuration or command source metadata');
}
async function call(path, body, status = 200) {
  const response = await fetch(`${base}/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { Origin: base, 'Content-Type': 'application/json', 'X-Pi-Web': '1' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  assert.equal(response.status, status, `${path}: ${JSON.stringify(result)}`);
  assertPublic(result);
  return result;
}
const command = (sessionId, message, status = 200) => call('prompt', { sessionId, message }, status);
function assertCommandList(commands) {
  assert.ok(Array.isArray(commands));
  for (const item of commands) {
    assert.ok(typeof item.name === 'string' && item.name);
    assert.ok(Object.keys(item).every(key => ['name', 'description', 'source', 'usage', 'suggestions'].includes(key)), 'Command lists expose only their public fields');
  }
  for (const name of ['model', 'help', 'new', 'name', 'session', 'mode', 'study', 'browser']) assert.ok(commands.some(item => item.name === name), `Command list includes /${name}`);
}
function assertModels(result, sessionId) {
  assert.equal(result.ok, true); assert.equal(result.state.sessionId, sessionId);
  assert.equal(result.command.type, 'models'); assert.equal(result.command.sessionId, sessionId);
  for (const model of result.command.models) {
    assert.deepEqual(Object.keys(model).sort(), ['id', 'name', 'provider', 'reasoning']);
    assert.equal(typeof model.reasoning, 'boolean');
  }
  assert.deepEqual(Object.keys(result.command.current).sort(), ['id', 'provider']);
  return result.command;
}

try {
  await mkdir(vault); await mkdir(agent);
  await writeFile(join(vault, 'Synthetic.md'), '# Synthetic\nOnly a temporary test note.\n');
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const pkg = process.env.PI_WEB_TEST_PACKAGE || resolve(here, '..');
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ packages: [pkg], defaultProvider: 'mock-a', defaultModel: 'alpha', retry: { enabled: false } }));
  const modelConfig = (id, name) => ({ id, name, reasoning: false, input: ['text'], contextWindow: 64000, maxTokens: 1000,
    headers: { 'X-Private-Fixture': sentinels[0] }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  const providerConfig = model => ({ baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: 'openai-completions', apiKey: sentinels[1], models: [model] });
  await writeFile(join(agent, 'models.json'), JSON.stringify({ providers: {
    'mock-a': providerConfig(modelConfig('alpha', 'Synthetic Alpha')),
    'mock-b': providerConfig(modelConfig('beta', 'Synthetic Beta')),
  } }));
  await launch();
  let state = await call('sessions', {}), sessionId = state.sessionId;
  const workspaceId = state.workspaceId;
  assert.equal(state.mode, 'general'); assertCommandList(state.commands);
  assert.deepEqual(state.messages, []);

  let response = await command(sessionId, '/model');
  let picker = assertModels(response, sessionId);
  assert.deepEqual(picker.current, { provider: 'mock-a', id: 'alpha' });
  assert.deepEqual(picker.models.map(model => `${model.provider}/${model.id}`).sort(), ['mock-a/alpha', 'mock-b/beta']);
  assert.deepEqual(response.state.messages, [], 'Opening /model adds neither a user prompt nor an assistant answer');
  assert.equal(modelCalls, 0);

  response = await command(sessionId, '/help');
  assert.equal(response.command.type, 'help'); assertCommandList(response.command.commands);
  response = await command(sessionId, '/session');
  assert.equal(response.command.type, 'session');
  assert.equal(response.command.info.messageCount, 0);
  assert.ok(JSON.stringify(response.command.info.workspace).includes(vault));
  assert.ok(response.command.info.model); assert.ok(response.command.info.title);
  for (const message of ['/login', '/settings', '/reload', '/unknown-command', '/skill:missing-skill']) {
    const rejected = await command(sessionId, message, 400);
    assert.ok(rejected.error, `${message} returns an explicit error rather than becoming a model prompt`);
  }
  assert.equal((await command(sessionId, '/compact')).command.type, 'compact', 'Compaction first opens a reviewable confirmation without calling a model');
  assert.deepEqual((await command(sessionId, '/thinking')).command.levels, ['off'], 'The real Pi controls report only the selected model’s supported levels');
  state = await call('state');
  assert.equal(state.sessionId, sessionId); assert.equal(state.busy, false); assert.deepEqual(state.messages, []);
  assert.equal(modelCalls, 0, 'Unsupported and unknown slash commands do not reach the provider');

  await command(sessionId, '/model mock-b/beta');
  picker = assertModels(await command(sessionId, '/model'), sessionId);
  assert.deepEqual(picker.current, { provider: 'mock-b', id: 'beta' });
  await command(sessionId, '/model alpha');
  picker = assertModels(await command(sessionId, '/model'), sessionId);
  assert.deepEqual(picker.current, { provider: 'mock-a', id: 'alpha' }, 'A unique model ID can be selected without a provider prefix');
  response = await call('model', { sessionId, provider: 'mock-b', modelId: 'beta' });
  assert.equal(response.ok, true); assert.equal(response.state.sessionId, sessionId);
  picker = assertModels(await command(sessionId, '/model'), sessionId);
  assert.deepEqual(picker.current, { provider: 'mock-b', id: 'beta' });
  await call('model', { sessionId, provider: 'not-configured', modelId: 'missing' }, 400);
  await command(sessionId, '/model not-configured/missing', 400);
  assert.deepEqual(assertModels(await command(sessionId, '/model'), sessionId).current, { provider: 'mock-b', id: 'beta' });
  const draft = JSON.parse(await readFile(join(dataDir, 'sessions.json'), 'utf8')).sessions.find(session => session.id === sessionId);
  assert.equal(draft.draft, true, 'The persistence case exercises a draft without a first assistant message');

  const second = await call('sessions', { workspaceId });
  assert.notEqual(second.sessionId, sessionId);
  await call('open', { id: sessionId });
  assert.deepEqual(assertModels(await command(sessionId, '/model'), sessionId).current, { provider: 'mock-b', id: 'beta' }, 'Reopening an unsent Web draft restores its selected model');
  await close(); await launch();
  state = await call('state'); assert.equal(state.sessionId, sessionId); assert.deepEqual(state.messages, []);
  assert.deepEqual(assertModels(await command(sessionId, '/model'), sessionId).current, { provider: 'mock-b', id: 'beta' }, 'Restart also restores the draft model without calling it');

  await command(sessionId, '/mode study');
  state = await call('state'); assert.equal(state.mode, 'study', 'Registered extension commands still execute through Pi RPC');
  await command(sessionId, '/mode\tresearch');
  state = await call('state'); assert.equal(state.mode, 'research', 'Tab-separated commands are converted to the ASCII-space syntax Pi accepts');
  await command(sessionId, '/mode\nstudy');
  state = await call('state'); assert.equal(state.mode, 'study', 'Newline-separated commands reach the registered extension rather than the model');
  assert.deepEqual(state.messages, []); assert.equal(modelCalls, 0, 'Non-space command separators never create a model prompt');
  response = await command(sessionId, '/name 手機上的測試對話');
  assert.equal(response.ok, true);
  state = await call('state'); assert.equal(state.sessions.find(session => session.id === sessionId).title, '手機上的測試對話');
  response = await command(sessionId, '/session'); assert.equal(response.command.info.title, '手機上的測試對話');

  const savedDraftState = JSON.parse(await readFile(join(dataDir, 'sessions.json'), 'utf8')).sessions.find(session => session.id === sessionId).draftState;
  assert.equal(savedDraftState.mode, 'study');
  assert.deepEqual(savedDraftState.model, { provider: 'mock-b', id: 'beta' });
  const availableModelConfig = await readFile(join(agent, 'models.json'), 'utf8');
  await close();
  const unavailableModelConfig = JSON.parse(availableModelConfig);
  delete unavailableModelConfig.providers['mock-b'];
  await writeFile(join(agent, 'models.json'), JSON.stringify(unavailableModelConfig));
  await launch();
  state = await call('state');
  assert.equal(state.sessionId, sessionId);
  assert.ok(state.error, 'Restoring a draft reports that its selected model is unavailable');
  assert.equal(state.online, false, 'A failed restore must close Pi rather than leave the default model usable');
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'sessions.json'), 'utf8')).sessions.find(session => session.id === sessionId).draftState,
    savedDraftState, 'A failed restore must retain the original model, Mode, name and focus in the manifest');
  await command(sessionId, 'This must not reach the default model after a failed restore.', 503);
  assert.equal(modelCalls, 0);
  await close();
  await writeFile(join(agent, 'models.json'), availableModelConfig);
  await launch();
  state = await call('state');
  assert.equal(state.sessionId, sessionId); assert.equal(state.online, true); assert.equal(state.error, '');
  assert.equal(state.mode, 'study', 'Restoring model availability recovers the original Study Mode');
  assert.deepEqual(assertModels(await command(sessionId, '/model'), sessionId).current, { provider: 'mock-b', id: 'beta' },
    'Restoring model availability recovers the original Beta selection instead of Alpha defaults');
  assert.equal(state.sessions.find(session => session.id === sessionId).title, '手機上的測試對話');
  assert.deepEqual(state.messages, []); assert.equal(modelCalls, 0);

  response = await command(sessionId, '/new');
  assert.equal(response.ok, true); state = response.state;
  assert.notEqual(state.sessionId, sessionId); assert.equal(state.workspaceId, workspaceId); assert.equal(state.mode, 'general');
  assert.deepEqual(state.messages, []);
  assert.ok(state.sessions.some(session => session.id === sessionId && session.title === '手機上的測試對話'));
  await call('model', { sessionId, provider: 'mock-a', modelId: 'alpha' }, 409);
  assert.equal(modelCalls, 0, 'All real-Pi command and draft operations use zero model requests');
  assert.equal(await readFile(join(vault, 'Synthetic.md'), 'utf8'), '# Synthetic\nOnly a temporary test note.\n');
  const browserSession = state.sessionId;
  await command(browserSession, '/browser status');
  state = await call('state');
  const browserStatus = state.transcript.entries.find(entry => entry.model === 'Zen Pi / Browser');
  assert.equal(JSON.parse(browserStatus.text).active, false, 'Browser status is visible in the Web conversation');
  assert.equal(state.transcript.usage.requests, 0);
  assert.equal(modelCalls, 0);
  await close();
  console.log('Real Pi Web commands: model selection, help, Session info/name/new, extension dispatch and draft persistence pass with 0 model requests');

  // A deliberately rich RPC response proves projection at the HTTP boundary even
  // when a provider adds private fields that the real Pi fixture does not retain.
  const rpcFile = join(root, 'private-model-fixture.mjs'), auditFile = join(root, 'rpc-audit.jsonl');
  await writeFile(rpcFile, `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2), sessionDir = args[args.indexOf('--session-dir') + 1];
const secretModel = { apiKey: 'PRIVATE_MODEL_KEY_SENTINEL', headers: { Authorization: 'PRIVATE_MODEL_HEADER_SENTINEL' }, baseUrl: 'https://PRIVATE_MODEL_ENDPOINT_SENTINEL.invalid' };
const models = [
  { ...secretModel, provider: 'sentinel-a', id: 'shared', name: 'Shared A', reasoning: false },
  { ...secretModel, provider: 'sentinel-b', id: 'shared', name: 'Shared B', reasoning: true },
  { ...secretModel, provider: 'sentinel-b', id: 'unique', name: 'Unique B', reasoning: false },
];
let model = models[0], mode = 'general';
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
const reply = (request, data) => emit({ type: 'response', id: request.id, command: request.type, success: true, data });
const custom = (customType, value) => emit({ type: 'message_end', message: { role: 'custom', customType, content: JSON.stringify(value) } });
const commands = ['mode', 'study', 'study-status', 'study-notes', 'browser', 'fixture-extension'].map(name => ({ name, description: 'Fixture extension', source: 'extension' }));
commands.push({ name: 'fixture-template', description: 'Fixture template', source: 'prompt' }, { name: 'skill:fixture-skill', description: 'Fixture skill', source: 'skill' });
for (const command of commands) Object.assign(command, { path: '/PRIVATE_COMMAND_SOURCE_SENTINEL', sourceInfo: { path: '/PRIVATE_COMMAND_SOURCE_SENTINEL', origin: 'temporary' } });
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line); appendFileSync(process.env.COMMAND_RPC_AUDIT, JSON.stringify(request) + '\\n');
  if (request.type === 'get_state') reply(request, { sessionId: 'fixture-native-id', sessionFile: join(sessionDir, 'fixture-draft.jsonl'), model, isStreaming: false, isCompacting: false });
  else if (request.type === 'get_messages') reply(request, { messages: [] });
  else if (request.type === 'get_session_stats') reply(request, { userMessages: 432, assistantMessages: 321, totalMessages: 9999, sessionFile: '/PRIVATE_COMMAND_SOURCE_SENTINEL/session.jsonl' });
  else if (request.type === 'get_commands') reply(request, { commands });
  else if (request.type === 'get_available_models') reply(request, { models });
  else if (request.type === 'set_model') { model = models.find(model => model.provider === request.provider && model.id === request.modelId); reply(request, model); }
  else if (request.type === 'prompt') {
    if (request.message.startsWith('/mode ')) { if (request.message !== '/mode status') mode = request.message.slice(6); custom('pi-mode-state', { mode }); }
    else if (request.message === '/study-status') custom('pi-study-state', { mode, focus: { mode: 'auto' }, status: 'Fixture', current: null });
    reply(request);
  } else reply(request);
}
`);
  await launch({ dataDir: join(root, 'fake-data'), piBin: process.execPath, piArgs: [rpcFile], env: { ...options.env, COMMAND_RPC_AUDIT: auditFile } });
  state = await call('sessions', {}); sessionId = state.sessionId;
  assertCommandList(state.commands);
  for (const [name, source] of [['fixture-extension', 'extension'], ['fixture-template', 'prompt'], ['skill:fixture-skill', 'skill']]) {
    assert.equal(state.commands.find(command => command.name === name)?.source, source);
  }
  picker = assertModels(await command(sessionId, '/model'), sessionId);
  assert.equal(picker.models.length, 3);
  assert.deepEqual(picker.current, { provider: 'sentinel-a', id: 'shared' });
  await command(sessionId, '/model shared', 400);
  assert.deepEqual(assertModels(await command(sessionId, '/model'), sessionId).current, { provider: 'sentinel-a', id: 'shared' }, 'Ambiguous model IDs must not silently choose a provider');
  await command(sessionId, '/model sentinel-b/shared');
  assert.deepEqual(assertModels(await command(sessionId, '/model'), sessionId).current, { provider: 'sentinel-b', id: 'shared' });
  await command(sessionId, '/model unique');
  assert.deepEqual(assertModels(await command(sessionId, '/model'), sessionId).current, { provider: 'sentinel-b', id: 'unique' });
  for (const message of ['/login', '/settings', '/reload', '/made-up-command', '/skill:not-installed']) await command(sessionId, message, 400);
  for (const message of ['/fixture-extension', '/fixture-template', '/skill:fixture-skill']) await command(sessionId, message);
  for (const message of ['/mode\tstudy', '/mode\nresearch']) await command(sessionId, message);
  response = await command(sessionId, '/session');
  assert.equal(response.command.info.messageCount, 753, 'Session info counts native user and assistant messages, including history outside the Web display limit');
  assert.deepEqual(response.state.messages, [], 'The statistics fixture intentionally has no messages in its current Web view');
  response = await command(sessionId, '/help'); assertCommandList(response.command.commands);
  const audit = (await readFile(auditFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const forwarded = audit.filter(request => request.type === 'prompt').map(request => request.message);
  for (const message of ['/login', '/settings', '/reload', '/made-up-command', '/skill:not-installed', '/model', '/model shared', '/model sentinel-b/shared', '/model unique', '/help']) {
    assert.ok(!forwarded.includes(message), `${message} must be handled before RPC prompt dispatch`);
  }
  for (const message of ['/fixture-extension', '/fixture-template', '/skill:fixture-skill']) assert.ok(forwarded.includes(message), 'Registered extension, prompt and skill commands are dispatched');
  for (const message of ['/mode study', '/mode research']) assert.ok(forwarded.includes(message), 'Registered commands are forwarded with a single ASCII space before their arguments');
  for (const message of ['/mode\tstudy', '/mode\nresearch']) assert.ok(!forwarded.includes(message), 'Raw tab/newline separators never reach Pi slash dispatch');
  assertPublic(await call('state'));
  assert.equal(modelCalls, 0);
  console.log('Web command boundary: private model fields and command paths stay server-side; ambiguous IDs and unsupported slash commands never become RPC prompts');
} finally {
  await close();
  if (provider.listening) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
  await rm(root, { recursive: true, force: true });
}
