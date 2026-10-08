import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { esc, renderHtmlReport, safeColor } from '../../src/report/html.js';
import { fixtureReport } from './report.helpers.js';

describe('renderHtmlReport', () => {
  it('escapes untrusted strings from host, cookie, customer, snippet', async () => {
    const html = await renderHtmlReport(fixtureReport());
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('Söhne <b>');
    expect(html).toContain('&#60;script&#62;alert(1)&#60;/script&#62;.evil.example');
    expect(html).toContain('&#60;iframe src=&#34;https://www.youtube.com/embed/x&#34;');
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).not.toMatch(/<script/i);
  });

  it('contains all sections, summary, metadata and sources', async () => {
    const r = fixtureReport({ manifestHash: 'd'.repeat(64) });
    const html = await renderHtmlReport(r);
    for (const h of [
      'Management-Summary',
      'Befunde nach Schweregrad',
      'Zeitleiste',
      'Szenario-Vergleich',
      'Screenshots',
      'Methodik',
    ])
      expect(html).toContain(h);
    expect(html).toContain('<svg');
    expect(html).toContain('keine Rechtsberatung');
    expect(html).toContain('IP-Geolokation: DB-IP.com');
    expect(html).toContain('EasyPrivacy');
    expect(html).toContain('d'.repeat(64));
    expect(html).toContain('Zeile 12');
    expect(html).toContain('203.0.113.5');
  });

  it('shows the yellow label when manual review is needed', async () => {
    const r = fixtureReport({ trafficLight: 'gelb' });
    r.assessment = {
      ...r.assessment!,
      trafficLight: 'gelb',
      label: 'Gelb – manuelle Prüfung nötig',
      manualReview: true,
    };
    const html = await renderHtmlReport(r);
    expect(html).toContain('Gelb – manuelle Prüfung nötig');
    expect(html).toContain('manuelle Prüfung ist nötig');
  });

  it('falls back to neutral Bello branding and sanitizes colours', async () => {
    const html = await renderHtmlReport(fixtureReport());
    expect(html).toContain('>Bello</span>');
    expect(html).toContain('--primary:#0a5');
    expect(safeColor('red;}</style><script>')).toBe('#0a5');
    expect(esc(`a"b'<`)).not.toMatch(/["'<]/);
  });

  it('applies company branding with inline logo', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bello-logo-'));
    try {
      const logo = path.join(dir, 'logo.svg');
      await writeFile(logo, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
      const html = await renderHtmlReport(fixtureReport(), {
        company: { name: 'Muster <GmbH>', logo, colors: { primary: '#123456' }, contact: 'a@b.de' },
      });
      expect(html).toContain('--primary:#123456');
      expect(html).toContain('data:image/svg+xml;base64,');
      expect(html).toContain('Muster &#60;GmbH&#62;');
      expect(html).toContain('a@b.de');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('groups crawl pages', async () => {
    const r = fixtureReport();
    r.pages.push({ ...r.pages[0]!, url: 'https://www.kunde.de/zweite' });
    const html = await renderHtmlReport(r);
    expect(html).toContain('Seite: https://www.kunde.de/zweite');
  });
});
