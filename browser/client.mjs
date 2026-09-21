import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { PORT, VERSION } from './bridge.mjs';

export const browserHome = () => process.env.PI_BROWSER_HOME || join(homedir(), '.pi', 'browser');
export async function connection() {
  const directory = browserHome();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'connection.json');
  try { await fs.writeFile(path, JSON.stringify({ endpoint: `http://127.0.0.1:${PORT}`, token: randomBytes(24).toString('hex') }) + '\n', { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await fs.lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('connection.json 必須是權限 0600 的一般檔案。');
  const config = JSON.parse(await fs.readFile(path, 'utf8'));
  if (config.endpoint !== `http://127.0.0.1:${PORT}` || !/^[a-f0-9]{48}$/.test(config.token || '')) throw new Error('Browser connection 設定無效。');
  return { ...config, path };
}
export async function request(config, body, signal) {
  const response = await fetch(config.endpoint + '/client', { method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000) });
  const value = await response.json();
  if (!response.ok || value.error) throw new Error(value.error || 'Browser bridge request failed');
  return value;
}
export async function ensureBridge() {
  const config = await connection();
  try {
    const value = await request(config, { op: 'status' });
    if (value.version !== VERSION) throw new Error('Browser Bridge 版本不同，請關閉舊版後重試。');
    return config;
  } catch (error) { if (!error.cause || !['ECONNREFUSED', 'ECONNRESET'].includes(error.cause.code)) throw error; }
  const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'daemon.mjs')], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    try { const status = await request(config, { op: 'status' }); if (status.version === VERSION) return config; } catch { /* startup race */ }
  }
  throw new Error('Browser Bridge 啟動失敗；請檢查 127.0.0.1:4319 是否被其他服務占用。');
}
