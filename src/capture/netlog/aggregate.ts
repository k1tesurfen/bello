/**
 * Aggregates NetLog events into per-host connection evidence (PLAN §5.1).
 *
 * How sockets are attributed to hosts: a socket (source type SOCKET) is created by a connect job
 * (`SOCKET_ALIVE.source_dependency`, or `CONNECT_JOB_SET_SOCKET` on the job). The connect job
 * logs `SOCKET_POOL_CONNECT_JOB_CREATED` with a `group_id` such as
 * `https://www.youtube.com <http://kunde-test.de cross_site>` (optionally prefixed, e.g. `pm/`),
 * which names the *logical* destination host. This keeps attribution correct even when the host
 * was remapped (`--host-resolver-rules`) or several hosts share an IP.
 */
import type { HostConnection, NetLogUrlRequest } from '../../types.js';
import { readNetLog, type NetLogEvent, type ParsedNetLog } from './parse.js';

export interface AggregateOptions {
  /**
   * Hosts for which this returns true are dropped. Do NOT pass Chrome-internal hosts here – those
   * are filtered after correlation (`isBrowserBackgroundConnection`), because a page may request
   * them itself.
   */
  ignoreHost?: (host: string) => boolean;
}

interface Endpoint {
  scheme?: string;
  host: string;
  port?: number;
}

const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443, ws: 80, wss: 443 };

/**
 * Parses host strings found in NetLog params: URLs (`https://h:443/x`), socket group ids
 * (`pm/https://h <nak>`, legacy `ssl/h:443`), resolver hosts (`https://h`, `h:443`).
 */
export function parseNetLogEndpoint(value: string): Endpoint | undefined {
  const s = value.trim().split(/\s+/)[0] ?? '';
  const m = /([a-z][a-z0-9+.-]*):\/\/(\[[^\]]+\]|[^/:?#\s]+)(?::(\d+))?/i.exec(s);
  if (m) {
    const scheme = m[1]!.toLowerCase();
    const host = m[2]!.toLowerCase().replace(/^\[|\]$/g, '');
    const port = m[3] ? Number(m[3]) : DEFAULT_PORTS[scheme];
    return { scheme, host, ...(port !== undefined ? { port } : {}) };
  }
  // Legacy formats: "ssl/host:443", "host:443"
  const legacy = /^(?:(ssl|http|https)\/)?(\[[^\]]+\]|[^/:\s]+)(?::(\d+))?$/i.exec(s);
  if (legacy) {
    const scheme = legacy[1]?.toLowerCase() === 'ssl' ? 'https' : legacy[1]?.toLowerCase();
    return {
      ...(scheme ? { scheme } : {}),
      host: legacy[2]!.toLowerCase().replace(/^\[|\]$/g, ''),
      ...(legacy[3] ? { port: Number(legacy[3]) } : {}),
    };
  }
  return undefined;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
export function isIpLiteral(host: string): boolean {
  return IPV4.test(host) || host.includes(':');
}

/** Strips the port from `ip:port` / `[v6]:port`. */
export function ipFromAddress(address: string): string {
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(address);
  if (v6) return v6[1]!;
  const idx = address.lastIndexOf(':');
  return idx > 0 && address.indexOf(':') === idx ? address.slice(0, idx) : address;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function dep(params: Record<string, unknown>): number | undefined {
  const d = params.source_dependency as { id?: unknown } | undefined;
  return typeof d?.id === 'number' ? d.id : undefined;
}
function netError(params: Record<string, unknown>): number | undefined {
  return typeof params.net_error === 'number' ? params.net_error : undefined;
}

/** Mutable per-host accumulator; times are epoch ms until finalised. */
interface HostAcc {
  host: string;
  ports: Set<number>;
  dns?: { start: number; end?: number; addresses: Set<string>; error?: number };
  tcp?: { start: number; end?: number; addresses: Set<string>; count: number; connected: boolean };
  tls?: {
    start: number;
    end?: number;
    sni?: string;
    count: number;
    established: boolean;
    version?: string;
  };
  quic?: { start: number; addresses: Set<string>; count: number };
  remoteIps: Set<string>;
  urlRequests: Array<Omit<NetLogUrlRequest, 'startTime'> & { start: number }>;
  sawPreconnect: boolean;
  firstSeen: number;
}

interface SocketAcc {
  jobId?: number;
  tcpAttempts: Array<{ time: number; address?: string }>;
  tcpConnectStart?: number;
  tcpConnectEnd?: number;
  tcpRemote?: string;
  tcpAddressList: string[];
  tcpError?: number;
  sslStart?: number;
  sslEnd?: number;
  sslOk?: boolean;
  sslVersion?: string;
  sslCount: number;
}

interface DnsJobAcc {
  host?: string;
  start: number;
  end?: number;
  addresses: Set<string>;
  error?: number;
}

/** Collects DNS result addresses from the various resolver param shapes. */
function collectAddresses(params: Record<string, unknown>, into: Set<string>): void {
  const list = params.address_list;
  if (Array.isArray(list))
    for (const a of list) if (typeof a === 'string') into.add(ipFromAddress(a));
  const visit = (results: unknown): void => {
    if (!Array.isArray(results)) return;
    for (const r of results) {
      const eps = (r as { endpoints?: unknown })?.endpoints;
      if (Array.isArray(eps))
        for (const ep of eps) {
          const addr = (ep as { address?: unknown })?.address;
          if (typeof addr === 'string') into.add(ipFromAddress(addr));
        }
    }
  };
  visit(params.results);
  const nested = params.results as { ip_endpoints?: unknown } | undefined;
  if (nested && !Array.isArray(nested) && Array.isArray(nested.ip_endpoints)) {
    for (const ep of nested.ip_endpoints) {
      const addr = (ep as { address?: unknown })?.address;
      if (typeof addr === 'string') into.add(ipFromAddress(addr));
    }
  }
}

/**
 * Aggregates a parsed NetLog into one {@link HostConnection} per host.
 * @param navigationStart epoch ms used as t = 0 for all relative times.
 */
export function aggregateHostConnections(
  log: ParsedNetLog,
  navigationStart: number,
  opts: AggregateOptions = {},
): HostConnection[] {
  const hosts = new Map<string, HostAcc>();
  const jobEndpoint = new Map<number, Endpoint>();
  const sockets = new Map<number, SocketAcc>();
  const dnsJobs = new Map<number, DnsJobAcc>();
  const quicSessions = new Map<number, { ep: Endpoint; start: number; addresses: Set<string> }>();
  const urlRequestCurrent = new Map<number, string>();
  const urlRequestLast = new Map<number, HostAcc['urlRequests'][number]>();

  const acc = (host: string, time: number): HostAcc => {
    let h = hosts.get(host);
    if (!h) {
      h = {
        host,
        ports: new Set(),
        remoteIps: new Set(),
        urlRequests: [],
        sawPreconnect: false,
        firstSeen: time,
      };
      hosts.set(host, h);
    }
    if (time < h.firstSeen) h.firstSeen = time;
    return h;
  };
  const socket = (id: number): SocketAcc => {
    let s = sockets.get(id);
    if (!s) {
      s = { tcpAttempts: [], tcpAddressList: [], sslCount: 0 };
      sockets.set(id, s);
    }
    return s;
  };
  const resolverHost = (value: unknown): string | undefined => {
    const ep = typeof value === 'string' ? parseNetLogEndpoint(value) : undefined;
    if (!ep || isIpLiteral(ep.host) || ep.host.startsWith('~')) return undefined;
    return ep.host;
  };

  for (const e of log.events) {
    handleEvent(e);
  }

  function handleEvent(e: NetLogEvent): void {
    const p = e.params;
    switch (e.type) {
      // ---- socket pools / connect jobs ------------------------------------------------
      case 'SOCKET_POOL_CONNECT_JOB_CREATED': {
        const ep = str(p.group_id) && parseNetLogEndpoint(str(p.group_id)!);
        if (ep) jobEndpoint.set(e.sourceId, ep);
        break;
      }
      case 'CONNECT_JOB_SET_SOCKET': {
        const sid = dep(p);
        if (sid !== undefined) socket(sid).jobId ??= e.sourceId;
        break;
      }
      case 'TCP_CLIENT_SOCKET_POOL_REQUESTED_SOCKETS': {
        // Plural = preconnect of N sockets (no request bound yet).
        const ep = str(p.group_id) && parseNetLogEndpoint(str(p.group_id)!);
        if (ep) acc(ep.host, e.time).sawPreconnect = true;
        break;
      }
      case 'HTTP_STREAM_JOB_CONTROLLER': {
        if (e.phase === 'begin' && p.is_preconnect === true) {
          const ep = str(p.url) && parseNetLogEndpoint(str(p.url)!);
          if (ep) acc(ep.host, e.time).sawPreconnect = true;
        }
        break;
      }
      // ---- sockets ------------------------------------------------------------------------
      case 'SOCKET_ALIVE': {
        if (e.sourceType === 'SOCKET' && e.phase === 'begin') {
          const jid = dep(p);
          if (jid !== undefined) socket(e.sourceId).jobId ??= jid;
        }
        break;
      }
      case 'TCP_CONNECT_ATTEMPT': {
        if (e.phase === 'begin') {
          const address = str(p.address);
          socket(e.sourceId).tcpAttempts.push({ time: e.time, ...(address ? { address } : {}) });
        }
        break;
      }
      case 'TCP_CONNECT': {
        const s = socket(e.sourceId);
        if (e.phase === 'begin') {
          s.tcpConnectStart ??= e.time;
          if (Array.isArray(p.address_list))
            for (const a of p.address_list) if (typeof a === 'string') s.tcpAddressList.push(a);
        } else if (e.phase === 'end') {
          s.tcpConnectEnd = e.time;
          const remote = str(p.remote_address);
          if (remote) s.tcpRemote = remote;
          const err = netError(p);
          if (err !== undefined) s.tcpError = err;
        }
        break;
      }
      case 'SSL_CONNECT': {
        const s = socket(e.sourceId);
        if (e.phase === 'begin') {
          s.sslStart ??= e.time;
          s.sslCount++;
        } else if (e.phase === 'end') {
          s.sslEnd = e.time;
          const err = netError(p);
          if (err === undefined) {
            s.sslOk = true;
            if (str(p.version)) s.sslVersion = str(p.version);
          }
        }
        break;
      }
      // ---- QUIC -----------------------------------------------------------------------------
      case 'QUIC_SESSION': {
        if (e.phase === 'begin' && typeof p.host === 'string') {
          const port = typeof p.port === 'number' ? p.port : 443;
          quicSessions.set(e.sourceId, {
            ep: { scheme: 'https', host: p.host.toLowerCase(), port },
            start: e.time,
            addresses: new Set(),
          });
        }
        break;
      }
      // ---- DNS ------------------------------------------------------------------------------
      case 'HOST_RESOLVER_MANAGER_JOB':
      case 'HOST_RESOLVER_IMPL_JOB': {
        if (e.phase === 'begin') {
          const host = resolverHost(p.host);
          dnsJobs.set(e.sourceId, {
            ...(host ? { host } : {}),
            start: e.time,
            addresses: new Set(),
          });
        } else if (e.phase === 'end') {
          const j = dnsJobs.get(e.sourceId);
          if (j) {
            j.end = e.time;
            const err = netError(p);
            if (err !== undefined) j.error = err;
          }
        }
        break;
      }
      case 'HOST_RESOLVER_MANAGER_REQUEST':
      case 'HOST_RESOLVER_IMPL_REQUEST': {
        if (e.phase === 'begin') {
          const host = resolverHost(p.host);
          if (host) {
            const h = acc(host, e.time);
            h.dns ??= { start: e.time, addresses: new Set() };
            if (e.time < h.dns.start) h.dns.start = e.time;
          }
        }
        break;
      }
      // ---- URL requests ---------------------------------------------------------------------
      case 'REQUEST_ALIVE': {
        if (e.sourceType !== 'URL_REQUEST') break;
        if (e.phase === 'begin' && str(p.url)) urlRequestCurrent.set(e.sourceId, str(p.url)!);
        else if (e.phase === 'end') {
          const last = urlRequestLast.get(e.sourceId);
          const err = netError(p);
          if (last && err !== undefined && last.netError === undefined) {
            last.netError = err;
            last.aborted = err === -3;
          }
        }
        break;
      }
      case 'URL_REQUEST_REDIRECTED': {
        if (str(p.location)) urlRequestCurrent.set(e.sourceId, str(p.location)!);
        break;
      }
      case 'URL_REQUEST_START_JOB': {
        if (e.phase === 'begin') {
          const url = str(p.url) ?? urlRequestCurrent.get(e.sourceId);
          if (!url) break;
          urlRequestCurrent.set(e.sourceId, url);
          let host: string;
          try {
            const u = new URL(url);
            if (!/^(https?|wss?):$/.test(u.protocol)) break;
            host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
          } catch {
            break;
          }
          const rec: HostAcc['urlRequests'][number] = {
            url,
            start: e.time,
            aborted: false,
            sourceId: e.sourceId,
            ...(str(p.method) ? { method: str(p.method)! } : {}),
            ...(str(p.request_type) ? { requestType: str(p.request_type)! } : {}),
            ...(str(p.initiator) ? { initiatorOrigin: str(p.initiator)! } : {}),
            ...(str(p.network_isolation_key)
              ? { networkIsolationKey: str(p.network_isolation_key)! }
              : {}),
          };
          acc(host, e.time).urlRequests.push(rec);
          urlRequestLast.set(e.sourceId, rec);
        } else if (e.phase === 'end') {
          const err = netError(p);
          const last = urlRequestLast.get(e.sourceId);
          if (last && err !== undefined) {
            last.netError = err;
            last.aborted = err === -3;
          }
        }
        break;
      }
      case 'HTTP_TRANSACTION_SEND_REQUEST':
      case 'HTTP_TRANSACTION_SEND_REQUEST_HEADERS':
      case 'HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS':
      case 'HTTP_TRANSACTION_QUIC_SEND_REQUEST_HEADERS': {
        // Logged on the URL_REQUEST source once the request headers are written to a stream –
        // whether the stream has its own socket or rides a pooled HTTP/2 / QUIC session.
        if (e.sourceType !== 'URL_REQUEST' || e.phase === 'end') break;
        const last = urlRequestLast.get(e.sourceId);
        if (last) last.headersSent = true;
        break;
      }
      case 'CANCELLED': {
        const last = urlRequestLast.get(e.sourceId);
        if (last) {
          last.aborted = true;
          last.netError ??= netError(p) ?? -3;
        }
        break;
      }
      default:
        break;
    }

    // DNS results and QUIC peer addresses can appear on many different event types.
    const job = dnsJobs.get(e.sourceId);
    if (job && e.sourceType !== 'SOCKET') collectAddresses(p, job.addresses);
    const qs = quicSessions.get(e.sourceId);
    if (qs && typeof p.peer_address === 'string') qs.addresses.add(p.peer_address);
  }

  // ---- fold DNS jobs into hosts --------------------------------------------------------------
  for (const j of dnsJobs.values()) {
    if (!j.host) continue;
    const h = acc(j.host, j.start);
    h.dns ??= { start: j.start, addresses: new Set() };
    if (j.start < h.dns.start) h.dns.start = j.start;
    if (j.end !== undefined) h.dns.end = Math.max(h.dns.end ?? j.end, j.end);
    for (const a of j.addresses) h.dns.addresses.add(a);
    if (j.error !== undefined && j.addresses.size === 0) h.dns.error = j.error;
  }

  // ---- fold sockets into hosts ---------------------------------------------------------------
  for (const s of sockets.values()) {
    if (s.jobId === undefined) continue;
    const ep = jobEndpoint.get(s.jobId);
    if (!ep) continue;
    const attempts = s.tcpAttempts.length
      ? s.tcpAttempts
      : s.tcpConnectStart !== undefined
        ? [{ time: s.tcpConnectStart, address: s.tcpAddressList[0] }]
        : [];
    if (!attempts.length && s.sslStart === undefined) continue;
    const first = attempts[0]?.time ?? s.sslStart!;
    const h = acc(ep.host, first);
    if (ep.port !== undefined) h.ports.add(ep.port);

    if (attempts.length) {
      h.tcp ??= { start: first, addresses: new Set(), count: 0, connected: false };
      if (first < h.tcp.start) h.tcp.start = first;
      h.tcp.count += attempts.length;
      for (const a of attempts) {
        if (a.address) {
          h.tcp.addresses.add(a.address);
          h.remoteIps.add(ipFromAddress(a.address));
        }
      }
      if (s.tcpRemote) {
        h.tcp.addresses.add(s.tcpRemote);
        h.remoteIps.add(ipFromAddress(s.tcpRemote));
      }
      if (s.tcpConnectEnd !== undefined && s.tcpError === undefined && s.tcpRemote) {
        h.tcp.connected = true;
        h.tcp.end =
          h.tcp.end === undefined ? s.tcpConnectEnd : Math.min(h.tcp.end, s.tcpConnectEnd);
      }
    }
    if (s.sslStart !== undefined) {
      h.tls ??= { start: s.sslStart, count: 0, established: false };
      if (s.sslStart < h.tls.start) h.tls.start = s.sslStart;
      h.tls.count += s.sslCount;
      if (ep.scheme === 'https' || ep.scheme === 'wss') h.tls.sni = ep.host;
      if (s.sslOk) {
        if (!h.tls.established && s.sslVersion) h.tls.version = s.sslVersion;
        h.tls.established = true;
        if (s.sslEnd !== undefined)
          h.tls.end = h.tls.end === undefined ? s.sslEnd : Math.min(h.tls.end, s.sslEnd);
      }
    }
  }

  // ---- fold QUIC sessions --------------------------------------------------------------------
  for (const q of quicSessions.values()) {
    const h = acc(q.ep.host, q.start);
    if (q.ep.port !== undefined) h.ports.add(q.ep.port);
    h.quic ??= { start: q.start, addresses: new Set(), count: 0 };
    if (q.start < h.quic.start) h.quic.start = q.start;
    h.quic.count++;
    for (const a of q.addresses) {
      h.quic.addresses.add(a);
      h.remoteIps.add(ipFromAddress(a));
    }
  }

  // ---- finalise -------------------------------------------------------------------------------
  const rel = (t: number): number => Math.round(t - navigationStart);
  const out: HostConnection[] = [];
  for (const h of hosts.values()) {
    if (opts.ignoreHost?.(h.host)) continue;
    for (const r of h.urlRequests) {
      try {
        const u = new URL(r.url);
        h.ports.add(u.port ? Number(u.port) : (DEFAULT_PORTS[u.protocol.slice(0, -1)] ?? 0));
      } catch {
        /* ignore */
      }
    }
    const connectTimes = [h.tcp?.start, h.quic?.start].filter((t): t is number => t !== undefined);
    const firstConnect = connectTimes.length ? Math.min(...connectTimes) : undefined;
    const requested = h.urlRequests.length > 0;
    const level: HostConnection['level'] = h.tls
      ? 'tls'
      : h.tcp || h.quic
        ? 'connect'
        : h.dns
          ? 'dns'
          : 'none';

    const conn: HostConnection = {
      host: h.host,
      ports: [...h.ports].sort((a, b) => a - b),
      remoteIps: [...h.remoteIps],
      urlRequests: h.urlRequests.map(({ start, ...r }) => ({ ...r, startTime: rel(start) })),
      wasPreconnectOnly: firstConnect !== undefined && !requested,
      sawPreconnect: h.sawPreconnect,
      firstSeen: rel(h.firstSeen),
      level,
      requested,
    };
    if (firstConnect !== undefined) conn.firstConnectAt = rel(firstConnect);
    if (h.dns) {
      conn.dns = { startTime: rel(h.dns.start), addresses: [...h.dns.addresses] };
      if (h.dns.end !== undefined) conn.dns.endTime = rel(h.dns.end);
      if (h.dns.error !== undefined) conn.dns.error = h.dns.error;
    }
    if (h.tcp) {
      conn.tcp = {
        startTime: rel(h.tcp.start),
        remoteAddresses: [...h.tcp.addresses],
        count: h.tcp.count,
        connected: h.tcp.connected,
      };
      if (h.tcp.end !== undefined) conn.tcp.endTime = rel(h.tcp.end);
    }
    if (h.tls) {
      conn.tls = {
        startTime: rel(h.tls.start),
        count: h.tls.count,
        established: h.tls.established,
      };
      if (h.tls.end !== undefined) conn.tls.endTime = rel(h.tls.end);
      if (h.tls.sni) conn.tls.sni = h.tls.sni;
      if (h.tls.version) conn.tls.version = h.tls.version;
    }
    if (h.quic) {
      conn.quic = {
        startTime: rel(h.quic.start),
        remoteAddresses: [...h.quic.addresses],
        count: h.quic.count,
      };
    }
    out.push(conn);
  }
  return out.sort((a, b) => a.firstSeen - b.firstSeen || a.host.localeCompare(b.host));
}

/** Convenience: read a NetLog file and aggregate it. */
export async function hostConnectionsFromFile(
  file: string,
  navigationStart: number,
  opts?: AggregateOptions,
): Promise<{ connections: HostConnection[]; log: ParsedNetLog }> {
  const log = await readNetLog(file);
  return { connections: aggregateHostConnections(log, navigationStart, opts), log };
}
