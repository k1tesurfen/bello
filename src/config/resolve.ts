import path from 'node:path';
import { ConfigError } from './errors.js';
import type { AllowedProcessor, BelloConfig } from './load.js';
import { tryNormalizeUrl } from './url.js';

export { tryNormalizeUrl } from './url.js';

export interface CliFlags {
  crawl?: boolean;
  pages?: number;
  out?: string;
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
  /** Absolute output directory (relative values resolve against cwd). */
  outDir: string;
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
    outDir: path.resolve(cwd, flags.out ?? d.outDir),
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
