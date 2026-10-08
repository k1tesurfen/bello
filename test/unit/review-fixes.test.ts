import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { comparableReports } from '../../src/batch/run.js';
import { bodyToText, discoverPages, normalizePageUrl, siteKey } from '../../src/crawl/index.js';
import { createReportDir, domainOf } from '../../src/scan/paths.js';
import type { ScanReport } from '../../src/types.js';

describe('domainOf / createReportDir', () => {
  it('bildet Punkt-Hosts und leere Hosts auf unbekannt ab, Port im Namen', () => {
    expect(domainOf('http://../x')).not.toBe('..');
    expect(domainOf('http://./x')).toBe('unbekannt');
    expect(domainOf('not a url')).toBe('unbekannt');
    expect(domainOf('https://Example.de/')).toBe('example.de');
    expect(domainOf('https://example.de:8080/')).toBe('example.de_8080');
    expect(domainOf('https://example.de:443/')).toBe('example.de');
  });
  it('legt das Verzeichnis immer innerhalb von outDir an', async () => {
    const out = await mkdtemp(path.join(os.tmpdir(), 'bello-paths-'));
    try {
      const dir = await createReportDir(out, 'http://../x', new Date());
      expect(path.relative(out, dir).startsWith('..')).toBe(false);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});

describe('normalizePageUrl', () => {
  it('behandelt Trailing Slash und index.html/php als dieselbe Seite', () => {
    const n = (u: string) => normalizePageUrl(u);
    expect(n('https://e.de/a/')).toBe(n('https://e.de/a'));
    expect(n('https://e.de/a/index.html')).toBe(n('https://e.de/a'));
    expect(n('https://e.de/index.php')).toBe('https://e.de/');
    expect(n('https://e.de/')).toBe('https://e.de/');
  });
  it('nutzt private Domains (github.io) für Same-Site', () => {
    expect(siteKey('https://a.github.io/')).not.toBe(siteKey('https://b.github.io/'));
  });
});

describe('Crawl-Härtung', () => {
  it('folgt keinem Redirect auf eine fremde Site', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url === 'https://e.de/robots.txt')
        return new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/' },
        });
      return new Response('x', { status: 404 });
    }) as typeof fetch;
    await discoverPages('https://e.de/', { maxPages: 5, fetchImpl, delayMs: 0 });
    expect(calls.some((c) => c.includes('169.254'))).toBe(false);
  });
  it('verwirft zu große Antworten und Gzip-Bomben', async () => {
    const big = 'a'.repeat(9 * 1024 * 1024);
    const fetchImpl = (async (input: string | URL | Request) =>
      String(input).endsWith('/sitemap.xml')
        ? new Response(`<urlset><url><loc>https://e.de/x</loc></url></urlset>${big}`)
        : new Response('', { status: 404 })) as typeof fetch;
    const r = await discoverPages('https://e.de/', { maxPages: 5, fetchImpl, delayMs: 0 });
    expect(r.pages).toEqual(['https://e.de/']);
    expect(bodyToText(gzipSync(Buffer.alloc(30 * 1024 * 1024)))).toBe('');
  });
  it('reicht userAgent durch', async () => {
    const uas: string[] = [];
    const fetchImpl = (async (_i: unknown, init?: RequestInit) => {
      uas.push(String((init?.headers as Record<string, string>)['user-agent']));
      return new Response('', { status: 404 });
    }) as typeof fetch;
    await discoverPages('https://e.de/', { maxPages: 1, fetchImpl, delayMs: 0, userAgent: 'X/1' });
    expect(uas.every((u) => u === 'X/1')).toBe(true);
  });
});

describe('comparableReports', () => {
  const rep = (pages: number, customer?: string, cmd: string[] = []): ScanReport =>
    ({
      pages: Array.from({ length: pages }, () => ({})),
      meta: { commandLine: cmd },
      ...(customer ? { customer } : {}),
    }) as unknown as ScanReport;
  it('Quick-Check ist keine Basis für einen Crawl', () => {
    expect(comparableReports(rep(1), rep(200))).toBe(false);
    expect(comparableReports(rep(50), rep(200))).toBe(true);
    expect(comparableReports(rep(1, 'a'), rep(1, 'a'))).toBe(true);
    expect(comparableReports(rep(1, 'a'), rep(1, 'b'))).toBe(false);
    expect(comparableReports(rep(1, undefined, ['--crawl']), rep(30))).toBe(true);
  });
});
