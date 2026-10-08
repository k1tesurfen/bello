import { describe, expect, it } from 'vitest';
import { correlate, isBrowserBackgroundConnection } from '../../src/capture/cdp/correlate.js';
import { mapInitiator } from '../../src/capture/cdp/requests.js';
import type { HostConnection, RequestRecord } from '../../src/types.js';

function conn(host: string, over: Partial<HostConnection> = {}): HostConnection {
  return {
    host,
    ports: [443],
    remoteIps: [],
    urlRequests: [],
    wasPreconnectOnly: false,
    sawPreconnect: false,
    firstSeen: 0,
    level: 'connect',
    requested: false,
    ...over,
  };
}

function req(
  id: string,
  url: string,
  startTime: number,
  over: Partial<RequestRecord> = {},
): RequestRecord {
  return {
    id,
    url,
    host: new URL(url).hostname,
    method: 'GET',
    resourceType: 'Script',
    initiator: { type: 'parser', url: 'https://www.kunde-test.de/', line: 12 },
    startTime,
    ...over,
  };
}

describe('correlate', () => {
  it('ordnet über URL + Zeit zu', () => {
    const c = conn('www.googletagmanager.com', {
      firstConnectAt: 40,
      requested: true,
      urlRequests: [
        {
          url: 'https://www.googletagmanager.com/gtm.js?id=GTM-X',
          startTime: 38,
          aborted: false,
          sourceId: 1,
        },
      ],
    });
    const requests = [
      req('a', 'https://www.googletagmanager.com/gtm.js?id=GTM-X#frag', 37),
      req('b', 'https://www.kunde-test.de/app.js', 10),
    ];
    correlate([c], requests);
    expect(c.causes).toHaveLength(1);
    expect(c.causes![0]).toMatchObject({ requestId: 'a', match: 'url', deltaMs: 1 });
    expect(c.causes![0]!.initiator.type).toBe('parser');
  });

  it('fällt auf Host + Zeitnähe zurück und wählt den nächstliegenden Request', () => {
    const c = conn('www.youtube.com', { firstConnectAt: 100 });
    correlate(
      [c],
      [
        req('early', 'https://www.youtube.com/a', 20),
        req('close', 'https://www.youtube.com/b', 104),
        req('far', 'https://www.youtube.com/c', 50_000),
      ],
    );
    expect(c.causes!.map((x) => [x.requestId, x.match, x.deltaMs])).toEqual([
      ['close', 'host-time', 4],
    ]);
  });

  it('lässt Preconnect-only-Verbindungen ohne Ursache', () => {
    const c = conn('fonts.gstatic.com', {
      wasPreconnectOnly: true,
      firstConnectAt: 5,
      sawPreconnect: true,
    });
    correlate([c], [req('x', 'https://www.kunde-test.de/', 0)]);
    expect(c.causes).toEqual([]);
    expect(isBrowserBackgroundConnection(c)).toBe(false);
  });

  it('erkennt Chrome-Hintergrundverkehr', () => {
    expect(isBrowserBackgroundConnection(conn('update.googleapis.com'))).toBe(true);
    const accounts = conn('accounts.google.com', {
      requested: true,
      urlRequests: [
        {
          url: 'https://accounts.google.com/ListAccounts?gpsia=1',
          startTime: 700,
          aborted: false,
          sourceId: 9,
          initiatorOrigin: 'not an origin',
          requestType: 'other',
        },
      ],
    });
    expect(isBrowserBackgroundConnection(accounts)).toBe(true);
    // The same host requested by the page is never background traffic.
    correlate([accounts], [req('p', 'https://accounts.google.com/ListAccounts?gpsia=1', 699)]);
    expect(isBrowserBackgroundConnection(accounts)).toBe(false);
    expect(isBrowserBackgroundConnection(conn('www.google.com', { firstSeen: -30 }))).toBe(true);
  });
});

describe('mapInitiator', () => {
  it('wandelt CDP-Initiatoren um (1-basierte Zeilen, flacher Stack inkl. async parent)', () => {
    const i = mapInitiator({
      type: 'script',
      stack: {
        callFrames: [{ url: '', functionName: 'anon', lineNumber: 0, columnNumber: 0 }],
        parent: {
          callFrames: [
            {
              url: 'https://www.googletagmanager.com/gtm.js',
              functionName: 'load',
              lineNumber: 4,
              columnNumber: 10,
            },
          ],
        },
      },
    });
    expect(i).toEqual({
      type: 'script',
      url: 'https://www.googletagmanager.com/gtm.js',
      line: 5,
      column: 11,
      stack: [
        {
          url: 'https://www.googletagmanager.com/gtm.js',
          functionName: 'load',
          line: 5,
          column: 11,
        },
      ],
    });
    expect(mapInitiator({ type: 'parser', url: 'https://a.de/', lineNumber: 8 })).toEqual({
      type: 'parser',
      url: 'https://a.de/',
      line: 9,
    });
    expect(mapInitiator({ type: 'preflight' }).type).toBe('other');
    expect(mapInitiator(undefined)).toEqual({ type: 'other' });
  });
});
