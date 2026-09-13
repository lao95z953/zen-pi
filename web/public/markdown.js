const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function inline(text, depth = 0) {
  if (depth > 4) return escape(text);
  const pattern = /`([^`\n]+)`|\[([^\[\]\n]+)\]\(([^\s)]+)\)|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*/g;
  let html = '', last = 0;
  for (const match of text.matchAll(pattern)) {
    html += escape(text.slice(last, match.index));
    if (match[1] !== undefined) html += `<code>${escape(match[1])}</code>`;
    else if (match[2] !== undefined) {
      let href; try { const url = new URL(match[3]); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) href = url.href; } catch {}
      html += href ? `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${inline(match[2], depth + 1)}</a>` : escape(match[0]);
    } else if (match[4] !== undefined) html += `<strong>${inline(match[4], depth + 1)}</strong>`;
    else html += `<em>${inline(match[5], depth + 1)}</em>`;
    last = match.index + match[0].length;
  }
  return html + escape(text.slice(last));
}

/** Deliberately small Markdown renderer. Raw HTML and remote image loading are excluded. */
export function markdown(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const out = []; let i = 0;
  const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^\s*```/.test(line)) {
      const code = []; i++; while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]); i++;
      out.push(`<pre tabindex="0"><code>${escape(code.join('\n'))}</code></pre>`); continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)/);
    if (heading) { out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); i++; continue; }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const headers = cells(line); i += 2; const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]));
      out.push(`<div class="table-wrap"><table><thead><tr>${headers.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${headers.map((_, j) => `<td>${inline(row[j] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`); continue;
    }
    if (/^\s*>/.test(line)) {
      const quote = []; while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${inline(quote.join('\n')).replace(/\n/g, '<br>')}</blockquote>`); continue;
    }
    if (/^\s*(?:[-*+] |\d+\. )/.test(line)) {
      const ordered = /^\s*\d+\. /.test(line), rows = [], re = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*+]\s+/;
      while (i < lines.length && re.test(lines[i])) rows.push(lines[i++].replace(re, ''));
      out.push(`<${ordered ? 'ol' : 'ul'}>${rows.map(r => `<li>${inline(r)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`); continue;
    }
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^(?:#{1,4}\s|\s*```|\s*>|\s*[-*+]\s|\s*\d+\.\s)/.test(lines[i])) {
      if (i + 1 < lines.length && lines[i].includes('|') && /---/.test(lines[i + 1])) break;
      paragraph.push(lines[i++]);
    }
    out.push(`<p>${inline(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('');
}
