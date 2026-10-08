/** Batch over customers (PLAN §3, §11): sites in parallel, pages per site sequential. */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_UA, discoverPages, type DiscoverResult } from '../crawl/discover.js';
import { BELLO_VERSION } from '../version.js';
import { diffReports } from '../analyze/diff.js';
import { resolveReportRoot, resolveScanOptions, ConfigError } from '../config/index.js';
import type { BelloConfig, CliFlags } from '../config/index.js';
import { readJsonReport } from '../report/json.js';
import { domainOf, scanSite } from '../scan/index.js';
import type { ScanProgress, ScanSiteOptions, ScanSiteResult } from '../scan/index.js';
import type { ScanReport, Severity, TrafficLight } from '../types.js';
import { runPool } from './pool.js';

export type ExitCode = 0 | 1 | 2 | 3;

const LIGHT_EXIT: Record<TrafficLight, ExitCode> = { gruen: 0, gelb: 1, rot: 2 };

export interface ChangeSummary {
  previousReportDir: string;
  previousStartedAt: string;
  neu: number;
  behoben: number;
  unveraendert: number;
  /** Severity changed. */
  geaendert: number;
  trafficLight: { before: TrafficLight; after: TrafficLight };
}

export interface CustomerResult {
  id: string;
  name: string;
  url: string;
  status: 'ok' | 'fehler';
  /** 0 Grün, 1 Gelb, 2 Rot, 3 Fehler. */
  exitCode: ExitCode;
  trafficLight?: TrafficLight;
  severityCounts?: Partial<Record<Severity, number>>;
  pagesScanned?: number;
  crawlSource?: DiscoverResult['source'];
  reportDir?: string;
  reportPath?: string;
  error?: string;
  change?: ChangeSummary;
  durationMs: number;
}

export interface BatchResult {
  startedAt: string;
  finishedAt: string;
  outDir: string;
  customers: CustomerResult[];
  exitCode: ExitCode;
}

export interface BatchProgress {
  type: 'customer-start' | 'customer-done' | 'customer-error' | 'scan' | 'crawl';
  customerId: string;
  message: string;
}

export interface RunBatchOptions {
  /** Customer ids; default: all customers of the configuration. */
  customers?: string[];
  cliFlags: CliFlags;
  onProgress?: (p: BatchProgress) => void;
  /** Passed to every scanSite call (config path/hash, command line, test switches). */
  scanExtras?: Partial<ScanSiteOptions>;
  /** Fetch used for page discovery (tests). */
  discoverFetch?: typeof fetch;
  /** Politeness delay of discovery (tests). */
  discoverDelayMs?: number;
  /** Replaceable scan function (tests). */
  scanFn?: (opts: ScanSiteOptions) => Promise<ScanSiteResult>;
}

/** Worst exit code wins: 3 > 2 > 1 > 0. */
export function aggregateExitCode(codes: readonly number[]): ExitCode {
  let worst = 0;
  for (const c of codes) if (c > worst) worst = c;
  return Math.min(3, worst) as ExitCode;
}

export function severityCountsOf(report: ScanReport): Partial<Record<Severity, number>> {
  const c: Partial<Record<Severity, number>> = {};
  for (const f of report.findings) c[f.severity] = (c[f.severity] ?? 0) + 1;
  return c;
}

/** Crawl-like = several pages or a `--crawl` flag in the recorded command line. */
function isCrawlReport(r: ScanReport): boolean {
  // Older reports lack meta.crawl; fall back to the page count / command line.
  if (typeof r.meta.crawl === 'boolean') return r.meta.crawl;
  return r.pages.length > 1 || r.meta.commandLine.some((a) => a === '--crawl');
}

/** A 1-page quick check must not become the baseline of a crawl (and vice versa). */
export function comparableReports(prev: ScanReport, cur: ScanReport): boolean {
  const prevCustomer = prev.meta.customerId ?? prev.customer;
  const curCustomer = cur.meta.customerId ?? cur.customer;
  if (prevCustomer !== undefined && curCustomer !== undefined && prevCustomer !== curCustomer)
    return false;
  return isCrawlReport(prev) === isCrawlReport(cur);
}

/** Latest comparable report.json of `<outDir>/<domain>/` that is older than `currentReportDir`. */
export async function findPreviousReportDir(
  outDir: string,
  url: string,
  currentReportDir: string,
  current?: ScanReport,
): Promise<string | null> {
  const domainDir = path.join(outDir, domainOf(url));
  let names: string[];
  try {
    names = await readdir(domainDir);
  } catch {
    return null;
  }
  const cur = path.basename(currentReportDir);
  const older = names
    .filter((n) => n < cur && /^\d{4}-\d\d-\d\dT/.test(n))
    .sort()
    .reverse();
  for (const n of older) {
    try {
      const prev = await readJsonReport(path.join(domainDir, n));
      if (current && !comparableReports(prev, current)) continue;
      return path.join(domainDir, n);
    } catch {
      /* unreadable or other schema – try the next older one */
    }
  }
  return null;
}

export async function computeChange(
  outDir: string,
  report: ScanReport,
  reportDir: string,
): Promise<ChangeSummary | undefined> {
  const prevDir = await findPreviousReportDir(outDir, report.url, reportDir, report);
  if (!prevDir) return undefined;
  const prev = await readJsonReport(prevDir);
  const d = diffReports(prev, report);
  return {
    previousReportDir: prevDir,
    previousStartedAt: prev.meta.startedAt,
    neu: d.new.length,
    behoben: d.fixed.length,
    unveraendert: d.unchanged.length,
    geaendert: d.changed.length,
    trafficLight: d.trafficLight,
  };
}

export async function runBatch(config: BelloConfig, opts: RunBatchOptions): Promise<BatchResult> {
  const ids = opts.customers ?? Object.keys(config.customers);
  if (ids.length === 0)
    throw new ConfigError(
      'In der Konfiguration sind keine Kunden definiert (Abschnitt „customers“).',
    );
  const startedAt = new Date().toISOString();
  const emit = (p: BatchProgress): void => opts.onProgress?.(p);
  const scan = opts.scanFn ?? scanSite;
  const parallel = config.defaults.crawl.sitesInParallel || 3;
  let outDir = '';

  const results = await runPool(ids, parallel, async (id): Promise<CustomerResult> => {
    const t0 = Date.now();
    const customer = config.customers[id];
    const base = {
      id,
      name: customer?.name ?? id,
      url: customer?.url ?? '',
    };
    try {
      const scanOpts = resolveScanOptions(config, { customerId: id, cliFlags: opts.cliFlags });
      outDir = scanOpts.outDir;
      emit({ type: 'customer-start', customerId: id, message: `Prüfe ${scanOpts.url} …` });
      let pages: string[] | undefined;
      let crawlSource: DiscoverResult['source'] | undefined;
      if (scanOpts.crawl) {
        const d = await discoverPages(scanOpts.url, {
          maxPages: scanOpts.maxPages,
          ...(scanOpts.proxy ? { proxy: scanOpts.proxy } : {}),
          delayMs: opts.discoverDelayMs ?? scanOpts.delayMs,
          ...(scanOpts.identify ? { userAgent: `${DEFAULT_UA} Bello/${BELLO_VERSION}` } : {}),
          ...(opts.discoverFetch ? { fetchImpl: opts.discoverFetch } : {}),
        });
        pages = d.pages;
        crawlSource = d.source;
        emit({
          type: 'crawl',
          customerId: id,
          message: `${d.pages.length} Seite(n) ermittelt (${d.source === 'sitemap' ? 'Sitemap' : 'Link-Crawl'}).`,
        });
      }
      const res = await scan({
        ...scanOpts,
        ...opts.scanExtras,
        ...(pages ? { pages } : {}),
        onProgress: (p: ScanProgress) => {
          if (p.type !== 'done') emit({ type: 'scan', customerId: id, message: p.message });
        },
      });
      const change = await computeChange(scanOpts.outDir, res.report, res.reportDir).catch(
        () => undefined,
      );
      const exitCode = LIGHT_EXIT[res.report.trafficLight];
      emit({
        type: 'customer-done',
        customerId: id,
        message: `Ampel ${res.report.trafficLight.toUpperCase()}`,
      });
      return {
        ...base,
        url: scanOpts.url,
        status: 'ok',
        exitCode,
        trafficLight: res.report.trafficLight,
        severityCounts: severityCountsOf(res.report),
        pagesScanned: res.report.pages.length,
        ...(crawlSource ? { crawlSource } : {}),
        reportDir: res.reportDir,
        reportPath: res.reportPath,
        ...(change ? { change } : {}),
        durationMs: Date.now() - t0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: 'customer-error', customerId: id, message });
      return {
        ...base,
        status: 'fehler',
        exitCode: 3,
        error: message,
        durationMs: Date.now() - t0,
      };
    }
  });

  if (!outDir) outDir = resolveReportRoot(config, opts.cliFlags).dir;
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    outDir,
    customers: results,
    exitCode: aggregateExitCode(results.map((r) => r.exitCode)),
  };
}
