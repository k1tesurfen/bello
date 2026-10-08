/** robots.txt and sitemap parsing (also gzip). */
import { gunzipSync } from 'node:zlib';

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

export interface ParsedSitemap {
  kind: 'index' | 'urlset';
  locs: string[];
}

/** Parses a sitemap XML document (`<sitemapindex>` or `<urlset>`). */
export function parseSitemap(xml: string): ParsedSitemap {
  const kind = /<sitemapindex[\s>]/i.test(xml) ? 'index' : 'urlset';
  const locs: string[] = [];
  const re = /<loc>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))\s*<\/loc>/gi;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const raw = (m[1] ?? m[2] ?? '').trim();
    if (raw) locs.push(m[1] !== undefined ? raw : decodeEntities(raw));
  }
  return { kind, locs };
}

const MAX_GUNZIP_BYTES = 20 * 1024 * 1024;

/** Decodes a response body that may be gzip-compressed (magic bytes) to text. */
export function bodyToText(buf: Uint8Array): string {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      return gunzipSync(buf, { maxOutputLength: MAX_GUNZIP_BYTES }).toString('utf8');
    } catch {
      return '';
    }
  }
  return Buffer.from(buf).toString('utf8');
}

/** `Sitemap:` lines of a robots.txt (case-insensitive, absolute URLs only). */
export function parseRobotsSitemaps(robots: string): string[] {
  const out: string[] = [];
  for (const line of robots.split(/\r?\n/)) {
    const m = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
    if (m?.[1] && /^https?:\/\//i.test(m[1])) out.push(m[1]);
  }
  return [...new Set(out)];
}

/** `<a href>` values of an HTML document (raw, unresolved). */
export function extractLinks(html: string): string[] {
  const out: string[] = [];
  const re = /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const href = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (href) out.push(decodeEntities(href));
  }
  return out;
}

/** `<link rel="canonical" href>` value, if any. */
export function extractCanonical(html: string): string | null {
  const tags = html.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (!/\brel\s*=\s*["']?[^"'>]*\bcanonical\b/i.test(tag)) continue;
    const m = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const href = m?.[1] ?? m?.[2] ?? m?.[3];
    if (href) return decodeEntities(href.trim());
  }
  return null;
}
