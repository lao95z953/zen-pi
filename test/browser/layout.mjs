import '../isolate.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, firefox } from 'playwright';

const publicRoot = new URL('../../web/public/', import.meta.url);
const message = '一段測試長對話，用來確認捲動只發生在內容區。\n\n'.repeat(12) + '\n```text\n' + 'long_content_'.repeat(160) + '\n```\n\n| 欄位 | 值 |\n| --- | --- |\n| 名稱 | ' + 'wide_value_'.repeat(100) + ' |';
const state = { startedAt: 1, revision: 1, serverId: 'layout-fixture', workspaceId: 'workspace', sessionId: 'session',
  mode: 'general', online: true, busy: false, readOnly: false, canContinue: false, model: 'mock/test',
  workspaces: [{ id: 'workspace', name: 'Workspace', path: '/fixture/workspace', available: true }],
  sessions: Array.from({ length: 50 }, (_, i) => ({ id: i ? `s-${i}` : 'session', workspaceId: 'workspace', title: `對話 ${i}`, createdAt: '2026-01-01', updatedAt: '2026-01-01', origin: 'web', kind: 'chat' })),
  messages: Array.from({ length: 50 }, (_, i) => ({ id: `m-${i}`, role: i % 2 ? 'assistant' : 'user', text: message, thinking: i % 2 ? '思考內容。'.repeat(30) : '', timestamp: 1 })),
  sources: Array.from({ length: 100 }, (_, i) => ({ id: `source-${i}`, path: `sources/${i}.md`, title: '測試來源與版本資訊'.repeat(8), sha256: 'a'.repeat(64) })), tools: [], dialogs: [], commands: [], subagents: [], queue: { steering: [], followUp: [] }, transcript: { entries: [], usage: {} },
};
const streams = new Set();
const server = createServer(async (req, res) => {
  if (req.url === '/api/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(`event: snapshot\ndata: ${JSON.stringify(state)}\n\n`); streams.add(res); req.on('close', () => streams.delete(res)); return; }
  if (req.url.startsWith('/api/')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(state)); return; }
  try {
    const file = req.url === '/' ? 'index.html' : req.url.slice(1);
    if (!/^[a-z0-9.-]+$/.test(file)) throw Error();
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
    res.end(await readFile(new URL(file, publicRoot)));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
async function inspect(page, label) {
  const value = await page.evaluate(() => {
    const bounds = id => { const r = document.querySelector(id).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, height: r.height }; };
    return { width: innerWidth, height: innerHeight, x: scrollX, y: scrollY,
      documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight,
      toolbar: bounds('.reading-toolbar'), composer: bounds('.composer-wrap'), chat: bounds('#chat-scroll'),
      chatOverflow: document.querySelector('#chat-scroll').scrollHeight > document.querySelector('#chat-scroll').clientHeight };
  });
  assert(value.documentWidth <= value.width + 1, `${label}: document width overflows ${JSON.stringify(value)}`);
  assert(value.documentHeight <= value.height + 1 && value.x === 0 && value.y === 0, `${label}: document scrolls ${JSON.stringify(value)}`);
  assert(value.toolbar.top >= 0 && value.toolbar.right <= value.width + 1 && value.toolbar.bottom < value.height, `${label}: toolbar out of view ${JSON.stringify(value)}`);
  assert(value.composer.top >= 0 && value.composer.bottom <= value.height + 1, `${label}: composer out of view ${JSON.stringify(value)}`);
  assert(value.chat.height > 50 && value.chatOverflow, `${label}: chat must own its scrollbar ${JSON.stringify(value)}`);
}
try {
  for (const [name, engine] of [['Chromium', chromium], ['Firefox', firefox]]) {
    browser = await engine.launch({ headless: true });
    for (const [width, height, reducedMotion = 'reduce'] of [[1920, 1000], [1280, 720], [900, 650], [812, 375], [390, 844], [390, 360], [1280, 720, 'no-preference'], [390, 844, 'no-preference']]) {
      const page = await browser.newPage({ viewport: { width, height }, reducedMotion });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(base); await page.locator('#messages .message').first().waitFor();
      await inspect(page, `${name} ${width}: initial`);
      if (process.env.PI_LAYOUT_SCREENSHOTS && name === 'Chromium' && [1280, 390].includes(width) && height > 600 && reducedMotion === 'reduce') {
        await mkdir(process.env.PI_LAYOUT_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: `${process.env.PI_LAYOUT_SCREENSHOTS}/${width}.png` });
      }
      await page.locator('#chat-scroll').evaluate(node => node.scrollTop = node.scrollHeight / 2);
      await page.locator('#prompt').focus();
      await page.evaluate(() => window.scrollTo(10000, 10000));
      await inspect(page, `${name} ${width}: long conversation and input focus`);
      await page.locator('#toggle-header').click();
      await inspect(page, `${name} ${width}: header open`);
      await page.locator('#toggle-header').click();
      if (width >= 768) {
        await page.locator('#toggle-right-panel').click(); await inspect(page, `${name} ${width}: both sidebars`);
        await page.locator('#source-pane').evaluate(node => node.scrollTop = node.scrollHeight);
        await page.locator('#sources-panel').evaluate(node => node.scrollTop = node.scrollHeight);
        const close = await page.locator('#close-sources').boundingBox();
        assert(close.y >= 0 && close.y + close.height <= height, `${name}: source close control scrolled out of view`);
        await page.locator('#open-sidebar').click(); await inspect(page, `${name} ${width}: left closed`);
        await page.locator('#toggle-right-panel').click(); await inspect(page, `${name} ${width}: both closed`);
      } else {
        await page.locator('#open-sidebar').click(); await page.locator('#close-sidebar').click();
        await page.locator('#toggle-right-panel').click(); await page.locator('#close-sources').click();
      }
      assert.deepEqual(errors, [], `${name}: runtime errors`);
      console.log(`${name} ${width}×${height} ${reducedMotion}: toolbar, composer and independent scrolling passed`);
      await page.close();
    }
    if (name === 'Chromium') {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce', hasTouch: true });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(base); await page.locator('#messages .message').first().waitFor();
      const devtools = await page.context().newCDPSession(page);
      async function visible(selectors, label) {
        await page.waitForFunction(() => {
          const box = document.documentElement.getBoundingClientRect(), v = visualViewport;
          return Math.abs(box.width - v.width) < 1 && Math.abs(box.height - v.height) < 1
            && Math.abs(box.left - v.offsetLeft) < 1 && Math.abs(box.top - v.offsetTop) < 1;
        });
        const value = await page.evaluate(selectors => {
          const v = visualViewport;
          return { viewport: { width: v.width, height: v.height, left: v.offsetLeft, top: v.offsetTop, scale: v.scale },
            boxes: Object.fromEntries(selectors.map(selector => [selector, document.querySelector(selector).getBoundingClientRect().toJSON()])) };
        }, selectors);
        for (const [selector, box] of Object.entries(value.boxes)) {
          const v = value.viewport;
          assert(box.left >= v.left - 1 && box.right <= v.left + v.width + 1 && box.top >= v.top - 1 && box.bottom <= v.top + v.height + 1,
            `${label}: ${selector} outside visual viewport ${JSON.stringify(value)}`);
        }
        return value.viewport;
      }
      const frame = ['.reading-toolbar', '.composer-wrap', '#open-sidebar', '#toggle-header', '#toggle-right-panel'];
      for (const scale of [1.25, 1.5, 2, 2.5, 1]) {
        await devtools.send('Emulation.setPageScaleFactor', { pageScaleFactor: scale });
        await visible(frame, `pinch ${scale}`);
        await page.locator('#toggle-right-panel').click();
        await visible(['#close-sources', '.panel-tabs'], `pinch ${scale}: sources`);
        await page.locator('#source-pane').evaluate(node => node.scrollTop = node.scrollHeight);
        await visible(['#close-sources'], `pinch ${scale}: sources scrolled`);
        await page.locator('#close-sources').click();
        await page.locator('#open-sidebar').click();
        // The desktop sidebar may already have been open.
        if (await page.locator('#sidebar').isHidden()) await page.locator('#open-sidebar').click();
        await page.locator('#add-workspace').click();
        await visible(['#workspace-dialog'], `pinch ${scale}: dialog`);
        await page.locator('#workspace-dialog').evaluate(node => node.close());
        await page.locator('#close-sidebar').click();
        await page.locator('#prompt').focus();
        await visible(frame, `pinch ${scale}: input focus`);
        console.log(`Chromium pinch ${scale}×: controls, panels, dialog and composer passed`);
      }
      await devtools.send('Input.synthesizePinchGesture', { x: 640, y: 360, scaleFactor: 1.5, relativeSpeed: 800, gestureSourceType: 'mouse' });
      await page.waitForFunction(() => visualViewport.scale > 1.1, null, { timeout: 3000 });
      const panned = await visible(frame, 'pinch around page center');
      assert(panned.scale > 1.1 && (panned.top > 0 || panned.left > 0), `gesture must cover panning: ${JSON.stringify(panned)}`);
      await page.locator('#open-sidebar').click();
      if (await page.locator('#sidebar').isHidden()) await page.locator('#open-sidebar').click();
      await page.locator('#add-workspace').click();
      await visible(['#workspace-dialog'], 'panned pinch: dialog');
      await page.locator('#cancel-workspace').click();
      console.log('Chromium centered pinch: panned visual viewport and dialog passed');
      assert.deepEqual(errors, [], 'pinch runtime errors');
      await page.close();
    }
    await browser.close(); browser = null;
  }
} finally { await browser?.close(); for (const res of streams) res.end(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
