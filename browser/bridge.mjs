import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const PORT = 4319;
export const VERSION = 1;
const key = () => randomBytes(24).toString('hex');
const fail = message => { throw new Error(message); };
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Transport only: a single task owns the attached browser; no model or page data is persisted. */
export async function createBrowserBridge({ token, port = PORT, timeout = 20000, leaseMs = 300000 } = {}) {
  if (!/^[a-f0-9]{48}$/.test(token || '')) throw new Error('Invalid bridge token');
  let peer = null, poll = null, pending = null, task = null, closed = false;
  const reply = (res, value, code = 200) => { if (!res.writableEnded) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); } };
  function cancel(reason) {
    task = null;
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error(reason)); pending = null; }
  }
  function deliver() {
    if (poll && pending && !pending.sent) {
      pending.sent = true;
      clearTimeout(poll.timer); reply(poll.res, { command: pending.command }); poll = null;
    }
  }
  function dispatch(command) {
    if (!peer || Date.now() - peer.seen > 35000) fail('Zen 擴充套件尚未連線，請先完成 /browser setup。');
    if (pending) fail('瀏覽器已有操作進行中。');
    return new Promise((resolve, reject) => {
      const id = key();
      pending = { command: { ...command, id }, resolve, reject, sent: false,
        timer: setTimeout(() => { pending = null; task = null; reject(new Error('瀏覽器回應逾時；操作結果不確定，任務已停止，請先檢查分頁。')); }, timeout) };
      deliver();
    });
  }
  const server = http.createServer(async (req, res) => {
    try {
      const address = server.address();
      if (req.headers.host !== `127.0.0.1:${address.port}` || req.headers.origin && !/^moz-extension:\/\/[a-f0-9-]+$/.test(req.headers.origin)) return reply(res, { error: 'Forbidden origin or host' }, 403);
      if (!equal(req.headers.authorization, `Bearer ${token}`)) return reply(res, { error: 'Unauthorized' }, 401);
      if (req.method !== 'POST' || !['/client', '/extension/poll', '/extension/result'].includes(req.url)) return reply(res, { error: 'Not found' }, 404);
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 256 * 1024) fail('Request too large'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Invalid request');
      if (task && task.expires < Date.now()) cancel('瀏覽器任務閒置逾時，請重新 /browser。');
      if (req.url.startsWith('/extension/')) {
        if (!/^[a-zA-Z0-9-]{16,64}$/.test(body.peer || '')) fail('Invalid browser identity');
        if (peer && peer.id !== body.peer && (task || Date.now() - peer.seen < 35000)) fail('另一個瀏覽器已連線。');
        peer = { id: body.peer, seen: Date.now() };
        if (req.url === '/extension/poll') {
          if (poll) { clearTimeout(poll.timer); reply(poll.res, { command: null }); }
          const timer = setTimeout(() => { if (poll?.res === res) { reply(res, { command: null }); poll = null; } }, 20000);
          poll = { res, timer };
          res.on('close', () => { if (poll?.res === res) { clearTimeout(timer); poll = null; } });
          deliver(); return;
        }
        if (!pending || pending.command.id !== body.id || !pending.sent) fail('Expired browser response');
        const active = pending; pending = null; clearTimeout(active.timer);
        if (body.error) { task = null; active.reject(new Error(String(body.error).slice(0, 500))); }
        else active.resolve(body.result);
        return reply(res, { ok: true });
      }
      if (body.op === 'status') return reply(res, { version: VERSION, connected: !!peer && Date.now() - peer.seen < 35000, busy: !!task });
      if (body.op === 'tabs') {
        if (task) fail('請先停止目前的瀏覽器任務。');
        return reply(res, await dispatch({ op: 'tabs' }));
      }
      if (body.op === 'begin') {
        if (task) fail('已有另一個瀏覽器任務，請先停止。');
        if (body.url) { const url = new URL(body.url); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) fail('只支援 HTTP(S) 網頁。'); }
        else if (!Number.isInteger(body.tabId) || body.tabId < 0) fail('請指定分頁 ID 或網址。');
        const lease = key(); task = { lease, expires: Date.now() + leaseMs };
        try {
          const page = await dispatch({ op: 'begin', job: lease, url: body.url, tabId: body.tabId });
          if (!task || task.lease !== lease) fail('任務已停止。');
          return reply(res, { lease, page });
        } catch (error) { if (task?.lease === lease) task = null; throw error; }
      }
      if (!task || !equal(body.lease, task.lease)) fail('瀏覽器任務未啟用或已結束，請重新 /browser。');
      task.expires = Date.now() + leaseMs;
      if (body.op === 'stop') { cancel('瀏覽器任務已停止。'); return reply(res, { stopped: true }); }
      if (!['observe', 'act'].includes(body.op)) fail('Unknown operation');
      const lease = task.lease;
      const result = await dispatch({ op: body.op, job: lease, action: body.action, snapshot: body.snapshot, text: body.text });
      if (!task || task.lease !== lease) fail('任務已停止。');
      return reply(res, result);
    } catch (error) { reply(res, { error: String(error.message).slice(0, 600) }, 400); }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { port: server.address().port, async close() {
    if (closed) return; closed = true; cancel('Bridge closed');
    if (poll) { clearTimeout(poll.timer); reply(poll.res, { command: null }); poll = null; }
    const done = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await done;
  } };
}
