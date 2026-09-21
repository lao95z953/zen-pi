import './isolate.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeLoader, makeApi, makeCtx, fire, test, assert, assertIncludes, report } from './harness.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'zen-wiki-mount-'));
const notes = join(tmp, 'notes'), workspace = join(tmp, 'workspace'), global = join(tmp, 'global');
mkdirSync(notes); mkdirSync(workspace);
writeFileSync(join(notes, 'NAT.md'), '# NAT\nOriginal source.\n');
const config = join(tmp, 'ronny.json');
writeFileSync(config, JSON.stringify({ wikis: { notes }, defaultWiki: 'notes' }));
process.env.PI_RONNY_CONFIG = config;
process.env.PI_STUDY_VAULT = notes;
process.env.PI_LLM_WIKI = global;
const j = await makeLoader(), w = await j.import(resolve('extensions/study/wikis.ts'));
const m = await j.import(resolve('extensions/study/memory.ts'));
const { default: factory } = await j.import(resolve('extensions/study/index.ts'));
const boot = (branch = [], cwd = workspace) => {
  const api = makeApi(); factory(api);
  const ctx = makeCtx({ cwd, sessionManager: { getBranch: () => branch, getEntries: () => branch, getSessionId: () => 'mount-fixture', getLeafId: () => null } });
  return { api, ctx };
};
const command = async (app, args) => { await app.api._commands.get('wiki').handler(args, app.ctx); return app.ctx._notices.at(-1); };
const stored = app => app.api._entries.map(e => ({ type: 'custom', ...e }));
const observe = async app => {
  await app.api._commands.get('mode').handler('study', app.ctx);
  app.ctx.sessionManager.getBranch = () => [{ type: 'message', id: 'u1', message: { role: 'user', content: '已確認回連需要有可到達的接收端。' } }];
  return app.api._tools.get('study_observe').execute('t', { topic: 'mount-check', title: 'Mount check', question: '可達嗎？', evidence: '已確認回連需要有可到達的接收端。', messageId: 'u1', status: 'partial', reasoning: 'Temporary fixture.', nextQuestion: '路由？' }, undefined, undefined, app.ctx);
};
async function rejects(fn, text) { let error; try { await fn(); } catch (e) { error = e; } assert(error, 'expected rejection'); if (text) assertIncludes(error.message, text); }
try {
  await test('預設 Wiki 不跟隨來源 vault 或舊 defaultWiki', async () => {
    const app = boot(); await fire(app.api, 'session_start', {}, app.ctx);
    const notice = await command(app, 'list'); assertIncludes(notice.text, global);
    await observe(app);
    assert(m.records({ directory: global, sourceVault: notes }).length === 1);
    assert(!existsSync(join(notes, '07-Agent-Wiki')), 'source vault must not receive generated files');
  });
  await test('相對路徑依 Workspace 掛載，來源筆記與 focus 不變', async () => {
    const app = boot(); await app.api._commands.get('study').handler('NAT.md', app.ctx);
    const before = await fire(app.api, 'before_agent_start', { prompt: 'NAT', systemPrompt: '' }, app.ctx);
    await command(app, 'use ./llm-wiki');
    const after = await fire(app.api, 'before_agent_start', { prompt: 'NAT', systemPrompt: '' }, app.ctx);
    assert(JSON.parse(before.message.content).current.path === JSON.parse(after.message.content).current.path);
    await observe(app);
    assert(m.records({ directory: join(workspace, 'llm-wiki'), sourceVault: notes }).length === 1);
    assert(readFileSync(join(notes, 'NAT.md'), 'utf8') === '# NAT\nOriginal source.\n');
  });
  await test('重開、Fork 與改 cwd 仍使用已保存絕對路徑', async () => {
    const app = boot(); await command(app, 'use ./saved');
    const resumed = boot(stored(app), tmp); await fire(resumed.api, 'session_start', {}, resumed.ctx);
    assertIncludes((await command(resumed, 'list')).text, `目前掛載：${join(workspace, 'saved')}`);
  });
  await test('新對話只指定筆記就重開，仍保存獨立的預設 Wiki', async () => {
    const app = boot(); await app.api._commands.get('study').handler('NAT.md', app.ctx);
    const resumed = boot(stored(app)); await fire(resumed.api, 'session_start', {}, resumed.ctx);
    assertIncludes((await command(resumed, 'list')).text, `目前掛載：${global}`);
    assert(!existsSync(join(notes, '07-Agent-Wiki')));
  });
  await test('掛載切換後須重新讀取来源，舊證據不能直接存入新 Wiki', async () => {
    const app = boot(); await app.api._tools.get('study_read').execute('t', { path: 'NAT.md' }, undefined, undefined, app.ctx);
    const n = await j.import(resolve('extensions/study/notes.ts'));
    const citation = { path: 'NAT.md', sha256: n.fingerprint('# NAT\nOriginal source.\n'), startLine: 2, endLine: 2, quote: 'Original source.' };
    await command(app, 'use ./fresh-evidence');
    const args = { topic: 'nat', title: 'NAT', body: 'Test', sources: [citation] };
    await rejects(() => app.api._tools.get('study_wiki').execute('t', args, undefined, undefined, app.ctx), '尚未讀取');
    await app.api._tools.get('study_read').execute('t', { path: 'NAT.md' }, undefined, undefined, app.ctx);
    await app.api._tools.get('study_wiki').execute('t', args, undefined, undefined, app.ctx);
  });
  await test('/wiki default 返回 ~/.pi 下的預設位置（測試用環境覆寫）', async () => {
    const app = boot(); await command(app, 'use ./other'); await command(app, 'default');
    assert(stored(app).at(-1).data.path === global);
  });
  await test('設定熱更新，新別名可即時使用；改路徑不偷偷轉向', async () => {
    w.listWikis();
    const first = join(tmp, 'named-a'), second = join(tmp, 'named-b');
    writeFileSync(config, JSON.stringify({ llmWikis: { custom: first }, wikis: { notes }, defaultWiki: 'notes' }));
    const app = boot(); assert((await command(app, 'use custom')).level === 'info');
    writeFileSync(config, JSON.stringify({ llmWikis: { custom: second }, wikis: { notes }, defaultWiki: 'notes' }));
    await rejects(() => observe(app), '設定已移除或改變');
    assert(!existsSync(second));
    assert((await command(app, 'use custom')).level === 'info');
    assert(existsSync(second));
  });
  await test('保存的掛載被刪除時停止，不能重建或退回預設位置', async () => {
    const app = boot(); await command(app, 'use ./removed');
    const branch = stored(app); renameSync(join(workspace, 'removed'), join(workspace, 'moved'));
    const resumed = boot(branch); await fire(resumed.api, 'session_start', {}, resumed.ctx);
    await rejects(() => observe(resumed), '掛載無法使用');
    assert(!existsSync(join(workspace, 'removed')));
    await command(resumed, 'default'); assertIncludes((await command(resumed, 'list')).text, global);
  });
  await test('舊 Session 的別名被移除時，不可退回其他 vault', async () => {
    const branch = [{ type: 'custom', customType: 'pentest-study-focus-v1', data: { wiki: 'removed-alias', vault: notes, focus: { mode: 'auto' } } }];
    const app = boot(branch); await fire(app.api, 'session_start', {}, app.ctx);
    await rejects(() => observe(app), '設定已移除或改變');
  });
  await test('舊 Study Session 保留來源、指定筆記與既有 Wiki', async () => {
    mkdirSync(join(notes, '07-Agent-Wiki'), { recursive: true });
    const app = boot([{ type: 'custom', customType: 'pentest-study-focus-v1', data: { wiki: 'notes', vault: notes, focus: { mode: 'manual', path: 'NAT.md' } } }]);
    await fire(app.api, 'session_start', {}, app.ctx);
    assertIncludes((await command(app, 'list')).text, `目前掛載：${join(notes, '07-Agent-Wiki')}`);
    assert(stored(app).some(e => e.customType === 'zen-pi-wiki-mount-v1'));
  });
  await test('只有舊研究模式 entry 的 Session 也保留原 Wiki 與來源', async () => {
    const legacy = join(tmp, 'legacy-research'); mkdirSync(legacy);
    const app = boot([{ type: 'custom', customType: 'pi-agent-mode-v2', data: { vault: legacy, state: { mode: 'research', question: 'Legacy?' } } }]);
    await fire(app.api, 'session_start', {}, app.ctx);
    assertIncludes((await command(app, 'list')).text, `目前掛載：${join(legacy, '07-Agent-Wiki')}`);
    const context = JSON.parse((await fire(app.api, 'before_agent_start', { prompt: 'Legacy?', systemPrompt: '' }, app.ctx)).message.content);
    assert(context.mode === 'research' && context.vault === legacy, JSON.stringify(context));
  });
  await test('新 Session 只切研究模式就重開，仍用獨立預設 Wiki', async () => {
    const app = boot(); await app.api._commands.get('mode').handler('research', app.ctx);
    const resumed = boot(stored(app)); await fire(resumed.api, 'session_start', {}, resumed.ctx);
    assertIncludes((await command(resumed, 'list')).text, `目前掛載：${global}`);
  });
  await test('無效或 symlink 掛載不改變目前位置', async () => {
    const app = boot(); await command(app, 'default');
    symlinkSync(global, join(workspace, 'link'));
    assert((await command(app, 'use ./link')).level === 'error');
    assert((await command(app, 'use misspelled')).level === 'error');
    assertIncludes((await command(app, 'list')).text, `目前掛載：${global}`);
  });
  await test('沒有來源 vault 仍可保存研究草稿至 LLM Wiki', async () => {
    writeFileSync(config, '{}'); delete process.env.PI_STUDY_VAULT;
    const app = boot(); await command(app, 'use ./research-only');
    await app.api._commands.get('mode').handler('research', app.ctx);
    const context = JSON.parse((await fire(app.api, 'before_agent_start', { prompt: 'question', systemPrompt: '' }, app.ctx)).message.content);
    assert(context.mode === 'research' && !context.error, JSON.stringify(context));
    const search = JSON.parse((await app.api._tools.get('study_search').execute('t', { query: 'question' }, undefined, undefined, app.ctx)).content[0].text);
    assert(search.notes.length === 0);
    await app.api._tools.get('research_save').execute('t', { topic: 'question', title: 'Question', question: 'Question?', scope: 'Scope', status: 'draft', findings: [], sources: [], uncertainties: [], nextSteps: [] }, undefined, undefined, app.ctx);
    assert(m.records({ directory: join(workspace, 'research-only') }).length === 1);
  });
} finally { rmSync(tmp, { recursive: true, force: true }); }
report();
