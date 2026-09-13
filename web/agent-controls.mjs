const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const positiveCount = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const thinkingLevel = value => THINKING_LEVELS.has(value) ? value : null;

/** Keep only levels advertised by Pi. An unavailable list is not an inferred "off". */
export function safeThinkingLevels(levels) {
  return [...new Set((Array.isArray(levels) ? levels : []).filter(level => THINKING_LEVELS.has(level)))];
}

/** Pi 0.85.1 SessionStats: totals cover all entries; contextUsage is the current estimate. */
export function safeSessionInfo(rawStats, rawState = {}) {
  const stats = object(rawStats), state = object(rawState), tokens = object(stats.tokens), context = object(stats.contextUsage);
  const userMessages = count(stats.userMessages), assistantMessages = count(stats.assistantMessages);
  return {
    userMessages, assistantMessages,
    messageCount: userMessages === null || assistantMessages === null ? null : count(userMessages + assistantMessages),
    toolCalls: count(stats.toolCalls), toolResults: count(stats.toolResults), totalMessages: count(stats.totalMessages),
    tokens: { input: count(tokens.input), output: count(tokens.output), cacheRead: count(tokens.cacheRead), cacheWrite: count(tokens.cacheWrite), total: count(tokens.total) },
    cost: amount(stats.cost),
    // Do not substitute accumulated tokens or a post-compaction heuristic for a missing context measurement.
    contextTokens: count(context.tokens), contextWindow: positiveCount(context.contextWindow), contextPercent: amount(context.percent),
    thinkingLevel: thinkingLevel(state.thinkingLevel),
  };
}

/** These are selectable entry IDs, never session filenames or arbitrary RPC fields. */
export function safeForkMessages(messages) {
  const seen = new Set(), safe = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (typeof message?.entryId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(message.entryId) || typeof message.text !== 'string' || seen.has(message.entryId)) continue;
    seen.add(message.entryId);
    safe.push({ entryId: message.entryId, text: message.text.slice(0, 16000), ...(message.text.length > 16000 ? { truncated: true } : {}) });
  }
  return safe;
}

export function safeUsage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const cost = object(raw.cost);
  return {
    ...(count(raw.reasoning) === null ? {} : { reasoning: count(raw.reasoning) }), input: count(raw.input), output: count(raw.output), cacheRead: count(raw.cacheRead), cacheWrite: count(raw.cacheWrite), totalTokens: count(raw.totalTokens),
    cost: { input: amount(cost.input), output: amount(cost.output), cacheRead: amount(cost.cacheRead), cacheWrite: amount(cost.cacheWrite), total: amount(cost.total) },
  };
}

/** Extension-specific details can contain local paths or credentials and are intentionally omitted. */
export function safeCompactionResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.summary !== 'string') return null;
  return {
    summary: result.summary.slice(0, 60000), ...(result.summary.length > 60000 ? { truncated: true } : {}),
    tokensBefore: count(result.tokensBefore), estimatedTokensAfter: count(result.estimatedTokensAfter), usage: safeUsage(result.usage),
  };
}

/** Used for queue_update and clear_queue. Preserve exact text for draft restoration. */
export function normalizeQueue(queue) {
  const value = object(queue);
  const messages = input => (Array.isArray(input) ? input : []).filter(message => typeof message === 'string');
  return { steering: messages(value.steering), followUp: messages(value.followUp) };
}
