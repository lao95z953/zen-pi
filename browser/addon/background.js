let generation = 0, job = null, connectionAbort;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const peerKey = 'zenPiPeer';
const saved = await browser.storage.local.get(peerKey);
const peer = saved[peerKey] || crypto.randomUUID();
await browser.storage.local.set({ [peerKey]: peer });

async function send(config, signal, path, body) {
  const response = await fetch(config.endpoint + path, { method: 'POST', credentials: 'omit', redirect: 'error',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, peer }), signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]) });
  const value = await response.json();
  if (!response.ok || value.error) throw new Error(value.error || 'Bridge 回應錯誤');
  return value;
}
function webTab(tab) { return /^https?:\/\//.test(tab.url || ''); }
async function content(op, extra = {}) {
  if (!job) throw new Error('任務尚未綁定分頁。');
  const tab = await browser.tabs.get(job.tabId);
  if (!webTab(tab)) throw new Error('此分頁不是可操作的 HTTP(S) 網頁。');
  await browser.tabs.executeScript(tab.id, { file: 'content.js' });
  const response = await browser.tabs.sendMessage(tab.id, { channel: 'zen-pi-browser', op, ...extra });
  if (!response || response.error) throw new Error(response?.error || '頁面沒有回應。');
  return response;
}
async function execute(command) {
  if (command.op === 'tabs') return (await browser.tabs.query({})).filter(webTab).map(({ id, title, url }) => ({ id, title, url }));
  if (command.op === 'begin') {
    const tab = command.url ? await browser.tabs.create({ url: command.url, active: false }) : await browser.tabs.get(command.tabId);
    job = { id: command.job, tabId: tab.id };
    for (let n = 0; n < 40; n++) {
      const current = await browser.tabs.get(tab.id);
      if (current.status === 'complete' && webTab(current)) return { ...await content('observe'), tabId: tab.id };
      await pause(250);
    }
    throw new Error('網頁載入逾時，請檢查分頁後重新開始。');
  }
  if (!job || command.job !== job.id) throw new Error('分頁任務已過期。');
  if (command.op === 'observe') return { ...await content('observe'), tabId: job.tabId };
  if (command.op === 'act') {
    // Send exactly once. Navigation may destroy the response after a click has executed.
    // In that case stop and ask Pi to inspect; never retry the mutation automatically.
    const result = await content('act', { snapshot: command.snapshot, action: command.action, text: command.text });
    return { ...result, tabId: job.tabId };
  }
  throw new Error('不支援此操作。');
}
async function connect() {
  const current = ++generation;
  connectionAbort?.abort(); connectionAbort = new AbortController();
  const signal = connectionAbort.signal;
  const config = (await browser.storage.local.get('connection')).connection;
  if (current !== generation) return;
  if (!config?.enabled) { job = null; await browser.browserAction.setBadgeText({ text: '' }); return; }
  while (current === generation) {
    try {
      const { command } = await send(config, signal, '/extension/poll', {});
      if (current !== generation) break;
      await browser.browserAction.setBadgeText({ text: 'Pi' });
      if (command) {
        let result, error;
        try { result = await execute(command); } catch (failure) { error = String(failure.message).slice(0, 500); job = null; }
        // A lost receipt is not retried: the action might already have happened.
        if (current !== generation) break;
        await send(config, signal, '/extension/result', { id: command.id, result, error });
      }
    } catch {
      if (current !== generation) break;
      await browser.browserAction.setBadgeText({ text: '…' });
      await pause(2000);
    }
  }
}
browser.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.connection) void connect(); });
void connect();
