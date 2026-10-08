/**
 * Severity rules (PLAN §7) for third-party connections and storage matches.
 *
 * KRITISCH/HOCH/MITTEL are only ever assigned to *real* connections (TCP/TLS/QUIC or a request
 * that demonstrably reached the host) in scenario A or B. DNS-only activity and everything that
 * only happened in scenario C (with consent) is INFO.
 */
import type {
  Classification,
  HostConnection,
  RequestRecord,
  ScenarioId,
  Severity,
  TrackingMatchRef,
} from '../types.js';
import { SEVERITY_ORDER } from '../types.js';

/** Vendor categories that count as tracking ("bekannter Tracker"). */
export const TRACKING_CATEGORIES: ReadonlySet<string> = new Set([
  'werbung',
  'analyse',
  'social',
  'tag-manager',
]);

/** Which rule decided a connection's severity. */
export type ConnectionRule =
  | 'first-party'
  | 'nur-c'
  | 'nur-dns'
  | 'allowlist'
  | 'cmp'
  | 'tracker'
  | 'drittland'
  | 'eu-vendor'
  | 'unbekannt'
  | 'unbestaetigt';

export interface ConnectionRating {
  /** `null` for first-party hosts (never a finding). */
  severity: Severity | null;
  rule: ConnectionRule;
}

/** True if the classification marks the host as a known tracker (PLAN §7 "bekannter Tracker"). */
export function isKnownTracker(cls: Classification): boolean {
  if (cls.easyPrivacy) return true;
  const cat = cls.vendor?.category;
  return cat !== undefined && TRACKING_CATEGORIES.has(cat);
}

export function isCmpVendor(cls: Classification): boolean {
  return cls.vendor?.category === 'cmp';
}

/**
 * Severity of one occurrence of a host in one scenario.
 * @param real a real connection (IP transmitted), not just DNS.
 */
export function rateConnection(
  cls: Classification,
  scenario: ScenarioId,
  real: boolean,
  unverified = false,
): ConnectionRating {
  if (cls.firstParty) return { severity: null, rule: 'first-party' };
  if (scenario === 'C') return { severity: 'INFO', rule: 'nur-c' };
  if (unverified && !real) {
    // A page request to this host exists (CDP) but the NetLog has no trace of it: the attempt is
    // proven, the (non-)transmission is not. Never INFO – at least HOCH, i.e. manual review.
    if (cls.allowlist) return { severity: 'INFO', rule: 'allowlist' };
    if (isCmpVendor(cls)) return { severity: 'INFO', rule: 'cmp' };
    return { severity: 'HOCH', rule: 'unbestaetigt' };
  }
  if (!real) return { severity: 'INFO', rule: 'nur-dns' };
  if (cls.allowlist) return { severity: 'INFO', rule: 'allowlist' };
  if (isCmpVendor(cls)) return { severity: 'INFO', rule: 'cmp' };
  if (isKnownTracker(cls)) return { severity: 'KRITISCH', rule: 'tracker' };
  if (cls.vendor && cls.thirdCountry === true) return { severity: 'KRITISCH', rule: 'drittland' };
  if (cls.vendor) return { severity: 'MITTEL', rule: 'eu-vendor' };
  return { severity: 'HOCH', rule: 'unbekannt' };
}

/**
 * True if the user's IP was transmitted to the host: TCP/TLS/QUIC seen in the NetLog, or a URL
 * request / CDP request that got an answer without its own socket (HTTP/2 connection
 * coalescing, proxy).
 */
export function isRealConnection(conn: HostConnection, requests: RequestRecord[] = []): boolean {
  if (conn.level === 'connect' || conn.level === 'tls') return true;
  if (conn.tcp || conn.tls || conn.quic) return true;
  if (conn.urlRequests.some((r) => !r.aborted && r.netError === undefined)) return true;
  // Pooled HTTP/2 / QUIC session (no own socket): sent request headers prove the transmission,
  // even if the request was aborted afterwards (e.g. by a late autoblocker).
  if (conn.urlRequests.some((r) => r.headersSent === true)) return true;
  return requests.some(
    (r) => r.host === conn.host && !r.failed && r.status !== undefined && r.status > 0,
  );
}

/**
 * A storage/cookie match is tracking unless it belongs to a CMP (consent storage) or the vendor
 * list explicitly marks the cookie/key as technically necessary (`necessary: true`, e.g.
 * Cloudflare `__cf_bm`). Non-tracking *vendor categories* (video, cdn, payment, …) do not
 * exempt a cookie: YouTube's `VISITOR_INFO1_LIVE` or Google's `NID` identify the visitor
 * regardless of the vendor's main business (§ 25 TDDDG).
 */
export function isTrackingMatch(m: TrackingMatchRef | undefined): boolean {
  if (!m) return false;
  if (m.necessary === true) return false;
  if (m.category === 'cmp') return false;
  return true;
}

export function severityRank(s: Severity): number {
  return SEVERITY_ORDER.indexOf(s);
}

/** The more severe of two severities. */
export function maxSeverity(a: Severity, b: Severity): Severity {
  return severityRank(a) <= severityRank(b) ? a : b;
}
