#!/usr/bin/env node
import { clearLine, cursorTo, createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const DEFAULT_URL = 'http://127.0.0.1:4318';
const REQUEST_TIMEOUT = 30_000;
const PROMPT_TIMEOUT = 10 * 60_000;
const HISTORY_LIMIT = 30;

const clean = value => String(value ?? '').replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|.)/g, '')
  .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');

export function parseArgs(args) {
  if (args.length === 1 && ['-h', '--help'].includes(args[0])) return { help: true };
  if (args[0] !== 'attach') throw new Error('用法：zen-pi attach [--url http://127.0.0.1:4318] [--session ID]');
  let url = DEFAULT_URL, sessionId;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index], value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${arg} 需要一個值。`);
    if (arg === '--url') url = value;
    else if (arg === '--session') sessionId = value;
    else throw new Error(`不支援的選項：${arg}`);
  }
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Web 服務網址無效。'); }
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname) ||
      parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('attach 只連接本機 HTTP Web 服務；網址請使用 http://127.0.0.1:4318。');
  }
  return { url: parsed.origin, sessionId };
}

/** Parse complete SSE frames. HTTP chunks can split an event or a UTF-8 character. */
export async function* eventFrames(body) {
  const decoder = new TextDecoder();
  let pending = '', type = '', data = [];
  const line = value => {
    if (!value) {
      const result = data.length ? { type: type || 'message', data: data.join('\n') } : null;
      type = ''; data = []; return result;
    }
    if (value.startsWith(':')) return null;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    const content = colon < 0 ? '' : value.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') type = content;
    if (field === 'data') data.push(content);
    return null;
  };
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true });
    if (pending.length > 8 * 1024 * 1024) throw new Error('Web 事件資料過大。');
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const value = pending.slice(0, end).replace(/\r$/, ''); pending = pending.slice(end + 1);
      const frame = line(value); if (frame) yield frame;
    }
  }
}

function commandOutput(command) {
  if (!command) return '';
  if (command.type === 'help') return (command.commands || []).map(item => `/${item.name} — ${item.description || item.usage || ''}`).join('\n');
  if (command.type === 'session') return Object.entries(command.info || {}).map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`).join('\n');
  if (command.type === 'models') return (command.models || []).map(item => `${item.provider || ''}/${item.id || item.modelId || ''} ${item.name || ''}`.trim()).join('\n') || '沒有可用模型。';
  if (command.type === 'thinking') return `可用思考強度：${(command.levels || []).join('、')}`;
  if (command.type === 'forks') return '請在 Web UI 選擇要分支的訊息。';
  if (command.type === 'export') return '匯出檔請在 Web UI 下載。';
  if (command.type === 'copy') return command.text || '';
  if (command.type === 'agents') return '請在 Web UI 查看 Sub Agent。';
  if (command.type === 'compact') return '請在 Web UI 確認壓縮。';
  return '';
}

export async function runAttach({ url = DEFAULT_URL, sessionId, input = process.stdin, output = process.stdout,
  error = process.stderr, fetcher = fetch } = {}) {
  const base = new URL(parseArgs(['attach', '--url', url]).url), terminal = !!input.isTTY && !!output.isTTY;
  const controller = new AbortController();
  let state, lastError = '', lastNotice = '', closed = false, failedDraft = null;
  let rendered = new Map(), shownDialogs = new Set(), rl;
  const print = value => {
    if (closed) return;
    if (terminal && rl) { clearLine(output, 0); cursorTo(output, 0); }
    output.write(`${clean(value)}\n`);
    if (terminal && rl) rl.prompt(true);
  };
  const printError = value => error.write(`${clean(value)}\n`);
  async function api(path, body) {
    let response;
    try {
      response = await fetcher(new URL(`/api/${path}`, base), {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { Origin: base.origin, 'Content-Type': 'application/json', 'X-Pi-Web': '1' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(path === 'prompt' ? PROMPT_TIMEOUT : REQUEST_TIMEOUT)]),
      });
    } catch (cause) {
      if (controller.signal.aborted) throw new Error('終端已離開。');
      throw new Error(cause?.name === 'TimeoutError' ? 'Web 服務回應逾時。' : `無法連線至 ${base.origin}。`);
    }
    let result;
    try { result = await response.json(); } catch { throw new Error(`Web 服務回傳無效資料（HTTP ${response.status}）。`); }
    if (!response.ok) throw new Error(result?.error || `Web 服務回應 HTTP ${response.status}。`);
    return result;
  }
  const label = message => message.role === 'user' ? '你' : 'Pi';
  function renderMessage(message) {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.id !== 'string') return;
    const now = String(message.text || ''), old = rendered.get(message.id);
    if (!old) {
      rendered.set(message.id, { text: now, streaming: !!message.streaming });
      if (now) print(`${label(message)}> ${now}`);
      else if (!message.streaming) print(`${label(message)}> [沒有文字內容]`);
      return;
    }
    if (now !== old.text) {
      if (now.startsWith(old.text)) print(`${old.text ? '  ' : `${label(message)}> `}${now.slice(old.text.length)}`);
      else print(`${label(message)}（更新）> ${now || '[沒有文字內容]'}`);
    } else if (old.streaming && !message.streaming && !now) print(`${label(message)}> [沒有文字內容]`);
    rendered.set(message.id, { text: now, streaming: !!message.streaming });
  }
  function renderState(next) {
    if (!next || !Array.isArray(next.sessions) || !Array.isArray(next.messages)) return;
    if (state?.serverId === next.serverId && next.startedAt === state.startedAt && next.revision < state.revision) return;
    const changedSession = !state || state.serverId !== next.serverId || state.sessionId !== next.sessionId || state.workspaceId !== next.workspaceId;
    state = next;
    if (changedSession) {
      rendered = new Map(); shownDialogs = new Set();
      const session = next.sessions.find(item => item.id === next.sessionId);
      const workspace = next.workspaces?.find(item => item.id === next.workspaceId);
      print(`\n[${workspace?.name || 'Workspace'}] ${session?.title || '尚未選擇對話'}${next.readOnly ? '（唯讀 CLI 紀錄）' : ''}`);
      const visible = next.messages.slice(-HISTORY_LIMIT);
      if (next.messages.length > visible.length) print(`（只顯示最近 ${HISTORY_LIMIT} 則；完整紀錄請看 Web UI）`);
      for (const message of visible) renderMessage(message);
      if (next.readOnly) print('要在此接續，輸入 /continue；原始 CLI 紀錄會保留。');
    } else for (const message of next.messages) renderMessage(message);
    for (const dialog of next.dialogs || []) {
      if (!dialog?.id || shownDialogs.has(dialog.id)) continue;
      shownDialogs.add(dialog.id);
      const choices = dialog.method === 'select' ? `\n${(dialog.options || []).map((item, index) => `${index + 1}. ${item}`).join('\n')}` : '';
      print(`Pi 詢問：${dialog.title || dialog.message || dialog.method}${dialog.title && dialog.message ? `\n${dialog.message}` : ''}${choices}\n輸入 /answer <回覆>，或 /cancel 取消。`);
    }
    if (next.error && next.error !== lastError) print(`錯誤：${next.error}`);
    if (next.notice && next.notice !== lastNotice) print(`提示：${next.notice}`);
    lastError = next.error || ''; lastNotice = next.notice || '';
  }
  function renderEvent(frame) {
    let data;
    try { data = JSON.parse(frame.data); } catch { return; }
    if (frame.type === 'snapshot') { renderState(data); return; }
    if (!state || data.startedAt !== state.startedAt || data.revision < state.revision) return;
    state.revision = data.revision;
    if (frame.type === 'message') {
      if (!state.messages.some(item => item.id === data.id)) state.messages.push(data);
      renderMessage(data);
    } else if (frame.type === 'delta') {
      const message = state.messages.find(item => item.id === data.id);
      if (!message || typeof data.delta !== 'string') return;
      message.text += data.delta; renderMessage(message);
    }
  }
  async function events() {
    let reportedOffline = false;
    while (!controller.signal.aborted) {
      try {
        const response = await fetcher(new URL('/api/events', base), { signal: controller.signal });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        if (reportedOffline) print('Web 連線已恢復。'); reportedOffline = false;
        for await (const frame of eventFrames(response.body)) renderEvent(frame);
        if (!controller.signal.aborted) throw new Error('事件連線已中斷');
      } catch (cause) {
        if (controller.signal.aborted) break;
        if (!reportedOffline) printError(`Web 即時連線中斷（${clean(cause.message)}），正在重試。`);
        reportedOffline = true;
      }
      if (!controller.signal.aborted) await new Promise(resolve => {
        const timer = setTimeout(resolve, 1500);
        controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  }
  function listSessions(query = '') {
    const needle = query.toLocaleLowerCase('zh-TW');
    const sessions = state.sessions.filter(item => !needle || `${item.title} ${item.id}`.toLocaleLowerCase('zh-TW').includes(needle));
    if (!sessions.length) { print('找不到對話。'); return; }
    for (const item of sessions) {
      const workspace = state.workspaces?.find(row => row.id === item.workspaceId);
      print(`${item.id === state.sessionId ? '●' : ' '} ${item.id}  ${item.title || '未命名'}  [${item.origin === 'local' ? 'CLI 紀錄' : 'Web'} · ${workspace?.name || '未知 Workspace'}]${item.busy ? ' 進行中' : ''}`);
    }
  }
  function showHelp() {
    print('連到 Web 服務的同一執行中對話。/sessions [搜尋] 列表，/open <ID> 切換，/new 新建，/continue 接續唯讀 CLI 紀錄，/refresh 更新清單，/stop 停止回覆，/follow <文字> 排下一輪，/steer <文字> 立即補充，/answer <回覆> 回答 Pi 問題，/cancel 取消問題，/retry 重送失敗草稿，/exit 離開。其他 / 指令交給 Web Pi。');
  }
  async function answerDialog(answer, cancelled = false) {
    const dialog = state.dialogs?.[0];
    if (!dialog) { print('目前沒有待回覆的問題。'); return; }
    const body = { sessionId: state.sessionId, id: dialog.id, cancelled };
    if (!cancelled) {
      if (dialog.method === 'confirm') {
        if (['yes', 'y', '是', '同意'].includes(answer.toLocaleLowerCase('zh-TW'))) body.confirmed = true;
        else if (['no', 'n', '否', '不同意'].includes(answer.toLocaleLowerCase('zh-TW'))) body.confirmed = false;
        else { print('確認問題請輸入 /answer yes 或 /answer no。'); return; }
      } else if (dialog.method === 'select') {
        const index = Number(answer);
        body.value = Number.isInteger(index) && index >= 1 && index <= dialog.options?.length ? dialog.options[index - 1] : answer;
      } else body.value = answer;
    }
    await api('ui', body);
    print(cancelled ? '已取消問題。' : '已送出回覆。');
  }
  async function send(message, queueAction) {
    if (!message.trim()) return;
    if (state.readOnly) { failedDraft = { message, sessionId: state.sessionId }; print(`這是唯讀紀錄；請先輸入 /continue。未送出：${message}`); return; }
    if (!state.sessionId) {
      if (!state.workspaceId) throw new Error('尚未選擇 Workspace。');
      renderState(await api('sessions', { workspaceId: state.workspaceId }));
    }
    const target = state.sessionId, workspaceId = state.workspaceId;
    if (state.busy && message.trimStart().startsWith('/') && !queueAction) {
      failedDraft = { message, sessionId: target };
      print(`對話正在回覆，指令未送出。完成後輸入 /retry，或先 /stop：${message}`); return;
    }
    try {
      if (queueAction || state.busy) {
        if (message.trimStart().startsWith('/')) throw new Error('Slash 指令不能排入佇列。');
        const action = queueAction || 'follow_up';
        await api('queue', { sessionId: target, workspaceId, action, message });
        print(action === 'steer' ? '已立即補充到目前回覆。' : '已排到下一輪。');
      } else {
        const result = await api('prompt', { sessionId: target, workspaceId, message });
        if (result.state) renderState(result.state);
        const extra = commandOutput(result.command); if (extra) print(extra);
      }
      failedDraft = null;
    } catch (cause) {
      if (controller.signal.aborted) return;
      failedDraft = { message, sessionId: target };
      printError(`未送出：${clean(cause.message)}。輸入 /retry 重送；草稿：${clean(message)}`);
    }
  }
  async function line(value) {
    const text = value.trim(); if (!text) return;
    const command = text.split(/\s+/, 1)[0], argument = text.slice(command.length).trim();
    if (['/exit', '/quit'].includes(command)) { if (argument) { print(`${command} 不接受參數。`); return; } rl.close(); return; }
    if (command === '/help') { showHelp(); return; }
    if (command === '/sessions') { listSessions(argument); return; }
    if (command === '/open') {
      if (!argument) { print('用法：/open <對話 ID>。可用 /sessions 查看 ID。'); return; }
      renderState(await api('open', { id: argument })); return;
    }
    if (command === '/new') { if (argument) { print('/new 不接受參數。'); return; } renderState(await api('sessions', { workspaceId: state.workspaceId })); return; }
    if (command === '/continue') {
      if (argument) { print('/continue 不接受參數。'); return; }
      if (!state.readOnly) { print('目前不是唯讀 CLI 紀錄。'); return; }
      renderState(await api('continue', { sessionId: state.sessionId })); return;
    }
    if (command === '/refresh') { if (argument) { print('/refresh 不接受參數。'); return; } renderState(await api('refresh', {})); return; }
    if (command === '/stop') { if (argument) { print('/stop 不接受參數。'); return; } await api('stop', { sessionId: state.sessionId }); print('已要求停止回覆。'); return; }
    if (command === '/answer') { if (!argument) { print('用法：/answer <回覆>'); return; } await answerDialog(argument); return; }
    if (command === '/cancel') { if (argument) { print('/cancel 不接受參數。'); return; } await answerDialog('', true); return; }
    if (command === '/retry') {
      if (!failedDraft) { print('沒有待重送的草稿。'); return; }
      if (failedDraft.sessionId && failedDraft.sessionId !== state.sessionId) { print('草稿屬於另一段對話；請先切回原對話。'); return; }
      await send(failedDraft.message); return;
    }
    if (command === '/follow' || command === '/steer') {
      if (!argument) { print(`用法：${command} <文字>`); return; }
      await send(argument, command === '/steer' ? 'steer' : 'follow_up'); return;
    }
    await send(value);
  }

  renderState(await api('state'));
  if (sessionId) renderState(await api('open', { id: sessionId }));
  print('Zen Pi 終端已連到 Web 服務。輸入 /help 查看操作。');
  const eventTask = events();
  rl = createInterface({ input, output, terminal });
  let operations = Promise.resolve();
  rl.on('line', value => {
    const urgent = /^\/(?:answer|cancel|stop|exit|quit)(?:\s|$)/.test(value.trim());
    const task = (urgent ? Promise.resolve() : operations).then(() => line(value)).catch(cause => {
      if (!controller.signal.aborted) printError(clean(cause.message));
    }).then(() => {
      if (!closed && terminal) rl.prompt();
    });
    if (!urgent) operations = task;
  });
  if (terminal) rl.setPrompt('zen-pi> '), rl.prompt();
  await new Promise(resolve => rl.once('close', resolve));
  closed = true; controller.abort();
  await operations; await eventTask;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { process.stdout.write('用法：zen-pi attach [--url http://127.0.0.1:4318] [--session ID]\n'); return; }
    await runAttach(args);
  } catch (cause) { process.stderr.write(`${clean(cause.message)}\n`); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
