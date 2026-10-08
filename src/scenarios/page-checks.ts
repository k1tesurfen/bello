/**
 * Pure helpers for scenario runs: bot-wall detection, internal link selection for the
 * follow-up navigation in scenario B, and CMP script recognition (for `cmpLoadedAt`).
 */
import { getDomain } from 'tldts';
import type { RequestRecord } from '../types.js';

// ---------------------------------------------------------------------------
// Bot wall / WAF challenge
// ---------------------------------------------------------------------------

export interface MainDocumentInfo {
  status?: number;
  /** Lower-case header names. */
  headers?: Record<string, string>;
  title?: string;
  /** Raw HTML (or a prefix of it). */
  html?: string;
}

export interface BotWallVerdict {
  botWall: boolean;
  vendor?: string;
  /** German explanation. */
  reason?: string;
}

/** Markers that only appear on challenge / block pages (safe even with HTTP 200). */
const STRONG_TITLE =
  /^(just a moment|einen moment|nur einen moment|attention required|checking your browser|ddos-guard|access denied|zugriff verweigert|pardon our interruption|request rejected|security check|sicherheitsüberprüfung)/i;

const BODY_MARKERS: Array<{ re: RegExp; vendor: string; strong: boolean }> = [
  {
    re: /cf-chl-|__cf_chl_|cf_chl_opt|challenges\.cloudflare\.com\/turnstile.*cf-challenge/i,
    vendor: 'Cloudflare',
    strong: true,
  },
  { re: /captcha-delivery\.com|geo\.captcha-delivery/i, vendor: 'DataDome', strong: true },
  { re: /px-captcha|_pxCaptcha|perimeterx/i, vendor: 'PerimeterX/HUMAN', strong: true },
  { re: /_Incapsula_Resource|Incapsula incident/i, vendor: 'Imperva', strong: true },
  { re: /Sucuri WebSite Firewall/i, vendor: 'Sucuri', strong: true },
  { re: /awswaf|aws-waf-token/i, vendor: 'AWS WAF', strong: true },
  { re: /Reference #\d+\.[0-9a-f]+\.\d+/i, vendor: 'Akamai', strong: false },
  {
    re: /captcha|bot detection|are you a robot|sind sie ein mensch/i,
    vendor: 'unbekannt',
    strong: false,
  },
];

/**
 * Heuristic: is the main document a bot wall / WAF challenge rather than the real page?
 * HTTP 403/429 is treated as a block even without markers; HTTP 200 only with strong markers
 * (Cloudflare also injects challenge scripts into normal pages, so those alone do not count).
 */
export function detectBotWall(doc: MainDocumentInfo): BotWallVerdict {
  const status = doc.status ?? 0;
  const html = doc.html ?? '';
  const title = (doc.title ?? '').trim();
  const headers = doc.headers ?? {};
  const server = headers.server ?? '';

  if (headers['cf-mitigated'] === 'challenge') {
    return {
      botWall: true,
      vendor: 'Cloudflare',
      reason: 'Cloudflare-Challenge (Header cf-mitigated).',
    };
  }
  if (STRONG_TITLE.test(title)) {
    const vendor = /cloudflare/i.test(server) ? 'Cloudflare' : undefined;
    return {
      botWall: true,
      ...(vendor ? { vendor } : {}),
      reason: `Seite zeigt eine Bot-Prüfung („${title.slice(0, 60)}“).`,
    };
  }
  const marker = BODY_MARKERS.find((m) => m.re.test(html));
  if (status >= 400 && marker) {
    return {
      botWall: true,
      vendor: marker.vendor,
      reason: `HTTP ${status} mit Bot-Schutz-Merkmalen (${marker.vendor}).`,
    };
  }
  if (status === 403 || status === 429) {
    return {
      botWall: true,
      reason: `HTTP ${status}: Zugriff vermutlich durch Bot-Schutz/WAF blockiert.`,
    };
  }
  if (status === 503 && /cloudflare|akamai|ddos-guard/i.test(server)) {
    return {
      botWall: true,
      vendor: server,
      reason: `HTTP 503 von ${server}: vermutlich Bot-Schutz.`,
    };
  }
  if (
    status > 0 &&
    status < 400 &&
    marker?.strong &&
    html.length < 30_000 &&
    marker.vendor !== 'Cloudflare'
  ) {
    return {
      botWall: true,
      vendor: marker.vendor,
      reason: `Bot-Schutz-Seite erkannt (${marker.vendor}).`,
    };
  }
  return { botWall: false };
}

// ---------------------------------------------------------------------------
// Internal links (scenario B follow-up navigation)
// ---------------------------------------------------------------------------

const SKIP_EXT =
  /\.(pdf|zip|gz|rar|7z|jpe?g|png|gif|svg|webp|avif|ico|mp4|webm|mp3|wav|ogg|docx?|xlsx?|pptx?|odt|exe|dmg|msi|apk|ics|vcf|xml|json|rss|atom|txt|css|js)$/i;
const SKIP_PATH =
  /(log-?out|abmelden|sign-?out|warenkorb|cart|checkout|kasse|login|anmelden|sign-?in|wp-admin|wp-login|\/feed\/?$)/i;

function siteOf(host: string): string {
  return getDomain(host, { allowPrivateDomains: true }) ?? host;
}

/**
 * Picks up to `max` same-site internal links (http/https, same registrable domain), skipping
 * the current page, downloads, login/cart links and duplicates. Order of appearance is kept.
 */
export function pickInternalLinks(hrefs: readonly string[], pageUrl: string, max = 2): string[] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }
  const site = siteOf(base.hostname);
  const norm = (u: URL): string => `${u.protocol}//${u.host}${u.pathname}${u.search}`;
  const seen = new Set<string>([norm(base)]);
  const out: string[] = [];
  for (const href of hrefs) {
    if (out.length >= max) break;
    let u: URL;
    try {
      u = new URL(href, base);
    } catch {
      continue;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    if (siteOf(u.hostname) !== site) continue;
    u.hash = '';
    if (SKIP_EXT.test(u.pathname) || SKIP_PATH.test(u.pathname)) continue;
    const key = norm(u);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u.toString());
  }
  return out;
}

// ---------------------------------------------------------------------------
// CMP scripts
// ---------------------------------------------------------------------------

const CMP_HOSTS: Array<{ re: RegExp; name: string }> = [
  { re: /(^|\.)usercentrics\.(eu|com)$/, name: 'Usercentrics' },
  { re: /(^|\.)cookiebot\.(com|eu)$/, name: 'Cookiebot' },
  { re: /(^|\.)(consentmanager\.net|consensu\.org)$/, name: 'consentmanager' },
  { re: /(^|\.)(cookielaw\.org|onetrust\.com)$/, name: 'OneTrust' },
  { re: /(^|\.)privacy-center\.org$/, name: 'Didomi' },
  { re: /(^|\.)privacy-mgmt\.com$/, name: 'Sourcepoint' },
  { re: /(^|\.)trustarc\.com$/, name: 'TrustArc' },
  { re: /(^|\.)quantcast\.com$/, name: 'Quantcast' },
  { re: /(^|\.)iubenda\.com$/, name: 'iubenda' },
  { re: /(^|\.)cookieyes\.com$|cdn-cookieyes\.com$/, name: 'CookieYes' },
  { re: /(^|\.)cookiehub\.(net|eu)$/, name: 'CookieHub' },
  { re: /(^|\.)cookie-script\.com$/, name: 'Cookie-Script' },
  { re: /(^|\.)cookiefirst\.com$/, name: 'CookieFirst' },
  { re: /(^|\.)cookieinformation\.com$/, name: 'Cookie Information' },
  { re: /(^|\.)termly\.io$/, name: 'Termly' },
  { re: /(^|\.)ccm19\.de$/, name: 'CCM19' },
  { re: /(^|\.)klaro\.(org|kiprotect\.com)$/, name: 'Klaro' },
  { re: /(^|\.)consentric\.io$|(^|\.)civiccomputing\.com$/, name: 'Civic' },
];

const CMP_PATHS: Array<{ re: RegExp; name: string }> = [
  { re: /\/borlabs-cookie\//i, name: 'Borlabs Cookie' },
  { re: /\/real-cookie-banner/i, name: 'Real Cookie Banner' },
  { re: /\/complianz-gdpr/i, name: 'Complianz' },
  { re: /\/cookie-law-info\/|\/cookie-notice\//i, name: 'WordPress-Cookie-Plugin' },
  { re: /\/klaro(\.min)?\.js/i, name: 'Klaro' },
  { re: /\/ccm19\.js|\/app\.ccm19/i, name: 'CCM19' },
  { re: /\/cookieconsent(\.min)?\.js/i, name: 'cookieconsent' },
  // Generic: a script file whose name says cmp/consent/cookie-banner.
  {
    re: /\/(?:[^/]*[-_.])?(?:cmp|consent|cookie-?banner|cookieconsent|cookie-?notice)(?:[-_.][^/]*)?\.js$/i,
    name: 'CMP',
  },
];

/** Returns a CMP name if the URL looks like a CMP script / CMP host, else undefined. */
export function cmpFromUrl(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const host = u.hostname.toLowerCase();
  const h = CMP_HOSTS.find((c) => c.re.test(host));
  if (h) return h.name;
  const p = CMP_PATHS.find((c) => c.re.test(u.pathname));
  return p?.name;
}

/**
 * Earliest CMP script load: the first CMP request (by start time) that completed, using its
 * response time (`endTime`, falls back to `startTime`). Only scripts / documents count.
 */
export function cmpScriptLoad(
  requests: readonly RequestRecord[],
): { at: number; url: string; name: string } | undefined {
  let best: { at: number; url: string; name: string } | undefined;
  for (const r of requests) {
    if (r.failed) continue;
    if (r.resourceType !== 'Script' && r.resourceType !== 'Document') continue;
    const name = cmpFromUrl(r.url);
    if (!name) continue;
    const at = r.endTime ?? r.startTime;
    if (!best || at < best.at) best = { at, url: r.url, name };
  }
  return best;
}
