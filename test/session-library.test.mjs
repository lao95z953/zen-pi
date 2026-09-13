import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createSessionLibrary } from '../web/session-library.mjs';
import { test, assert, assertIncludes, report, piPackageDir } from './harness.mjs';

const temp = await fs.mkdtemp(join(tmpdir(), 'pi-session-library-'));
const pkg = piPackageDir();
const header = (cwd, id = '019943ed-6500-7000-8000-000000000001', version = 3) => ({ type: 'session', version, id, cwd, timestamp: '2026-01-01T00:00:00.000Z' });
const message = (id, parentId, role, text, timestamp = 1767312000000) => ({ type: 'message', id, parentId, timestamp: new Date(timestamp).toISOString(), message: { role, content: [{ type: 'text', text }], timestamp } });
const serialized = (entries, lf = true) => entries.map(entry => JSON.stringify(entry)).join('\n') + (lf ? '\n' : '');
let serial = 0;
async function fixture() {
  const root = join(temp, `root-${++serial}`); await fs.mkdir(root);
  const library = await createSessionLibrary({ roots: [root], piPackageDir: pkg });
  return { root, library };
}
async function write(file, entries, lf = true) { await fs.mkdir(join(file, '..'), { recursive: true }); await fs.writeFile(file, serialized(entries, lf)); }
async function rejects(fn, needle) { let error; try { await fn(); } catch (err) { error = err; } assert(error, 'expected rejection'); if (needle) assertIncludes(error.message, needle); }
try {
  await test('掃描 CLI/Web roots，使用 header.cwd 分組且 ID 由檔案路徑決定', async () => {
    const { root } = await fixture(), cli = join(root, 'cli'), web = join(root, 'web');
    const a = join(cli, '--ambiguous-encoded-name--', 'a.jsonl'), b = join(web, 'b.jsonl');
    await write(a, [header('/workspace/project-one'), message('a1', null, 'user', '研究 A')]);
    await write(b, [header('/workspace/project/two'), message('b1', null, 'user', '研究 B')]);
    const library = await createSessionLibrary({ roots: [cli, web], piPackageDir: pkg });
    const { sessions, issues } = await library.scan();
    assert(sessions.length === 2 && issues.length === 0);
    assert(sessions.some(s => s.cwd === '/workspace/project-one') && sessions.some(s => s.cwd === '/workspace/project/two'));
    assert(sessions[0].id !== sessions[1].id, '同 native ID 的不同檔案不能覆蓋');
    assert(sessions.every(s => s.id === `local-${createHash('sha256').update(s.file).digest('hex').slice(0, 32)}` && s.readable && s.messageCount === 1));
    assert(!JSON.stringify(sessions).includes('allMessagesText'));
    const again = await library.scan(); assert(JSON.stringify(again.sessions) === JSON.stringify(sessions));
  });
  await test('read 保留目前 branch，不能把另一分支回答混進來', async () => {
    const { root, library } = await fixture(), file = join(root, 'branched.jsonl');
    await write(file, [header('/workspace/branch'), message('root', null, 'user', '最初問題'), message('old', 'root', 'assistant', '放棄的回答'),
      message('new', 'root', 'user', '改問這個'), message('answer', 'new', 'assistant', '目前回答'),
      { type: 'custom', id: 'mode', parentId: 'answer', timestamp: '2026-01-02T00:00:00.000Z', customType: 'pi-mode', data: { mode: 'study' } }]);
    await library.scan(); const result = await library.read(file);
    assert(result.cwd === '/workspace/branch' && result.header.type === 'session');
    assert(result.branch.map(e => e.id).join(',') === 'root,new,answer,mode');
    assert(result.entries.some(e => e.id === 'old') && result.entries[0].type === 'session');
  });
  await test('缺失、空白或不合法 cwd 的合法對話列為未分類，不冒充 home', async () => {
    const { root, library } = await fixture();
    const values = [undefined, '', 'relative/project', null, 42];
    for (const [index, cwd] of values.entries()) {
      const file = join(root, `unknown-${index}.jsonl`);
      await write(file, [header(cwd), message('u1', null, 'user', `未知工作目錄 ${index}`)]);
    }
    const { sessions, issues } = await library.scan();
    assert(sessions.length === values.length && issues.length === 0);
    assert(sessions.every(session => session.cwd === null && session.readable));
    for (const session of sessions) {
      const original = await fs.readFile(session.file), data = await library.read(session.file);
      assert(data.cwd === null && data.branch.length === 1);
      assert(!('cwd' in data.header) || data.header.cwd === JSON.parse(original.toString().split('\n')[0]).cwd);
      assert(!JSON.stringify(data).includes('__pi_unknown_session_workspace__'));
      const snapshot = await library.capture(session.file, join(temp, 'unknown-cwd-captures'));
      assert((await fs.readFile(snapshot)).equals(original), '快照不能替來源補寫 cwd');
    }
  });
  await test('允許未知 cwd 仍不接受不合法的 header type、id 或版本', async () => {
    const { root, library } = await fixture();
    const invalid = [{ ...header(undefined), type: 'ledger' }, { ...header(undefined), id: '' }, { ...header(undefined), id: 42 }, { ...header(undefined), version: -1 }];
    for (const [index, value] of invalid.entries()) await write(join(root, `invalid-header-${index}.jsonl`), [value]);
    const result = await library.scan(); assert(result.sessions.length === 0 && result.issues.length === 3);
    for (let index = 0; index < invalid.length; index++) await rejects(() => library.read(join(root, `invalid-header-${index}.jsonl`)), '白名單');
  });
  await test('讀取與 capture 不改缺尾端 LF 的 CLI 原檔，快照為穩定 0600', async () => {
    const { root, library } = await fixture(), file = join(root, 'no-lf.jsonl'), destination = join(temp, 'captures');
    await write(file, [header('/workspace/no-lf', 'custom.session-id'), message('user', null, 'user', '原始文字')], false);
    const original = await fs.readFile(file), before = await fs.stat(file);
    await library.scan(); await library.read(file);
    const [snapshot, same] = await Promise.all([library.capture(file, destination), library.capture(file, destination)]);
    const captured = await fs.readFile(snapshot), after = await fs.stat(file);
    assert(snapshot === same && captured.at(-1) === 10 && (await fs.stat(snapshot)).mode % 0o1000 === 0o600);
    assert(basename(snapshot) === `${createHash('sha256').update(captured).digest('hex')}.jsonl`);
    assert((await fs.readFile(file)).equals(original) && before.mtimeMs === after.mtimeMs && before.size === after.size);
    assert((await fs.readdir(destination)).every(name => name.endsWith('.jsonl')));
  });
  await test('metadata 快取可隨同一路徑內容更新，檔名 ID 不變', async () => {
    const { root, library } = await fixture(), file = join(root, 'updated.jsonl');
    await write(file, [header('/workspace/original'), message('u1', null, 'user', '原始標題')]);
    const initial = (await library.scan()).sessions[0];
    await write(file, [header('/workspace/updated'), message('u1', null, 'user', '後來的問題'),
      { type: 'session_info', id: 'name', parentId: 'u1', timestamp: '2026-01-03T00:00:00Z', name: '指定的標題' }]);
    const updated = (await library.scan()).sessions[0];
    assert(updated.id === initial.id && updated.title === '指定的標題' && updated.cwd === '/workspace/updated');
    await fs.unlink(file); assert((await library.scan()).sessions.length === 0);
    await rejects(() => library.read(file), '白名單');
  });
  await test('未 scan 的檔案、path traversal 與白名單外原檔不能讀取', async () => {
    const { root, library } = await fixture(), file = join(root, 'listed.jsonl'), outside = join(temp, 'outside.jsonl');
    await write(file, [header('/workspace/safe')]); await write(outside, [header('/workspace/private')]);
    await rejects(() => library.read(file), '白名單');
    await library.scan();
    await rejects(() => library.read(outside), '白名單');
    await rejects(() => library.read(join(root, '..', 'outside.jsonl')), '白名單');
    await rejects(() => library.read('listed.jsonl'), '已列出');
  });
  await test('symlink 檔案與目錄不被索引，scan 後偷換 symlink 也不能讀', async () => {
    const { root, library } = await fixture(), file = join(root, 'normal.jsonl'), outsideDir = join(temp, 'private-session-dir');
    await fs.mkdir(outsideDir); const outside = join(outsideDir, 'private.jsonl');
    await write(file, [header('/workspace/safe')]); await write(outside, [header('/workspace/private')]);
    await fs.symlink(outside, join(root, 'linked.jsonl')); await fs.symlink(outsideDir, join(root, 'linked-dir'));
    const scanned = await library.scan(); assert(scanned.sessions.length === 1 && scanned.issues.length === 2);
    await fs.unlink(file); await fs.symlink(outside, file);
    await rejects(() => library.read(file), 'symlink');
    await rejects(() => library.capture(file, join(temp, 'denied-capture')), 'symlink');
  });
  await test('普通 SoL-Pi ledger 略過，不當成壞 session 或讀取其附屬目錄', async () => {
    const { root, library } = await fixture();
    await fs.writeFile(join(root, 'observations.jsonl'), JSON.stringify({ version: 1, observationId: 'obs-1', content: 'ledger data' }) + '\n');
    await write(join(root, 'sol-pi', 'ledger.jsonl'), [header('/should-not-be-listed')]);
    await write(join(root, 'normal.jsonl'), [header('/workspace/normal')]);
    const result = await library.scan(); assert(result.sessions.length === 1 && result.issues.length === 0);
    await rejects(() => library.read(join(root, 'observations.jsonl')), '白名單');
  });
  await test('超過三層不遞迴，重疊 roots 不造成重複或漏掉其自身三層範圍', async () => {
    const { root } = await fixture(), nested = join(root, 'one', 'two', 'three');
    await write(join(nested, 'level-three.jsonl'), [header('/workspace/three')]);
    await write(join(nested, 'four', 'level-four.jsonl'), [header('/workspace/four')]);
    const shallow = await createSessionLibrary({ roots: [root], piPackageDir: pkg });
    assert((await shallow.scan()).sessions.length === 1);
    const overlapping = await createSessionLibrary({ roots: [root, nested], piPackageDir: pkg });
    assert((await overlapping.scan()).sessions.length === 2);
  });
  await test('大檔仍能列 metadata，但明示不完整、拒絕 read/capture', async () => {
    const { root } = await fixture(), file = join(root, 'large.jsonl');
    await write(file, [header('/workspace/large'), message('user', null, 'user', 'x'.repeat(4096))]);
    const library = await createSessionLibrary({ roots: [root], piPackageDir: pkg, maxBytes: 512 });
    const { sessions, issues } = await library.scan();
    assert(sessions.length === 1 && !sessions[0].readable && sessions[0].metadataPartial && sessions[0].messageCount === null && issues.length === 1);
    await rejects(() => library.read(file), '512 bytes');
    await rejects(() => library.capture(file, join(temp, 'large-capture')), '512 bytes');
  });
  await test('duplicate IDs、cycle、缺少 parent 及非 object entries 都拒絕', async () => {
    for (const rows of [
      [message('a', null, 'user', 'one'), message('a', null, 'assistant', 'duplicate')],
      [message('a', 'b', 'user', 'cycle'), message('b', 'a', 'assistant', 'cycle')],
      [message('a', 'absent', 'user', 'missing parent')],
      [null],
    ]) {
      const { root, library } = await fixture(), file = join(root, 'invalid.jsonl');
      await write(file, [header('/workspace/invalid'), ...rows]);
      const result = await library.scan();
      assert(result.sessions.length === 1 && !result.sessions[0].readable && result.issues.length === 1);
      await rejects(() => library.read(file)); await rejects(() => library.capture(file, join(temp, 'invalid-capture')));
    }
  });
  await test('深 parent chain 使用迭代驗證，超過 entries 上限明示拒絕', async () => {
    const { root, library } = await fixture(), file = join(root, 'deep.jsonl');
    const entries = [header('/workspace/deep')];
    for (let index = 0; index < 12000; index++) entries.push({ type: 'custom', id: `n${index}`, parentId: index ? `n${index - 1}` : null, timestamp: '2026-01-01', customType: 'fixture' });
    await write(file, entries); await library.scan(); assert((await library.read(file)).branch.length === 12000);
    while (entries.length <= 100000) { const index = entries.length - 1; entries.push({ type: 'custom', id: `n${index}`, parentId: `n${index - 1}`, timestamp: '2026-01-01', customType: 'fixture' }); }
    await write(file, entries); const result = await library.scan();
    assert(!result.sessions[0].readable); assertIncludes(result.issues[0].reason, '100000');
    await rejects(() => library.read(file), '100000');
  });
  await test('舊 v1 session 只在記憶體迁移，重複 capture 仍得到同一快照', async () => {
    const { root, library } = await fixture(), file = join(root, 'legacy.jsonl');
    await write(file, [header('/workspace/legacy', 'legacy-id', 1), { type: 'message', timestamp: '2026-01-02', message: { role: 'user', content: '舊格式文字' } }], false);
    const original = await fs.readFile(file); await library.scan(); const data = await library.read(file);
    assert(data.header.version === 1 && data.entries[1].id === undefined && typeof data.branch[0].id === 'string');
    const first = await library.capture(file, join(temp, 'legacy-capture')), second = await library.capture(file, join(temp, 'legacy-capture'));
    assert(first === second && (await fs.readFile(file)).equals(original));
  });
  await test('capture 不跟隨目的地 symlink，不覆寫遭竄改的既有快照', async () => {
    const { root, library } = await fixture(), file = join(root, 'capture.jsonl'), destination = join(temp, 'verified-capture');
    await write(file, [header('/workspace/capture')]); await library.scan();
    const snapshot = await library.capture(file, destination);
    await fs.writeFile(snapshot, 'tampered');
    await rejects(() => library.capture(file, destination), '拒絕覆寫');
    assert(await fs.readFile(snapshot, 'utf8') === 'tampered');
    const link = join(temp, 'linked-capture'); await fs.symlink(destination, link);
    await rejects(() => library.capture(file, link), 'symlink');
  });
} finally { await fs.rm(temp, { recursive: true, force: true }); }
report();
