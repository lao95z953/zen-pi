// Real Gecko extension test, entirely headless with a disposable profile and synthetic pages.
// Needs system Firefox. It refuses to replace an existing bridge on port 4319.
import '../isolate.mjs';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createBrowserBridge } from '../../browser/bridge.mjs';
import { request } from '../../browser/client.mjs';

const root = await mkdtemp(join(tmpdir(), 'zen-addon-'));
const portServer = net.createServer(); await new Promise(r => portServer.listen(0, '127.0.0.1', r));
const port = portServer.address().port; await new Promise(r => portServer.close(r));
const uuid = '83d025a0-588f-44b8-ac20-601386e59156';
const config = { endpoint: 'http://127.0.0.1:4319', token: 'b'.repeat(48) };
const bridge = await createBrowserBridge({ token: config.token });
const site = createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(req.url === '/overflow'
  ? `<!doctype html><title>Many links</title><style>a{display:inline-block;width:65px;height:20px;font:10px sans-serif}input{display:block}</style>${Array.from({ length: 90 }, (_, i) => `<a href="#link-${i}">Link ${i}</a>`).join('')}<label>Search <input id="query"></label>`
  : `<!doctype html><title>Bridge fixture</title><style>body{font:18px sans-serif;padding:24px}input,button,select{padding:10px;margin:10px}</style><h1>Test page</h1><label>Search <input id="query"></label><button id="go">Search</button><p id="result">Ready</p><label>Category <select id="category"><option>All</option><option>Research</option></select></label><label>Password <input type="password" value="secret-fixture"></label><button disabled>Disabled</button><script>document.querySelector('#go').onclick=()=>{document.querySelector('#result').textContent='Result: '+document.querySelector('#query').value;window.clicks=(window.clicks||0)+1}</script>`); });
await new Promise(r => site.listen(0, '127.0.0.1', r));
let child, socket, lease, log = '', serial = 0, buffer = Buffer.alloc(0);
const pending = new Map();
const pause = ms => new Promise(r => setTimeout(r, ms));
function receive(chunk) {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const separator = buffer.indexOf(':'); if (separator < 0) return;
    const length = Number(buffer.subarray(0, separator).toString()); if (buffer.length < separator + 1 + length) return;
    const value = JSON.parse(buffer.subarray(separator + 1, separator + 1 + length)); buffer = buffer.subarray(separator + 1 + length);
    if (!Array.isArray(value)) continue;
    const entry = pending.get(value[1]); if (!entry) continue;
    pending.delete(value[1]); clearTimeout(entry.timer);
    if (value[2]) entry.reject(new Error(JSON.stringify(value[2]))); else entry.resolve(value[3]);
  }
}
function command(name, args = {}) {
  return new Promise((resolve, reject) => {
    const id = ++serial, body = Buffer.from(JSON.stringify([0, id, name, args]));
    pending.set(id, { resolve, reject, timer: setTimeout(() => { pending.delete(id); reject(new Error('Marionette timeout: ' + name)); }, 60000) });
    socket.write(Buffer.concat([Buffer.from(body.length + ':'), body]));
  });
}
const script = async (script, args = []) => (await command('WebDriver:ExecuteScript', { script, args, newSandbox: false, sandbox: null })).value;
try {
  const prefs = { 'marionette.port': port, 'browser.shell.checkDefaultBrowser': false, 'browser.aboutwelcome.enabled': false, 'browser.startup.page': 0, 'browser.startup.homepage': 'about:blank', 'browser.newtabpage.enabled': false, 'datareporting.policy.dataSubmissionEnabled': false, 'extensions.webextensions.uuids': JSON.stringify({ 'browser-bridge@zen-pi.local': uuid }) };
  await writeFile(join(root, 'user.js'), Object.entries(prefs).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join('\n'));
  await writeFile(join(root, 'connection.json'), JSON.stringify(config), { mode: 0o600 });
  execFileSync(process.execPath, ['scripts/package-browser-addon.mjs', join(root, 'bridge.xpi')]);
  const args = ['--headless', '--marionette', '-remote-allow-system-access', '--no-remote', '--profile', root];
  child = process.env.PI_BROWSER_FLATPAK === '1'
    ? spawn('flatpak', ['run', `--filesystem=${root}`, 'app.zen_browser.zen', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(process.env.PI_BROWSER_FIREFOX || '/usr/bin/firefox', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => log = (log + data).slice(-4000)); child.stderr.on('data', data => log = (log + data).slice(-4000));
  child.on('error', e => log += e.message);
  for (let i = 0; i < 100; i++) {
    try { socket = net.connect(port, '127.0.0.1'); await once(socket, 'connect'); break; } catch { socket?.destroy(); socket = null; await pause(100); }
  }
  assert(socket, 'Headless Firefox must start: ' + log); socket.on('data', receive);
  await command('WebDriver:NewSession', { capabilities: { alwaysMatch: { acceptInsecureCerts: false, 'moz:webdriverClick': true } } });
  await command('Addon:Install', { path: join(root, 'bridge.xpi'), temporary: true });
  await command('WebDriver:Navigate', { url: `moz-extension://${uuid}/options.html` });
  const input = (await command('WebDriver:FindElement', { using: 'css selector', value: '#config' })).value;
  await command('WebDriver:ElementSendKeys', { id: input['element-6066-11e4-a52e-4f735466cecf'], text: join(root, 'connection.json') });
  for (let i = 0; i < 100 && !(await request(config, { op: 'status' })).connected; i++) await pause(100);
  assert((await request(config, { op: 'status' })).connected, 'Addon must pair through its actual file input');
  const started = await request(config, { op: 'begin', url: `http://127.0.0.1:${site.address().port}/` }); lease = started.lease;
  const call = value => request(config, { ...value, lease });
  let page = started.page;
  assert(!JSON.stringify(page).includes('secret-fixture'));
  assert(!page.actions.some(a => /Password|Disabled/.test(a.label)));
  const field = page.actions.find(a => a.kind === 'fill'); assert(field);
  await call({ op: 'act', snapshot: page.snapshot, action: field.id, text: 'Hello Zen' });
  page = await call({ op: 'observe' });
  const button = page.actions.find(a => a.kind === 'click'); assert(button);
  await call({ op: 'act', snapshot: page.snapshot, action: button.id });
  page = await call({ op: 'observe' }); assert(page.text.includes('Result: Hello Zen'));
  const option = page.actions.find(a => a.kind === 'select' && a.option === 1); assert.equal(option.label, 'Category → Research');
  await call({ op: 'act', snapshot: page.snapshot, action: option.id });
  page = await call({ op: 'observe' }); assert(page.actions.filter(a => a.kind === 'select').every(a => a.value === 'Research'));
  // The background created an inactive tab. Switch only this disposable headless browser to verify actual page state.
  const handlesResult = await command('WebDriver:GetWindowHandles');
  const handles = handlesResult.value || handlesResult;
  await command('WebDriver:SwitchToWindow', { handle: handles.at(-1) });
  assert.equal(await script('return window.clicks'), 1);
  await script('document.querySelector("#go").textContent = "Changed"; return true');
  await assert.rejects(call({ op: 'act', snapshot: page.snapshot, action: button.id }), /改變/);
  lease = null;
  const restarted = await request(config, { op: 'begin', tabId: started.page.tabId }); lease = restarted.lease; page = restarted.page;
  await script('const e=document.createElement("div"); e.id="overlay"; e.style="position:fixed;inset:0;z-index:100;background:#fff8"; document.body.append(e); return true');
  await assert.rejects(call({ op: 'act', snapshot: page.snapshot, action: button.id }), /遮住/);
  lease = null;
  const overflow = await request(config, { op: 'begin', url: `http://127.0.0.1:${site.address().port}/overflow` }); lease = overflow.lease;
  assert(overflow.page.truncated, 'The page must exercise the 80-action cap');
  assert(overflow.page.actions.some(a => a.kind === 'fill' && a.label === 'Search'), 'The search field must remain available after many links');
  console.log(`Real headless ${process.env.PI_BROWSER_FLATPAK === '1' ? 'Zen Flatpak' : 'Firefox'} addon: package install, file pairing, authenticated bridge, tab binding, isolated content scripts, fill/click/select, sensitive fields and stale/covered target rejection passed. No personal profile or model used.`);
} catch (error) { console.error(log); throw error; }
finally {
  if (lease) await request(config, { op: 'stop', lease }).catch(() => {});
  if (socket && !socket.destroyed) await command('Marionette:Quit', { flags: ['eForceQuit'] }).catch(() => {});
  for (const value of pending.values()) clearTimeout(value.timer);
  socket?.destroy();
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), pause(5000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
  await bridge.close(); site.closeAllConnections(); await new Promise(r => site.close(r));
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
