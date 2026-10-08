/**
 * Capture sanity checks (PLAN §7 "never green for something that did not happen").
 *
 * A scenario whose NetLog does not even contain the connection to the main document host was
 * not captured properly (NetLog written for the wrong process, truncated, empty, …) – every
 * "no third-party connection" conclusion drawn from it would be worthless.
 */
import type { HostConnection, NetLogUrlRequest } from '../types.js';

/** True if the URL request's headers were demonstrably sent (pooled HTTP/2/QUIC included). */
export function requestReachedServer(r: NetLogUrlRequest): boolean {
  return r.headersSent === true;
}

/** True if the NetLog proves bytes went to this host (own socket or sent request headers). */
export function hasSocketEvidence(c: HostConnection): boolean {
  return Boolean(c.tcp || c.tls || c.quic || c.urlRequests.some(requestReachedServer));
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return undefined;
  }
}

/**
 * Requires NetLog TCP/TLS/QUIC evidence (or sent request headers) for at least one of the main
 * document hosts (requested URL / final URL after redirects).
 */
export function mainDocumentCaptured(
  connections: readonly HostConnection[],
  urls: readonly string[],
): { ok: true } | { ok: false; reason: string } {
  const hosts = [...new Set(urls.map(hostOf).filter((h): h is string => Boolean(h)))];
  if (hosts.length === 0) return { ok: true };
  const ok = connections.some((c) => hosts.includes(c.host) && hasSocketEvidence(c));
  if (ok) return { ok: true };
  return {
    ok: false,
    reason: `Im NetLog fehlt die Verbindung zur Hauptseite (${hosts.join(', ')}) – der Netzwerk-Mitschnitt ist unvollständig oder unbrauchbar; manuelle Prüfung nötig.`,
  };
}
