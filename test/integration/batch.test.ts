/** Batch over two fixture customers, run twice: summary files and change detection. */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runBatch } from '../../src/batch/index.js';
import { FAST_TUNING } from '../../src/cli/program.js';
import { Classifier } from '../../src/classify/index.js';
import { builtinConfig, type BelloConfig } from '../../src/config/index.js';
import { writeBatchSummary } from '../../src/report/batch.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server.js';
import { fixtureFetch } from './crawl.helpers.js';

let server: FixtureServer;
let outDir: string;
let classifier: Classifier;

beforeAll(async () => {
  server = await startFixtureServer({ site: 'crawl-batch' });
  outDir = await mkdtemp(path.join(os.tmpdir(), 'bello-batch-'));
  classifier = await Classifier.create({ skipExternalData: true });
});
afterAll(async () => {
  await server.close();
  await rm(outDir, { recursive: true, force: true });
});

function config(): BelloConfig {
  const c = builtinConfig();
  c.defaults.outDir = outDir;
  c.defaults.crawl.sitesInParallel = 2;
  c.customers.eins = {
    id: 'eins',
    name: 'Kunde Eins',
    url: server.url('/'),
    crawl: true,
    firstPartyAliases: [],
    allowedProcessors: [],
    banner: {},
  };
  c.customers.zwei = {
    id: 'zwei',
    name: 'Kunde Zwei',
    url: server.url('/', 'kunde-test.de'),
    crawl: false,
    firstPartyAliases: [],
    allowedProcessors: [],
    banner: {},
  };
  return c;
}

async function run(): Promise<ReturnType<typeof runBatch>> {
  return runBatch(config(), {
    cliFlags: { wait: 0.5 },
    discoverFetch: fixtureFetch(server),
    discoverDelayMs: 0,
    scanExtras: {
      delayMs: 0,
      launchArgs: server.chromiumArgs(),
      exitIpResult: { ip: '192.0.2.1', country: 'DE', check: { status: 'ok', inEu: true } },
      classifier,
      scenarioTuning: FAST_TUNING,
      commandLine: ['bello', 'test'],
    },
  });
}

describe('Batch', { timeout: 300_000 }, () => {
  it('zwei Läufe: Übersicht und Änderungserkennung', async () => {
    const first = await run();
    expect(first.customers.map((c) => [c.id, c.trafficLight, c.pagesScanned])).toEqual([
      ['eins', 'gruen', 3],
      ['zwei', 'rot', 1],
    ]);
    expect(first.exitCode).toBe(2);
    expect(first.customers.every((c) => c.change === undefined)).toBe(true);
    const f1 = await writeBatchSummary(first, { now: new Date('2026-10-08T10:00:00Z') });
    expect(existsSync(f1.htmlPath)).toBe(true);

    // Second run: customer "zwei" has fixed the problem.
    server.useSite('crawl-batch-fixed');
    const second = await run();
    expect(second.exitCode).toBe(0);
    const zwei = second.customers.find((c) => c.id === 'zwei')!;
    expect(zwei.trafficLight).toBe('gruen');
    expect(zwei.change?.trafficLight).toEqual({ before: 'rot', after: 'gruen' });
    expect(zwei.change?.behoben).toBeGreaterThan(0);
    const eins = second.customers.find((c) => c.id === 'eins')!;
    expect(eins.change).toMatchObject({ neu: 0, behoben: 0 });

    const f2 = await writeBatchSummary(second, { now: new Date('2026-10-09T10:00:00Z') });
    const json = JSON.parse(await readFile(f2.jsonPath, 'utf8'));
    expect(json.customers[1].change.trafficLight).toEqual({ before: 'rot', after: 'gruen' });
    const html = await readFile(f2.htmlPath, 'utf8');
    expect(html).toContain('Kunde Zwei');
    expect(html).toContain('Ampel Rot → Grün');
    expect(html).toContain('report.json');
  });
});
