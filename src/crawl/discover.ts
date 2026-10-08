/**
 * Page discovery for `--crawl` (PLAN §3): sitemap.xml (robots.txt, index recursion, gzip), fallback
 * same-site BFS link crawl. Plain HTTP fetches; never throws – problems end up in `notes`.
 */
import { isSameSite, normalizePageUrl } from './normalize.js';
import {
  bodyToText,
  extractCanonical,
  extractLinks,
  parseRobotsSitemaps,
  parseSitemap,
} from './sitemap.js';

export interface DiscoverOptions {
  maxPages: number;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  /** Not supported by plain fetch; noted in `notes` when set without a custom fetchImpl. */
  proxy?: string;
  /** Politeness delay between fetches (default 200 ms). */
  delayMs?: number;
  /** Max sitemap-index nesting (default 3). */
  maxSitemapDepth?: number;
}

export interface DiscoverResult {
  pages: string[];
  source: 'sitemap' | 'links';
  notes: string[];
}

const MAX_SITEMAP_FILES = 50;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
/** Browser-like UA of plain discovery fetches; `--identify` appends ` Bello/<version>`. */
export const DEFAULT_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** Reads a response body but gives up (null) once it exceeds `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body)
    return new Uint8Array(await res.arrayBuffer()).length > max ? null : new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function discoverPages(
  startUrl: string,
  opts: DiscoverOptions,
): Promise<DiscoverResult> {
  const notes: string[] = [];
  const fetchFn = opts.fetchImpl ?? fetch;
  const delayMs = opts.delayMs ?? 200;
  const maxPages = Math.max(1, opts.maxPages);
  const ua = opts.userAgent ?? DEFAULT_UA;
  if (opts.proxy && !opts.fetchImpl) {
    notes.push('Hinweis: Die Seitenermittlung läuft ohne Proxy (nur der Browser nutzt den Proxy).');
  }
  const start = normalizePageUrl(startUrl) ?? startUrl;
  const pages: string[] = [start];
  const seen = new Set<string>([start]);
  let fetched = 0;

  async function get(
    url: string,
  ): Promise<{ body: Uint8Array; contentType: string; finalUrl: string } | null> {
    if (fetched++ > 0 && delayMs > 0) await sleep(delayMs);
    try {
      let current = url;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const res = await fetchFn(current, {
          headers: { 'user-agent': ua, accept: 'text/html,application/xml,text/xml,*/*;q=0.5' },
          redirect: 'manual',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          await res.body?.cancel().catch(() => {});
          if (!loc) return null;
          let next: string;
          try {
            next = new URL(loc, current).toString();
          } catch {
            return null;
          }
          // Never follow a redirect to another site (SSRF via robots.txt/sitemap redirects).
          if (!/^https?:/i.test(next) || !isSameSite(next, start)) return null;
          current = next;
          continue;
        }
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          return null;
        }
        const finalUrl = res.url || current;
        if (!isSameSite(finalUrl, start)) {
          await res.body?.cancel().catch(() => {});
          return null;
        }
        const buf = await readCapped(res, MAX_BODY_BYTES);
        if (!buf) return null;
        return { body: buf, contentType: res.headers.get('content-type') ?? '', finalUrl };
      }
      return null;
    } catch {
      return null;
    }
  }

  function add(raw: string, base?: string): void {
    if (pages.length >= maxPages) return;
    const n = normalizePageUrl(raw, base);
    if (!n || seen.has(n) || !isSameSite(n, start)) return;
    seen.add(n);
    pages.push(n);
  }

  // --- sitemap ---
  const origin = new URL(start).origin;
  const sitemapQueue: { url: string; depth: number }[] = [];
  const robots = await get(`${origin}/robots.txt`);
  if (robots) {
    for (const s of parseRobotsSitemaps(bodyToText(robots.body)))
      sitemapQueue.push({ url: s, depth: 0 });
  }
  sitemapQueue.push({ url: `${origin}/sitemap.xml`, depth: 0 });
  const visitedSitemaps = new Set<string>();
  const maxDepth = opts.maxSitemapDepth ?? 3;
  let sitemapFiles = 0;
  while (sitemapQueue.length > 0 && pages.length < maxPages && sitemapFiles < MAX_SITEMAP_FILES) {
    const { url, depth } = sitemapQueue.shift()!;
    if (visitedSitemaps.has(url) || !isSameSite(url, start)) continue;
    visitedSitemaps.add(url);
    const res = await get(url);
    sitemapFiles++;
    if (!res) continue;
    const parsed = parseSitemap(bodyToText(res.body));
    if (parsed.kind === 'index') {
      if (depth >= maxDepth) {
        notes.push(`Sitemap-Index ${url} nicht weiter verfolgt (Tiefenlimit ${maxDepth}).`);
        continue;
      }
      for (const loc of parsed.locs) sitemapQueue.push({ url: loc, depth: depth + 1 });
    } else {
      for (const loc of parsed.locs) add(loc, url);
    }
  }
  if (pages.length > 1) {
    notes.push(`${pages.length} Seite(n) aus der Sitemap übernommen.`);
    return { pages, source: 'sitemap', notes };
  }
  notes.push('Keine verwertbare Sitemap gefunden – Fallback: Link-Crawl.');

  // --- BFS link crawl ---
  const queue: string[] = [start];
  const visited = new Set<string>();
  while (queue.length > 0 && pages.length < maxPages) {
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    const res = await get(url);
    if (!res || !/html/i.test(res.contentType)) continue;
    const html = Buffer.from(res.body).toString('utf8');
    const canonical = extractCanonical(html);
    if (canonical) {
      const c = normalizePageUrl(canonical, res.finalUrl);
      if (c && c !== url && isSameSite(c, start) && !seen.has(c)) {
        // The page declares another canonical URL: scan that one instead of the alias.
        const idx = pages.indexOf(url);
        seen.add(c);
        if (idx > 0) pages[idx] = c;
        else if (idx < 0 && pages.length < maxPages) pages.push(c);
        visited.add(c);
      }
    }
    for (const href of extractLinks(html)) {
      const n = normalizePageUrl(href, res.finalUrl);
      if (!n || !isSameSite(n, start)) continue;
      const before = pages.length;
      add(n);
      if (pages.length > before) queue.push(n);
    }
  }
  notes.push(`${pages.length} Seite(n) per Link-Crawl gefunden.`);
  return { pages, source: 'links', notes };
}
