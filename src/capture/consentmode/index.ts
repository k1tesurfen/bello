/**
 * Google Consent Mode ping parsing (PLAN §5.5).
 *
 * Extracts `gcs`, `gcd`, `npa`, `dma`, `dma_cps` from requests to Google measurement/ads endpoints
 * and decodes them. All decoding is best effort: Google does not document these formats.
 */
import { getDomain } from 'tldts';
import type { ConsentModePing } from '../../types.js';

export type ConsentState = 'granted' | 'denied' | 'unbekannt';

/** ConsentModePing plus the additional signals decoded from `gcd`. */
export interface ConsentModePingDetail extends ConsentModePing {
  dmaCps?: string;
  adUserData?: ConsentState;
  adPersonalization?: ConsentState;
  /** Decoded per-signal state from `gcd` (ad_storage, analytics_storage, ad_user_data, ad_personalization). */
  gcdDecoded?: GcdDecoded;
}

export interface GcdSignalState {
  letter: string;
  /** Effective state (the update wins over the default). */
  state: ConsentState | 'nicht-gesetzt';
  /** Human readable (German) description of the letter. */
  description: string;
}

export interface GcdDecoded {
  adStorage: GcdSignalState;
  analyticsStorage: GcdSignalState;
  adUserData: GcdSignalState;
  adPersonalization: GcdSignalState;
}

/** Registrable domains of Google endpoints that carry consent mode parameters. */
const GOOGLE_DOMAINS = new Set([
  'google-analytics.com',
  'googletagmanager.com',
  'doubleclick.net',
  'googleadservices.com',
  'googlesyndication.com',
]);
const GOOGLE_PATH_PREFIXES = ['/pagead/', '/ccm/', '/g/collect', '/j/collect'];

export function isConsentModeCandidate(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  const domain = getDomain(host);
  if (domain && GOOGLE_DOMAINS.has(domain)) return true;
  if (host === 'analytics.google.com') return true;
  if (domain === 'google.com' && GOOGLE_PATH_PREFIXES.some((p) => u.pathname.startsWith(p))) {
    return true;
  }
  return false;
}

/**
 * gcs = "G1" + ad_storage + analytics_storage, each "1" = granted, "0" = denied.
 * G100 = both denied, G111 = both granted, G101 = ad denied / analytics granted.
 */
export function decodeGcs(
  gcs: string,
): { adStorage: 'granted' | 'denied'; analyticsStorage: 'granted' | 'denied' } | undefined {
  const m = /^G1([01])([01])$/.exec(gcs);
  if (!m) return undefined;
  return {
    adStorage: m[1] === '1' ? 'granted' : 'denied',
    analyticsStorage: m[2] === '1' ? 'granted' : 'denied',
  };
}

/**
 * Letters used by `gcd` for one signal. Community-reverse-engineered mapping:
 *   l = not set (no default, no update)       p = default denied
 *   t = default granted                       q = default denied, update denied
 *   r = default denied, update granted        u = default granted, update denied
 *   v = default granted, update granted       m = update denied (no default)
 *   n = update granted (no default)
 * Anything else -> 'unbekannt'.
 */
const GCD_LETTERS: Record<string, { state: GcdSignalState['state']; description: string }> = {
  l: { state: 'nicht-gesetzt', description: 'weder Default noch Update gesetzt' },
  p: { state: 'denied', description: 'Default verweigert' },
  t: { state: 'granted', description: 'Default erteilt' },
  q: { state: 'denied', description: 'Default verweigert, Update verweigert' },
  r: { state: 'granted', description: 'Default verweigert, Update erteilt' },
  u: { state: 'denied', description: 'Default erteilt, Update verweigert' },
  v: { state: 'granted', description: 'Default erteilt, Update erteilt' },
  m: { state: 'denied', description: 'Update verweigert' },
  n: { state: 'granted', description: 'Update erteilt' },
};

function gcdSignal(letter: string | undefined): GcdSignalState {
  const known = letter ? GCD_LETTERS[letter.toLowerCase()] : undefined;
  if (!letter || !known)
    return { letter: letter ?? '', state: 'unbekannt', description: 'unbekannt' };
  return { letter, ...known };
}

/**
 * gcd looks like `11t1t1t1t5` / `13r3r3r2r5`: a two character prefix (format version/marker),
 * followed by one `<letter><digit>` pair per signal in the order ad_storage, analytics_storage,
 * ad_user_data, ad_personalization (the digit is a source marker). Trailing characters are ignored.
 */
export function decodeGcd(gcd: string): GcdDecoded | undefined {
  const m = /^\d{2}(?:([a-z])\d)?(?:([a-z])\d)?(?:([a-z])\d)?(?:([a-z])\d)?/i.exec(gcd);
  if (!m || !m[1]) return undefined;
  return {
    adStorage: gcdSignal(m[1]),
    analyticsStorage: gcdSignal(m[2]),
    adUserData: gcdSignal(m[3]),
    adPersonalization: gcdSignal(m[4]),
  };
}

function toConsent(s: GcdSignalState['state']): ConsentState | undefined {
  return s === 'nicht-gesetzt' ? undefined : s;
}

function paramsOf(url: URL, postBody?: string): URLSearchParams[] {
  const lists = [url.searchParams];
  if (postBody) {
    // GA4 batches: newline-separated `k=v&k=v` lines (or a single query-string-like body).
    for (const line of postBody.split(/\r?\n/)) {
      const t = line.trim();
      if (t.includes('=')) lists.push(new URLSearchParams(t));
    }
  }
  return lists;
}

export interface ParseOptions {
  time?: number;
  requestId?: string;
}

/** Returns undefined for non-Google URLs or requests without any consent mode parameter. */
export function parseConsentModePing(
  url: string,
  postBody?: string,
  opts: ParseOptions = {},
): ConsentModePingDetail | undefined {
  if (!isConsentModeCandidate(url)) return undefined;
  const u = new URL(url);
  const lists = paramsOf(u, postBody);
  const get = (k: string): string | undefined => {
    for (const p of lists) {
      const v = p.get(k);
      if (v) return v;
    }
    return undefined;
  };
  const gcs = get('gcs');
  const gcd = get('gcd');
  const npa = get('npa');
  const dma = get('dma');
  const dmaCps = get('dma_cps');
  if (!gcs && !gcd && npa === undefined && dma === undefined) return undefined;

  const ping: ConsentModePingDetail = {
    url,
    host: u.hostname.toLowerCase(),
    time: opts.time ?? 0,
    advancedMode: false,
  };
  if (opts.requestId) ping.requestId = opts.requestId;
  if (gcs) ping.gcs = gcs;
  if (gcd) ping.gcd = gcd;
  if (npa !== undefined) ping.npa = npa;
  if (dma !== undefined) ping.dma = dma;
  if (dmaCps) ping.dmaCps = dmaCps;

  const g = gcs ? decodeGcs(gcs) : undefined;
  if (g) {
    ping.adStorage = g.adStorage;
    ping.analyticsStorage = g.analyticsStorage;
  }
  const d = gcd ? decodeGcd(gcd) : undefined;
  if (d) {
    ping.gcdDecoded = d;
    const ad = toConsent(d.adStorage.state);
    const an = toConsent(d.analyticsStorage.state);
    // gcs wins; gcd fills gaps.
    if (!ping.adStorage && (ad === 'granted' || ad === 'denied')) ping.adStorage = ad;
    if (!ping.analyticsStorage && (an === 'granted' || an === 'denied')) ping.analyticsStorage = an;
    const aud = toConsent(d.adUserData.state);
    const adp = toConsent(d.adPersonalization.state);
    if (aud) ping.adUserData = aud;
    if (adp) ping.adPersonalization = adp;
  }
  ping.advancedMode = isAdvancedModePing(ping);
  return ping;
}

/**
 * Advanced Mode = a ping was sent although consent is denied (e.g. gcs=G100): Google tags fire
 * cookieless pings before/without consent. True if ad_storage or analytics_storage is denied.
 */
export function isAdvancedModePing(
  ping: Pick<ConsentModePing, 'adStorage' | 'analyticsStorage'>,
): boolean {
  return ping.adStorage === 'denied' || ping.analyticsStorage === 'denied';
}
