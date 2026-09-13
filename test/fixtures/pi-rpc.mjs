import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2), sessionDir = args[args.indexOf('--session-dir') + 1];
let file = args.includes('--session') ? args[args.indexOf('--session') + 1] : join(sessionDir, `${randomUUID()}.jsonl`);
let history = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
const imageQueue = { steering: [], followUp: [] };
let mode = 'general', focus = { mode: 'auto' }, busy = false, waiting, buffer = '';
for (const msg of history) if (msg.customType === 'pi-mode-state') mode = JSON.parse(msg.content).mode;
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const answer = (request, data) => emit({ type: 'response', command: request.type, id: request.id, success: true, data });
const custom = (customType, value) => { const message = { role: 'custom', customType, content: JSON.stringify(value) }; history.push(message); emit({ type: 'message_end', message }); };
const modeStatus = (notify = false) => {
  custom('pi-mode-state', { mode });
  if (notify) emit({ type: 'extension_ui_request', method: 'notify', notifyType: 'info', message: JSON.stringify({ mode }) });
};
const studyStatus = () => custom('pi-study-state', { mode, focus, status: focus.mode === 'manual' ? '指定' : '跟隨', current: focus.path ? { path: focus.path, title: 'Network' } : null });
function finish() {
  const message = { role: 'assistant', content: [{ type: 'text', text: '完成：安全的回覆。' }], stopReason: 'stop' };
  history.push(message); emit({ type: 'message_end', message }); busy = false; emit({ type: 'agent_settled' }); writeFileSync(file, JSON.stringify(history));
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk; let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line) continue;
    const req = JSON.parse(line); if (process.env.FAKE_RPC_LOG) appendFileSync(process.env.FAKE_RPC_LOG, `${JSON.stringify(req)}\n`);
    if (req.type === 'get_state') answer(req, { sessionFile: file, sessionId: 'fake-internal-id', isStreaming: busy, model: { provider: 'local', id: 'fake', name: '測試模型', input: process.env.FAKE_NO_IMAGES ? ['text'] : ['text', 'image'], apiKey: 'DO-NOT-EXPOSE', headers: { Authorization: 'SECRET' } } });
    else if (req.type === 'get_commands') answer(req, { commands: ['mode', 'study', 'study-status', 'study-notes', 'test-feedback', 'confirm'].map(name => ({ name, source: 'extension' })) });
    else if (req.type === 'get_session_stats') {
      const stats = { contextUsage: process.env.FAKE_UNKNOWN_CONTEXT ? { tokens: null, contextWindow: 1000, percent: null } : { tokens: 120, contextWindow: 1000, percent: 12 }, tokens: { total: 9231931 }, apiKey: 'PRIVATE-USAGE', sessionFile: file };
      if (process.env.FAKE_STATS_GATE && !existsSync(process.env.FAKE_STATS_GATE + '.release')) {
        writeFileSync(process.env.FAKE_STATS_GATE + '.waiting', 'ready');
        const timer = setInterval(() => { if (existsSync(process.env.FAKE_STATS_GATE + '.release')) { clearInterval(timer); answer(req, stats); } }, 10);
      } else answer(req, stats);
    }
    else if (req.type === 'get_messages') answer(req, { messages: history });
    else if (req.type === 'new_session') { file = join(sessionDir, `${randomUUID()}.jsonl`); history = []; mode = 'general'; focus = { mode: 'auto' }; answer(req, { cancelled: false }); }
    else if (req.type === 'clear_queue') {
      if (process.env.FAKE_IMAGE_QUEUES) { answer(req, { steering: imageQueue.steering.map(row => row.message), followUp: imageQueue.followUp.map(row => row.message) }); imageQueue.steering = []; imageQueue.followUp = []; }
      else answer(req, { steering: ['未送出的訊息'], followUp: [] });
    }
    else if (['steer', 'follow_up'].includes(req.type)) {
      if (req.type === 'follow_up' && process.env.FAKE_CONSUME_FOLLOW_UP) {
        const message = { role: 'user', content: [{ type: 'text', text: req.message }, ...req.images || []] };
        emit({ type: 'message_start', message }); history.push(message); emit({ type: 'message_end', message });
      } else imageQueue[req.type === 'steer' ? 'steering' : 'followUp'].push(req);
      answer(req);
    }
    else if (req.type === 'abort') { if (busy) finish(); answer(req); }
    else if (req.type === 'extension_ui_response') { if (waiting) { answer(waiting); waiting = null; finish(); } }
    else if (req.type === 'prompt') {
      if (req.message.startsWith('/mode ')) { const next = req.message.slice(6); if (next !== 'status') mode = next; modeStatus(next === 'status'); answer(req); }
      else if (req.message === '/test-feedback') {
        emit({ type: 'extension_ui_request', method: 'notify', notifyType: 'info', message: JSON.stringify({ warning: '需要保留的提醒' }) });
        emit({ type: 'extension_ui_request', method: 'notify', notifyType: 'error', message: '筆記庫暫時無法讀取。' });
        answer(req);
      }
      else if (req.message === '/study-status') { studyStatus(); answer(req); }
      else if (req.message.startsWith('/study-notes')) { custom('pi-note-list', { notes: [{ path: '03-Network/Network.md', title: 'Network' }] }); answer(req); }
      else if (req.message.startsWith('/study ')) { mode = 'study'; focus = req.message.slice(7) === 'auto' ? { mode: 'auto' } : { mode: 'manual', path: req.message.slice(7) }; modeStatus(); studyStatus(); answer(req); }
      else if (req.message === 'trace-test') {
        busy = true; emit({ type: 'agent_start' });
        const assistant = { role: 'assistant', provider: 'fixture', model: 'test', stopReason: 'toolUse', usage: { input: 30, output: 10, cacheRead: 20, cacheWrite: 0, totalTokens: 60, reasoning: 4, cost: { total: 0 } }, content: [{ type: 'thinking', thinking: 'Fixture planning summary', thinkingSignature: 'PRIVATE-SIGNATURE' }, { type: 'toolCall', id: 'trace-call', name: 'bash', arguments: { command: 'printf fixture', apiKey: 'PRIVATE-KEY' } }] };
        history.push(assistant); emit({ type: 'message_end', message: assistant });
        emit({ type: 'tool_execution_start', toolCallId: 'trace-call', toolName: 'bash', args: { command: 'printf fixture', apiKey: 'PRIVATE-KEY' } });
        emit({ type: 'tool_execution_update', toolCallId: 'trace-call', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'first line' }] } });
        answer(req);
        setTimeout(() => {
          const result = { role: 'toolResult', toolCallId: 'trace-call', toolName: 'bash', isError: true, content: [{ type: 'text', text: 'first line\nfixture failure' }] };
          emit({ type: 'tool_execution_end', toolCallId: 'trace-call', toolName: 'bash', isError: true, result: { content: result.content, details: { exitCode: 7, secret: 'PRIVATE-RESULT' } } });
          history.push(result); emit({ type: 'message_end', message: result });
          writeFileSync(file, JSON.stringify(history)); busy = false; emit({ type: 'agent_settled' });
        }, 200);
      }
      else {
        const user = { role: 'user', content: [{ type: 'text', text: req.message }, ...req.images || []] }; history.push(user); emit({ type: 'message_end', message: user });
        busy = true; emit({ type: 'agent_start' }); emit({ type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: '段落\u2028仍在同一則訊息\u2029。' }] } });
        emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '段落\u2028仍在同一則訊息\u2029。' } });
        if (req.message === '/confirm') { waiting = req; emit({ type: 'extension_ui_request', id: 'dialog-1', method: 'confirm', title: '允許測試操作？' }); }
        else {
          custom('study-context', { mode, status: '指定', current: { path: '03-Network/Network.md', sha256: 'a'.repeat(64), content: '9: 原始證據\n10: 下一行', startLine: 9, endLine: 10, truncated: true } });
          emit({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'study_read' });
          emit({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'study_read', result: { content: [{ type: 'text', text: JSON.stringify({ path: '03-Network/Network.md', sha256: 'a'.repeat(64), content: '20: 後面的段落', truncated: true }) }] } });
          answer(req); if (req.message !== 'hold') setTimeout(finish, 25);
        }
      }
    }
  }
});
