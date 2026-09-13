import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { load } from "cheerio";

export function publicAddress(address: string) {
  try { return ipaddr.process(address).range() === "unicast"; } catch { return false; }
}
export function publicURL(raw: string) {
  const url = new URL(raw);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) throw new Error("網路查證只支援公開 HTTP(S) 網頁。");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || (isIP(host) && !publicAddress(host))) throw new Error("網路查證不連向本機或私有位址。");
  url.hash = ""; return url;
}

/** Resolve once and pin the connection to a verified public address, including redirects. */
export async function fetchPublicBytes(raw: string, signal?: AbortSignal, pdf = false): Promise<{ url: string; bytes: Buffer; contentType: string }> {
  const abort = AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]);
  let url = publicURL(raw);
  for (let redirects = 0; redirects <= 5; redirects++) {
    abort.throwIfAborted();
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
    abort.throwIfAborted();
    if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error("網址解析到非公開位址。");
    const selected = addresses.find(a => a.family === 4) || addresses[0];
    const response = await new Promise<{ status: number; location?: string; contentType: string; bytes: Buffer }>((resolve, reject) => {
      const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        signal: abort, family: selected.family,
        lookup: (_hostname, _options, cb) => cb(null, selected.address, selected.family),
        headers: { "User-Agent": "Pi-Study/0.3 (personal research reference fetcher)", Accept: pdf ? "application/pdf" : "text/html,text/plain,application/json,application/atom+xml,application/xml;q=0.8", "Accept-Encoding": "identity" },
      }, res => {
        const contentType = res.headers["content-type"] || "";
        if ([301,302,303,307,308].includes(res.statusCode || 0)) {
          res.resume(); resolve({ status: res.statusCode!, location: res.headers.location, contentType, bytes: Buffer.alloc(0) }); return;
        }
        if ((res.statusCode || 0) >= 400) { res.resume(); reject(new Error(`網站回應 HTTP ${res.statusCode}`)); return; }
        if (!(pdf ? /application\/pdf/i : /(?:text\/|json|xml|html)/i).test(contentType)) { res.resume(); reject(new Error(`不支援的來源格式：${contentType}`)); return; }
        const chunks: Buffer[] = []; let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > (pdf ? 12 : 2) * 1024 * 1024) { req.destroy(new Error(`來源超過 ${pdf ? 12 : 2} MiB 上限`)); return; }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode || 0, contentType, bytes: Buffer.concat(chunks) }));
      });
      req.on("error", reject); req.end();
    });
    if (response.location) { url = publicURL(new URL(response.location, url).href); continue; }
    if ([301,302,303,307,308].includes(response.status)) throw new Error("重新導向缺少目的地。");
    return { url: url.href, bytes: response.bytes, contentType: response.contentType };
  }
  throw new Error("重新導向次數過多。");
}

export async function fetchPublic(raw: string, signal?: AbortSignal) {
  const response = await fetchPublicBytes(raw, signal);
  return { url: response.url, text: response.bytes.toString("utf8"), contentType: response.contentType };
}

export async function searchWeb(query: string, signal?: AbortSignal) {
  if (!query.trim() || query.length > 400) throw new Error("搜尋詞需為 1–400 字元，請用公開概念詞，不要傳整篇私人筆記。");
  const response = await fetchPublic(`https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`, signal);
  return { provider: "Bing RSS（公開搜尋介面，無可用性保證）", query, fetchedAt: new Date().toISOString(), results: parseRSS(response.text) };
}

export function parseRSS(xml: string) {
  const $ = load(xml, { xmlMode: true });
  if (!$("rss channel").length) throw new Error("搜尋服務未回傳 RSS；可能暫時不可用，請提供網址使用 study_web_read。");
  const results: { title: string; url: string; snippet: string }[] = [];
  $("item").each((_i, item) => {
    try {
      const url = publicURL($(item).find("link").text().trim()).href;
      if (!results.some(r => r.url === url)) results.push({ title: $(item).find("title").text().trim(), url, snippet: $(item).find("description").text().trim().slice(0, 1000) });
    } catch { /* Skip unusable result URLs. */ }
  });
  return results.slice(0, 6);
}

export function extractPage(html: string, contentType: string) {
  if (!/html/i.test(contentType)) return { title: "Text source", text: html.slice(0, 60000), truncated: html.length > 60000 };
  const $ = load(html), title = $("title").first().text().trim() || $("h1").first().text().trim() || "Web source";
  $("script, style, nav, footer, header, noscript, form, svg").remove();
  $("br").replaceWith("\n");
  $("p, h1, h2, h3, h4, li, pre, tr").each((_i, el) => { $(el).append("\n"); });
  const main = $("main").first(), article = $("article").first();
  const text = (main.length ? main : article.length ? article : $("body")).text().replace(/[\t ]+/g, " ").replace(/\n\s*\n\s*\n/g, "\n\n").trim();
  if (!text) throw new Error("網頁沒有可讀正文，可能需要 JavaScript 或登入。");
  return { title, text: text.slice(0, 60000), truncated: text.length > 60000 };
}
