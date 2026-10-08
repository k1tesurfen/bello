import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkBannerDesign } from '../../src/capture/banner/index.js';
import {
  fetchPrivacyPolicyText,
  findPrivacyPolicyUrl,
} from '../../src/capture/privacypolicy/index.js';
import { launchScenarioBrowser, type ScenarioBrowser } from '../../src/browser/launch.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server.js';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let server: FixtureServer;
let sb: ScenarioBrowser;

beforeAll(async () => {
  server = await startFixtureServer({ site: 'pp-banner-links' });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bello-pp-'));
  sb = await launchScenarioBrowser({
    netLogPath: path.join(dir, 'netlog.json'),
    extraArgs: server.chromiumArgs(),
  });
}, 60_000);
afterAll(async () => {
  await sb?.close();
  await server?.close();
});

async function open(site: string, pathname = '/') {
  server.useSite(site);
  const page = await sb.context.newPage();
  await page.goto(server.url(pathname), { waitUntil: 'load' });
  return page;
}

describe('Banner-Design-Prüfung', () => {
  it('Links im Banner: Impressum und Datenschutz erreichbar, Ablehnen auf erster Ebene', async () => {
    const page = await open('pp-banner-links');
    const r = await checkBannerDesign(page, { found: true });
    expect(r).toMatchObject({
      rejectFirstLayer: true,
      imprintReachable: true,
      privacyPolicyReachable: true,
    });
    expect(r.details.length).toBeGreaterThan(0);
    await page.close();
  });

  it('Vollbild-Overlay ohne Links verdeckt den Footer: nicht erreichbar, kein Ablehnen', async () => {
    const page = await open('pp-overlay');
    const r = await checkBannerDesign(page, { found: true });
    expect(r.imprintReachable).toBe(false);
    expect(r.privacyPolicyReachable).toBe(false);
    expect(r.rejectFirstLayer).toBe(false);
    expect(r.details.join(' ')).toContain('verdeckt');
    await page.close();
  });
});

describe('Banner-Design-Prüfung (fester Banner unten)', () => {
  it('Footer-Links unter einem festen Banner sind nicht erreichbar', async () => {
    const page = await open('pp-bottom-banner');
    const r = await checkBannerDesign(page, { found: true });
    expect(r.imprintReachable).toBe(false);
    expect(r.privacyPolicyReachable).toBe(false);
    await page.close();
  });
});

describe('Datenschutzerklärung', () => {
  it('findet den Footer-Link (Datenschutzerklärung vor Datenschutz, ohne Cookie-Anker/javascript:)', async () => {
    const page = await open('pp-footer');
    const url = await findPrivacyPolicyUrl(page);
    expect(url).toBe(server.url('/datenschutzerklaerung.html'));
    await page.close();
  });

  it('findet Links im Banner und lädt den Text', async () => {
    const page = await open('pp-banner-links');
    const url = await findPrivacyPolicyUrl(page);
    expect(url).toBe(server.url('/datenschutz.html'));
    await page.close();
    server.useSite('pp-footer');
    const res = await fetchPrivacyPolicyText(sb.context, server.url('/datenschutzerklaerung.html'));
    expect(res.text).toContain('Google-Analytics');
    expect(res.text).toContain('YouTube');
    expect(res.text).not.toContain('versteckt');
    expect(res.text).not.toMatch(/\s{2}/);
  });
});
