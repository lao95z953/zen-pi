import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { ConversationView } from '../web/server.mjs';
import { markdown } from '../web/public/markdown.js';
import { isCurrent } from '../web/public/state.js';
const view = new ConversationView();
view.message({ role: 'custom', customType: 'pi-mode-state', content: JSON.stringify({ mode: 'research', question: '為什麼？' }) });
assert.equal(view.mode, 'research');
view.message({ role: 'custom', customType: 'pi-study-state', content: JSON.stringify({ focus: { mode: 'manual', path: 'note.md' }, current: { path: 'note.md' } }) });
assert.equal(view.context.current, 'note.md');
assert.equal(view.sources.size, 0, 'Selecting a note must not claim its content has been delivered');
view.message({ role: 'custom', customType: 'pi-mode-error', content: JSON.stringify({ error: '模式不能切換' }) });
assert.equal(view.error, '模式不能切換');
const excerpt = { path: 'note.md', sha256: 'a'.repeat(64), content: '1: first line', truncated: true };
view.collectSources({ current: excerpt });
view.collectSources({ current: excerpt });
assert.equal(view.sources.size, 1);
view.collectSources({ current: { ...excerpt, content: '2: next line' } });
assert.equal(view.sources.size, 2, 'Different delivered ranges must retain separate immutable snapshots');
assert.equal([...view.sources.values()][0].content, '1: first line');
assert.ok(view.snapshot().sources.every(s => !('content' in s)), 'Snapshot lists metadata; full content comes only from source ID route');
const reasoned = view.message({ role: 'assistant', content: [
  { type: 'thinking', thinking: '先檢查來源。' },
  { type: 'thinking', thinking: 'Do not show this', redacted: true, thinkingSignature: 'PRIVATE-SIGNATURE' },
] });
assert.equal(reasoned.thinking, '先檢查來源。');
assert.ok(!JSON.stringify(view.snapshot()).includes('PRIVATE-SIGNATURE'));
for (let i = 0; i < 400; i++) view.message({ role: 'assistant', content: 'x'.repeat(5000) });
assert.ok(view.messages.length <= 300);
assert.ok(view.messages.reduce((n, m) => n + m.text.length, 0) <= 1200000);
const malicious = markdown('<script>alert(1)</script>\n[x](javascript:alert)\n![track](https://evil.test/a)\n[ok](https://example.com)');
assert.ok(!malicious.includes('<script>'));
assert.ok(!malicious.includes('href="javascript:'));
assert.ok(!malicious.includes('<img'), 'Remote source content cannot issue image requests');
assert.ok(malicious.includes('rel="noopener noreferrer"'));
const code = markdown('```html\n<img src=x onerror=alert(1)>\n```\n\n**strong** and `code`\n\n| a | b |\n| --- | --- |\n| 1 | 2 |');
assert.ok(code.includes('&lt;img'));
assert.ok(code.includes('<strong>strong</strong>'));
assert.ok(code.includes('<table>'));
const numbered = markdown('1. first\n\nDetails\n\n2. second\n\n3. third');
assert.ok(numbered.includes('<ol><li>first</li></ol>'));
assert.ok(numbered.includes('<ol start="2"><li>second</li></ol>'), 'Separated ordered-list items must retain their Markdown number');
assert.ok(numbered.includes('<ol start="3"><li>third</li></ol>'), 'Later ordered-list items must not restart visually at 1');
assert.equal(markdown('['.repeat(120000)), `<p>${'['.repeat(120000)}</p>`, 'Unclosed bracket runs must not create repeated link-label scans');
assert.equal(isCurrent({ startedAt: 100, revision: 8 }, { startedAt: 100, revision: 7 }), false, 'Late HTTP response cannot undo a newer SSE snapshot');
assert.equal(isCurrent({ startedAt: 100, revision: 8 }, { startedAt: 101, revision: 0 }), true, 'Service restart starts a new revision epoch');
assert.equal(isCurrent({ startedAt: 101, revision: 1 }, { startedAt: 100, revision: 100 }), false, 'Late response from a stopped service cannot overwrite the new service');
// A browser module the allow-list forgets is a 404 that breaks every import below it.
const publicDir = new URL('../web/public/', import.meta.url);
const allowList = readFileSync(new URL('../web/server.mjs', import.meta.url), 'utf8').split('\n').find(line => line.includes('const staticFiles')) || '';
for (const file of readdirSync(publicDir).filter(name => name.endsWith('.js'))) {
  assert.ok(allowList.includes(`'/${file}'`), `web/public/${file} is never served: add it to staticFiles in web/server.mjs`);
  const source = readFileSync(new URL(file, publicDir), 'utf8');
  for (const [, specifier] of source.matchAll(/(?:from|import)\s*\(?\s*'\.\/([^']+)'/g))
    assert.ok(allowList.includes(`'/${specifier}'`), `${file} imports ./${specifier}, which staticFiles in web/server.mjs never serves`);
}

console.log('Web view / safe Markdown checks passed');
