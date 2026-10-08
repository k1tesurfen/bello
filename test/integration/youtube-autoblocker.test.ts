/**
 * Milestone (PLAN §17 step 1): the "YouTube iframe + late autoblocker" case is detected on
 * socket level, and the connection is attributed to the iframe element in the raw HTML.
 */
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isBrowserBackgroundConnection } from '../../src/capture/cdp/correlate.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server.js';
import { runFixturePage, type FixtureRun } from './helpers.js';

let server: FixtureServer;
const runs: FixtureRun[] = [];

beforeAll(async () => {
  server = await startFixtureServer();
});
afterAll(async () => {
  await Promise.all(runs.map((r) => r.cleanup()));
  await server.close();
});

describe('YouTube-iframe mit Autoblocker', () => {
  it('erkennt die TCP-Verbindung zu www.youtube.com und ordnet sie dem iframe zu', async () => {
    server.useSite('youtube-autoblocker');
    const run = await runFixturePage(server, server.url('/'));
    runs.push(run);

    const yt = run.connections.find((c) => c.host === 'www.youtube.com');
    expect(yt, JSON.stringify(run.connections.map((c) => c.host))).toBeDefined();
    expect(yt!.tcp).toBeDefined();
    expect(yt!.tcp!.count).toBeGreaterThan(0);
    expect(yt!.remoteIps).toContain('127.0.0.1');
    expect(yt!.firstConnectAt).toBeGreaterThanOrEqual(0);
    expect(['connect', 'tls']).toContain(yt!.level);

    const cause = yt!.causes?.[0];
    expect(cause, JSON.stringify(yt, null, 2)).toBeDefined();
    expect(cause!.initiator.type).toBe('parser');
    expect(cause!.initiator.url).toBe(server.url('/'));
    // 1-based line of the <iframe> element in the raw HTML.
    expect(cause!.initiator.line).toBe(9);
    expect(cause!.url).toContain('www.youtube.com/embed/');
    expect(cause!.resourceType).toBe('Document');

    // Page-caused connections are never mistaken for Chrome background traffic.
    expect(isBrowserBackgroundConnection(yt!)).toBe(false);

    // The autoblocker ran, but only after the socket had been opened.
    const cmp = run.requests.find((r) => r.url.includes('/cmp-autoblocker.js'));
    expect(cmp).toBeDefined();
    expect(yt!.firstConnectAt!).toBeLessThan(cmp!.endTime ?? Infinity);
    if (process.env.BELLO_DEBUG_OUT)
      writeFileSync(
        process.env.BELLO_DEBUG_OUT,
        JSON.stringify({ connections: run.connections, requests: run.requests }, null, 2),
      );
  });

  it('meldet keine YouTube-Verbindung, wenn nur data-src gesetzt ist', async () => {
    server.useSite('youtube-data-src');
    const run = await runFixturePage(server, server.url('/'));
    runs.push(run);

    expect(run.connections.find((c) => c.host === 'www.kunde-test.de')?.tcp).toBeDefined();
    expect(run.connections.find((c) => c.host === 'www.youtube.com')).toBeUndefined();
    expect(run.requests.some((r) => r.host === 'www.youtube.com')).toBe(false);
  });
});
