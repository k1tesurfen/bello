import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aggregateExitCode, runBatch, runPool } from '../../src/batch/index.js';
import { builtinConfig, type BelloConfig } from '../../src/config/index.js';
import { renderBatchHtml, writeBatchSummary } from '../../src/report/batch.js';
import type { ScanReport } from '../../src/types.js';

describe('aggregateExitCode', () => {
  it('schlimmster Code gewinnt (3 > 2 > 1 > 0)', () => {
    expect(aggregateExitCode([])).toBe(0);
    expect(aggregateExitCode([0, 1, 0])).toBe(1);
    expect(aggregateExitCode([1, 2, 0])).toBe(2);
    expect(aggregateExitCode([2, 3, 1])).toBe(3);
  });
});

describe('runPool', () => {
  it('begrenzt die Parallelität und erhält die Reihenfolge', async () => {
    let active = 0;
    let max = 0;
    const out = await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return n * 2;
    });
    expect(max).toBe(3);
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
  });
});

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'bello-batch-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

function config(): BelloConfig {
  const c = builtinConfig();
  c.defaults.outDir = dir;
  c.defaults.crawl.sitesInParallel = 2;
  for (const id of ['a', 'b', 'c']) {
    c.customers[id] = {
      id,
      name: id === 'c' ? 'C <script>alert(1)</script>' : id.toUpperCase(),
      url: `https://${id}.example.de/`,
      crawl: false,
      firstPartyAliases: [],
      allowedProcessors: [],
      banner: {},
    };
  }
  return c;
}

describe('runBatch', () => {
  it('ein technischer Fehler bricht den Batch nicht ab (Exit 3), Pool-Limit gilt', async () => {
    let active = 0;
    let max = 0;
    const res = await runBatch(config(), {
      cliFlags: {},
      scanFn: async (o) => {
        active++;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        if (o.customerId === 'b') throw new Error('Browser startet nicht');
        const report = {
          url: o.url,
          trafficLight: o.customerId === 'a' ? 'gelb' : 'gruen',
          findings: [],
          pages: [{}],
          meta: { startedAt: new Date().toISOString() },
        } as unknown as ScanReport;
        return { report, reportDir: path.join(dir, o.customerId!, 'x'), reportPath: 'x' };
      },
    });
    expect(max).toBe(2);
    expect(res.customers.map((c) => [c.id, c.status, c.exitCode])).toEqual([
      ['a', 'ok', 1],
      ['b', 'fehler', 3],
      ['c', 'ok', 0],
    ]);
    expect(res.customers[1]!.error).toContain('Browser startet nicht');
    expect(res.exitCode).toBe(3);

    const files = await writeBatchSummary(res);
    const json = JSON.parse(await readFile(files.jsonPath, 'utf8'));
    expect(json.customers).toHaveLength(3);
    const html = await readFile(files.htmlPath, 'utf8');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('Browser startet nicht');
    expect(renderBatchHtml(res, files.dir)).toContain('Fehler');
  });
  it('Konfiguration ohne Kunden → Fehlermeldung', async () => {
    await expect(runBatch(builtinConfig(), { cliFlags: {} })).rejects.toThrow(/keine Kunden/);
  });
});
