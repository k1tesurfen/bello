import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildConfig,
  builtinConfig,
  ConfigError,
  loadConfig,
  normalizeUrl,
  resolveScanOptions,
} from '../../src/config/index.js';

function tmp(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'bello-cfg-'));
  for (const [n, c] of Object.entries(files)) writeFileSync(path.join(dir, n), c);
  return dir;
}

function issues(raw: unknown): string[] {
  try {
    buildConfig(raw, '/base');
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
  throw new Error('expected ConfigError');
}

const VALID = `
company:
  name: "Test GmbH"
  logo: ./assets/logo.svg
  colors: { primary: "#123456" }
  contact: "a@b.de"
defaults:
  outDir: ./out
  waitSeconds: 5
  crawl: { maxPages: 50, delayMs: 500, sitesInParallel: 2 }
customers:
  acme:
    name: "ACME"
    url: www.acme.de
    crawl: true
    maxPages: 10
    firstPartyAliases: [acme-cdn.de]
    allowedProcessors:
      - { host: "*.b-cdn.net", reason: "CDN" }
    banner: { rejectSelector: "#no" }
    vendorsFile: ./vendors.yaml
  beta:
    name: "Beta"
    url: https://beta.example
`;

describe('loadConfig', () => {
  it('loads a valid config with hash and resolved paths', () => {
    const dir = tmp({ 'bello.config.yaml': VALID });
    const r = loadConfig(path.join(dir, 'bello.config.yaml'));
    expect(r.path).toBe(path.join(dir, 'bello.config.yaml'));
    expect(r.sha256).toBe(createHash('sha256').update(VALID).digest('hex'));
    expect(r.config.company.logo).toBe(path.join(dir, 'assets/logo.svg'));
    expect(r.config.customers.acme?.vendorsFile).toBe(path.join(dir, 'vendors.yaml'));
    expect(r.config.customers.acme?.url).toBe('https://www.acme.de/');
    expect(r.config.customers.beta?.crawl).toBe(false);
    expect(r.config.defaults.crawl.sitesInParallel).toBe(2);
  });

  it('falls back to built-in defaults without a config file', () => {
    const dir = tmp({});
    const r = loadConfig(undefined, dir);
    expect(r.path).toBeNull();
    expect(r.sha256).toBeNull();
    expect(r.config).toEqual(builtinConfig());
    expect(r.config.defaults.crawl).toEqual({ maxPages: 200, delayMs: 2000, sitesInParallel: 3 });
    expect(r.config.company.name).toBe('Bello');
  });

  it('picks up ./bello.config.yaml from cwd', () => {
    const dir = tmp({ 'bello.config.yaml': 'company: { name: X }' });
    expect(loadConfig(undefined, dir).config.company.name).toBe('X');
  });

  it('fails when an explicit path does not exist', () => {
    expect(() => loadConfig('/nonexistent/x.yaml')).toThrow(/nicht gefunden/);
  });

  it('reports YAML syntax errors in German', () => {
    const dir = tmp({ 'c.yaml': 'company: [unclosed' });
    expect(() => loadConfig(path.join(dir, 'c.yaml'))).toThrow(/YAML-Syntaxfehler.*Zeile/);
  });

  it('treats an empty file as defaults', () => {
    const dir = tmp({ 'c.yaml': '' });
    expect(loadConfig(path.join(dir, 'c.yaml')).config.defaults.waitSeconds).toBe(10);
  });
});

describe('validation messages', () => {
  it('invalid URL with path', () => {
    expect(issues({ customers: { acme: { name: 'A', url: 'not a url' } } })).toContain(
      'customers.acme.url: Ungültige URL',
    );
  });
  it('missing required field', () => {
    expect(issues({ customers: { acme: { name: 'A' } } })).toContain(
      'customers.acme.url: Pflichtfeld fehlt',
    );
  });
  it('unknown key', () => {
    expect(issues({ foo: 1 })).toContain('(Wurzel): Unbekannter Schlüssel: „foo“');
    expect(issues({ customers: { a: { name: 'A', url: 'a.de', bogus: 1 } } })).toContain(
      'customers.a: Unbekannter Schlüssel: „bogus“',
    );
  });
  it('wrong type', () => {
    expect(issues({ defaults: { waitSeconds: 'viel' } })).toContain(
      'defaults.waitSeconds: Erwartet Zahl, gefunden: Text',
    );
  });
  it('range', () => {
    expect(issues({ defaults: { crawl: { maxPages: 0 } } })).toContain(
      'defaults.crawl.maxPages: Muss größer als 0 sein',
    );
  });
  it('lists every issue', () => {
    expect(
      issues({ defaults: { waitSeconds: 'x' }, customers: { a: { name: 'A', url: '' } } }).length,
    ).toBeGreaterThanOrEqual(2);
  });
  it('nested list paths', () => {
    expect(
      issues({
        customers: { a: { name: 'A', url: 'a.de', allowedProcessors: [{ host: '*.x.de' }] } },
      }),
    ).toContain('customers.a.allowedProcessors.0.reason: Pflichtfeld fehlt');
  });
});

describe('normalizeUrl', () => {
  it('adds https and validates', () => {
    expect(normalizeUrl('example.de')).toBe('https://example.de/');
    expect(normalizeUrl(' http://example.de/a?b=1 ')).toBe('http://example.de/a?b=1');
    expect(normalizeUrl('localhost:8080')).toBe('https://localhost:8080/');
    expect(() => normalizeUrl('ftp://example.de')).toThrow(/Ungültige URL/);
    expect(() => normalizeUrl('')).toThrow(ConfigError);
    expect(() => normalizeUrl('foo')).toThrow(ConfigError);
  });
});

describe('resolveScanOptions', () => {
  const cfg = buildConfig(
    {
      defaults: { outDir: './out', waitSeconds: 5, crawl: { maxPages: 50, delayMs: 500 } },
      customers: {
        acme: {
          name: 'ACME',
          url: 'acme.de',
          crawl: true,
          maxPages: 10,
          delayMs: 100,
          waitSeconds: 7,
          banner: { rejectSelector: '#cfg' },
          firstPartyAliases: ['x.de'],
        },
      },
    },
    '/base',
  );

  it('ad-hoc scan uses defaults', () => {
    const o = resolveScanOptions(builtinConfig(), { url: 'example.de' }, '/cwd');
    expect(o).toMatchObject({
      url: 'https://example.de/',
      crawl: false,
      maxPages: 200,
      delayMs: 2000,
      waitSeconds: 10,
      outDir: path.resolve('/cwd', './bello-reports'),
      pdf: true,
      headful: false,
      identify: false,
    });
    expect(o.customerId).toBeUndefined();
  });

  it('customer overrides defaults', () => {
    const o = resolveScanOptions(cfg, { customerId: 'acme' }, '/cwd');
    expect(o).toMatchObject({
      url: 'https://acme.de/',
      customerId: 'acme',
      crawl: true,
      maxPages: 10,
      delayMs: 100,
      waitSeconds: 7,
      rejectSelector: '#cfg',
      firstPartyAliases: ['x.de'],
      outDir: path.resolve('/cwd', './out'),
    });
  });

  it('CLI flags override customer', () => {
    const o = resolveScanOptions(
      cfg,
      {
        customerId: 'acme',
        url: 'other.de',
        cliFlags: {
          crawl: false,
          pages: 3,
          out: 'x',
          proxy: 'http://p:1',
          identify: true,
          rejectSelector: '#cli',
          acceptSelector: '#acc',
          wait: 1,
          noPdf: true,
          headful: true,
        },
      },
      '/cwd',
    );
    expect(o).toMatchObject({
      url: 'https://other.de/',
      crawl: false,
      maxPages: 3,
      outDir: '/cwd/x',
      proxy: 'http://p:1',
      identify: true,
      rejectSelector: '#cli',
      acceptSelector: '#acc',
      waitSeconds: 1,
      pdf: false,
      headful: true,
    });
  });

  it('unknown customer lists known ids', () => {
    expect(() => resolveScanOptions(cfg, { customerId: 'nope' })).toThrow(
      /Unbekannter Kunde „nope“.*acme/,
    );
  });

  it('requires a url', () => {
    expect(() => resolveScanOptions(cfg, {})).toThrow(/Keine URL/);
  });

  it('rejects invalid CLI url', () => {
    expect(() => resolveScanOptions(cfg, { url: 'ftp://x.de' })).toThrow(/Ungültige URL/);
  });
});
