import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeThinkingLevels, safeSessionInfo, safeForkMessages, safeCompactionResult, normalizeQueue } from '../web/agent-controls.mjs';
import { WEB_COMMANDS, TERMINAL_COMMANDS, safeCommands, commandCatalog, parseSlash } from '../web/commands.mjs';

const secret = 'PRIVATE_RPC_METADATA_SENTINEL';
const stats = {
  sessionFile: `/private/${secret}/session.jsonl`, sessionId: secret,
  userMessages: 5, assistantMessages: 7, toolCalls: 12, toolResults: 10, totalMessages: 22,
  tokens: { input: 50000, output: 10000, cacheRead: 40000, cacheWrite: 5000, total: 105000, headers: secret },
  cost: 0.45, contextUsage: { tokens: 60000, contextWindow: 200000, percent: 30, internal: secret },
  apiKey: secret, headers: { Authorization: secret },
};

test('Session statistics project native counts and current context separately, without private metadata', () => {
  const before = structuredClone(stats);
  const result = safeSessionInfo(stats, { thinkingLevel: 'high', model: { apiKey: secret }, sessionFile: secret });
  assert.deepEqual(result, {
    userMessages: 5, assistantMessages: 7, messageCount: 12, toolCalls: 12, toolResults: 10, totalMessages: 22,
    tokens: { input: 50000, output: 10000, cacheRead: 40000, cacheWrite: 5000, total: 105000 }, cost: 0.45,
    contextTokens: 60000, contextWindow: 200000, contextPercent: 30, thinkingLevel: 'high',
  });
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.deepEqual(stats, before, 'Projection does not mutate the RPC response');
});

test('Post-compaction unknown context stays unknown even when historical token totals are available', () => {
  const result = safeSessionInfo({ ...stats, contextUsage: { tokens: null, contextWindow: 200000, percent: null } }, { thinkingLevel: 'medium' });
  assert.equal(result.contextTokens, null); assert.equal(result.contextPercent, null); assert.equal(result.contextWindow, 200000);
  assert.equal(result.tokens.total, 105000, 'Accumulated usage is not substituted for current context');
  const missing = safeSessionInfo({ ...stats, contextUsage: undefined }, { model: { contextWindow: 999999 } });
  assert.equal(missing.contextTokens, null); assert.equal(missing.contextPercent, null); assert.equal(missing.contextWindow, null);
  assert.equal(missing.thinkingLevel, null);
});

test('Unknown, invalid and zero statistics are distinguished without coercion or overflow', () => {
  const missing = safeSessionInfo(null, null);
  for (const [key, value] of Object.entries(missing)) {
    if (key === 'tokens') assert.ok(Object.values(value).every(value => value === null));
    else assert.equal(value, null);
  }
  const invalid = safeSessionInfo({ userMessages: 2, assistantMessages: '3', toolCalls: -1, toolResults: 0.5, totalMessages: Infinity,
    tokens: { input: false, output: NaN, cacheRead: '0', cacheWrite: -2, total: Number.MAX_SAFE_INTEGER + 1 }, cost: '0',
    contextUsage: { tokens: -1, contextWindow: 0, percent: Infinity } }, { thinkingLevel: 'turbo' });
  assert.equal(invalid.userMessages, 2); assert.equal(invalid.messageCount, null);
  assert.ok(Object.values(invalid.tokens).every(value => value === null));
  for (const key of ['assistantMessages', 'toolCalls', 'toolResults', 'totalMessages', 'cost', 'contextTokens', 'contextWindow', 'contextPercent', 'thinkingLevel']) assert.equal(invalid[key], null);
  assert.equal(safeSessionInfo({ userMessages: Number.MAX_SAFE_INTEGER, assistantMessages: 1 }).messageCount, null);
  const zero = safeSessionInfo({ userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, contextUsage: { tokens: 0, contextWindow: 200000, percent: 0 } }, { thinkingLevel: 'off' });
  assert.equal(zero.messageCount, 0); assert.equal(zero.cost, 0); assert.equal(zero.contextTokens, 0); assert.equal(zero.contextPercent, 0);
  assert.ok(Object.values(zero.tokens).every(value => value === 0));
  assert.equal(safeSessionInfo({ contextUsage: { tokens: 240000, contextWindow: 200000, percent: 120 } }).contextPercent, 120, 'Context overflow above 100% must remain visible');
});

test('Thinking choices retain the supported list and do not fabricate levels', () => {
  assert.deepEqual(safeThinkingLevels(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(safeThinkingLevels(['medium', 'high', 'medium', 'turbo', null, { level: 'max' }]), ['medium', 'high']);
  assert.deepEqual(safeThinkingLevels(['off']), ['off']);
  assert.deepEqual(safeThinkingLevels(undefined), []); assert.deepEqual(safeThinkingLevels({ levels: ['high'] }), []);
});

test('Fork choices keep opaque entry IDs and user text, rejecting invalid IDs and duplicate rows', () => {
  const input = [{ entryId: 'abc123', text: 'First user prompt', sessionPath: secret, headers: secret },
    { entryId: 'abc123', text: 'Duplicate should not replace the first prompt' },
    { entryId: '01900000-0000-7000-8000-000000000001', text: 'Second prompt\nwith lines' },
    { entryId: `/tmp/${secret}`, text: 'Not an entry ID' }, { entryId: 'bad\nentry', text: 'Invalid' },
    { entryId: 'valid', text: { auth: secret } }, null];
  const result = safeForkMessages(input);
  assert.deepEqual(result, [{ entryId: 'abc123', text: 'First user prompt' }, { entryId: '01900000-0000-7000-8000-000000000001', text: 'Second prompt\nwith lines' }]);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.deepEqual(safeForkMessages(undefined), []);
  const preview = safeForkMessages([{ entryId: 'long-entry', text: 'x'.repeat(16001) }])[0];
  assert.equal(preview.text.length, 16000); assert.equal(preview.truncated, true, 'Bounded previews report truncation');
  assert.equal(input[0].sessionPath, secret, 'The original RPC response is unchanged');
});

test('Compaction projection distinguishes estimated context size from summary generation usage', () => {
  const result = safeCompactionResult({ summary: 'Retained decisions and next steps.', firstKeptEntryId: secret, tokensBefore: 150000, estimatedTokensAfter: 32000,
    usage: { input: 32000, output: 1200, cacheRead: 0, cacheWrite: 0, totalTokens: 33200,
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03, headers: secret }, apiKey: secret },
    details: { readFiles: [`/private/${secret}`], modifiedFiles: [secret] }, sessionFile: secret });
  assert.deepEqual(result, { summary: 'Retained decisions and next steps.', tokensBefore: 150000, estimatedTokensAfter: 32000,
    usage: { input: 32000, output: 1200, cacheRead: 0, cacheWrite: 0, totalTokens: 33200, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } } });
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.deepEqual(safeCompactionResult({ summary: 'Custom extension summary', tokensBefore: 0 }), { summary: 'Custom extension summary', tokensBefore: 0, estimatedTokensAfter: null, usage: null });
  assert.equal(safeCompactionResult(null), null); assert.equal(safeCompactionResult({ error: 'Cancelled' }), null);
  const unknownUsage = safeCompactionResult({ summary: 'Summary', usage: { input: '10', output: -1, totalTokens: Infinity, cost: { total: NaN } } });
  assert.equal(unknownUsage.usage.input, null); assert.equal(unknownUsage.usage.output, null); assert.equal(unknownUsage.usage.totalTokens, null); assert.equal(unknownUsage.usage.cost.total, null);
  const long = safeCompactionResult({ summary: 'x'.repeat(60001) });
  assert.equal(long.summary.length, 60000); assert.equal(long.truncated, true);
});

test('Queue normalization preserves exact drafts, order and intentional duplicates', () => {
  const long = 'a'.repeat(40000), first = '  Keep leading space\nand a second line.  ';
  const raw = { steering: [first, first, { headers: secret }, long], followUp: ['Next question', '', null, 7], sessionFile: secret };
  const result = normalizeQueue(raw);
  assert.deepEqual(result, { steering: [first, first, long], followUp: ['Next question', ''] });
  assert.ok(!JSON.stringify(result).includes(secret));
  result.steering.push('another'); assert.equal(raw.steering.length, 4, 'The normalized queue owns its arrays');
  assert.deepEqual(normalizeQueue(null), { steering: [], followUp: [] });
  assert.deepEqual(normalizeQueue({ steering: 'not an array', followUp: { text: secret } }), { steering: [], followUp: [] });
});

test('New Web controls are registered while unsupported terminal commands remain blocked', () => {
  const names = WEB_COMMANDS.map(command => command.name);
  for (const name of ['thinking', 'compact', 'fork', 'clone', 'export', 'copy', 'agents', 'side']) {
    assert.ok(names.includes(name)); assert.equal(TERMINAL_COMMANDS.has(name), false);
  }
  for (const name of ['login', 'logout', 'settings', 'resume', 'reload', 'tree']) {
    assert.equal(TERMINAL_COMMANDS.has(name), true);
    assert.equal(safeCommands([{ name, source: 'extension' }]).length, 0, 'A registered-looking row cannot bypass terminal-only handling');
  }
  assert.equal(new Set(names).size, names.length);
  assert.equal(commandCatalog([]).some(command => command.name === 'wiki'), false, 'Metadata does not fabricate an unregistered command');
  assert.equal(commandCatalog([]).some(command => command.name === 'unknown'), false);
});

test('Known subcommand suggestions match the actual mode, study, research and wiki grammar', () => {
  const commands = safeCommands(['mode', 'study', 'research', 'wiki'].map(name => ({ name, description: name, source: 'extension', sourceInfo: { path: secret } })));
  const expected = { mode: ['/mode general', '/mode study', '/mode research', '/mode status'], study: ['/study auto', '/study status', '/study off'],
    research: ['/research resume', '/research status', '/research off'], wiki: ['/wiki check', '/wiki rebuild', '/wiki forget'] };
  for (const command of commands) {
    assert.ok(command.usage.startsWith(`/${command.name}`));
    assert.deepEqual(command.suggestions.map(suggestion => suggestion.value), expected[command.name]);
    assert.ok(command.suggestions.every(suggestion => suggestion.label));
  }
  assert.deepEqual(safeCommands(commands), commands, 'Repeated projection preserves safe metadata');
  assert.ok(!JSON.stringify(commands).includes(secret));
  const catalog = commandCatalog([...commands, { name: 'model', description: secret, source: 'extension' }]);
  assert.equal(catalog.find(command => command.name === 'model').source, 'web', 'Built-in Web routing wins command name collisions');
  assert.equal(catalog.find(command => command.name === 'wiki').suggestions.length, 3);
});

test('Custom suggestion metadata is projected and cannot insert another command or a hidden second line', () => {
  const [result] = safeCommands([{ name: 'custom', source: 'extension', description: 'Custom command', usage: '/custom <option>', path: secret,
    suggestions: [
      { value: '/custom option', label: 'Option', description: 'Description', path: secret, headers: secret },
      { value: '/custom option', label: 'Duplicate' }, { value: '/login', label: 'Wrong command' },
      { value: '/custom first\n/login', label: 'Hidden second line' }, { value: '/custom\0bad', label: 'Invalid control' },
      { value: { script: secret }, label: 'Invalid type' },
    ] }]);
  assert.deepEqual(result, { name: 'custom', source: 'extension', description: 'Custom command', usage: '/custom <option>', suggestions: [{ value: '/custom option', label: 'Option', description: 'Description' }] });
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(safeCommands([{ name: 'custom', usage: '/custom\nsecond' }])[0].usage, undefined);
  assert.equal(safeCommands([{ name: 'custom name' }, { name: '/custom' }, { name: null }]).length, 0);
  const [bounded] = safeCommands([{ name: 'custom', usage: 'x'.repeat(501), suggestions: Array.from({ length: 20 }, (_, index) => ({ value: `/custom ${index}`, label: 'x'.repeat(201) })) }]);
  assert.equal(bounded.usage.length, 500); assert.equal(bounded.suggestions.length, 12); assert.equal(bounded.suggestions[0].label.length, 200);
});

test('Slash parsing still identifies registered names across whitespace and never invents ordinary-text commands', () => {
  for (const input of ['/mode study', '/mode\tstudy', '/mode\nstudy', '/mode  study']) assert.deepEqual(parseSlash(input), { name: 'mode', args: 'study' });
  assert.deepEqual(parseSlash('/custom first\nsecond'), { name: 'custom', args: 'first\nsecond' });
  assert.deepEqual(parseSlash('/unknown option'), { name: 'unknown', args: 'option' });
  assert.equal(parseSlash('ordinary user text'), null);
  assert.deepEqual(parseSlash('/'), { name: 'help', args: '' });
});
