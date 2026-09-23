import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createConnection } from 'node:net';
import { socketPathForSession, socketRoots } from '../extensions/session-sync/bridge.mjs';

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 2000;

/** Attach to the existing native Pi TUI writer; this client never opens its JSONL for writing. */
export async function connectNativeSession({ sessionFile, sessionId, onEvent = () => {}, onClose = () => {}, roots = socketRoots() }) {
  for (const root of roots) {
    const client = await connectAtRoot({ sessionFile, sessionId, onEvent, onClose, root });
    if (client) return client;
  }
  return null;
}

async function connectAtRoot({ sessionFile, sessionId, onEvent, onClose, root }) {
  const path = socketPathForSession(sessionFile, root);
  const [directory, socketFile] = await Promise.all([
    fs.lstat(root).catch(error => { if (error.code === 'ENOENT') return null; throw error; }),
    fs.lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; }),
  ]);
  if (!directory || !socketFile) return null;
  if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o077) !== 0 ||
      !socketFile.isSocket() || socketFile.uid !== process.getuid() || (socketFile.mode & 0o077) !== 0)
    throw new Error('Session 同步連線的權限不安全。');

  const peer = createConnection(path);
  const pending = new Map();
  let buffer = Buffer.alloc(0), hello, closed = false, ready;
  const failPending = error => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  const connected = new Promise((resolve, reject) => { ready = { resolve, reject }; });
  const timeout = setTimeout(() => peer.destroy(new Error('原生 Pi 同步連線逾時。')), HELLO_TIMEOUT_MS);
  timeout.unref();
  const finish = error => {
    if (closed) return;
    closed = true; clearTimeout(timeout);
    const reason = error || new Error('原生 Pi 已關閉同步連線。');
    ready?.reject(reason); ready = null;
    failPending(reason); if (hello) onClose(reason);
  };
  peer.on('error', finish);
  peer.on('close', () => finish());
  peer.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_FRAME_BYTES) { peer.destroy(new Error('原生 Pi 同步訊息過大。')); return; }
    let newline;
    while ((newline = buffer.indexOf(10)) !== -1) {
      const line = buffer.subarray(0, newline).toString('utf8');
      buffer = buffer.subarray(newline + 1);
      let frame;
      try { frame = JSON.parse(line); }
      catch { peer.destroy(new Error('原生 Pi 同步訊息格式錯誤。')); return; }
      if (!hello) {
        if (frame?.type !== 'hello' || frame.version !== 1 || frame.owner !== 'native' ||
            frame.sessionFile !== sessionFile || frame.sessionId !== sessionId) {
          peer.destroy(new Error('原生 Pi 同步身分不符。')); return;
        }
        hello = frame; clearTimeout(timeout); ready?.resolve(frame); ready = null;
        continue;
      }
      if (frame?.type === 'event') { onEvent(frame.event); continue; }
      if (frame?.type === 'invalidate') { onEvent({ type: 'session_sync_invalidate' }); continue; }
      if (frame?.type === 'close') { peer.end(); continue; }
      if (frame?.type === 'ack' || frame?.type === 'error') {
        const item = pending.get(frame.id);
        if (!item) continue;
        pending.delete(frame.id); clearTimeout(item.timer);
        frame.type === 'ack' ? item.resolve(frame) : item.reject(new Error(String(frame.error || '原生 Pi 拒絕訊息。')));
      }
    }
  });
  try { await connected; }
  catch (error) {
    peer.destroy();
    if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) return null;
    throw error;
  }
  function request(type, payload = {}) {
    if (closed) return Promise.reject(new Error('原生 Pi 已離線。'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('原生 Pi 未回覆訊息確認。')); }, 5000);
      pending.set(id, { resolve, reject, timer });
      peer.write(JSON.stringify({ id, type, ...payload }) + '\n', error => {
        if (error && pending.has(id)) { pending.delete(id); clearTimeout(timer); reject(error); }
      });
    });
  }
  return {
    hello,
    get closed() { return closed; },
    prompt(text, deliverAs = 'followUp') {
      if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 64 * 1024) return Promise.reject(new Error('訊息必須介於 1 到 65536 bytes。'));
      return request('prompt', { text, deliverAs });
    },
    abort() { return request('abort'); },
    close() { peer.destroy(); },
  };
}
