import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { join } from 'node:path';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024, MAX_BATCH_BYTES = 8 * 1024 * 1024, MAX_IMAGES = 4;
const ID = /^[a-f0-9]{64}$/;
const fail = (status, message) => Object.assign(new Error(message), { status });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function mimeOf(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  throw fail(400, '圖片格式無法辨識；請使用 PNG、JPEG、WebP 或 GIF。');
}
function decode(image) {
  if (!image || typeof image.data !== 'string' || image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw fail(413, '每張圖片最多 5 MiB。');
  if (!image.data.length || image.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw fail(400, '圖片資料格式錯誤。');
  const bytes = Buffer.from(image.data, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) throw fail(413, '每張圖片最多 5 MiB。');
  if (bytes.toString('base64') !== image.data) throw fail(400, '圖片資料格式錯誤。');
  const mimeType = mimeOf(bytes);
  if (image.mimeType !== mimeType) throw fail(400, '圖片內容與格式不一致。');
  return { bytes, mimeType, id: digest(bytes), size: bytes.length };
}
const descriptor = ({ id, mimeType, size }) => ({ id, mimeType, size });

/** Immutable, content-addressed copies. URLs never contain local paths or base64. */
export async function createImageStore(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('圖片資料夾必須是本機目錄。');
  await fs.chmod(directory, 0o700);
  const pending = new Map(), saved = new Set();
  async function read(id) {
    if (!ID.test(id || '')) throw fail(400, '圖片 ID 無效。');
    if (pending.has(id)) await pending.get(id);
    let handle;
    try {
      handle = await fs.open(join(directory, id), constants.O_RDONLY | constants.O_NOFOLLOW);
      const st = await handle.stat();
      if (!st.isFile() || st.size > MAX_IMAGE_BYTES) throw fail(400, '圖片檔案無法使用。');
      const bytes = await handle.readFile();
      if (digest(bytes) !== id) throw fail(400, '圖片檔案已變更。');
      return { bytes, id, mimeType: mimeOf(bytes), size: bytes.length };
    } catch (error) { if (error.code === 'ENOENT') throw fail(404, '找不到圖片，請重新加入。'); throw error; }
    finally { await handle?.close(); }
  }
  function remember(image) {
    const value = decode(image), { id, bytes } = value;
    if (!saved.has(id) && !pending.has(id)) {
      const operation = (async () => {
        const temporary = join(directory, `${id}.${randomUUID()}.tmp`);
        try {
          await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
          try { await fs.link(temporary, join(directory, id)); } catch (error) { if (error.code !== 'EEXIST') throw error; }
          saved.add(id);
        } finally { await fs.rm(temporary, { force: true }); }
      })();
      pending.set(id, operation);
      void operation.finally(() => pending.delete(id)).catch(() => {});
    }
    return descriptor(value);
  }
  async function upload(images) {
    if (!Array.isArray(images) || !images.length || images.length > MAX_IMAGES) throw fail(400, '一次最多加入 4 張圖片。');
    const values = images.map(decode);
    if (values.reduce((n, image) => n + image.size, 0) > MAX_BATCH_BYTES) throw fail(413, '圖片合計最多 8 MiB。');
    const result = images.map(remember);
    await Promise.all(result.map(image => read(image.id)));
    return result;
  }
  async function resolve(ids = []) {
    if (!Array.isArray(ids) || ids.length > MAX_IMAGES || ids.some(id => typeof id !== 'string' || !ID.test(id))) throw fail(400, '每則訊息最多 4 張圖片。');
    const values = await Promise.all(ids.map(read));
    if (values.reduce((n, image) => n + image.size, 0) > MAX_BATCH_BYTES) throw fail(413, '圖片合計最多 8 MiB。');
    return values.map(value => ({ type: 'image', data: value.bytes.toString('base64'), mimeType: value.mimeType }));
  }
  function project(content) {
    return (Array.isArray(content) ? content : []).filter(block => block.type === 'image').slice(0, MAX_IMAGES).map(block => {
      try { return remember(block); } catch { return { unavailable: true }; }
    });
  }
  return { upload, resolve, read, project };
}
