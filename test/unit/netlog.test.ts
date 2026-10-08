import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isBrowserBackgroundConnection } from '../../src/capture/cdp/correlate.js';
import {
  aggregateHostConnections,
  ipFromAddress,
  netErrorName,
  NetLogParseError,
  parseNetLog,
  parseNetLogEndpoint,
} from '../../src/capture/netlog/index.js';
import type { HostConnection } from '../../src/types.js';
import { NAV_START, NetLogBuilder, TICK0, TICK_OFFSET } from './netlog-builder.js';

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'netlog',
);

function sample(): NetLogBuilder {
  const b = new NetLogBuilder();
  // Preconnect (e.g. <link rel=preconnect>) to fonts.googleapis.com that fails, no request.
  b.add(105, 40, 'HTTP_STREAM_JOB_CONTROLLER', 'HTTP_STREAM_JOB_CONTROLLER', 'begin', {
    is_preconnect: true,
    url: 'https://fonts.googleapis.com/',
  })
    .add(105, 41, 'HTTP_STREAM_JOB', 'TCP_CLIENT_SOCKET_POOL_REQUESTED_SOCKETS', 'none', {
      group_id: 'https://fonts.googleapis.com <http://kunde-test.de cross_site>',
    })
    .add(105, 42, 'SSL_CONNECT_JOB', 'SOCKET_POOL_CONNECT_JOB_CREATED', 'none', {
      backup_job: false,
      group_id: 'https://fonts.googleapis.com <http://kunde-test.de cross_site>',
    })
    .add(106, 43, 'SOCKET', 'SOCKET_ALIVE', 'begin', { source_dependency: { id: 42, type: 4 } })
    .add(106, 43, 'SOCKET', 'TCP_CONNECT', 'begin', { address_list: ['142.250.2.2:443'] })
    .add(106, 43, 'SOCKET', 'TCP_CONNECT_ATTEMPT', 'begin', { address: '142.250.2.2:443' })
    .add(108, 43, 'SOCKET', 'TCP_CONNECT', 'end', { net_error: -102 });

  // DNS for www.youtube.com
  b.add(110, 10, 'NETWORK_SERVICE_HOST_RESOLVER', 'HOST_RESOLVER_MANAGER_REQUEST', 'begin', {
    host: 'https://www.youtube.com',
    is_speculative: false,
  })
    .add(110, 11, 'HOST_RESOLVER_IMPL_JOB', 'HOST_RESOLVER_MANAGER_JOB', 'begin', {
      host: 'https://www.youtube.com',
      source_dependency: { id: 10, type: 9 },
    })
    .add(115, 11, 'HOST_RESOLVER_IMPL_JOB', 'HOST_RESOLVER_SYSTEM_TASK', 'end', {
      address_list: ['142.250.1.1:0', '[2a00:1450::1]:0'],
    })
    .add(115, 11, 'HOST_RESOLVER_IMPL_JOB', 'HOST_RESOLVER_MANAGER_JOB', 'end', {});

  // Iframe request: http → HSTS redirect to https, then aborted by the CMP.
  b.add(112, 30, 'URL_REQUEST', 'REQUEST_ALIVE', 'begin', { url: 'http://www.youtube.com/embed/x' })
    .add(112, 30, 'URL_REQUEST', 'URL_REQUEST_START_JOB', 'begin', {
      method: 'GET',
      initiator: 'http://www.kunde-test.de',
      request_type: 'subframe',
      network_isolation_key: 'http://kunde-test.de http://youtube.com',
    })
    .add(113, 30, 'URL_REQUEST', 'URL_REQUEST_REDIRECTED', 'none', {
      location: 'https://www.youtube.com/embed/x',
    })
    .add(113, 30, 'URL_REQUEST', 'URL_REQUEST_START_JOB', 'end', {})
    .add(113, 30, 'URL_REQUEST', 'URL_REQUEST_START_JOB', 'begin', {
      method: 'GET',
      initiator: 'http://www.kunde-test.de',
      request_type: 'subframe',
    })
    .add(140, 30, 'URL_REQUEST', 'URL_REQUEST_START_JOB', 'end', { net_error: -3 });

  // TCP + TLS to www.youtube.com
  b.add(116, 20, 'SSL_CONNECT_JOB', 'SOCKET_POOL_CONNECT_JOB_CREATED', 'none', {
    group_id: 'pm/https://www.youtube.com <http://kunde-test.de cross_site>',
  })
    .add(116, 21, 'SOCKET', 'SOCKET_ALIVE', 'begin', { source_dependency: { id: 20, type: 4 } })
    .add(116, 21, 'SOCKET', 'TCP_CONNECT', 'begin', { address_list: ['142.250.1.1:443'] })
    .add(116, 21, 'SOCKET', 'TCP_CONNECT_ATTEMPT', 'begin', { address: '142.250.1.1:443' })
    .add(120, 21, 'SOCKET', 'TCP_CONNECT_ATTEMPT', 'end', {})
    .add(120, 21, 'SOCKET', 'TCP_CONNECT', 'end', {
      local_address: '192.0.2.10:5555',
      remote_address: '142.250.1.1:443',
    })
    .add(120, 20, 'SSL_CONNECT_JOB', 'CONNECT_JOB_SET_SOCKET', 'none', {
      source_dependency: { id: 21, type: 6 },
    })
    .add(120, 21, 'SOCKET', 'SSL_CONNECT', 'begin')
    .add(130, 21, 'SOCKET', 'SSL_CONNECT', 'end', { version: 'TLS 1.3', next_proto: 'h2' });

  // HTTP/3 to www.google-analytics.com
  b.add(150, 50, 'QUIC_SESSION', 'QUIC_SESSION', 'begin', {
    host: 'www.google-analytics.com',
    port: 443,
  }).add(155, 50, 'QUIC_SESSION', 'QUIC_SESSION_PACKET_RECEIVED', 'none', {
    peer_address: '216.58.1.1:443',
    self_address: '192.0.2.10:6000',
  });

  // DNS only for connect.facebook.net (via async resolver results)
  b.add(160, 60, 'NETWORK_SERVICE_HOST_RESOLVER', 'HOST_RESOLVER_MANAGER_REQUEST', 'begin', {
    host: 'https://connect.facebook.net',
    is_speculative: true,
  })
    .add(160, 61, 'HOST_RESOLVER_IMPL_JOB', 'HOST_RESOLVER_MANAGER_JOB', 'begin', {
      host: 'https://connect.facebook.net',
    })
    .add(162, 61, 'HOST_RESOLVER_IMPL_JOB', 'HOST_RESOLVER_DNS_TASK_EXTRACTION_RESULTS', 'none', {
      results: [
        { domain_name: 'connect.facebook.net', endpoints: [{ address: '157.240.1.1', port: 0 }] },
      ],
    })
    .add(162, 61, 'HOST_RESOLVER_IMPL_JOB', 'HOST_RESOLVER_MANAGER_JOB', 'end', {});

  // Resolver noise that must be ignored (host-resolver-rules targets).
  b.add(170, 62, 'NETWORK_SERVICE_HOST_RESOLVER', 'HOST_RESOLVER_MANAGER_REQUEST', 'begin', {
    host: 'https://~notfound',
  }).add(171, 63, 'NETWORK_SERVICE_HOST_RESOLVER', 'HOST_RESOLVER_MANAGER_REQUEST', 'begin', {
    host: 'http://127.0.0.1:41917',
  });
  return b;
}

const byHost = (conns: HostConnection[], host: string): HostConnection => {
  const c = conns.find((x) => x.host === host);
  if (!c) throw new Error(`no connection for ${host}: ${conns.map((x) => x.host).join(', ')}`);
  return c;
};

describe('parseNetLog', () => {
  it('löst Typnamen über den constants-Block auf und rechnet Ticks in Epoch-ms um', () => {
    const log = parseNetLog(sample().toString());
    expect(log.truncated).toBe(false);
    expect(log.timeTickOffset).toBe(TICK_OFFSET);
    const first = log.events[0]!;
    expect(first.type).toBe('HTTP_STREAM_JOB_CONTROLLER');
    expect(first.sourceType).toBe('HTTP_STREAM_JOB_CONTROLLER');
    expect(first.phase).toBe('begin');
    expect(first.time).toBe(TICK_OFFSET + TICK0 + 105);
    expect(netErrorName(-3, log.constants)).toBe('ERR_ABORTED');
  });

  it('toleriert eine abgeschnittene Datei (Browser-Absturz)', () => {
    const b = sample();
    const total = parseNetLog(b.toString()).events.length;
    const log = parseNetLog(b.toTruncatedString());
    expect(log.truncated).toBe(true);
    expect(log.events.length).toBe(total - 1);
    // Cut exactly after a complete event (no partial line).
    const log2 = parseNetLog(b.toTruncatedString(0));
    expect(log2.events.length).toBe(total);
    expect(log2.truncated).toBe(true);
  });

  it('wirft einen verständlichen Fehler, wenn constants fehlen', () => {
    const text = sample().toString();
    expect(() => parseNetLog(text.slice(0, 50))).toThrow(NetLogParseError);
    expect(() => parseNetLog('{"events": []}')).toThrow(/constants/);
  });
});

describe('aggregateHostConnections (handgemachtes Sample)', () => {
  const conns = aggregateHostConnections(parseNetLog(sample().toString()), NAV_START);

  it('aggregiert DNS, TCP und TLS pro Host mit relativen Zeiten', () => {
    const yt = byHost(conns, 'www.youtube.com');
    expect(yt.dns).toEqual({
      startTime: 10,
      endTime: 15,
      addresses: ['142.250.1.1', '2a00:1450::1'],
    });
    expect(yt.tcp).toMatchObject({ startTime: 16, endTime: 20, count: 1, connected: true });
    expect(yt.tcp!.remoteAddresses).toEqual(['142.250.1.1:443']);
    expect(yt.tls).toMatchObject({
      startTime: 20,
      endTime: 30,
      sni: 'www.youtube.com',
      established: true,
      version: 'TLS 1.3',
    });
    expect(yt.remoteIps).toEqual(['142.250.1.1']);
    expect(yt.firstConnectAt).toBe(16);
    expect(yt.level).toBe('tls');
    expect(yt.ports).toEqual([80, 443]);
    expect(yt.wasPreconnectOnly).toBe(false);
  });

  it('verfolgt Redirects und markiert abgebrochene Requests', () => {
    const yt = byHost(conns, 'www.youtube.com');
    expect(yt.urlRequests.map((r) => r.url)).toEqual([
      'http://www.youtube.com/embed/x',
      'https://www.youtube.com/embed/x',
    ]);
    expect(yt.urlRequests[0]).toMatchObject({
      startTime: 12,
      aborted: false,
      requestType: 'subframe',
      initiatorOrigin: 'http://www.kunde-test.de',
    });
    expect(yt.urlRequests[1]).toMatchObject({ startTime: 13, aborted: true, netError: -3 });
  });

  it('erkennt Preconnects ohne Request (auch fehlgeschlagene Verbindungen)', () => {
    const fonts = byHost(conns, 'fonts.googleapis.com');
    expect(fonts.wasPreconnectOnly).toBe(true);
    expect(fonts.sawPreconnect).toBe(true);
    expect(fonts.requested).toBe(false);
    expect(fonts.tcp).toMatchObject({ startTime: 6, count: 1, connected: false });
    expect(fonts.firstConnectAt).toBe(6);
    expect(fonts.remoteIps).toEqual(['142.250.2.2']);
    expect(fonts.level).toBe('connect');
  });

  it('erfasst QUIC-Sessions mit Gegenstelle', () => {
    const ga = byHost(conns, 'www.google-analytics.com');
    expect(ga.quic).toEqual({ startTime: 50, remoteAddresses: ['216.58.1.1:443'], count: 1 });
    expect(ga.remoteIps).toEqual(['216.58.1.1']);
    expect(ga.firstConnectAt).toBe(50);
    expect(ga.level).toBe('connect');
  });

  it('unterscheidet reine DNS-Auflösung', () => {
    const fb = byHost(conns, 'connect.facebook.net');
    expect(fb.level).toBe('dns');
    expect(fb.firstConnectAt).toBeUndefined();
    expect(fb.dns!.addresses).toEqual(['157.240.1.1']);
  });

  it('ignoriert Resolver-Rauschen und gefilterte Hosts', () => {
    expect(conns.map((c) => c.host).sort()).toEqual([
      'connect.facebook.net',
      'fonts.googleapis.com',
      'www.google-analytics.com',
      'www.youtube.com',
    ]);
    const filtered = aggregateHostConnections(parseNetLog(sample().toString()), NAV_START, {
      ignoreHost: (h) => h.endsWith('facebook.net'),
    });
    expect(filtered.some((c) => c.host === 'connect.facebook.net')).toBe(false);
  });
});

describe('Hilfsfunktionen', () => {
  it('parst Hosts aus Gruppen-IDs, URLs und Resolver-Strings', () => {
    expect(parseNetLogEndpoint('pm/https://www.youtube.com <http://a.de cross_site>')).toEqual({
      scheme: 'https',
      host: 'www.youtube.com',
      port: 443,
    });
    expect(parseNetLogEndpoint('http://www.kunde-test.de:8080/x')).toEqual({
      scheme: 'http',
      host: 'www.kunde-test.de',
      port: 8080,
    });
    expect(parseNetLogEndpoint('ssl/example.com:443')).toEqual({
      scheme: 'https',
      host: 'example.com',
      port: 443,
    });
    expect(parseNetLogEndpoint('https://[2a00::1]:443')?.host).toBe('2a00::1');
  });

  it('trennt IP und Port', () => {
    expect(ipFromAddress('1.2.3.4:443')).toBe('1.2.3.4');
    expect(ipFromAddress('[2a00::1]:443')).toBe('2a00::1');
    expect(ipFromAddress('2a00::1')).toBe('2a00::1');
  });
});

describe('echte Chromium-Aufzeichnungen', () => {
  const load = (name: string) => ({
    text: readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'),
    meta: JSON.parse(readFileSync(path.join(FIXTURES, `${name}.meta.json`), 'utf8')) as {
      navigationStart: number;
    },
  });

  it('YouTube-Autoblocker-Fixture: Socket zu www.youtube.com vor dem Request (Preconnect)', () => {
    const { text, meta } = load('youtube-autoblocker');
    const conns = aggregateHostConnections(parseNetLog(text), meta.navigationStart);
    const yt = byHost(conns, 'www.youtube.com');
    expect(yt.tcp?.connected).toBe(true);
    expect(yt.tls?.sni).toBe('www.youtube.com');
    expect(yt.tls?.established).toBe(true);
    expect(yt.remoteIps).toEqual(['127.0.0.1']);
    expect(yt.sawPreconnect).toBe(true);
    expect(yt.firstConnectAt).toBeGreaterThan(0);
    expect(yt.firstConnectAt!).toBeLessThanOrEqual(yt.urlRequests[0]!.startTime);
    expect(yt.urlRequests[0]!.requestType).toBe('subframe');
    // Resources loaded inside the iframe are attributed to their own hosts.
    expect(byHost(conns, 'i.ytimg.com').level).toBe('tls');
    // Chrome's own background requests (failing in the hermetic setup) are classified.
    expect(isBrowserBackgroundConnection(byHost(conns, 'accounts.google.com'))).toBe(true);
    expect(isBrowserBackgroundConnection(yt)).toBe(false);
  });

  it('YouTube-Autoblocker-Fixture: abgeschnittene Datei liefert die frühen Verbindungen', () => {
    const { text, meta } = load('youtube-autoblocker');
    const log = parseNetLog(text.slice(0, Math.floor(text.length * 0.5)));
    expect(log.truncated).toBe(true);
    const conns = aggregateHostConnections(log, meta.navigationStart);
    expect(byHost(conns, 'www.kunde-test.de').tcp?.connected).toBe(true);
  });

  it('example.com (echtes Netz): DNS, TCP, TLS, QUIC und Chrome-Hintergrundverkehr', () => {
    const { text, meta } = load('example-com-real');
    const conns = aggregateHostConnections(parseNetLog(text), meta.navigationStart);
    const ex = byHost(conns, 'example.com');
    expect(ex.dns!.addresses.length).toBeGreaterThan(0);
    expect(ex.dns!.startTime).toBeGreaterThanOrEqual(0);
    expect(ex.tcp?.connected).toBe(true);
    expect(ex.tls).toMatchObject({ established: true, sni: 'example.com', version: 'TLS 1.3' });
    expect(ex.quic?.count).toBe(1);
    expect(ex.remoteIps.every((ip) => ex.dns!.addresses.includes(ip))).toBe(true);
    expect(ex.urlRequests[0]).toMatchObject({
      url: 'https://example.com/',
      requestType: 'main frame',
    });

    for (const host of ['accounts.google.com', 'update.googleapis.com', 'www.google.com']) {
      expect(isBrowserBackgroundConnection(byHost(conns, host)), host).toBe(true);
    }
    expect(isBrowserBackgroundConnection(ex)).toBe(false);
  });
});

describe('NetLog – Anfragen über gebündelte HTTP/2-/QUIC-Sessions', () => {
  it('markiert Requests mit gesendeten Headern (headersSent), auch wenn sie abgebrochen wurden', () => {
    const b = new NetLogBuilder();
    // www.youtube.com rides an existing HTTP/2 session (no own socket): only DNS + URL request.
    b.add(100, 1, 'HOST_RESOLVER_IMPL_JOB', 'HOST_RESOLVER_MANAGER_REQUEST', 'begin', {
      host: 'https://www.youtube.com',
    });
    b.add(101, 2, 'URL_REQUEST', 'URL_REQUEST_START_JOB', 'begin', {
      url: 'https://www.youtube.com/embed/x',
      method: 'GET',
    });
    b.add(102, 2, 'URL_REQUEST', 'HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS', 'none', {});
    b.add(103, 2, 'URL_REQUEST', 'URL_REQUEST_START_JOB', 'end', { net_error: -3 });
    // A second host whose request was aborted before anything was sent.
    b.add(104, 3, 'URL_REQUEST', 'URL_REQUEST_START_JOB', 'begin', {
      url: 'https://i.ytimg.com/vi/x.jpg',
    });
    b.add(105, 3, 'URL_REQUEST', 'URL_REQUEST_START_JOB', 'end', { net_error: -3 });
    // Plain HTTP/1.1 send event.
    b.add(106, 4, 'URL_REQUEST', 'URL_REQUEST_START_JOB', 'begin', {
      url: 'https://quic.example/x',
    });
    b.add(107, 4, 'URL_REQUEST', 'HTTP_TRANSACTION_QUIC_SEND_REQUEST_HEADERS', 'begin', {});
    const conns = aggregateHostConnections(parseNetLog(b.toString()), NAV_START);
    const yt = conns.find((c) => c.host === 'www.youtube.com')!;
    expect(yt.level).toBe('dns');
    expect(yt.urlRequests[0]).toMatchObject({ aborted: true, headersSent: true });
    expect(
      conns.find((c) => c.host === 'i.ytimg.com')!.urlRequests[0]!.headersSent,
    ).toBeUndefined();
    expect(conns.find((c) => c.host === 'quic.example')!.urlRequests[0]!.headersSent).toBe(true);
  });
});
