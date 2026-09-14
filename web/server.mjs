import http from 'node:http';
import { createImageStore } from './images.mjs';
import { Transcript, visibleThinking } from './transcript.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSessionLibrary } from './session-library.mjs';
import { WEB_COMMANDS, TERMINAL_COMMANDS, safeCommands, commandCatalog, parseSlash, safeModels } from './commands.mjs';
import { safeThinkingLevels, safeSessionInfo, safeForkMessages, safeCompactionResult, normalizeQueue } from './agent-controls.mjs';
import { createSubagentManager } from './subagents.mjs';
import { createSubagentBridge } from './subagent-bridge.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|local-[0-9a-f]{32})$/;
const MODES = new Set(['general', 'study', 'research']);
const clip = (v, n = 16000) => typeof v === 'string' ? v.slice(0, n) : '';
const textOf = content => typeof content === 'string' ? content : (Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join('\n') : '');
const parsed = value => { try { return JSON.parse(textOf(value)); } catch { return null; } };
const inside = (parent, child) => { const p = relative(parent, child); return !!p && !p.startsWith('..') && !isAbsolute(p); };
const fail = (status, message) => Object.assign(new Error(message), { status });
const safeError = e => clip(e?.message || String(e), 1400).replace(/\b(?:Bearer\s+|sk-[a-zA-Z0-9_-]{5})\S*/gi, '[已隱藏憑證]').replace(/(authorization|api[_-]?key|access[_-]?token)\s*[:=]\s*[^\s,;]+/gi, '$1=[已隱藏憑證]');

/** Only LF delimits JSONL. U+2028 and U+2029 are valid JSON string content. */
export class PiRpc {
  constructor({ command = 'pi', args = [], cwd, env = process.env, onEvent = () => {}, onExit = () => {} }) {
    this.pending = new Map(); this.buffer = ''; this.closed = false; this.onEvent = onEvent;
    this.child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 16 * 1024 * 1024) { this.close(); onExit(new Error('Pi 回應超過讀取上限，請重新開啟對話。')); return; }
      let end;
      while ((end = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, end).replace(/\r$/, ''); this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'response') {
          const item = this.pending.get(event.id);
          if (item) { this.pending.delete(event.id); clearTimeout(item.timer); event.success ? item.resolve(event.data) : item.reject(new Error(safeError(event.error || 'Pi 拒絕此操作'))); }
        } else onEvent(event);
      }
    });
    // Diagnostics can contain provider headers. Never forward stderr to the browser.
    this.child.stderr.on('data', () => {});
    const ended = error => {
      if (this.closed) return;
      this.closed = true;
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
      this.pending.clear(); onExit(error);
    };
    this.child.once('error', error => ended(new Error(`無法啟動 Pi：${safeError(error)}`)));
    this.child.once('exit', code => ended(new Error(`Pi 已離線（退出代碼 ${code ?? 'signal'}），請重新開啟對話。`)));
    this.child.stdin.on('error', () => {});
  }
  send(value) {
    if (this.closed || !this.child.stdin.writable) throw new Error('Pi 尚未連線。');
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  request(type, payload = {}, timeout = 45000) {
    if (this.closed) return Promise.reject(new Error('Pi 尚未連線。'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Pi 回應逾時；請檢查連線後重試。')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ ...payload, type, id }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('Pi 連線已關閉。')); }
    this.pending.clear(); this.child.stdin.end(); this.child.kill('SIGTERM');
    const timer = setTimeout(() => { if (this.child.exitCode === null) this.child.kill('SIGKILL'); }, 2500); timer.unref();
  }
}

/** A bounded, presentation-only view; credentials/model configuration are never serialized. */
export class ConversationView {
  constructor(imageStore) { this.imageStore = imageStore; this.reset(); }
  reset() {
    this.transcript = new Transcript(); this.messages = []; this.sources = new Map(); this.tools = new Map(); this.dialogs = new Map(); this.dialogTimers = new Map();
    this.mode = 'general'; this.modeState = null; this.question = ''; this.topic = ''; this.context = null; this.focus = null; this.busy = false; this.error = ''; this.notice = ''; this.notes = []; this.status = ''; this.streaming = null; this.streamingBlocks = new Map(); this.streamingThinkingBlocks = new Map();
  }
  message(message, complete = true) {
    if (!message) return;
    if (message.role === 'custom') {
      const value = parsed(message.content);
      if (!value) return;
      if (message.customType === 'pi-mode-state' && MODES.has(value.mode)) {
        this.mode = value.mode; this.question = clip(value.question, 1000); this.topic = clip(value.topic, 100);
        this.modeState = { mode: this.mode, question: this.question, topic: this.topic };
      }
      if (message.customType === 'pi-mode-error') this.error = safeError(value.error || '模式操作失敗。');
      if (message.customType === 'pi-study-state') {
        this.focus = value.focus;
        this.context = { status: clip(value.status, 500), focus: value.focus?.mode, current: clip(value.current?.path, 2000) };
      }
      if (message.customType === 'pi-note-list') this.notes = (Array.isArray(value.notes) ? value.notes : []).slice(0, 100).filter(n => typeof n.path === 'string').map(n => ({ path: clip(n.path, 2000), title: clip(n.title || n.path, 250) }));
      if (message.customType === 'study-context') {
        this.context = { status: clip(value.status, 500), focus: value.focus?.mode, current: clip(value.current?.path, 2000), truncated: !!value.current?.truncated, omitted: !!value.currentOmittedAsUnrelated, error: clip(value.error, 700) };
        if (MODES.has(value.mode)) this.mode = value.mode;
        this.collectSources(value);
      }
      return;
    }
    if (message.role === 'bashExecution') { this.transcript.message(message, randomUUID()); return; }
    if (message.role === 'toolResult') { this.transcript.message(message); this.collectResult(message.content); return; }
    if (!['user', 'assistant'].includes(message.role)) return;
    const item = { id: randomUUID(), role: message.role, streaming: !complete, text: clip(textOf(message.content), 120000), timestamp: message.timestamp || Date.now(), error: message.role === 'assistant' && message.stopReason === 'error' ? safeError(message.errorMessage || '模型回應失敗') : '' };
    if (message.role === 'assistant') item.thinking = visibleThinking(message.content);
    const images = this.imageStore?.project(message.content) || [];
    if (images.length) item.images = images;
    this.transcript.message(message, item.id, complete); this.messages.push(item); this.trimMessages(); return item;
  }
  trimMessages() {
    let chars = this.messages.reduce((n, m) => n + m.text.length + (m.thinking?.length || 0), 0);
    while (this.messages.length > 1 && (this.messages.length > 300 || chars > 1200000)) {
      const removed = this.messages.shift(); chars -= removed.text.length + (removed.thinking?.length || 0);
    }
  }
  collectResult(content) { const value = parsed(content); if (value) this.collectSources(value); }
  collectSources(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 8) return;
    if (Array.isArray(value)) { for (const v of value.slice(0, 100)) this.collectSources(v, depth + 1); return; }
    const content = typeof value.content === 'string' ? value.content : typeof value.quote === 'string' ? value.quote : '';
    if (typeof value.path === 'string' && typeof value.sha256 === 'string' && content) {
      const full = clip(content, 60000), path = clip(value.path, 2000), sha256 = clip(value.sha256, 128);
      const id = createHash('sha256').update(`${path}\0${sha256}\0${full}`).digest('hex').slice(0, 32);
      if (!this.sources.has(id)) this.sources.set(id, { id, path, title: clip(value.title || path.split('/').at(-1), 250), sha256, content: full,
        startLine: value.startLine, endLine: value.endLine, totalLines: value.totalLines, truncated: !!value.truncated || content.length > full.length,
        sourceId: clip(value.sourceId, 100), url: /^https?:\/\//.test(value.url || '') ? clip(value.url, 2000) : undefined,
        kind: typeof value.quote === 'string' ? 'quote' : 'excerpt', status: ['fresh', 'changed', 'missing'].includes(value.freshness) ? value.freshness : undefined });
      while (this.sources.size > 100) this.sources.delete(this.sources.keys().next().value);
    }
    for (const [key, child] of Object.entries(value)) if (key !== 'content' && key !== 'quote') this.collectSources(child, depth + 1);
  }
  snapshot() {
    return { transcript: this.transcript.snapshot(), messages: this.messages, sources: [...this.sources.values()].map(({ content, ...meta }) => meta), tools: [...this.tools.values()], dialogs: [...this.dialogs.values()],
      mode: this.mode, question: this.question, topic: this.topic, context: this.context, busy: this.busy, error: this.error, notice: this.notice, status: this.status };
  }
}

export async function createWebServer(options = {}) {
  const runtimeEnv = options.env || process.env;
  const userHome = runtimeEnv.HOME || homedir();
  const defaultWorkspace = resolve(options.workspace || runtimeEnv.PI_WEB_WORKSPACE || userHome);
  const dataDir = resolve(options.dataDir || process.env.PI_WEB_DATA_DIR || join(homedir(), '.local/share/zen-pi-web'));
  const sessionDir = join(dataDir, 'sessions');
  await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 }); await fs.chmod(dataDir, 0o700); await fs.chmod(sessionDir, 0o700);
  const realSessionDir = await fs.realpath(sessionDir);
  const imageStore = await createImageStore(join(dataDir, 'images'));
  const manifestPath = join(dataDir, 'sessions.json');
  const publicOrigin = options.publicOrigin ?? process.env.PI_WEB_PUBLIC_ORIGIN ?? '';
  const tailscaleUser = options.tailscaleUser ?? process.env.PI_WEB_TAILSCALE_USER ?? '';
  let publicURL;
  if (publicOrigin) {
    publicURL = new URL(publicOrigin);
    if (publicURL.protocol !== 'https:' || publicURL.username || publicURL.password || publicURL.origin !== publicOrigin) throw new Error('PI_WEB_PUBLIC_ORIGIN 必須是完整 HTTPS origin，不能包含路徑或結尾斜線。');
    if (!tailscaleUser.trim()) throw new Error('外部網址必須同時設定 PI_WEB_TAILSCALE_USER，限制可操作的 Tailscale 帳號。');
  }
  const agentDir = runtimeEnv.PI_CODING_AGENT_DIR || join(userHome, '.pi/agent');
  const expandPath = value => resolve(defaultWorkspace, value === '~' ? userHome : value.startsWith('~/') ? join(userHome, value.slice(2)) : value);
  let configuredSessionDir;
  if (options.sessionRoots === undefined) {
    try {
      const file = join(agentDir, 'settings.json');
      if ((await fs.stat(file)).size < 1024 * 1024) {
        const value = JSON.parse(await fs.readFile(file, 'utf8')).sessionDir;
        if (typeof value === 'string' && value.trim()) configuredSessionDir = expandPath(value);
      }
    } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
  }
  const roots = options.sessionRoots ?? [join(agentDir, 'sessions'), configuredSessionDir,
    runtimeEnv.PI_CODING_AGENT_SESSION_DIR && expandPath(runtimeEnv.PI_CODING_AGENT_SESSION_DIR),
    ...(runtimeEnv.PI_WEB_SESSION_ROOTS || '').split(delimiter).filter(Boolean).map(expandPath)].filter(Boolean);
  const library = await createSessionLibrary({ roots: [sessionDir, ...roots], piPackageDir: options.piPackageDir });
  // Preferences belong to the Web library; native Pi JSONL files stay untouched.
  const validTitle = value => typeof value === 'string' && !!value.trim() && value.length <= 160 && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value);
  let manifest = { version: 3, sessions: [], activeId: null, workspaceId: null, workspacePaths: [], sessionPreferences: {} };
  try {
    const st = await fs.stat(manifestPath); if (st.size > 2 * 1024 * 1024) throw new Error('對話索引過大');
    const input = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.sessions = (input.sessions || []).filter(s => UUID.test(s.id) && typeof s.file === 'string' && inside(sessionDir, resolve(s.file)));
    manifest.activeId = SESSION_ID.test(input.activeId || '') ? input.activeId : null;
    manifest.workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId : null;
    manifest.workspacePaths = (input.workspacePaths || []).filter(p => typeof p === 'string' && isAbsolute(p) && !/[\r\n\0]/.test(p)).slice(0, 100);
    for (const [id, item] of Object.entries(input.sessionPreferences || {})) {
      if (!SESSION_ID.test(id) || !item || typeof item !== 'object') continue;
      const preference = {};
      if (validTitle(item.title)) preference.title = item.title.trim();
      if (typeof item.deletedAt === 'string' && Number.isFinite(Date.parse(item.deletedAt))) preference.deletedAt = item.deletedAt;
      if (Object.keys(preference).length) manifest.sessionPreferences[id] = preference;
    }
  } catch (e) { if (e.code !== 'ENOENT') throw new Error(`無法讀取 Web 對話索引：${safeError(e)}`); }
  let persistQueue = Promise.resolve();
  const persist = () => {
    const data = JSON.stringify(manifest, null, 2);
    const operation = persistQueue.catch(() => {}).then(async () => { const tmp = `${manifestPath}.tmp`; await fs.writeFile(tmp, data, { mode: 0o600 }); await fs.rename(tmp, manifestPath); });
    persistQueue = operation; return operation;
  };
  // Each request and RPC event retains its own conversation across awaits.
  const contexts = new AsyncLocalStorage(), runtimes = new Map(), subagentAdmissions = new Map();
  const makeRuntime = id => ({ id, view: new ConversationView(imageStore), queuedImages: { steering: [], followUp: [] }, rpc: undefined, modelLabel: '', generation: 0,
    stopping: false, runtimeCommands: undefined, loadedLocalRevision: undefined, thinkingLevel: null,
    nativeSessionId: null, epoch: 0, operation: null, queue: { steering: [], followUp: [] }, serial: Promise.resolve() });
  const emptyRuntime = makeRuntime(null);
  const selectedRuntime = () => runtimes.get(manifest.activeId) || emptyRuntime;
  const runtime = () => contexts.getStore() || selectedRuntime();
  const view = new Proxy({}, {
    get: (_, key) => runtime().view[key],
    set: (_, key, value) => { runtime().view[key] = value; return true; },
  });
  const clients = new Set(); const startedAt = Date.now(), serverId = randomUUID();
  let closed = false, revision = 0, navigation = Promise.resolve();
  let catalog = new Map(), workspaces = [], libraryIssues = [];
  let subagents, subagentBridge;
  const isDeleted = id => !!manifest.sessionPreferences[id]?.deletedAt;
  const active = () => { const id = contexts.getStore()?.id ?? manifest.activeId; return isDeleted(id) ? undefined : catalog.get(id) || manifest.sessions.find(s => s.id === id); };
  const deleteReason = id => {
    const owner = runtimes.get(id);
    if (owner?.view.busy || owner?.stopping || owner?.operation) return '這個對話正在處理中，請完成或停止後再刪除。';
    if (subagentAdmissions.get(id) || subagents?.hasActiveParent(id)) return '這個對話還有 Sub Agent 等候或執行中，請完成或取消子任務後再刪除。';
    return '';
  };
  const sessions = (deleted = false) => [...catalog.values()].filter(s => isDeleted(s.id) === deleted).map(s => ({
    id: s.id, title: manifest.sessionPreferences[s.id]?.title ?? s.title, createdAt: s.createdAt, updatedAt: s.updatedAt,
    workspaceId: s.workspaceId, origin: s.origin, messageCount: s.messageCount ?? null, parentId: s.parentId, kind: s.kind || 'chat',
    busy: !!runtimes.get(s.id)?.view.busy, operation: runtimes.get(s.id)?.operation || null,
    deleteBlockedReason: deleted ? '' : deleteReason(s.id), deletedAt: manifest.sessionPreferences[s.id]?.deletedAt,
  })).sort((a, b) => (deleted ? b.deletedAt.localeCompare(a.deletedAt) : b.updatedAt.localeCompare(a.updatedAt)));
  const selectedWorkspace = () => workspaces.find(w => w.id === (contexts.getStore()?.id ? active()?.workspaceId : manifest.workspaceId));
  const snapshot = () => contexts.run(selectedRuntime(), () => ({ ...view.snapshot(), sessionId: manifest.activeId, workspaceId: manifest.workspaceId, workspaces, sessions: sessions(), deletedSessions: sessions(true),
    readOnly: active()?.origin === 'local', canContinue: active()?.origin === 'local' && active()?.readable !== false && !!selectedWorkspace()?.available,
    origin: active()?.origin || null, libraryIssueCount: libraryIssues.length, commands: commandCatalog(runtime().runtimeCommands),
    model: runtime().modelLabel, thinkingLevel: runtime().thinkingLevel, operation: runtime().operation, queue: runtime().queue, queuedImages: runtime().queuedImages,
    subagents: subagents?.list({ workspaceId: manifest.workspaceId }) || [],
    online: !!runtime().rpc && !runtime().rpc.closed && active()?.origin !== 'local', revision, startedAt, serverId }));
  async function refreshLibrary() {
    const discovered = await library.scan(); libraryIssues = discovered.issues;
    const workspaceMap = new Map();
    const workspaceCache = new Map();
    async function workspaceFor(raw) {
      const path = typeof raw === 'string' && isAbsolute(raw) && !/[\r\n\0]/.test(raw) ? resolve(raw) : null;
      if (workspaceCache.has(path)) return workspaceCache.get(path);
      let canonical = path, available = false;
      if (path) try { canonical = await fs.realpath(path); available = (await fs.stat(canonical)).isDirectory(); } catch {}
      const id = `ws-${createHash('sha256').update(canonical || 'unknown').digest('hex').slice(0, 32)}`;
      let item = workspaceMap.get(id);
      if (!item) { item = { id, name: canonical === userHome ? '個人空間' : canonical ? basename(canonical) || canonical : '未分類', path: canonical, available, sessionCount: 0 }; workspaceMap.set(id, item); }
      workspaceCache.set(path, item); return item;
    }
    const fallback = await workspaceFor(defaultWorkspace);
    for (const path of manifest.workspacePaths) await workspaceFor(path);
    const found = new Map(discovered.sessions.map(s => [s.file, s]));
    const next = new Map();
    for (const saved of manifest.sessions) {
      let file = saved.file;
      try { file = await fs.realpath(file); } catch {}
      const disk = found.get(file); found.delete(file);
      saved.cwd = disk?.cwd || saved.cwd || defaultWorkspace;
      saved.workspaceId = (await workspaceFor(saved.cwd)).id;
      saved.origin = 'web'; saved.messageCount = disk?.messageCount ?? saved.messageCount ?? null;
      if (disk) { saved.updatedAt = disk.updatedAt > saved.updatedAt ? disk.updatedAt : saved.updatedAt; if (disk.title && saved.title === '新對話') saved.title = disk.title; }
      if (manifest.sessionPreferences[saved.id]?.title) saved.title = manifest.sessionPreferences[saved.id].title;
      next.set(saved.id, saved);
    }
    for (const disk of found.values()) {
      const workspace = await workspaceFor(disk.cwd);
      next.set(disk.id, { ...disk, title: manifest.sessionPreferences[disk.id]?.title ?? disk.title, origin: 'local', workspaceId: workspace.id });
    }
    for (const record of next.values()) if (!isDeleted(record.id)) workspaceMap.get(record.workspaceId).sessionCount++;
    catalog = next;
    workspaces = [...workspaceMap.values()].sort((a, b) => a.name.localeCompare(b.name) || (a.path || '').localeCompare(b.path || ''));
    const selected = isDeleted(manifest.activeId) ? undefined : catalog.get(manifest.activeId);
    if (selected) manifest.workspaceId = selected.workspaceId;
    else if (!workspaceMap.has(manifest.workspaceId)) manifest.workspaceId = fallback.id;
    if (manifest.activeId && !selected) {
      manifest.activeId = null;
      contexts.run(emptyRuntime, () => {
        clearDialogs(); view.reset(); runtime().modelLabel = '';
        view.notice = '這份對話已移走或刪除，請從清單選擇其他對話。';
      });
    }
  }
  const broadcast = (type, payload = {}) => {
    // Background text is already retained in its own view. Do not resend the
    // selected conversation's entire history for every background token.
    if (type !== 'snapshot' && runtime().id !== manifest.activeId) return;
    const frame = `event: ${type}\ndata: ${JSON.stringify({ ...payload, revision: ++revision, startedAt, serverId })}\n\n`;
    for (const res of clients) { if (res.writableLength > 1024 * 1024) { res.destroy(); clients.delete(res); } else res.write(frame); }
  };
  const changed = () => broadcast('snapshot', snapshot());
  const mutate = (operation, navigate = false, changesOwnership = false) => {
    const owner = runtime();
    const previous = navigate ? navigation : owner.serial;
    const pending = [previous.catch(() => {})];
    if (navigate && changesOwnership) pending.push(owner.serial.catch(() => {}));
    const p = Promise.all(pending).then(() => contexts.run(owner, () => {
      if (closed) throw fail(503, '服務正在關閉。'); return operation();
    }));
    if (navigate) navigation = p;
    if (!navigate || changesOwnership) owner.serial = p;
    return p;
  };
  const clearDialogs = () => {
    for (const timer of view.dialogTimers.values()) clearTimeout(timer);
    view.dialogTimers.clear(); view.dialogs.clear();
  };
  const consume = event => {
    if (event.type === 'agent_start') { view.busy = true; view.error = ''; changed(); }
    if (event.type === 'agent_settled') {
      view.busy = false; view.transcript.settle(); if (view.streaming) view.streaming.streaming = false; view.streaming = null; runtime().queue = { steering: [], followUp: [] }; runtime().queuedImages = { steering: [], followUp: [] }; clearDialogs(); changed();
      void rememberSession().then(changed).catch(() => {});
    }
    if (event.type === 'message_start' && event.message?.role === 'user') {
      const text = textOf(event.message.content), images = imageStore.project(event.message.content);
      for (const key of ['steering', 'followUp']) {
        const index = runtime().queue[key].findIndex((message, i) => message === text && JSON.stringify(runtime().queuedImages[key][i] || []) === JSON.stringify(images));
        if (index !== -1) { runtime().queue[key].splice(index, 1); runtime().queuedImages[key].splice(index, 1); changed(); break; }
      }
    }
    if (event.type === 'message_start' && event.message?.role === 'assistant') {
      // Pi's start event can reference a partial that has already advanced to the
      // first delta. Assemble text blocks from deltas to avoid counting it twice.
      view.streamingBlocks.clear(); view.streamingThinkingBlocks.clear();
      view.streaming = view.message({ ...event.message, content: [] }, false); broadcast('message', view.streaming);
      broadcast('transcript', { entry: view.transcript.entries.get(view.streaming.id), omitted: view.transcript.omitted, retainedIds: [...view.transcript.entries.keys()] });
    }
    if (event.type === 'message_update') {
      const e = event.assistantMessageEvent;
      if (view.streaming && ['thinking_start', 'thinking_delta', 'thinking_end'].includes(e?.type)) {
        const index = Number.isInteger(e.contentIndex) ? e.contentIndex : 0;
        const blocks = view.streamingThinkingBlocks;
        if (!blocks.has(index) && blocks.size >= 64) return;
        const otherLength = [...blocks].reduce((total, [key, text]) => total + (key === index ? 0 : text.length), 0);
        const content = e.type === 'thinking_start' ? '' : e.type === 'thinking_end' ? clip(e.content, 120000) : (blocks.get(index) || '') + clip(e.delta, 120000);
        blocks.set(index, clip(content, Math.max(0, 120000 - otherLength)));
        const thinking = visibleThinking([{ type: 'thinking', thinking: [...blocks].sort(([a], [b]) => a - b).map(([, text]) => text).join('\n') }]);
        if (thinking !== view.streaming.thinking) {
          view.streaming.thinking = thinking;
          const entry = view.transcript.setThinking(view.streaming.id, thinking);
          broadcast('thinking', { id: view.streaming.id, thinking });
          if (entry) broadcast('transcript', { entry, omitted: view.transcript.omitted, retainedIds: [...view.transcript.entries.keys()] });
        }
      }
      if (view.streaming && ['text_start', 'text_delta', 'text_end'].includes(e?.type)) {
        const index = Number.isInteger(e.contentIndex) ? e.contentIndex : 0;
        if (!view.streamingBlocks.has(index) && view.streamingBlocks.size >= 64) return;
        const before = view.streaming.text;
        const otherLength = [...view.streamingBlocks].reduce((total, [key, text]) => total + (key === index ? 0 : text.length), 0);
        const content = e.type === 'text_start' ? '' : e.type === 'text_end' ? clip(e.content, 120000) : (view.streamingBlocks.get(index) || '') + clip(e.delta, 120000);
        view.streamingBlocks.set(index, clip(content, Math.max(0, 120000 - otherLength)));
        view.streaming.text = [...view.streamingBlocks].sort(([a], [b]) => a - b).map(([, text]) => text).join('\n').slice(0, 120000);
        if (view.streaming.text !== before) {
          if (view.streaming.text.startsWith(before)) broadcast('delta', { id: view.streaming.id, delta: view.streaming.text.slice(before.length) });
          else changed();
        }
      }
    }
    if (event.type === 'message_end') {
      const msg = event.message;
      if (msg?.role === 'assistant' && view.streaming) {
        view.streaming.streaming = false;
        view.transcript.message(msg, view.streaming.id);
        view.streaming.text = clip(textOf(msg.content), 120000);
        view.streaming.thinking = visibleThinking(msg.content);
        view.streaming.error = msg.stopReason === 'error' ? safeError(msg.errorMessage || '模型回應失敗') : '';
        if (view.streaming.error) view.error = view.streaming.error;
        view.streaming = null; view.trimMessages();
      } else view.message(msg);
      changed();
    }
    if (['tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(event.type)) {
      const entry = view.transcript.tool(event);
      if (event.type === 'tool_execution_update') { if (entry) broadcast('transcript', { entry, omitted: view.transcript.omitted, retainedIds: [...view.transcript.entries.keys()] }); return; }
    }
    if (event.type === 'tool_execution_start') {
      view.tools.set(event.toolCallId, { id: event.toolCallId, name: clip(event.toolName, 100), state: 'running' });
      while (view.tools.size > 24) view.tools.delete(view.tools.keys().next().value); changed();
    }
    if (event.type === 'tool_execution_end') {
      const old = view.tools.get(event.toolCallId) || { id: event.toolCallId, name: clip(event.toolName, 100) };
      view.tools.set(event.toolCallId, { ...old, state: event.isError ? 'error' : 'done' });
      view.collectResult(event.result?.content); changed();
    }
    if (event.type === 'extension_error') { view.error = safeError(event.error || 'Pi extension 執行失敗'); changed(); }
    if (event.type === 'extension_ui_request') {
      if (['confirm', 'select', 'input', 'editor'].includes(event.method)) {
        const dialog = { id: clip(event.id, 200), method: event.method, title: clip(event.title, 2000), message: clip(event.message, 8000),
          options: Array.isArray(event.options) ? event.options.slice(0, 100).map(o => clip(o, 2000)) : undefined,
          placeholder: clip(event.placeholder, 1000), prefill: clip(event.prefill, 16000) };
        if (view.dialogs.size >= 8) { runtime().rpc?.send({ type: 'extension_ui_response', id: event.id, cancelled: true }); return; }
        view.dialogs.set(dialog.id, dialog);
        const timer = setTimeout(() => {
          if (view.dialogs.delete(dialog.id)) { try { runtime().rpc?.send({ type: 'extension_ui_response', id: dialog.id, cancelled: true }); } catch {} view.dialogTimers.delete(dialog.id); changed(); }
        }, Math.min(typeof event.timeout === 'number' ? Math.max(100, event.timeout) : 10 * 60 * 1000, 10 * 60 * 1000));
        timer.unref(); view.dialogTimers.set(dialog.id, timer);
      } else if (event.method === 'notify') {
        const value = parsed(event.message);
        // /mode status also sends a terminal notification. Its structured state
        // is already shown by the mode controls; keep unrelated notifications.
        const duplicateModeStatus = (!event.notifyType || event.notifyType === 'info') && view.modeState && value &&
          Object.keys(value).every(key => ['mode', 'question', 'topic'].includes(key)) &&
          value.mode === view.modeState.mode && (value.question ?? '') === view.modeState.question && (value.topic ?? '') === view.modeState.topic;
        if (duplicateModeStatus) return;
        if (event.notifyType === 'error') view.error = safeError(event.message);
        else view.notice = clip(event.message, 2000);
      } else if (event.method === 'setStatus' && event.statusKey === 'pentest-study') view.status = clip(event.statusText, 500);
      else if (event.method === 'set_editor_text') broadcast('editor', { text: clip(event.text, 32000) });
      changed();
    }
  };
  async function rememberSession() {
    const owner = runtime(), ownerId = owner.id, epoch = owner.epoch, targetRpc = owner.rpc;
    const state = await targetRpc.request('get_state');
    const file = resolve(state.sessionFile || '');
    if (!inside(sessionDir, file) || !file.endsWith('.jsonl')) throw new Error('Pi 未使用指定的 Web 對話資料夾。');
    const parent = await fs.realpath(dirname(file));
    if (parent !== realSessionDir && !inside(realSessionDir, parent)) throw new Error('Pi 對話路徑不在允許範圍。');
    let draft = false;
    try { await fs.access(file); } catch (error) { if (error.code !== 'ENOENT') throw error; draft = true; }
    // A late autosave from before fork/clone must never attach its old file to
    // the newly selected branch. All filesystem awaits precede this check.
    if (owner.id !== ownerId || owner.epoch !== epoch || owner.rpc !== targetRpc || targetRpc.closed || isDeleted(ownerId)) return state;
    const record = catalog.get(ownerId) || manifest.sessions.find(item => item.id === ownerId);
    if (record?.origin === 'local') throw new Error('本機對話紀錄只能檢視；請先接續成新對話。');
    if (record) {
      record.file = file; record.updatedAt = new Date().toISOString(); record.draft = draft;
      record.draftState = draft ? { mode: owner.view.mode, focus: owner.view.focus,
        model: state.model ? { provider: state.model.provider, id: state.model.id } : undefined,
        thinkingLevel: state.thinkingLevel, name: state.sessionName } : undefined;
    }
    owner.modelLabel = state.model ? clip(`${state.model.provider || ''} / ${state.model.name || state.model.id || ''}`, 200) : '尚未設定模型';
    owner.thinkingLevel = typeof state.thinkingLevel === 'string' ? state.thinkingLevel : null;
    owner.nativeSessionId = state.sessionId;
    owner.view.busy = !!state.isStreaming || !!state.isCompacting;
    if (record) { await refreshLibrary(); await persist(); }
    return state;
  }
  async function loadView(save = true) {
    clearDialogs(); view.reset();
    let messages;
    // get_messages is the model context and drops pre-compaction history. The
    // Web reader uses the saved active branch, through the existing file allowlist.
    try {
      const current = await runtime().rpc.request('get_state');
      const file = typeof current.sessionFile === 'string' ? await fs.realpath(current.sessionFile) : null;
      if (file && inside(realSessionDir, file)) {
        await library.scan();
        const { branch } = await library.read(file);
        messages = branch.flatMap(entry => entry.type === 'message' ? [entry.message] : entry.type === 'custom_message' ? [{ ...entry, role: 'custom' }] : []);
      }
    } catch { /* A new draft may not have a JSONL file yet; use Pi's memory. */ }
    messages ??= (await runtime().rpc.request('get_messages'))?.messages || [];
    for (const message of messages) view.message(message);
    view.transcript.settle();
    // Extension state can exist before the first model message or after compaction.
    const commands = await runtime().rpc.request('get_commands');
    runtime().runtimeCommands = safeCommands(commands?.commands);
    const available = new Set((commands?.commands || []).map(c => c.name));
    if (!['mode', 'study', 'study-status', 'study-notes'].every(name => available.has(name))) throw new Error('目前 Pi 尚未載入完整的新版 Mode extension，請完成安裝後重新開啟。');
    await runtime().rpc.request('prompt', { message: '/mode status' });
    if (available.has('study-status')) await runtime().rpc.request('prompt', { message: '/study-status' });
    const state = save ? await rememberSession() : await runtime().rpc.request('get_state');
    if (save) changed(); return state;
  }
  async function start(record, fork) {
    let owner = runtimes.get(record.id);
    if (!fork && owner?.rpc && !owner.rpc.closed) { changed(); return; }
    if (!owner) { owner = makeRuntime(record.id); runtimes.set(record.id, owner); }
    const others = [...runtimes.values()].filter(item => item.id !== record.id && item.rpc && !item.rpc.closed);
    if (others.length >= 8) {
      const idle = others.find(item => !item.view.busy && !item.operation && !item.stopping);
      if (!idle) throw fail(429, '已有 8 個對話執行中，請先完成或停止其中一個。');
      contexts.run(idle, () => { idle.generation++; clearDialogs(); idle.rpc.close(); });
      runtimes.delete(idle.id);
    }
    return contexts.run(owner, async () => {
      try { return await startRuntime(record, fork); }
      catch (error) { owner.rpc?.close(); owner.view.busy = false; owner.view.error = safeError(error); changed(); throw error; }
    });
  }
  async function startRuntime(record, fork) {
    const owner = runtime();
    runtime().generation++; const currentGeneration = runtime().generation;
    const draftState = record?.draftState;
    let restoreDraft = false;
    runtime().rpc?.close(); clearDialogs(); view.reset(); runtime().runtimeCommands = undefined; runtime().modelLabel = '';
    const args = [...(options.piArgs || []), '--mode', 'rpc', '--session-dir', sessionDir,
      '-e', join(here, '../extensions/subagents/index.ts')];
    if (fork) args.push('--fork', fork);
    else if (record?.file) {
      try {
        const real = await fs.realpath(record.file);
        if (!inside(realSessionDir, real)) throw new Error('對話檔案不在 Web 資料夾。');
        args.push('--session', real);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        if (!record.draft) throw new Error('已保存的對話檔案不存在，無法重新開啟。');
        restoreDraft = true;
      }
    }
    if (closed) throw fail(503, '服務正在關閉。');
    const cwd = record?.cwd || defaultWorkspace;
    if (!(await fs.stat(cwd)).isDirectory()) throw new Error('Workspace 的工作目錄不存在。');
    runtime().rpc = new PiRpc({ command: options.piBin || process.env.PI_WEB_PI_BIN || 'pi', args,
      cwd, env: { ...runtimeEnv, PI_WEB_SUBAGENT_SOCKET: subagentBridge.socketPath },
      onEvent: e => contexts.run(owner, () => { if (owner.generation === currentGeneration && !closed) consume(e); }),
      onExit: error => contexts.run(owner, () => { if (owner.generation === currentGeneration && !closed) { view.error = safeError(error); view.busy = false; view.transcript.settle(); if (view.streaming) view.streaming.streaming = false; view.streaming = null; clearDialogs(); changed(); } }) });
    try {
      // Keep the saved draft intact until every setting has been restored.
      const restoring = restoreDraft && draftState;
      const initialState = await loadView(!restoring);
      if (restoring) {
        if (typeof draftState.model?.provider === 'string' && typeof draftState.model.id === 'string') {
          if (initialState.model?.provider !== draftState.model.provider || initialState.model?.id !== draftState.model.id)
            await runtime().rpc.request('set_model', { provider: draftState.model.provider, modelId: draftState.model.id });
          if (typeof draftState.thinkingLevel === 'string' && initialState.thinkingLevel !== draftState.thinkingLevel)
            await runtime().rpc.request('set_thinking_level', { level: draftState.thinkingLevel });
        }
        if (typeof draftState.name === 'string' && draftState.name && initialState.sessionName !== draftState.name)
          await runtime().rpc.request('set_session_name', { name: draftState.name });
        const focus = draftState.focus;
        const query = focus?.mode === 'manual' ? focus.path : focus?.mode === 'pending' ? focus.query : null;
        if (typeof query === 'string' && query.length <= 2000 && !/[\r\n]/.test(query)) await runtime().rpc.request('prompt', { message: `/study ${query}` });
        if (MODES.has(draftState.mode)) await runtime().rpc.request('prompt', { message: `/mode ${draftState.mode}` });
        await rememberSession(); changed();
      }
    } catch (error) {
      runtime().generation++; runtime().rpc?.close(); runtime().rpc = undefined; clearDialogs(); view.reset(); runtime().modelLabel = '';
      view.error = safeError(error); changed(); throw error;
    }
  }
  async function newSession(workspaceId = manifest.workspaceId, continuation) {
    const workspace = workspaces.find(w => w.id === workspaceId);
    if (!workspace?.available || !workspace.path) throw fail(400, '請選擇目前可用的 Workspace。');
    const record = { id: randomUUID(), file: '', title: continuation?.title || '新對話', cwd: workspace.path, workspaceId,
      origin: 'web', parentId: continuation?.parentId, kind: continuation?.kind || 'chat', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    manifest.sessions.push(record); manifest.activeId = record.id; manifest.workspaceId = workspaceId;
    const owner = makeRuntime(record.id); runtimes.set(record.id, owner);
    return contexts.run(owner, async () => {
    try {
      // A new process is necessary: Pi's new_session RPC does not change cwd.
      await start(record, continuation?.fork);
      await persist(); return { ...snapshot(), createdSessionId: record.id };
    } catch (e) {
      runtime().rpc?.close(); runtime().rpc = undefined; clearDialogs(); view.reset();
      manifest.sessions = manifest.sessions.filter(s => s.id !== record.id); runtimes.delete(record.id);
      if (manifest.activeId === record.id) manifest.activeId = null;
      await refreshLibrary(); await persist(); view.error = safeError(e); changed(); throw e;
    }
    });
  }
  async function loadLocal(record) {
    let owner = runtimes.get(record.id);
    if (!owner) { owner = makeRuntime(record.id); runtimes.set(record.id, owner); }
    return contexts.run(owner, () => loadLocalRuntime(record));
  }
  async function loadLocalRuntime(record) {
    const { branch, revision } = await library.read(record.file);
    runtime().generation++; runtime().rpc?.close(); runtime().rpc = undefined; clearDialogs(); view.reset(); runtime().modelLabel = ''; runtime().runtimeCommands = undefined;
    let hasModeState = false;
    for (const entry of branch) {
      if (entry.type === 'message') view.message(entry.message);
      if (entry.type === 'custom_message') {
        view.message({ ...entry, role: 'custom' });
        if (entry.customType === 'pi-mode-state') hasModeState = true;
      }
      if (entry.type === 'custom' && ['pi-agent-mode-v2', 'pi-research-mode-v1'].includes(entry.customType) && MODES.has(entry.data?.state?.mode)) {
        hasModeState = true; view.mode = entry.data.state.mode; view.question = clip(entry.data.state.question, 1000); view.topic = clip(entry.data.state.topic, 100);
      }
      if (!hasModeState && entry.type === 'custom' && entry.customType === 'pentest-study-focus-v1') view.mode = 'study';
    }
    view.transcript.settle(); view.busy = false; view.error = '';
    manifest.activeId = record.id; manifest.workspaceId = record.workspaceId;
    runtime().loadedLocalRevision = revision;
    if (!selectedWorkspace()?.available) view.notice = '這個 Workspace 的資料夾目前不存在，仍可檢視對話。';
  }
  async function showLocal(record) {
    await loadLocal(record);
    await persist(); changed(); return snapshot();
  }
  async function refreshCatalogView() {
    await refreshLibrary();
    if (active()?.origin === 'local') {
      if (active().revision !== runtime().loadedLocalRevision) {
        try { await loadLocal(active()); }
        catch (e) { view.error = safeError(e); }
      }
      view.notice = selectedWorkspace()?.available ? '' : '這個 Workspace 的資料夾目前不存在，仍可檢視對話。';
    }
    await persist(); changed(); return snapshot();
  }
  const requireActive = body => {
    if (!body.sessionId || body.sessionId !== manifest.activeId || runtime().id !== body.sessionId) throw fail(409, '目前對話已在另一個頁面切換，請重新載入。');
    if (active()?.origin === 'local') throw fail(409, '這是本機對話紀錄；請先按「接續對話」。');
    if (!runtime().rpc || runtime().rpc.closed) throw fail(503, 'Pi 已離線，請重新開啟對話。');
  };
  async function promptImages(ids) {
    const owner = runtime(), rpc = owner.rpc, epoch = owner.epoch;
    const images = await imageStore.resolve(ids);
    if (images.length) {
      const state = await rpc.request('get_state');
      if (Array.isArray(state.model?.input) && !state.model.input.includes('image')) throw fail(422, '目前模型不支援圖片，請切換可讀取圖片的模型；圖片仍保留在草稿。');
    }
    if (runtime() !== owner || owner.rpc !== rpc || owner.epoch !== epoch) throw fail(409, '對話已切換，圖片仍保留在原草稿。');
    return images;
  }
  const restoredImages = (owner, cleared) => {
    const result = [];
    for (const key of ['steering', 'followUp']) {
      const remaining = owner.queue[key].map((message, index) => ({ message, images: owner.queuedImages[key][index] || [] }));
      for (const message of cleared[key]) { const index = remaining.findIndex(row => row.message === message); if (index !== -1) result.push(...remaining.splice(index, 1)[0].images); }
    }
    return result;
  };
  const requireIdle = () => { if (view.busy || runtime().stopping || runtime().operation) throw fail(409, '這個對話正在處理中，請完成或停止後再操作。'); };
  const ensureText = (value, limit = 32000) => { if (typeof value !== 'string' || !value.trim() || value.length > limit) throw fail(400, `請提供 1–${limit} 字元的文字。`); return value.trim(); };
  function managedRecord(body, deleted = false) {
    if (!SESSION_ID.test(body.id || '')) throw fail(400, '對話 ID 無效。');
    const record = catalog.get(body.id);
    if (!record || isDeleted(record.id) !== deleted) throw fail(404, deleted ? '找不到回收清單中的對話。' : '找不到這個對話。');
    if (body.workspaceId !== record.workspaceId || body.workspaceId !== manifest.workspaceId) throw fail(409, 'Workspace 已切換，請回到這個對話的 Workspace 再操作。');
    return record;
  }
  async function manageSession(action, body, acceptedOwner, serialBarrier) {
    let record = managedRecord(body, action === 'restore');
    if (action === 'rename') {
      if (!validTitle(body.title)) throw fail(400, '對話名稱需為 1–160 字元的單行文字，不能包含控制字元。');
      const title = body.title.trim();
      manifest.sessionPreferences[record.id] = { ...manifest.sessionPreferences[record.id], title };
      record.title = title;
    } else if (action === 'delete') {
      let reason = deleteReason(record.id); if (reason) throw fail(409, reason);
      // Only await work accepted before this request. A later fork can itself
      // wait on our navigation slot; awaiting its serial promise would deadlock.
      const conflictingOperation = () => {
        const current = runtimes.get(record.id);
        return current && (current !== acceptedOwner || current.serial !== serialBarrier);
      };
      if (conflictingOperation()) throw fail(409, '這個對話還有其他操作，請完成後再刪除。');
      await serialBarrier?.catch(() => {});
      record = managedRecord(body);
      if (conflictingOperation()) throw fail(409, '這個對話還有其他操作，請完成後再刪除。');
      reason = deleteReason(record.id); if (reason) throw fail(409, reason);
      manifest.sessionPreferences[record.id] = { ...manifest.sessionPreferences[record.id], deletedAt: new Date().toISOString() };
      const owner = runtimes.get(record.id);
      if (owner) contexts.run(owner, () => {
        owner.epoch++; owner.generation++; clearDialogs(); owner.rpc?.close(); runtimes.delete(record.id);
      });
      if (manifest.activeId === record.id) {
        manifest.activeId = null;
        contexts.run(emptyRuntime, () => { clearDialogs(); view.reset(); view.notice = '對話已移到回收清單，可隨時還原。'; });
      }
    } else {
      delete manifest.sessionPreferences[record.id].deletedAt;
      if (!Object.keys(manifest.sessionPreferences[record.id]).length) delete manifest.sessionPreferences[record.id];
    }
    // Counts derive from visible records; files and parent links are retained.
    for (const workspace of workspaces) workspace.sessionCount = [...catalog.values()].filter(item => item.workspaceId === workspace.id && !isDeleted(item.id)).length;
    await persist(); changed(); return { ok: true, state: snapshot() };
  }
  async function modelMenu() {
    const data = await runtime().rpc.request('get_available_models'), current = await runtime().rpc.request('get_state');
    return { type: 'models', sessionId: runtime().id, models: safeModels(data?.models),
      current: current.model ? { provider: current.model.provider, id: current.model.id } : null };
  }
  async function changeModel(provider, modelId) {
    const menu = await modelMenu();
    if (!menu.models.some(model => model.provider === provider && model.id === modelId)) throw fail(400, '這個模型目前不可用，請從模型清單選擇。');
    view.error = ''; view.notice = '';
    await runtime().rpc.request('set_model', { provider, modelId });
    await rememberSession(); changed(); return { ok: true, state: snapshot() };
  }
  async function thinkingMenu(level) {
    const levels = safeThinkingLevels((await runtime().rpc.request('get_available_thinking_levels'))?.levels);
    if (level !== undefined) {
      requireIdle();
      if (!levels.includes(level)) throw fail(400, '目前模型不支援這個思考強度，請從清單選擇。');
      await runtime().rpc.request('set_thinking_level', { level });
      await rememberSession(); changed();
    }
    const state = await runtime().rpc.request('get_state');
    return { ok: true, state: snapshot(), command: { type: 'thinking', levels, current: state.thinkingLevel ?? null } };
  }
  async function sessionInfo() {
    const [stats, state] = await Promise.all([runtime().rpc.request('get_session_stats'), runtime().rpc.request('get_state')]);
    return { ok: true, state: snapshot(), command: { type: 'session', info: {
      ...safeSessionInfo(stats, state), title: active().title, workspace: selectedWorkspace()?.path || '', model: runtime().modelLabel,
    } } };
  }
  async function forkMenu() {
    const data = await runtime().rpc.request('get_fork_messages');
    return { ok: true, state: snapshot(), command: { type: 'forks', messages: safeForkMessages(data?.messages) } };
  }
  async function branchSession(entryId, clone = false) {
    requireIdle();
    if (!clone) {
      const menu = await forkMenu();
      if (!menu.command.messages.some(message => message.entryId === entryId)) throw fail(400, '找不到這則可分支的訊息，請重新選擇。');
    }
    const owner = runtime(), source = active(), originalFile = source.file;
    owner.epoch++;
    const result = await owner.rpc.request(clone ? 'clone' : 'fork', clone ? {} : { entryId });
    if (result?.cancelled) throw fail(409, 'Pi 已取消這次分支操作。');
    const record = { ...source, id: randomUUID(), title: `${source.title} · ${clone ? '副本' : '分支'}`.slice(0, 160),
      parentId: source.id, kind: 'fork', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    // Pi has switched to a new file. Move ownership before reading or persisting
    // it, so the original manifest entry can never be overwritten by the fork.
    runtimes.delete(source.id); owner.id = record.id; runtimes.set(record.id, owner);
    manifest.sessions.push(record); manifest.activeId = record.id;
    try {
      await owner.rpc.request('set_session_name', { name: record.title });
      await loadView(); await persist(); changed();
      return { ok: true, state: snapshot(), restoredPrompt: clone ? '' : clip(result?.text, 32000) };
    } catch (error) {
      manifest.sessions = manifest.sessions.filter(item => item.id !== record.id);
      runtimes.delete(record.id); owner.epoch++; owner.id = source.id; runtimes.set(source.id, owner); manifest.activeId = source.id;
      try { await owner.rpc.request('switch_session', { sessionPath: originalFile }); await loadView(); }
      catch { owner.rpc.close(); }
      await persist(); changed(); throw error;
    }
  }
  async function compactSession(instructions) {
    requireIdle();
    if (instructions !== undefined && (typeof instructions !== 'string' || instructions.length > 8000)) throw fail(400, '摘要重點最多 8000 字元。');
    const owner = runtime(); owner.operation = 'compact'; view.busy = true; view.error = ''; changed();
    let result;
    try {
      result = await owner.rpc.request('compact', instructions?.trim() ? { customInstructions: instructions.trim() } : {}, 10 * 60 * 1000);
      await loadView();
    } catch (error) { view.error = safeError(error); throw error; }
    finally { owner.operation = null; view.busy = false; changed(); }
    return { ok: true, state: snapshot(), command: { type: 'compaction', result: safeCompactionResult(result) } };
  }
  async function exportSession() {
    requireIdle();
    const dir = await fs.mkdtemp(join(dataDir, 'export-'));
    await fs.chmod(dir, 0o700);
    const outputPath = join(dir, 'session.html');
    try {
      await runtime().rpc.request('export_html', { outputPath });
      const stat = await fs.lstat(outputPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw fail(400, '對話匯出檔案過大或格式無效。');
      const html = await fs.readFile(outputPath, 'utf8');
      return { ok: true, state: snapshot(), command: { type: 'export', html, filename: `pi-${active().id}.html` } };
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
  async function copyLast() {
    const result = await runtime().rpc.request('get_last_assistant_text');
    return { ok: true, state: snapshot(), command: { type: 'copy', text: clip(result?.text, 120000) } };
  }
  async function sideChat(message = '') {
    const source = active(), state = await runtime().rpc.request('get_state');
    if (typeof message !== 'string' || message.length > 32000) throw fail(400, 'Side Chat 問題最多 32000 字元。');
    let fork;
    try {
      await fs.access(source.file);
      fork = await library.capture(source.file, join(dataDir, 'imports'));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const created = await newSession(source.workspaceId, { fork, parentId: source.id, kind: 'side', title: 'Side Chat' });
    await contexts.run(runtimes.get(created.createdSessionId), async () => {
      if (state.model) await runtime().rpc.request('set_model', { provider: state.model.provider, modelId: state.model.id });
      if (state.thinkingLevel) await runtime().rpc.request('set_thinking_level', { level: state.thinkingLevel });
      await runtime().rpc.request('set_session_name', { name: 'Side Chat' });
      await rememberSession(); changed();
    });
    return { ok: true, state: snapshot(), restoredPrompt: message };
  }
  async function startSubagent(body) {
    const owner = runtime(), parentId = owner.id, epoch = owner.epoch, workspace = selectedWorkspace();
    subagentAdmissions.set(parentId, (subagentAdmissions.get(parentId) || 0) + 1); changed();
    try {
      const state = await owner.rpc.request('get_state');
      if (owner.id !== parentId || owner.epoch !== epoch || isDeleted(parentId)) throw fail(409, '主對話已建立分支或變更，請回到原對話再建立 Sub Agent。');
      if (!workspace?.available || !state.model) throw fail(400, '請選擇可用的 Workspace 與模型。');
      return await subagents.start({ workspaceId: workspace.id, cwd: workspace.path, parentSessionId: parentId,
        task: ensureText(body.task, 8000), context: body.context, kind: body.kind || 'read',
        model: { provider: state.model.provider, id: state.model.id }, thinkingLevel: state.thinkingLevel });
    } finally {
      const count = subagentAdmissions.get(parentId) - 1;
      if (count) subagentAdmissions.set(parentId, count); else subagentAdmissions.delete(parentId);
      changed();
    }
  }
  async function webCommand(command) {
    const { name, args } = command;
    if (name === 'model') {
      const menu = await modelMenu();
      if (!args) return { ok: true, state: snapshot(), command: menu };
      const matches = menu.models.filter(model => `${model.provider}/${model.id}` === args || model.id === args);
      if (matches.length !== 1) throw fail(400, matches.length ? '有多個同名模型，請使用 /model 開啟清單選擇。' : '找不到這個模型，請使用 /model 開啟清單選擇。');
      return changeModel(matches[0].provider, matches[0].id);
    }
    if (name === 'help') return { ok: true, state: snapshot(), command: { type: 'help', commands: commandCatalog(runtime().runtimeCommands) } };
    if (name === 'new') {
      if (args) throw fail(400, '/new 不需要參數；會在目前 Workspace 建立對話。');
      return { ok: true, state: await newSession(manifest.workspaceId) };
    }
    if (name === 'name') {
      if (!validTitle(args)) throw fail(400, '對話名稱需為 1–160 字元的單行文字，不能包含控制字元。');
      const title = args.trim();
      const id = active().id, previousPreference = manifest.sessionPreferences[id];
      await runtime().rpc.request('set_session_name', { name: title });
      // A later row rename can finish while Pi acknowledges /name. Preserve
      // that newer Web choice instead of replacing it with the stale reply.
      if (manifest.sessionPreferences[id] === previousPreference) {
        active().title = title;
        manifest.sessionPreferences[id] = { ...previousPreference, title };
      }
      await rememberSession(); changed(); return { ok: true, state: snapshot() };
    }
    if (name === 'session') return sessionInfo();
    if (name === 'thinking') return thinkingMenu(args || undefined);
    if (name === 'compact') return { ok: true, state: snapshot(), command: { type: 'compact', customInstructions: args } };
    if (name === 'fork') return args ? branchSession(args) : forkMenu();
    if (name === 'clone') return branchSession(undefined, true);
    if (name === 'export') return exportSession();
    if (name === 'copy') return copyLast();
    if (name === 'agents') return { ok: true, state: snapshot(), command: { type: 'agents' } };
    if (name === 'side') return sideChat(args);
  }
  async function bodyOf(req, limit = 128 * 1024) {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '') || req.headers['x-pi-web'] !== '1') throw fail(415, '請使用此網站的操作介面。');
    let length = 0, chunks = [];
    for await (const chunk of req) { length += chunk.length; if (length > limit) throw fail(413, '訊息太長，請分段傳送。'); chunks.push(chunk); }
    try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || Array.isArray(value) || typeof value !== 'object') throw Error(); return value; } catch { throw fail(400, '請求格式錯誤。'); }
  }
  function authorize(req) {
    const port = server.address()?.port;
    const host = req.headers.host;
    // Serve reaches the loopback listener too. Its forwarding headers must never
    // let a forged localhost Host fall through to local-only authorization.
    const proxied = Object.keys(req.headers).some(key => key === 'forwarded' || key.startsWith('x-forwarded-') || key.startsWith('tailscale-'));
    const local = !proxied && [`127.0.0.1:${port}`, `localhost:${port}`].includes(host);
    const external = publicURL && host === publicURL.host;
    if (!local && !external) throw fail(403, '此網址不在允許清單。');
    const expected = local ? `http://${host}` : publicOrigin;
    if (external && req.headers['tailscale-user-login'] !== tailscaleUser) throw fail(403, '此 Tailscale 帳號沒有存取權。');
    if (req.headers.origin && req.headers.origin !== expected) throw fail(403, '拒絕跨網站請求。');
    const documentNavigation = req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
    if (['cross-site', 'same-site'].includes(req.headers['sec-fetch-site']) && !documentNavigation) throw fail(403, '拒絕跨網站請求。');
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== expected) throw fail(403, '操作需要相同網站的 Origin。');
  }
  const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  const staticFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/markdown.js': ['markdown.js', 'text/javascript; charset=utf-8'], '/mermaid-view.js': ['mermaid-view.js', 'text/javascript; charset=utf-8'], '/mermaid-vendor.js': ['mermaid-vendor.js', 'text/javascript; charset=utf-8'], '/math-view.js': ['math-view.js', 'text/javascript; charset=utf-8'], '/katex-vendor.js': ['katex-vendor.js', 'text/javascript; charset=utf-8'], '/state.js': ['state.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/icon.svg': ['icon.svg', 'image/svg+xml'] };
  const server = http.createServer((req, res) => contexts.run(selectedRuntime(), async () => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    try {
      authorize(req);
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && staticFiles[url.pathname]) { const [file, type] = staticFiles[url.pathname]; res.setHeader('Content-Type', type); res.end(await fs.readFile(join(here, 'public', file))); return; }
      if (req.method === 'GET' && /^\/api\/images\/[a-f0-9]{64}$/.test(url.pathname)) {
        const image = await imageStore.read(url.pathname.split('/').at(-1));
        res.setHeader('Content-Type', image.mimeType); res.end(image.bytes); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/health') { json(res, { ok: true, online: !!runtime().rpc && !runtime().rpc.closed }); return; }
      if (req.method === 'GET' && url.pathname === '/api/state') { json(res, snapshot()); return; }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        if (clients.size >= 16) throw fail(429, '開啟頁面過多，請關閉不使用的分頁。');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`retry: 1500\nevent: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`); clients.add(res);
        const heartbeat = setInterval(() => { if (res.writableLength > 1024 * 1024) res.destroy(); else res.write(': keepalive\n\n'); }, 20000); heartbeat.unref();
        req.on('close', () => { clearInterval(heartbeat); clients.delete(res); }); return;
      }
      if (req.method === 'GET' && /^\/api\/sources\/[a-f0-9]{32}$/.test(url.pathname)) {
        const source = view.sources.get(url.pathname.split('/').at(-1)); if (!source) throw fail(404, '這個來源片段已不在目前對話中。'); json(res, source); return;
      }
      if (req.method !== 'POST') throw fail(404, '找不到此頁面。');
      const body = await bodyOf(req, url.pathname === '/api/images' ? 12 * 1024 * 1024 : undefined);
      if (url.pathname === '/api/images') {
        if (!workspaces.some(workspace => workspace.id === body.workspaceId && workspace.available)) throw fail(409, 'Workspace 已切換，請在原 Workspace 重新加入圖片。');
        json(res, { images: await imageStore.upload(body.images) }); return;
      }
      if (url.pathname === '/api/usage') {
        requireActive(body);
        if (body.workspaceId !== manifest.workspaceId) throw fail(409, 'Workspace 已切換。');
        const owner = runtime(), targetRpc = owner.rpc, epoch = owner.epoch;
        const info = safeSessionInfo(await targetRpc.request('get_session_stats', {}, 5000));
        requireActive(body);
        if (owner.rpc !== targetRpc || owner.epoch !== epoch) throw fail(409, '對話已變更，請重新取得用量。');
        json(res, { sessionId: owner.id, contextTokens: info.contextTokens, contextWindow: info.contextWindow, contextPercent: info.contextPercent, measuredAt: Date.now() }); return;
      }
      const requestedCommand = typeof body.message === 'string' ? parseSlash(body.message) : null;
      const management = /^\/api\/session\/(rename|delete|restore)$/.exec(url.pathname)?.[1];
      if (management) {
        const record = managedRecord(body, management === 'restore');
        const reason = management === 'delete' && deleteReason(record.id);
        if (reason) throw fail(409, reason);
        // Library operations serialize with navigation, never with an unrelated
        // selected session's long-running prompt. The target is always explicit.
        const targetOwner = runtimes.get(record.id), serialBarrier = targetOwner?.serial;
        const result = await mutate(() => manageSession(management, body, targetOwner, serialBarrier), true);
        json(res, result); return;
      }
      if (['/api/mode', '/api/model', '/api/note', '/api/notes', '/api/fork', '/api/clone'].includes(url.pathname)) requireIdle();
      if (url.pathname === '/api/prompt' && ['fork', 'clone'].includes(requestedCommand?.name)) requireIdle();
      // Dialog responses and stop must bypass the command queue: a prompt can be waiting for them.
      if (url.pathname === '/api/ui') {
        requireActive(body); const d = view.dialogs.get(body.id); if (!d) throw fail(409, '這個問題已回覆或逾時。');
        let response = { type: 'extension_ui_response', id: d.id, cancelled: body.cancelled === true };
        if (!response.cancelled) {
          if (d.method === 'confirm') { if (typeof body.confirmed !== 'boolean') throw fail(400, '請選擇確認或取消。'); response.confirmed = body.confirmed; }
          else { if (typeof body.value !== 'string' || body.value.length > 32000 || d.method === 'select' && !d.options.includes(body.value)) throw fail(400, '選項或輸入內容無效。'); response.value = body.value; }
        }
        runtime().rpc.send(response); clearTimeout(view.dialogTimers.get(d.id)); view.dialogTimers.delete(d.id); view.dialogs.delete(d.id); changed(); json(res, { ok: true }); return;
      }
      if (url.pathname === '/api/stop') {
        requireActive(body);
        if (runtime().stopping) throw fail(409, '正在停止，請稍候。');
        const targetRpc = runtime().rpc, targetId = manifest.activeId; runtime().stopping = true;
        try {
          for (const d of view.dialogs.values()) targetRpc.send({ type: 'extension_ui_response', id: d.id, cancelled: true }); clearDialogs();
          const queue = normalizeQueue(await targetRpc.request('clear_queue')), images = restoredImages(runtime(), queue);
          runtime().queue = { steering: [], followUp: [] }; runtime().queuedImages = { steering: [], followUp: [] };
          await targetRpc.request('abort', {}, 45000);
          if (runtime().rpc === targetRpc && manifest.activeId === targetId) { view.busy = false; changed(); }
          json(res, { ok: true, restored: [...queue?.steering || [], ...queue?.followUp || []].join('\n\n'), restoredImages: images }); return;
        } finally { runtime().stopping = false; }
      }
      if (url.pathname === '/api/queue') {
        requireActive(body);
        const owner = runtime();
        if (!['steer', 'follow_up', 'clear'].includes(body.action)) throw fail(400, '待處理訊息操作無效。');
        if (body.action === 'clear') {
          const restored = normalizeQueue(await owner.rpc.request('clear_queue')), images = restoredImages(owner, restored);
          owner.queue = { steering: [], followUp: [] }; owner.queuedImages = { steering: [], followUp: [] }; changed(); json(res, { ok: true, state: snapshot(), restored, restoredImages: images }); return;
        }
        if (!view.busy || owner.operation || owner.stopping) throw fail(409, '只有回覆執行中可以追加指示。');
        const images = await promptImages(body.imageIds);
        if (!owner.view.busy || owner.operation || owner.stopping) throw fail(409, '回覆狀態已變更，請重新送出。');
        const message = images.length ? ensureText(body.message || '請查看這些圖片。') : ensureText(body.message);
        if (parseSlash(message)) throw fail(400, '指令不能排入訊息佇列；請等對話完成後執行。');
        const key = body.action === 'steer' ? 'steering' : 'followUp';
        if (owner.queue.steering.length + owner.queue.followUp.length >= 20) throw fail(429, '最多保留 20 則待處理訊息。');
        const attachments = imageStore.project(images);
        owner.queue[key].push(message); owner.queuedImages[key].push(attachments); changed();
        try { await owner.rpc.request(body.action, { message, ...(images.length ? { images } : {}) }); }
        catch (error) { const i = owner.queuedImages[key].indexOf(attachments); if (i !== -1) owner.queue[key].splice(i, 1); if (i !== -1) owner.queuedImages[key].splice(i, 1); changed(); throw error; }
        json(res, { ok: true, state: snapshot() }); return;
      }
      // Delegated tasks remain available while the parent is running.
      if (url.pathname === '/api/subagents') {
        requireActive(body); const job = await startSubagent(body); json(res, { ok: true, job, state: snapshot() }); return;
      }
      if (url.pathname === '/api/subagents/cancel') {
        const job = subagents.get(body.id);
        if (!job || job.workspaceId !== manifest.workspaceId || body.workspaceId && body.workspaceId !== manifest.workspaceId) throw fail(404, '找不到目前 Workspace 的子任務。');
        await subagents.cancel(job.id); json(res, { ok: true, state: snapshot() }); return;
      }
      const result = await mutate(async () => {
        if (url.pathname === '/api/sessions') { return newSession(body.workspaceId); }
        if (url.pathname === '/api/refresh') { return refreshCatalogView(); }
        if (url.pathname === '/api/workspace' || url.pathname === '/api/workspaces') {
          let id = body.workspaceId;
          if (url.pathname === '/api/workspaces') {
            const input = ensureText(body.path, 4000);
            if ((!isAbsolute(input) && input !== '~' && !input.startsWith('~/')) || /[\r\n\0]/.test(input)) throw fail(400, '請填寫完整的本機資料夾路徑。');
            let path;
            try { path = await fs.realpath(expandPath(input)); }
            catch (e) { if (['ENOENT', 'ENOTDIR'].includes(e.code)) throw fail(400, '找不到這個本機資料夾，請確認完整路徑。'); throw e; }
            if (!(await fs.stat(path)).isDirectory()) throw fail(400, 'Workspace 必須是已存在的資料夾。');
            if (!manifest.workspacePaths.includes(path)) manifest.workspacePaths.push(path);
            if (manifest.workspacePaths.length > 100) { manifest.workspacePaths.pop(); throw fail(400, '最多可加入 100 個 Workspace。'); }
            await refreshLibrary(); id = workspaces.find(w => w.path === path)?.id;
          }
          const workspace = workspaces.find(w => w.id === id);
          if (!workspace) throw fail(404, '找不到這個 Workspace，請重新整理。');
          manifest.activeId = null; manifest.workspaceId = workspace.id; await persist(); changed(); return snapshot();
        }
        if (url.pathname === '/api/continue') {
          if (body.sessionId !== manifest.activeId || active()?.origin !== 'local') throw fail(409, '請先開啟要接續的本機對話。');
          const source = active();
          if (!selectedWorkspace()?.available || source.readable === false) throw fail(400, '目前無法在這個 Workspace 接續對話。');
          const fork = await library.capture(source.file, join(dataDir, 'imports'), runtime().loadedLocalRevision);
          return newSession(source.workspaceId, { fork, title: source.title, parentId: source.id });
        }
        if (url.pathname === '/api/open') {
          if (!SESSION_ID.test(body.id || '')) throw fail(400, '對話 ID 無效。');
          const record = catalog.get(body.id); if (!record || isDeleted(record.id)) throw fail(404, '找不到這個對話。');
          if (record.origin === 'local') return showLocal(record);
          manifest.activeId = record.id; manifest.workspaceId = record.workspaceId;
          try { await start(record); await persist(); return snapshot(); }
          catch (e) {
            await persist(); changed(); throw e;
          }
        }
        requireActive(body);
        if (url.pathname === '/api/side-chat') return sideChat(body.message);
        if (url.pathname === '/api/thinking') return thinkingMenu(body.level);
        if (url.pathname === '/api/stats') return sessionInfo();
        if (url.pathname === '/api/fork') return body.entryId ? branchSession(ensureText(body.entryId, 200)) : forkMenu();
        if (url.pathname === '/api/clone') return branchSession(undefined, true);
        if (url.pathname === '/api/compact') return compactSession(body.customInstructions);
        if (url.pathname === '/api/export') return exportSession();
        if (url.pathname === '/api/copy') return copyLast();
        if (url.pathname === '/api/model') {
          requireIdle(); return changeModel(ensureText(body.provider, 200), ensureText(body.modelId, 500));
        }
        if (url.pathname === '/api/prompt') {
          const images = await promptImages(body.imageIds);
          let message = images.length ? ensureText(body.message || '請查看這些圖片。') : ensureText(body.message);
          if (images.length && parseSlash(message)) throw fail(400, '圖片請搭配一般訊息送出；Slash 指令不會接收圖片。');
          // RPC prompt only dispatches extension/template/skill commands. Native
          // terminal commands must be bridged here or they become model prompts.
          const command = parseSlash(message);
          if (command) {
            if (WEB_COMMANDS.some(item => item.name === command.name)) {
              if (!['help', 'session', 'new', 'side', 'agents', 'copy'].includes(command.name)) requireIdle();
              return webCommand(command);
            }
            if (TERMINAL_COMMANDS.has(command.name)) throw fail(400, `/${command.name} 目前需要在 T14 的 Pi 終端使用。輸入 /help 可查看 Web 支援的指令。`);
            if (!runtime().runtimeCommands?.some(item => item.name === command.name)) throw fail(400, '找不到這個指令，請輸入 /help 查看可用清單。這段內容未送給模型。');
            // Pi splits the invocation at an ASCII space, not at arbitrary
            // whitespace. Keep our parser and its dispatcher in agreement.
            message = `/${command.name}${command.args ? ` ${command.args}` : ''}`;
          }
          requireIdle();
          view.error = ''; view.notice = ''; view.busy = true; changed();
          try { await runtime().rpc.request('prompt', { message, ...(images.length ? { images } : {}) }, 10 * 60 * 1000); } catch (e) { view.busy = false; view.error = safeError(e); changed(); throw e; }
          if (active().title === '新對話' && !manifest.sessionPreferences[active().id]?.title && !message.startsWith('/')) active().title = message.slice(0, 60);
          await rememberSession(); changed(); return { ok: true };
        }
        if (url.pathname === '/api/mode') {
          requireIdle(); if (!MODES.has(body.mode)) throw fail(400, '模式無效。');
          view.error = ''; view.notice = ''; await runtime().rpc.request('prompt', { message: `/mode ${body.mode}` });
          if (view.error) throw fail(400, view.error);
          await rememberSession(); changed(); return snapshot();
        }
        if (url.pathname === '/api/notes') {
          requireIdle(); const query = typeof body.query === 'string' ? body.query.trim() : ''; if (query.length > 200 || /[\r\n]/.test(query)) throw fail(400, '筆記關鍵字過長或包含換行。');
          view.notes = []; view.error = ''; await runtime().rpc.request('prompt', { message: `/study-notes ${query}` });
          if (view.error) throw fail(400, view.error);
          return { notes: view.notes };
        }
        if (url.pathname === '/api/note') {
          requireIdle(); const path = ensureText(body.path, 2000);
          if (path !== 'auto' && !view.notes.some(n => n.path === path)) throw fail(400, '請從筆記清單選擇。');
          if (/[\r\n]/.test(path)) throw fail(400, '筆記路徑無效。');
          view.error = ''; view.notice = ''; await runtime().rpc.request('prompt', { message: `/study ${path}` });
          if (view.error) throw fail(400, view.error);
          await rememberSession(); changed(); return snapshot();
        }
        throw fail(404, '找不到此操作。');
      }, ['/api/sessions', '/api/open', '/api/workspace', '/api/workspaces', '/api/continue', '/api/side-chat', '/api/fork', '/api/clone'].includes(url.pathname) || url.pathname === '/api/prompt' && ['new', 'side', 'fork', 'clone'].includes(requestedCommand?.name),
      ['/api/fork', '/api/clone'].includes(url.pathname) || url.pathname === '/api/prompt' && ['fork', 'clone'].includes(requestedCommand?.name));
      json(res, result);
    } catch (e) { if (!res.headersSent) json(res, { error: safeError(e) }, e.status || 500); else res.end(); }
  }));
  server.headersTimeout = 15000; server.requestTimeout = 30000; server.keepAliveTimeout = 5000;
  server.on('clientError', (_e, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  subagents = await createSubagentManager({ dataDir, createRpc: config => new PiRpc(config),
    piCommand: options.piBin || runtimeEnv.PI_WEB_PI_BIN || 'pi', piArgs: options.subagentPiArgs || [],
    env: runtimeEnv, onChange: () => changed() });
  subagentBridge = await createSubagentBridge(body => {
    const owner = [...runtimes.values()].find(item => item.nativeSessionId === body.nativeSessionId && item.rpc && !item.rpc.closed);
    if (!owner || typeof body.nativeSessionId !== 'string') throw fail(409, '主對話已變更或離線，無法操作子任務。');
    return contexts.run(owner, async () => {
      const scope = { workspaceId: active().workspaceId, parentSessionId: active().id };
      if (body.action === 'start') return startSubagent(body);
      if (body.action === 'list') return subagents.list(scope).map(({ output, result, context, ...job }) => ({ ...job, task: job.task.slice(0, 500) }));
      const job = subagents.get(body.id);
      if (job.workspaceId !== scope.workspaceId || job.parentSessionId !== scope.parentSessionId) throw fail(404, '找不到這個主對話的子任務。');
      if (body.action === 'status') return job;
      if (body.action === 'cancel') return subagents.cancel(job.id);
      throw fail(400, 'Sub Agent 操作無效。');
    });
  });
  await refreshLibrary();
  if (active() && options.restore !== false) {
    try { if (active().origin === 'local') await showLocal(active()); else await start(active()); } catch (e) { view.error = safeError(e); }
  }
  const refreshTimer = setInterval(() => {
    if (!clients.size || view.busy || runtime().stopping || closed) return;
    void mutate(async () => { if (view.busy || runtime().stopping) return; await refreshCatalogView(); }).catch(() => {});
  }, 15000); refreshTimer.unref();
  return { server, view, snapshot, async close() { closed = true; clearInterval(refreshTimer); for (const owner of runtimes.values()) contexts.run(owner, () => { owner.generation++; clearDialogs(); owner.rpc?.close(); }); await subagents?.close(); await subagentBridge?.close(); for (const res of clients) res.end(); clients.clear(); await persistQueue.catch(() => {}); const stopped = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await stopped; } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createWebServer();
  const port = Number(process.env.PI_WEB_PORT || 4318);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PI_WEB_PORT 無效。');
  app.server.listen(port, '127.0.0.1', () => console.log(`Pi Web 已啟動：http://127.0.0.1:${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
