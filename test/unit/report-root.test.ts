import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildConfig,
  builtinConfig,
  ConfigError,
  globalConfigPath,
  loadConfig,
  resolveReportRoot,
  resolveScanOptions,
} from '../../src/config/index.js';
import { main } from '../../src/cli/program.js';

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'bello-root-'));
}

function writeCfg(file: string, yaml: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, yaml);
}

describe('Konfigurationssuche', () => {
  it('Reihenfolge: --config > cwd > global > eingebaut', () => {
    const home = scratch();
    const cwd = scratch();
    const env = { HOME: home } as NodeJS.ProcessEnv;
    const global = path.join(home, '.config', 'bello', 'bello.config.yaml');

    expect(loadConfig(undefined, cwd, env).path).toBeNull();

    writeCfg(global, 'company: { name: Global }\n');
    expect(loadConfig(undefined, cwd, env).path).toBe(global);
    expect(loadConfig(undefined, cwd, env).config.company.name).toBe('Global');

    writeCfg(path.join(cwd, 'bello.config.yaml'), 'company: { name: Cwd }\n');
    expect(loadConfig(undefined, cwd, env).config.company.name).toBe('Cwd');

    const explicit = path.join(cwd, 'x.yaml');
    writeCfg(explicit, 'company: { name: Explicit }\n');
    expect(loadConfig('x.yaml', cwd, env).config.company.name).toBe('Explicit');
  });

  it('XDG_CONFIG_HOME hat Vorrang vor ~/.config', () => {
    const home = scratch();
    const xdg = scratch();
    const env = { HOME: home, XDG_CONFIG_HOME: xdg } as NodeJS.ProcessEnv;
    expect(globalConfigPath(env)).toBe(path.join(xdg, 'bello', 'bello.config.yaml'));
    writeCfg(globalConfigPath(env), 'company: { name: Xdg }\n');
    expect(loadConfig(undefined, scratch(), env).config.company.name).toBe('Xdg');
  });
});

describe('defaults.outDir', () => {
  it('expandiert ~', () => {
    const c = buildConfig({ defaults: { outDir: '~/bello-reports' } }, '/base', '/home/u');
    expect(c.defaults.outDir).toBe('/home/u/bello-reports');
  });

  it('relativer Pfad gilt relativ zur Konfigurationsdatei', () => {
    const home = scratch();
    const cwd = scratch();
    const env = { HOME: home } as NodeJS.ProcessEnv;
    const global = path.join(home, '.config', 'bello', 'bello.config.yaml');
    writeCfg(global, 'defaults: { outDir: ./reports }\n');
    const loaded = loadConfig(undefined, cwd, env);
    expect(loaded.config.defaults.outDir).toBe(path.join(path.dirname(global), 'reports'));
  });

  it('eingebaute Standardwerte haben kein globales Verzeichnis', () => {
    expect(builtinConfig().defaults.outDir).toBeUndefined();
  });
});

describe('resolveReportRoot', () => {
  const cfg = buildConfig({ defaults: { outDir: '/global/reports' } }, '/base');
  const cwd = '/work/dir';

  it('Vorrang: --out > --here > Konfiguration > cwd', () => {
    expect(resolveReportRoot(cfg, { out: 'o', here: false }, cwd)).toEqual({
      dir: '/work/dir/o',
      source: 'out',
    });
    expect(resolveReportRoot(cfg, { here: true }, cwd)).toEqual({
      dir: '/work/dir/bello-reports',
      source: 'here',
    });
    expect(resolveReportRoot(cfg, {}, cwd)).toEqual({ dir: '/global/reports', source: 'config' });
    expect(resolveReportRoot(builtinConfig(), {}, cwd)).toEqual({
      dir: '/work/dir/bello-reports',
      source: 'cwd',
    });
  });

  it('--out zusammen mit --here ist ein Fehler', () => {
    expect(() => resolveReportRoot(cfg, { out: 'o', here: true }, cwd)).toThrow(ConfigError);
    expect(() => resolveReportRoot(cfg, { out: 'o', here: true }, cwd)).toThrow(
      /schließen sich aus/,
    );
  });

  it('resolveScanOptions übernimmt --here', () => {
    const o = resolveScanOptions(cfg, { url: 'example.de', cliFlags: { here: true } }, cwd);
    expect(o.outDir).toBe('/work/dir/bello-reports');
    expect(o.outDirSource).toBe('here');
  });
});

describe('CLI', () => {
  it('--out mit --here endet mit Exit-Code 3 und deutscher Meldung', async () => {
    const err: string[] = [];
    const code = await main(['node', 'bello', 'example.de', '--out', 'x', '--here'], {
      out: () => undefined,
      err: (s: string) => void err.push(s),
    } as never);
    expect(code).toBe(3);
    expect(err.join('')).toMatch(/--out und --here schließen sich aus/);
  });
});
