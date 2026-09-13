import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { wikiPath } from "./memory.ts";
import { fetchPublicBytes, publicURL } from "./web.ts";

export const MAX_PDF_BYTES = 12 * 1024 * 1024;
export const MAX_PDF_CACHE_BYTES = 128 * 1024 * 1024;
export const MAX_PDF_CACHE_URLS = 128;
type FetchBytes = typeof fetchPublicBytes;
type CacheEntry = { version: 1; requestedUrl: string; url: string; sha256: string; fetchedAt: string; checkedAt: string; contentType: string; size: number };
type CacheOptions = { refresh?: boolean; signal?: AbortSignal; fetchBytes?: FetchBytes; maxCacheBytes?: number; maxEntries?: number; now?: () => Date };
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const cachePath = (vault: string, name?: string) => wikiPath(vault, ".cache", "pdf", ...(name ? [name] : []));
const pending = new Map<string, Promise<void>>();

function waitForTurn(previous: Promise<void>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!signal) return previous;
  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    previous.then(() => { signal.removeEventListener("abort", abort); resolve(); });
  });
}

/** Serialize one URL, but let an aborted waiter leave without cancelling another reader. */
async function serialize<T>(key: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
  const previous = pending.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => current);
  pending.set(key, tail);
  // An aborted waiter still remains behind the active fetch until that fetch releases its slot.
  void tail.then(() => { if (pending.get(key) === tail) pending.delete(key); });
  try { await waitForTurn(previous, signal); signal?.throwIfAborted(); return await operation(); }
  finally { release(); }
}

function atomicWrite(vault: string, name: string, data: string | Buffer) {
  const tempName = `.${randomUUID()}.tmp`, temp = cachePath(vault, tempName);
  try {
    writeFileSync(temp, data, { flag: "wx", mode: 0o600 });
    renameSync(temp, cachePath(vault, name));
  } finally {
    try { unlinkSync(cachePath(vault, tempName)); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  }
}

function readEntry(vault: string, name: string): CacheEntry | undefined {
  try {
    const file = cachePath(vault, name);
    if (statSync(file).size > 16384) throw new Error("PDF cache 索引超過上限。");
    const entry = JSON.parse(readFileSync(file, "utf8")) as CacheEntry;
    if (entry.version !== 1 || typeof entry.requestedUrl !== "string" || typeof entry.url !== "string" ||
        hash(entry.requestedUrl) + ".json" !== name || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        !Number.isInteger(entry.size) || entry.size < 1 || entry.size > MAX_PDF_BYTES ||
        !Number.isFinite(Date.parse(entry.fetchedAt)) || !Number.isFinite(Date.parse(entry.checkedAt)) ||
        typeof entry.contentType !== "string") throw new Error("PDF cache 索引損壞。");
    publicURL(entry.requestedUrl); publicURL(entry.url);
    return entry;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

function readBlob(vault: string, entry: CacheEntry) {
  try {
    const file = cachePath(vault, `${entry.sha256}.pdf`), size = statSync(file).size;
    if (size !== entry.size || size > MAX_PDF_BYTES) throw new Error("PDF cache 檔案大小不符。");
    const bytes = readFileSync(file);
    if (hash(bytes) !== entry.sha256) throw new Error("PDF cache 內容 hash 不符。");
    return bytes;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

/** Eviction only touches managed cache names; immutable source records are retained. */
function evict(vault: string, preserve: string, maxBytes: number, maxEntries: number) {
  const names = readdirSync(cachePath(vault));
  const entries = names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => ({
    name, entry: readEntry(vault, name)!, accessed: statSync(cachePath(vault, name)).mtimeMs,
  })).filter(item => item.entry).sort((a, b) => a.accessed - b.accessed || a.name.localeCompare(b.name));
  const blobs = new Map(names.filter(name => /^[a-f0-9]{64}\.pdf$/.test(name)).map(name => [name.slice(0, -4), statSync(cachePath(vault, name)).size]));
  const collectOrphans = () => {
    const referenced = new Set(entries.map(item => item.entry.sha256));
    for (const sha256 of blobs.keys()) if (!referenced.has(sha256)) {
      unlinkSync(cachePath(vault, `${sha256}.pdf`)); blobs.delete(sha256);
    }
  };
  collectOrphans();
  while (entries.length > maxEntries || [...blobs.values()].reduce((sum, size) => sum + size, 0) > maxBytes) {
    const index = entries.findIndex(item => item.name !== preserve);
    if (index < 0) break;
    unlinkSync(cachePath(vault, entries[index].name)); entries.splice(index, 1); collectOrphans();
  }
}

/** A cache hit is a saved version, never a claim that the URL is still current. */
export async function cachedPDF(vault: string, rawUrl: string, options: CacheOptions = {}) {
  const url = publicURL(rawUrl).href;
  return serialize(`${cachePath(vault)}\0${url}`, options.signal, () => loadCachedPDF(vault, url, options));
}

async function loadCachedPDF(vault: string, rawUrl: string, options: CacheOptions) {
  const requestedUrl = publicURL(rawUrl).href, name = `${hash(requestedUrl)}.json`;
  const maxBytes = options.maxCacheBytes ?? MAX_PDF_CACHE_BYTES, maxEntries = options.maxEntries ?? MAX_PDF_CACHE_URLS;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PDF_CACHE_BYTES || !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_PDF_CACHE_URLS) throw new Error("PDF cache 容量設定不合法。");
  options.signal?.throwIfAborted();
  mkdirSync(cachePath(vault), { recursive: true, mode: 0o700 });
  const previous = readEntry(vault, name);
  if (previous && !options.refresh) {
    const bytes = readBlob(vault, previous);
    if (bytes) {
      const now = (options.now || (() => new Date()))();
      utimesSync(cachePath(vault, name), now, now);
      return { ...previous, bytes, cacheHit: true, refreshed: false };
    }
  }
  // The production fetch pins public DNS addresses and checks every redirect.
  const response = await (options.fetchBytes || fetchPublicBytes)(requestedUrl, options.signal, true);
  options.signal?.throwIfAborted();
  const url = publicURL(response.url).href, bytes = response.bytes;
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_PDF_BYTES) throw new Error("來源超過 12 MiB 上限。");
  if (!/application\/pdf/i.test(response.contentType) || !bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw new Error("回應不是 PDF。");
  const sha256 = hash(bytes), checkedAt = (options.now || (() => new Date()))().toISOString();
  const entry: CacheEntry = { version: 1, requestedUrl, url, sha256, size: bytes.length, contentType: response.contentType,
    fetchedAt: previous?.sha256 === sha256 ? previous.fetchedAt : checkedAt, checkedAt };
  // Test limits may be smaller than one source. Return it without exceeding storage limits.
  if (bytes.length <= maxBytes) {
    atomicWrite(vault, `${sha256}.pdf`, bytes);
    atomicWrite(vault, name, JSON.stringify(entry) + "\n");
    evict(vault, name, maxBytes, maxEntries);
  }
  return { ...entry, bytes, cacheHit: false, refreshed: !!options.refresh };
}
