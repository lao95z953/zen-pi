import { createSessionSyncBridge, findActiveSessionOwner, socketRoot, socketRoots, SessionAlreadyOwnedError } from './bridge.mjs';

const FORWARDED_EVENTS = [
  'agent_start', 'agent_end', 'agent_settled', 'turn_start', 'turn_end',
  'message_start', 'message_update', 'message_end',
  'tool_execution_start', 'tool_execution_update', 'tool_execution_end',
  'session_tree', 'session_info_changed', 'session_compact',
  'model_select', 'thinking_level_select',
];

export default function sessionSyncExtension(pi) {
  let bridge = null;
  let blocked = false;
  let currentContext = null;

  async function close() {
    const previous = bridge;
    bridge = null;
    if (previous) await previous.close();
  }

  pi.on('session_start', async (_event, ctx) => {
    await close();
    blocked = false;
    currentContext = ctx;
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return; // Ephemeral/in-memory sessions are never shared.
    try {
      const otherRoots = ctx.mode === 'tui' ? socketRoots().filter(root => root !== socketRoot()) : socketRoots();
      if (await findActiveSessionOwner(sessionFile, otherRoots)) throw new SessionAlreadyOwnedError();
      if (ctx.mode !== 'tui') return;
      bridge = await createSessionSyncBridge({
        sessionFile,
        sessionId: ctx.sessionManager.getSessionId(),
        getState: () => ({
          leafId: currentContext?.sessionManager.getLeafId() ?? null,
          busy: currentContext ? !currentContext.isIdle() : false,
          pending: currentContext?.hasPendingMessages() ?? false,
        }),
        sendPrompt: (text, options) => {
          if (blocked || !bridge) throw new Error('Session bridge is not active');
          if (text.startsWith('/')) throw new Error('Native slash commands are not supported through Web yet');
          if (!currentContext?.model) throw new Error('No model selected in Pi');
          pi.sendUserMessage(text, options);
        },
        abort: () => currentContext?.abort(),
      });
      ctx.ui.setStatus('zen-session-sync', 'Web 同步中');
    } catch (error) {
      blocked = true;
      if (error instanceof SessionAlreadyOwnedError) {
        ctx.ui.notify('這份 Session 已在另一個 Pi 或 Web 視窗中使用，避免同時寫入，這個 Pi 視窗將關閉。', 'error');
      } else ctx.ui.notify(`Session 即時同步無法鎖定，這個 Pi 視窗將關閉：${error?.message ?? error}`, 'error');
      // The input hook below also protects the short interval before shutdown.
      setImmediate(() => ctx.shutdown());
    }
  });

  pi.on('session_shutdown', async () => {
    blocked = false;
    currentContext = null;
    await close();
  });

  pi.on('input', (event, ctx) => {
    currentContext = ctx;
    if (blocked) return { action: 'handled' };
    bridge?.publish(event);
  });

  for (const name of FORWARDED_EVENTS) {
    pi.on(name, (event, ctx) => {
      currentContext = ctx;
      // Ordinary message appends advance Pi's leaf without a session_tree event.
      // Include the final in-memory leaf so Web rereads the same branch.
      bridge?.publish(name === 'agent_settled'
        ? { ...event, sessionSyncLeafId: ctx.sessionManager.getLeafId() }
        : event);
    });
  }
}
