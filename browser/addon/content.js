(() => {
  if (globalThis.__zenPiBridgeLoaded) return;
  globalThis.__zenPiBridgeLoaded = true;
  let observation = null;
  const clean = (value, size = 140) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, size);
  const visible = e => {
    if (e.checkVisibility && !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
      && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0' && !e.closest('[hidden],[inert]');
  };
  const labelText = e => {
    const copy = e.cloneNode(true);
    for (const control of copy.querySelectorAll('input,select,textarea,button')) control.remove();
    return copy.textContent;
  };
  const label = e => clean(e.getAttribute('aria-label') || e.getAttribute('aria-labelledby')?.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ')
    || (e.labels && [...e.labels].map(labelText).join(' ')) || e.innerText || e.getAttribute('placeholder') || e.getAttribute('title') || e.getAttribute('name'));
  const sensitive = e => e.matches('input[type=password],input[type=file],input[autocomplete*=cc-],input[autocomplete*=password],input[autocomplete=one-time-code]');
  function describe(e) {
    return { label: label(e), role: e.getAttribute('role') || e.tagName.toLowerCase(),
      value: sensitive(e) ? '[不可讀取]' : clean(e.value ?? (e.isContentEditable ? e.textContent : ''), 160),
      checked: 'checked' in e ? e.checked : null, disabled: !!e.disabled || e.getAttribute('aria-disabled') === 'true',
      href: e.tagName === 'A' ? e.href : null };
  }
  function excerpt() {
    const out = []; let count = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode() && count < 2000) {
      const n = walker.currentNode, p = n.parentElement;
      if (!p || p.closest('script,style,noscript,textarea,input,[contenteditable], [aria-hidden=true]') || !visible(p)) continue;
      const text = clean(n.textContent, 300); if (text) { out.push(text); count += text.length; }
    }
    return out.join(' ').slice(0, 2000);
  }
  function observe() {
    const id = crypto.randomUUID(), nodes = new Map(), actions = [];
    const selectors = 'a[href],button,input,textarea,select,[role=button],[role=link],[role=checkbox],[role=radio],[role=combobox],[contenteditable=true]';
    let clipped = false;
    for (const e of document.querySelectorAll(selectors)) {
      if (!visible(e) || sensitive(e) || e.disabled || e.readOnly || e.getAttribute('aria-disabled') === 'true' || e.matches('input[type=hidden]')) continue;
      const info = describe(e); if (!info.label) continue;
      if (actions.length >= 80) { clipped = true; break; }
      const ref = String(nodes.size + 1), entry = { e, guard: JSON.stringify(info) }; nodes.set(ref, entry);
      if (e.tagName === 'SELECT') {
        const options = [...e.options].filter(o => !o.disabled && !o.closest('optgroup[disabled]'));
        const remaining = Math.min(24, 80 - actions.length);
        if (options.length > remaining) clipped = true;
        for (const option of options.slice(0, remaining)) {
          actions.push({ id: `${ref}:select:${option.index}`, ref, kind: 'select', ...info, label: `${info.label} → ${clean(option.text)}`, option: option.index });
        }
      } else if (e.matches('textarea,input:not([type=button]):not([type=submit]):not([type=reset]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]),[contenteditable=true]')) {
        actions.push({ id: `${ref}:fill`, ref, kind: 'fill', ...info });
      } else actions.push({ id: `${ref}:click`, ref, kind: 'click', ...info });
    }
    const text = excerpt();
    observation = { id, nodes, actions, url: location.href, text, consumed: false };
    return { snapshot: id, url: location.href, title: clean(document.title, 200), text, actions, truncated: clipped,
      scroll: { y: scrollY, height: innerHeight, total: document.documentElement.scrollHeight } };
  }
  function act(request) {
    const o = observation;
    if (!o || o.consumed || request.snapshot !== o.id || location.href !== o.url) throw new Error('頁面觀察已過期，請重新讀取。');
    // A page result changing behind a stable button can change what a click means.
    if (excerpt() !== o.text) throw new Error('頁面內容已改變，請重新讀取。');
    o.consumed = true;
    if (['SCROLL_DOWN', 'SCROLL_UP'].includes(request.action)) {
      window.scrollBy({ top: Math.round(innerHeight * .7) * (request.action === 'SCROLL_DOWN' ? 1 : -1), behavior: 'instant' });
      return { executed: request.action };
    }
    const action = o.actions.find(a => a.id === request.action), node = action && o.nodes.get(action.ref), e = node?.e;
    if (!e?.isConnected || !visible(e) || e.disabled || e.readOnly || sensitive(e) || JSON.stringify(describe(e)) !== node.guard) throw new Error('目標元素已改變，請重新讀取。');
    const r = e.getBoundingClientRect(), x = Math.max(0, r.left) + Math.min(r.width, innerWidth - Math.max(0, r.left)) / 2,
      y = Math.max(0, r.top) + Math.min(r.height, innerHeight - Math.max(0, r.top)) / 2;
    if (!e.contains(document.elementFromPoint(x, y))) throw new Error('目標被其他內容遮住，請重新讀取。');
    if (action.kind === 'click') e.click();
    else if (action.kind === 'fill') {
      if (typeof request.text !== 'string' || request.text.length > 2000) throw new Error('請提供最多 2000 字的輸入文字。');
      if (e.isContentEditable) e.textContent = request.text;
      else {
        const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, request.text);
      }
      e.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: request.text }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (action.kind === 'select') {
      const option = e.options[action.option];
      if (!option || option.disabled || option.closest('optgroup[disabled]') || `${describe(e).label} → ${clean(option.text)}` !== action.label) throw new Error('選項已改變，請重新讀取。');
      e.selectedIndex = action.option; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { executed: action.id };
  }
  browser.runtime.onMessage.addListener(request => {
    if (request?.channel !== 'zen-pi-browser') return;
    try {
      if (request.op === 'observe') return Promise.resolve(observe());
      if (request.op === 'act') return Promise.resolve(act(request));
      throw new Error('Unknown page operation');
    } catch (error) { return Promise.resolve({ error: error.message }); }
  });
})();
