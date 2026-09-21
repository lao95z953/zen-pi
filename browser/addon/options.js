const status = document.getElementById('status');
async function show() {
  const { connection } = await browser.storage.local.get('connection');
  status.textContent = connection?.enabled ? '已配對；Bridge 啟動時會自動連線。' : '尚未連線';
}
document.getElementById('config').addEventListener('change', async event => {
  try {
    const file = event.target.files[0];
    if (!file || file.size > 4096) throw new Error('請選擇 /browser setup 產生的 connection.json。');
    const value = JSON.parse(await file.text());
    if (value.endpoint !== 'http://127.0.0.1:4319' || !/^[a-f0-9]{48}$/.test(value.token || '')) throw new Error('連線設定格式不符。');
    await browser.storage.local.set({ connection: { endpoint: value.endpoint, token: value.token, enabled: true } });
    await show();
  } catch (error) { status.textContent = error.message; }
});
document.getElementById('disconnect').onclick = async () => { await browser.storage.local.remove('connection'); await show(); };
await show();
