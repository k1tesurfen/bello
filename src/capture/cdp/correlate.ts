/**
 * Correlates socket-level evidence (NetLog) with CDP requests so that every connection gets a
 * cause (PLAN §5.2 "Abgleich NetLog ↔ CDP über URL + Zeit").
 *
 * Matching strategy per host:
 *  1. `url`: a NetLog URL request and a CDP request share the same URL (fragment ignored) and
 *     start within {@link CorrelateOptions.urlWindowMs} of each other.
 *  2. `host-time`: otherwise the CDP request to the same host whose start is closest to the
 *     first connection attempt (within {@link CorrelateOptions.hostWindowMs}). Chromium may
 *     preconnect a few ms *before* the request is announced (navigation predictor), so the
 *     window is symmetric.
 * Hosts with sockets but no request at all keep `causes: []` and `wasPreconnectOnly: true`;
 * resource hints are matched against the raw HTML by a later analysis step.
 */
import { isChromeInternalHost } from '../../browser/launch.js';
import type { ConnectionCause, HostConnection, RequestRecord } from '../../types.js';

export interface CorrelateOptions {
  /** Max |NetLog start − CDP start| for URL matches (default 3000 ms). */
  urlWindowMs?: number;
  /** Max |connect − CDP start| for host/time matches (default 10000 ms). */
  hostWindowMs?: number;
}

function normalizeUrl(url: string): string {
  const i = url.indexOf('#');
  return i >= 0 ? url.slice(0, i) : url;
}

function causeFrom(
  r: RequestRecord,
  match: ConnectionCause['match'],
  deltaMs?: number,
): ConnectionCause {
  return {
    requestId: r.id,
    url: r.url,
    initiator: r.initiator,
    resourceType: r.resourceType,
    match,
    ...(r.frameUrl ? { frameUrl: r.frameUrl } : {}),
    ...(deltaMs !== undefined ? { deltaMs } : {}),
  };
}

/**
 * Sets `causes` on each connection (mutates and returns the same array). Causes are ordered by
 * CDP request start time, so `causes[0]` is the earliest explanation.
 */
export function correlate(
  connections: HostConnection[],
  requests: readonly RequestRecord[],
  opts: CorrelateOptions = {},
): HostConnection[] {
  const urlWindow = opts.urlWindowMs ?? 3000;
  const hostWindow = opts.hostWindowMs ?? 10_000;

  const byHost = new Map<string, RequestRecord[]>();
  for (const r of requests) {
    if (!r.host) continue;
    const list = byHost.get(r.host) ?? [];
    list.push(r);
    byHost.set(r.host, list);
  }

  for (const conn of connections) {
    const candidates = (byHost.get(conn.host) ?? [])
      .slice()
      .sort((a, b) => a.startTime - b.startTime);
    const causes: ConnectionCause[] = [];
    const used = new Set<string>();

    for (const nr of conn.urlRequests) {
      const target = normalizeUrl(nr.url);
      let best: RequestRecord | undefined;
      let bestDelta = Infinity;
      for (const r of candidates) {
        if (used.has(r.id) || normalizeUrl(r.url) !== target) continue;
        const delta = Math.abs(r.startTime - nr.startTime);
        if (delta <= urlWindow && delta < bestDelta) {
          best = r;
          bestDelta = delta;
        }
      }
      if (best) {
        used.add(best.id);
        causes.push(causeFrom(best, 'url', bestDelta));
      }
    }

    if (!causes.length && candidates.length) {
      const ref = conn.firstConnectAt ?? conn.dns?.startTime ?? conn.firstSeen;
      let best: RequestRecord | undefined;
      let bestDelta = Infinity;
      for (const r of candidates) {
        const delta = Math.abs(r.startTime - ref);
        if (delta <= hostWindow && delta < bestDelta) {
          best = r;
          bestDelta = delta;
        }
      }
      if (best) causes.push(causeFrom(best, 'host-time', bestDelta));
    }

    const start = new Map(candidates.map((r) => [r.id, r.startTime]));
    conn.causes = causes.sort(
      (a, b) => (start.get(a.requestId) ?? 0) - (start.get(b.requestId) ?? 0),
    );
  }
  return connections;
}

/**
 * True if a connection was most likely opened by Chromium itself, not by the page. Call after
 * {@link correlate}: connections with a CDP cause are never background traffic.
 *
 * Observed with Chromium 156 despite all suppression flags: `accounts.google.com/ListAccounts`
 * (Gaia cookie manager), `update.googleapis.com` (updater) and a startup preconnect to the
 * search engine. Rules:
 *  - known Chrome-internal host (see `CHROME_INTERNAL_HOSTS`), or
 *  - all URL requests are browser-initiated (`not an origin`) and not navigations, or
 *  - socket/DNS activity without any request that started before navigation (t < 0).
 */
export function isBrowserBackgroundConnection(conn: HostConnection): boolean {
  if (conn.causes?.length) return false;
  if (isChromeInternalHost(conn.host)) return true;
  if (
    conn.urlRequests.length > 0 &&
    conn.urlRequests.every(
      (r) =>
        r.initiatorOrigin === 'not an origin' &&
        r.requestType !== 'main frame' &&
        r.requestType !== 'subframe',
    )
  ) {
    return true;
  }
  return !conn.requested && conn.firstSeen < 0;
}
