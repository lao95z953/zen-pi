import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const MAX_COMMAND_BYTES = 128 * 1024;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const EVENT_TYPES = new Set([
  'input', 'agent_start', 'agent_end', 'agent_settled',
  'turn_start', 'turn_end', 'message_start', 'message_update', 'message_end',
  'tool_execution_start', 'tool_execution_update', 'tool_execution_end',
  'session_tree', 'session_info_changed', 'session_compact',
  'model_select', 'thinking_level_select',
]);

export function canonicalSessionFile(sessionFile) {
  if (typeof sessionFile !== 'string' || !sessionFile) throw new Error('Session file is required');
  const absolute = resolve(sessionFile);
  try { return realpathSync(absolute); }
  catch (error) {
    // Pi defers creation of a new session JSONL until its first assistant turn.
    if (error?.code !== 'ENOENT') throw error;
    return join(realpathSync(dirname(absolute)), basename(absolute));
  }
}

function usableRuntimeDir(path) {
  if (!path) return false;
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0;
  } catch { return false; }
}

export function socketRoots() {
  const fallback = join(tmpdir(), `zen-pi-session-sync-${process.getuid()}`);
  // SSH shells sometimes omit XDG_RUNTIME_DIR even though the same systemd
  // user runtime directory is available to the Web service.
  const runtime = usableRuntimeDir(process.env.XDG_RUNTIME_DIR)
    ? process.env.XDG_RUNTIME_DIR
    : `/run/user/${process.getuid()}`;
  const preferred = join(runtime, 'zen-pi-session-sync');
  // Linux sockaddr_un.sun_path holds at most 107 pathname bytes plus NUL.
  return usableRuntimeDir(runtime) && Buffer.byteLength(join(preferred, `${'a'.repeat(32)}.sock`)) <= 107
    ? [preferred, fallback]
    : [fallback];
}

export function socketRoot() {
  return socketRoots()[0];
}

export function socketPathForSession(sessionFile, root = socketRoot()) {
  const canonical = canonicalSessionFile(sessionFile);
  return join(root, `${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}.sock`);
}

export function ensurePrivateSocketRoot(root = socketRoot()) {
  try { mkdirSync(root, { mode: 0o700 }); }
  catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Unsafe Session bridge directory: ${root}`);
  }
  return root;
}

function probeSocket(path) {
  return new Promise(resolve => {
    const peer = createConnection(path);
    const timer = setTimeout(() => { peer.destroy(); resolve(true); }, 500);
    timer.unref();
    peer.once('connect', () => { clearTimeout(timer); peer.destroy(); resolve(true); });
    peer.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}

export async function findActiveSessionOwner(sessionFile, roots = socketRoots()) {
  for (const root of roots) {
    const path = socketPathForSession(sessionFile, root);
    try {
      if (lstatSync(path).isSocket() && await probeSocket(path)) return path;
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  return null;
}

function listen(server, path) {
  return new Promise((resolve, reject) => {
    const onError = error => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(path);
  });
}

export class SessionAlreadyOwnedError extends Error {
  constructor() { super('This Session is already open in another Pi process'); this.name = 'SessionAlreadyOwnedError'; }
}

export class StaleSessionSocketError extends Error {
  constructor(path) {
    super(`Session bridge socket is left over from a stopped process: ${path}. Confirm that no Pi or Web process owns this Session, then remove this socket and retry.`);
    this.name = 'StaleSessionSocketError';
  }
}

/** One native Pi TUI process owns one JSONL session file and forwards its events to Web. */
export async function createSessionSyncBridge({ sessionFile, sessionId, owner = 'native', getState = () => ({}), sendPrompt, abort, root = socketRoot() }) {
  if (!['native', 'web'].includes(owner) || typeof getState !== 'function' ||
      (owner === 'native' && typeof sendPrompt !== 'function')) throw new TypeError('Invalid Session bridge handlers');
  const canonical = canonicalSessionFile(sessionFile);
  ensurePrivateSocketRoot(root);
  const path = socketPathForSession(canonical, root);
  const clients = new Set();
  const handled = new Map();
  let closed = false;
  const remember = (id, reply) => {
    handled.set(id, reply);
    if (handled.size > 256) handled.delete(handled.keys().next().value);
  };

  const write = (peer, message) => {
    if (peer.destroyed) return;
    const line = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(line) > MAX_EVENT_BYTES || peer.writableLength + Buffer.byteLength(line) > MAX_BUFFERED_BYTES) {
      peer.destroy();
      return;
    }
    peer.write(line);
  };

  const server = createServer(peer => {
    clients.add(peer);
    let incoming = '';
    const decoder = new StringDecoder('utf8');
    peer.on('close', () => clients.delete(peer));
    peer.on('error', () => {});
    write(peer, { type: 'hello', version: 1, owner, sessionFile: canonical, sessionId, ...getState() });
    peer.on('data', chunk => {
      incoming += decoder.write(chunk);
      if (Buffer.byteLength(incoming) > MAX_COMMAND_BYTES) { peer.destroy(); return; }
      let newline;
      while ((newline = incoming.indexOf('\n')) !== -1) {
        const line = incoming.slice(0, newline);
        incoming = incoming.slice(newline + 1);
        if (!line) continue;
        let command;
        try { command = JSON.parse(line); }
        catch { write(peer, { type: 'error', error: 'Invalid JSON' }); continue; }
        const id = typeof command?.id === 'string' && command.id.length <= 100 ? command.id : undefined;
        if (closed) { write(peer, { type: 'error', id, error: 'Session bridge is closing' }); continue; }
        if (owner === 'web') { write(peer, { type: 'error', id, error: 'This Session is owned by Web' }); continue; }
        if (id && handled.has(id)) { write(peer, handled.get(id)); continue; }
        if (id && command.type === 'abort') {
          try {
            abort?.();
            const reply = { type: 'ack', id, status: 'requested' };
            remember(id, reply);
            write(peer, reply);
          } catch (error) {
            write(peer, { type: 'error', id, error: String(error?.message ?? error) });
          }
          continue;
        }
        if (!id || command.type !== 'prompt' || typeof command.text !== 'string' ||
            !command.text.trim() || Buffer.byteLength(command.text) > 64 * 1024 ||
            ![undefined, 'followUp', 'steer'].includes(command.deliverAs)) {
          write(peer, { type: 'error', id, error: 'Invalid prompt command' });
          continue;
        }
        try {
          // Pi's ExtensionAPI is intentionally fire-and-forget. Completion is reported
          // through native message and agent events, never by this acknowledgement.
          sendPrompt(command.text, { deliverAs: command.deliverAs ?? 'followUp' });
          const reply = { type: 'ack', id, status: 'queued' };
          remember(id, reply);
          write(peer, reply);
        } catch (error) {
          write(peer, { type: 'error', id, error: String(error?.message ?? error) });
        }
      }
    });
  });
  server.on('error', () => {});
  try {
    await listen(server, path);
  } catch (error) {
    if (error?.code !== 'EADDRINUSE') throw error;
    // Do not unlink after probing: two processes could both observe a stale
    // socket, and the later unlink could remove the first process's new owner.
    // An existing socket always fails closed until an operator removes it.
    try {
      const stat = lstatSync(path);
      if (stat.isSocket() && !(await probeSocket(path))) throw new StaleSessionSocketError(path);
    } catch (probeError) {
      if (probeError instanceof StaleSessionSocketError) throw probeError;
      if (probeError?.code !== 'ENOENT') throw probeError;
    }
    throw new SessionAlreadyOwnedError();
  }
  const socketStat = lstatSync(path);
  if (!socketStat.isSocket()) throw new Error('Session bridge did not create a Unix socket');
  // A private 0700 directory is the primary boundary; socket mode is tightened too.
  chmodSync(path, 0o600);

  return {
    path,
    sessionFile: canonical,
    publish(event) {
      if (closed || !EVENT_TYPES.has(event?.type)) return;
      let frame;
      try { frame = JSON.stringify({ type: 'event', event }); }
      catch { frame = null; }
      if (!frame || Buffer.byteLength(frame) > MAX_EVENT_BYTES) frame = JSON.stringify({ type: 'invalidate' });
      for (const peer of clients) {
        if (peer.writableLength + Buffer.byteLength(frame) > MAX_BUFFERED_BYTES) peer.destroy();
        else peer.write(frame + '\n');
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const peer of clients) { write(peer, { type: 'close' }); peer.end(); peer.destroy(); }
      clients.clear();
      await new Promise(done => server.close(() => done()));
      try {
        const current = lstatSync(path);
        if (current.isSocket() && current.ino === socketStat.ino && current.dev === socketStat.dev) unlinkSync(path);
      } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    },
  };
}
