import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as uiState from '../web/public/state.js';

const { commandSuggestions, moveCommandSelection, filterModels, acceptsCommandResponse, modelDisabledReason, draftScope } = uiState;
const commands = [
  { name: 'model', description: '選擇模型', source: 'web' },
  { name: 'mode', description: '切換對話模式', source: 'extension' },
  { name: 'help', description: '查看可用指令', source: 'web' },
  { name: 'skill:review', description: '檢查程式', source: 'skill' },
  { name: 'explain', description: '說明概念', source: 'prompt' },
];
assert.deepEqual(commandSuggestions(commands, '/'), commands);
assert.deepEqual(commandSuggestions(commands, '/MOD').map(x => x.name), ['model', 'mode']);
assert.deepEqual(commandSuggestions(commands, '/ＭＯＤＥＬ').map(x => x.name), ['model']);
assert.deepEqual(commandSuggestions(commands, '/模型').map(x => x.name), ['model']);
assert.deepEqual(commandSuggestions(commands, '/skill:').map(x => x.name), ['skill:review']);
assert.deepEqual(commandSuggestions(commands, '/explain').map(x => x.name), ['explain']);
for (const input of ['hello /model', '/model ', '/model provider/id', '/mode\nstudy', '/unknown']) assert.equal(commandSuggestions(commands, input).length, 0);
assert.equal(commandSuggestions(undefined, '/').length, 0);
assert.equal(moveCommandSelection(0, -1, 5), 4);
assert.equal(moveCommandSelection(4, 1, 5), 0);
assert.equal(moveCommandSelection(0, 1, 0), -1);
const models = [{ provider: 'local', id: 'tiny-model', name: 'Tiny 模型' }, { provider: 'remote', id: 'tiny-model', name: 'Tiny 推理', reasoning: true }];
assert.deepEqual(filterModels(models, 'ＴＩＮＹ local'), [models[0]]);
assert.deepEqual(filterModels(models, '推理'), [models[1]]);
assert.deepEqual(filterModels(models, 'no such model'), []);
assert.equal(filterModels(models, '').length, 2, 'Same model IDs from different providers remain separate choices');
const snapshot = {
  startedAt: 100, revision: 1, serverId: 'server-one', workspaceId: 'workspace-a', sessionId: 'session-a',
  workspaces: [{ id: 'workspace-a', name: 'a', path: '/tmp/a', available: true }, { id: 'workspace-b', name: 'b', path: '/tmp/b', available: true }],
  sessions: [], messages: [], sources: [], tools: [], dialogs: [], commands, mode: 'general', model: 'local/tiny-model',
  online: true, busy: false, readOnly: false, canContinue: false,
};
const requested = { workspaceId: snapshot.workspaceId, sessionId: snapshot.sessionId, startedAt: snapshot.startedAt };
const modelResponse = { ok: true, state: snapshot, command: { type: 'models', sessionId: snapshot.sessionId, models, current: { provider: 'local', id: 'tiny-model' } } };
assert.equal(acceptsCommandResponse(snapshot, requested, modelResponse), true);
for (const changed of [{ sessionId: 'session-b' }, { workspaceId: 'workspace-b' }, { startedAt: 101 }]) {
  assert.equal(acceptsCommandResponse({ ...snapshot, ...changed }, requested, modelResponse), false);
}
assert.equal(acceptsCommandResponse({ ...snapshot, revision: 2 }, requested, modelResponse), true, 'Unrelated newer background updates do not discard same-session command results');
assert.equal(acceptsCommandResponse({ ...snapshot, model: 'other-model' }, { ...requested, model: snapshot.model }, modelResponse), false, 'A stale model menu is still rejected when the selected model changed');
assert.equal(acceptsCommandResponse(snapshot, requested, { command: { sessionId: 'other-session' } }), false);
const ready = { connected: true, working: false };
assert.equal(modelDisabledReason(snapshot, ready), '');
for (const changed of [{ busy: true }, { readOnly: true }, { online: false }, { workspaceId: 'missing' }]) assert.ok(modelDisabledReason({ ...snapshot, ...changed }, ready));
assert.ok(modelDisabledReason(snapshot, { ...ready, connected: false }));
assert.ok(modelDisabledReason(snapshot, { ...ready, working: true }));
assert.equal(modelDisabledReason({ ...snapshot, sessionId: null, online: false }, ready), '', 'The model button can safely create a first session');

// A minimal DOM tests actual event handlers and delayed HTTP/SSE ordering without a browser or network.
function harness({ width = 1280, localStorageMap = new Map(), deferredFrames = false } = {}) {
  let document;
  class Element {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.style = {}; this.dataset = {}; this.value = ''; this.hidden = false; this.inert = false; this.open = false; this.disabled = false; this.scrollHeight = 40; this.clientHeight = 300; this.scrollTop = 0; this.className = ''; this.listeners = {}; this._text = ''; this.classList = { contains: name => this.className.split(' ').includes(name), toggle: (name, on) => { const names = new Set(this.className.split(' ').filter(Boolean)); const add = on ?? !names.has(name); if (add) names.add(name); else names.delete(name); this.className = [...names].join(' '); return add; }, add: (...names) => names.forEach(name => this.classList.toggle(name, true)), remove: (...names) => names.forEach(name => this.classList.toggle(name, false)) }; }
    set textContent(text) { this._text = text; this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    append(...nodes) { for (const node of nodes) { this.children.push(node); node.parent = this; } }
    replaceChildren(...nodes) { this._text = ''; this.children = []; this.append(...nodes); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
    get childElementCount() { return this.children.length; }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    getAttribute(key) { return this.attributes[key]; }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    get isConnected() { return document.body.contains(this); }
    getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
    querySelectorAll(selector) { return this.children.flatMap(node => [...(matches(node, selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    focus() { if (document.activeElement !== this) document.activeElement?.onblur?.(); document.activeElement = this; this.onfocus?.(); }
    showModal() { this.open = true; }
    close() { this.open = false; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    scrollIntoView() {}
    select() { this.selected = true; }
    requestSubmit() { this.onsubmit?.({ preventDefault() {} }); }
  }
  function matches(node, selector) {
    if (selector.includes(',')) return selector.split(',').some(part => matches(node, part.trim()));
    if (selector.startsWith('.')) return node.className.split(' ').includes(selector.slice(1));
    if (selector === '[data-mode]') return !!node.dataset.mode;
    return node.tagName.toLowerCase() === selector;
  }
  const html = readFileSync(new URL('../web/public/index.html', import.meta.url), 'utf8');
  const nodes = new Map([...html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"[^>]*>/g)].map(match => {
    const node = new Element(match[1]); node.id = match[2];
    node.hidden = /\shidden(?:\s|=|\/?>)/.test(match[0]); node.inert = /\sinert(?:\s|=|\/?>)/.test(match[0]);
    node.className = /\bclass="([^"]*)"/.exec(match[0])?.[1] || '';
    for (const attribute of match[0].matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(attribute[1], attribute[2]);
    return [node.id, node];
  }));
  // Retain real parent relationships among ID-bearing elements so hidden-panel
  // focus handling is tested against the actual page structure.
  const body = [...nodes.values()].find(node => node.tagName === 'BODY') || new Element('body'), stack = [];
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  for (const match of html.matchAll(/<(\/?)([a-z][a-z0-9-]*)\b([^>]*)>/g)) {
    const [, closing, tag, attributes] = match;
    if (closing) { const index = stack.map(entry => entry.tag).lastIndexOf(tag); if (index !== -1) stack.splice(index); continue; }
    const id = /\bid="([^"]+)"/.exec(attributes)?.[1], node = nodes.get(id);
    if (node && node !== body) (stack.findLast(entry => entry.node)?.node || body).append(node);
    if (!voidTags.has(tag) && !/\/$/.test(attributes)) stack.push({ tag, node: tag === 'body' ? body : node });
  }
  const modeButtons = ['general', 'study', 'research'].map(mode => { const node = new Element('button'); node.dataset.mode = mode; return node; });
  document = {
    activeElement: null, body,
    getElementById(id) { return nodes.get(id) || [...nodes.values()].flatMap(node => node.querySelectorAll('button')).find(node => node.id === id); },
    createElement: tag => new Element(tag), createTextNode: text => { const node = new Element('text'); node.textContent = text; return node; }, addEventListener() {},
    querySelectorAll(selector) { if (selector === '[data-mode]') return modeButtons; if (selector.startsWith('#')) { const [id, sub] = selector.split(' '); return nodes.get(id.slice(1)).querySelectorAll(sub); } return [...nodes.values()].flatMap(node => node.querySelectorAll(selector)); },
    querySelector(selector) { return selector === 'body' ? body : selector.startsWith('#') ? nodes.get(selector.slice(1)) || null : body.querySelector(selector); },
  };
  const storage = new Map(), requests = [], clipboard = [], downloads = [];
  const globalListeners = new Map(), frames = [];
  let events;
  class EventSource {
    constructor() { events = this; this.handlers = {}; }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    emit(name, value) { this.handlers[name]?.({ data: JSON.stringify(value) }); }
  }
  const context = { ...uiState, document, EventSource, console, innerWidth: width, requestAnimationFrame: fn => deferredFrames ? frames.push(fn) : fn(), Blob,
    addEventListener: (name, handler) => { const handlers = globalListeners.get(name) || []; handlers.push(handler); globalListeners.set(name, handlers); },
    URL: { createObjectURL: blob => { downloads.push(blob); return 'blob:test-download'; }, revokeObjectURL() {} },
    navigator: { clipboard: { writeText: async text => { clipboard.push(text); } } },
    Option: class extends Element { constructor(label, value) { super('option'); this.textContent = label; this.value = value; } },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    localStorage: { getItem: key => localStorageMap.get(key) ?? null, setItem: (key, value) => localStorageMap.set(key, String(value)), removeItem: key => localStorageMap.delete(key) },
    fetch: (url, options) => new Promise(resolve => requests.push({ url, body: JSON.parse(options.body), answer: (data, ok = true) => resolve({ ok, json: async () => data }) })),
    markdown: text => text,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(new URL('../web/public/app.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, ''), context);
  return { nodes, events, requests, storage, localStorageMap, body, clipboard, downloads, focused: () => document.activeElement,
    flushFrames() { while (frames.length) frames.shift()(); },
    resize(width) { context.innerWidth = width; for (const handler of globalListeners.get('resize') || []) handler({ type: 'resize' }); },
    type(text) { const prompt = nodes.get('prompt'); prompt.focus(); prompt.value = text; prompt.oninput(); }, key(key, extra = {}) { let prevented = false; nodes.get('prompt').onkeydown({ key, preventDefault() { prevented = true; }, ...extra }); return prevented; }, snapshot(value) { events.emit('snapshot', value); } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const ui = harness(); ui.snapshot(snapshot);
ui.type('/');
assert.equal(ui.nodes.get('command-menu').hidden, false);
assert.equal(ui.nodes.get('command-options').children.length, commands.length);
ui.key('ArrowDown'); ui.key('Enter');
assert.equal(ui.nodes.get('prompt').value, '/mode ');
assert.equal(ui.requests.length, 0, 'Selecting a command only inserts it and never calls Pi');
assert.equal(ui.nodes.get('command-menu').hidden, true);
ui.type('/model'); ui.key('Tab');
assert.equal(ui.nodes.get('prompt').value, '/model ');
ui.type('/'); ui.key('Escape');
assert.equal(ui.nodes.get('command-menu').hidden, true);
ui.type('/'); ui.key('Enter', { isComposing: true });
assert.equal(ui.nodes.get('prompt').value, '/', 'IME confirmation does not select or submit');
ui.nodes.get('command-options').children[0].onclick();
assert.equal(ui.nodes.get('prompt').value, '/model ', 'Phone taps use the same insertion-only action');
ui.key('Enter');
assert.equal(ui.requests[0].url, '/api/prompt');
assert.equal(ui.requests[0].body.message, '/model');
ui.requests.shift().answer(modelResponse); await tick();
assert.equal(ui.nodes.get('model-dialog').open, true);
assert.equal(ui.nodes.get('model-results').children.length, 2);
ui.nodes.get('model-query').value = 'remote'; ui.nodes.get('model-query').oninput();
assert.equal(ui.nodes.get('model-results').children.length, 1);
ui.nodes.get('model-results').children[0].onclick();
assert.deepEqual(ui.requests[0].body, { sessionId: 'session-a', workspaceId: 'workspace-a', provider: 'remote', modelId: 'tiny-model' });
assert.equal(ui.requests[0].url, '/api/model');
ui.requests.shift().answer({ ok: true, state: { ...snapshot, revision: 2, model: 'remote/tiny-model' } }); await tick();
assert.equal(ui.nodes.get('model-dialog').open, false);
assert.equal(ui.nodes.get('model-button-label').textContent, 'remote/tiny-model');
ui.nodes.get('choose-model').onclick();
ui.requests.shift().answer({ ...modelResponse, state: { ...snapshot, revision: 2, model: 'remote/tiny-model' }, command: { ...modelResponse.command, current: { provider: 'remote', id: 'tiny-model' } } }); await tick();
assert.equal(ui.nodes.get('model-dialog').open, true);
ui.snapshot({ ...snapshot, revision: 3, model: 'local/tiny-model' });
assert.equal(ui.nodes.get('model-dialog').open, false, 'A model changed in another tab cannot leave a stale current-model badge visible');
ui.nodes.get('choose-model').onclick();
ui.snapshot({ ...snapshot, revision: 4, workspaceId: 'workspace-b', sessionId: 'session-b' });
ui.requests.shift().answer({ ...modelResponse, state: { ...snapshot, revision: 3 } }); await tick();
assert.equal(ui.nodes.get('model-dialog').open, false, 'A late model response cannot reopen a dialog in another session');
assert.equal(ui.nodes.get('header-workspace-path').textContent, '/tmp/b');
ui.snapshot({ ...snapshot, revision: 5, busy: true });
assert.equal(ui.nodes.get('choose-model').disabled, true);
assert.match(ui.nodes.get('model-action-hint').textContent, /停止/);
ui.snapshot({ ...snapshot, revision: 6, readOnly: true });
assert.equal(ui.nodes.get('choose-model').disabled, true);
assert.match(ui.nodes.get('model-action-hint').textContent, /接續/);
const fresh = harness(); fresh.snapshot({ ...snapshot, sessionId: null, online: false });
fresh.type('原本的草稿'); fresh.nodes.get('choose-model').onclick();
assert.equal(fresh.requests[0].url, '/api/sessions');
fresh.snapshot({ ...snapshot, revision: 3, workspaceId: 'workspace-b', sessionId: 'session-b' });
fresh.requests.shift().answer({ ...snapshot, revision: 2, sessionId: 'created-a' }); await tick();
assert.equal(fresh.requests.length, 0, 'Late first-session creation cannot dispatch /model to the other workspace');
assert.equal(fresh.storage.get(draftScope({ ...snapshot, sessionId: null })), '原本的草稿');
assert.equal(fresh.nodes.get('prompt').value, '');
const details = harness(); details.snapshot(snapshot);
details.type('/help '); details.key('Enter');
details.requests.shift().answer({ ok: true, state: snapshot, command: { type: 'help', commands } }); await tick();
assert.equal(details.nodes.get('help-dialog').open, true);
details.nodes.get('help-results').children[2].onclick();
assert.equal(details.nodes.get('help-dialog').open, false);
assert.equal(details.nodes.get('prompt').value, '/help ');
assert.equal(details.requests.length, 0, 'Help choices also only insert a command');
details.type('/session '); details.key('Enter');
details.requests.shift().answer({ ok: true, state: snapshot, command: { type: 'session', info: { title: '<personal title>', workspace: '/tmp/a', model: 'local/tiny-model', messageCount: 0 } } }); await tick();
assert.equal(details.nodes.get('session-dialog').open, true);
assert.match(details.nodes.get('session-info').textContent, /<personal title>/, 'Session details use text nodes');
const messageMetric = details.nodes.get('session-info').children.findIndex(node => node.textContent === '訊息數');
assert.equal(details.nodes.get('session-info').children[messageMetric + 1].textContent, '0');
details.nodes.get('close-session-info').onclick();
details.nodes.get('choose-model').onclick(); details.requests.shift().answer(modelResponse); await tick();
details.nodes.get('model-results').children[1].onclick();
details.requests.shift().answer({ error: '模型目前無法使用，請選其他模型。' }, false); await tick();
assert.equal(details.nodes.get('model-dialog').open, true);
assert.equal(details.nodes.get('model-error').hidden, false);
assert.equal(details.nodes.get('model-results').children[1].disabled, false, 'A failed selection can be retried');
console.log('Command UI insertion, keyboard/IME, searchable models, dedicated model API, and cross-session guards passed');

const { composerSuggestions, commandUsage, agentControls, sessionInfoRows, workspaceJobs, jobDraft, metric, sessionParent } = uiState;
const subcommands = [{ name: 'mode', usage: '/mode <general|study|research>', suggestions: [{ value: '/mode general', label: '一般', description: '自由討論' }, { value: '/mode study', label: '學習' }] }];
assert.deepEqual(composerSuggestions(subcommands, '/mode st').map(item => item.value), ['/mode study']);
assert.equal(commandUsage(subcommands, '/mode study'), '/mode <general|study|research>');
assert.equal(composerSuggestions([], '/wiki check').length, 0, 'Hints never invent unavailable commands');
assert.equal(metric(null), '未知'); assert.equal(metric(undefined), '未知'); assert.equal(metric(0), '0');
assert.ok(sessionInfoRows({}).filter(([label]) => label !== '名稱').every(([, value]) => value === '未知'));
assert.equal(sessionInfoRows({ contextPercent: 102.5 }).at(-1)[1], '102.5%');
assert.equal(agentControls({ ...snapshot, readOnly: true }, ready).inspect, false);
assert.equal(agentControls({ ...snapshot, busy: true }, { ...ready, working: true }).queue, true, 'A long main response does not block steering');
const subUi = harness(); subUi.snapshot({ ...snapshot, commands: subcommands });
subUi.type('/mo'); subUi.key('Enter');
assert.equal(subUi.nodes.get('prompt').value, '/mode ');
assert.equal(subUi.nodes.get('command-menu').hidden, false, 'Selecting a command reveals its available subcommands');
subUi.key('ArrowDown'); subUi.key('Enter');
assert.equal(subUi.nodes.get('prompt').value, '/mode study ');
assert.equal(subUi.requests.length, 0);

const controlsUi = harness(); controlsUi.snapshot(snapshot);
controlsUi.nodes.get('choose-thinking').onclick();
assert.equal(controlsUi.requests[0].url, '/api/thinking');
controlsUi.requests.shift().answer({ command: { type: 'thinking', levels: ['off', 'high'], current: 'off' } }); await tick();
assert.equal(controlsUi.nodes.get('thinking-dialog').open, true);
controlsUi.nodes.get('thinking-options').children[1].onclick();
assert.equal(controlsUi.requests[0].body.level, 'high');
controlsUi.requests.shift().answer({ ...snapshot, revision: 2, thinkingLevel: 'high' }); await tick();
assert.equal(controlsUi.nodes.get('thinking-label').textContent, '高');
assert.equal(controlsUi.nodes.get('thinking-dialog').open, false);
controlsUi.nodes.get('tool-stats').onclick();
controlsUi.requests.shift().answer({ command: { type: 'session', info: { title: '對話', tokens: { input: 0, output: null }, contextTokens: null, cost: null } } }); await tick();
assert.match(controlsUi.nodes.get('session-info').textContent, /未知/);
controlsUi.nodes.get('close-session-info').onclick();
controlsUi.nodes.get('tool-compact').onclick();
assert.equal(controlsUi.nodes.get('compact-dialog').open, true);
assert.equal(controlsUi.requests.length, 0, 'Opening compaction never calls a model before confirmation');
controlsUi.nodes.get('compact-focus').value = '保留決策與路徑';
controlsUi.nodes.get('compact-form').onsubmit({ preventDefault() {} });
assert.equal(controlsUi.requests[0].url, '/api/compact');
assert.equal(controlsUi.requests[0].body.customInstructions, '保留決策與路徑');
assert.equal(controlsUi.nodes.get('compact-progress').hidden, false);
assert.equal(controlsUi.nodes.get('new-session').disabled, false, 'Compaction only locks its session, not new-session navigation');
controlsUi.requests.shift().answer({ state: { ...snapshot, revision: 3 }, command: { type: 'compaction', result: { summary: '保留摘要', tokensBefore: 1200, estimatedTokensAfter: 250 } } }); await tick();
assert.equal(controlsUi.nodes.get('compact-result').hidden, false);
assert.match(controlsUi.nodes.get('compact-metrics').textContent, /1,200/);
assert.equal(controlsUi.nodes.get('compact-progress').hidden, true);
controlsUi.nodes.get('close-compact').onclick();
controlsUi.nodes.get('tool-fork').onclick();
controlsUi.requests.shift().answer({ command: { type: 'forks', messages: [{ entryId: 'entry-id-1', text: '重新想這個問題' }] } }); await tick();
assert.equal(controlsUi.nodes.get('fork-dialog').open, true);
controlsUi.nodes.get('fork-options').children[0].onclick();
assert.equal(controlsUi.requests[0].body.entryId, 'entry-id-1');
const forked = { ...snapshot, revision: 4, sessionId: 'forked', sessions: [{ id: 'session-a', workspaceId: 'workspace-a', title: '原對話' }, { id: 'forked', workspaceId: 'workspace-a', parentId: 'session-a', kind: 'fork', title: '分支' }] };
controlsUi.requests.shift().answer({ state: forked, restoredPrompt: '重新想這個問題' }); await tick();
assert.equal(controlsUi.nodes.get('prompt').value, '重新想這個問題');
assert.equal(controlsUi.nodes.get('parent-navigation').hidden, false);
assert.equal(controlsUi.requests.length, 0, 'Fork selection restores the old input without submitting');
controlsUi.nodes.get('tool-clone').onclick();
assert.equal(controlsUi.requests[0].url, '/api/clone');
controlsUi.requests.shift().answer({ ...forked, revision: 5, sessionId: 'cloned' }); await tick();
controlsUi.nodes.get('tool-export').onclick();
controlsUi.requests.shift().answer({ command: { type: 'export', filename: '../test.html', html: '<html><script>exportOnly()</script>對話</html>' } }); await tick();
assert.equal(controlsUi.nodes.get('export-dialog').open, true);
assert.equal(controlsUi.nodes.get('download-export').href, 'blob:test-download');
assert.equal(controlsUi.nodes.get('download-export').download.includes('/'), false);
assert.match(await controlsUi.downloads[0].text(), /exportOnly/);
assert.equal(controlsUi.nodes.get('export-dialog').innerHTML, undefined, 'Exported HTML is never inserted into the live UI');
controlsUi.nodes.get('close-export').onclick();
controlsUi.nodes.get('tool-copy').onclick();
controlsUi.requests.shift().answer({ command: { type: 'copy', text: '最後一則回覆' } }); await tick();
controlsUi.nodes.get('copy-text').onclick(); await tick();
assert.deepEqual(controlsUi.clipboard, ['最後一則回覆']);

const queueUi = harness(); queueUi.snapshot(snapshot);
queueUi.type('長時間任務'); queueUi.key('Enter');
const heldPrompt = queueUi.requests.shift();
queueUi.snapshot({ ...snapshot, revision: 2, busy: true });
assert.equal(queueUi.nodes.get('new-session').disabled, false);
assert.equal(queueUi.nodes.get('workspace-select').disabled, false);
queueUi.type('先查證來源'); queueUi.nodes.get('queue-steer').onclick();
assert.equal(queueUi.requests[0].url, '/api/queue');
assert.equal(queueUi.requests[0].body.action, 'steer');
queueUi.requests.shift().answer({ state: { ...snapshot, revision: 3, busy: true, queue: { steering: ['先查證來源'], followUp: [] } } }); await tick();
assert.equal(queueUi.nodes.get('queue-count').textContent, '1');
queueUi.type('下一輪再整理'); queueUi.key('Enter');
assert.equal(queueUi.requests[0].body.action, 'follow_up');
queueUi.requests.shift().answer({ state: { ...snapshot, revision: 4, busy: true, queue: { steering: ['先查證來源'], followUp: ['下一輪再整理'] } } }); await tick();
queueUi.type('目前的新草稿'); queueUi.nodes.get('clear-queue').onclick();
queueUi.requests.shift().answer({ state: { ...snapshot, revision: 5, busy: true, queue: { steering: [], followUp: [] } }, restored: { steering: ['先查證來源'], followUp: ['下一輪再整理'] } }); await tick();
assert.equal(queueUi.nodes.get('prompt').value, '目前的新草稿\n\n先查證來源\n\n下一輪再整理');
queueUi.nodes.get('workspace-select').value = 'workspace-b'; queueUi.nodes.get('workspace-select').onchange();
assert.equal(queueUi.requests[0].url, '/api/workspace', 'An unfinished original prompt does not retain the global action lock');
queueUi.requests.shift().answer({ ...snapshot, revision: 6, sessionId: null, workspaceId: 'workspace-b' }); await tick();
heldPrompt.answer({ ok: true }); await tick();
assert.equal(queueUi.nodes.get('header-workspace-path').textContent, '/tmp/b');
assert.equal(queueUi.nodes.get('prompt').value, '');

const sideUi = harness(); sideUi.snapshot({ ...snapshot, busy: true });
sideUi.nodes.get('start-side-chat').onclick();
assert.equal(sideUi.requests[0].url, '/api/side-chat');
const side = { ...snapshot, revision: 2, sessionId: 'side-a', sessions: [{ id: 'session-a', title: '主對話', workspaceId: 'workspace-a', busy: true }, { id: 'side-a', title: 'Side Chat', workspaceId: 'workspace-a', kind: 'side', parentId: 'session-a' }] };
sideUi.requests.shift().answer({ state: side, restoredPrompt: '另一個想法' }); await tick();
assert.equal(sideUi.nodes.get('prompt').value, '另一個想法');
assert.equal(sessionParent(side), 'session-a');
assert.match(sideUi.nodes.get('parent-caption').textContent, /Side Chat/);
sideUi.nodes.get('return-parent').onclick();
assert.equal(sideUi.requests[0].body.id, 'session-a');
sideUi.requests.shift().answer({ ...snapshot, revision: 3, busy: true }); await tick();
assert.equal(sideUi.nodes.get('parent-navigation').hidden, true);

const jobsUi = harness(); jobsUi.snapshot(snapshot);
jobsUi.nodes.get('open-agents').onclick();
assert.equal(jobsUi.nodes.get('agent-pane').hidden, false);
jobsUi.nodes.get('new-agent').onclick();
assert.equal(jobsUi.nodes.get('agent-dialog').open, true);
jobsUi.nodes.get('agent-task').value = '檢查來源'; jobsUi.nodes.get('agent-context').value = '只閱讀指定檔案'; jobsUi.nodes.get('agent-kind').value = 'read';
jobsUi.nodes.get('agent-form').onsubmit({ preventDefault() {} });
assert.deepEqual(jobsUi.requests[0].body, { sessionId: 'session-a', workspaceId: 'workspace-a', task: '檢查來源', context: '只閱讀指定檔案', kind: 'read' });
const job = { id: 'job-a', workspaceId: 'workspace-a', parentSessionId: 'session-a', task: '檢查來源', kind: 'read', status: 'running', output: '已讀第一篇來源' };
jobsUi.requests.shift().answer({ state: { ...snapshot, revision: 2, subagents: [job] } }); await tick();
assert.equal(jobsUi.nodes.get('agent-dialog').open, false);
assert.equal(jobsUi.nodes.get('agent-count').textContent, '1');
let card = jobsUi.nodes.get('agent-list').children[0]; card.querySelector('details').open = true;
jobsUi.snapshot({ ...snapshot, revision: 3, subagents: [{ ...job, output: '繼續核對來源' }] });
card = jobsUi.nodes.get('agent-list').children[0];
assert.equal(card.querySelector('details').open, true, 'Progress updates preserve the expanded job');
card.querySelector('.job-cancel').onclick();
assert.equal(jobsUi.requests[0].url, '/api/subagents/cancel');
assert.equal(jobsUi.requests[0].body.id, 'job-a');
jobsUi.requests.shift().answer({ state: { ...snapshot, revision: 4, subagents: [{ ...job, status: 'cancelled' }] } }); await tick();
const finished = { ...job, kind: 'code', status: 'completed', result: '檢查完成，請 review diff。', branch: 'agent/job-a', worktree: '/tmp/worktrees/job-a' };
jobsUi.snapshot({ ...snapshot, revision: 5, subagents: [finished, { ...job, id: 'other', workspaceId: 'workspace-b' }] });
assert.equal(workspaceJobs({ ...snapshot, subagents: [finished, { ...job, workspaceId: 'workspace-b' }] }).length, 1);
jobsUi.type('主對話的原有草稿');
jobsUi.nodes.get('agent-list').children[0].querySelector('.job-use').onclick();
assert.match(jobsUi.nodes.get('prompt').value, /^主對話的原有草稿/);
assert.ok(jobsUi.nodes.get('prompt').value.includes(jobDraft(finished)));
assert.equal(jobsUi.requests.length, 0, 'Sub Agent results only append a draft and never start the parent model');
jobsUi.snapshot({ ...snapshot, revision: 6, readOnly: true, subagents: [finished] });
assert.equal(jobsUi.nodes.get('new-agent').disabled, true);
assert.equal(jobsUi.nodes.get('agent-list').children[0].querySelector('.job-use').disabled, true);
assert.equal(jobsUi.nodes.get('agent-pane').hidden, false, 'Read-only sessions may still inspect workspace jobs');
console.log('Agent tools, unknown stats, confirmed compaction, fork/clone, export/copy, queues, Side Chat and Sub Agent controls passed');

const backgroundUi = harness(); backgroundUi.snapshot(snapshot);
backgroundUi.nodes.get('choose-model').onclick();
backgroundUi.snapshot({ ...snapshot, revision: 20, subagents: [job] });
backgroundUi.requests.shift().answer(modelResponse); await tick();
assert.equal(backgroundUi.nodes.get('model-dialog').open, true, 'A newer job-progress snapshot cannot swallow a still-valid model response');
backgroundUi.nodes.get('close-models').onclick();
backgroundUi.nodes.get('tool-compact').onclick();
backgroundUi.nodes.get('compact-form').onsubmit({ preventDefault() {} });
const delayedCompact = backgroundUi.requests.shift();
backgroundUi.snapshot({ ...snapshot, revision: 21, workspaceId: 'workspace-b', sessionId: 'session-b' });
delayedCompact.answer({ state: { ...snapshot, revision: 20 }, command: { type: 'compaction', result: { summary: '原對話的摘要', tokensBefore: 2000 } } }); await tick();
assert.equal(backgroundUi.nodes.get('compact-dialog').open, false, 'A compaction result never opens in another workspace');
backgroundUi.snapshot({ ...snapshot, revision: 22 });
backgroundUi.nodes.get('tool-compact').onclick();
assert.equal(backgroundUi.nodes.get('compact-result').hidden, false, 'Returning to the original session can inspect its completed compaction');
assert.match(backgroundUi.nodes.get('compact-metrics').textContent, /壓縮後估計 未知/);

const restoreUi = harness(); restoreUi.snapshot({ ...snapshot, busy: true, queue: { steering: ['A 的指示'], followUp: [] } });
restoreUi.nodes.get('clear-queue').onclick();
restoreUi.snapshot({ ...snapshot, revision: 3, workspaceId: 'workspace-b', sessionId: 'session-b' });
restoreUi.type('B 的草稿');
restoreUi.requests.shift().answer({ state: { ...snapshot, revision: 2 }, restored: { steering: ['A 的指示'], followUp: [] } }); await tick();
assert.equal(restoreUi.nodes.get('prompt').value, 'B 的草稿');
assert.equal(restoreUi.storage.get(draftScope(snapshot)), 'A 的指示', 'Cleared queue recovery stays in the captured session');
console.log('Background command delivery, compaction result scope, and cross-workspace queue recovery passed');
const createdUi = harness(); createdUi.snapshot({ ...snapshot, sessionId: null, online: false });
createdUi.type('在新對話提出問題'); createdUi.key('Enter');
const createRequest = createdUi.requests.shift();
const createdSnapshot = { ...snapshot, sessionId: 'created-current', revision: 2 };
createdUi.snapshot({ ...createdSnapshot, revision: 3, subagents: [job] });
createRequest.answer(createdSnapshot); await tick();
assert.equal(createdUi.requests[0].url, '/api/prompt', 'Background progress after the same session was created does not cancel the first message');
assert.equal(createdUi.requests[0].body.sessionId, 'created-current');
createdUi.requests.shift().answer({ ok: true }); await tick();
assert.equal(createdUi.nodes.get('prompt').value, '');
console.log('New-session first send remains valid across unrelated background updates');
const boundedJob = jobDraft({ ...finished, result: '完整結果'.repeat(16000) }, 12000);
assert.ok(boundedJob.length <= 12000);
assert.match(boundedJob, /僅帶入部分結果/);
assert.ok(boundedJob.includes(finished.worktree), 'Bounded result drafts retain the review worktree');
assert.equal(jobDraft(finished, 50), '', 'A nearly full draft is not overwritten to make room for a result');

const familySessions = [
  { id: 'family-root', workspaceId: 'workspace-a', title: '主對話', origin: 'web', updatedAt: '2026-09-01T00:00:00Z' },
  { id: 'family-side', workspaceId: 'workspace-a', parentId: 'family-root', kind: 'side', title: '旁支討論', origin: 'web', updatedAt: '2026-09-02T00:00:00Z' },
  { id: 'family-fork', workspaceId: 'workspace-a', parentId: 'family-side', kind: 'fork', title: '深層實作分支', origin: 'web', updatedAt: '2026-09-03T00:00:00Z' },
  { id: 'independent', workspaceId: 'workspace-a', title: '另一段對話', origin: 'web' },
  { id: 'native-a', workspaceId: 'workspace-a', title: '本機終端紀錄', origin: 'local' },
  { id: 'other-workspace', workspaceId: 'workspace-b', title: 'B 的對話', origin: 'web' },
];
const familyState = { ...snapshot, sessionId: 'family-root', sessions: familySessions, deletedSessions: [] };
const sessionUi = harness(); sessionUi.snapshot(familyState);
const rowFor = (ui, id) => ui.nodes.get('session-list').children.find(row => row.dataset.sessionId === id);
const rowIds = ui => ui.nodes.get('session-list').children.map(row => row.dataset.sessionId).filter(Boolean);
assert.ok(rowIds(sessionUi).indexOf('family-root') < rowIds(sessionUi).indexOf('family-side'));
assert.ok(rowIds(sessionUi).indexOf('family-side') < rowIds(sessionUi).indexOf('family-fork'));
assert.equal(rowFor(sessionUi, 'family-side').style.paddingInlineStart, '12px');
assert.equal(rowFor(sessionUi, 'family-fork').style.paddingInlineStart, '24px');
assert.match(rowFor(sessionUi, 'family-fork').textContent, /Fork/);
rowFor(sessionUi, 'family-root').querySelector('.session-toggle').onclick();
assert.equal(rowFor(sessionUi, 'family-side'), undefined);
sessionUi.snapshot({ ...familyState, revision: 2 });
assert.equal(rowFor(sessionUi, 'family-side'), undefined, 'Background refresh preserves a collapsed conversation family');
sessionUi.nodes.get('session-search').value = '深層'; sessionUi.nodes.get('session-search').oninput();
assert.deepEqual(rowIds(sessionUi), ['family-root', 'family-side', 'family-fork']);
assert.equal(rowFor(sessionUi, 'family-root').querySelector('.session-toggle').disabled, true, 'Search exposes ancestors without changing the saved collapse preference');
sessionUi.nodes.get('session-search').value = ''; sessionUi.nodes.get('session-search').oninput();
assert.equal(rowFor(sessionUi, 'family-side'), undefined);
sessionUi.snapshot({ ...familyState, revision: 3, sessionId: 'family-fork' });
assert.ok(rowFor(sessionUi, 'family-fork'), 'Switching to a nested active session reveals its ancestors');
rowFor(sessionUi, 'family-root').querySelector('.session-toggle').onclick();
assert.equal(rowFor(sessionUi, 'family-side'), undefined, 'The user can still collapse the current session’s ancestor afterward');
rowFor(sessionUi, 'family-root').querySelector('.session-toggle').onclick();
rowFor(sessionUi, 'family-side').querySelector('.session-more').onclick();
assert.equal(sessionUi.nodes.get('session-manage-dialog').open, true);
assert.equal(sessionUi.nodes.get('session-manage-name').textContent, '旁支討論');
sessionUi.nodes.get('manage-rename').onclick();
sessionUi.nodes.get('session-rename-input').value = '重新命名的旁支'; sessionUi.nodes.get('session-rename-input').oninput();
sessionUi.snapshot({ ...familyState, revision: 4, sessionId: 'independent' });
assert.equal(sessionUi.nodes.get('session-rename-target').textContent, '旁支討論');
assert.equal(sessionUi.nodes.get('session-rename-input').value, '重新命名的旁支', 'SSE does not overwrite the rename input or retarget it to the active session');
sessionUi.nodes.get('session-rename-form').onsubmit({ preventDefault() {} });
assert.equal(sessionUi.requests[0].url, '/api/session/rename');
assert.equal(sessionUi.requests[0].body.id, 'family-side');
assert.equal(sessionUi.requests[0].body.sessionId, 'independent', 'The explicit metadata target is independent of the active runtime');
assert.equal(sessionUi.requests[0].body.title, '重新命名的旁支');
const renamedFamily = familySessions.map(item => item.id === 'family-side' ? { ...item, title: '重新命名的旁支' } : item);
sessionUi.requests.shift().answer({ ok: true, state: { ...familyState, revision: 5, sessionId: 'independent', sessions: renamedFamily } }); await tick();
assert.equal(sessionUi.nodes.get('session-rename-dialog').open, false);
assert.match(rowFor(sessionUi, 'family-side').textContent, /重新命名的旁支/);

const busyFamily = renamedFamily.map(item => item.id === 'family-side' ? { ...item, busy: true, deleteBlockedReason: '此對話的 Sub Agent 仍在執行，請先等待完成。' } : item);
sessionUi.snapshot({ ...familyState, revision: 6, sessions: busyFamily });
rowFor(sessionUi, 'family-side').querySelector('.session-more').onclick();
assert.equal(sessionUi.nodes.get('manage-rename').disabled, false, 'Web-only titles can be renamed while a session runs');
assert.equal(sessionUi.nodes.get('manage-delete').disabled, true);
assert.match(sessionUi.nodes.get('manage-delete-reason').textContent, /Sub Agent/);
sessionUi.nodes.get('manage-delete').onclick();
assert.equal(sessionUi.nodes.get('session-delete-dialog').open, false);
assert.equal(sessionUi.requests.length, 0);
sessionUi.snapshot({ ...familyState, revision: 7, sessions: renamedFamily });
sessionUi.nodes.get('manage-delete').onclick();
assert.equal(sessionUi.nodes.get('session-delete-dialog').open, true);
assert.equal(sessionUi.requests.length, 0, 'Delete requires the dedicated confirmation action');
sessionUi.snapshot({ ...familyState, revision: 8, sessions: busyFamily });
assert.equal(sessionUi.nodes.get('confirm-session-delete').disabled, true, 'A newly running job invalidates an already-open delete confirmation');
sessionUi.nodes.get('confirm-session-delete').onclick();
assert.equal(sessionUi.requests.length, 0);
sessionUi.snapshot({ ...familyState, revision: 9, sessionId: 'family-fork', sessions: renamedFamily });
assert.equal(sessionUi.nodes.get('session-delete-target').textContent, '重新命名的旁支');
sessionUi.nodes.get('confirm-session-delete').onclick();
assert.equal(sessionUi.requests[0].url, '/api/session/delete');
assert.equal(sessionUi.requests[0].body.id, 'family-side');
assert.equal(sessionUi.requests[0].body.workspaceId, 'workspace-a');
const deletedSide = { ...renamedFamily.find(item => item.id === 'family-side'), deletedAt: '2026-09-13T00:00:00Z' };
const deletedState = { ...familyState, revision: 10, sessionId: 'family-fork', sessions: renamedFamily.filter(item => item.id !== 'family-side'), deletedSessions: [deletedSide] };
sessionUi.requests.shift().answer({ ok: true, state: deletedState }); await tick();
assert.equal(sessionUi.nodes.get('session-delete-dialog').open, false);
assert.equal(rowFor(sessionUi, 'family-side'), undefined);
assert.ok(rowFor(sessionUi, 'family-fork'), 'Deleting one parent leaves its descendants visible');
assert.equal(rowFor(sessionUi, 'family-fork').style.paddingInlineStart, '12px', 'A surviving descendant stays under its nearest live ancestor');
assert.equal(sessionUi.nodes.get('recycle-count').textContent, '1');
sessionUi.nodes.get('open-recycle').onclick();
assert.equal(sessionUi.nodes.get('recycle-dialog').open, true);
const restoreButton = sessionUi.nodes.get('recycle-list').querySelector('.recycle-restore');
restoreButton.focus();
restoreButton.onclick();
assert.equal(sessionUi.requests[0].url, '/api/session/restore');
assert.equal(sessionUi.requests[0].body.id, 'family-side');
sessionUi.requests.shift().answer({ ok: true, state: { ...familyState, revision: 11, sessionId: 'family-fork', sessions: renamedFamily } }); await tick();
assert.ok(rowFor(sessionUi, 'family-side'));
assert.equal(rowFor(sessionUi, 'family-fork').style.paddingInlineStart, '24px');
assert.match(sessionUi.nodes.get('recycle-status').textContent, /已還原/);
assert.equal(sessionUi.nodes.get('recycle-count').textContent, '0');
assert.equal(sessionUi.focused(), sessionUi.nodes.get('close-recycle'), 'After the final restore, keyboard focus remains on the recycle dialog’s close button');

sessionUi.nodes.get('close-recycle').onclick();
rowFor(sessionUi, 'native-a').querySelector('.session-more').onclick();
assert.equal(sessionUi.nodes.get('manage-rename').disabled, false);
sessionUi.nodes.get('manage-rename').onclick();
sessionUi.nodes.get('session-rename-input').value = '未送出的命名';
sessionUi.snapshot({ ...familyState, revision: 12, workspaceId: 'workspace-b', sessionId: 'other-workspace' });
assert.equal(sessionUi.nodes.get('session-rename-dialog').open, true);
assert.equal(sessionUi.nodes.get('session-rename-target').textContent, '本機終端紀錄');
assert.equal(sessionUi.nodes.get('session-rename-input').value, '未送出的命名');
assert.equal(sessionUi.nodes.get('save-session-rename').disabled, true);
assert.match(sessionUi.nodes.get('session-rename-reason').textContent, /原 Workspace/);
sessionUi.nodes.get('session-rename-form').onsubmit({ preventDefault() {} });
assert.equal(sessionUi.requests.length, 0, 'A switched workspace cannot submit a metadata mutation to a different workspace');
sessionUi.snapshot({ ...familyState, revision: 13, sessionId: 'native-a', readOnly: true });
assert.equal(sessionUi.nodes.get('save-session-rename').disabled, false);
for (const invalid of ['', 'a'.repeat(161), '含\n換行']) {
  sessionUi.nodes.get('session-rename-input').value = invalid;
  sessionUi.nodes.get('session-rename-form').onsubmit({ preventDefault() {} });
  assert.equal(sessionUi.requests.length, 0);
}
sessionUi.nodes.get('session-rename-input').value = '原生紀錄名稱';
sessionUi.nodes.get('session-rename-form').onsubmit({ preventDefault() {} });
sessionUi.requests.shift().answer({ error: '清單已更新，請重新整理。' }, false); await tick();
assert.equal(sessionUi.nodes.get('session-rename-dialog').open, true);
assert.equal(sessionUi.nodes.get('session-rename-error').hidden, false);
assert.equal(sessionUi.nodes.get('save-session-rename').disabled, false, 'Failed metadata changes remain reviewable and retryable');
console.log('Session hierarchy, collapse/search, pinned rename/delete, active-job restrictions, recycle and restoration passed');

// Layout preferences run through the real UI handlers; DOM visibility is checked
// independently of classes so a visually collapsed panel cannot stay interactive.
const layoutKey = 'pi-web-layout-v1';
const layoutState = { ...snapshot, sessions: [{ id: 'session-a', workspaceId: 'workspace-a', title: '正在閱讀的對話' }] };
const storedLayout = ui => JSON.parse(ui.localStorageMap.get(layoutKey));
const clickLayout = (ui, id) => ui.nodes.get(id).onclick();
function assertLayout(ui, { left, right, header }) {
  for (const [id, toggle, collapsed, visible] of [
    ['sidebar', 'open-sidebar', 'left-collapsed', left],
    ['sources-panel', 'toggle-right-panel', 'right-collapsed', right],
    ['conversation-controls', 'toggle-header', 'header-collapsed', header],
  ]) {
    const panel = ui.nodes.get(id);
    assert.equal(panel.hidden, !visible, `${id}: hidden matches visibility`);
    assert.equal(panel.inert, !visible, `${id}: collapsed content is inert`);
    assert.equal(panel.getAttribute('aria-hidden'), String(!visible), `${id}: accessibility matches visibility`);
    assert.equal(ui.body.classList.contains(collapsed), !visible, `${id}: body layout matches visibility`);
    assert.equal(ui.nodes.get(toggle).getAttribute('aria-expanded'), String(visible));
    assert.equal(ui.nodes.get(toggle).hidden, false, `${toggle} remains available`);
  }
}
const layoutStore = new Map(), desktopUi = harness({ localStorageMap: layoutStore }); desktopUi.snapshot(layoutState);
assertLayout(desktopUi, { left: true, right: false, header: false });
assert.equal(desktopUi.body.classList.contains('desktop-layout'), true);
assert.equal(desktopUi.nodes.get('compact-session-title').textContent, '正在閱讀的對話');
assert.equal(desktopUi.nodes.get('backdrop').hidden, true);
clickLayout(desktopUi, 'open-sidebar'); clickLayout(desktopUi, 'toggle-right-panel'); clickLayout(desktopUi, 'toggle-header');
const desktopChoice = { left: false, right: true, header: true };
assertLayout(desktopUi, desktopChoice);
clickLayout(desktopUi, 'toggle-focus');
assertLayout(desktopUi, { left: false, right: false, header: false });
assert.equal(desktopUi.nodes.get('toggle-focus').getAttribute('aria-pressed'), 'true');
assert.deepEqual(storedLayout(desktopUi).desktop.restore, desktopChoice);
assert.equal(storedLayout(desktopUi).desktop.focused, true);
const restoredDesktop = harness({ localStorageMap: layoutStore }); restoredDesktop.snapshot(layoutState);
assertLayout(restoredDesktop, { left: false, right: false, header: false });
assert.equal(restoredDesktop.nodes.get('toggle-focus').getAttribute('aria-pressed'), 'true', 'Reload keeps focus mode and its restoration record');
clickLayout(restoredDesktop, 'toggle-focus');
assertLayout(restoredDesktop, desktopChoice);
assert.equal(storedLayout(restoredDesktop).desktop.restore, null);
const desktopSaved = storedLayout(restoredDesktop).desktop;

const mobileUi = harness({ width: 390, localStorageMap: layoutStore }); mobileUi.snapshot(layoutState);
assertLayout(mobileUi, { left: false, right: false, header: true });
assert.equal(mobileUi.body.classList.contains('desktop-layout'), false);
clickLayout(mobileUi, 'toggle-header'); clickLayout(mobileUi, 'open-sidebar');
assertLayout(mobileUi, { left: true, right: false, header: false });
assert.equal(mobileUi.nodes.get('sidebar').classList.contains('open'), true);
assert.equal(mobileUi.nodes.get('backdrop').hidden, false);
clickLayout(mobileUi, 'toggle-right-panel');
assertLayout(mobileUi, { left: false, right: true, header: false });
assert.equal(mobileUi.nodes.get('sidebar').classList.contains('open'), false, 'Opening the other mobile drawer closes the first');
assert.equal(mobileUi.nodes.get('sources-panel').classList.contains('open'), true);
clickLayout(mobileUi, 'toggle-focus');
assertLayout(mobileUi, { left: false, right: false, header: false });
assert.equal(mobileUi.nodes.get('backdrop').hidden, true);
assert.deepEqual(storedLayout(mobileUi).mobile.restore, { left: false, right: true, header: false });
assert.deepEqual(storedLayout(mobileUi).desktop, desktopSaved, 'Mobile changes never overwrite desktop preferences');
const restoredMobile = harness({ width: 390, localStorageMap: layoutStore }); restoredMobile.snapshot(layoutState);
assertLayout(restoredMobile, { left: false, right: false, header: false });
assert.equal(restoredMobile.nodes.get('toggle-focus').getAttribute('aria-pressed'), 'true');
clickLayout(restoredMobile, 'toggle-focus');
assertLayout(restoredMobile, { left: false, right: true, header: false });
restoredMobile.resize(768);
assert.equal(restoredMobile.body.classList.contains('desktop-layout'), true);
assertLayout(restoredMobile, desktopChoice);
assert.equal(restoredMobile.nodes.get('backdrop').hidden, true);
restoredMobile.resize(767);
assertLayout(restoredMobile, { left: false, right: false, header: false });
assert.equal(restoredMobile.nodes.get('backdrop').hidden, true, 'Returning to mobile clears transient drawers');
assert.deepEqual(storedLayout(restoredMobile).desktop, desktopSaved);

clickLayout(restoredDesktop, 'toggle-focus'); clickLayout(restoredDesktop, 'open-sidebar');
assertLayout(restoredDesktop, { left: true, right: false, header: false });
assert.equal(restoredDesktop.nodes.get('toggle-focus').getAttribute('aria-pressed'), 'false', 'Manual layout changes leave focus mode');
assert.equal(storedLayout(restoredDesktop).desktop.restore, null);
const manualReload = harness({ localStorageMap: layoutStore }); manualReload.snapshot(layoutState);
assertLayout(manualReload, { left: true, right: false, header: false });

const focusUi = harness(); focusUi.snapshot(layoutState);
focusUi.nodes.get('session-search').focus(); clickLayout(focusUi, 'open-sidebar');
assert.equal(focusUi.focused(), focusUi.nodes.get('open-sidebar'), 'Collapsing a focused sidebar moves focus to its visible toggle');
clickLayout(focusUi, 'toggle-header'); focusUi.nodes.get('choose-thinking').focus(); clickLayout(focusUi, 'toggle-header');
assert.equal(focusUi.focused(), focusUi.nodes.get('toggle-header'), 'Collapsing focused conversation controls preserves keyboard access');
clickLayout(focusUi, 'toggle-right-panel'); focusUi.nodes.get('close-sources').focus(); clickLayout(focusUi, 'toggle-right-panel');
assert.equal(focusUi.focused(), focusUi.nodes.get('toggle-right-panel'));
clickLayout(focusUi, 'toggle-header');
focusUi.nodes.get('source-toggle').focus(); clickLayout(focusUi, 'source-toggle');
assert.equal(focusUi.nodes.get('sources-panel').hidden, false);
assert.equal(focusUi.nodes.get('source-pane').hidden, false);
assert.equal(focusUi.focused(), focusUi.nodes.get('source-toggle'), 'Opening sources does not steal focus for the composer');
clickLayout(focusUi, 'toggle-right-panel');
focusUi.nodes.get('open-agents').focus(); clickLayout(focusUi, 'open-agents');
assert.equal(focusUi.nodes.get('sources-panel').hidden, false);
assert.equal(focusUi.nodes.get('agent-pane').hidden, false);
assert.equal(focusUi.focused(), focusUi.nodes.get('open-agents'), 'Opening Sub Agent leaves keyboard focus with its trigger');
focusUi.nodes.get('prompt').focus(); clickLayout(focusUi, 'toggle-right-panel');
assert.equal(focusUi.focused(), focusUi.nodes.get('prompt'), 'Hiding an unrelated panel does not move composer focus');
const readingBox = focusUi.nodes.get('chat-scroll');
readingBox.scrollHeight = 2000; readingBox.clientHeight = 300; readingBox.scrollTop = 400;
clickLayout(focusUi, 'toggle-focus');
assert.equal(readingBox.scrollTop, 400, 'A layout change preserves reading position instead of jumping to the bottom');

for (const invalid of ['invalid JSON', JSON.stringify({ desktop: { left: 'false', focused: true, restore: {} }, mobile: null })]) {
  const invalidUi = harness({ localStorageMap: new Map([[layoutKey, invalid]]) }); invalidUi.snapshot(layoutState);
  assertLayout(invalidUi, { left: true, right: false, header: false });
  assert.equal(invalidUi.nodes.get('toggle-focus').getAttribute('aria-pressed'), 'false');
}
for (const layoutUi of [desktopUi, restoredDesktop, mobileUi, restoredMobile, manualReload, focusUi]) {
  assert.equal(layoutUi.requests.length, 0, 'Layout changes never start a server request or a model call');
}
console.log('Desktop/mobile layout preferences, focus restore and reload, hidden/inert panels, reading position and keyboard focus passed');

// One long assistant message can reflow internally while its message top stays
// fixed. Keep the paragraph crossing the viewport edge at the same offset.
const paragraphUi = harness(); paragraphUi.snapshot(layoutState);
const paragraphBox = paragraphUi.nodes.get('chat-scroll'), Element = paragraphBox.constructor;
paragraphBox.scrollHeight = 5000; paragraphBox.clientHeight = 300; paragraphBox.scrollTop = 1904;
paragraphBox.getBoundingClientRect = () => ({ top: 100, bottom: 400 });
const longMessage = new Element('article'), content = new Element('div');
longMessage.className = 'message assistant'; content.className = 'message-content';
longMessage.getBoundingClientRect = () => ({ top: -1800 - (paragraphBox.scrollTop - 1904), bottom: 4000 - (paragraphBox.scrollTop - 1904) });
const paragraphs = [[-220, 66, -1200, -901], [66.2, 160, -900, -806.2], [170, 240, -790, -700]].map(([top, bottom, focusedTop, focusedBottom]) => {
  const paragraph = new Element('p');
  paragraph.getBoundingClientRect = () => {
    const focused = paragraphUi.body.classList.contains('reading-focused'), scrollDelta = paragraphBox.scrollTop - 1904;
    return { top: (focused ? focusedTop : top) - scrollDelta, bottom: (focused ? focusedBottom : bottom) - scrollDelta };
  };
  return paragraph;
});
content.append(...paragraphs); longMessage.append(content); paragraphUi.nodes.get('messages').append(longMessage);
const paragraphOffset = paragraphs[1].getBoundingClientRect().top - paragraphBox.getBoundingClientRect().top;
assert.ok(Math.abs(paragraphOffset - -33.8) < 1e-9);
clickLayout(paragraphUi, 'toggle-focus');
assert.ok(Math.abs(paragraphBox.scrollTop - 937.8) < 1e-9, 'Internal message reflow adjusts scroll by the visible paragraph displacement');
assert.ok(Math.abs(paragraphs[1].getBoundingClientRect().top - paragraphBox.getBoundingClientRect().top - paragraphOffset) < 1e-9, 'The same paragraph retains its viewport offset after reflow');
paragraphBox.scrollTop = 4700;
clickLayout(paragraphUi, 'toggle-focus');
assert.equal(paragraphBox.scrollTop, paragraphBox.scrollHeight, 'Following the bottom takes precedence over any paragraph anchor');
assert.equal(paragraphUi.requests.length, 0);
console.log('Long-message paragraph anchoring across reflow and bottom-following priority passed');

// Reproduce a wheel event arriving after a delta queued a frame but before it paints.
const streamUI = harness({ deferredFrames: true });
const streamBox = streamUI.nodes.get('chat-scroll');
streamBox.scrollHeight = 3000; streamBox.clientHeight = 500;
const streaming = { ...snapshot, busy: true, messages: [{ id: 'stream-one', role: 'assistant', text: 'First paragraphs' }] };
streamUI.snapshot(streaming); streamUI.flushFrames();
streamBox.scrollTop = 2500;
streamUI.events.emit('delta', { ...snapshot, revision: 2, id: 'stream-one', delta: ' more text' });
streamBox.listeners.wheel({ deltaY: -30 }); streamBox.scrollTop = 2470;
streamUI.flushFrames();
assert.equal(streamBox.scrollTop, 2470, 'Even a small upward wheel cancels an already queued bottom scroll');
streamBox.scrollHeight = 3500;
streamUI.snapshot({ ...streaming, revision: 3 }); streamUI.flushFrames();
assert.equal(streamBox.scrollTop, 2470, 'Tool snapshots cannot override paused reading');
assert.equal(streamUI.nodes.get('jump-latest').hidden, false);
streamUI.nodes.get('jump-latest').onclick(); streamUI.flushFrames();
assert.equal(streamBox.scrollTop, 3500);
assert.equal(streamUI.nodes.get('jump-latest').hidden, true);
streamBox.listeners.touchstart({ touches: [{ clientY: 200 }] }); streamBox.scrollTop = 1800;
streamUI.events.emit('delta', { ...snapshot, revision: 4, id: 'stream-one', delta: ' continued' }); streamUI.flushFrames();
assert.equal(streamBox.scrollTop, 1800, 'Touch reading remains independent of stream updates');
streamUI.nodes.get('toggle-header').onclick(); streamBox.listeners.keydown({ key: 'PageUp' }); streamBox.scrollTop = 1400;
streamUI.flushFrames(); assert.equal(streamBox.scrollTop, 1400, 'A pending layout frame cannot override a later keyboard scroll');
streamUI.snapshot({ ...streaming, revision: 5, sessionId: 'session-b' }); streamUI.flushFrames();
assert.equal(streamBox.scrollTop, 3500, 'Opening another conversation resumes initial positioning');
const trace = { entries: [{ id: 'tool:one', kind: 'tool', name: 'bash', state: 'running', input: '{"command":"pwd"}', output: 'partial' }], usage: { requests: 1, reported: 1, totals: { totalTokens: 100, input: 50, output: 40, cacheRead: 10, cacheWrite: 0 }, currentTurn: { requests: 1, reported: 1, totals: { totalTokens: 100, input: 50, output: 40, cacheRead: 10, cacheWrite: 0 } } } };
streamUI.snapshot({ ...streaming, revision: 6, transcript: trace }); streamUI.flushFrames();
streamUI.nodes.get('open-transcript').onclick(); streamUI.flushFrames();
assert.equal(streamUI.nodes.get('transcript-pane').hidden, false);
const detail = streamUI.nodes.get('transcript-list').children[0]; detail.open = true;
streamUI.events.emit('transcript', { ...snapshot, revision: 7, entry: { ...trace.entries[0], output: 'partial plus latest' } });
assert.equal(detail.open, true); assert.match(detail.textContent, /partial plus latest/);
assert.equal(streamUI.nodes.get('token-summary').textContent, '40', 'The footer shows turn output, excluding input and cache');
assert.match(streamUI.nodes.get('transcript-history').textContent, /100 tokens/);
assert.equal(streamUI.nodes.get('usage-history').open, false);
assert.equal(streamUI.nodes.get('sources-panel').hidden, true, 'Transcript opens in the main viewport without opening the side panel');
assert.ok(streamBox.contains(streamUI.nodes.get('transcript-pane')));
assert.equal(streamUI.nodes.get('conversation-pane').hidden, true);
assert.equal(streamUI.nodes.get('jump-latest').hidden, true);
const usageRequest = streamUI.requests.at(-1);
assert.equal(usageRequest.url, '/api/usage');
usageRequest.answer({ contextTokens: 120, contextWindow: 1000, contextPercent: 12 }); await tick();
assert.match(streamUI.nodes.get('usage-context').textContent, /120 \/ 1,000 tokens（12.0%）/);
streamBox.scrollTop = 125;
streamUI.events.emit('delta', { ...snapshot, revision: 8, id: 'stream-one', delta: ' growing in hidden chat' }); streamUI.flushFrames();
assert.equal(streamBox.scrollTop, 125, 'Chat streaming does not scroll the Transcript');
streamUI.nodes.get('back-to-chat').onclick(); streamUI.flushFrames();
assert.equal(streamUI.nodes.get('conversation-pane').hidden, false);
assert.equal(streamBox.scrollTop, 3500, 'Returning to chat restores its separate position');
streamUI.nodes.get('open-transcript').onclick(); streamUI.flushFrames();
assert.equal(streamBox.scrollTop, 125, 'Returning to Transcript restores its own position');
const staleUsage = streamUI.requests.at(-1);
streamUI.snapshot({ ...streaming, sessionId: 'session-c', revision: 9 }); streamUI.flushFrames();
assert.equal(streamUI.nodes.get('transcript-list').children.length, 0, 'Transcript cannot leak into the next Session');
console.log('Streaming wheel/touch/keyboard intent, cancelled RAF, latest button and stable Transcript details passed');

staleUsage.answer({ contextTokens: 999, contextWindow: 1000, contextPercent: 99.9 }); await tick();
assert.equal(streamUI.nodes.get('transcript-pane').hidden, true);
assert.doesNotMatch(streamUI.nodes.get('usage-context').textContent, /999/);
streamUI.nodes.get('open-transcript').onclick(); streamUI.flushFrames();
const oldModelUsage = streamUI.requests.at(-1);
streamUI.snapshot({ ...streaming, sessionId: 'session-c', model: 'changed', revision: 10 });
oldModelUsage.answer({ contextTokens: 888, contextWindow: 1000, contextPercent: 88.8 }); await tick();
assert.doesNotMatch(streamUI.nodes.get('usage-context').textContent, /888|正在取得/);
assert.equal(streamUI.nodes.get('refresh-usage').disabled, false);
const placeholders = harness(); placeholders.snapshot({ ...snapshot, busy: true, messages: [
  { id: 'past', role: 'assistant', text: '', streaming: false },
  { id: 'current', role: 'assistant', text: '', streaming: true },
] });
const [past, current] = placeholders.nodes.get('messages').children;
assert.equal(past.hidden, true); assert.equal(current.hidden, false);
assert.equal(current.querySelector('.message-content').innerHTML, '正在思考…');
placeholders.snapshot({ ...snapshot, revision: 2, messages: [
  { id: 'past', role: 'assistant', text: '', streaming: false },
  { id: 'current', role: 'assistant', text: '', streaming: false },
] });
assert.equal(current.hidden, true);
console.log('Main Transcript navigation, turn/context/history separation, stale usage and stream-only placeholders passed');
