import { safeUsage } from './agent-controls.mjs';

const LIMIT = 24000, MAX_CHARS = 400000, MAX_ENTRIES = 160;
const redact = text => text.replace(/\bBearer\s+[^\s"']+|\bsk-[a-zA-Z0-9_-]{8,}/gi, '[已隱藏憑證]')
  .replace(/(["']?(?:authorization|api[_-]?key|access[_-]?token|password|secret)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[已隱藏憑證]');
function bounded(value) {
  let text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, (key, item) => /^(?:authorization|api[_-]?key|access[_-]?token|password|secret|thinkingSignature|textSignature|data)$/i.test(key) ? '[已隱藏]' : item, 2);
  text = redact(text || '');
  return text.length > LIMIT ? `${text.slice(0, LIMIT / 2)}\n\n[內容過長，已省略中段；保留開頭與結尾]\n\n${text.slice(-LIMIT / 2)}` : text;
}
const contentText = content => typeof content === 'string' ? content : (Array.isArray(content) ? content.map(block => block.type === 'text' ? block.text : block.type === 'image' ? '[圖片內容]' : '').filter(Boolean).join('\n') : '');
const fields = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'reasoning'];
const counter = () => ({ requests: 0, reported: 0, missing: 0, totals: Object.fromEntries(fields.map(key => [key, null])), cost: null });
function addUsage(counter, usage) {
  counter.requests++;
  if (usage?.totalTokens != null) counter.reported++; else counter.missing++;
  for (const key of fields) if (usage?.[key] != null) counter.totals[key] = (counter.totals[key] ?? 0) + usage[key];
  if (usage?.cost.total != null) counter.cost = (counter.cost ?? 0) + usage.cost.total;
}

/** A bounded projection of Pi's public messages/events, never provider payloads or signatures. */
export class Transcript {
  constructor() {
    this.entries = new Map(); this.omitted = 0;
    this.usage = { ...counter(), latest: null, currentTurn: counter() };
  }
  put(id, value) {
    const item = { ...this.entries.get(id), ...value, id };
    this.entries.set(id, item);
    let chars = [...this.entries.values()].reduce((n, row) => n + JSON.stringify(row).length, 0);
    while (this.entries.size > 1 && (this.entries.size > MAX_ENTRIES || chars > MAX_CHARS)) {
      const first = this.entries.keys().next().value; chars -= JSON.stringify(this.entries.get(first)).length;
      this.entries.delete(first); this.omitted++;
    }
    return item;
  }
  message(message, id, complete = true) {
    if (message.role === 'bashExecution') return this.put(id, { kind: 'tool', name: 'bash', input: bounded(message.command), output: bounded(message.output) + (message.truncated ? '\n[Pi 已截斷輸出]' : ''), state: message.cancelled ? 'aborted' : message.exitCode ? 'error' : 'done', exitCode: Number.isInteger(message.exitCode) ? message.exitCode : undefined });
    if (message.role === 'toolResult') {
      return this.tool({ type: 'tool_execution_end', toolCallId: message.toolCallId, toolName: message.toolName, result: { content: message.content, details: message.details }, isError: message.isError });
    }
    if (!['assistant', 'user'].includes(message.role)) return;
    const assistant = message.role === 'assistant';
    if (!assistant && complete) this.usage.currentTurn = counter();
    const entry = this.put(id, { kind: message.role, messageId: id, text: bounded(contentText(message.content)),
      timestamp: typeof message.timestamp === 'number' ? message.timestamp : Date.now(),
      state: complete ? (['error', 'aborted'].includes(message.stopReason) ? message.stopReason : 'done') : 'running',
      thinking: bounded((Array.isArray(message.content) ? message.content : []).filter(b => b.type === 'thinking' && !b.redacted).map(b => b.thinking).join('\n')),
      error: bounded(message.errorMessage), model: bounded(assistant ? [message.provider, message.model].filter(Boolean).join(' / ') : ''),
      usage: assistant && complete ? safeUsage(message.usage) : null });
    if (assistant && complete) {
      const usage = entry.usage; addUsage(this.usage, usage); addUsage(this.usage.currentTurn, usage);
      this.usage.latest = usage;
      for (const call of Array.isArray(message.content) ? message.content : []) if (call.type === 'toolCall') {
        this.put(`tool:${call.id}`, { kind: 'tool', name: bounded(call.name), input: bounded(call.arguments), state: 'pending' });
      }
    }
    return entry;
  }
  tool(event) {
    if (typeof event.toolCallId !== 'string') return;
    const id = `tool:${event.toolCallId}`, old = this.entries.get(id);
    const result = event.type === 'tool_execution_update' ? event.partialResult : event.result;
    const value = { kind: 'tool', name: bounded(event.toolName || old?.name),
      state: event.type === 'tool_execution_end' ? event.isError ? 'error' : 'done' : 'running' };
    if (event.args !== undefined) value.input = bounded(event.args);
    if (event.type === 'tool_execution_start') value.startedAt = Date.now();
    if (result !== undefined) value.output = bounded(contentText(result?.content));
    if (event.type === 'tool_execution_end') {
      value.finishedAt = Date.now();
      const code = result?.details?.exitCode ?? result?.exitCode;
      if (Number.isInteger(code)) value.exitCode = code;
    }
    return this.put(id, value);
  }
  settle() { for (const item of this.entries.values()) if (['running', 'pending'].includes(item.state)) item.state = 'interrupted'; }
  snapshot() { return { entries: [...this.entries.values()], omitted: this.omitted, usage: this.usage }; }
}
