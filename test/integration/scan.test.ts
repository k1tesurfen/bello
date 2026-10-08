/**
 * End-to-end: scanSite on hermetic fixture sites (PLAN §15) – all three scenarios in real
 * Chromium processes, classification with the bundled vendors.yaml, analysis and report.json.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Classifier } from '../../src/classify/index.js';
import { builtinConfig, resolveScanOptions } from '../../src/config/index.js';
import { FAST_TUNING } from '../../src/cli/program.js';
import { scanSite, type ScanSiteResult } from '../../src/scan/index.js';
import { renderTerminal } from '../../src/report/terminal.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let server: FixtureServer;
let outDir: string;
let classifier: Classifier;

beforeAll(async () => {
  server = await startFixtureServer({ site: 'scan-youtube' });
  outDir = await mkdtemp(path.join(os.tmpdir(), 'bello-scan-'));
  classifier = await Classifier.create({ skipExternalData: true });
});
afterAll(async () => {
  await server.close();
  await rm(outDir, { recursive: true, force: true });
});

async function scan(site: string, pages?: string[]): Promise<ScanSiteResult> {
  server.useSite(site);
  const opts = resolveScanOptions(builtinConfig(), {
    url: server.url('/'),
    cliFlags: { out: outDir, wait: 0.5 },
  });
  return scanSite({
    ...opts,
    ...(pages ? { pages } : {}),
    delayMs: 0,
    launchArgs: server.chromiumArgs(),
    exitIpResult: { ip: '192.0.2.1', country: 'DE', check: { status: 'ok', inEu: true } },
    classifier,
    scenarioTuning: FAST_TUNING,
    commandLine: ['bello', 'test'],
  });
}

describe('scanSite – End-to-End auf Fixture-Sites', { timeout: 180_000 }, () => {
  it('(a) YouTube-iframe im HTML + Autoblocker-CMP → Rot, KRITISCH mit Ursache und Zeile', async () => {
    const { report, reportDir, reportPath } = await scan('scan-youtube');
    expect(report.trafficLight).toBe('rot');
    const yt = report.findings.find((f) => f.host === 'www.youtube.com');
    expect(yt, JSON.stringify(report.findings, null, 2)).toBeDefined();
    expect(yt!.severity).toBe('KRITISCH');
    expect(yt!.scenarios).toEqual(expect.arrayContaining(['A', 'B']));
    expect(yt!.causeClass).toBe('html-quelltext');
    const snip = yt!.evidence.find((e) => e.snippet)?.snippet;
    expect(snip?.line).toBe(9);
    expect(snip?.text).toContain('<iframe');
    expect(yt!.description).toMatch(/ms nach Navigationsstart/);
    expect(yt!.country).toBe('US');

    // Report bundle and metadata (Beweissicherung)
    expect(reportPath).toBe(path.join(reportDir, 'report.json'));
    const saved = JSON.parse(await readFile(reportPath, 'utf8'));
    expect(saved.schemaVersion).toBe(1);
    expect(saved.meta.belloVersion).toBeTruthy();
    expect(saved.meta.chromiumVersion).toMatch(/^\d+\./);
    expect(saved.meta.exitIpCheck.status).toBe('ok');
    expect(saved.meta.commandLine).toEqual(['bello', 'test']);
    expect(saved.meta.crawl).toBe(false);
    expect(path.basename(reportDir)).toMatch(/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ$/);
    expect(path.basename(path.dirname(reportDir))).toBe('www.kunde-test.de');
    for (const f of [
      'netlog.json',
      'cookies.json',
      'storage.json',
      'fingerprinting.json',
      'raw.html',
    ]) {
      expect(existsSync(path.join(reportDir, 'evidence', 'A-no-interaction', f)), f).toBe(true);
    }
    expect(saved.pages[0].scenarios[0].extras).toBeUndefined();

    const text = renderTerminal(report, reportPath, { color: false });
    expect(text).toContain('ROT');
    expect(text).toContain('www.youtube.com');
    expect(text).toContain(reportPath);
  });

  it('(b) korrekte Einbindung (data-src + CMP, GTM erst nach Akzeptieren) → Grün', async () => {
    const { report } = await scan('scan-korrekt');
    const detail = JSON.stringify(
      { a: report.assessment, f: report.findings.map((f) => [f.severity, f.title, f.scenarios]) },
      null,
      2,
    );
    expect(report.trafficLight, detail).toBe('gruen');
    expect(report.findings.every((f) => f.severity === 'INFO')).toBe(true);
    const gtm = report.findings.find((f) => f.host === 'www.googletagmanager.com');
    expect(gtm, detail).toBeDefined();
    expect(gtm!.scenarios).toEqual(['C']);
    expect(report.pages[0]!.bannerDesign?.rejectFirstLayer).toBe(true);
    expect(report.pages[0]!.privacyPolicy?.url).toContain('/datenschutz.html');
    expect(report.pages[0]!.privacyPolicy?.missing).toEqual([]);
  });

  it('(c) nicht bedienbarer Banner → Gelb (manuelle Prüfung), nie Grün', async () => {
    const { report } = await scan('scan-kaputt');
    expect(report.trafficLight).toBe('gelb');
    expect(report.assessment?.manualReview).toBe(true);
    expect(report.assessment?.label).toBe('Gelb – manuelle Prüfung nötig');
    const inc = report.assessment!.incomplete.map((i) => [i.scenario, i.reasonCode]);
    expect(inc).toEqual([
      ['B', 'banner-nicht-bedienbar'],
      ['C', 'banner-nicht-bedienbar'],
    ]);
  });

  it('(d) kein Banner + Google Fonts → Rot', async () => {
    const { report } = await scan('scan-font');
    expect(report.trafficLight).toBe('rot');
    const banner = report.findings.find((f) => f.category === 'banner');
    expect(banner?.severity).toBe('KRITISCH');
    expect(report.findings.find((f) => f.host === 'fonts.googleapis.com')?.severity).toBe(
      'KRITISCH',
    );
  });

  it('(e) kein Banner + nur First Party → Grün', async () => {
    const { report } = await scan('scan-first-party');
    expect(report.trafficLight, JSON.stringify(report.assessment)).toBe('gruen');
    expect(report.assessment?.neutralized.map((n) => n.scenario)).toEqual(['B', 'C']);
  });

  it('mehrere Seiten: Evidence unter evidence/<seite>/<szenario>/', async () => {
    const { report, reportDir } = await scan('scan-first-party', [
      server.url('/'),
      server.url('/datenschutz.html'),
    ]);
    expect(report.pages).toHaveLength(2);
    expect(
      existsSync(
        path.join(reportDir, 'evidence', '01-startseite', 'A-no-interaction', 'netlog.json'),
      ),
    ).toBe(true);
    expect(
      existsSync(
        path.join(reportDir, 'evidence', '02-datenschutz-html', 'C-accept', 'cookies.json'),
      ),
    ).toBe(true);
    expect(report.pages[1]!.scenarios[0]!.evidenceFiles[0]).toMatch(
      /^evidence\/02-datenschutz-html\//,
    );
    expect(report.trafficLight).toBe('gruen');
  });
});

describe('CLI-Smoke (dist/cli/index.js)', { timeout: 180_000 }, () => {
  it('Exit-Code 2 (Rot) für die YouTube-Fixture', async () => {
    const cli = path.join(ROOT, 'dist', 'cli', 'index.js');
    if (!existsSync(cli)) {
      await promisify(execFile)('pnpm', ['-s', 'build'], { cwd: ROOT });
    }
    server.useSite('scan-youtube');
    const args = [
      cli,
      server.url('/'),
      '--out',
      outDir,
      '--wait',
      '0.5',
      '--skip-ip-check',
      '--fast',
      ...server.chromiumArgs().flatMap((a) => ['--chromium-arg', a]),
    ];
    const res = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        execFile(
          process.execPath,
          args,
          { cwd: outDir, env: { ...process.env, NO_COLOR: '1' } },
          (err, stdout, stderr) => {
            resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
          },
        );
      },
    );
    expect(res.code, res.stderr).toBe(2);
    expect(res.stdout).toContain('www.youtube.com');
    expect(res.stdout).toContain('report.json');
  });
});
