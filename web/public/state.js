/** HTTP responses and SSE can arrive out of order, especially across mobile networks. */
export function isCurrent(previous, next) {
  if (!Number.isFinite(next.revision) || !Number.isFinite(next.startedAt)) return false;
  if (!previous.startedAt) return true;
  if (next.startedAt !== previous.startedAt) return next.startedAt > previous.startedAt;
  return next.revision >= previous.revision;
}

export function selectedWorkspace(snapshot) {
  return (snapshot.workspaces || []).find(workspace => workspace.id === snapshot.workspaceId) || null;
}

export function workspaceSessions(snapshot, query = '') {
  const needle = query.normalize('NFKC').trim().toLocaleLowerCase('zh-TW');
  return (snapshot.sessions || []).filter(session =>
    (!Array.isArray(snapshot.workspaces) || session.workspaceId === snapshot.workspaceId) &&
    (!needle || String(session.title || '').normalize('NFKC').toLocaleLowerCase('zh-TW').includes(needle)));
}

const sameWorkspace = (snapshot, session) => !Array.isArray(snapshot.workspaces) || session.workspaceId === snapshot.workspaceId;
const sessionTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const recentSession = session => Math.max(sessionTime(session.updatedAt), sessionTime(session.createdAt));
const compareIds = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/** Flat, ordered tree rows. Collapsing or searching never changes the input catalog or Set. */
export function workspaceSessionRows(snapshot, { query = '', collapsed = new Set(), selectedId = snapshot.sessionId } = {}) {
  const nodes = new Map();
  for (const session of workspaceSessions(snapshot)) {
    if (typeof session.id === 'string' && session.id && !session.deletedAt && !nodes.has(session.id))
      nodes.set(session.id, { session, parentId: null, children: [], recent: recentSession(session) });
  }
  const deleted = new Map();
  for (const session of snapshot.deletedSessions || []) {
    if (sameWorkspace(snapshot, session) && typeof session.id === 'string' && !deleted.has(session.id)) deleted.set(session.id, session);
  }
  // A deleted intermediate session can still connect a child to its nearest
  // visible ancestor. Never follow metadata across a Workspace boundary.
  for (const [id, node] of nodes) {
    const seen = new Set([id]);
    let parentId = node.session.parentId;
    while (typeof parentId === 'string' && parentId && !seen.has(parentId)) {
      seen.add(parentId);
      if (nodes.has(parentId)) {
        if (nodes.get(parentId).session.workspaceId === node.session.workspaceId) node.parentId = parentId;
        break;
      }
      const parent = deleted.get(parentId);
      if (!parent || parent.workspaceId !== node.session.workspaceId) break;
      parentId = parent.parentId;
    }
  }
  // A functional parent graph has at most one cycle per component. Break the
  // lexically first edge in each cycle, independent of catalog ordering.
  const complete = new Set();
  for (const id of nodes.keys()) {
    const path = [], positions = new Map();
    let cursor = id;
    while (cursor && !complete.has(cursor)) {
      if (positions.has(cursor)) {
        const cycle = path.slice(positions.get(cursor));
        const root = cycle.reduce((first, value) => compareIds(value, first) < 0 ? value : first);
        nodes.get(root).parentId = null; break;
      }
      positions.set(cursor, path.length); path.push(cursor); cursor = nodes.get(cursor).parentId;
    }
    for (const visited of path) complete.add(visited);
  }
  for (const [id, node] of nodes) if (node.parentId) nodes.get(node.parentId).children.push(id);
  // Accumulate subtree recency from leaves without recursive calls; imported
  // histories can contain much deeper chains than the JavaScript call stack.
  const remaining = new Map([...nodes].map(([id, node]) => [id, node.children.length]));
  const leaves = [...nodes.keys()].filter(id => !remaining.get(id));
  for (let index = 0; index < leaves.length; index++) {
    const node = nodes.get(leaves[index]);
    if (!node.parentId) continue;
    const parent = nodes.get(node.parentId); parent.recent = Math.max(parent.recent, node.recent);
    remaining.set(node.parentId, remaining.get(node.parentId) - 1);
    if (!remaining.get(node.parentId)) leaves.push(node.parentId);
  }
  const compare = (a, b) => nodes.get(b).recent - nodes.get(a).recent ||
    recentSession(nodes.get(b).session) - recentSession(nodes.get(a).session) || compareIds(a, b);
  const roots = [...nodes.keys()].filter(id => !nodes.get(id).parentId).sort(compare);
  for (const node of nodes.values()) node.children.sort(compare);
  const needle = searchText(query).trim(), matching = new Set(), included = new Set(), forced = new Set();
  for (const [id, node] of nodes) {
    if (needle && !searchText(node.session.title).includes(needle)) continue;
    matching.add(id);
    let cursor = id;
    while (cursor && !included.has(cursor)) { included.add(cursor); cursor = nodes.get(cursor).parentId; }
  }
  if (needle) for (const id of included) { const parentId = nodes.get(id).parentId; if (parentId) forced.add(parentId); }
  let ancestor = nodes.get(selectedId)?.parentId;
  while (ancestor) { forced.add(ancestor); ancestor = nodes.get(ancestor).parentId; }
  const rows = [], stack = roots.slice().reverse().map(id => ({ id, depth: 0 }));
  while (stack.length) {
    const { id, depth } = stack.pop(); if (!included.has(id)) continue;
    const node = nodes.get(id), children = node.children.filter(child => included.has(child));
    const hasChildren = children.length > 0, expanded = hasChildren && (!collapsed.has(id) || forced.has(id));
    rows.push({ id, session: node.session, parentId: node.parentId, depth, hasChildren, expanded,
      orphan: !!node.session.parentId && !node.parentId, matchesSearch: matching.has(id) });
    if (expanded) for (let index = children.length - 1; index >= 0; index--) stack.push({ id: children[index], depth: depth + 1 });
  }
  return rows;
}

export function workspaceDeletedSessions(snapshot, query = '') {
  const needle = searchText(query).trim();
  return (snapshot.deletedSessions || []).filter(session => sameWorkspace(snapshot, session) &&
    (!needle || searchText(session.title).includes(needle))).sort((a, b) => sessionTime(b.deletedAt) - sessionTime(a.deletedAt) ||
      recentSession(b) - recentSession(a) || compareIds(a.id, b.id));
}

/** Renaming changes Web metadata only; deletion must wait for related work to finish. */
export function sessionManagementReason(snapshot, sessionId, { connected, working, action = 'delete' }) {
  if (!connected) return '連線恢復後，才能管理對話。';
  if (working) return '正在處理操作，請稍候。';
  const session = (snapshot.sessions || []).find(item => item.id === sessionId && sameWorkspace(snapshot, item) && !item.deletedAt);
  if (!session) return '找不到這個對話，請重新整理。';
  if (action === 'rename') return '';
  if (typeof session.deleteBlockedReason === 'string' && session.deleteBlockedReason) return session.deleteBlockedReason;
  const selected = session.id === snapshot.sessionId;
  if (session.busy || selected && snapshot.busy) return '回覆完成或停止後，才能管理這個對話。';
  if (session.operation || selected && snapshot.operation) return '目前操作完成後，才能管理這個對話。';
  if ((snapshot.subagents || []).some(job => job.workspaceId === session.workspaceId && job.parentSessionId === session.id && ['queued', 'running'].includes(job.status)))
    return '這個對話的 Sub Agent 完成或取消後，才能管理對話。';
  return '';
}

export function workspaceControls(snapshot, { connected, working }) {
  const workspace = selectedWorkspace(snapshot);
  const available = Array.isArray(snapshot.workspaces) ? !!workspace && workspace.available !== false : true;
  const idle = connected && !working && !snapshot.busy && !snapshot.operation;
  return {
    browse: connected && !working,
    start: connected && !working && available,
    mode: idle && available && !snapshot.readOnly && !snapshot.nativeBridge,
    input: available && !snapshot.readOnly,
    send: idle && available && !snapshot.readOnly && (snapshot.online || !snapshot.sessionId),
    continue: idle && snapshot.readOnly === true && snapshot.canContinue === true && available,
  };
}

export function draftScope(snapshot) {
  return `pi-draft:${JSON.stringify([snapshot.workspaceId ?? null, snapshot.sessionId ?? null])}`;
}

export function acceptsCreatedSession(current, created, workspaceId) {
  const alreadyCurrent = current.sessionId === created.sessionId && current.startedAt === created.startedAt && !current.readOnly;
  return (alreadyCurrent || isCurrent(current, created)) && !!created.sessionId && !created.readOnly && !current.readOnly &&
    created.workspaceId === workspaceId && current.workspaceId === workspaceId &&
    (!current.sessionId || current.sessionId === created.sessionId);
}

export function mergeRestoredDraft(existing, restored, append = false) {
  if (!restored || existing.trim() === restored.trim()) return existing;
  return (append ? [existing, restored] : [restored, existing]).filter(Boolean).join('\n\n');
}

export function libraryScanWarning(count) {
  return Number.isInteger(count) && count > 0 ? `掃描遇到 ${count} 項問題，部分紀錄可能未列出。` : '';
}

const searchText = value => String(value || '').normalize('NFKC').toLocaleLowerCase('zh-TW');
const matchesTerms = (value, query) => searchText(query).trim().split(/\s+/).filter(Boolean).every(term => searchText(value).includes(term));
const commandText = command => `${command.name} ${command.description || ''} ${command.usage || ''} ${(command.suggestions || [])
  .map(option => `${option.value || ''} ${option.label || ''} ${option.description || ''}`).join(' ')}`;

export function commandSuggestions(commands, input) {
  const match = /^\/([^\s]*)$/.exec(input);
  if (!match) return [];
  const query = searchText(match[1]);
  return (commands || []).filter(command => command.name &&
    matchesTerms(commandText(command), query))
    .sort((a, b) => Number(searchText(b.name).startsWith(query)) - Number(searchText(a.name).startsWith(query)));
}

export function composerSuggestions(commands, input) {
  const match = /^\/([^\s]+)\s+([^\n]*)$/.exec(input);
  if (!match) return commandSuggestions(commands, input).map(command => ({ ...command, value: `/${command.name}`, label: `/${command.name}` }));
  const command = (commands || []).find(command => command.name === match[1]);
  const query = match[2].trim();
  return (command?.suggestions || []).filter(option => typeof option.value === 'string' &&
    searchText(option.value) !== searchText(input.trim()) &&
    matchesTerms(`${option.value} ${option.label || ''} ${option.description || ''}`, query))
    .map(option => ({ ...option, name: option.value, label: option.label || option.value }));
}

/** The palette searches command names, descriptions, usage and available subcommands. */
export function commandPaletteOptions(commands, query = '') {
  const terms = searchText(query).trim().replace(/^\//, '');
  const entries = [];
  for (const command of commands || []) {
    if (!command?.name) continue;
    if (!terms || matchesTerms(`${command.name} ${command.description || ''} ${command.usage || ''}`, terms))
      entries.push({ ...command, value: `/${command.name}`, label: `/${command.name}`, kind: 'command' });
    if (terms) for (const option of command.suggestions || []) {
      if (typeof option.value !== 'string' || !matchesTerms(`${command.name} ${option.value} ${option.label || ''} ${option.description || ''}`, terms)) continue;
      entries.push({ ...option, value: option.value, label: option.label || option.value, description: option.description || command.description || '',
        parent: command.name, kind: 'suggestion' });
    }
  }
  if (terms) {
    const rank = option => {
      const value = searchText(option.value).replace(/^\//, '');
      return value === terms ? 2 : value.startsWith(terms) ? 1 : 0;
    };
    entries.sort((a, b) => rank(b) - rank(a));
  }
  return entries;
}

export function commandUsage(commands, input) {
  const name = /^\/([^\s]+)(?:\s|$)/.exec(input)?.[1];
  return (commands || []).find(command => command.name === name)?.usage || '';
}

export function commandArgumentHint(commands, input) {
  const name = /^\/([^\s]+)(?:\s|$)/.exec(input)?.[1];
  const command = (commands || []).find(item => item.name === name);
  const value = input.trim();
  if (!command || !value) return '';
  if (value === `/${name}`) return command.argumentHint || '';
  return command.suggestions?.find(option => option.value === value)?.argumentHint || '';
}

export function moveCommandSelection(index, step, count) {
  return count ? ((index + step) % count + count) % count : -1;
}

export function filterModels(models, query) {
  const terms = searchText(query).trim().split(/\s+/).filter(Boolean);
  return (models || []).filter(model => {
    const text = searchText(`${model.name || ''} ${model.provider} ${model.id}`);
    return terms.every(term => text.includes(term));
  });
}

/** A delayed command dialog belongs only to the session that requested it. */
export function acceptsCommandResponse(current, requested, response) {
  return current.sessionId === requested.sessionId && current.workspaceId === requested.workspaceId &&
    current.startedAt === requested.startedAt &&
    (!response.command || !response.state || (response.state.sessionId === requested.sessionId && response.state.workspaceId === requested.workspaceId)) &&
    (!response.command || !['models', 'thinking', 'session', 'compact', 'forks'].includes(response.command.type) || requested.model === undefined || current.model === requested.model) &&
    (!response.command?.sessionId || response.command.sessionId === current.sessionId);
}

export function modelDisabledReason(snapshot, { connected, working }) {
  if (snapshot.readOnly) return '先接續對話，才能切換模型。';
  if (snapshot.nativeBridge) return '這段對話由原生 Pi 終端管理；請在該終端切換模型。';
  if (snapshot.busy) return '回覆完成或停止後，才能切換模型。';
  if (snapshot.operation) return '目前操作完成後，才能切換模型。';
  if (!connected) return '連線恢復後，才能切換模型。';
  if (working) return '正在處理操作，請稍候。';
  if (Array.isArray(snapshot.workspaces) && (!selectedWorkspace(snapshot) || selectedWorkspace(snapshot).available === false)) return '請先選擇可使用的 Workspace。';
  if (snapshot.sessionId && !snapshot.online) return 'Pi 目前離線，請重新開啟對話。';
  return '';
}

export function agentControls(snapshot, { connected, working, queuePending = false, agentPending = false }) {
  const available = !Array.isArray(snapshot.workspaces) || selectedWorkspace(snapshot)?.available === true;
  const writable = connected && available && !!snapshot.sessionId && snapshot.online && !snapshot.readOnly;
  const managed = writable && !snapshot.nativeBridge;
  return {
    inspect: managed && !working && !snapshot.operation,
    change: managed && !working && !snapshot.busy && !snapshot.operation,
    side: managed && !working,
    queue: writable && snapshot.busy && !snapshot.operation && !queuePending,
    clearQueue: managed && !snapshot.operation && !queuePending,
    createAgent: managed && !snapshot.operation && !agentPending,
    cancelAgent: connected && !agentPending,
  };
}

export function sessionParent(snapshot) {
  const selected = (snapshot.sessions || []).find(session => session.id === snapshot.sessionId);
  if (!selected || selected.deletedAt) return null;
  const parentId = snapshot.parentSessionId || selected.parentId;
  const parent = (snapshot.sessions || []).find(session => session.id === parentId && !session.deletedAt);
  return parent && parent.id !== selected.id && parent.workspaceId === selected.workspaceId ? parent.id : null;
}

export function metric(value, suffix = '') {
  return Number.isFinite(value) && value >= 0 ? `${value.toLocaleString('zh-TW', { maximumFractionDigits: 4 })}${suffix}` : '未知';
}

export function sessionInfoRows(info = {}) {
  const text = value => typeof value === 'string' && value ? value : '未知';
  return [
    ['名稱', text(info.title)], ['Workspace', text(info.workspace)], ['模型', text(info.model)], ['思考強度', text(info.thinkingLevel)],
    ['訊息數', metric(info.messageCount)], ['使用者訊息', metric(info.userMessages)], ['模型訊息', metric(info.assistantMessages)],
    ['工具呼叫', metric(info.toolCalls)], ['工具結果', metric(info.toolResults)],
    ['輸入 tokens', metric(info.tokens?.input)], ['輸出 tokens', metric(info.tokens?.output)],
    ['快取讀取 tokens', metric(info.tokens?.cacheRead)], ['快取寫入 tokens', metric(info.tokens?.cacheWrite)],
    ['累計 tokens', metric(info.tokens?.total)], ['累計費用', metric(info.cost, ' USD')],
    ['目前 context tokens', metric(info.contextTokens)], ['Context 容量', metric(info.contextWindow)], ['Context 使用率', metric(info.contextPercent, '%')],
  ];
}

export function workspaceJobs(snapshot) {
  return (snapshot.subagents || []).filter(job => job.workspaceId === snapshot.workspaceId);
}

export function jobDraft(job, limit = Infinity) {
  const heading = `Sub Agent 任務：${job.task || '未命名任務'}`;
  const result = job.result || job.output || '尚未提供結果。', tail = [];
  if (job.branch) tail.push(`分支：${job.branch}`);
  if (job.worktree) tail.push(`工作目錄：${job.worktree}`);
  tail.push('請先檢查結果與變更，再決定下一步。');
  const full = [heading, result, ...tail].join('\n\n');
  if (full.length <= limit) return full;
  const prefix = heading.slice(0, 1000), suffix = ['（僅帶入部分結果；完整內容請回 Sub Agent 面板檢查。）', ...tail].join('\n\n');
  const remaining = limit - prefix.length - suffix.length - 4;
  return remaining < 100 ? '' : `${prefix}\n\n${result.slice(0, remaining)}\n\n${suffix}`;
}
