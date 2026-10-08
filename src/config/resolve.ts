import path from 'node:path';
import { ConfigError } from './errors.js';
import type { AllowedProcessor, BelloConfig } from './load.js';
import { tryNormalizeUrl } from './url.js';

export { tryNormalizeUrl } from './url.js';

export interface CliFlags {
  crawl?: boolean;
  pages?: number;
  out?: string;
  /** --here: reports go to <cwd>/bello-reports. */
  here?: boolean;
  proxy?: string;
  identify?: boolean;
  rejectSelector?: string;
  acceptSelector?: string;
  wait?: number;
  /** True when --no-pdf was given. */
  noPdf?: boolean;
  headful?: boolean;
}

export interface ScanOptions {
  url: string;
  customerId?: string;
  customerName?: string;
  crawl: boolean;
  maxPages: number;
  delayMs: number;
  sitesInParallel: number;
  waitSeconds: number;
  /** Absolute report root. */
  outDir: string;
  outDirSource: ReportRootSource;
  proxy?: string;
  identify: boolean;
  rejectSelector?: string;
  acceptSelector?: string;
  pdf: boolean;
  headful: boolean;
  firstPartyAliases: string[];
  allowedProcessors: AllowedProcessor[];
  vendorsFile?: string;
  company: BelloConfig['company'];
}

export type ReportRootSource = 'out' | 'here' | 'config' | 'cwd';
export interface ReportRoot {
  dir: string;
  source: ReportRootSource;
}

/** Report root precedence: --out > --here > config defaults.outDir > <cwd>/bello-reports. */
export function resolveReportRoot(
  config: BelloConfig,
  flags: Pick<CliFlags, 'out' | 'here'> = {},
  cwd: string = process.cwd(),
): ReportRoot {
  if (flags.out !== undefined && flags.here) {
    throw new ConfigError(
      '--out und --here schließen sich aus. Bitte nur eine der Optionen angeben.',
    );
  }
  if (flags.out !== undefined) return { dir: path.resolve(cwd, flags.out), source: 'out' };
  if (flags.here) return { dir: path.resolve(cwd, 'bello-reports'), source: 'here' };
  if (config.defaults.outDir !== undefined)
    return { dir: config.defaults.outDir, source: 'config' };
  return { dir: path.resolve(cwd, 'bello-reports'), source: 'cwd' };
}

/** German reason for where the report root comes from. */
export function describeReportRoot(source: ReportRootSource, configPath: string | null): string {
  switch (source) {
    case 'out':
      return 'per --out';
    case 'here':
      return 'per --here im aktuellen Verzeichnis';
    case 'config':
      return `aus Konfiguration ${configPath ?? '(unbekannt)'}`;
    case 'cwd':
      return 'aktuelles Verzeichnis';
  }
}

export function normalizeUrl(input: string): string {
  const url = tryNormalizeUrl(input);
  if (url === null) throw new ConfigError(`Ungültige URL: „${input}“`);
  return url;
}

export function resolveScanOptions(
  config: BelloConfig,
  args: { customerId?: string; url?: string; cliFlags?: CliFlags },
  cwd: string = process.cwd(),
): ScanOptions {
  const flags = args.cliFlags ?? {};
  const customer = args.customerId !== undefined ? config.customers[args.customerId] : undefined;
  if (args.customerId !== undefined && !customer) {
    const known = Object.keys(config.customers);
    throw new ConfigError(
      `Unbekannter Kunde „${args.customerId}“. ` +
        (known.length > 0
          ? `Bekannte Kunden: ${known.join(', ')}`
          : 'In der Konfiguration sind keine Kunden definiert.'),
    );
  }

  const rawUrl = args.url ?? customer?.url;
  if (rawUrl === undefined)
    throw new ConfigError('Keine URL angegeben (URL oder --customer erforderlich).');

  const d = config.defaults;
  const root = resolveReportRoot(config, flags, cwd);
  const maxPages = flags.pages ?? customer?.maxPages ?? d.pages ?? d.crawl.maxPages;
  const rejectSelector = flags.rejectSelector ?? customer?.banner.rejectSelector;
  const acceptSelector = flags.acceptSelector ?? customer?.banner.acceptSelector;

  return {
    url: normalizeUrl(rawUrl),
    ...(customer && { customerId: customer.id, customerName: customer.name }),
    crawl: flags.crawl ?? customer?.crawl ?? false,
    maxPages,
    delayMs: customer?.delayMs ?? d.crawl.delayMs,
    sitesInParallel: d.crawl.sitesInParallel,
    waitSeconds: flags.wait ?? customer?.waitSeconds ?? d.waitSeconds,
    outDir: root.dir,
    outDirSource: root.source,
    ...(flags.proxy !== undefined && { proxy: flags.proxy }),
    identify: flags.identify ?? false,
    ...(rejectSelector !== undefined && { rejectSelector }),
    ...(acceptSelector !== undefined && { acceptSelector }),
    pdf: !(flags.noPdf ?? false),
    headful: flags.headful ?? false,
    firstPartyAliases: customer?.firstPartyAliases ?? [],
    allowedProcessors: customer?.allowedProcessors ?? [],
    ...(customer?.vendorsFile !== undefined && { vendorsFile: customer.vendorsFile }),
    company: config.company,
  };
}
