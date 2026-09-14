const MAX_SOURCE_LENGTH = 2000;
const MATHML = 'http://www.w3.org/1998/Math/MathML';
const XHTML = 'http://www.w3.org/1999/xhtml';

/** Render LaTeX as MathML; the page CSP forbids the inline styles KaTeX's HTML output relies on. */
export function createMathRenderer({ loadKatex = () => import('./katex-vendor.js') } = {}) {
  let library;
  const getLibrary = () => (library ||= loadKatex().then(module => module.default));
  const fail = (node, text) => { node.dataset.mathReady = 'error'; node.title = text; };
  /** Parsed as strict XML so nothing executes, then kept only if every element is MathML. */
  const parse = markup => {
    const doc = new DOMParser().parseFromString(`<div xmlns="${XHTML}">${markup}</div>`, 'application/xhtml+xml');
    const root = doc.documentElement;
    if (!root || root.localName === 'parsererror') return null;
    let formulas = 0;
    for (const node of root.querySelectorAll('*')) {
      if (node.namespaceURI === MATHML) { formulas++; continue; }
      if (node.localName !== 'span') return null;
    }
    // KaTeX reports a rejected formula as a colour-styled span, never as MathML, and that
    // inline style is exactly what the CSP blocks. Treat it as a failure and keep the source.
    return formulas ? root : null;
  };
  return async function renderMathBlocks(container) {
    const pending = [...container.querySelectorAll('[data-math]')].filter(node => !node.dataset.mathReady);
    if (!pending.length) return;
    let katex;
    try { katex = await getLibrary(); }
    catch { for (const node of pending) fail(node, '無法載入數學排版程式庫，以下為原始 LaTeX。'); return; }
    for (const node of pending) {
      if (node.dataset.mathReady) continue;
      const source = node.textContent;
      if (!source.trim() || source.length > MAX_SOURCE_LENGTH) {
        fail(node, source.trim() ? '算式過長，請縮短至 2,000 字元以內。' : '算式是空的。'); continue;
      }
      let root = null, reason = '';
      // throwOnError keeps KaTeX from emitting its styled error span: building that markup in a
      // DOMParser document is itself reported as a CSP inline-style violation, even unattached.
      try {
        root = parse(katex.renderToString(source, {
          output: 'mathml',
          displayMode: node.dataset.math === 'block',
          throwOnError: true,
          trust: false,
          strict: false,
          maxExpand: 1000,
        }));
      } catch (error) { reason = String(error?.message || '').slice(0, 160); root = null; }
      if (!root) { fail(node, reason ? `${reason}；以下為原始 LaTeX。` : '無法排版此算式，以下為原始 LaTeX。'); continue; }
      node.replaceChildren(...[...root.childNodes].map(child => document.importNode(child, true)));
      node.dataset.mathReady = 'done';
    }
  };
}

export const renderMathBlocks = createMathRenderer();
