import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const HEADER_BYTES = 1024 * 1024;
const MAX_ENTRIES = 100000;
const hash = value => createHash('sha256').update(value).digest('hex');
const inside = (root, file) => { const path = relative(root, file); return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path); };
const stamp = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ?
  content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join(' ') : '';
const date = (value, fallback) => Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : fallback;
const sessionCwd = header => typeof header.cwd === 'string' && header.cwd.length <= 4096 &&
  isAbsolute(header.cwd) && !header.cwd.includes('\0') ? header.cwd : null;

async function noSymlinks(path, root = parse(path).root) {
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('對話路徑包含 symlink，拒絕存取。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

/** Discover only the configured session roots. Never invoke a model or read its credentials. */
export async function createSessionLibrary({ roots, piPackageDir, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!Array.isArray(roots) || roots.some(root => typeof root !== 'string' || !isAbsolute(root))) throw new Error('需提供絕對路徑的 session roots。');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('session 大小上限必須是正整數。');
  const configuredRoots = [...new Set(roots.map(root => resolve(root)))];
  const packageDir = piPackageDir || process.env.PI_PKG || join((await run('npm', ['root', '-g'], { timeout: 10000 })).stdout.trim(), '@earendil-works/pi-coding-agent');
  const { SessionManager, parseSessionEntries, CURRENT_SESSION_VERSION } = await import(pathToFileURL(join(resolve(packageDir), 'dist/core/session-manager.js')).href);
  if (typeof SessionManager?.inMemory !== 'function' || typeof parseSessionEntries !== 'function') throw new Error('Pi SDK 缺少唯讀 session 解析功能。');
  let canonicalRoots = [], allowedFiles = new Set();
  const metadataCache = new Map();
  let scanQueue = Promise.resolve();

  function validateHeader(entries) {
    const header = entries[0];
    if (!header || typeof header !== 'object' || header.type !== 'session') return null;
    if (typeof header.id !== 'string' || !header.id || header.id.length > 512) throw new Error('對話 header 缺少合法的 id。');
    const version = header.version ?? 1;
    if (!Number.isInteger(version) || version < 1 || version > CURRENT_SESSION_VERSION) throw new Error('不支援的 Pi session 版本。');
    return header;
  }

  function validateEntries(entries) {
    const header = validateHeader(entries);
    if (!header) throw new Error('檔案不是 Pi session。');
    if (entries.length > MAX_ENTRIES) throw new Error(`對話超過 ${MAX_ENTRIES} 筆 entries 上限。`);
    const ids = new Map();
    for (const entry of entries.slice(1)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.type !== 'string' || entry.type === 'session') throw new Error('對話含有不合法或重複的 header/entry。');
      if (entry.type === 'message' && (!entry.message || typeof entry.message !== 'object' || Array.isArray(entry.message) || typeof entry.message.role !== 'string')) throw new Error('對話 message 格式錯誤。');
      // The SDK migrates v1 linear history into a tree, on an in-memory copy only.
      if ((header.version ?? 1) < 2) continue;
      if (typeof entry.id !== 'string' || !entry.id || entry.parentId !== null && (typeof entry.parentId !== 'string' || !entry.parentId)) throw new Error('對話 entry 缺少合法的 id/parentId。');
      if (ids.has(entry.id)) throw new Error('對話含有重複的 entry id。');
      ids.set(entry.id, entry);
    }
    const colors = new Map();
    for (const entry of ids.values()) {
      if (colors.get(entry.id) === 2) continue;
      const chain = []; let current = entry;
      while (current) {
        if (colors.get(current.id) === 1) throw new Error('對話 parent chain 含有 cycle。');
        if (colors.get(current.id) === 2) break;
        colors.set(current.id, 1); chain.push(current.id);
        if (current.parentId && !ids.has(current.parentId)) throw new Error('對話 parent chain 缺少來源 entry。');
        current = current.parentId ? ids.get(current.parentId) : null;
      }
      for (const id of chain) colors.set(id, 2);
    }
    return header;
  }

  async function openChecked(file, requireListed = true) {
    if (typeof file !== 'string' || !isAbsolute(file) || !file.endsWith('.jsonl')) throw new Error('只接受已列出的 session 檔案。');
    const lexical = resolve(file), root = canonicalRoots.find(root => inside(root, lexical));
    if (!root || requireListed && !allowedFiles.has(lexical)) throw new Error('對話不在 scan 白名單內。');
    await noSymlinks(lexical, root);
    const canonical = await fs.realpath(lexical);
    if (canonical !== lexical || !canonicalRoots.some(root => inside(root, canonical))) throw new Error('對話路徑超出允許範圍。');
    const handle = await fs.open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat(), current = await fs.lstat(canonical);
      if (!stat.isFile() || !current.isFile() || current.isSymbolicLink() || stat.dev !== current.dev || stat.ino !== current.ino || await fs.realpath(canonical) !== canonical) throw new Error('對話檔案不是普通檔案或路徑已改變。');
      return { handle, stat, file: canonical };
    } catch (error) { await handle.close(); throw error; }
  }

  async function contentOf(opened, limit = maxBytes) {
    if (opened.stat.size > limit) throw new Error(`對話超過 ${limit} bytes 讀取上限。`);
    const text = await opened.handle.readFile({ encoding: 'utf8' });
    const after = await opened.handle.stat();
    if (Buffer.byteLength(text) > limit) throw new Error(`對話超過 ${limit} bytes 讀取上限。`);
    if (stamp(after) !== stamp(opened.stat)) throw new Error('對話在讀取期間更新，請重新整理後再試。');
    return text;
  }

  function metadata(file, stat, entries, { readable = true, partial = false } = {}) {
    const header = validateHeader(entries);
    if (!header) return null; // SoL-Pi ledgers and other JSONL sidecars are not sessions.
    let name, firstMessage = '', count = 0, latest = 0;
    for (const entry of entries.slice(1)) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.type === 'session_info') name = typeof entry.name === 'string' ? entry.name.trim().slice(0, 250) : undefined;
      if (entry.type !== 'message') continue;
      count++;
      const message = entry.message;
      if (!message || !['user', 'assistant'].includes(message.role)) continue;
      if (!firstMessage && message.role === 'user') firstMessage = textOf(message.content).trim().slice(0, 160);
      const activity = typeof message.timestamp === 'number' ? message.timestamp : Date.parse(entry.timestamp);
      if (Number.isFinite(activity)) latest = Math.max(latest, activity);
    }
    const createdAt = date(header.timestamp, stat.birthtime.toISOString());
    return { id: `local-${hash(file).slice(0, 32)}`, file, cwd: sessionCwd(header), title: name || firstMessage || '未命名對話',
      createdAt, updatedAt: partial ? stat.mtime.toISOString() : latest ? new Date(latest).toISOString() : createdAt,
      messageCount: partial ? null : count, readable, revision: stamp(stat), ...(partial ? { metadataPartial: true } : {}) };
  }

  async function inspect(file) {
    const opened = await openChecked(file, false);
    try {
      const key = stamp(opened.stat), cached = metadataCache.get(opened.file);
      if (cached?.stamp === key) return cached.result;
      let entries, issue;
      const oversized = opened.stat.size > maxBytes;
      if (oversized) {
        const bytes = Buffer.alloc(Math.min(HEADER_BYTES, opened.stat.size));
        const { bytesRead } = await opened.handle.read(bytes, 0, bytes.length, 0);
        // The last prefix line can be partial; parseSessionEntries skips malformed JSON.
        entries = parseSessionEntries(bytes.subarray(0, bytesRead).toString('utf8'));
        if (validateHeader(entries)) issue = `對話超過 ${maxBytes} bytes，僅列出部分 metadata，未載入全文。`;
      } else {
        entries = parseSessionEntries(await contentOf(opened));
        if (validateHeader(entries)) {
          try { validateEntries(entries); } catch (error) { issue = error.message; }
        }
      }
      const session = metadata(opened.file, opened.stat, entries, { readable: !issue, partial: oversized });
      const result = { session, issue: session && issue ? { file: opened.file, reason: issue } : null };
      metadataCache.set(opened.file, { stamp: key, result });
      return result;
    } finally { await opened.handle.close(); }
  }

  async function performScan() {
    const issues = [], sessions = [], seen = new Set(), directories = new Map();
    canonicalRoots = [];
    for (const root of configuredRoots) {
      try {
        const real = await fs.realpath(root);
        if (!(await fs.stat(real)).isDirectory()) throw new Error('session root 不是目錄。');
        if (!canonicalRoots.includes(real)) canonicalRoots.push(real);
      } catch (error) { if (error.code !== 'ENOENT') issues.push({ file: root, reason: error.message }); }
    }
    async function visit(dir, depth) {
      if (directories.has(dir) && directories.get(dir) <= depth) return;
      directories.set(dir, depth);
      let children;
      try { children = await fs.readdir(dir, { withFileTypes: true }); }
      catch (error) { issues.push({ file: dir, reason: error.message }); return; }
      for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
        const file = join(dir, child.name);
        if (child.isSymbolicLink()) { issues.push({ file, reason: '略過 symlink，不讀取連結目標。' }); continue; }
        if (child.isDirectory()) {
          if (['sol-pi', '.sol-pi', 'node_modules'].includes(child.name)) continue;
          if (depth < 3) await visit(file, depth + 1);
          continue;
        }
        if (!child.isFile() || !child.name.endsWith('.jsonl') || seen.has(file)) continue;
        seen.add(file);
        try {
          const { session, issue } = await inspect(file);
          if (session) sessions.push(session);
          if (issue) issues.push(issue);
        } catch (error) { issues.push({ file, reason: error.message }); }
      }
    }
    for (const root of canonicalRoots) await visit(root, 0);
    allowedFiles = new Set(sessions.map(session => session.file));
    for (const file of metadataCache.keys()) if (!seen.has(file)) metadataCache.delete(file);
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    return { sessions: sessions.map(session => ({ ...session })), issues: issues.map(issue => ({ ...issue })) };
  }

  function scan() {
    const operation = scanQueue.catch(() => {}).then(performScan);
    scanQueue = operation;
    return operation;
  }

  async function read(file) {
    const opened = await openChecked(file);
    try {
      const entries = parseSessionEntries(await contentOf(opened)), header = validateEntries(entries);
      const cwd = sessionCwd(header);
      // This placeholder exists only inside the non-persistent SDK instance. It is
      // never returned, serialized, created on disk, or used to launch a process.
      const manager = SessionManager.inMemory(cwd ?? '/__pi_unknown_session_workspace__', undefined, structuredClone(entries));
      return { header, branch: manager.getBranch(), entries, cwd, revision: stamp(opened.stat) };
    } finally { await opened.handle.close(); }
  }

  async function capture(file, destinationDir, expectedRevision) {
    const { entries, revision } = await read(file);
    if (expectedRevision !== undefined && revision !== expectedRevision) throw new Error('本機對話已更新，請重新整理確認內容後再接續。');
    const text = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
    if (typeof destinationDir !== 'string' || !isAbsolute(destinationDir)) throw new Error('快照目錄需為絕對路徑。');
    const destination = resolve(destinationDir);
    await noSymlinks(destination);
    await fs.mkdir(destination, { recursive: true, mode: 0o700 });
    await noSymlinks(destination);
    const snapshotFile = join(destination, `${hash(text)}.jsonl`);
    const temporary = join(destination, `.capture-${randomUUID()}.tmp`);
    let handle, created = false;
    try {
      handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      await handle.writeFile(text, 'utf8');
      await handle.sync();
      await handle.close(); handle = undefined;
      await noSymlinks(destination);
      // Publish a fully written file without overwriting a concurrent identical capture.
      await fs.link(temporary, snapshotFile);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await noSymlinks(snapshotFile);
      const existing = await fs.lstat(snapshotFile);
      if (!existing.isFile() || (existing.mode & 0o777) !== 0o600 || existing.size !== Buffer.byteLength(text) || await fs.readFile(snapshotFile, 'utf8') !== text) throw new Error('既有快照內容或權限不符，拒絕覆寫。');
    } finally { await handle?.close(); if (created) await fs.unlink(temporary); }
    return snapshotFile;
  }

  return { scan, read, capture };
}
