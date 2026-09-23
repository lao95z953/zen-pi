import './isolate.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWebServer } from '../web/server.mjs';
import { eventFrames, parseArgs } from '../bin/zen-pi.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const executable = join(here, '../bin/zen-pi.mjs');
const fixture = join(here, 'fixtures/pi-rpc.mjs');
const root = await mkdtemp(join(tmpdir(), 'zen-pi-attach-'));
const workspace = join(root, 'workspace'), dataDir = join(root, 'web-data');
let app, child, stdout = '', stderr = '', base;

async function until(predicate, label) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const result = await predicate(); if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`等待逾時：${label}\nstdout: ${stdout.slice(-2000)}\nstderr: ${stderr.slice(-1000)}`);
}
async function call(path, body) {
  const response = await fetch(`${base}/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { Origin: base, 'Content-Type': 'application/json', 'X-Pi-Web': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(result)}`);
  return result;
}

try {
  assert.equal(parseArgs(['attach']).url, 'http://127.0.0.1:4318');
  assert.throws(() => parseArgs(['attach', '--url', 'https://example.com']), /本機/);
  assert.throws(() => parseArgs(['attach', '--url', 'http://127.0.0.1:4318/other']), /本機/);
  const parts = ['event: snapshot\r\n', 'data: {"sessionId":"', 'x"}\r\n\r\n', ': keepalive\n\n', 'event: delta\ndata: {"delta":"測', '試"}\n\n'];
  const body = new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(new TextEncoder().encode(part)); controller.close(); } });
  const frames = []; for await (const frame of eventFrames(body)) frames.push(frame);
  assert.deepEqual(frames.map(frame => frame.type), ['snapshot', 'delta']);
  assert.equal(JSON.parse(frames[1].data).delta, '測試');

  await mkdir(workspace);
  app = await createWebServer({ dataDir, workspace, sessionRoots: [], piBin: process.execPath, piArgs: [fixture],
    env: { PATH: process.env.PATH, HOME: root, LANG: 'C.UTF-8' }, publicOrigin: '', tailscaleUser: '' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  const initial = await call('sessions', {}), oldId = initial.sessionId;
  child = spawn(process.execPath, [executable, 'attach', '--url', base], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  await until(() => stdout.includes('Zen Pi 終端已連到 Web 服務'), 'CLI 連線');

  await call('prompt', { sessionId: oldId, message: 'hold' });
  await until(() => stdout.includes('段落') && stdout.includes('你> hold'), 'Web prompt 串流即時顯示於 CLI');
  assert.equal((await call('state')).busy, true, 'The model is still running when CLI has displayed its delta');
  child.stdin.write('/sessions\n');
  await until(() => stdout.includes(oldId), 'CLI 列出目前對話');
  child.stdin.write('下一輪由終端補充\n');
  await until(async () => (await call('state')).queue.followUp.includes('下一輪由終端補充'), 'busy CLI 訊息排入 Web follow-up');
  assert(stdout.includes('已排到下一輪'));
  child.stdin.write('/stop\n');
  await until(async () => !(await call('state')).busy, 'CLI 停止回覆');

  child.stdin.write('/new\n');
  const next = await until(async () => { const state = await call('state'); return state.sessionId !== oldId && state; }, 'CLI 新建 Web 對話');
  assert.equal(next.origin, 'web');
  child.stdin.write('從 CLI 送出的訊息\n');
  await until(async () => (await call('state')).messages.some(message => message.role === 'user' && message.text === '從 CLI 送出的訊息'), 'CLI prompt 進入 Web 對話');
  child.stdin.write(`/open ${oldId}\n`);
  await until(async () => (await call('state')).sessionId === oldId, 'CLI 切換回原 Web 對話');
  child.stdin.write('/not-a-command\n');
  await until(() => stderr.includes('輸入 /retry 重送；草稿：/not-a-command'), 'API 失敗保留可重試草稿');
  child.stdin.write('/confirm\n');
  await until(() => stdout.includes('Pi 詢問：允許測試操作？'), 'CLI 顯示 extension 確認問題');
  child.stdin.write('/answer yes\n');
  await until(() => stdout.includes('已送出回覆。'), 'CLI 回覆 pending prompt 而不被請求序列阻塞');
  await until(async () => !(await call('state')).busy, '確認後的回覆完成');
  child.stdin.write('/exit\n');
  const exitCode = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(exitCode, 0, stderr);
  child = null;
  const offline = spawnSync(process.execPath, [executable, 'attach', '--url', 'http://127.0.0.1:1'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(offline.status, 1); assert.match(offline.stderr, /無法連線/);
  console.log('Attach CLI: local URL guard, chunked SSE, Web→CLI live delta, CLI→Web prompt, busy follow-up, sessions/new/open and exit passed');
} finally {
  child?.kill('SIGTERM');
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
