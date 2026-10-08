/**
 * Hard limits of the scenario runner (review fixes): time budget with force-kill, failing capture
 * hooks, failed follow-up navigation in B, pages without internal links.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runScenario, type RunScenarioOptions } from '../../src/scenarios/run.js';
import type { ScenarioId } from '../../src/types.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server.js';

let server: FixtureServer;
let reportRoot: string;

beforeAll(async () => {
  server = await startFixtureServer({ site: 'scn-review' });
  reportRoot = await mkdtemp(path.join(os.tmpdir(), 'bello-limits-'));
});
afterAll(async () => {
  await server.close();
  await rm(reportRoot, { recursive: true, force: true });
});

let counter = 0;
function run(scenario: ScenarioId, pathname: string, extra: Partial<RunScenarioOptions> = {}) {
  return runScenario({
    url: server.url(pathname),
    scenario,
    reportDir: path.join(reportRoot, `r${++counter}`),
    waitSeconds: 0.3,
    passiveReader: {
      networkIdleTimeoutMs: 2000,
      scrollStepPx: 1500,
      scrollStepDelayMs: 50,
      bottomSettleMs: 200,
      mouseMoves: 2,
    },
    banner: { detectTimeoutMs: 3000, settleMs: 300, reappearCheckMs: 800, secondLayerDelayMs: 200 },
    followLinkWaitSeconds: 0.2,
    launch: { extraArgs: server.chromiumArgs() },
    ...extra,
  });
}

describe('Szenario-Grenzen', () => {
  it('hängender Renderer: Zeitbudget greift, Browser wird beendet, Szenario unvollständig', async () => {
    const t0 = Date.now();
    const r = await run('A', '/haengt.html', { timeBudgetMs: 12_000, closeTimeoutMs: 3_000 });
    const elapsed = Date.now() - t0;
    expect(r.status.state).toBe('unvollstaendig');
    expect(r.status.state === 'unvollstaendig' && r.status.reasonCode).toBe('timeout');
    expect(r.status.state === 'unvollstaendig' && r.status.reason).toContain('Zeitbudget');
    expect(elapsed).toBeLessThan(40_000);
  }, 60_000);

  it('Browser schließt nicht rechtzeitig → Prozess wird beendet, NetLog unvollständig, Szenario unvollständig', async () => {
    const r = await run('A', '/ohne-links.html', { closeTimeoutMs: 1 });
    expect(r.status.state === 'unvollstaendig' && r.status.reasonCode).toBe('browser-fehler');
    expect(r.warnings.some((w) => w.includes('nicht sauber schließen'))).toBe(true);
  }, 60_000);

  it('fehlschlagende Capture-Erweiterung → unvollständig (kein-mitschnitt)', async () => {
    const r = await run('A', '/ohne-links.html', {
      hooks: {
        onCheckpoint: () => {
          throw new Error('Testfehler');
        },
      },
    });
    expect(r.status.state === 'unvollstaendig' && r.status.reasonCode).toBe('kein-mitschnitt');
  }, 60_000);

  it('B: Folgeseite mit HTTP 404 → unvollständig', async () => {
    const r = await run('B', '/');
    expect(r.banner.succeeded).toBe(true);
    expect(r.followUps.find((f) => f.url.endsWith('/fehlt.html'))).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(r.status.state === 'unvollstaendig' && r.status.reasonCode).toBe(
      'navigation-fehlgeschlagen',
    );
  }, 60_000);

  it('B: Seite ohne interne Links → nur Warnung, vollständig', async () => {
    const r = await run('B', '/ohne-links.html');
    expect(r.status, JSON.stringify(r.status)).toEqual({ state: 'vollstaendig' });
    expect(r.followUps).toEqual([]);
    expect(r.warnings.some((w) => w.includes('Keine internen Links'))).toBe(true);
  }, 60_000);
});
