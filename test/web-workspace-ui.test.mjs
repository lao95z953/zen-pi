import './isolate.mjs';
import assert from 'node:assert/strict';
import { selectedWorkspace, workspaceSessions, workspaceControls, draftScope, acceptsCreatedSession, mergeRestoredDraft, libraryScanWarning } from '../web/public/state.js';
const snapshot = {
  workspaces: [
    { id: 'workspace-a', name: 'project', path: '/home/me/project', available: true, sessionCount: 2 },
    { id: 'workspace-b', name: 'project', path: '/home/me/archive/project', available: true, sessionCount: 1 },
    { id: 'workspace-missing', name: 'gone', path: '/old/worktree/gone', available: false, sessionCount: 1 },
  ],
  workspaceId: 'workspace-a', sessionId: null, readOnly: false, busy: false, online: false,
  sessions: [
    { id: 'local-' + 'a'.repeat(32), workspaceId: 'workspace-a', origin: 'local', title: 'NAT 理解紀錄' },
    { id: 'opaque-web-id', workspaceId: 'workspace-a', origin: 'web', title: 'ＧＰＴ 設定' },
    { id: 'another-local-id', workspaceId: 'workspace-b', origin: 'local', title: 'NAT 實作' },
    { id: 'old-worktree-record', workspaceId: 'workspace-missing', origin: 'local', title: '保留的舊紀錄' },
  ],
};
const ready = { connected: true, working: false };
assert.equal(selectedWorkspace(snapshot).path, '/home/me/project');
assert.deepEqual(workspaceSessions(snapshot).map(s => s.id), ['local-' + 'a'.repeat(32), 'opaque-web-id'], 'Both CLI and Web records appear in their actual working directory');
assert.deepEqual(workspaceSessions({ ...snapshot, workspaceId: 'workspace-b' }).map(s => s.id), ['another-local-id'], 'Same folder names cannot merge distinct workspaces');
assert.equal(workspaceSessions(snapshot, 'nat').length, 1);
assert.equal(workspaceSessions(snapshot, 'gpt')[0].title, 'ＧＰＴ 設定', 'Search handles ASCII case and full-width titles');
assert.equal(workspaceSessions(snapshot, '/home/me/project').length, 0, 'Search is limited to session titles');
assert.equal(workspaceSessions({ ...snapshot, workspaceId: 'unknown' }).length, 0, 'An unknown workspace cannot display sessions from elsewhere');
assert.equal(selectedWorkspace({ ...snapshot, workspaceId: 'unknown' }), null, 'Selection does not silently fall back to another workspace');
assert.equal(workspaceControls(snapshot, ready).start, true);
assert.equal(workspaceControls(snapshot, ready).send, true, 'An empty available workspace can create a new session on submit');
assert.equal(workspaceControls({ ...snapshot, workspaceId: 'unknown' }, ready).start, false);
const archive = { ...snapshot, sessionId: snapshot.sessions[0].id, readOnly: true, canContinue: true, origin: 'local' };
const archiveControls = workspaceControls(archive, ready);
assert.equal(archiveControls.input, false);
assert.equal(archiveControls.mode, false);
assert.equal(archiveControls.send, false);
assert.equal(archiveControls.continue, true);
assert.equal(archiveControls.browse, true, 'Read-only preview can still navigate the catalog');
assert.equal(archiveControls.start, true, 'A local preview does not prevent starting a separate conversation');
const missing = { ...archive, workspaceId: 'workspace-missing', canContinue: false };
const missingControls = workspaceControls(missing, ready);
assert.equal(missingControls.browse, true, 'Missing working directories still allow reading their history');
assert.equal(missingControls.continue, false);
assert.equal(missingControls.start, false);
assert.equal(missingControls.input, false);
assert.equal(workspaceControls({ ...archive, canContinue: false }, ready).continue, false, 'The server decides whether continuation is available');
for (const activity of [{ connected: false, working: false }, { connected: true, working: true }]) {
  const controls = workspaceControls(archive, activity);
  for (const name of ['browse', 'start', 'continue', 'send']) assert.equal(controls[name], false);
}
const busyControls = workspaceControls({ ...snapshot, busy: true }, ready);
for (const name of ['mode', 'continue', 'send']) assert.equal(busyControls[name], false);
for (const name of ['browse', 'start']) assert.equal(busyControls[name], true, 'A background response does not lock workspace and session navigation');
assert.equal(busyControls.input, true, 'A new draft can be typed while the current reply streams');
assert.notEqual(draftScope(snapshot), draftScope({ ...snapshot, workspaceId: 'workspace-b' }), 'Empty-session drafts are scoped to their workspace');
assert.notEqual(draftScope(archive), draftScope({ ...archive, sessionId: 'forked-web-session', readOnly: false }), 'A copied local session does not inherit a stale composer draft');
assert.equal(draftScope({ ...snapshot, sessions: [] }), draftScope(snapshot), 'Catalog refresh does not change the active draft scope');
assert.notEqual(draftScope({ workspaceId: 'a:b', sessionId: 'c' }), draftScope({ workspaceId: 'a', sessionId: 'b:c' }), 'Opaque IDs cannot collide across draft scopes');
assert.notEqual(draftScope({ workspaceId: 'default', sessionId: 'new' }), draftScope({ workspaceId: null, sessionId: null }));
const created = { ...snapshot, sessionId: 'created-a', revision: 11, startedAt: 100 };
assert.equal(acceptsCreatedSession({ ...snapshot, revision: 10, startedAt: 100 }, created, 'workspace-a'), true);
assert.equal(acceptsCreatedSession(created, created, 'workspace-a'), true, 'Receiving the same created session through SSE first is safe');
assert.equal(acceptsCreatedSession({ ...created, revision: 12, workspaceId: 'workspace-b', sessionId: 'active-b' }, created, 'workspace-a'), false, 'Late create response cannot send an A prompt into B');
assert.equal(acceptsCreatedSession({ ...created, revision: 12, sessionId: 'another-a' }, created, 'workspace-a'), false, 'Another session in the same workspace is a different operation target');
assert.equal(acceptsCreatedSession({ ...created, revision: 12 }, created, 'workspace-a'), true, 'Background progress does not invalidate the same created session already received through SSE');
assert.equal(acceptsCreatedSession({ ...created, revision: 12, readOnly: true }, created, 'workspace-a'), false, 'A read-only current session cannot authorize a dependent mutation');
assert.equal(acceptsCreatedSession({ ...snapshot, revision: 10, startedAt: 100 }, { ...created, readOnly: true }, 'workspace-a'), false);
const drafts = new Map([[draftScope(snapshot), '新的 A 草稿'], [draftScope({ ...snapshot, workspaceId: 'workspace-b' }), 'B 草稿']]);
const failedScope = draftScope(snapshot);
drafts.set(failedScope, mergeRestoredDraft(drafts.get(failedScope), 'A 失敗的訊息'));
assert.equal(drafts.get(failedScope), 'A 失敗的訊息\n\n新的 A 草稿');
assert.equal(drafts.get(draftScope({ ...snapshot, workspaceId: 'workspace-b' })), 'B 草稿', 'Recovery uses the captured scope, leaving the current workspace draft untouched');
assert.equal(mergeRestoredDraft('已輸入的草稿', '停止後未送出的訊息', true), '已輸入的草稿\n\n停止後未送出的訊息');
assert.equal(mergeRestoredDraft('同一則訊息', '同一則訊息'), '同一則訊息');
assert.equal(libraryScanWarning(2), '掃描遇到 2 項問題，部分紀錄可能未列出。');
for (const count of [0, -1, undefined, '2', 1.5]) assert.equal(libraryScanWarning(count), '');
console.log('Workspace UI filtering, read-only controls, missing directories, and draft isolation checks passed');
