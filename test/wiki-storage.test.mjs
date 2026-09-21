import './isolate.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { makeLoader, test, assert, assertIncludes, report } from './harness.mjs';
const tmp = mkdtempSync(join(tmpdir(), 'zen-wiki-storage-'));
const notesA = join(tmp, 'a'), notesB = join(tmp, 'b'), directory = join(tmp, 'memory');
for (const d of [notesA, notesB, directory]) mkdirSync(d);
const j = await makeLoader(), m = await j.import(resolve('extensions/study/memory.ts'));
const n = await j.import(resolve('extensions/study/notes.ts'));
const storage = await j.import(resolve('extensions/study/storage.ts'));
try {
  await test('共享 Wiki 的引用固定原本來源 vault，不因同名筆記判斷錯版本', () => {
    writeFileSync(join(notesA, 'same.md'), 'Original source.');
    writeFileSync(join(notesB, 'same.md'), 'Different source.');
    const cite = { path: 'same.md', sha256: n.fingerprint('Original source.'), startLine: 1, endLine: 1, quote: 'Original source.' };
    const a = { directory, sourceVault: notesA }, b = { directory, sourceVault: notesB };
    const saved = m.saveRecord(a, { kind: 'concept', topic: 'source', title: 'Source', body: 'Test', sources: [{ ...cite, vault: notesB }] });
    assert(saved.sources[0].vault === notesA, 'never trust a model-provided vault');
    assert(m.sourceStatus(b, saved.sources[0]) === 'current');
    writeFileSync(join(notesA, 'same.md'), 'Changed.');
    assert(m.sourceStatus(b, saved.sources[0]) === 'changed');
  });
  await test('網路來源只存掛載的 Wiki，虛擬路徑可讀，禁止跳脫', () => {
    const store = { directory, sourceVault: notesA };
    const { record } = m.saveSourceSnapshot(store, { kind: 'web', topic: 'web', title: 'Web', body: 'Fetched body.', url: 'https://example.test' });
    assertIncludes(storage.readStoredNote(store, `07-Agent-Wiki/sources/${record.id}.md`).text, 'Fetched body.');
    assert(!existsSync(join(notesA, '07-Agent-Wiki')));
    let error; try { storage.readStoredNote(store, '07-Agent-Wiki/../a/same.md'); } catch (e) { error = e; } assert(error);
  });
  await test('直接執行測試也不讀取繼承的個人掛載設定', () => {
    const sentinel = join(tmp, 'sentinel'); mkdirSync(sentinel);
    const config = join(tmp, 'personal.json'); writeFileSync(config, JSON.stringify({ defaultWiki: 'personal', wikis: { personal: sentinel } }));
    const child = spawnSync(process.execPath, [resolve('test/study-memory.test.mjs')], { env: { ...process.env, PI_RONNY_CONFIG: config, PI_LLM_WIKI: sentinel, PI_STUDY_VAULT: sentinel }, encoding: 'utf8' });
    assert(child.status === 0, child.stdout + child.stderr);
    assert(readdirSync(sentinel).length === 0, 'test must never create files in the inherited personal mount');
  });
} finally { rmSync(tmp, { recursive: true, force: true }); }
report();
