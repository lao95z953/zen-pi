import { fingerprint, type Note } from "./notes.ts";
import type { Citation } from "./memory.ts";

type Seen = { sha256: string; lines: Map<number, number> };

/** Track the exact line prefixes delivered to the model, after output budgets. */
export function createReadEvidence() {
  const tools = new Map<string, Seen>();
  const context = new Map<string, Seen>();
  const latest = new Map<string, string>();
  const mark = (target: Map<string, Seen>, note: Note, content: string, fresh: boolean) => {
    const sha256 = fingerprint(note.text);
    // Replaying an older snapshot must not revoke a newer explicit tool read.
    if (!fresh && latest.has(note.path) && latest.get(note.path) !== sha256) return;
    latest.set(note.path, sha256);
    for (const map of [tools, context]) if (map.get(note.path)?.sha256 !== sha256) map.delete(note.path);
    const seen = target.get(note.path) || { sha256, lines: new Map<number, number>() };
    const original = note.text.split("\n");
    for (const line of content.split("\n")) {
      const match = /^(\d+): ([\s\S]*)$/.exec(line);
      if (!match) continue;
      const number = Number(match[1]), source = original[number - 1];
      if (source === undefined) continue;
      const shown = match[2];
      let length = 0;
      // Excerpt truncation may append an ellipsis that was not in the source.
      while (length < shown.length && length < source.length && shown[length] === source[length]) length++;
      if (length || !source.length && !shown.length) seen.lines.set(number, Math.max(seen.lines.get(number) ?? 0, length));
    }
    if (seen.lines.size) target.set(note.path, seen);
  };
  return {
    markRead: (note: Note, content: string) => mark(tools, note, content, true),
    markContext: (note: Note, content: string, fresh = false) => mark(context, note, content, fresh),
    clearContext: () => context.clear(),
    clear: () => { tools.clear(); context.clear(); latest.clear(); },
    assert(source: Citation, note: Note) {
      const maps = [tools.get(source.path), context.get(source.path)].filter((s): s is Seen => s?.sha256 === source.sha256);
      if (!maps.length) throw new Error(`此版本尚未讀取：${source.path}。先用 study_read 閱讀。`);
      const lines = note.text.split("\n"), seen = new Map<number, number>();
      for (const map of maps) for (const [number, length] of map.lines) seen.set(number, Math.max(seen.get(number) ?? 0, length));
      for (let n = source.startLine; n <= source.endLine; n++) {
        if (!seen.has(n)) throw new Error(`引用行段尚未讀取：${source.path}:${n}。先用 study_read 補讀。`);
      }
      const selected = lines.slice(source.startLine - 1, source.endLine).join("\n");
      let at = selected.indexOf(source.quote);
      while (at !== -1) {
        let offset = 0, visible = true;
        const end = at + source.quote.length;
        for (let n = source.startLine; n <= source.endLine; n++) {
          const line = lines[n - 1], length = line.length;
          const overlapEnd = Math.min(end, offset + length);
          if (at < offset + length && end > offset && overlapEnd - offset > (seen.get(n) ?? -1)) visible = false;
          // A quote spanning a newline needs the whole preceding source line.
          if (at <= offset + length && end > offset + length && n < source.endLine && seen.get(n) !== length) visible = false;
          offset += length + 1;
        }
        if (visible) return;
        at = selected.indexOf(source.quote, at + 1);
      }
      throw new Error(`引文包含未展示的文字：${source.path}。先用 study_read 補讀該行段。`);
    },
  };
}
