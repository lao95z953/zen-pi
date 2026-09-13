import { markdown } from './markdown.js';
import { renderMermaidBlocks } from './mermaid-view.js';
import { isCurrent, selectedWorkspace, workspaceSessions, workspaceControls, draftScope, acceptsCreatedSession, mergeRestoredDraft, libraryScanWarning, composerSuggestions, commandUsage, moveCommandSelection, filterModels, acceptsCommandResponse, modelDisabledReason, agentControls, sessionInfoRows, workspaceJobs, jobDraft, metric, sessionParent, workspaceSessionRows, workspaceDeletedSessions, sessionManagementReason } from './state.js';
const $ = id => document.getElementById(id);
const labels = { general: '一般', study: '學習', research: '研究' };
const hints = { general: '一般 · 自由討論', study: '學習 · 從筆記釐清概念', research: '研究 · 查證來源與推進問題' };
const welcomes = {
  general: ['今天想聊什麼？', '從一個問題開始。一起寫程式、整理想法，或把卡住的地方拆開。', [['一起想清楚', '貼上正在思考的問題'], ['幫我看段程式', '描述預期與實際發生的事']]],
  study: ['把卡住的地方弄懂。', '選一篇筆記，接著說說你想釐清的概念。也可以請 Pi 檢查你的理解。', [['釐清一個概念', '從目前筆記找出關鍵前提'], ['檢查我的理解', '貼上你的說法，再一起核對']]],
  research: ['讓問題帶著研究往前。', '先描述研究問題。Pi 會查閱來源、整理證據，並保留尚未解決的部分。', [['開始一個研究問題', '寫下問題、範圍與已有的線索'], ['接續之前的研究', '告訴 Pi 研究主題或保存的代號']]],
};
const toolLabels = { study_read: '閱讀筆記', study_search: '搜尋筆記', study_focus: '選擇筆記', study_memory: '回查記憶', study_wiki: '保存概念整理', study_observe: '保存學習觀察', study_web_search: '搜尋網路來源', study_web_read: '閱讀網頁', research_papers: '搜尋論文', research_paper: '核對論文資料', research_pdf_read: '閱讀論文頁面', research_save: '保存研究', read: '閱讀檔案', write: '寫入檔案', edit: '編輯檔案', bash: '執行指令', obs_recall: '回查工具輸出' };
let state = { messages: [], sources: [], sessions: [], workspaces: [], workspaceId: null, tools: [], dialogs: [], commands: [], mode: 'general', busy: false, sessionId: null, online: false, readOnly: false, canContinue: false };
let connected = false, working = false, stopPending = false, shownDialog = null, draftKey = '', renderQueued = false, noteSearchRevision = 0;
let commandOptions = [], commandIndex = 0, commandDismissed = false, modelRequest = null;
let queuePending = false, agentPending = false, controlRequest = null, agentRequest = null, panelView = 'sources', exportURL = null;
const imageDrafts = new Map(), imageUploads = new Map(), imageAliases = new Map();
const promptPending = new Set(), compactPending = new Set(), compactResults = new Map(), jobNodes = new Map();
const thinkingLabels = { off: '關閉', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '最高' };
const messageNodes = new Map();
const collapsedSessions = new Map();
let revealSelectedSession = true, sessionManagementTarget = null, sessionManagementPending = false;
const LAYOUT_KEY = 'pi-web-layout-v1';
let layoutPreferences = readLayoutPreferences(), layoutMode = innerWidth >= 768 ? 'desktop' : 'mobile';
let mobilePanels = { left: false, right: false }, layoutRevision = 0;
let following = true, scrollRevision = 0, lastScrollTop = 0, touchY = null;
const traceNodes = new Map();
let traceScope = '', mainView = 'chat', chatTop = 0, transcriptTop = 0, usageRequest = null;
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function setError(text) { $('error').textContent = text || ''; $('error').hidden = !text; }
async function api(path, body) {
  if (body !== undefined) body = { sessionId: state.sessionId, workspaceId: state.workspaceId, ...body };
  const response = await fetch(`/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Pi-Web': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data; try { data = await response.json(); } catch { throw Error('伺服器回應無法讀取，請檢查連線。'); }
  if (!response.ok) throw Error(data.error || '操作失敗，請稍後再試。'); return data;
}
async function action(fn) {
  if (working) return;
  working = true; controls(); setError('');
  try { return await fn(); } catch (e) { setError(e.message); } finally { working = false; controls(); }
}
function controls() {
  const current = compactPending.has(draftScope(state)) ? { ...state, operation: 'compact' } : state;
  const can = workspaceControls(current, { connected, working });
  const agents = agentControls(current, { connected, working, queuePending, agentPending });
  document.querySelectorAll('[data-mode]').forEach(button => { button.disabled = !can.mode; button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode)); });
  document.querySelectorAll('.session-item').forEach(button => { button.disabled = !can.browse; });
  document.querySelectorAll('.session-more').forEach(button => { button.disabled = !connected || sessionManagementPending; });
  const tooLong = $('prompt').value.length > 32000;
  $('send').disabled = !can.send || promptPending.has(draftScope(state)) || (!$('prompt').value.trim() && !draftImages().length) || uploadingImages() || imageLimitExceeded() || tooLong;
  $('draft-limit').hidden = !tooLong;
  $('send').hidden = state.busy || !!current.operation; $('stop').hidden = !state.busy && !current.operation; $('stop').disabled = !connected || stopPending;
  $('new-session').disabled = !can.start;
  $('choose-note').disabled = !can.mode || !state.sessionId;
  const modelReason = modelDisabledReason(current, { connected, working });
  $('choose-model').disabled = !!modelReason; $('choose-model').title = modelReason || '選擇模型（/model）';
  for (const id of ['model-action-hint', 'model-dialog-hint']) { $(id).textContent = modelReason; $(id).hidden = !modelReason; }
  document.querySelectorAll('#model-results button').forEach(button => { button.disabled = !!modelReason; });
  $('prompt').disabled = !can.input; $('add-image').disabled = !can.input;
  $('workspace-select').disabled = !can.browse || !(state.workspaces || []).length;
  $('add-workspace').disabled = !can.browse; $('save-workspace').disabled = !can.browse;
  $('refresh-sessions').disabled = !can.browse;
  $('continue-session').disabled = !can.continue;
  $('choose-thinking').disabled = !!modelReason;
  $('open-tools').disabled = !connected || !state.sessionId;
  $('start-side-chat').disabled = !agents.side;
  $('return-parent').disabled = !can.browse || !sessionParent(state);
  for (const name of ['stats', 'export', 'copy']) $(`tool-${name}`).disabled = !agents.inspect;
  for (const name of ['thinking', 'compact', 'fork', 'clone']) $(`tool-${name}`).disabled = !agents.change;
  $('tools-hint').textContent = state.readOnly ? '請先接續成 Web 對話，才能查看完整用量、匯出或使用對話工具。' : state.busy || current.operation ? '對話仍在處理，可先使用 Side Chat 或查看 Sub Agent。' : '';
  document.querySelectorAll('#thinking-options button').forEach(button => { button.disabled = !agents.change; });
  document.querySelectorAll('#fork-options button').forEach(button => { button.disabled = !agents.change; });
  $('confirm-compact').disabled = !agents.change;
  $('compact-focus').disabled = !!current.operation;
  $('queue-actions').hidden = !state.busy || !!current.operation || state.readOnly;
  if ($('queue-actions').hidden) $('queue-actions').open = false;
  const queueMessage = $('prompt').value.trim(), canQueue = agents.queue && (!!queueMessage || !!draftImages().length) && !uploadingImages() && !imageLimitExceeded() && !queueMessage.startsWith('/') && !tooLong;
  $('queue-steer').disabled = !canQueue; $('queue-follow').disabled = !canQueue;
  $('clear-queue').disabled = !agents.clearQueue;
  $('new-agent').disabled = !agents.createAgent; $('start-agent').disabled = !agents.createAgent;
  $('agent-create-hint').textContent = state.readOnly ? '接續對話後，才能建立新的 Sub Agent。' : !state.sessionId ? '先開一段主對話，再分派任務。' : !state.online ? 'Pi 連線恢復後可建立任務。' : '';
  document.querySelectorAll('.job-cancel').forEach(button => { button.disabled = !agents.cancelAgent; });
  document.querySelectorAll('.job-use').forEach(button => { button.disabled = state.readOnly || !state.sessionId; });
  $('composer-hint').textContent = state.busy ? 'Enter 排到下一輪；從補充選單可立即調整方向。Shift + Enter 換行。' : state.readOnly ? '本機紀錄 · 請先接續對話' : 'Enter 送出 · Shift + Enter 換行 · 輸入 / 查看指令';
  $('connection-label').textContent = !connected ? '正在重新連線' : state.readOnly ? '本機紀錄 · 唯讀' : state.online ? 'Pi 已連線' : state.sessionId ? 'Pi 已離線' : '已就緒';
  $('connection-dot').classList.toggle('online', connected && (state.online || !state.sessionId || state.readOnly));
  sessionManagementControls();
}
function imageScope(scope = draftKey) { const seen = new Set(); while (imageAliases.has(scope) && !seen.has(scope)) { seen.add(scope); scope = imageAliases.get(scope); } return scope; }
function draftImages(scope = draftKey) {
  scope = imageScope(scope);
  if (!imageDrafts.has(scope)) {
    let images = []; try { images = JSON.parse(sessionStorage.getItem(`${scope}:images`) || '[]'); } catch {}
    imageDrafts.set(scope, Array.isArray(images) ? images.filter(image => /^[a-f0-9]{64}$/.test(image?.id || '') && Number.isFinite(image.size)).slice(0, 100) : []);
  }
  return imageDrafts.get(scope);
}
function imageLimitExceeded() { return draftImages().length > 4 || draftImages().reduce((n, image) => n + image.size, 0) > 8 * 1024 * 1024; }
function uploadingImages(scope = draftKey) { return imageUploads.get(imageScope(scope))?.count || 0; }
function writeImages(scope, images) {
  scope = imageScope(scope); const unique = [...new Map(images.map(image => [image.id, image])).values()];
  imageDrafts.set(scope, unique);
  try { sessionStorage.setItem(`${scope}:images`, JSON.stringify(unique)); } catch { setError('瀏覽器無法保存圖片草稿，重新整理前請先送出。'); }
  if (scope === imageScope(draftKey)) { renderAttachments(); controls(); }
}
function imageButton(image, index) {
  const button = el('button', 'image-preview'); button.type = 'button'; button.setAttribute('aria-label', `放大圖片 ${index + 1}`);
  const img = el('img'); img.src = `/api/images/${image.id}`; img.alt = `圖片 ${index + 1}`; img.loading = 'lazy';
  button.append(img); button.onclick = () => { $('image-full').src = img.src; $('image-dialog').showModal(); };
  return button;
}
function renderAttachments() {
  const list = $('image-attachments'), images = draftImages(); list.replaceChildren(); list.hidden = !images.length;
  images.forEach((image, index) => {
    const item = el('div', 'image-attachment'), remove = el('button', 'remove-image', '×'); remove.type = 'button'; remove.setAttribute('aria-label', `移除圖片 ${index + 1}`);
    remove.onclick = () => writeImages(draftKey, draftImages().filter(row => row.id !== image.id));
    item.append(imageButton(image, index), remove); list.append(item);
  });
  const pending = uploadingImages();
  $('image-status').hidden = !pending && !imageLimitExceeded();
  $('image-status').textContent = pending ? `正在加入 ${pending} 張圖片…` : imageLimitExceeded() ? '已恢復所有圖片；每次最多 4 張、合計 8 MiB，請先整理附件。' : '';
}
async function addImageFiles(files) {
  if ($('prompt').disabled || !files.length) return;
  const scope = imageScope(), workspaceId = state.workspaceId;
  try {
    const pending = imageUploads.get(scope) || { count: 0, bytes: 0 };
    if (draftImages(scope).length + pending.count + files.length > 4) throw Error('每則訊息最多加入 4 張圖片。');
    if (files.some(file => !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type))) throw Error('請使用 PNG、JPEG、WebP 或 GIF 圖片。');
    if (files.some(file => file.size > 5 * 1024 * 1024)) throw Error('每張圖片最多 5 MiB。');
    const bytes = files.reduce((n, file) => n + file.size, 0);
    if (draftImages(scope).reduce((n, image) => n + image.size, 0) + pending.bytes + bytes > 8 * 1024 * 1024) throw Error('圖片合計最多 8 MiB。');
    imageUploads.set(scope, { count: pending.count + files.length, bytes: pending.bytes + bytes }); renderAttachments(); controls();
    try {
      const images = await Promise.all(files.map(file => new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve({ mimeType: file.type, data: String(reader.result).split(',')[1] }); reader.onerror = () => reject(Error('圖片讀取失敗，請重新貼上。')); reader.readAsDataURL(file);
      })));
      const response = await api('images', { workspaceId, images });
      writeImages(scope, [...draftImages(scope), ...response.images]);
    } finally {
      const target = imageScope(scope), current = imageUploads.get(target) || { count: files.length, bytes };
      imageUploads.set(target, { count: current.count - files.length, bytes: current.bytes - bytes });
      if (!uploadingImages(target)) for (const alias of imageAliases.keys()) if (imageScope(alias) === target) imageAliases.delete(alias);
      renderAttachments(); controls();
    }
  } catch (error) { setError(imageScope(scope) === imageScope() ? error.message : `先前對話的圖片未加入：${error.message}`); }
}
$('add-image').onclick = () => $('image-input').click();
$('image-input').onchange = event => { const files = [...event.target.files]; event.target.value = ''; void addImageFiles(files); };
$('prompt').addEventListener('paste', event => {
  const files = [...event.clipboardData?.items || []].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
  if (!files.length) return;
  event.preventDefault();
  const text = event.clipboardData.getData('text/plain');
  if (text) { const input = $('prompt'); input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end'); resizeInput(); saveDraft(); }
  void addImageFiles(files);
});
$('close-image').onclick = () => $('image-dialog').close();

function readLayoutPreferences() {
  const defaults = { desktop: { left: true, right: false, header: false, focused: false, restore: null }, mobile: { header: true, focused: false, restore: null } };
  try {
    const raw = localStorage.getItem(LAYOUT_KEY); if (!raw || raw.length > 4096) return defaults;
    const saved = JSON.parse(raw);
    for (const mode of ['desktop', 'mobile']) {
      const entry = saved?.[mode]; if (!entry || typeof entry !== 'object') continue;
      for (const key of mode === 'desktop' ? ['left', 'right', 'header'] : ['header']) if (typeof entry[key] === 'boolean') defaults[mode][key] = entry[key];
      if (entry.focused === true && entry.restore && ['left', 'right', 'header'].every(key => typeof entry.restore[key] === 'boolean')) {
        defaults[mode].focused = true;
        defaults[mode].restore = { left: entry.restore.left, right: entry.restore.right, header: entry.restore.header };
        defaults[mode].header = false;
        if (mode === 'desktop') { defaults[mode].left = false; defaults[mode].right = false; }
      }
    }
  } catch { /* Storage can be unavailable in a private or restricted browser. */ }
  return defaults;
}
function saveLayoutPreferences() { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layoutPreferences)); } catch {} }
function visibleLayout() {
  const preferences = layoutPreferences[layoutMode];
  return { left: layoutMode === 'desktop' ? preferences.left : mobilePanels.left, right: layoutMode === 'desktop' ? preferences.right : mobilePanels.right, header: preferences.header };
}
function readingPosition() {
  const box = $('chat-scroll'), rect = box.getBoundingClientRect?.();
  const candidates = mainView === 'transcript' ? [...$('transcript-pane').querySelectorAll('.trace-entry')] : [...$('messages').querySelectorAll('.message')].filter(message => !message.hidden).flatMap(message => {
    const blocks = message.querySelector('.message-content')?.querySelectorAll('h1,h2,h3,h4,h5,h6,p,pre,li,table,blockquote,hr');
    return blocks?.length ? [...blocks] : [message];
  });
  const anchor = rect && candidates.find(block => { const bounds = block.getBoundingClientRect(); return bounds.bottom > rect.top && bounds.top < rect.bottom; });
  return { bottom: mainView === 'chat' && following && nearBottom(), top: box.scrollTop, anchor, offset: anchor ? anchor.getBoundingClientRect().top - rect.top : 0 };
}
function layoutVisibility(id, visible, toggleId) {
  const panel = $(id);
  if (!visible && panel.contains(document.activeElement)) $(toggleId).focus({ preventScroll: true });
  panel.hidden = !visible; panel.inert = !visible; panel.setAttribute('aria-hidden', String(!visible));
}
function renderLayout(preserveReading = true) {
  const reading = preserveReading ? readingPosition() : null, revision = ++layoutRevision, scrollVersion = scrollRevision;
  const visible = visibleLayout(), body = $('app-layout');
  body.classList.toggle('desktop-layout', layoutMode === 'desktop');
  body.classList.toggle('left-collapsed', !visible.left); body.classList.toggle('right-collapsed', !visible.right);
  body.classList.toggle('header-collapsed', !visible.header);
  body.classList.toggle('reading-focused', layoutPreferences[layoutMode].focused);
  layoutVisibility('sidebar', visible.left, 'open-sidebar');
  layoutVisibility('sources-panel', visible.right, 'toggle-right-panel');
  layoutVisibility('conversation-controls', visible.header, 'toggle-header');
  $('sidebar').classList.toggle('open', visible.left); $('sources-panel').classList.toggle('open', visible.right);
  $('backdrop').hidden = layoutMode === 'desktop' || !visible.left && !visible.right;
  for (const [id, open, shown, hidden] of [
    ['open-sidebar', visible.left, '收合對話欄', '展開對話欄'],
    ['toggle-right-panel', visible.right, '收合側面板', '展開側面板'],
    ['toggle-header', visible.header, '收合對話工具', '展開對話工具'],
  ]) { $(id).setAttribute('aria-expanded', String(open)); $(id).setAttribute('aria-label', open ? shown : hidden); $(id).title = open ? shown : hidden; }
  $('open-transcript').setAttribute('aria-expanded', String(mainView === 'transcript'));
  $('source-toggle').setAttribute('aria-expanded', String(visible.right && panelView === 'sources'));
  const focused = layoutPreferences[layoutMode].focused;
  $('toggle-focus').setAttribute('aria-pressed', String(focused)); $('toggle-focus').setAttribute('aria-label', focused ? '退出專注閱讀，恢復先前版面' : '專注閱讀：收起左右欄與上方工具');
  $('toggle-focus').title = focused ? '恢復先前版面' : '專注閱讀'; $('focus-label').textContent = focused ? '恢復' : '專注';
  function restoreReading() {
    if (revision !== layoutRevision || scrollVersion !== scrollRevision) return;
    const box = $('chat-scroll');
    if (reading.bottom) box.scrollTop = box.scrollHeight;
    else if (reading.anchor?.isConnected) box.scrollTop += reading.anchor.getBoundingClientRect().top - box.getBoundingClientRect().top - reading.offset;
    else box.scrollTop = reading.top;
    lastScrollTop = box.scrollTop;
    // Track paragraph reflow throughout the width transition. A newer wheel,
    // touch or keyboard event cancels this immediately via scrollRevision.
    if (body.getAnimations?.().some(animation => animation.transitionProperty === 'grid-template-columns' && ['running', 'pending'].includes(animation.playState))) requestAnimationFrame(restoreReading);
  }
  if (reading) requestAnimationFrame(restoreReading);
}
function leaveFocusForManualLayout() {
  const preferences = layoutPreferences[layoutMode]; preferences.focused = false; preferences.restore = null;
}
function drawer(name, open) {
  const key = name === 'sidebar' ? 'left' : 'right';
  if (visibleLayout()[key] !== open) leaveFocusForManualLayout();
  if (layoutMode === 'desktop') layoutPreferences.desktop[key] = open;
  else { mobilePanels[key] = open; if (open) mobilePanels[key === 'left' ? 'right' : 'left'] = false; }
  saveLayoutPreferences(); renderLayout();
}
function closeDrawers() {
  if (layoutMode === 'desktop') return;
  mobilePanels = { left: false, right: false }; renderLayout();
}
function toggleHeader() { leaveFocusForManualLayout(); layoutPreferences[layoutMode].header = !layoutPreferences[layoutMode].header; saveLayoutPreferences(); renderLayout(); }
function toggleFocus() {
  const preferences = layoutPreferences[layoutMode];
  if (preferences.focused && preferences.restore) {
    const previous = preferences.restore;
    preferences.header = previous.header;
    if (layoutMode === 'desktop') { preferences.left = previous.left; preferences.right = previous.right; }
    else mobilePanels = { left: previous.left, right: previous.right };
    preferences.focused = false; preferences.restore = null;
  } else {
    preferences.restore = visibleLayout(); preferences.focused = true; preferences.header = false;
    if (layoutMode === 'desktop') { preferences.left = false; preferences.right = false; }
    else mobilePanels = { left: false, right: false };
  }
  saveLayoutPreferences(); renderLayout();
}
function nearBottom() { const box = $('chat-scroll'); return box.scrollHeight - box.scrollTop - box.clientHeight <= 2; }
function showLatest() { $('jump-latest').hidden = mainView !== 'chat' || following || !state.messages.length; }
function pauseFollowing() { if (mainView !== 'chat') { scrollRevision++; return; } following = false; scrollRevision++; showLatest(); }
function scrollDown(force = false) {
  if (mainView !== 'chat') return;
  if (force) { following = true; scrollRevision++; }
  const version = scrollRevision;
  if (following) requestAnimationFrame(() => {
    if (!following || version !== scrollRevision) return;
    const box = $('chat-scroll'); box.scrollTop = box.scrollHeight; lastScrollTop = box.scrollTop; showLatest();
  });
  showLatest();
}
function renderConversation() {
  const top = $('chat-scroll').scrollTop;
  renderMessages(); renderWelcome();
  if (mainView !== 'chat') return;
  if (!following) $('chat-scroll').scrollTop = top;
  scrollDown();
}
$('jump-latest').onclick = () => scrollDown(true);
$('chat-scroll').addEventListener('wheel', event => { if (event.deltaY < 0) pauseFollowing(); }, { passive: true });
$('chat-scroll').addEventListener('touchstart', event => { touchY = event.touches[0]?.clientY; pauseFollowing(); }, { passive: true });
$('chat-scroll').addEventListener('touchmove', event => {
  const y = event.touches[0]?.clientY;
  if (y > touchY) pauseFollowing(); touchY = y;
}, { passive: true });
$('chat-scroll').addEventListener('pointerdown', () => pauseFollowing());
$('chat-scroll').addEventListener('keydown', event => {
  if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || event.key === ' ' && event.shiftKey) pauseFollowing();
});
$('chat-scroll').addEventListener('scroll', () => {
  if (mainView !== 'chat') return;
  const top = $('chat-scroll').scrollTop;
  if (top < lastScrollTop && !nearBottom()) pauseFollowing();
  else if (top > lastScrollTop && nearBottom()) following = true;
  lastScrollTop = top; showLatest();
}, { passive: true });
function resizeInput() { $('prompt').style.height = 'auto'; $('prompt').style.height = `${Math.min($('prompt').scrollHeight, innerWidth < 768 ? 140 : 180)}px`; controls(); }
function saveDraft() { try { sessionStorage.setItem(draftKey, $('prompt').value); } catch {} }
function restoreToScope(scope, text, append = false) {
  if (draftKey === scope) { $('prompt').value = mergeRestoredDraft($('prompt').value, text, append); resizeInput(); saveDraft(); return; }
  try { sessionStorage.setItem(scope, mergeRestoredDraft(sessionStorage.getItem(scope) || '', text, append)); } catch {}
}
function transferDraft(from, to) {
  if (from === to) return;
  const images = draftImages(from), pending = imageUploads.get(imageScope(from));
  writeImages(to, [...draftImages(to), ...images]); writeImages(from, []);
  if (pending) { imageUploads.set(imageScope(to), pending); imageUploads.delete(imageScope(from)); }
  if (pending?.count) imageAliases.set(from, to); renderAttachments();
  try {
    const text = sessionStorage.getItem(from) || '';
    if (text) { restoreToScope(to, text); sessionStorage.removeItem(from); }
  } catch {}
}
function restoreDraft(snapshot) {
  const key = draftScope(snapshot); if (draftKey === key) return;
  if (draftKey) saveDraft(); draftKey = key;
  try { $('prompt').value = sessionStorage.getItem(key) || ''; } catch { $('prompt').value = ''; }
  renderAttachments(); resizeInput();
}
function apply(next) {
  if (!isCurrent(state, next)) return false;
  const workspaceChanged = state.workspaceId !== next.workspaceId;
  const switched = state.sessionId !== next.sessionId || workspaceChanged;
  const modelChanged = state.model !== next.model;
  const serverChanged = state.serverId !== next.serverId;
  const thinkingChanged = state.thinkingLevel !== next.thinkingLevel;
  state = next;
  if (modelChanged || serverChanged) { usageRequest = null; $('usage-context').textContent = '模型或連線已變更，請更新上下文估計。'; }
  if (switched) { mainView = 'chat'; $('conversation-pane').hidden = false; $('transcript-pane').hidden = true; $('chat-scroll').setAttribute('aria-label', '對話內容'); $('open-transcript').setAttribute('aria-expanded', 'false'); transcriptTop = 0; usageRequest = null; $('usage-context').textContent = '尚未取得估計值。'; following = true; scrollRevision++; }
  if (workspaceChanged) $('session-search').value = '';
  if (switched) revealSelectedSession = true;
  if (switched) {
    $('queue-actions').open = false; $('queue-panel').open = false; $('queue-status').hidden = true;
    for (const id of ['note-dialog', 'source-dialog', 'model-dialog', 'help-dialog', 'session-dialog', 'tools-dialog', 'thinking-dialog', 'compact-dialog', 'fork-dialog', 'copy-dialog', 'export-dialog', 'agent-dialog']) $(id).close();
    modelRequest = null; commandDismissed = false;
    controlRequest = null; agentRequest = null;
  }
  if (modelChanged && $('model-dialog').open) { $('model-dialog').close(); modelRequest = null; }
  if ((modelChanged || thinkingChanged) && $('thinking-dialog').open) $('thinking-dialog').close();
  restoreDraft(state);
  $('session-title').textContent = state.sessions.find(s => s.id === state.sessionId)?.title || '新對話';
  $('compact-session-title').textContent = $('session-title').textContent;
  $('compact-session-title').title = $('session-title').textContent;
  $('mode-caption').textContent = `${state.readOnly ? '本機紀錄 · ' : ''}${(state.mode || 'general').toUpperCase()}`;
  $('model-label').textContent = state.model || (state.readOnly ? '閱讀紀錄時不會啟動模型' : '使用目前 Pi 模型設定');
  $('model-button-label').textContent = state.model || '目前設定';
  $('thinking-label').textContent = thinkingLabels[state.thinkingLevel] || state.thinkingLevel || '目前設定';
  const parentId = sessionParent(state), session = state.sessions.find(s => s.id === state.sessionId);
  $('parent-navigation').hidden = !parentId;
  $('parent-caption').textContent = session?.kind === 'side' || state.sideChat ? 'Side Chat · 獨立對話' : '分支對話';
  $('composer-hint').textContent = state.readOnly ? '本機紀錄 · 請先接續對話' : hints[state.mode];
  $('prompt').placeholder = state.readOnly ? '先接續對話，才能繼續傳送訊息。' : '輸入訊息，或 / 查看指令…';
  $('composer').classList.toggle('readonly', !!state.readOnly);
  $('choose-note').hidden = state.mode !== 'study';
  const current = state.context?.current;
  $('note-label').textContent = current ? current.split('/').at(-1).replace(/\.md$/, '') : '選擇筆記';
  $('notice').textContent = state.notice || ''; $('notice').hidden = !state.notice;
  setError(state.error);
  renderWorkspaces(); renderSessions(); renderRecycle(); renderReadOnly(); renderConversation(); renderSources(); renderActivity(); renderTranscript(); renderQuestion(); renderCommands(); renderQueue(); renderJobs(); controls();
  scrollDown();
  return true;
}
function renderWorkspaces() {
  const picker = $('workspace-select'), selected = selectedWorkspace(state);
  picker.replaceChildren();
  if (!(state.workspaces || []).length) picker.append(new Option(Array.isArray(state.workspaces) ? '尚未加入 Workspace' : '預設 Workspace', ''));
  const nameCounts = new Map();
  for (const workspace of state.workspaces || []) nameCounts.set(workspace.name, (nameCounts.get(workspace.name) || 0) + 1);
  for (const workspace of state.workspaces || []) {
    const duplicateName = nameCounts.get(workspace.name) > 1;
    const label = duplicateName ? `${workspace.name} — ${workspace.path}` : workspace.name;
    const count = Number.isInteger(workspace.sessionCount) ? ` · ${workspace.sessionCount} 個對話` : '';
    picker.append(new Option(`${label}${workspace.available === false ? '（目錄無法使用）' : ''}${count}`, workspace.id));
  }
  picker.value = state.workspaceId || '';
  $('workspace-path').textContent = selected?.path || (Array.isArray(state.workspaces) ? '加入或選擇一個工作目錄。' : '使用目前 Pi 的工作目錄');
  $('header-workspace-path').textContent = selected?.path || '';
  $('compact-session-title').title = [$('session-title').textContent, selected?.path].filter(Boolean).join(' · ');
  $('workspace-unavailable').hidden = selected?.available !== false;
  const warning = libraryScanWarning(state.libraryIssueCount);
  $('library-warning').textContent = warning; $('library-warning').hidden = !warning;
}
function renderReadOnly() {
  $('readonly-banner').hidden = !state.readOnly;
  $('archive-empty').hidden = !state.readOnly || !!state.messages.length;
  $('readonly-copy').textContent = state.canContinue ? '接續會建立新的 Web 對話，保留原本紀錄。' : selectedWorkspace(state)?.available === false ? '工作目錄目前不存在或無法使用，暫時不能接續。' : '目前無法接續這段對話，仍可閱讀原本紀錄。';
}
function renderSessions() {
  const list = $('session-list');
  const focused = [...list.querySelectorAll('button')].find(button => button === document.activeElement);
  const focusedId = focused?.dataset.sessionId, focusedAction = focused?.dataset.sessionAction;
  list.replaceChildren();
  const query = $('session-search').value, matches = workspaceSessions(state, query), total = workspaceSessions(state).length;
  $('session-count').textContent = query.trim() ? `${matches.length} / ${total}` : String(total);
  $('session-count').title = query.trim() ? '符合搜尋的對話數 / 目前 Workspace 對話總數' : '目前 Workspace 對話總數';
  const key = state.workspaceId || '', collapsed = collapsedSessions.get(key) || new Set();
  collapsedSessions.set(key, collapsed);
  if (revealSelectedSession) {
    const ancestors = workspaceSessionRows(state, { selectedId: state.sessionId });
    const parents = new Map(ancestors.map(row => [row.id, row.parentId]));
    const visited = new Set(); let parent = parents.get(state.sessionId);
    while (parent && !visited.has(parent)) { collapsed.delete(parent); visited.add(parent); parent = parents.get(parent); }
    revealSelectedSession = false;
  }
  const rows = workspaceSessionRows(state, { query, collapsed, selectedId: null });
  if (!rows.length) { list.append(el('p', 'session-empty', query.trim() ? '找不到符合的對話。' : '這個 Workspace 還沒有對話。可開始新對話，或重新整理本機紀錄。')); return; }
  for (const item of rows) {
    const session = item.session, title = session.title || '未命名對話';
    const row = el('div', `session-row${session.id === state.sessionId ? ' active' : ''}${query.trim() && !item.matchesSearch ? ' search-ancestor' : ''}`);
    row.dataset.sessionId = session.id; row.setAttribute('role', 'listitem'); row.style.paddingInlineStart = `${Math.min(item.depth, 4) * 12}px`;
    if (item.hasChildren) {
      const toggle = el('button', 'session-toggle', item.expanded ? '▾' : '▸'); toggle.type = 'button'; toggle.dataset.sessionId = session.id; toggle.dataset.sessionAction = 'toggle';
      toggle.setAttribute('aria-label', `${item.expanded ? '收合' : '展開'}「${title}」的子對話`); toggle.setAttribute('aria-expanded', String(item.expanded));
      const setExpanded = expanded => { if (expanded) collapsed.delete(session.id); else collapsed.add(session.id); renderSessions(); controls(); };
      toggle.onclick = () => setExpanded(!item.expanded);
      toggle.onkeydown = event => { if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); setExpanded(event.key === 'ArrowRight'); } };
      if (query.trim()) { toggle.disabled = true; toggle.title = '搜尋時會展開符合條件的上層對話'; }
      row.append(toggle);
    } else row.append(el('span', 'session-toggle-space'));
    const button = el('button', `session-item${session.id === state.sessionId ? ' active' : ''}`); button.type = 'button';
    button.dataset.sessionId = session.id; button.dataset.sessionAction = 'open'; button.title = title;
    button.setAttribute('aria-current', session.id === state.sessionId ? 'true' : 'false');
    button.setAttribute('aria-label', `${title}${item.depth ? `，第 ${item.depth + 1} 層對話` : ''}`);
    const date = new Date(session.updatedAt || session.createdAt), meta = el('span', 'session-meta');
    meta.append(el('span', `session-origin ${session.origin === 'local' ? 'local' : 'web'}`, session.origin === 'local' ? '本機' : 'Web'), el('time', '', Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-TW', { month: 'short', day: 'numeric' })));
    if (session.kind === 'side') meta.append(el('span', 'session-origin', 'Side Chat'));
    if (session.kind === 'fork') meta.append(el('span', 'session-origin', 'Fork'));
    if (session.busy || session.operation) meta.append(el('span', 'session-running', '進行中'));
    if (item.orphan) meta.append(el('span', 'session-orphan', '上層未列出'));
    button.append(el('strong', '', title), meta);
    button.disabled = !workspaceControls(state, { connected, working }).browse;
    button.onclick = () => action(async () => { if (apply(await api('open', { id: session.id }))) closeDrawers(); });
    const more = el('button', 'session-more', '⋯'); more.type = 'button'; more.dataset.sessionId = session.id; more.dataset.sessionAction = 'manage';
    more.setAttribute('aria-label', `「${title}」的對話操作`); more.setAttribute('aria-haspopup', 'dialog');
    more.disabled = !connected || sessionManagementPending; more.onclick = () => openSessionManagement(session);
    row.append(button, more); list.append(row);
  }
  if (focusedId) [...list.querySelectorAll('button')].find(button => button.dataset.sessionId === focusedId && button.dataset.sessionAction === focusedAction)?.focus({ preventScroll: true });
}
function renderMessages() {
  const container = $('messages');
  const existing = new Set(state.messages.map(m => m.id));
  for (const [id, node] of messageNodes) if (!existing.has(id)) { node.remove(); messageNodes.delete(id); }
  for (const message of state.messages) {
    let node = messageNodes.get(message.id);
    if (!node) {
      node = el('article', `message ${message.role}`); node.dataset.id = message.id;
      const label = el('div', 'message-label');
      if (message.role === 'assistant') label.append(el('span', 'mini-pi', 'π'));
      label.append(document.createTextNode(message.role === 'user' ? '你' : 'Pi'));
      const thinking = el('details', 'message-thinking');
      thinking.append(el('summary', '', '思考過程'), el('div', 'message-thinking-content'));
      if (message.role === 'assistant' && message.streaming) thinking.open = true;
      node.append(label, thinking, el('div', 'message-content'), el('div', 'message-images'), el('div', 'message-error'));
      messageNodes.set(message.id, node); container.append(node);
    }
    const imageKey = JSON.stringify(message.images || []);
    if (node._images !== imageKey) {
      node._images = imageKey; const media = node.querySelector('.message-images'); media.replaceChildren();
      for (const [index, image] of (message.images || []).entries()) media.append(image.unavailable ? el('span', 'small muted', '這張圖片無法預覽') : imageButton(image, index));
    }
    node.hidden = message.role === 'assistant' && !message.text && !message.thinking && !message.error && !message.streaming;
    const thinking = node.querySelector('.message-thinking');
    thinking.hidden = message.role !== 'assistant' || !message.thinking && (!message.streaming || !!message.text);
    if (!thinking.hidden) {
      const content = message.thinking || '模型尚未提供可顯示的思考文字；提供後會即時顯示。';
      if (node._thinking !== content) { thinking.querySelector('.message-thinking-content').textContent = content; node._thinking = content; }
      thinking.querySelector('summary').textContent = message.streaming ? '思考過程 · 即時' : '思考過程';
    }
    const displayText = message.text || (message.streaming && !message.thinking ? '正在生成回覆…' : '');
    if (node._displayText !== displayText) {
      node.querySelector('.message-content').innerHTML = markdown(displayText);
      node._displayText = displayText;
    }
    renderMermaidBlocks(node.querySelector('.message-content'), { streaming: !!message.streaming });
    node.querySelector('.message-error').textContent = message.error || '';
  }
}
function renderWelcome() {
  $('welcome').hidden = !!state.messages.length || state.readOnly;
  const [title, copy, starters] = welcomes[state.mode] || welcomes.general;
  $('welcome-title').textContent = title; $('welcome-copy').textContent = copy;
  $('starters').replaceChildren();
  starters.forEach(([title, text]) => {
    const button = el('button', '', title); button.append(el('span', '', text));
    button.onclick = () => { $('prompt').value = state.mode === 'study' && title === '檢查我的理解' ? '我對這個概念的理解是：' : ''; $('prompt').placeholder = text; $('prompt').focus(); resizeInput(); };
    $('starters').append(button);
  });
}
function renderActivity() {
  const activeTools = state.tools.filter(t => t.state === 'running');
  const operation = state.operation || (compactPending.has(draftScope(state)) ? 'compact' : null);
  $('activity').hidden = !state.busy && !operation;
  $('activity').textContent = operation ? (typeof operation === 'object' ? operation.label || '正在整理上下文…' : '正在整理上下文…') : state.dialogs.length ? '等待你的選擇' : activeTools.length ? activeTools.map(t => toolLabels[t.name] || t.name).join(' · ') : '生成中';
  $('trace-idle').hidden = !$('activity').hidden;
  $('open-transcript').title = `${$('activity').hidden ? 'Transcript · 執行紀錄' : $('activity').textContent} · 查看 Transcript 與 Token 用量`;
  $('compact-progress').hidden = !operation;
  $('cancel-compact').textContent = operation ? '關閉視窗' : '取消';
}
function renderSources() {
  $('source-count').textContent = state.sources.length; $('source-total').textContent = state.sources.length || '';
  const card = $('context-card'); card.replaceChildren(el('span', 'small muted', '目前筆記'));
  if (state.mode === 'general') card.append(el('p', '', '一般模式不會自動載入學習筆記。'));
  else if (state.context?.error) card.append(el('p', '', state.context.error));
  else if (state.context?.current) {
    card.append(el('p', '', state.context.current));
    card.append(el('small', '', `${state.context.status || '已讀取'}${state.context.truncated ? ' · 僅讀取片段' : ''}`));
  } else card.append(el('p', '', state.mode === 'general' ? '一般模式不會自動載入學習筆記。' : state.context?.omitted ? '目前筆記與研究問題無關，本輪未載入。' : state.status || '尚未指定筆記。'));
  if (state.question) card.append(el('small', '', `研究問題：${state.question}`));
  const list = $('source-list'); list.replaceChildren();
  if (!state.sources.length) list.append(el('p', 'empty-sources', '讀取筆記或網頁後，來源片段會出現在這裡。點開可核對原文與版本。'));
  for (const source of [...state.sources].reverse()) {
    const button = el('button', 'source-card');
    button.append(el('strong', '', source.title || source.path), el('small', '', `${source.kind === 'quote' ? '已交付引文' : '已交付片段'}${source.truncated ? ' · 部分內容' : ''}`), el('small', '', `版本 ${source.sha256.slice(0, 12)}`));
    button.onclick = () => openSource(source.id); list.append(button);
  }
}
async function openSource(id) {
  const scope = draftScope(state);
  try {
    const source = await api(`sources/${id}`);
    if (scope !== draftScope(state)) return;
    $('source-title').textContent = source.title;
    $('source-meta').textContent = `${source.path}\nSHA-256：${source.sha256}\n${source.startLine ? `行數：${source.startLine}${source.endLine ? `–${source.endLine}` : ''}\n` : ''}${source.truncated ? '部分內容；省略範圍未在這個片段中提供。' : '這是當時交付給 Pi 的內容。'}`;
    $('source-content').textContent = source.content;
    $('source-dialog').showModal();
  } catch (e) { if (scope === draftScope(state)) setError(e.message); }
}
function renderQuestion() {
  const current = state.dialogs[0];
  if (!current) { if ($('question-dialog').open) $('question-dialog').close(); shownDialog = null; return; }
  if (shownDialog?.id === current.id) return;
  shownDialog = current;
  $('question-title').textContent = current.title || 'Pi 需要你的選擇';
  $('question-message').textContent = current.message || '';
  const fields = $('question-fields'); fields.replaceChildren();
  if (current.method === 'select') {
    current.options.forEach((option, i) => {
      const label = el('label', 'question-option'); const input = el('input'); input.type = 'radio'; input.name = 'choice'; input.value = option; input.required = true;
      label.append(input, el('span', '', option)); fields.append(label);
    });
  } else if (['input', 'editor'].includes(current.method)) {
    const input = el(current.method === 'editor' ? 'textarea' : 'input'); input.name = 'answer'; input.setAttribute('aria-label', current.title || '回覆'); input.placeholder = current.placeholder || ''; input.value = current.prefill || ''; input.maxLength = 32000;
    fields.append(input);
  }
  $('question-submit').textContent = current.method === 'confirm' ? '確認' : '送出';
  if (!$('question-dialog').open) $('question-dialog').showModal();
}
async function answerQuestion(cancelled) {
  if (!shownDialog) return;
  const body = { sessionId: state.sessionId, id: shownDialog.id, cancelled };
  if (!cancelled) {
    if (shownDialog.method === 'confirm') body.confirmed = true;
    else if (shownDialog.method === 'select') body.value = new FormData($('question-form')).get('choice');
    else body.value = $('question-fields').querySelector('input,textarea').value;
  }
  try { await api('ui', body); } catch (e) { setError(e.message); }
}
async function searchNotes() {
  const scope = draftScope(state), sessionId = state.sessionId, requestRevision = ++noteSearchRevision;
  const current = () => requestRevision === noteSearchRevision && scope === draftScope(state) && $('note-dialog').open;
  $('note-results').textContent = '搜尋中…';
  try {
    const { notes } = await api('notes', { sessionId, query: $('note-query').value });
    if (!current()) return;
    $('note-results').replaceChildren();
    if (!notes.length) $('note-results').textContent = '找不到符合的筆記。試試篇名中的其他關鍵字。';
    notes.forEach(note => { const button = el('button', '', note.title); button.append(el('small', '', note.path)); button.onclick = () => selectNote(note.path); $('note-results').append(button); });
  } catch (e) { if (current()) $('note-results').textContent = e.message; }
}
async function selectNote(path) { await action(async () => { apply(await api('note', { sessionId: state.sessionId, path })); $('note-dialog').close(); }); }

function closeCommands() {
  $('command-menu').hidden = true;
  $('prompt').setAttribute('aria-expanded', 'false'); $('prompt').removeAttribute('aria-activedescendant');
}
function renderCommands() {
  if (commandDismissed || state.readOnly || document.activeElement !== $('prompt') || !$('prompt').value.startsWith('/') || $('prompt').value.includes('\n')) { closeCommands(); return; }
  const previousName = commandOptions[commandIndex]?.name;
  commandOptions = composerSuggestions(state.commands, $('prompt').value);
  commandIndex = Math.max(0, commandOptions.findIndex(command => command.name === previousName));
  const list = $('command-options'); list.replaceChildren();
  commandOptions.forEach((command, index) => {
    const button = el('button', 'command-option'); button.type = 'button'; button.id = `command-option-${index}`;
    button.setAttribute('role', 'option'); button.tabIndex = -1;
    button.append(el('strong', '', command.label), el('span', '', command.description || ''));
    button.onpointerdown = event => event.preventDefault();
    button.onclick = () => insertCommand(command.value);
    list.append(button);
  });
  $('command-menu').hidden = false; $('command-empty').hidden = !!commandOptions.length;
  const usage = commandUsage(state.commands, $('prompt').value); $('command-usage').textContent = usage; $('command-usage').hidden = !usage;
  $('prompt').setAttribute('aria-expanded', 'true'); updateCommandSelection();
}
function updateCommandSelection() {
  document.querySelectorAll('.command-option').forEach((button, index) => button.setAttribute('aria-selected', String(index === commandIndex)));
  if (commandOptions.length) $('prompt').setAttribute('aria-activedescendant', `command-option-${commandIndex}`);
  else $('prompt').removeAttribute('aria-activedescendant');
}
function insertCommand(name) {
  if (state.readOnly) return;
  const value = name.startsWith('/') ? name : `/${name}`;
  $('prompt').value = `${value} `;
  commandDismissed = !(state.commands || []).some(command => `/${command.name}` === value && command.suggestions?.length);
  closeCommands(); $('prompt').focus(); resizeInput(); saveDraft(); renderCommands();
}
function renderModels() {
  const list = $('model-results'); list.replaceChildren();
  const models = filterModels(modelRequest?.models, $('model-query').value);
  if (!models.length) list.append(el('p', 'choice-empty', modelRequest?.models.length ? '找不到符合的模型。試試其他名稱或供應商。' : '目前沒有可用模型，請先在 T14 的 Pi 設定模型帳號。'));
  for (const model of models) {
    const current = model.provider === modelRequest.current?.provider && model.id === modelRequest.current?.id;
    const button = el('button', `model-option${current ? ' current' : ''}`); button.type = 'button';
    button.setAttribute('aria-pressed', String(current));
    const title = el('span', 'choice-title'); title.append(el('strong', '', model.name || model.id));
    if (current) title.append(el('span', 'choice-badge', '目前'));
    button.append(title, el('small', '', `${model.provider} · ${model.id}${model.reasoning ? ' · 支援推理' : ''}`));
    button.onclick = () => selectModel(model); list.append(button);
  }
  controls();
}
function showCommandResponse(response, requested) {
  const next = response.state || (Number.isFinite(response.revision) ? response : null);
  const accepted = !next || apply(next);
  if (accepted && next && response.restoredPrompt) restoreToScope(draftScope(next), response.restoredPrompt);
  if (!response.command || !acceptsCommandResponse(state, requested, response)) return;
  const command = response.command;
  closeCommands();
  if (command.type === 'models') {
    modelRequest = { ...requested, models: command.models || [], current: command.current };
    $('model-query').value = ''; $('model-error').hidden = true; renderModels();
    $('model-dialog').showModal(); $('model-query').focus();
  } else if (command.type === 'help') {
    const list = $('help-results'); list.replaceChildren();
    for (const entry of command.commands || []) {
      const button = el('button', 'help-option'); button.type = 'button';
      button.append(el('strong', '', `/${entry.name}`), el('small', '', entry.description || ''));
      button.onclick = () => { $('help-dialog').close(); insertCommand(entry.name); }; list.append(button);
    }
    if (!list.childElementCount) list.append(el('p', 'choice-empty', '目前沒有可用指令。'));
    $('help-dialog').showModal();
  } else if (command.type === 'session') {
    const list = $('session-info'); list.replaceChildren();
    for (const [label, value] of sessionInfoRows(command.info)) {
      list.append(el('dt', '', label), el('dd', '', value));
    }
    $('session-dialog').showModal();
  } else showAgentCommand(command, requested);
}
async function selectModel(model) {
  if (!modelRequest || modelDisabledReason(state, { connected, working })) return;
  const requested = modelRequest;
  if (!acceptsCommandResponse(state, requested, {})) return;
  $('model-error').hidden = true;
  await action(async () => {
    try {
      const response = await api('model', { sessionId: requested.sessionId, provider: model.provider, modelId: model.id });
      const current = acceptsCommandResponse(state, requested, {});
      if (response.state) apply(response.state);
      if (current && acceptsCommandResponse(state, requested, {})) $('model-dialog').close();
    } catch (e) {
      if (acceptsCommandResponse(state, requested, {}) && $('model-dialog').open) { $('model-error').textContent = e.message; $('model-error').hidden = false; }
      throw e;
    }
  });
}
$('choose-model').onclick = () => {
  if (modelDisabledReason(state, { connected, working })) return;
  const workspaceId = state.workspaceId, scope = draftScope(state); let sessionId = state.sessionId;
  action(async () => {
    if (!sessionId) {
      const created = await api('sessions', { workspaceId });
      if (!acceptsCreatedSession(state, created, workspaceId)) throw Error('目前對話已切換，這次模型操作已取消。');
      apply(created); transferDraft(scope, draftScope(created)); sessionId = created.sessionId;
    }
    const requested = { workspaceId, sessionId, startedAt: state.startedAt, model: state.model };
    showCommandResponse(await api('prompt', { sessionId, message: '/model' }), requested);
  });
};
$('model-query').oninput = renderModels;
$('close-models').onclick = () => $('model-dialog').close();
$('close-help').onclick = () => $('help-dialog').close();
$('close-session-info').onclick = () => $('session-dialog').close();
$('open-sidebar').onclick = () => drawer('sidebar', !visibleLayout().left);
$('toggle-right-panel').onclick = () => drawer('sources-panel', !visibleLayout().right);
$('toggle-header').onclick = toggleHeader;
$('toggle-focus').onclick = toggleFocus;
$('close-sidebar').onclick = () => drawer('sidebar', false);
$('source-toggle').onclick = () => drawer('sources-panel', !$('sources-panel').classList.contains('open'));
$('close-sources').onclick = () => drawer('sources-panel', false);
$('backdrop').onclick = closeDrawers;
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeDrawers(); });
$('new-session').onclick = () => action(async () => { if (apply(await api('sessions', { workspaceId: state.workspaceId }))) closeDrawers(); });
$('workspace-select').onchange = () => {
  const workspaceId = $('workspace-select').value;
  $('workspace-select').value = state.workspaceId || '';
  action(async () => { apply(await api('workspace', { workspaceId })); });
};
$('session-search').oninput = renderSessions;
$('refresh-sessions').onclick = () => action(async () => { apply(await api('refresh', {})); });
$('add-workspace').onclick = () => { $('workspace-error').hidden = true; $('workspace-input').value = ''; $('workspace-dialog').showModal(); $('workspace-input').focus(); };
$('close-workspace').onclick = $('cancel-workspace').onclick = () => $('workspace-dialog').close();
$('workspace-form').onsubmit = event => {
  event.preventDefault(); const path = $('workspace-input').value.trim(); if (!path) return;
  $('workspace-error').hidden = true;
  action(async () => {
    try { apply(await api('workspaces', { path })); $('workspace-dialog').close(); }
    catch (e) { $('workspace-error').textContent = e.message; $('workspace-error').hidden = false; throw e; }
  });
};
$('continue-session').onclick = () => {
  if (!workspaceControls(state, { connected, working }).continue) return;
  action(async () => { if (apply(await api('continue', { sessionId: state.sessionId }))) closeDrawers(); });
};
document.querySelectorAll('[data-mode]').forEach(button => button.onclick = () => {
  if (!workspaceControls(state, { connected, working }).mode) return;
  const workspaceId = state.workspaceId, scope = draftScope(state); let sessionId = state.sessionId;
  action(async () => {
    if (!sessionId) {
      const created = await api('sessions', { workspaceId });
      if (!acceptsCreatedSession(state, created, workspaceId)) throw Error('目前對話已切換，這次模式操作已取消。');
      apply(created); transferDraft(scope, draftScope(created)); sessionId = created.sessionId;
    }
    apply(await api('mode', { sessionId, mode: button.dataset.mode }));
  });
});
$('choose-note').onclick = () => { $('note-dialog').showModal(); searchNotes(); };
$('close-notes').onclick = () => $('note-dialog').close();
$('close-source').onclick = () => $('source-dialog').close();
$('note-search').onsubmit = event => { event.preventDefault(); searchNotes(); };
$('follow-note').onclick = () => selectNote('auto');
$('question-form').onsubmit = event => { event.preventDefault(); answerQuestion(false); };
$('question-cancel').onclick = () => answerQuestion(true);
$('question-dialog').addEventListener('cancel', event => { event.preventDefault(); answerQuestion(true); });
$('prompt').oninput = () => { commandDismissed = false; resizeInput(); saveDraft(); renderCommands(); };
$('prompt').onfocus = renderCommands;
$('prompt').onblur = closeCommands;
$('prompt').onkeydown = event => {
  if (event.isComposing) return;
  if (!$('command-menu').hidden) {
    if (event.key === 'Escape') { event.preventDefault(); commandDismissed = true; closeCommands(); return; }
    if (commandOptions.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault(); commandIndex = moveCommandSelection(commandIndex, event.key === 'ArrowDown' ? 1 : -1, commandOptions.length);
      updateCommandSelection(); $(`command-option-${commandIndex}`).scrollIntoView({ block: 'nearest' }); return;
    }
    if (commandOptions.length && !event.shiftKey && ['Tab', 'Enter'].includes(event.key)) { event.preventDefault(); insertCommand(commandOptions[commandIndex].value); return; }
  }
  if (event.key === 'Enter' && !event.shiftKey && innerWidth >= 768) { event.preventDefault(); if (state.busy) enqueue('follow_up'); else $('composer').requestSubmit(); }
};
$('composer').onsubmit = async event => {
  event.preventDefault(); if (!workspaceControls(state, { connected, working }).send || promptPending.has(draftScope(state))) return;
  const message = $('prompt').value.trim(), images = [...draftImages()]; if ((!message && !images.length) || message.length > 32000 || uploadingImages() || imageLimitExceeded()) return;
  if (images.length && message.startsWith('/')) { setError('圖片請搭配一般訊息送出；Slash 指令不會接收圖片。'); return; }
  const workspaceId = state.workspaceId; let sessionId = state.sessionId, restoreScope = draftScope(state);
  const initialScope = restoreScope; promptPending.add(initialScope); writeImages(initialScope, []);
  $('prompt').value = ''; closeCommands(); resizeInput(); saveDraft();
  setError('');
  try {
      if (!sessionId) {
        const created = await api('sessions', { workspaceId });
        if (!acceptsCreatedSession(state, created, workspaceId)) throw Error('目前對話已切換，訊息未送出；草稿已保留在原 Workspace。');
        apply(created); transferDraft(restoreScope, draftScope(created)); sessionId = created.sessionId; restoreScope = draftScope(created); promptPending.add(restoreScope);
      }
      const requested = { workspaceId, sessionId, startedAt: state.startedAt, model: state.model };
      showCommandResponse(await api('prompt', { sessionId, workspaceId, message, ...(images.length ? { imageIds: images.map(image => image.id) } : {}) }), requested);
  } catch (e) {
      restoreToScope(restoreScope, message); writeImages(restoreScope, [...images, ...draftImages(restoreScope)]);
      setError(restoreScope !== draftScope(state) ? `先前對話未送出訊息，草稿已保留在原 Workspace。${e.message}` : e.message);
  } finally { promptPending.delete(initialScope); promptPending.delete(restoreScope); controls(); }
};
$('stop').onclick = async () => {
  if (stopPending) return;
  const sessionId = state.sessionId, scope = draftScope(state);
  stopPending = true;
  $('stop').disabled = true;
  try { const data = await api('stop', { sessionId }); if (data.restored) restoreToScope(scope, data.restored, true); if (data.restoredImages?.length) writeImages(scope, [...draftImages(scope), ...data.restoredImages]); }
  catch (e) { setError(scope === draftScope(state) ? e.message : `先前對話停止失敗：${e.message}`); } finally { stopPending = false; controls(); }
};
function capture() { return { sessionId: state.sessionId, workspaceId: state.workspaceId, startedAt: state.startedAt, model: state.model }; }
function scopedBody(requested, values = {}) { return { sessionId: requested.sessionId, workspaceId: requested.workspaceId, ...values }; }
function isRequested(requested) { return !!requested && acceptsCommandResponse(state, requested, {}); }
function runControl(path, values = {}, { create = false, requested = capture() } = {}) {
  return action(async () => {
    if (!requested.sessionId && create) {
      const scope = draftScope(requested), created = await api('sessions', { workspaceId: requested.workspaceId });
      if (!acceptsCreatedSession(state, created, requested.workspaceId)) throw Error('目前對話已切換，這次操作已取消。');
      apply(created); transferDraft(scope, draftScope(created)); requested = capture();
    }
    if (!isRequested(requested)) throw Error('目前對話已切換，請在要操作的對話重新開啟。');
    $('tools-dialog').close();
    showCommandResponse(await api(path, scopedBody(requested, values)), requested);
  });
}
function showPanel(name) {
  panelView = name;
  $('source-pane').hidden = name !== 'sources'; $('agent-pane').hidden = name !== 'agents';
  $('panel-tab-sources').setAttribute('aria-pressed', String(name === 'sources'));
  $('panel-tab-agents').setAttribute('aria-pressed', String(name === 'agents'));
  $('side-panel-title').textContent = name === 'agents' ? 'Sub Agent' : '來源與筆記';
  drawer('sources-panel', true);
}
function openCompact(customInstructions = '', requested = capture()) {
  if (!isRequested(requested)) return;
  controlRequest = requested;
  $('compact-focus').value = customInstructions;
  $('compact-error').hidden = true;
  const lastResult = compactResults.get(draftScope(requested));
  $('compact-result').hidden = !lastResult;
  if (lastResult) showCompactionResult(lastResult);
  $('compact-dialog').showModal(); renderActivity(); controls();
}
function showCompactionResult(result) {
  $('compact-result').hidden = false;
  $('compact-metrics').textContent = `壓縮前 ${metric(result.tokensBefore)} tokens · 壓縮後估計 ${metric(result.estimatedTokensAfter)} tokens`;
  $('compact-summary').innerHTML = markdown(typeof result.summary === 'string' ? result.summary : '摘要未提供。');
}
function showAgentCommand(command, requested) {
  controlRequest = requested;
  if (command.type === 'thinking') {
    const list = $('thinking-options'); list.replaceChildren(); $('thinking-error').hidden = true;
    for (const level of command.levels || []) {
      const button = el('button', '', `${thinkingLabels[level] || level}${level === command.current ? ' · 目前' : ''}`);
      button.type = 'button'; button.dataset.level = level; button.setAttribute('aria-pressed', String(level === command.current));
      button.onclick = () => chooseThinking(level, requested); list.append(button);
    }
    if (!list.childElementCount) list.append(el('p', 'choice-empty', '這個模型沒有可調整的思考強度。'));
    $('thinking-dialog').showModal(); controls();
  } else if (command.type === 'compact') openCompact(command.customInstructions || '', requested);
  else if (command.type === 'compaction') {
    compactResults.set(draftScope(requested), command.result || {}); showCompactionResult(command.result || {}); $('compact-dialog').showModal();
  } else if (command.type === 'forks') {
    const list = $('fork-options'); list.replaceChildren(); $('fork-error').hidden = true;
    for (const [index, message] of (command.messages || []).entries()) {
      const button = el('button', 'fork-option'); button.type = 'button';
      button.append(el('strong', '', `訊息 ${index + 1}`), el('small', '', String(message.text || '').slice(0, 1600)));
      button.onclick = () => runControl('fork', { entryId: message.entryId }, { requested }); list.append(button);
    }
    if (!list.childElementCount) list.append(el('p', 'choice-empty', '目前沒有可建立分支的訊息。'));
    $('fork-dialog').showModal(); controls();
  } else if (command.type === 'copy') {
    $('copy-content').value = typeof command.text === 'string' ? command.text : '';
    $('copy-status').textContent = command.text ? '按下複製，或直接選取文字。' : '目前沒有可複製的模型回覆。';
    $('copy-text').disabled = !command.text; $('copy-dialog').showModal();
  } else if (command.type === 'export') {
    if (typeof command.html !== 'string') throw Error('尚未取得可下載的對話。');
    if (exportURL) URL.revokeObjectURL(exportURL);
    exportURL = URL.createObjectURL(new Blob([command.html], { type: 'text/html;charset=utf-8' }));
    $('download-export').href = exportURL;
    $('download-export').download = String(command.filename || 'pi-session.html').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 180);
    $('export-dialog').showModal();
  } else if (command.type === 'agents') showPanel('agents');
  else if (command.type === 'queue') { $('queue-panel').hidden = false; $('queue-panel').open = true; }
}
async function chooseThinking(level, requested) {
  if (!isRequested(requested) || !agentControls(state, { connected, working }).change) return;
  await action(async () => {
    try {
      const response = await api('thinking', scopedBody(requested, { level })); showCommandResponse(response, requested);
      if (isRequested(requested)) $('thinking-dialog').close();
    } catch (e) {
      if (isRequested(requested)) { $('thinking-error').textContent = e.message; $('thinking-error').hidden = false; }
      throw e;
    }
  });
}
async function compact(event) {
  event.preventDefault();
  const requested = controlRequest, scope = requested && draftScope(requested);
  if (!isRequested(requested) || compactPending.has(scope) || !agentControls(state, { connected, working }).change) return;
  const customInstructions = $('compact-focus').value.trim();
  compactPending.add(scope); $('compact-result').hidden = true; $('compact-error').hidden = true; renderActivity(); controls();
  try {
    const response = await api('compact', scopedBody(requested, { customInstructions }));
    if (response.command?.type === 'compaction') compactResults.set(scope, response.command.result || {});
    showCommandResponse(response, requested);
  } catch (e) {
    if (isRequested(requested)) { $('compact-error').textContent = e.message; $('compact-error').hidden = false; }
    else setError(`先前對話的壓縮操作未完成：${e.message}`);
  } finally { compactPending.delete(scope); renderActivity(); controls(); }
}
function renderQueue() {
  const steering = state.queue?.steering || [], following = state.queue?.followUp || [];
  const count = steering.length + following.length;
  if (count) $('queue-status').hidden = true;
  $('queue-panel').hidden = !count && $('queue-status').hidden;
  if ($('queue-panel').hidden) $('queue-panel').open = false; $('queue-count').textContent = String(count);
  const list = $('queue-list'); list.replaceChildren();
  for (const [label, items, key] of [['立即補充', steering, 'steering'], ['下一輪', following, 'followUp']]) {
    for (const [index, item] of items.entries()) {
      const row = el('div', 'queue-item'); row.append(el('strong', '', label), el('p', '', typeof item === 'string' ? item : item.text || item.message || ''));
      const images = state.queuedImages?.[key]?.[index] || [];
      if (images.length) row.append(el('span', 'small muted', `${images.length} 張圖片`));
      list.append(row);
    }
  }
  if (!count) list.append(el('p', 'small muted', '目前沒有待送內容。'));
}
async function enqueue(kind) {
  $('queue-actions').open = false;
  const requested = capture(), scope = draftScope(requested), message = $('prompt').value.trim(), images = [...draftImages()];
  if (!agentControls(state, { connected, working, queuePending }).queue || (!message && !images.length) || message.length > 32000 || uploadingImages() || imageLimitExceeded()) return;
  if (message.startsWith('/')) { setError('指令請等目前回覆完成後送出；佇列只接受補充訊息。'); return; }
  queuePending = true; writeImages(scope, []); $('prompt').value = ''; closeCommands(); resizeInput(); saveDraft(); controls();
  try { showCommandResponse(await api('queue', scopedBody(requested, { action: kind, message, ...(images.length ? { imageIds: images.map(image => image.id) } : {}) })), requested); }
  catch (e) { restoreToScope(scope, message); writeImages(scope, [...images, ...draftImages(scope)]); setError(isRequested(requested) ? e.message : `先前對話的補充未送出，草稿已保留。${e.message}`); }
  finally { queuePending = false; controls(); }
}
async function clearQueue() {
  const requested = capture();
  if (!agentControls(state, { connected, working, queuePending }).clearQueue) return;
  queuePending = true; controls();
  try {
    const response = await api('queue', scopedBody(requested, { action: 'clear' }));
    showCommandResponse(response, requested);
    const restored = [response.restored?.steering || [], response.restored?.followUp || []].flat().map(item => typeof item === 'string' ? item : item.text || item.message || '').filter(Boolean).join('\n\n');
    if (restored) restoreToScope(draftScope(requested), restored, true);
    if (response.restoredImages?.length) writeImages(draftScope(requested), [...draftImages(draftScope(requested)), ...response.restoredImages]);
    if (isRequested(requested)) { $('queue-status').textContent = restored ? '佇列已清空，待送內容已放回草稿。' : '待送內容已清空。'; $('queue-status').hidden = false; $('queue-panel').hidden = false; $('queue-panel').open = true; }
  } catch (e) { setError(isRequested(requested) ? e.message : `先前對話的佇列未清空：${e.message}`); }
  finally { queuePending = false; controls(); }
}
const jobStatus = { queued: '等待中', starting: '準備中', running: '執行中', completed: '已完成', succeeded: '已完成', failed: '失敗', cancelled: '已取消', cancelling: '取消中', interrupted: '已中斷' };
function renderJobs() {
  const jobs = workspaceJobs(state), list = $('agent-list'), ids = new Set(jobs.map(job => job.id));
  $('agent-count').textContent = String(jobs.filter(job => ['queued', 'starting', 'running', 'cancelling'].includes(job.status)).length);
  $('agent-workspace').textContent = selectedWorkspace(state)?.path || '';
  for (const [id, node] of jobNodes) if (!ids.has(id)) { node.remove(); jobNodes.delete(id); }
  const empty = list.querySelector('.job-empty'); if (empty) empty.remove();
  if (!jobs.length) list.append(el('p', 'job-empty small muted', '這個 Workspace 尚未建立 Sub Agent。'));
  for (const job of jobs) {
    let card = jobNodes.get(job.id);
    const serialized = JSON.stringify(job);
    if (card?._value === serialized) continue;
    const wasOpen = card?.querySelector('details')?.open || false;
    const focused = card && [card.querySelector('summary'), ...card.querySelectorAll('button')].find(node => node === document.activeElement);
    const focusKey = focused?.dataset.jobFocus;
    if (!card) { card = el('article', 'job-card'); card.dataset.id = job.id; jobNodes.set(job.id, card); list.append(card); }
    card._value = serialized; card.replaceChildren();
    const meta = el('div', 'job-meta'); meta.append(el('span', '', job.kind === 'code' ? '程式開發' : '閱讀與分析'), el('span', `job-status ${job.status}`, jobStatus[job.status] || '狀態未知'));
    card.append(meta, el('h3', '', job.task || '未命名任務'));
    if (job.progress) card.append(el('p', 'job-progress small muted', job.progress));
    const parent = state.sessions.find(session => session.id === job.parentSessionId);
    const parentButton = el('button', 'job-parent', `主對話：${parent?.title || '查看原對話'}`); parentButton.type = 'button';
    parentButton.dataset.jobFocus = 'parent';
    parentButton.onclick = () => { if (state.workspaceId === job.workspaceId) action(async () => { apply(await api('open', { id: job.parentSessionId, workspaceId: job.workspaceId })); }); };
    if (!job.parentSessionId) parentButton.disabled = true;
    card.append(parentButton);
    if (job.error) card.append(el('p', 'dialog-error', job.error));
    const details = el('details', 'job-details'); details.open = wasOpen;
    const summary = el('summary', '', job.result ? '檢查結果與變更' : '查看進度與任務背景'); summary.dataset.jobFocus = 'details'; details.append(summary);
    if (job.context) details.append(el('p', 'job-context', job.context));
    if (job.model) details.append(el('p', 'small muted', `模型：${typeof job.model === 'string' ? job.model : `${job.model.provider || ''}/${job.model.id || ''}`} · 思考：${job.thinkingLevel || '預設'}`));
    if (job.branch || job.worktree) {
      const review = el('dl', 'job-review');
      for (const [label, value] of [['分支', job.branch], ['Worktree', job.worktree], ['起始版本', job.sourceHead]]) if (value) review.append(el('dt', '', label), el('dd', '', value));
      details.append(review, el('p', 'small muted', '變更保留在此工作目錄，尚未合併。請檢查 diff 與測試結果。'));
    }
    const output = job.result || job.output;
    if (output) { const content = el('div', 'job-output message-content'); content.innerHTML = markdown(String(output)); details.append(content); }
    else details.append(el('p', 'small muted', '尚未收到進度文字。'));
    if (job.truncated) details.append(el('p', 'small muted', '此處只顯示部分輸出。'));
    card.append(details);
    const actions = el('div', 'job-actions');
    if (['queued', 'starting', 'running'].includes(job.status)) {
      const cancel = el('button', 'job-cancel', '取消任務'); cancel.type = 'button'; cancel.dataset.jobFocus = 'cancel'; cancel.onclick = () => cancelJob(job.id, job.workspaceId); actions.append(cancel);
    }
    if (job.result) {
      const use = el('button', 'job-use', '填入主對話草稿'); use.type = 'button';
      use.dataset.jobFocus = 'use';
      use.onclick = () => useJob(job); actions.append(use);
    }
    card.append(actions);
    if (focusKey) [summary, ...card.querySelectorAll('button')].find(node => node.dataset.jobFocus === focusKey)?.focus();
  }
}
function openAgent() {
  if (!agentControls(state, { connected, working, agentPending }).createAgent) return;
  agentRequest = capture(); $('agent-error').hidden = true;
  $('agent-parent').textContent = `主對話：${state.sessions.find(session => session.id === state.sessionId)?.title || '目前對話'}\nWorkspace：${selectedWorkspace(state)?.path || ''}`;
  $('agent-dialog').showModal(); $('agent-task').focus();
}
async function startAgent(event) {
  event.preventDefault(); const requested = agentRequest;
  if (!isRequested(requested) || !agentControls(state, { connected, working, agentPending }).createAgent) return;
  const task = $('agent-task').value.trim(), context = $('agent-context').value.trim(), kind = $('agent-kind').value;
  if (!task) return;
  agentPending = true; $('agent-error').hidden = true; controls();
  try {
    const response = await api('subagents', scopedBody(requested, { task, context, kind }));
    showCommandResponse(response, requested);
    if (isRequested(requested)) { $('agent-dialog').close(); $('agent-task').value = ''; $('agent-context').value = ''; showPanel('agents'); }
  } catch (e) { if (isRequested(requested)) { $('agent-error').textContent = e.message; $('agent-error').hidden = false; } else setError(`先前對話的 Sub Agent 未建立：${e.message}`); }
  finally { agentPending = false; controls(); }
}
async function cancelJob(id, workspaceId) {
  if (agentPending || !connected || workspaceId !== state.workspaceId) return;
  const requested = capture(); agentPending = true; controls();
  try { showCommandResponse(await api('subagents/cancel', scopedBody(requested, { id, workspaceId })), requested); }
  catch (e) { setError(e.message); } finally { agentPending = false; controls(); }
}
async function useJob(job) {
  if (job.workspaceId !== state.workspaceId || state.readOnly || !state.sessionId) return;
  const requested = capture();
  const insert = () => {
    const text = jobDraft(job, 32000 - $('prompt').value.length - 2);
    if (!text) { setError('目前草稿已接近 32,000 字元，請先縮短草稿，再帶入任務結果。'); return; }
    restoreToScope(draftScope(state), text, true); closeDrawers(); $('prompt').focus();
  };
  if (job.parentSessionId && job.parentSessionId !== state.sessionId) {
    await action(async () => {
      const response = await api('open', { id: job.parentSessionId, workspaceId: requested.workspaceId });
      if (!apply(response) || state.readOnly || state.workspaceId !== job.workspaceId) return;
      insert();
    });
  } else insert();
}
$('choose-thinking').onclick = () => runControl('thinking', {}, { create: true });
$('open-tools').onclick = () => { $('tools-dialog').showModal(); controls(); };
$('close-tools').onclick = () => $('tools-dialog').close();
for (const name of ['stats', 'thinking', 'fork', 'clone', 'export', 'copy']) $(`tool-${name}`).onclick = () => runControl(name);
$('tool-compact').onclick = () => { $('tools-dialog').close(); openCompact(); };
$('compact-form').onsubmit = compact;
$('cancel-compact').onclick = () => $('compact-dialog').close();
for (const name of ['thinking', 'compact', 'fork', 'copy', 'export', 'agent']) $(`close-${name}`).onclick = () => $(`${name}-dialog`).close();
$('copy-text').onclick = async () => {
  const requested = controlRequest, text = $('copy-content').value;
  if (!isRequested(requested)) return;
  try { await navigator.clipboard.writeText(text); if (isRequested(requested)) $('copy-status').textContent = '已複製。'; }
  catch { if (isRequested(requested)) { $('copy-content').focus(); $('copy-content').select(); $('copy-status').textContent = '瀏覽器未允許複製，請複製已選取的文字。'; } }
};
$('queue-steer').onclick = () => enqueue('steer'); $('queue-follow').onclick = () => enqueue('follow_up'); $('clear-queue').onclick = clearQueue;
$('open-agents').onclick = () => showPanel('agents');
$('panel-tab-agents').onclick = () => showPanel('agents'); $('panel-tab-sources').onclick = () => showPanel('sources');
$('source-toggle').onclick = () => { if (panelView === 'sources' && $('sources-panel').classList.contains('open')) drawer('sources-panel', false); else showPanel('sources'); };
$('new-agent').onclick = openAgent; $('agent-form').onsubmit = startAgent;
$('cancel-agent').onclick = () => $('agent-dialog').close();
$('agent-kind').onchange = () => { $('agent-kind-hint').textContent = $('agent-kind').value === 'code' ? '在獨立 Git 分支與 Worktree 開發，完成後由你檢查並決定是否合併。' : '閱讀與分析不修改專案檔案。'; };
$('start-side-chat').onclick = () => runControl('side-chat');
$('return-parent').onclick = () => {
  const id = sessionParent(state); if (id) action(async () => { apply(await api('open', { id, workspaceId: state.workspaceId })); });
};

function managementReason(action) {
  const target = sessionManagementTarget;
  if (!target) return '請先選擇要管理的對話。';
  if (state.startedAt !== target.startedAt) return '服務已重新連線，請重新開啟這段對話的操作。';
  if (state.workspaceId !== target.workspaceId) return '目前已切換 Workspace。請回到原 Workspace，再完成這項操作。';
  return sessionManagementReason(state, target.id, { connected, working: working || sessionManagementPending, action });
}
function sessionManagementControls() {
  const renameReason = managementReason('rename'), deleteReason = managementReason('delete');
  $('manage-rename').disabled = !!renameReason; $('manage-delete').disabled = !!deleteReason;
  $('save-session-rename').disabled = !!renameReason || !$('session-rename-input').value.trim();
  $('confirm-session-delete').disabled = !!deleteReason;
  $('session-rename-input').disabled = sessionManagementPending;
  for (const [id, reason] of [['manage-rename-reason', renameReason], ['session-rename-reason', renameReason], ['manage-delete-reason', deleteReason], ['session-delete-reason', deleteReason]]) {
    $(id).textContent = reason; $(id).hidden = !reason;
  }
  for (const button of document.querySelectorAll('.recycle-restore')) button.disabled = !connected || working || sessionManagementPending;
  $('open-recycle').disabled = !state.workspaceId;
}
function openSessionManagement(session) {
  if (sessionManagementPending) return;
  const current = state.sessions.find(item => item.id === session.id && item.workspaceId === state.workspaceId);
  if (!current) { setError('目前對話清單已更新，請重新選擇要操作的對話。'); return; }
  sessionManagementTarget = { id: current.id, workspaceId: current.workspaceId, title: current.title || '未命名對話', startedAt: state.startedAt };
  $('session-manage-name').textContent = sessionManagementTarget.title;
  $('session-manage-workspace').textContent = selectedWorkspace(state)?.path || '';
  $('session-manage-dialog').showModal(); sessionManagementControls();
}
function openRename() {
  if (managementReason('rename')) return;
  $('session-manage-dialog').close();
  $('session-rename-target').textContent = sessionManagementTarget.title;
  $('session-rename-input').value = sessionManagementTarget.title;
  $('session-rename-error').hidden = true;
  $('session-rename-dialog').showModal(); sessionManagementControls(); $('session-rename-input').focus(); $('session-rename-input').select();
}
function openDelete() {
  if (managementReason('delete')) return;
  $('session-manage-dialog').close();
  $('session-delete-target').textContent = sessionManagementTarget.title;
  $('session-delete-error').hidden = true;
  $('session-delete-dialog').showModal(); sessionManagementControls();
}
async function manageSession(action, values = {}) {
  const target = sessionManagementTarget;
  if (!target || sessionManagementPending) return;
  const reason = managementReason(action), error = $(`session-${action}-error`);
  if (reason) { error.textContent = reason; error.hidden = false; return; }
  sessionManagementPending = true; error.hidden = true; controls();
  try {
    const response = await api(`session/${action}`, { id: target.id, workspaceId: target.workspaceId, ...values });
    if (response.state) apply(response.state);
    if (sessionManagementTarget === target) $(`session-${action}-dialog`).close();
  } catch (e) {
    if (sessionManagementTarget === target) { error.textContent = e.message; error.hidden = false; }
    else setError(`「${target.title}」的操作未完成：${e.message}`);
  } finally { sessionManagementPending = false; controls(); }
}
function renderRecycle() {
  const sessions = workspaceDeletedSessions(state), list = $('recycle-list');
  const focusedId = [...list.querySelectorAll('button')].find(button => button === document.activeElement)?.dataset.sessionId;
  $('recycle-count').textContent = String(sessions.length);
  $('recycle-workspace').textContent = selectedWorkspace(state)?.path || '';
  list.replaceChildren();
  if (!sessions.length) list.append(el('p', 'recycle-empty small muted', '這個 Workspace 的回收清單是空的。'));
  for (const session of sessions) {
    const row = el('div', 'recycle-row'), content = el('div', 'recycle-content'), title = session.title || '未命名對話';
    content.append(el('strong', '', title));
    const date = new Date(session.deletedAt);
    const kind = session.kind === 'side' ? 'Side Chat' : session.kind === 'fork' ? 'Fork' : session.origin === 'local' ? '本機紀錄' : 'Web 對話';
    content.append(el('small', '', `${kind} · ${Number.isNaN(date.getTime()) ? '刪除時間未提供' : date.toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`));
    const restore = el('button', 'recycle-restore', '還原'); restore.type = 'button'; restore.dataset.sessionId = session.id;
    restore.setAttribute('aria-label', `還原「${title}」`);
    restore.disabled = !connected || working || sessionManagementPending;
    restore.onclick = () => restoreSession(session);
    row.append(content, restore); list.append(row);
  }
  if (focusedId && !sessionManagementPending) {
    const buttons = [...list.querySelectorAll('button')];
    (buttons.find(button => button.dataset.sessionId === focusedId) || buttons[0] || $('close-recycle')).focus({ preventScroll: true });
  }
}
async function restoreSession(session) {
  if (!connected || working || sessionManagementPending) return;
  const workspaceId = session.workspaceId;
  if (state.workspaceId !== workspaceId || !workspaceDeletedSessions(state).some(item => item.id === session.id)) {
    $('recycle-error').textContent = '回收清單已更新，請重新選擇要還原的對話。'; $('recycle-error').hidden = false; return;
  }
  const title = session.title || '未命名對話';
  const trigger = document.activeElement;
  const position = workspaceDeletedSessions(state).findIndex(item => item.id === session.id);
  let restored = false;
  sessionManagementPending = true; $('recycle-error').hidden = true; $('recycle-status').hidden = true; controls();
  try {
    const response = await api('session/restore', { id: session.id, workspaceId });
    if (response.state) apply(response.state);
    restored = true;
    if (state.workspaceId === workspaceId) { $('recycle-status').textContent = `「${title}」已還原。`; $('recycle-status').hidden = false; }
  } catch (e) {
    $('recycle-error').textContent = state.workspaceId === workspaceId ? e.message : `先前 Workspace 的「${title}」未還原：${e.message}`;
    $('recycle-error').hidden = false;
  } finally {
    sessionManagementPending = false; controls();
    if (restored && $('recycle-dialog').open && state.workspaceId === workspaceId &&
      (document.activeElement === trigger || document.activeElement === document.body || !document.activeElement)) {
      const buttons = [...$('recycle-list').querySelectorAll('button')];
      (buttons[Math.min(position, buttons.length - 1)] || $('close-recycle')).focus({ preventScroll: true });
    }
  }
}
$('manage-rename').onclick = openRename; $('manage-delete').onclick = openDelete;
$('session-rename-input').oninput = sessionManagementControls;
$('session-rename-form').onsubmit = event => {
  event.preventDefault(); const title = $('session-rename-input').value.trim();
  if (!title || title.length > 160 || /[\r\n\0]/.test(title)) {
    $('session-rename-error').textContent = '請輸入 1–160 個字元的單行名稱。'; $('session-rename-error').hidden = false; return;
  }
  manageSession('rename', { title });
};
$('confirm-session-delete').onclick = () => manageSession('delete');
for (const name of ['manage', 'rename', 'delete']) $(`close-session-${name}`).onclick = () => $(`session-${name}-dialog`).close();
$('cancel-session-rename').onclick = () => $('session-rename-dialog').close();
$('cancel-session-delete').onclick = () => $('session-delete-dialog').close();
$('open-recycle').onclick = () => { $('recycle-error').hidden = true; $('recycle-status').hidden = true; renderRecycle(); $('recycle-dialog').showModal(); sessionManagementControls(); };
$('close-recycle').onclick = () => $('recycle-dialog').close();
addEventListener('resize', () => {
  const nextMode = innerWidth >= 768 ? 'desktop' : 'mobile';
  if (nextMode !== layoutMode) { layoutMode = nextMode; mobilePanels = { left: false, right: false }; }
  renderLayout();
});

function usageText(usage) {
  if (!usage || usage.totalTokens == null) return 'Tokens 未提供';
  return `本次請求含快取 ${metric(usage.totalTokens)} tokens · 非快取輸入 ${metric(usage.input)} · 輸出 ${metric(usage.output)} · 快取讀取 ${metric(usage.cacheRead)} · 快取寫入 ${metric(usage.cacheWrite)}${usage.reasoning == null ? '' : ` · 推理 ${metric(usage.reasoning)}（已含在輸出）`}`;
}
function renderTranscript() {
  const trace = state.transcript || { entries: [], usage: {} }, usage = trace.usage || {};
  const turn = usage.currentTurn || {}, output = turn.totals?.output;
  $('token-summary').textContent = output == null ? '—' : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(output);
  $('token-summary').title = `本輪已回報輸出 ${metric(output)} tokens（含模型回報的推理 tokens）`;
  $('open-transcript').title = `檢視 Transcript · ${$('token-summary').title}`;
  $('open-transcript').setAttribute('aria-label', $('open-transcript').title);
  const totals = turn.totals || {};
  $('transcript-usage').textContent = `輸出：${metric(totals.output)} tokens${totals.reasoning == null ? '' : `（含推理 ${metric(totals.reasoning)}）`}\n非快取輸入：${metric(totals.input)}\n快取讀取：${metric(totals.cacheRead)} · 寫入：${metric(totals.cacheWrite)}\n最近送出訊息後，已回報 ${turn.reported || 0} / ${turn.requests || 0} 次模型回應。${state.busy ? '生成中的回應尚未結算。' : ''}`;
  $('transcript-history').textContent = `目前分支共 ${usage.requests || 0} 次模型回應，${usage.missing || 0} 次未提供用量。\n非快取輸入 ${metric(usage.totals?.input)} · 輸出 ${metric(usage.totals?.output)}\n快取讀取 ${metric(usage.totals?.cacheRead)} · 快取寫入 ${metric(usage.totals?.cacheWrite)}\n各次請求合計（包含反覆讀取快取）：${metric(usage.totals?.totalTokens)} tokens。\n不是單次上下文大小，也不是訂閱額度或實際帳單。${usage.cost == null ? '' : `\nPi 的 API 價目估算：US$ ${usage.cost.toFixed(6)}；不代表本帳號實際收費。`}\n最近一次模型回應：${usageText(usage.latest)}`;
  $('transcript-limit').textContent = `${trace.omitted ? `已省略較早的 ${trace.omitted} 筆執行紀錄。` : ''}長輸入／輸出保留頭尾，完整內容仍在原始 Pi Session。`;
  $('refresh-usage').disabled = !state.online || state.readOnly || !!usageRequest;
  const scope = `${state.serverId}/${state.workspaceId}/${state.sessionId}`;
  if (scope !== traceScope) { traceScope = scope; traceNodes.clear(); $('transcript-list').replaceChildren(); }
  const entries = trace.entries || [], ids = new Set(entries.map(entry => entry.id));
  for (const [id, node] of traceNodes) if (!ids.has(id)) { node.remove(); traceNodes.delete(id); }
  $('transcript-empty').hidden = !!entries.length;
  const status = { running: '執行中', pending: '等待執行', done: '完成', error: '失敗', aborted: '已停止', interrupted: '未完成' };
  for (const entry of entries) {
    let node = traceNodes.get(entry.id);
    if (!node) {
      node = el('details', 'trace-entry');
      node.append(el('summary', 'trace-summary'), el('div', 'trace-meta'), el('pre', 'trace-input'), el('pre', 'trace-output'), el('pre', 'trace-thinking'), el('p', 'trace-usage'));
      for (const pre of node.querySelectorAll('pre')) pre.setAttribute('tabindex', '0');
      traceNodes.set(entry.id, node); $('transcript-list').append(node);
    }
    const message = entry.messageId && state.messages.find(message => message.id === entry.messageId);
    const output = message?.text || entry.output || entry.text || '';
    const label = entry.kind === 'tool' ? `${toolLabels[entry.name] || entry.name} · ${entry.name}` : entry.kind === 'user' ? '你' : 'Pi';
    const summary = `${label} · ${status[entry.state] || entry.state || ''}`;
    const values = { '.trace-summary': summary, '.trace-meta': [entry.model, entry.startedAt && entry.finishedAt ? `${Math.max(0, entry.finishedAt - entry.startedAt)} ms` : '', entry.exitCode != null ? `退出代碼 ${entry.exitCode}` : ''].filter(Boolean).join(' · '),
      '.trace-input': entry.input ? `輸入\n${entry.input}` : '', '.trace-output': output || entry.error ? `${entry.kind === 'tool' ? '輸出\n' : ''}${output}${entry.error ? `\n${entry.error}` : ''}` : '',
      '.trace-thinking': entry.thinking ? `模型提供的思考文字\n${entry.thinking}` : '', '.trace-usage': entry.kind === 'assistant' ? usageText(entry.usage) : '' };
    for (const [selector, text] of Object.entries(values)) {
      const part = node.querySelector(selector);
      if (part.textContent !== text) part.textContent = text;
      part.hidden = !text;
    }
  }
}
function showTranscript(open = true) {
  const next = open ? 'transcript' : 'chat'; if (next === mainView) return;
  const box = $('chat-scroll');
  if (open) chatTop = box.scrollTop; else transcriptTop = box.scrollTop;
  mainView = next; const version = ++scrollRevision;
  $('conversation-pane').hidden = open; $('transcript-pane').hidden = !open;
  box.setAttribute('aria-label', open ? 'Transcript 執行紀錄' : '對話內容');
  $('open-transcript').setAttribute('aria-expanded', String(open)); showLatest();
  if (open) { renderTranscript(); refreshContextUsage(); }
  requestAnimationFrame(() => { if (version === scrollRevision && mainView === next) { box.scrollTop = open ? transcriptTop : chatTop; lastScrollTop = box.scrollTop; } });
}
async function refreshContextUsage() {
  if (!state.online || state.readOnly) { $('usage-context').textContent = '本機紀錄沒有執行中的上下文估計。'; return; }
  if (usageRequest) return;
  const requested = capture(), ticket = {}; usageRequest = ticket; $('refresh-usage').disabled = true;
  $('usage-context').textContent = '正在取得 Pi 的估計值…';
  try {
    const info = await api('usage', scopedBody(requested, {}));
    if (!isRequested(requested) || usageRequest !== ticket) return;
    $('usage-context').textContent = info.contextTokens == null ? `Pi 尚未提供估計值${info.contextWindow ? `，模型容量 ${metric(info.contextWindow)} tokens` : ''}。若剛完成壓縮，需等下一次模型回應才能重新估計。` : `${metric(info.contextTokens)} / ${metric(info.contextWindow)} tokens${info.contextPercent == null ? '' : `（${info.contextPercent.toFixed(1)}%）`}\nPi 在查看時提供的上下文估計；與歷史請求累計不同。`;
  } catch (error) { if (isRequested(requested) && usageRequest === ticket) $('usage-context').textContent = `暫時無法取得上下文估計：${error.message}`; }
  finally { if (usageRequest === ticket) { usageRequest = null; $('refresh-usage').disabled = !state.online || state.readOnly; } }
}
$('open-transcript').onclick = () => showTranscript(mainView !== 'transcript');
$('back-to-chat').onclick = () => showTranscript(false);
$('refresh-usage').onclick = refreshContextUsage;

for (const id of ['queue-actions', 'queue-panel']) {
  $(id).addEventListener('toggle', () => {
    if ($(id).open) $(id === 'queue-actions' ? 'queue-panel' : 'queue-actions').open = false;
    else if (id === 'queue-panel' && !(state.queue?.steering?.length || state.queue?.followUp?.length)) { $('queue-status').hidden = true; $(id).hidden = true; }
  });
}
document.addEventListener('click', event => {
  for (const id of ['queue-actions', 'queue-panel']) if (!$(id).contains(event.target)) $(id).open = false;
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') for (const id of ['queue-actions', 'queue-panel']) if ($(id).open) { $(id).open = false; $(id).querySelector('summary')?.focus(); }
});
const events = new EventSource('/api/events');
events.addEventListener('open', () => { connected = true; controls(); });
events.addEventListener('error', () => { connected = false; controls(); });
events.addEventListener('snapshot', event => { connected = true; apply(JSON.parse(event.data)); });
function acceptEvent(event) {
  const data = JSON.parse(event.data); if (!isCurrent(state, data)) return null;
  state.revision = data.revision; state.startedAt = data.startedAt; state.serverId = data.serverId; return data;
}
events.addEventListener('message', event => { const message = acceptEvent(event); if (!message) return; if (!state.messages.some(m => m.id === message.id)) state.messages.push(message); renderConversation(); renderTranscript(); });
function scheduleStreamingRender() {
  if (!renderQueued) { renderQueued = true; requestAnimationFrame(() => { renderQueued = false; renderConversation(); if (mainView === 'transcript') renderTranscript(); }); }
}
events.addEventListener('delta', event => {
  const data = acceptEvent(event); if (!data) return;
  const { id, delta } = data; const message = state.messages.find(m => m.id === id); if (!message) return;
  message.text += delta;
  scheduleStreamingRender();
});
events.addEventListener('thinking', event => {
  const data = acceptEvent(event); if (!data) return;
  const message = state.messages.find(m => m.id === data.id); if (!message) return;
  message.thinking = data.thinking;
  scheduleStreamingRender();
});
events.addEventListener('transcript', event => {
  const data = acceptEvent(event); if (!data?.entry) return;
  state.transcript ||= { entries: [], usage: {} };
  const entries = state.transcript.entries, index = entries.findIndex(entry => entry.id === data.entry.id);
  if (index < 0) entries.push(data.entry); else entries[index] = data.entry;
  if (Array.isArray(data.retainedIds)) state.transcript.entries = entries.filter(entry => data.retainedIds.includes(entry.id));
  while (state.transcript.entries.length > 160) state.transcript.entries.shift();
  state.transcript.omitted = data.omitted;
  if (mainView === 'transcript') renderTranscript();
});
events.addEventListener('editor', event => { const data = acceptEvent(event); if (!data) return; $('prompt').value = data.text; resizeInput(); saveDraft(); });
restoreDraft(state); renderWelcome(); controls(); renderLayout(false);
