import './isolate.mjs';
import assert from 'node:assert/strict';
import { markdown } from '../web/public/markdown.js';
import { createMermaidRenderer } from '../web/public/mermaid-view.js';

const diagram = 'flowchart LR\nA[開始] --> B[結束]';
const html = markdown(`前言\n\n\`\`\`mermaid\n${diagram}\n\`\`\`\n\n後記`);
assert.match(html, /class="mermaid-card"/);
assert.match(html, /查看原始碼/);
assert.match(html, /flowchart LR/);
assert.match(html, /後記/);
assert.doesNotMatch(markdown('```mermaid\nflowchart LR\nA-->B'), /mermaid-card/, 'Incomplete streaming fences stay readable code');
assert.doesNotMatch(markdown('```javascript\nflowchart LR\nA-->B\n```'), /mermaid-card/);
assert.match(markdown('```MERMAID\nA[<img src=x onerror=alert(1)>]\n```'), /&lt;img src=x onerror=alert\(1\)&gt;/);
assert.doesNotMatch(markdown('```MERMAID\nA[<img src=x onerror=alert(1)>]\n```'), /<img/);

class Element {
  constructor() { this.dataset = {}; this.children = []; this.isConnected = true; this.hidden = false; this.textContent = ''; this.open = false; }
  append(...children) { this.children.push(...children); }
  remove() { this.removed = true; }
  setAttribute(key, value) { this[key] = value; }
  querySelector(selector) { return this.parts[selector]; }
}
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
globalThis.document = { createElement: () => new Element() };
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async text => { assert.equal(text, diagram); } } } });
const makeCard = (text = diagram) => {
  const code = new Element(); code.textContent = text;
  const source = new Element(); source.parts = { code };
  const status = new Element();
  const preview = new Element(); preview.parts = { '.mermaid-status': status };
  const toolbar = new Element();
  const card = new Element(); card.parts = { '.mermaid-source': source, '.mermaid-preview': preview, '.mermaid-toolbar': toolbar };
  const container = { querySelectorAll: () => [card] };
  return { card, container, source, status, preview, toolbar };
};
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
try {
  let loads = 0, renders = 0, config;
  const renderer = createMermaidRenderer({ loadMermaid: async () => { loads++; return { default: {
    initialize: value => { config = value; },
    render: async (_, text) => { renders++; assert.equal(text, diagram); return { svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' }; },
  } }; } });
  const view = makeCard();
  assert.equal(loads, 0, 'Mermaid library loads only when a diagram is present');
  renderer(view.container, { streaming: true });
  assert.equal(view.status.textContent, '回覆完成後繪製圖表…');
  assert.equal(loads, 0);
  renderer(view.container);
  await flush();
  assert.equal(loads, 1);
  assert.equal(renders, 1);
  assert.equal(config.securityLevel, 'strict');
  assert.equal(config.htmlLabels, false);
  assert.equal(config.suppressErrorRendering, true);
  const image = view.preview.children[0];
  assert.match(image.src, /^data:image\/svg\+xml/);
  assert.match(decodeURIComponent(image.src), /<svg/);
  assert.equal(view.preview.innerHTML, undefined, 'SVG is never inserted as live page HTML');
  image.onload();
  assert.equal(view.status.hidden, true);
  assert.equal(view.card.dataset.mermaidReady, 'done');
  renderer(view.container);
  assert.equal(renders, 1, 'Repeated UI updates do not redraw a completed diagram');
  view.toolbar.children[1].onclick();
  assert.equal(view.preview.dataset.zoom, '2');
  await view.toolbar.children[2].onclick();
  assert.equal(view.toolbar.children[2].textContent, '已複製');

  const broken = makeCard('flowchart nope');
  const failing = createMermaidRenderer({ loadMermaid: async () => ({ default: { initialize() {}, render: async () => { throw Error('parse'); } } }) });
  failing(broken.container); await flush();
  assert.equal(broken.card.dataset.mermaidReady, 'error');
  assert.equal(broken.source.open, true);
  assert.match(broken.status.textContent, /無法繪製/);
  const long = makeCard('x'.repeat(10001));
  renderer(long.container); await flush();
  assert.equal(long.source.open, true);
  assert.equal(renders, 1, 'Oversized diagrams never reach the parser');
} finally {
  if (previousDocument === undefined) delete globalThis.document; else Object.defineProperty(globalThis, 'document', previousDocument);
  if (previousNavigator === undefined) delete globalThis.navigator; else Object.defineProperty(globalThis, 'navigator', previousNavigator);
}
console.log('Mermaid display and safe fallback checks passed');
