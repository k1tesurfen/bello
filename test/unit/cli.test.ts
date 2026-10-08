import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/program.js';
import type { CliIo } from '../../src/cli/io.js';
import type { Finding, ScanReport } from '../../src/types.js';

function io(): CliIo & { stdout: string; stderr: string } {
  const o = {
    stdout: '',
    stderr: '',
    color: false,
    out(t: string) {
      o.stdout += t + '\n';
    },
    err(t: string) {
      o.stderr += t + '\n';
    },
  };
  return o;
}

const finding = (id: string): Finding => ({
  id,
  severity: 'KRITISCH',
  scenarios: ['A'],
  category: 'drittverbindung',
  title: `Befund ${id}`,
  description: '',
  evidence: [],
});
const report = (findings: Finding[], trafficLight: ScanReport['trafficLight']): ScanReport => ({
  schemaVersion: 1,
  url: 'https://www.kunde-test.de/',
  meta: {
    startedAt: '2026-10-08T00:00:00.000Z',
    belloVersion: '0.1.0',
    commandLine: [],
    crawl: false,
  },
  trafficLight,
  pages: [],
  classifications: [],
  findings,
});

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'bello-cli-'));
  await writeFile(
    path.join(dir, 'a.json'),
    JSON.stringify(report([finding('x'), finding('y')], 'rot')),
  );
  await writeFile(
    path.join(dir, 'b.json'),
    JSON.stringify(report([finding('y'), finding('z')], 'rot')),
  );
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const argv = (...a: string[]): string[] => ['node', 'bello', ...a];

describe('CLI', () => {
  it('--all ohne Kunden in der Konfiguration → Exit 3, deutsche Meldung', async () => {
    const cfg = path.join(dir, 'leer.yaml');
    await writeFile(cfg, 'company:\n  name: Test\n');
    const o = io();
    expect(await main(argv('scan', '--all', '--config', cfg), o)).toBe(3);
    expect(o.stderr).toContain('keine Kunden');
  });
  it('unbekannter Kunde → Exit 3', async () => {
    const o = io();
    expect(await main(argv('scan', '--customer', 'gibtsnicht'), o)).toBe(3);
    expect(o.stderr).toContain('Unbekannter Kunde');
  });
  it('ohne URL → Exit 3 mit Hinweis', async () => {
    const o = io();
    expect(await main(argv('scan'), o)).toBe(3);
    expect(o.stderr).toContain('Keine URL angegeben');
  });
  it('ungültige --pages → Exit 3', async () => {
    expect(await main(argv('example.de', '--pages', 'abc'), io())).toBe(3);
  });
  it('fehlende Config-Datei → deutsche Meldung, Exit 3', async () => {
    const o = io();
    expect(await main(argv('example.de', '--config', path.join(dir, 'fehlt.yaml')), o)).toBe(3);
    expect(o.stderr).toContain('Konfigurationsdatei nicht gefunden');
  });
  it('diff: neu / behoben / unverändert', async () => {
    const o = io();
    expect(await main(argv('diff', path.join(dir, 'a.json'), path.join(dir, 'b.json')), o)).toBe(0);
    expect(o.stdout).toContain('Neu (1)');
    expect(o.stdout).toContain('Befund z');
    expect(o.stdout).toContain('Behoben (1)');
    expect(o.stdout).toContain('Unverändert (1)');
  });
  it('diff --json', async () => {
    const o = io();
    await main(argv('diff', '--json', path.join(dir, 'a.json'), path.join(dir, 'b.json')), o);
    const d = JSON.parse(o.stdout);
    expect(d.fixed.map((f: Finding) => f.id)).toEqual(['x']);
  });
  it('diff mit fehlender Datei → Exit 3', async () => {
    expect(
      await main(argv('diff', path.join(dir, 'nix.json'), path.join(dir, 'b.json')), io()),
    ).toBe(3);
  });
  it('--version / --help → Exit 0', async () => {
    expect(await main(argv('--version'), io())).toBe(0);
    expect(await main(argv('--help'), io())).toBe(0);
  });
});

describe('commander-Fehler auf Deutsch', () => {
  it('unbekannte Option → deutsche Meldung, Exit 3', async () => {
    const o = io();
    const code = await main(['node', 'bello', 'scan', 'example.de', '--gibtsnicht'], o);
    expect(code).toBe(3);
    expect(o.stderr).toContain('Unbekannte Option');
    expect(o.stderr).not.toMatch(/unknown option/i);
  });
  it('ungültiger Wert → deutsche Meldung', async () => {
    const o = io();
    const code = await main(['node', 'bello', 'scan', 'example.de', '--pages', 'abc'], o);
    expect(code).toBe(3);
    expect(o.stderr).toContain('Ungültiger Wert');
  });
});
