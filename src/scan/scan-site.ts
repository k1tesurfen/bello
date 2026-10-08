/**
 * Scan pipeline (PLAN §3, §4, §10): exit-IP check, every page × scenario A/B/C in a fresh
 * browser, storage/fingerprinting/consent-mode capture, banner design and privacy policy checks,
 * classification, analysis and report.json.
 *
 * Crawl/batch modules only need to pass the page list (`pages`).
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import type { ProxyOptions } from '../browser/launch.js';
import {
  analyze,
  allConnections,
  isRealConnection,
  type AnalyzePage,
  type AnalyzeScenario,
} from '../analyze/index.js';
import { checkBannerDesign, type BannerDesignResult } from '../capture/banner/index.js';
import { parseConsentModePing } from '../capture/consentmode/index.js';
import {
  startFingerprintCapture,
  toFingerprintEvents,
  type FingerprintCapture,
} from '../capture/fingerprint/index.js';
import {
  fetchPrivacyPolicyText,
  findPrivacyPolicyUrl,
  matchVendorsInPolicy,
  type PolicyVendor,
} from '../capture/privacypolicy/index.js';
import {
  collectStorage,
  cookiesFromSetCookieRecords,
  type StorageSnapshot,
} from '../capture/storage/index.js';
import { Classifier } from '../classify/index.js';
import type { ScanOptions } from '../config/index.js';
import { writeReportBundle } from '../report/bundle.js';
import {
  runScenario,
  type RunScenarioOptions,
  type ScenarioRunResult,
} from '../scenarios/index.js';
import {
  SCENARIO_DIR,
  SCENARIO_IDS,
  SCHEMA_VERSION,
  type BannerDesignCheck,
  type Classification,
  type ConsentModePing,
  type CookieRecord,
  type HostConnection,
  type PageResult,
  type PrivacyPolicyCheck,
  type ScanMetadata,
  type ScanReport,
  type ScenarioId,
  type ScenarioResult,
  type StorageRecord,
} from '../types.js';
import { BELLO_VERSION } from '../version.js';
import { checkExitIp, type ExitIpResult } from './exit-ip.js';
import { createReportDir, pageSlug } from './paths.js';

export const DISCLAIMER =
  'Bello liefert technische Befunde und Einschätzungen, keine Rechtsberatung. Die Einstufungen sollten im Zweifel von einer Datenschutzjuristin bzw. einem Datenschutzjuristen geprüft werden.';

export interface ScanProgress {
  type: 'start' | 'exit-ip' | 'scenario-start' | 'scenario-done' | 'analyze' | 'done' | 'warning';
  message: string;
  page?: string;
  pageIndex?: number;
  pageCount?: number;
  scenario?: ScenarioId;
}

/** Timing knobs of the scenario runner (tests / fast mode). */
export type ScenarioTuning = Pick<
  RunScenarioOptions,
  | 'passiveReader'
  | 'banner'
  | 'followLinks'
  | 'followLinkWaitSeconds'
  | 'navigationTimeoutMs'
  | 'loadTimeoutMs'
  | 'timeBudgetMs'
  | 'hookTimeoutMs'
  | 'closeTimeoutMs'
>;

/**
 * Hard time budget per scenario: `scenarioTuning.timeBudgetMs`, else the environment variable
 * `BELLO_SCENARIO_BUDGET_S` (seconds), else the runner default (180 s).
 */
export function scenarioBudgetFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const v = Number(env.BELLO_SCENARIO_BUDGET_S);
  return Number.isFinite(v) && v > 0 ? Math.round(v * 1000) : undefined;
}

export interface ScanSiteOptions extends ScanOptions {
  /** Pages to scan (default `[url]`). Crawl mode passes the discovered page list. */
  pages?: string[];
  /** Extra Chromium switches (tests: host resolver rules). */
  launchArgs?: string[];
  /** Accept invalid TLS certificates (tests). */
  ignoreHttpsErrors?: boolean;
  onProgress?: (p: ScanProgress) => void;
  /**
   * Skip the exit-IP check (tests, offline). Note: without a confirmed EU exit IP a site without
   * banner is never judged "no banner needed" (B/C stay incomplete).
   */
  skipExitIpCheck?: boolean;
  /** Pre-determined exit-IP check result (tests); skips the network lookup. */
  exitIpResult?: ExitIpResult;
  configPath?: string | null;
  configSha256?: string | null;
  commandLine?: string[];
  /** Pre-built classifier (tests). */
  classifier?: Classifier;
  scenarioTuning?: ScenarioTuning;
  /** Clock (tests). */
  now?: () => Date;
}

export interface ScanSiteResult {
  report: ScanReport;
  /** Absolute report directory. */
  reportDir: string;
  /** Absolute path of report.json. */
  reportPath: string;
  htmlPath?: string;
  /** Absent if PDF was disabled or failed. */
  pdfPath?: string;
}

/** The browser could not be started at all – a technical error (exit code 3). */
export class BrowserStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserStartError';
  }
}

const toPosix = (p: string): string => p.split(path.sep).join('/');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function parseProxy(proxy: string | undefined): ProxyOptions | undefined {
  if (!proxy) return undefined;
  let u: URL;
  try {
    u = new URL(proxy.includes('://') ? proxy : `http://${proxy}`);
  } catch {
    return { server: proxy };
  }
  const opts: ProxyOptions = { server: `${u.protocol}//${u.host}` };
  if (u.username) opts.username = decodeURIComponent(u.username);
  if (u.password) opts.password = decodeURIComponent(u.password);
  return opts;
}

interface ScenarioCapture {
  fp?: FingerprintCapture;
  snapshots: StorageSnapshot[];
  design?: BannerDesignResult;
  designError?: string;
  policy?: { url: string; text: string };
  policyUrl?: string;
  policyError?: string;
}

/** Scenario result as stored in report.json (without hook internals). */
type StoredScenario = Omit<ScenarioRunResult, 'extras'>;

interface RunContext {
  opts: ScanSiteOptions;
  reportDir: string;
  classifier: Classifier;
  multiPage: boolean;
  warnings: string[];
}

function markCookie(c: CookieRecord, classifier: Classifier): CookieRecord {
  if (classifier.isCmpConsentCookie(c.name)) return { ...c, isConsentCookie: true };
  const m = classifier.matchTrackingCookie(c.name, c.domain);
  if (!m) return c;
  return {
    ...c,
    trackingMatch: {
      vendor: m.vendor,
      pattern: m.pattern,
      vendorName: m.vendorName,
      category: m.category,
      ...(m.necessary ? { necessary: true } : {}),
    },
  };
}

function markStorage(r: StorageRecord, classifier: Classifier): StorageRecord {
  if (r.kind !== 'indexedDB' && classifier.isCmpConsentStorageKey(r.key))
    return { ...r, isConsentKey: true };
  const m = classifier.matchTrackingStorageKey(r.key);
  if (!m) return r;
  return {
    ...r,
    trackingMatch: {
      vendor: m.vendor,
      pattern: m.pattern,
      vendorName: m.vendorName,
      category: m.category,
      ...(m.necessary ? { necessary: true } : {}),
    },
  };
}

/** Moves `<staging>/evidence/<scenario>` to `<reportDir>/evidence/<slug>/<scenario>`. */
async function relocateEvidence(
  result: ScenarioRunResult,
  stagingDir: string,
  reportDir: string,
  slug: string,
): Promise<void> {
  const dirName = SCENARIO_DIR[result.scenario];
  const target = path.join(reportDir, 'evidence', slug, dirName);
  await mkdir(path.dirname(target), { recursive: true });
  await rename(path.join(stagingDir, 'evidence', dirName), target);
  await rm(stagingDir, { recursive: true, force: true });
  const from = `evidence/${dirName}`;
  const to = `evidence/${slug}/${dirName}`;
  const fix = (p: string): string => (p.startsWith(from) ? to + p.slice(from.length) : p);
  result.evidenceFiles = result.evidenceFiles.map(fix);
  result.evidenceDir = fix(result.evidenceDir);
}

async function runOne(
  rc: RunContext,
  pageUrl: string,
  pageIndex: number,
  scenario: ScenarioId,
): Promise<{ stored: StoredScenario; analysis: AnalyzeScenario; capture: ScenarioCapture }> {
  const { opts, classifier } = rc;
  const slug = pageSlug(pageUrl, pageIndex);
  const runDir = rc.multiPage
    ? path.join(rc.reportDir, `.staging-${slug}-${scenario}`)
    : rc.reportDir;
  const cap: ScenarioCapture = { snapshots: [] };
  const extraArgs = [
    ...(opts.launchArgs ?? []),
    ...(opts.ignoreHttpsErrors ? ['--ignore-certificate-errors'] : []),
  ];
  const proxy = parseProxy(opts.proxy);
  const tuning = opts.scenarioTuning ?? {};

  const result = await runScenario({
    url: pageUrl,
    scenario,
    reportDir: runDir,
    waitSeconds: opts.waitSeconds,
    ...(scenarioBudgetFromEnv() !== undefined ? { timeBudgetMs: scenarioBudgetFromEnv() } : {}),
    ...tuning,
    banner: {
      ...(tuning.banner ?? {}),
      ...(opts.rejectSelector ? { rejectSelector: opts.rejectSelector } : {}),
      ...(opts.acceptSelector ? { acceptSelector: opts.acceptSelector } : {}),
    },
    launch: {
      ...(extraArgs.length ? { extraArgs } : {}),
      ...(proxy ? { proxy } : {}),
      headful: opts.headful,
      identify: opts.identify,
    },
    hooks: {
      onContextCreated: async (context: BrowserContext) => {
        cap.fp = await startFingerprintCapture(context);
      },
      onCheckpoint: async (page: Page, context: BrowserContext, cp) => {
        try {
          const snap = await collectStorage(context, cp, pageUrl);
          cap.snapshots.push(snap);
          if (snap.unreadableFrames.length > 0) {
            // A frame whose storage could not be read may hide tracking storage: never silent.
            throw new Error(
              `Speicher von ${snap.unreadableFrames.length} Frame(s) nicht lesbar (${snap.unreadableFrames.slice(0, 3).join(', ')})`,
            );
          }
        } catch (err) {
          // Rethrown: the scenario runner marks the scenario as incomplete (kein-mitschnitt).
          throw new Error(
            `Speicher-Abfrage (${scenario}, ${cp}) fehlgeschlagen: ${(err as Error).message.split('\n')[0]}`,
            { cause: err },
          );
        }
        if (scenario === 'A' && cp === 'nach-laden') {
          try {
            // The real banner facts are only known after the run; the result is discarded if
            // no banner was found.
            cap.design = await checkBannerDesign(page, { found: true });
          } catch (err) {
            cap.designError = (err as Error).message;
          }
        }
        if (scenario === 'C' && cp === 'ende' && pageIndex === 0) {
          try {
            const url = await findPrivacyPolicyUrl(page);
            if (url) {
              cap.policyUrl = url;
              cap.policy = await fetchPrivacyPolicyText(context, url);
            }
          } catch (err) {
            cap.policyError = `Datenschutzerklärung konnte nicht geladen werden: ${(err as Error).message.split('\n')[0]}`;
          }
        }
      },
    },
  });

  if (
    result.status.state === 'unvollstaendig' &&
    result.status.reasonCode === 'browser-fehler' &&
    result.status.reason.startsWith('Browser konnte nicht gestartet werden')
  ) {
    throw new BrowserStartError(result.status.reason);
  }

  if (rc.multiPage) await relocateEvidence(result, runDir, rc.reportDir, slug);
  const evidenceAbs = path.join(rc.reportDir, result.evidenceDir);

  // Storage (all checkpoints, deduplicated, first checkpoint wins) + Set-Cookie headers.
  const cookies: CookieRecord[] = [];
  const cookieKeys = new Set<string>();
  const addCookie = (c: CookieRecord): void => {
    const k = `${c.name}|${c.domain.replace(/^\./, '')}|${c.path}`;
    if (cookieKeys.has(k)) return;
    cookieKeys.add(k);
    cookies.push(markCookie(c, classifier));
  };
  for (const snap of cap.snapshots) snap.cookies.forEach(addCookie);
  for (const r of result.requests) {
    const stored = (r.setCookies ?? []).filter((c) => !c.blockedReasons?.length);
    if (stored.length) cookiesFromSetCookieRecords(stored, r.host, pageUrl).forEach(addCookie);
  }
  const storage: StorageRecord[] = [];
  const storageKeys = new Set<string>();
  for (const snap of cap.snapshots) {
    for (const s of snap.storage) {
      const k = `${s.kind}|${s.origin}|${s.key}`;
      if (storageKeys.has(k)) continue;
      storageKeys.add(k);
      storage.push(markStorage(s, classifier));
    }
  }
  const fingerprinting = cap.fp
    ? toFingerprintEvents(cap.fp.events(), result.timing.navigationStart)
    : [];
  const consentMode: ConsentModePing[] = [];
  for (const r of result.requests) {
    const ping = parseConsentModePing(r.url, r.postData, { time: r.startTime, requestId: r.id });
    if (ping) {
      const { gcdDecoded: _g, ...rest } = ping;
      consentMode.push(rest);
    }
  }
  result.cookies = cookies;
  result.storage = storage;
  result.fingerprinting = fingerprinting;
  result.consentMode = consentMode;

  const writeEvidence = async (name: string, data: unknown): Promise<void> => {
    try {
      await mkdir(evidenceAbs, { recursive: true });
      await writeFile(path.join(evidenceAbs, name), JSON.stringify(data, null, 2) + '\n');
      result.evidenceFiles.push(`${result.evidenceDir}/${name}`);
    } catch (err) {
      rc.warnings.push(`Evidence-Datei ${name} nicht geschrieben: ${(err as Error).message}`);
    }
  };
  await writeEvidence('cookies.json', cookies);
  await writeEvidence('storage.json', storage);
  await writeEvidence('fingerprinting.json', fingerprinting);
  if (consentMode.length) await writeEvidence('consent-mode.json', consentMode);

  let rawHtml: string | undefined;
  try {
    rawHtml = await readFile(path.join(evidenceAbs, 'raw.html'), 'utf8');
  } catch {
    rawHtml = undefined;
  }
  for (const w of result.warnings) rc.warnings.push(`${scenario} (${pageUrl}): ${w}`);

  const { extras: _extras, ...stored } = result;
  const analysis: AnalyzeScenario = {
    ...stored,
    ...(rawHtml !== undefined ? { rawHtml } : {}),
    ...(result.mainDocument?.finalUrl ? { finalUrl: result.mainDocument.finalUrl } : {}),
  };
  return { stored, analysis, capture: cap };
}

/** Scans one site (one or more pages × scenarios A/B/C) and writes report.json. */
export async function scanSite(opts: ScanSiteOptions): Promise<ScanSiteResult> {
  const now = opts.now ?? ((): Date => new Date());
  const startedAt = now();
  const progress = (p: ScanProgress): void => {
    try {
      opts.onProgress?.(p);
    } catch {
      // progress output must never break a scan
    }
  };
  const pages = opts.pages?.length ? opts.pages : [opts.url];
  const reportDir = await createReportDir(opts.outDir, opts.url, startedAt);
  const warnings: string[] = [];
  progress({
    type: 'start',
    message: `Scan von ${opts.url} gestartet (${pages.length} Seite(n)).`,
  });

  const classifier =
    opts.classifier ??
    (await Classifier.create(opts.vendorsFile ? { extraVendorsFile: opts.vendorsFile } : {}));
  const unavailable = [...classifier.unavailable];
  if (unavailable.length > 0) {
    const w = `Datendateien fehlen (${unavailable.join(', ')}) – Klassifizierung eingeschränkt. Führe \`bello setup\` bzw. \`bello vendors update\` aus.`;
    warnings.push(w);
    progress({ type: 'warning', message: w });
  }

  const proxy = parseProxy(opts.proxy);
  const meta: ScanMetadata = {
    startedAt: startedAt.toISOString(),
    belloVersion: BELLO_VERSION,
    commandLine: redactCommandLine(opts.commandLine ?? process.argv.slice()),
    crawl: Boolean(opts.crawl),
    attributions: ['IP-Geolokation: DB-IP.com (CC BY 4.0)'],
  };
  if (opts.customerId) meta.customerId = opts.customerId;
  if (opts.configPath) meta.configPath = opts.configPath;
  if (opts.configSha256) meta.configHash = opts.configSha256;
  if (proxy) meta.proxy = proxy.server;
  if (unavailable.length) meta.unavailableData = unavailable;

  if (opts.exitIpResult) {
    const r = opts.exitIpResult;
    if (r.ip) meta.exitIp = r.ip;
    if (r.country) meta.exitCountry = r.country;
    meta.exitIpCheck = r.check;
  } else if (opts.skipExitIpCheck) {
    meta.exitIpCheck = { status: 'uebersprungen', message: 'Standort-Check übersprungen.' };
  } else {
    const r = await checkExitIp({
      ...(proxy ? { proxy } : {}),
      lookupCountry: (ip) => classifier.lookupIp(ip)?.country,
    });
    if (r.ip) meta.exitIp = r.ip;
    if (r.country) meta.exitCountry = r.country;
    meta.exitIpCheck = r.check;
    if (r.check.message) {
      warnings.push(r.check.message);
      progress({ type: 'warning', message: r.check.message });
    }
    progress({
      type: 'exit-ip',
      message: r.ip ? `Exit-IP ${r.ip}${r.country ? ` (${r.country})` : ''}` : 'Exit-IP unbekannt',
    });
  }

  const rc: RunContext = { opts, reportDir, classifier, multiPage: pages.length > 1, warnings };
  const pageResults: PageResult[] = [];
  const analysisPages: AnalyzePage[] = [];
  let firstRun = true;
  let firstPolicyCap: ScenarioCapture | undefined;
  for (const [pageIndex, pageUrl] of pages.entries()) {
    const stored: ScenarioResult[] = [];
    const analysisScenarios: AnalyzeScenario[] = [];
    let design: BannerDesignResult | undefined;
    let policyCap: ScenarioCapture | undefined;
    for (const scenario of SCENARIO_IDS) {
      if (!firstRun && opts.delayMs > 0) await sleep(opts.delayMs);
      firstRun = false;
      progress({
        type: 'scenario-start',
        message: `Seite ${pageIndex + 1}/${pages.length}, Szenario ${scenario}`,
        page: pageUrl,
        pageIndex,
        pageCount: pages.length,
        scenario,
      });
      const r = await runOne(rc, pageUrl, pageIndex, scenario);
      stored.push(r.stored);
      analysisScenarios.push(r.analysis);
      if (scenario === 'A' && r.stored.banner.found) design = r.capture.design;
      if (scenario === 'C') policyCap = r.capture;
      progress({
        type: 'scenario-done',
        message:
          r.stored.status.state === 'vollstaendig'
            ? `Szenario ${scenario} abgeschlossen`
            : `Szenario ${scenario} unvollständig: ${r.stored.status.reason}`,
        page: pageUrl,
        pageIndex,
        pageCount: pages.length,
        scenario,
      });
    }
    const page: PageResult = { url: pageUrl, scenarios: stored };
    if (design) {
      const d: BannerDesignCheck = { details: design.details };
      if (design.rejectFirstLayer !== undefined) d.rejectFirstLayer = design.rejectFirstLayer;
      if (design.imprintReachable !== undefined) d.imprintReachable = design.imprintReachable;
      if (design.privacyPolicyReachable !== undefined)
        d.privacyPolicyReachable = design.privacyPolicyReachable;
      page.bannerDesign = d;
    }
    pageResults.push(page);
    analysisPages.push({
      url: pageUrl,
      scenarios: analysisScenarios,
      ...(page.bannerDesign ? { bannerDesign: page.bannerDesign } : {}),
    });
    if (pageIndex === 0) firstPolicyCap = policyCap;
  }

  // ---- Classification ------------------------------------------------------------------------
  progress({ type: 'analyze', message: 'Auswertung' });
  // With a proxy, socket remote IPs are the proxy's address – geolocating them would attribute
  // the proxy's location to every host. Use DNS answers if Chromium resolved the host itself
  // (SOCKS5 with local DNS), else leave the server location unknown.
  const ips = new Map<string, Set<string>>();
  for (const p of analysisPages) {
    for (const s of p.scenarios) {
      for (const c of allConnections(s)) {
        const set = ips.get(c.host) ?? new Set<string>();
        geoIps(c, Boolean(proxy)).forEach((ip) => set.add(ip));
        ips.set(c.host, set);
      }
    }
  }
  const classifications = new Map<string, Classification>();
  const classify = (host: string): Classification => {
    const h = host.toLowerCase();
    let c = classifications.get(h);
    if (!c) {
      c = classifier.classifyHost(h, {
        site: opts.url,
        firstPartyAliases: opts.firstPartyAliases,
        allowedProcessors: opts.allowedProcessors,
        ips: [...(ips.get(h) ?? [])],
      });
      classifications.set(h, c);
    }
    return c;
  };
  for (const h of ips.keys()) classify(h);

  // ---- Privacy policy --------------------------------------------------------------------------
  const first = analysisPages[0];
  if (first) {
    const check = await privacyPolicyCheck(
      firstPolicyCap,
      analysisPages,
      classify,
      classifier,
      reportDir,
      rc.multiPage ? pageSlug(first.url, 0) : undefined,
    );
    if (check) {
      first.privacyPolicy = check;
      pageResults[0]!.privacyPolicy = check;
    }
  }

  // ---- Analysis & report -----------------------------------------------------------------------
  const result = analyze({
    pages: analysisPages,
    classify,
    ...(meta.exitIpCheck ? { exitIpStatus: meta.exitIpCheck.status } : {}),
  });
  const chromiumVersion = pageResults
    .flatMap((p) => p.scenarios)
    .find((s) => s.browserVersion)?.browserVersion;
  if (chromiumVersion) meta.chromiumVersion = chromiumVersion;
  meta.finishedAt = now().toISOString();
  if (warnings.length) meta.warnings = warnings;

  const report: ScanReport = {
    schemaVersion: SCHEMA_VERSION,
    url: opts.url,
    ...(opts.customerName ? { customer: opts.customerName } : {}),
    meta,
    trafficLight: result.trafficLight,
    assessment: result.assessment,
    pages: pageResults,
    classifications: [...classifications.values()].sort((a, b) => a.host.localeCompare(b.host)),
    findings: result.findings,
    disclaimer: DISCLAIMER,
  };
  const bundle = await writeReportBundle(report, reportDir, {
    pdf: opts.pdf,
    company: opts.company,
    onWarning: (m) => {
      warnings.push(m);
      progress({ type: 'warning', message: m });
    },
  });
  const reportPath = bundle.reportPath;
  progress({ type: 'done', message: `Report: ${reportPath}` });
  return {
    report,
    reportDir,
    reportPath,
    htmlPath: bundle.htmlPath,
    ...(bundle.pdfPath ? { pdfPath: bundle.pdfPath } : {}),
  };
}

async function privacyPolicyCheck(
  cap: ScenarioCapture | undefined,
  pages: AnalyzePage[],
  classify: (host: string) => Classification,
  classifier: Classifier,
  reportDir: string,
  slug: string | undefined,
): Promise<PrivacyPolicyCheck | undefined> {
  if (!cap) return undefined;
  if (cap.policyError) {
    return {
      ...(cap.policyUrl ? { url: cap.policyUrl } : {}),
      mentioned: [],
      missing: [],
      error: cap.policyError,
    };
  }
  if (!cap.policy) return { mentioned: [], missing: [] };
  const rel = slug ? `evidence/${slug}/privacy-policy.txt` : 'evidence/privacy-policy.txt';
  const check: PrivacyPolicyCheck = { url: cap.policy.url, mentioned: [], missing: [] };
  try {
    await mkdir(path.dirname(path.join(reportDir, rel)), { recursive: true });
    await writeFile(path.join(reportDir, rel), `Quelle: ${cap.policy.url}\n\n${cap.policy.text}\n`);
    check.file = toPosix(rel);
  } catch {
    // evidence file is optional
  }
  // Vendors actually contacted (real connections) in any scenario of any page.
  const vendorIds = new Set<string>();
  for (const p of pages) {
    for (const s of p.scenarios) {
      for (const c of allConnections(s)) {
        const cls = classify(c.host);
        if (cls.firstParty || !cls.vendor) continue;
        if (isRealConnection(c, s.requests)) vendorIds.add(cls.vendor.id);
      }
    }
  }
  const vendors: PolicyVendor[] = [];
  for (const id of vendorIds) {
    const v = classifier.vendors.find((x) => x.id === id);
    if (v) vendors.push({ id: v.id, name: v.name, aliases: v.privacyPolicyAliases });
  }
  if (vendors.length === 0) return check;
  const m = matchVendorsInPolicy(cap.policy.text, vendors);
  const name = (id: string): string => vendors.find((v) => v.id === id)?.name ?? id;
  check.mentioned = m.mentioned.map(name);
  check.missing = m.missing.map(name);
  return check;
}

/**
 * IPs used to geolocate a host's server. Behind a proxy the socket remote IPs belong to the
 * proxy, so only DNS answers (if Chromium resolved the name itself) are used.
 */
export function geoIps(c: Pick<HostConnection, 'remoteIps' | 'dns'>, proxied: boolean): string[] {
  return proxied ? [...(c.dns?.addresses ?? [])] : [...c.remoteIps];
}

const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s:]*(?::[^/@\s]*)?@/gi;

/**
 * Removes credentials from a command line: `user:pass@` in any URL-like argument and the whole
 * value of `--proxy` (both `--proxy <v>` and `--proxy=<v>`; reduced to scheme://host:port).
 */
export function redactCommandLine(argv: readonly string[]): string[] {
  const proxyValue = (v: string): string => {
    const p = parseProxy(v);
    if (!p || !(p.username || p.password || /@/.test(v)))
      return v.replace(URL_CREDENTIALS, '$1***@');
    return p.server.includes('://') ? `${p.server} (Zugangsdaten entfernt)` : '***';
  };
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--proxy' && i + 1 < argv.length) {
      out.push(a, proxyValue(argv[++i]!));
    } else if (a.startsWith('--proxy=')) {
      out.push(`--proxy=${proxyValue(a.slice('--proxy='.length))}`);
    } else {
      out.push(a.replace(URL_CREDENTIALS, '$1***@'));
    }
  }
  return out;
}

/** sha256 hex helper (config hash). */
export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
