import './isolate.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceSessionRows, workspaceDeletedSessions, sessionManagementReason, sessionParent } from '../web/public/state.js';

const session = (id, parentId = null, options = {}) => ({ id, parentId, workspaceId: 'a', title: id, ...options });
const snapshot = (sessions, options = {}) => ({ workspaces: [{ id: 'a' }, { id: 'b' }], workspaceId: 'a', sessionId: null, sessions, ...options });
const rows = (state, options) => workspaceSessionRows(state, options);
const ids = values => values.map(value => value.id);
const stamp = day => `2026-09-${String(day).padStart(2, '0')}T00:00:00Z`;
const ready = { connected: true, working: false };

test('Any visible parent relationship forms a contiguous tree, ordered by subtree activity', () => {
  const state = snapshot([
    session('main', null, { updatedAt: stamp(1) }),
    session('unrelated', null, { updatedAt: stamp(8) }),
    session('side', 'main', { kind: 'side', updatedAt: stamp(2) }),
    session('continued', 'side', { kind: 'future-kind', updatedAt: stamp(10) }),
    session('fork', 'main', { kind: 'fork', updatedAt: stamp(4) }),
    session('foreign', null, { workspaceId: 'b', updatedAt: stamp(11) }),
  ]);
  const before = structuredClone(state), result = rows(state);
  assert.deepEqual(ids(result), ['main', 'side', 'continued', 'fork', 'unrelated']);
  assert.deepEqual(result.map(row => row.depth), [0, 1, 2, 1, 0]);
  assert.deepEqual(result.map(row => row.parentId), [null, 'main', 'side', 'main', null]);
  assert.deepEqual(result.map(row => row.hasChildren), [true, true, false, false, false]);
  assert.deepEqual(result.map(row => row.expanded), [true, true, false, false, false]);
  assert.ok(result.every(row => !row.orphan && row.matchesSearch));
  assert.equal(result[0].session, state.sessions[0]);
  assert.deepEqual(state, before, 'Sorting and tree construction leave the original snapshot untouched');
});

test('Deleted intermediate parents reconnect to the nearest visible ancestor within the same Workspace', () => {
  const state = snapshot([
    session('root'), session('child', 'deleted-one'), session('missing', 'gone'), session('cross', 'foreign'),
    session('cross-deleted', 'deleted-other-workspace'), session('foreign', null, { workspaceId: 'b' }),
  ], { deletedSessions: [
    session('deleted-one', 'deleted-two', { deletedAt: stamp(10) }),
    session('deleted-two', 'root', { deletedAt: stamp(9) }),
    session('deleted-other-workspace', 'root', { workspaceId: 'b', deletedAt: stamp(10) }),
  ] });
  const result = rows(state), byId = new Map(result.map(row => [row.id, row]));
  assert.equal(result.length, 5); assert.equal(byId.get('child').parentId, 'root'); assert.equal(byId.get('child').depth, 1);
  assert.equal(byId.get('child').orphan, false);
  for (const id of ['missing', 'cross', 'cross-deleted']) { assert.equal(byId.get(id).depth, 0); assert.equal(byId.get(id).orphan, true); }
  assert.ok(!result.some(row => row.id.startsWith('deleted-')));
  const legacy = { sessions: [session('one', 'two'), session('two', null, { workspaceId: 'b' })] };
  assert.equal(rows(legacy).find(row => row.id === 'one').parentId, null, 'Cross-Workspace edges are rejected even without the modern Workspace catalog');
});

test('Self parents, visible cycles and deleted cycles show each session once without unstable cycle roots', () => {
  const sessions = [session('c', 'a'), session('b', 'c'), session('a', 'b'), session('self', 'self'), session('orphan', 'deleted-a')];
  const deletedSessions = [session('deleted-a', 'deleted-b'), session('deleted-b', 'deleted-a')];
  const result = rows(snapshot(sessions, { deletedSessions }));
  assert.equal(result.length, sessions.length); assert.equal(new Set(ids(result)).size, sessions.length);
  assert.deepEqual(result.filter(row => ['a', 'b', 'c'].includes(row.id)).map(row => [row.id, row.parentId, row.depth]), [
    ['a', null, 0], ['c', 'a', 1], ['b', 'c', 2],
  ]);
  assert.deepEqual(rows(snapshot([...sessions].reverse(), { deletedSessions })), result, 'Input ordering cannot change the selected edge removed from a cycle');
  for (const id of ['self', 'orphan']) assert.equal(result.find(row => row.id === id).orphan, true);
});

test('Collapsed ancestors hide children, while explicit selection reveals its branch without mutating preferences', () => {
  const state = snapshot([session('root'), session('child', 'root'), session('leaf', 'child'), session('other')], { sessionId: 'leaf' });
  const collapsed = new Set(['root', 'child']);
  assert.deepEqual(ids(rows(state, { collapsed, selectedId: null })), ['other', 'root']);
  const revealed = rows(state, { collapsed });
  assert.deepEqual(ids(revealed), ['other', 'root', 'child', 'leaf']);
  assert.equal(revealed.find(row => row.id === 'root').expanded, true);
  assert.equal(revealed.find(row => row.id === 'child').expanded, true);
  assert.deepEqual([...collapsed], ['root', 'child']);
  assert.deepEqual(ids(rows(state, { collapsed, selectedId: 'gone' })), ['other', 'root']);
});

test('Search includes matching titles and visible ancestors, opens their path and excludes unrelated siblings', () => {
  const state = snapshot([
    session('root', null, { title: '研究紀錄' }), session('child', 'deleted', { title: '來源整理' }),
    session('leaf', 'child', { title: 'ＧＰＴ 設定' }), session('sibling', 'root', { title: '其他問題' }),
    session('unrelated', null, { title: 'Other project' }),
  ], { deletedSessions: [session('deleted', 'root', { title: '不可見的中間筆記' })] });
  const collapsed = new Set(['root', 'child']), result = rows(state, { query: '  gpt ', collapsed, selectedId: null });
  assert.deepEqual(ids(result), ['root', 'child', 'leaf']);
  assert.deepEqual(result.map(row => row.matchesSearch), [false, false, true]);
  assert.deepEqual(result.map(row => row.expanded), [true, true, false]);
  assert.deepEqual([...collapsed], ['root', 'child']);
  assert.deepEqual(ids(rows(state, { query: '研究紀錄' })), ['root'], 'A parent match does not flood the search result with nonmatching descendants');
  assert.deepEqual(rows(state, { query: '不可見的中間筆記' }), [], 'Deleted titles are not active search results');
  assert.deepEqual(rows(state, { query: '/workspace/path' }), [], 'Search remains scoped to titles');
});

test('Subtree recency considers creation dates, ignores invalid timestamps and breaks ties deterministically', () => {
  const state = snapshot([session('a', null, { updatedAt: 'invalid' }), session('b', null, { updatedAt: stamp(5) }),
    session('child', 'a', { createdAt: stamp(6) }), session('d'), session('c')]);
  assert.deepEqual(ids(rows(state, { collapsed: new Set(['a']) })), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids(rows(snapshot([...state.sessions].reverse()), { collapsed: new Set(['a']) })), ['a', 'b', 'c', 'd']);
});

test('Deep imported parent chains use iterative traversal and preserve the last selected row', () => {
  const sessions = Array.from({ length: 12000 }, (_, index) => session(`s${index}`, index ? `s${index - 1}` : null));
  const state = snapshot(sessions, { sessionId: 's11999' });
  const result = rows(state, { collapsed: new Set(['s0', 's5000']) });
  assert.equal(result.length, 12000); assert.equal(result.at(-1).id, 's11999'); assert.equal(result.at(-1).depth, 11999);
});

test('Deleted rows filter by Workspace and normalized titles, ordered by deletion time without mutation', () => {
  const deletedSessions = [session('old', null, { title: 'ＧＰＴ old', deletedAt: stamp(1) }),
    session('new', null, { title: 'GPT new', deletedAt: stamp(3) }), session('other', null, { workspaceId: 'b', title: 'GPT elsewhere', deletedAt: stamp(4) })];
  const before = structuredClone(deletedSessions), state = snapshot([], { deletedSessions });
  assert.deepEqual(ids(workspaceDeletedSessions(state, 'gpt')), ['new', 'old']);
  assert.deepEqual(ids(workspaceDeletedSessions({ ...state, workspaceId: 'b' })), ['other']);
  assert.deepEqual(workspaceDeletedSessions({ ...state, workspaceId: 'unknown' }), []);
  assert.deepEqual(deletedSessions, before);
});

test('Return-to-parent only targets an existing visible direct parent in the same Workspace', () => {
  const state = snapshot([session('root'), session('child', 'root')], { sessionId: 'child' });
  assert.equal(sessionParent(state), 'root');
  assert.equal(sessionParent({ ...state, sessions: [state.sessions[1]], deletedSessions: [state.sessions[0]] }), null);
  assert.equal(sessionParent({ ...state, sessions: [state.sessions[1], session('root', null, { workspaceId: 'b' })] }), null);
  assert.equal(sessionParent({ ...state, parentSessionId: 'missing' }), null);
  assert.equal(sessionParent({ ...state, parentSessionId: 'child' }), null);
  assert.equal(sessionParent({ ...state, sessionId: 'missing', parentSessionId: 'root' }), null);
  assert.equal(sessionParent({ ...state, sessions: [state.sessions[1], { ...state.sessions[0], deletedAt: stamp(3) }] }), null);
});

test('Deletion follows server blocks and related activity; Web renaming remains available during background work', () => {
  const state = snapshot([session('local', null, { origin: 'local' }), session('background', null, { busy: true }), session('other-workspace', null, { workspaceId: 'b' })],
    { sessionId: 'local', readOnly: true, online: false });
  assert.equal(sessionManagementReason(state, 'local', ready), '', 'Local read-only and offline records still allow Web metadata management');
  assert.match(sessionManagementReason(state, 'background', ready), /回覆/);
  assert.equal(sessionManagementReason(state, 'background', { ...ready, action: 'rename' }), '');
  assert.match(sessionManagementReason({ ...state, busy: true }, 'local', ready), /回覆/);
  assert.match(sessionManagementReason({ ...state, operation: 'compact' }, 'local', ready), /操作/);
  assert.match(sessionManagementReason(state, 'other-workspace', ready), /找不到/);
  assert.match(sessionManagementReason(state, 'missing', ready), /找不到/);
  assert.match(sessionManagementReason(state, 'local', { ...ready, connected: false, action: 'rename' }), /連線/);
  assert.match(sessionManagementReason(state, 'local', { ...ready, working: true }), /稍候/);
  const job = { workspaceId: 'a', parentSessionId: 'local', status: 'running' };
  for (const status of ['queued', 'running']) assert.match(sessionManagementReason({ ...state, subagents: [{ ...job, status }] }, 'local', ready), /Sub Agent/);
  for (const changed of [{ status: 'completed' }, { status: 'cancelled' }, { workspaceId: 'b' }, { parentSessionId: 'different' }])
    assert.equal(sessionManagementReason({ ...state, subagents: [{ ...job, ...changed }] }, 'local', ready), '');
  const blocked = { ...state, sessions: [{ ...state.sessions[0], deleteBlockedReason: '子任務正在準備工作目錄。' }] };
  assert.equal(sessionManagementReason(blocked, 'local', ready), '子任務正在準備工作目錄。');
  assert.equal(sessionManagementReason(blocked, 'local', { ...ready, action: 'rename' }), '');
});
