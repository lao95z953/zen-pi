import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createImageStore, MAX_IMAGE_BYTES } from '../web/images.mjs';
import { createWebServer } from '../web/server.mjs';
const root = await mkdtemp(join(tmpdir(), 'zen-images-'));
const png = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRusAAAAASUVORK5CYII=' };
let app, base;
const log = join(root, 'rpc.log');
const options = { workspace: root, dataDir: join(root, 'data'), sessionRoots: [], piBin: process.execPath,
  piArgs: [fileURLToPath(new URL('./fixtures/pi-rpc.mjs', import.meta.url))], env: { ...process.env, HOME: root, FAKE_RPC_LOG: log, FAKE_IMAGE_QUEUES: '1' } };
async function launch() { app = await createWebServer(options); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`; }
async function api(path, body, expected = 200, headers = {}) {
  const response = await fetch(`${base}/api/${path}`, body === undefined ? { headers } : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pi-Web': '1', Origin: base, ...headers }, body: JSON.stringify(body) });
  assert.equal(response.status, expected, await response.clone().text()); return response.json();
}
async function idle() { let state; for (let i = 0; i < 200; i++) { state = await api('state'); if (!state.busy) return state; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error('Fixture did not settle'); }
try {
  const store = await createImageStore(join(root, 'cache'));
  const [descriptor] = await store.upload([png]);
  assert.deepEqual(await store.resolve([descriptor.id]), [png]);
  assert.equal((await stat(join(root, 'cache', descriptor.id))).mode & 0o777, 0o600);
  assert.deepEqual((await store.upload([png]))[0], descriptor, 'Identical bytes keep the same reference');
  for (const invalid of [{ ...png, mimeType: 'image/jpeg' }, { mimeType: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') }, { ...png, data: png.data + '*' }]) await assert.rejects(store.upload([invalid]));
  await assert.rejects(store.upload(Array(5).fill(png)));
  await assert.rejects(store.upload([{ ...png, data: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64') }]), /5 MiB/);
  const large = { ...png, data: Buffer.concat([Buffer.from(png.data, 'base64'), Buffer.alloc(MAX_IMAGE_BYTES - 100)]).toString('base64') };
  await assert.rejects(store.upload([large, large]), /8 MiB/);
  await assert.rejects(store.resolve(['../../private']));
  const otherPng = Buffer.concat([Buffer.from(png.data, 'base64'), Buffer.from('different')]), otherId = createHash('sha256').update(otherPng).digest('hex');
  await writeFile(join(root, 'outside'), otherPng); await symlink(join(root, 'outside'), join(root, 'cache', otherId));
  await assert.rejects(store.read(otherId), 'Image lookup never follows a symlink');
  await launch(); const s = await api('sessions', {}), scope = { sessionId: s.sessionId, workspaceId: s.workspaceId };
  const uploaded = await api('images', { ...scope, images: [png] });
  const image = uploaded.images[0]; assert.equal(image.id, descriptor.id);
  let bytes = await fetch(`${base}/api/images/${image.id}`);
  assert.equal(bytes.headers.get('Content-Type'), 'image/png'); assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), Buffer.from(png.data, 'base64'));
  assert.equal((await fetch(`${base}/api/images/${image.id}`, { headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
  await api('images', { ...scope, images: [png] }, 403, { Origin: 'https://untrusted.invalid' });
  await api('prompt', { ...scope, message: '/help', imageIds: [image.id] }, 400);
  await api('prompt', { ...scope, message: 'test', imageIds: ['b'.repeat(64)] }, 404);
  await api('prompt', { ...scope, message: '', imageIds: [image.id] });
  const done = await idle(), user = done.messages.find(message => message.role === 'user');
  assert.equal(user.images[0].id, image.id, 'Image-only prompts retain an image in the conversation');
  assert.ok(!JSON.stringify(done).includes(png.data), 'Snapshots contain references, never image base64');
  let requests = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(requests.find(request => request.type === 'prompt' && request.images)?.images, [png], 'Original image bytes reach the native Pi RPC');
  await app.close(); await launch();
  assert.equal((await api('state')).messages.find(message => message.images)?.images[0].id, image.id, 'Image history survives restarting');
  await api('prompt', { ...scope, message: 'hold' });
  for (const action of ['steer', 'follow_up']) await api('queue', { ...scope, action, message: action, imageIds: [image.id] });
  const queued = await api('state');
  assert.equal(queued.queuedImages.steering[0][0].id, image.id); assert.equal(queued.queuedImages.followUp[0][0].id, image.id);
  const restored = await api('queue', { ...scope, action: 'clear' });
  assert.equal(restored.restoredImages.length, 2); assert.equal(restored.restoredImages[0].id, image.id);
  await api('queue', { ...scope, action: 'follow_up', message: 'before abort', imageIds: [image.id] });
  const stopped = await api('stop', scope); assert.equal(stopped.restoredImages[0].id, image.id); assert.match(stopped.restored, /before abort/);
  requests = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  for (const type of ['steer', 'follow_up']) assert.deepEqual(requests.find(request => request.type === type).images, [png]);
  await app.close(); options.env.FAKE_NO_IMAGES = '1'; await launch();
  await api('prompt', { ...scope, message: 'inspect', imageIds: [image.id] }, 422);
  assert.equal((await api('state')).busy, false);
  await app.close(); delete options.env.FAKE_NO_IMAGES; options.env.FAKE_CONSUME_FOLLOW_UP = '1'; await launch();
  const second = (await api('images', { ...scope, images: [{ ...png, data: otherPng.toString('base64') }] })).images[0];
  await api('prompt', { ...scope, message: 'hold' });
  await api('queue', { ...scope, action: 'steer', message: '', imageIds: [image.id] });
  await api('queue', { ...scope, action: 'follow_up', message: '', imageIds: [second.id] });
  const delivered = await api('state');
  assert.equal(delivered.queue.steering.length, 1); assert.equal(delivered.queue.followUp.length, 0,
    'Identical image-only prompt text must match the delivered images, even across different queue types');
  const remaining = await api('stop', scope);
  assert.deepEqual(remaining.restoredImages.map(image => image.id), [image.id], 'Only undelivered images return to the draft');
  console.log('Image validation, private cache, native RPC, history, queue/stop recovery and text-only model rejection passed');
} finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
