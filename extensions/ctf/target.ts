/**
 * 把題目給的各種寫法統一成 host / port / url。
 * CTF 題目描述長什麼樣都有:`nc chal.example.com 1337`、`chal:1337`、
 * `https://chal.example.com/`、有時只給一行 `chal.example.com 1337`。
 */
export interface Target {
  /** 使用者原本輸入的字串,原樣留著。 */
  raw: string;
  host?: string;
  port?: number;
  url?: string;
}

export function parseTarget(input: string): Target {
  const raw = input.trim();
  if (!raw) return { raw };

  const nc = raw.match(/^n(?:c|cat)\s+(\S+)\s+(\d{1,5})$/i);
  if (nc) return { raw, host: nc[1], port: Number(nc[2]) };

  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
      return { raw, host: u.hostname, port, url: raw };
    } catch {
      return { raw, url: raw };
    }
  }

  const spaced = raw.match(/^(\S+)\s+(\d{1,5})$/);
  if (spaced) return { raw, host: spaced[1], port: Number(spaced[2]) };

  const colon = raw.match(/^([^\s:]+):(\d{1,5})$/);
  if (colon) return { raw, host: colon[1], port: Number(colon[2]) };

  return { raw, host: raw };
}

export function describeTarget(t: Target): string {
  if (t.url) return t.url;
  if (t.host && t.port) return `${t.host}:${t.port}`;
  return t.host ?? t.raw;
}

/** 給 bash 工具用的 export 行。單引號包起來,題目網址帶 & 或 ? 也不會炸。 */
export function envExports(t: Target): string[] {
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const lines: string[] = [];
  if (t.host) lines.push(`export TARGET_HOST=${q(t.host)}`);
  if (t.port !== undefined) lines.push(`export TARGET_PORT=${q(String(t.port))}`);
  if (t.url) lines.push(`export TARGET_URL=${q(t.url)}`);
  lines.push(`export TARGET=${q(describeTarget(t))}`);
  return lines;
}
