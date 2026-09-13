import http from 'node:http';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Private local IPC. Only the parent Pi receives this socket path. */
export async function createSubagentBridge(handle) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'pi-agent-'));
  await fs.chmod(directory, 0o700);
  const socketPath = join(directory, 'bridge.sock');
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      if (request.method !== 'POST' || request.url !== '/subagent') throw new Error('無效的 Sub Agent 操作。');
      let length = 0; const chunks = [];
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 128 * 1024) throw new Error('Sub Agent 請求過大。');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('Sub Agent 請求格式無效。');
      response.end(JSON.stringify({ ok: true, data: await handle(body) }));
    } catch (error) {
      response.statusCode = error.status || 400;
      response.end(JSON.stringify({ ok: false, error: String(error.message || 'Sub Agent 操作失敗。').slice(0, 1400) }));
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await fs.chmod(socketPath, 0o600);
  return { socketPath, async close() {
    const stopped = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await stopped;
    await fs.rm(directory, { recursive: true, force: true });
  } };
}
