import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { ConfigError } from './errors.js';
import { configSchema, formatPath, germanError, type RawConfig } from './schema.js';

export interface AllowedProcessor {
  host: string;
  reason: string;
  avv?: string;
}

export interface CustomerConfig {
  id: string;
  name: string;
  url: string;
  crawl: boolean;
  maxPages?: number;
  delayMs?: number;
  waitSeconds?: number;
  firstPartyAliases: string[];
  allowedProcessors: AllowedProcessor[];
  banner: { rejectSelector?: string; acceptSelector?: string };
  /** Absolute path. */
  vendorsFile?: string;
}

export interface BelloConfig {
  company: {
    name: string;
    /** Absolute path, if configured. */
    logo?: string;
    colors: { primary: string; [key: string]: string | undefined };
    contact?: string;
  };
  defaults: {
    /** Global reports directory (absolute; `~` expanded, relative paths resolved against the config file's directory). Unset = <cwd>/bello-reports. */
    outDir?: string;
    waitSeconds: number;
    crawl: { maxPages: number; delayMs: number; sitesInParallel: number };
    pages?: number;
  };
  customers: Record<string, CustomerConfig>;
}

export interface LoadedConfig {
  config: BelloConfig;
  /** Absolute config path, or null when built-in defaults are used. */
  path: string | null;
  /** sha256 hex of the file content, or null when built-in defaults are used. */
  sha256: string | null;
}

export const DEFAULT_PRIMARY_COLOR = '#0a5';

export function builtinConfig(): BelloConfig {
  return {
    company: { name: 'Bello', colors: { primary: DEFAULT_PRIMARY_COLOR } },
    defaults: {
      waitSeconds: 10,
      crawl: { maxPages: 200, delayMs: 2000, sitesInParallel: 3 },
    },
    customers: {},
  };
}

const CONFIG_FILENAME = 'bello.config.yaml';

/** Expand a leading `~`, then resolve relative paths against the config file's directory. */
export function resolveConfigDir(value: string, baseDir: string, home: string): string {
  let v = value.trim();
  if (v === '~') v = home;
  else if (v.startsWith('~/') || v.startsWith('~\\')) v = path.join(home, v.slice(2));
  return path.resolve(baseDir, v);
}

/** Home directory used for `~` and the global config (HOME wins so tests can override it). */
export function homeDirOf(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME && path.isAbsolute(env.HOME) ? env.HOME : os.homedir();
}

/** `$XDG_CONFIG_HOME/bello/bello.config.yaml` (default `~/.config/...`, also on macOS). */
export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(homeDirOf(env), '.config');
  return path.join(base, 'bello', CONFIG_FILENAME);
}

/** Validate an already-parsed YAML value; paths are resolved relative to baseDir. */
export function buildConfig(
  raw: unknown,
  baseDir: string,
  home: string = os.homedir(),
): BelloConfig {
  const parsed = configSchema.safeParse(raw ?? {}, { error: germanError });
  if (!parsed.success) {
    throw new ConfigError(
      'Ungültige Konfiguration:',
      parsed.error.issues.map((i) => `${formatPath(i.path)}: ${i.message}`),
    );
  }
  return normalize(parsed.data, baseDir, home);
}

function normalize(raw: RawConfig, baseDir: string, home: string): BelloConfig {
  const base = builtinConfig();
  const rel = (p: string) => path.resolve(baseDir, p);
  const colors: BelloConfig['company']['colors'] = {
    ...base.company.colors,
    ...raw.company?.colors,
  };
  const d = raw.defaults;
  const customers: Record<string, CustomerConfig> = {};
  for (const [id, c] of Object.entries(raw.customers ?? {})) {
    customers[id] = {
      id,
      name: c.name,
      url: c.url,
      crawl: c.crawl ?? false,
      ...(c.maxPages !== undefined && { maxPages: c.maxPages }),
      ...(c.delayMs !== undefined && { delayMs: c.delayMs }),
      ...(c.waitSeconds !== undefined && { waitSeconds: c.waitSeconds }),
      firstPartyAliases: c.firstPartyAliases ?? [],
      allowedProcessors: c.allowedProcessors ?? [],
      banner: { ...c.banner },
      ...(c.vendorsFile !== undefined && { vendorsFile: rel(c.vendorsFile) }),
    };
  }
  return {
    company: {
      name: raw.company?.name ?? base.company.name,
      ...(raw.company?.logo !== undefined && { logo: rel(raw.company.logo) }),
      colors,
      ...(raw.company?.contact !== undefined && { contact: raw.company.contact }),
    },
    defaults: {
      ...(d?.outDir !== undefined && { outDir: resolveConfigDir(d.outDir, baseDir, home) }),
      waitSeconds: d?.waitSeconds ?? base.defaults.waitSeconds,
      crawl: {
        maxPages: d?.crawl?.maxPages ?? base.defaults.crawl.maxPages,
        delayMs: d?.crawl?.delayMs ?? base.defaults.crawl.delayMs,
        sitesInParallel: d?.crawl?.sitesInParallel ?? base.defaults.crawl.sitesInParallel,
      },
      ...(d?.pages !== undefined && { pages: d.pages }),
    },
    customers,
  };
}

/**
 * Load the configuration. Lookup order: explicit path (must exist) >
 * ./bello.config.yaml > global config (see globalConfigPath) > built-in defaults.
 */
export function loadConfig(
  configPath?: string,
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): LoadedConfig {
  let file: string;
  if (configPath !== undefined) {
    file = path.resolve(cwd, configPath);
    if (!existsSync(file) || !statSync(file).isFile()) {
      throw new ConfigError(`Konfigurationsdatei nicht gefunden: ${file}`);
    }
  } else {
    file = path.resolve(cwd, CONFIG_FILENAME);
    if (!isFile(file)) {
      file = globalConfigPath(env);
      if (!isFile(file)) return { config: builtinConfig(), path: null, sha256: null };
    }
  }

  let content: Buffer;
  try {
    content = readFileSync(file);
  } catch (e) {
    throw new ConfigError(`Konfigurationsdatei nicht lesbar: ${file} (${(e as Error).message})`);
  }

  let raw: unknown;
  try {
    raw = parseYaml(content.toString('utf8'));
  } catch (e) {
    if (e instanceof YAMLParseError) {
      const pos = e.linePos?.[0];
      const where = pos ? ` (Zeile ${pos.line}, Spalte ${pos.col})` : '';
      throw new ConfigError(`YAML-Syntaxfehler in ${file}${where}: ${e.message.split('\n')[0]}`);
    }
    throw e;
  }

  let config: BelloConfig;
  try {
    config = buildConfig(raw, path.dirname(file), homeDirOf(env));
  } catch (e) {
    if (e instanceof ConfigError && e.issues.length > 0) {
      throw new ConfigError(`Ungültige Konfiguration in ${file}:`, e.issues);
    }
    throw e;
  }
  return { config, path: file, sha256: createHash('sha256').update(content).digest('hex') };
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
