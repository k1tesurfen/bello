/**
 * CDP capture must cover out-of-process iframes: a cross-site YouTube embed runs in its own
 * renderer process, its subresources are only visible on the iframe's own CDP session.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../fixtures/server.js';
import { runFixturePage, type FixtureRun } from './helpers.js';

let server: FixtureServer;
let run: FixtureRun;

beforeAll(async () => {
  server = await startFixtureServer({ site: 'youtube-embed-plain' });
  run = await runFixturePage(server, server.url('/'), { settleMs: 800 });
});
afterAll(async () => {
  await run?.cleanup();
  await server.close();
});

it('erfasst Requests aus dem Cross-Site-iframe (OOPIF) mit Initiator', () => {
  const embedUrl = 'https://www.youtube.com/embed/dQw4w9WgXcQ';
  const img = run.requests.find((r) => r.host === 'i.ytimg.com');
  expect(img, JSON.stringify(run.requests.map((r) => r.url))).toBeDefined();
  expect(img!.oopif).toBe(true);
  expect(img!.initiator.type).toBe('parser');
  expect(img!.initiator.url).toBe(embedUrl);

  const pixel = run.requests.find((r) => r.host === 'stats.g.doubleclick.net');
  expect(pixel).toBeDefined();
  expect(pixel!.initiator.type).toBe('script');
  expect(pixel!.initiator.url).toBe(embedUrl);
  expect(pixel!.initiator.stack?.[0]?.functionName).toBe('sendTelemetry');
});

it('ordnet die Socket-Verbindungen der iframe-Ressourcen ihren Requests zu', () => {
  for (const host of ['www.youtube.com', 'i.ytimg.com', 'stats.g.doubleclick.net']) {
    const conn = run.connections.find((c) => c.host === host);
    expect(conn, host).toBeDefined();
    expect(conn!.level).toBe('tls');
    expect(conn!.tls!.sni).toBe(host);
    expect(conn!.causes?.length, host).toBeGreaterThan(0);
  }
  const yt = run.connections.find((c) => c.host === 'www.youtube.com')!;
  expect(yt.causes![0]!.initiator.type).toBe('parser');
  expect(yt.causes![0]!.resourceType).toBe('Document');
});
