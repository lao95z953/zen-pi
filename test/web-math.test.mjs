import './isolate.mjs';
import assert from 'node:assert/strict';
import { markdown } from '../web/public/markdown.js';
import { createMathRenderer } from '../web/public/math-view.js';

const formula = 'Recall_r = \\frac{TP_r}{12}';
const shot = markdown(`以下是公式：\n\n\\[\n${formula}\n\\]\n\n後記`);
assert.match(shot, /<div class="math-block" data-math="block">Recall_r = \\frac\{TP_r\}\{12\}<\/div>/);
assert.match(shot, /<p>以下是公式：<\/p>/);
assert.match(shot, /<p>後記<\/p>/);

for (const source of ['\\[\nx = 1\n\\]', '$$\nx = 1\n$$', '\\[ x = 1 \\]', '$$ x = 1 $$'])
  assert.match(markdown(source), /class="math-block" data-math="block">x = 1</, source);
for (const source of ['行內 \\(y\\) 收尾', '行內 $y$ 收尾', '行內 $$y$$ 收尾'])
  assert.match(markdown(source), /<span class="math-inline" data-math="inline">y<\/span>/, source);

for (const plain of ['$a + b$', '$f(x) = y$'])
  assert.match(markdown(plain), /class="math-inline"/, `Simple spaced formulas still count: ${plain}`);

for (const pair of ['$x$ 和 $y$', '\\[x\\] 和 \\[y\\]'])
  assert.equal([...markdown(pair).matchAll(/data-math="inline"/g)].length, 2, `Two formulas on one line stay separate: ${pair}`);

for (const money of ['價格 $5 到 $10 之間', '成本從 $5 漲到 $8', '$100 與 $200', '單價 $9 起'])
  assert.doesNotMatch(markdown(money), /data-math/, money);
assert.doesNotMatch(markdown('`price $5 and $10`'), /data-math/, 'Code spans win over math delimiters');
assert.match(markdown('`price $5 and $10`'), /<code>price \$5 and \$10<\/code>/);

assert.doesNotMatch(markdown('\\[\nRecall_r ='), /data-math/, 'Unclosed streaming math stays readable text');
assert.doesNotMatch(markdown('$$\nx ='), /data-math/);
assert.match(markdown('\\[\nRecall_r ='), /<p>\\\[<br>Recall_r =<\/p>/);

const injection = markdown('\\[<img src=x onerror=alert(1)>\\]');
assert.match(injection, /&lt;img src=x onerror=alert\(1\)&gt;/);
assert.doesNotMatch(injection, /<img/);
assert.match(markdown('**粗體** 與 $x^2$'), /<strong>粗體<\/strong>/, 'Math does not swallow surrounding emphasis');
assert.match(markdown('| 指標 | 值 |\n| --- | --- |\n| 召回 | $x^2$ |'), /<td><span class="math-inline"/);

const MATHML = 'http://www.w3.org/1998/Math/MathML';
const MATHML_TAGS = new Set(['math', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'mfrac', 'msub', 'msup', 'mtext', 'mstyle', 'annotation']);
class Stub {
  constructor(localName) {
    this.localName = localName;
    this.namespaceURI = MATHML_TAGS.has(localName) ? MATHML : 'http://www.w3.org/1999/xhtml';
    this.childNodes = []; this.descendants = []; this.dataset = {}; this.textContent = '';
  }
  querySelectorAll() { return this.descendants; }
  replaceChildren(...nodes) { this.childNodes = nodes; this.replaced = nodes; }
}
const previousParser = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
globalThis.DOMParser = class {
  parseFromString(markup) {
    if (markup.includes('MALFORMED')) return { documentElement: new Stub('parsererror') };
    const root = new Stub('div');
    const inner = markup.replace(/^<div [^>]*>/, '').replace(/<\/div>$/, '');
    root.descendants = [...inner.matchAll(/<([a-zA-Z][\w-]*)/g)].map(match => new Stub(match[1]));
    root.childNodes = root.descendants.slice(0, 1);
    return { documentElement: root };
  }
};
globalThis.document = { importNode: node => node };
const mathml = '<span class="katex"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>x</mi></mrow></semantics></math></span>';
const node = (source, mode = 'block') => { const item = new Stub(mode === 'block' ? 'div' : 'span'); item.textContent = source; item.dataset.math = mode; return item; };
const container = (...nodes) => ({ querySelectorAll: () => nodes });

try {
  let loads = 0, options;
  const katex = { renderToString: (source, value) => { options = value; if (source.includes('BAD')) return '<span><script>alert(1)</script></span>'; if (source.includes('THROW')) throw Error("KaTeX parse error: Expected '}', got 'EOF'"); if (source.includes('BROKEN')) return 'MALFORMED'; return source.includes('REJECT') ? '<span class="katex-error" style="color:#cc0000">bad</span>' : mathml; } };
  const renderer = createMathRenderer({ loadKatex: async () => { loads++; return { default: katex }; } });

  await renderer(container());
  assert.equal(loads, 0, 'KaTeX loads only when the message actually holds math');

  const good = node(formula);
  await renderer(container(good));
  assert.equal(loads, 1);
  assert.equal(good.dataset.mathReady, 'done');
  assert.equal(good.replaced.length, 1);
  assert.equal(options.output, 'mathml', 'HTML output would need inline styles the CSP blocks');
  assert.equal(options.trust, false);
  assert.equal(options.throwOnError, true, 'A thrown parse error beats KaTeX emitting a CSP-blocked error span');
  assert.equal(options.displayMode, true);

  await renderer(container(good));
  assert.equal(loads, 1, 'Rendered nodes are never typeset twice');

  const inlineNode = node('y', 'inline');
  await renderer(container(inlineNode));
  assert.equal(options.displayMode, false);

  const scripted = node('BAD');
  await renderer(container(scripted));
  assert.equal(scripted.dataset.mathReady, 'error', 'Non-MathML elements are refused wholesale');
  assert.equal(scripted.replaced, undefined);
  assert.equal(scripted.textContent, 'BAD', 'The raw LaTeX survives a refusal');

  const thrown = node('THROW');
  await renderer(container(thrown));
  assert.equal(thrown.dataset.mathReady, 'error');
  assert.equal(thrown.textContent, 'THROW', 'A rejected formula still shows its source');
  assert.match(thrown.title, /Expected/, "KaTeX's own reason reaches the tooltip");

  const rejected = node('REJECT');
  await renderer(container(rejected));
  assert.equal(rejected.dataset.mathReady, 'error', 'A KaTeX error span carries a CSP-blocked inline style, so it never reaches the page');
  assert.equal(rejected.replaced, undefined);
  assert.equal(rejected.textContent, 'REJECT');

  const malformed = node('BROKEN');
  await renderer(container(malformed));
  assert.equal(malformed.dataset.mathReady, 'error');

  const empty = node('   ');
  const huge = node('x'.repeat(2001));
  await renderer(container(empty, huge));
  assert.equal(empty.dataset.mathReady, 'error');
  assert.equal(huge.dataset.mathReady, 'error');

  const offline = createMathRenderer({ loadKatex: async () => { throw Error('offline'); } });
  const stranded = node(formula);
  await offline(container(stranded));
  assert.equal(stranded.dataset.mathReady, 'error');
  assert.equal(stranded.textContent, formula, 'A failed library load still shows the source');
  assert.match(stranded.title, /原始 LaTeX/);
} finally {
  if (previousParser) Object.defineProperty(globalThis, 'DOMParser', previousParser); else delete globalThis.DOMParser;
  if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else delete globalThis.document;
}

console.log('web-math: 數學算式渲染測試通過');
