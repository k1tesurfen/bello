/**
 * Real-world CMP structures, offline (regression for heise.de / buy-my-site.de / solid-unit.de):
 *  - Sourcepoint: message in a cross-origin iframe, privacy manager in a second iframe, and the
 *    "consent or pay" (Pur-Abo) variant where a free rejection is impossible,
 *  - Usercentrics v2 (#usercentrics-root) and v3 (#usercentrics-cmp-ui) in open shadow roots,
 *  - CCM19 (#ccm-widget), also with custom labels (markup-based classification).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runScenario, type RunScenarioOptions } from '../../src/scenarios/run.js';
import type { HostConnection, ScenarioId } from '../../src/types.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server.js';

let server: FixtureServer;
let reportRoot: string;

beforeAll(async () => {
  server = await startFixtureServer({ site: 'scn-sourcepoint' });
  reportRoot = await mkdtemp(path.join(os.tmpdir(), 'bello-scn-cmps-'));
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
    waitSeconds: 0.5,
    followLinks: 0,
    passiveReader: {
      networkIdleTimeoutMs: 3000,
      scrollStepPx: 1500,
      scrollStepDelayMs: 60,
      bottomSettleMs: 300,
      mouseMoves: 3,
    },
    banner: {
      detectTimeoutMs: 4000,
      settleMs: 400,
      reappearCheckMs: 1000,
      secondLayerDelayMs: 300,
      autoconsentTimeoutMs: 12_000,
    },
    followLinkWaitSeconds: 0.3,
    launch: { extraArgs: server.chromiumArgs() },
    ...extra,
  });
}

const GTM = 'www.googletagmanager.com';
const gtm = (conns: HostConnection[]): HostConnection | undefined =>
  conns.find((c) => c.host === GTM);

describe('Sourcepoint (Nachricht im fremden iframe)', () => {
  it('A/B/C: Ablehnen auf erster Ebene, autoconsent bedient das iframe', async () => {
    server.useSite('scn-sourcepoint');
    const a = await run('A', '/');
    expect(a.status).toEqual({ state: 'vollstaendig' });
    expect(a.banner.firstLayer).toMatchObject({ reject: true, accept: true, settings: true });
    expect(gtm(a.connections)).toBeUndefined();

    const b = await run('B', '/', { followLinks: 1 });
    expect(b.status, JSON.stringify(b.banner)).toEqual({ state: 'vollstaendig' });
    expect(b.banner).toMatchObject({ succeeded: true, clicked: 'reject', disappeared: true });
    expect(b.banner.method).toBe('autoconsent');
    expect(b.banner.cmp).toBe('Sourcepoint-frame');
    expect(gtm(b.connections)).toBeUndefined();
    expect(b.followUps[0]?.bannerVisible).toBe(false);

    const c = await run('C', '/');
    expect(c.status, JSON.stringify(c.banner)).toEqual({ state: 'vollstaendig' });
    expect(c.banner).toMatchObject({ succeeded: true, clicked: 'accept' });
    expect(gtm(c.connections)).toBeDefined();
  }, 120_000);

  it('B: „Alle ablehnen“ nur im Privacy Manager (zweites iframe)', async () => {
    server.useSite('scn-sourcepoint');
    const b = await run('B', '/pm.html');
    expect(b.status, JSON.stringify(b.banner)).toEqual({ state: 'vollstaendig' });
    expect(b.banner).toMatchObject({ succeeded: true, clicked: 'reject', rejectFirstLayer: false });
    expect(gtm(b.connections)).toBeUndefined();
  }, 90_000);

  it('Pur-Modell: B nicht durchführbar (Abo nötig), C vollständig', async () => {
    server.useSite('scn-sourcepoint');
    const b = await run('B', '/pur.html');
    expect(b.status.state).toBe('unvollstaendig');
    if (b.status.state !== 'unvollstaendig') return;
    expect(b.status.reasonCode).toBe('banner-nicht-bedienbar');
    expect(b.status.reason).toContain('kostenpflichtigem Abo');
    expect(b.status.reason).toContain('Pur-Abo abschließen');
    expect(b.status.reason).not.toContain('technisch nicht bedienbar');
    expect(b.banner).toMatchObject({
      succeeded: false,
      consentOrPay: true,
      rejectFirstLayer: false,
    });
    expect(b.banner.firstLayer?.pay).toBe(true);
    // Nothing was consented: no "save selection" with the mandatory purpose, no accept.
    expect(gtm(b.connections)).toBeUndefined();
    expect(b.banner.autoconsent).toBeUndefined();

    const c = await run('C', '/pur.html');
    expect(c.status, JSON.stringify(c.banner)).toEqual({ state: 'vollstaendig' });
    expect(gtm(c.connections)).toBeDefined();
  }, 120_000);
});

describe('Usercentrics (Shadow DOM)', () => {
  it('v2 (#usercentrics-root): B und C über autoconsent', async () => {
    server.useSite('scn-usercentrics');
    const b = await run('B', '/');
    expect(b.status, JSON.stringify(b.banner)).toEqual({ state: 'vollstaendig' });
    expect(b.banner).toMatchObject({ succeeded: true, clicked: 'reject', method: 'autoconsent' });
    expect(b.banner.firstLayer).toMatchObject({ reject: true, accept: true, settings: true });
    expect(gtm(b.connections)).toBeUndefined();

    const c = await run('C', '/');
    expect(c.status, JSON.stringify(c.banner)).toEqual({ state: 'vollstaendig' });
    expect(c.banner).toMatchObject({ succeeded: true, clicked: 'accept' });
    expect(gtm(c.connections)).toBeDefined();
  }, 120_000);

  it('v3 (#usercentrics-cmp-ui) mit eigenen Texten: Heuristik erkennt die Buttons am Markup', async () => {
    server.useSite('scn-usercentrics');
    const b = await run('B', '/v3.html', {
      banner: { autoconsent: false, detectTimeoutMs: 4000, settleMs: 400, reappearCheckMs: 1000 },
    });
    expect(b.status, JSON.stringify(b.banner)).toEqual({ state: 'vollstaendig' });
    expect(b.banner).toMatchObject({ method: 'heuristik', clickedText: 'Nein, danke' });
    expect(gtm(b.connections)).toBeUndefined();

    const c = await run('C', '/v3.html');
    expect(c.status, JSON.stringify(c.banner)).toEqual({ state: 'vollstaendig' });
    expect(c.banner).toMatchObject({ succeeded: true, clicked: 'accept' });
    expect(gtm(c.connections)).toBeDefined();
  }, 120_000);

  it('Banner erscheint erst 2,5 s nach dem load-Ereignis', async () => {
    server.useSite('scn-usercentrics');
    const b = await run('B', '/spaet.html');
    expect(b.status, JSON.stringify(b.banner)).toEqual({ state: 'vollstaendig' });
    expect(b.banner.detectedAt).toBeGreaterThan(2000);
    expect(gtm(b.connections)).toBeUndefined();
  }, 90_000);
});

describe('CCM19', () => {
  it('B und C mit Standardtexten', async () => {
    server.useSite('scn-ccm19');
    const b = await run('B', '/', { followLinks: 1 });
    expect(b.status, JSON.stringify(b.banner)).toEqual({ state: 'vollstaendig' });
    expect(b.banner).toMatchObject({ succeeded: true, clicked: 'reject', rejectFirstLayer: true });
    expect(gtm(b.connections)).toBeUndefined();
    expect(b.followUps[0]?.bannerVisible).toBe(false);

    const c = await run('C', '/');
    expect(c.status, JSON.stringify(c.banner)).toEqual({ state: 'vollstaendig' });
    expect(gtm(c.connections)).toBeDefined();
  }, 120_000);

  it('eigene Button-Texte: Erkennung über das CCM19-Markup', async () => {
    server.useSite('scn-ccm19');
    const b = await run('B', '/eigene-texte.html');
    expect(b.status, JSON.stringify(b.banner)).toEqual({ state: 'vollstaendig' });
    expect(b.banner).toMatchObject({ clickedText: 'Nein, danke', clicked: 'reject' });
    expect(gtm(b.connections)).toBeUndefined();

    const c = await run('C', '/eigene-texte.html');
    expect(c.status, JSON.stringify(c.banner)).toEqual({ state: 'vollstaendig' });
    expect(c.banner).toMatchObject({ clickedText: 'Okay, passt', clicked: 'accept' });
    expect(gtm(c.connections)).toBeDefined();
  }, 120_000);
});
