const MAX_SOURCE_LENGTH = 10000;
const MAX_ZOOM = 3;

/** Render untrusted diagram text as an SVG image, never as live page HTML. */
export function createMermaidRenderer({ loadMermaid = () => import('./mermaid-vendor.js') } = {}) {
  let library, sequence = 0, renderQueue = Promise.resolve();
  const getLibrary = () => {
    library ||= loadMermaid().then(module => {
      const mermaid = module.default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        htmlLabels: false,
        theme: 'dark',
        maxTextSize: MAX_SOURCE_LENGTH,
        maxEdges: 200,
        suppressErrorRendering: true,
      });
      return mermaid;
    });
    return library;
  };
  const button = (label, title, action) => {
    const item = document.createElement('button');
    item.type = 'button'; item.textContent = label; item.title = title;
    item.setAttribute('aria-label', title); item.onclick = action;
    return item;
  };
  const fail = (card, status, source, text) => {
    if (!card.isConnected) return;
    card.dataset.mermaidReady = 'error';
    status.hidden = false; status.textContent = text;
    source.open = true;
  };
  return function renderMermaidBlocks(container, { streaming = false } = {}) {
    for (const card of container.querySelectorAll('.mermaid-card')) {
      if (card.dataset.mermaidReady) continue;
      const source = card.querySelector('.mermaid-source');
      const code = source.querySelector('code').textContent;
      const preview = card.querySelector('.mermaid-preview');
      const status = preview.querySelector('.mermaid-status');
      if (!card.dataset.mermaidControls) {
        card.dataset.mermaidControls = 'true';
        preview.dataset.zoom = '1';
        const toolbar = card.querySelector('.mermaid-toolbar');
        const zoomOut = button('−', '縮小圖表', () => zoom(-1));
        const zoomIn = button('＋', '放大圖表', () => zoom(1));
        function zoom(step) {
          const index = Math.max(0, Math.min(MAX_ZOOM - 1, Number(preview.dataset.zoom) - 1 + step));
          preview.dataset.zoom = String(index + 1);
          zoomOut.disabled = index === 0; zoomIn.disabled = index === MAX_ZOOM - 1;
        }
        zoom(0);
        const copy = button('複製原始碼', '複製 Mermaid 原始碼', async () => {
          try { await navigator.clipboard.writeText(code); copy.textContent = '已複製'; }
          catch { status.hidden = false; status.textContent = '無法複製，請展開原始碼選取。'; source.open = true; }
        });
        toolbar.append(zoomOut, zoomIn, copy);
      }
      if (streaming) { status.textContent = '回覆完成後繪製圖表…'; continue; }
      if (!code.trim() || code.length > MAX_SOURCE_LENGTH) {
        fail(card, status, source, code.length > MAX_SOURCE_LENGTH ? '圖表原始碼過長，請縮短至 10,000 字元以內。' : '圖表原始碼是空的。');
        continue;
      }
      card.dataset.mermaidReady = 'pending';
      status.textContent = '正在繪製圖表…';
      renderQueue = renderQueue.catch(() => {}).then(async () => {
        if (!card.isConnected) return;
        try {
          const mermaid = await getLibrary();
          if (!card.isConnected) return;
          const { svg } = await mermaid.render(`zen-pi-mermaid-${++sequence}`, code);
          if (!card.isConnected) return;
          const image = document.createElement('img');
          image.alt = 'Mermaid 圖表';
          image.onload = () => { if (card.isConnected) { status.hidden = true; card.dataset.mermaidReady = 'done'; } };
          image.onerror = () => { image.remove(); fail(card, status, source, '圖表圖片無法顯示，請查看原始碼。'); };
          preview.append(image);
          image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        } catch {
          fail(card, status, source, '無法繪製圖表，請檢查 Mermaid 語法；原始碼仍可查看。');
        }
      });
    }
  };
}

export const renderMermaidBlocks = createMermaidRenderer();
