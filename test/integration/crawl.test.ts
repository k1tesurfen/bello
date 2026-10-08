/** Crawl mode end-to-end: sitemap discovery on a fixture site, then a multi-page scan. */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAST_TUNING } from '../../src/cli/program.js';
import { Classifier } from '../../src/classify/index.js';
import { builtinConfig, resolveScanOptions } from '../../src/config/index.js';
import { discoverPages } from '../../src/crawl/index.js';
import { scanSite } from '../../src/scan/index.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server.js';
import { fixtureFetch } from './crawl.helpers.js';

let server: FixtureServer;
let outDir: string;

beforeAll(async () => {
  server = await startFixtureServer({ site: 'crawl-sitemap' });
  outDir = await mkdtemp(path.join(os.tmpdir(), 'bello-crawl-'));
});
afterAll(async () => {
  await server.close();
  await rm(outDir, { recursive: true, force: true });
});

describe('Crawl-Modus', { timeout: 180_000 }, () => {
  it('Sitemap mit 3 Seiten wird entdeckt und gescannt', async () => {
    const d = await discoverPages(server.url('/'), {
      maxPages: 10,
      delayMs: 0,
      fetchImpl: fixtureFetch(server),
    });
    expect(d.source).toBe('sitemap');
    expect(d.pages).toEqual([server.url('/'), server.url('/a.html'), server.url('/b.html')]);

    const opts = resolveScanOptions(builtinConfig(), {
      url: server.url('/'),
      cliFlags: { out: outDir, wait: 0.5, crawl: true },
    });
    const { report } = await scanSite({
      ...opts,
      pages: d.pages,
      delayMs: 0,
      launchArgs: server.chromiumArgs(),
      exitIpResult: { ip: '192.0.2.1', country: 'DE', check: { status: 'ok', inEu: true } },
      classifier: await Classifier.create({ skipExternalData: true }),
      scenarioTuning: FAST_TUNING,
      commandLine: ['bello', 'test'],
    });
    expect(report.pages.map((p) => new URL(p.url).pathname)).toEqual(['/', '/a.html', '/b.html']);
    expect(report.trafficLight).toBe('gruen');
  });
});
