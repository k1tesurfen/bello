/**
 * Scenarios A/B/C end-to-end against fixture CMPs (PLAN §3, §5.6, §7).
 * Wait times are shortened via options; everything else runs exactly as in a real scan.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runScenario, type RunScenarioOptions } from '../../src/scenarios/run.js';
import type { HostConnection, ScenarioId } from '../../src/types.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server.js';

let server: FixtureServer;
let reportRoot: string;

beforeAll(async () => {
  server = await startFixtureServer({ site: 'scn-cmp' });
  reportRoot = await mkdtemp(path.join(os.tmpdir(), 'bello-scn-'));
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
    },
    followLinkWaitSeconds: 0.3,
    launch: { extraArgs: server.chromiumArgs() },
    ...extra,
  });
}

const host = (conns: HostConnection[], h: string): HostConnection | undefined =>
  conns.find((c) => c.host === h);
const GTM = 'www.googletagmanager.com';

describe('Szenarien mit einfachem CMP (Ablehnen + Akzeptieren auf erster Ebene)', () => {
  it('A: Banner erkannt, nicht geklickt, keine GTM-Verbindung; Evidence vorhanden', async () => {
    server.useSite('scn-cmp');
    const r = await run('A', '/');
    expect(r.status, JSON.stringify(r.status)).toEqual({ state: 'vollstaendig' });
    expect(r.banner.found).toBe(true);
    expect(r.banner.attempted).toBe(false);
    expect(r.banner.clicked).toBeUndefined();
    expect(r.banner.rejectFirstLayer).toBe(true);
    expect(r.timing.bannerClickAt).toBeUndefined();
    expect(host(r.connections, GTM)).toBeUndefined();
    expect(host(r.connections, 'www.kunde-test.de')).toBeDefined();
    // CMP script recognised → cmpLoadedAt from the request.
    expect(r.cmpLoadedSource).toBe('cmp-script');
    expect(r.timing.cmpLoadedAt).toBeGreaterThanOrEqual(0);
    expect(r.timing.scrollPhaseStartAt).toBeGreaterThan(0);
    expect(r.passiveReader?.reachedBottom).toBe(true);
    for (const f of [
      'evidence/A-no-interaction/netlog.json',
      'evidence/A-no-interaction/network.har',
      'evidence/A-no-interaction/raw.html',
      'evidence/A-no-interaction/dom.html',
      'evidence/A-no-interaction/screenshots/banner.png',
      'evidence/A-no-interaction/screenshots/seitenende.png',
    ]) {
      expect(r.evidenceFiles).toContain(f);
    }
  });

  it('B: „Alle ablehnen“ geklickt und verifiziert, keine GTM-Verbindung, Folgenavigation', async () => {
    server.useSite('scn-cmp');
    const r = await run('B', '/');
    expect(r.status, JSON.stringify(r.banner)).toEqual({ state: 'vollstaendig' });
    expect(r.banner).toMatchObject({
      found: true,
      method: 'heuristik',
      clicked: 'reject',
      succeeded: true,
      disappeared: true,
      reappeared: false,
      rejectFirstLayer: true,
      clickedText: 'Alle ablehnen',
    });
    expect(r.timing.bannerClickAt).toBeGreaterThan(0);
    expect(r.timing.scrollPhaseStartAt!).toBeGreaterThanOrEqual(r.timing.bannerClickAt!);
    expect(host(r.connections, GTM)).toBeUndefined();
    // Two same-site links, PDF/external skipped; consent remembered on follow-up pages.
    expect(r.followUps.map((f) => new URL(f.url).pathname)).toEqual([
      '/seite-2.html',
      '/seite-3.html',
    ]);
    expect(r.followUps.every((f) => f.ok && f.bannerVisible === false)).toBe(true);
    expect(r.evidenceFiles).toContain('evidence/B-reject/screenshots/nach-klick.png');
  });

  it('C: „Alle akzeptieren“ geklickt, GTM-Verbindung nach dem Klick', async () => {
    server.useSite('scn-cmp');
    const r = await run('C', '/');
    expect(r.status).toEqual({ state: 'vollstaendig' });
    expect(r.banner).toMatchObject({ found: true, clicked: 'accept', succeeded: true });
    const gtm = host(r.connections, GTM);
    expect(gtm, JSON.stringify(r.connections.map((c) => c.host))).toBeDefined();
    expect(gtm!.firstConnectAt).toBeDefined();
    expect(gtm!.firstConnectAt!).toBeGreaterThanOrEqual(r.timing.bannerClickAt! - 20);
    expect(gtm!.causes?.[0]?.initiator.type).toBe('script');
    expect(r.followUps).toEqual([]);
  });
});

describe('Banner ohne Ablehnen auf erster Ebene', () => {
  it('B: Dark Pattern vermerkt, zweite Ebene mit abgewählter Statistik, keine GTM-Verbindung', async () => {
    server.useSite('scn-cmp');
    const r = await run('B', '/zweite-ebene.html', { followLinks: 0 });
    expect(r.status, JSON.stringify(r.banner)).toEqual({ state: 'vollstaendig' });
    expect(r.banner.rejectFirstLayer).toBe(false);
    expect(r.banner.firstLayer).toMatchObject({ reject: false, accept: true, settings: true });
    expect(r.banner.secondLayer).toEqual({
      tried: true,
      succeeded: true,
      via: 'auswahl-speichern',
      uncheckedToggles: 1,
    });
    expect(r.banner.clicked).toBe('reject');
    expect(host(r.connections, GTM)).toBeUndefined();
  });
});

describe('Nicht bedienbarer Banner', () => {
  it('B und C: Buttons ohne Wirkung → UNVOLLSTÄNDIG', async () => {
    server.useSite('scn-cmp');
    for (const sc of ['B', 'C'] as const) {
      const r = await run(sc, '/kaputt.html');
      expect(r.status.state, sc).toBe('unvollstaendig');
      expect(r.status.state === 'unvollstaendig' && r.status.reasonCode).toBe(
        'banner-nicht-bedienbar',
      );
      expect(r.banner.succeeded).toBe(false);
      expect(r.banner.clicked).toBeUndefined();
      expect(r.banner.disappeared).toBe(false);
      expect(r.timing.bannerClickAt).toBeUndefined();
      // Evidence is still collected.
      expect(r.connections.length).toBeGreaterThan(0);
    }
  });

  it('B: Banner verschwindet und erscheint erneut → UNVOLLSTÄNDIG', async () => {
    server.useSite('scn-cmp');
    const r = await run('B', '/wiederkehrend.html', { followLinks: 0 });
    expect(r.status.state).toBe('unvollstaendig');
    expect(r.status.state === 'unvollstaendig' && r.status.reason).toMatch(/erneut/);
    expect(r.banner.reappeared).toBe(true);
    expect(r.banner.succeeded).toBe(false);
  });

  it('A: Szenario A bleibt vollständig, auch wenn der Banner kaputt ist', async () => {
    server.useSite('scn-cmp');
    const r = await run('A', '/kaputt.html');
    expect(r.status).toEqual({ state: 'vollstaendig' });
    expect(r.banner.found).toBe(true);
  });
});

describe('Lazy-Load und Nachladen', () => {
  it('A: lazy iframe wird erst durch das Scrollen geladen (nach Scrollbeginn)', async () => {
    server.useSite('scn-cmp');
    const r = await run('A', '/lazy.html', {
      banner: { detectTimeoutMs: 1000, settleMs: 200, reappearCheckMs: 200 },
      passiveReader: {
        networkIdleTimeoutMs: 2000,
        scrollStepPx: 800,
        scrollStepDelayMs: 50,
        bottomSettleMs: 300,
        mouseMoves: 2,
      },
    });
    expect(r.status).toEqual({ state: 'vollstaendig' });
    expect(r.banner.found).toBe(false);
    const yt = host(r.connections, 'www.youtube.com');
    expect(yt, JSON.stringify(r.connections.map((c) => c.host))).toBeDefined();
    expect(yt!.firstConnectAt!).toBeGreaterThanOrEqual(r.timing.scrollPhaseStartAt!);
  });

  it('B ohne Banner → UNVOLLSTÄNDIG (banner-nicht-gefunden)', async () => {
    server.useSite('scn-cmp');
    const r = await run('B', '/lazy.html', { banner: { detectTimeoutMs: 1000 } });
    expect(r.status.state === 'unvollstaendig' && r.status.reasonCode).toBe(
      'banner-nicht-gefunden',
    );
  });

  it('B: Tracker wird nach dem Ablehnen geladen → Verbindung nach bannerClickAt', async () => {
    server.useSite('scn-cmp');
    const r = await run('B', '/nach-ablehnen.html', { followLinks: 0 });
    expect(r.status).toEqual({ state: 'vollstaendig' });
    const t = host(r.connections, 'unknown-tracker.example');
    expect(t, JSON.stringify(r.connections.map((c) => c.host))).toBeDefined();
    expect(t!.firstConnectAt!).toBeGreaterThan(r.timing.bannerClickAt! + 100);
  });
});

describe('autoconsent', () => {
  it('B und C: bekanntes CMP wird über autoconsent bedient', async () => {
    server.useSite('scn-autoconsent');
    const b = await run('B', '/', { followLinks: 0 });
    expect(b.status, JSON.stringify(b.banner)).toEqual({ state: 'vollstaendig' });
    expect(b.banner).toMatchObject({
      found: true,
      method: 'autoconsent',
      cmp: 'abconcerts.be',
      clicked: 'reject',
      rejectFirstLayer: true,
    });
    expect(b.banner.detectedBy).toContain('autoconsent');
    expect(b.banner.autoconsent?.result).toBe(true);
    expect(b.timing.bannerClickAt).toBeGreaterThan(0);
    expect(host(b.connections, GTM)).toBeUndefined();

    const c = await run('C', '/', { followLinks: 0 });
    expect(c.status).toEqual({ state: 'vollstaendig' });
    expect(c.banner).toMatchObject({ method: 'autoconsent', clicked: 'accept' });
    const gtm = host(c.connections, GTM);
    expect(gtm).toBeDefined();
    expect(gtm!.firstConnectAt!).toBeGreaterThanOrEqual(c.timing.bannerClickAt! - 20);
  });

  it('Selektor-Override hat Vorrang', async () => {
    server.useSite('scn-cmp');
    const r = await run('B', '/', {
      followLinks: 0,
      banner: {
        rejectSelector: '#kt-reject',
        detectTimeoutMs: 3000,
        settleMs: 300,
        reappearCheckMs: 500,
      },
    });
    expect(r.status).toEqual({ state: 'vollstaendig' });
    expect(r.banner.method).toBe('selektor');
    expect(r.banner.clicked).toBe('reject');
  });
});

describe('Ladefehler', () => {
  it('HTTP 404 → UNVOLLSTÄNDIG (navigation-fehlgeschlagen), Bot-Wall (403) → bot-schutz', async () => {
    server.useSite('scn-cmp');
    const r = await run('A', '/gibt-es-nicht.html');
    expect(r.status.state === 'unvollstaendig' && r.status.reasonCode).toBe(
      'navigation-fehlgeschlagen',
    );
    server.route('www.kunde-test.de', '/blockiert.html', (_req, res) => {
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Just a moment...</title><p>cf-chl-bypass</p>');
      return true;
    });
    const b = await run('B', '/blockiert.html');
    expect(b.status.state === 'unvollstaendig' && b.status.reasonCode).toBe('bot-schutz');
    expect(b.banner.clicked).toBeUndefined();
    await stat(path.join(reportRoot, `r${counter}`, 'evidence', 'B-reject', 'netlog.json'));
  });
});
