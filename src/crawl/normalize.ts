/** URL normalization and same-site checks for page discovery (PLAN §3 "Crawl-Modus"). */
import { getDomain } from 'tldts';

const TRACKING_PARAMS = new Set(['gclid', 'fbclid', 'msclkid', 'dclid', 'yclid', '_ga', 'gbraid']);

const NON_HTML_EXT = new Set([
  'pdf',
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'avif',
  'svg',
  'ico',
  'bmp',
  'zip',
  'gz',
  'tgz',
  'rar',
  '7z',
  'tar',
  'mp3',
  'mp4',
  'webm',
  'avi',
  'mov',
  'wav',
  'ogg',
  'css',
  'js',
  'mjs',
  'json',
  'xml',
  'txt',
  'csv',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'exe',
  'dmg',
  'apk',
  'iso',
  'rss',
  'atom',
]);

export function isTrackingParam(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith('utm_') || n.startsWith('mc_') || TRACKING_PARAMS.has(n);
}

export function hasNonHtmlExtension(pathname: string): boolean {
  const last = pathname.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  if (dot < 0) return false;
  return NON_HTML_EXT.has(last.slice(dot + 1).toLowerCase());
}

/**
 * Normalizes `input` (optionally relative to `base`): http(s) only, no fragment, lower-case host,
 * default port removed, tracking parameters dropped, query sorted. Returns null for URLs that
 * cannot be pages (other schemes, non-HTML file extensions).
 */
export function normalizePageUrl(input: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim(), base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (hasNonHtmlExtension(u.pathname)) return null;
  u.hash = '';
  u.username = '';
  u.password = '';
  const params = [...u.searchParams.entries()].filter(([k]) => !isTrackingParam(k));
  params.sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1));
  const q = new URLSearchParams(params).toString();
  u.search = q ? `?${q}` : '';
  // Treat `/foo/`, `/foo`, `/foo/index.html` and `/foo/index.php` as the same page.
  u.pathname = u.pathname.replace(/\/index\.(?:html?|php)$/i, '/');
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  if (u.pathname === '') u.pathname = '/';
  return u.toString();
}

/** Registrable domain, or the bare host for IPs / localhost. */
export function siteKey(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return getDomain(host, { allowPrivateDomains: true }) ?? host;
  } catch {
    return null;
  }
}

export function isSameSite(a: string, b: string): boolean {
  const ka = siteKey(a);
  return ka !== null && ka === siteKey(b);
}
