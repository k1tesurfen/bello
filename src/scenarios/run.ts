/**
 * Runs one page × one scenario (PLAN §3) in a fresh browser process and returns the raw
 * evidence (NetLog connections correlated with CDP requests, banner facts, timing markers).
 *
 *  A = load, passive reader (banner ignored; detection only)
 *  B = load, reject, passive reader, then (quick mode) 1–2 same-site internal links with a
 *      short passive reader each
 *  C = load, accept, passive reader
 *
 * Status rules (PLAN §7, "never green for something that did not happen"):
 *  - load failure / bot wall / crash / unusable NetLog → UNVOLLSTÄNDIG in every scenario,
 *  - B/C: banner found but the action could not be performed *and verified* → UNVOLLSTÄNDIG
 *    (`banner-nicht-bedienbar`),
 *  - B/C: no banner found → UNVOLLSTÄNDIG (`banner-nicht-gefunden`); the analysis may treat
 *    this as harmless when no scenario shows any third-party activity,
 *  - A without banner is complete (no banner + third parties is judged by the analysis).
 *
 * `cmpLoadedAt` (documented choice): response time of the first CMP script request (known CMP
 * hosts/paths, see `cmpFromUrl`); else the time autoconsent first reported `cmpDetected`; else
 * the time the banner was first seen. The source is reported in `cmpLoadedSource`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, Page, Response } from 'playwright';
import {
  launchScenarioBrowser,
  type LaunchOptions,
  type ScenarioBrowser,
} from '../browser/launch.js';
import {
  runPassiveReader,
  type PassiveReaderOptions,
  type PassiveReaderResult,
} from '../browser/passive-reader.js';
import { correlate, isBrowserBackgroundConnection } from '../capture/cdp/correlate.js';
import { startRequestCapture, type RequestCapture } from '../capture/cdp/requests.js';
import { hostConnectionsFromFile } from '../capture/netlog/aggregate.js';
import { mainDocumentCaptured } from '../analyze/capture-sanity.js';
import {
  SCENARIO_DIR,
  SCENARIO_LABEL,
  type HostConnection,
  type RequestRecord,
  type ScenarioId,
  type ScenarioResult,
  type ScenarioStatus,
  type StorageCheckpoint,
  type TimingMarkers,
} from '../types.js';
import { AutoconsentDriver } from './autoconsent.js';
import {
  bannerFromDetection,
  detectBanner,
  operateBanner,
  type BannerOptions,
  type BannerResult,
} from './banner.js';
import { isDecisionBanner, pageFn, scanForBanners } from './banner-dom.js';
import {
  cmpScriptLoad,
  detectBotWall,
  pickInternalLinks,
  type BotWallVerdict,
} from './page-checks.js';

export type UnvollstaendigCode = Extract<ScenarioStatus, { state: 'unvollstaendig' }>['reasonCode'];

export interface ScenarioHookInfo {
  scenario: ScenarioId;
  url: string;
  /** Epoch ms (0 before navigation started). */
  navigationStart: number;
}

/** Extension points for other capture modules (storage, fingerprinting, …). */
export interface ScenarioHooks {
  /** After the context exists, before the page is created (add init scripts / bindings here). */
  onContextCreated?(context: BrowserContext, info: ScenarioHookInfo): unknown;
  /** After the page is created, before navigation. */
  onPageCreated?(page: Page, context: BrowserContext, info: ScenarioHookInfo): unknown;
  /**
   * At `nach-laden` (load + banner detection, before any click), `nach-klick` (after the banner
   * action, B/C only) and `ende` (before the browser is closed). The resolved value is stored in
   * `extras.checkpoints[checkpoint]`.
   */
  onCheckpoint?(
    page: Page,
    context: BrowserContext,
    checkpoint: StorageCheckpoint,
    info: ScenarioHookInfo,
  ): unknown;
}

export interface RunScenarioOptions {
  url: string;
  scenario: ScenarioId;
  /** Report directory; evidence goes to `<reportDir>/evidence/<scenario-dir>/`. */
  reportDir: string;
  /** Final wait of the passive reader in seconds (PLAN `--wait`, default 10). */
  waitSeconds?: number;
  /** Further passive reader tuning (navigationStart/waitSeconds are set by the runner). */
  passiveReader?: Omit<PassiveReaderOptions, 'navigationStart' | 'waitSeconds'>;
  banner?: BannerOptions;
  /** Same-site links visited after rejecting in scenario B (default 2, 0 = off). */
  followLinks?: number;
  /** Final wait (s) of the short passive reader on follow-up pages (default min(3, waitSeconds)). */
  followLinkWaitSeconds?: number;
  /** Navigation timeout in ms (default 45 000). */
  navigationTimeoutMs?: number;
  /** Max. wait for the `load` event after DOMContentLoaded (default 20 000 ms). */
  loadTimeoutMs?: number;
  /** Passed to `launchScenarioBrowser` (proxy, extraArgs, headful, identify, …). */
  launch?: Omit<LaunchOptions, 'netLogPath' | 'harPath'>;
  hooks?: ScenarioHooks;
  /**
   * Hard time budget for the whole scenario in ms (default 180 000). When exceeded, the browser
   * is force-killed and the scenario is UNVOLLSTÄNDIG (`timeout`).
   */
  timeBudgetMs?: number;
  /** Max. duration of one capture hook call in ms (default 30 000). */
  hookTimeoutMs?: number;
  /** Max. duration of the graceful browser close in ms (default 30 000), then kill. */
  closeTimeoutMs?: number;
}

export interface FollowUpNavigation {
  url: string;
  /** Relative ms when navigation was issued. */
  at: number;
  status?: number;
  ok: boolean;
  /** German error text. */
  error?: string;
  /** A consent banner was visible again on this page (consent decision not remembered). */
  bannerVisible?: boolean;
}

export interface ScenarioTiming extends TimingMarkers {
  /** End of the passive reader's scroll phase on the landing page (relative ms). */
  scrollPhaseEndAt?: number;
  /** Follow-up navigations in B (relative ms). */
  followUpAt?: number[];
}

/** Superset of {@link ScenarioResult}. */
export interface ScenarioRunResult extends ScenarioResult {
  timing: ScenarioTiming;
  banner: BannerResult;
  /** Where `timing.cmpLoadedAt` comes from. */
  cmpLoadedSource?: 'cmp-script' | 'autoconsent' | 'banner-sichtbar';
  cmpScriptUrl?: string;
  passiveReader?: PassiveReaderResult;
  followUps: FollowUpNavigation[];
  mainDocument?: {
    status?: number;
    finalUrl: string;
    botWall?: BotWallVerdict;
  };
  /** Hosts dropped as Chrome background traffic (not page-caused). */
  backgroundHosts: string[];
  /** Non-fatal problems (German). */
  warnings: string[];
  /** Evidence directory relative to the report directory. */
  evidenceDir: string;
  /** Hook results. */
  extras: {
    contextCreated?: unknown;
    pageCreated?: unknown;
    checkpoints: Partial<Record<StorageCheckpoint, unknown>>;
  };
}

class ScenarioAbort extends Error {
  constructor(
    readonly code: UnvollstaendigCode,
    readonly reason: string,
  ) {
    super(reason);
  }
}

const toPosix = (p: string): string => p.split(path.sep).join('/');

/** Navigation-timing marks of the current document (epoch ms). */
const NAV_TIMING_FN = pageFn(String.raw`() => {
  const e = performance.getEntriesByType('navigation')[0];
  if (!e) return null;
  const o = performance.timeOrigin;
  return {
    dcl: e.domContentLoadedEventStart > 0 ? o + e.domContentLoadedEventStart : null,
    load: e.loadEventStart > 0 ? o + e.loadEventStart : null,
  };
}`);

const HREFS_FN = pageFn(
  String.raw`() => Array.from(document.querySelectorAll('a[href]')).map((a) => a.href).filter(Boolean)`,
);

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split('\n')[0]!.slice(0, 300);
}

function navigationFailure(err: unknown): ScenarioAbort {
  const msg = errorText(err);
  if (/timeout/i.test(msg)) {
    return new ScenarioAbort('timeout', `Seite wurde nicht rechtzeitig geladen (${msg}).`);
  }
  return new ScenarioAbort(
    'navigation-fehlgeschlagen',
    `Seite konnte nicht geladen werden (${msg}).`,
  );
}

/** Default hard time budget per scenario (ms). */
export const DEFAULT_SCENARIO_BUDGET_MS = 180_000;

/** A page whose `load` event takes longer than this counts as slow. */
export const SLOW_LOAD_THRESHOLD_MS = 10_000;

/**
 * Timing adjustments for slow sites, derived from the observed load duration of the landing
 * page (`load` event, or the time waited if it never came):
 *  - banner detection waits longer (CMP scripts of slow sites also arrive late):
 *    + half the load duration, max. +20 s; +20 s if `load` never fired,
 *  - the scenario budget grows by 4× the time above the threshold (B loads up to two more
 *    pages, the passive reader waits for network idle), max. +100 % of the base budget.
 */
export function slowSiteTuning(
  loadDurationMs: number,
  loadReached: boolean,
  base: { detectTimeoutMs: number; budgetMs: number },
): { slow: boolean; detectTimeoutMs: number; budgetMs: number } {
  const slow = !loadReached || loadDurationMs > SLOW_LOAD_THRESHOLD_MS;
  if (!slow) return { slow, ...base };
  const detectExtra = loadReached ? Math.min(20_000, Math.round(loadDurationMs / 2)) : 20_000;
  const over = Math.max(0, loadDurationMs - SLOW_LOAD_THRESHOLD_MS);
  const budgetExtra = Math.min(base.budgetMs, 4 * over);
  return {
    slow,
    detectTimeoutMs: base.detectTimeoutMs + detectExtra,
    budgetMs: base.budgetMs + budgetExtra,
  };
}

/** Phase names (German, used in the timeout reason). */
type Phase =
  | 'Browserstart'
  | 'Seitenaufruf'
  | 'Banner-Erkennung'
  | 'Banner-Bedienung'
  | 'Speicher-Abfrage'
  | 'Passiver Leser'
  | 'Screenshot'
  | 'DOM-Abbild'
  | 'Folgenavigation'
  | 'Abschluss';

/** Resolves with `fallback` if `p` does not settle within `ms`; rejections propagate. */
function bounded<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  return new Promise<T | F>((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

const TIMED_OUT = Symbol('timed-out');

/**
 * Runs one scenario. Never throws for page/browser problems; they end up in `status`.
 *
 * Hard limits (a hanging scenario must never block a scan, and must never look complete):
 *  - the whole scenario (launch → last checkpoint) runs against `timeBudgetMs`; when exceeded the
 *    browser process is force-killed and the scenario is UNVOLLSTÄNDIG (`timeout`),
 *  - capture hooks run against `hookTimeoutMs`; a failing/hanging hook makes the scenario
 *    UNVOLLSTÄNDIG (`kein-mitschnitt`) because storage/fingerprinting evidence is missing,
 *  - closing the browser races against `closeTimeoutMs`; on timeout the process is killed and the
 *    scenario is UNVOLLSTÄNDIG (`browser-fehler`),
 *  - a truncated/malformed NetLog is UNVOLLSTÄNDIG (`browser-fehler`),
 *  - no TCP/TLS/QUIC (or sent request headers) for the main document host in the NetLog is
 *    UNVOLLSTÄNDIG (`kein-mitschnitt`).
 */
export async function runScenario(opts: RunScenarioOptions): Promise<ScenarioRunResult> {
  const { scenario, url } = opts;
  const evidenceDirAbs = path.join(opts.reportDir, 'evidence', SCENARIO_DIR[scenario]);
  const screenshotsDir = path.join(evidenceDirAbs, 'screenshots');
  await mkdir(screenshotsDir, { recursive: true });
  const rel = (abs: string): string => toPosix(path.relative(opts.reportDir, abs));
  const files = {
    netlog: path.join(evidenceDirAbs, 'netlog.json'),
    har: path.join(evidenceDirAbs, 'network.har'),
    raw: path.join(evidenceDirAbs, 'raw.html'),
    dom: path.join(evidenceDirAbs, 'dom.html'),
    shotBanner: path.join(screenshotsDir, 'banner.png'),
    shotAfterClick: path.join(screenshotsDir, 'nach-klick.png'),
    shotEnd: path.join(screenshotsDir, 'seitenende.png'),
  };
  const evidenceFiles: string[] = [];
  const warnings: string[] = [];
  const extras: ScenarioRunResult['extras'] = { checkpoints: {} };
  const followUps: FollowUpNavigation[] = [];
  const hooks = opts.hooks ?? {};
  const waitSeconds = opts.waitSeconds ?? 10;
  const bannerOpts = opts.banner ?? {};
  const action = scenario === 'B' ? 'reject' : scenario === 'C' ? 'accept' : undefined;
  const baseBudgetMs = opts.timeBudgetMs ?? DEFAULT_SCENARIO_BUDGET_MS;
  /** Effective budget; grows once for slow sites (see {@link slowSiteTuning}). */
  let budgetMs = baseBudgetMs;
  let runStart = Date.now();
  const remainingBudget = (): number => runStart + budgetMs - Date.now();
  const navTimeoutMs = opts.navigationTimeoutMs ?? 45_000;
  /** Observed load duration of the landing page (ms). */
  let landingLoadMs = 0;
  const hookTimeoutMs = opts.hookTimeoutMs ?? 30_000;
  const closeTimeoutMs = opts.closeTimeoutMs ?? 30_000;

  let navigationStart = 0;
  const timing: ScenarioTiming = { navigationStart: 0 };
  let status: ScenarioStatus = { state: 'vollstaendig' };
  /** Records a failure unless an earlier (more specific) one is already recorded. */
  const fail = (reasonCode: UnvollstaendigCode, reason: string): void => {
    if (status.state === 'vollstaendig') status = { state: 'unvollstaendig', reasonCode, reason };
  };
  let banner: BannerResult = {
    found: false,
    detectedBy: [],
    attempted: false,
    succeeded: false,
    attempts: [],
  };
  let passive: PassiveReaderResult | undefined;
  let mainDocument: ScenarioRunResult['mainDocument'];
  let crashed = false;
  let sb: ScenarioBrowser | undefined;
  let cdp: RequestCapture | undefined;
  let requests: RequestRecord[] = [];
  let driver: AutoconsentDriver | undefined;
  let phase: Phase = 'Browserstart';
  let timedOut = false;
  let killed = false;

  const info = (): ScenarioHookInfo => ({ scenario, url, navigationStart });
  const hookFailures: string[] = [];
  const runHook = async (name: string, fn: () => unknown): Promise<unknown> => {
    try {
      const r = await bounded(Promise.resolve().then(fn), hookTimeoutMs, TIMED_OUT);
      if (r === TIMED_OUT) {
        throw new Error(`keine Antwort innerhalb von ${Math.round(hookTimeoutMs / 1000)} s`);
      }
      return r;
    } catch (err) {
      const msg = `Erweiterung „${name}“ fehlgeschlagen: ${errorText(err)}`;
      warnings.push(msg);
      hookFailures.push(msg);
      return undefined;
    }
  };
  const screenshot = async (page: Page, file: string): Promise<void> => {
    const prev = phase;
    phase = 'Screenshot';
    try {
      await page.screenshot({ path: file, timeout: 10_000 });
      evidenceFiles.push(rel(file));
    } catch (err) {
      warnings.push(`Screenshot ${path.basename(file)} fehlgeschlagen: ${errorText(err)}`);
    } finally {
      phase = prev;
    }
  };
  const checkpoint = async (page: Page, cp: StorageCheckpoint): Promise<void> => {
    if (!hooks.onCheckpoint || !sb) return;
    const ctx = sb.context;
    const prev = phase;
    phase = 'Speicher-Abfrage';
    extras.checkpoints[cp] = await runHook(`checkpoint:${cp}`, () =>
      hooks.onCheckpoint!(page, ctx, cp, info()),
    );
    phase = prev;
  };

  const body = async (): Promise<void> => {
    try {
      try {
        sb = await launchScenarioBrowser({
          ...(opts.launch ?? {}),
          netLogPath: files.netlog,
          harPath: files.har,
        });
      } catch (err) {
        throw new ScenarioAbort(
          'browser-fehler',
          `Browser konnte nicht gestartet werden: ${errorText(err)}`,
        );
      }
      if (timedOut) return;
      if (sb.cdpEndpoint) {
        try {
          cdp = await startRequestCapture(sb.cdpEndpoint);
        } catch (err) {
          warnings.push(`CDP-Mitschnitt nicht verfügbar: ${errorText(err)}`);
        }
      } else {
        warnings.push('CDP-Mitschnitt deaktiviert: keine Request-Initiatoren verfügbar.');
      }
      const context = sb.context;
      if (hooks.onContextCreated) {
        extras.contextCreated = await runHook('onContextCreated', () =>
          hooks.onContextCreated!(context, info()),
        );
      }
      const page = await context.newPage();
      page.on('crash', () => {
        crashed = true;
      });
      page.setDefaultTimeout(15_000);
      driver = await AutoconsentDriver.attach(page, { enabled: bannerOpts.autoconsent !== false });
      if (hooks.onPageCreated) {
        extras.pageCreated = await runHook('onPageCreated', () =>
          hooks.onPageCreated!(page, context, info()),
        );
      }

      // ---- Load ----------------------------------------------------------------------------
      phase = 'Seitenaufruf';
      navigationStart = Date.now();
      timing.navigationStart = navigationStart;
      let response: Response | null;
      // Slow sites: first wait for the response to commit, then give the document its own
      // timeout to reach DOMContentLoaded (a slowly streamed HTML page is not a failure).
      try {
        response = await page.goto(url, { waitUntil: 'commit', timeout: navTimeoutMs });
        await page.waitForLoadState('domcontentloaded', { timeout: navTimeoutMs });
      } catch (err) {
        throw navigationFailure(err);
      }
      const dclElapsed = Date.now() - navigationStart;
      let loadReached = true;
      try {
        await page.waitForLoadState('load', {
          timeout: opts.loadTimeoutMs ?? Math.min(45_000, Math.max(20_000, 2 * dclElapsed)),
        });
      } catch {
        loadReached = false;
        warnings.push('load-Ereignis kam nicht rechtzeitig; Szenario läuft weiter.');
      }
      landingLoadMs = Date.now() - navigationStart;
      const slowTuning = slowSiteTuning(landingLoadMs, loadReached, {
        detectTimeoutMs: bannerOpts.detectTimeoutMs ?? 10_000,
        budgetMs: baseBudgetMs,
      });
      if (slowTuning.slow) {
        budgetMs = slowTuning.budgetMs;
        warnings.push(
          `Langsame Seite (Laden ${Math.round(landingLoadMs / 1000)} s): Banner-Wartezeit auf ${Math.round(slowTuning.detectTimeoutMs / 1000)} s und Zeitbudget auf ${Math.round(budgetMs / 1000)} s erhöht.`,
        );
      }
      let rawHtml = '';
      if (response) {
        try {
          const text = await bounded(response.text(), 20_000, TIMED_OUT);
          if (text === TIMED_OUT) throw new Error('Zeitüberschreitung beim Lesen der Antwort');
          rawHtml = text;
          await writeFile(files.raw, rawHtml);
          evidenceFiles.push(rel(files.raw));
        } catch (err) {
          warnings.push(`Original-HTML nicht verfügbar: ${errorText(err)}`);
        }
      }
      const title = await bounded(
        page.title().catch(() => ''),
        5_000,
        '',
      );
      const statusCode = response?.status();
      const botWall = detectBotWall({
        ...(statusCode !== undefined ? { status: statusCode } : {}),
        headers: response?.headers() ?? {},
        title,
        html: rawHtml,
      });
      mainDocument = {
        ...(statusCode !== undefined ? { status: statusCode } : {}),
        finalUrl: page.url(),
        ...(botWall.botWall ? { botWall } : {}),
      };
      try {
        const nt = (await bounded(page.evaluate(NAV_TIMING_FN, null), 5_000, null)) as {
          dcl: number | null;
          load: number | null;
        } | null;
        if (nt?.dcl) timing.domContentLoadedAt = Math.round(nt.dcl - navigationStart);
        if (nt?.load) timing.loadAt = Math.round(nt.load - navigationStart);
      } catch {
        // page navigated away; timing stays unknown
      }
      if (botWall.botWall) {
        await screenshot(page, files.shotEnd);
        throw new ScenarioAbort(
          'bot-schutz',
          `Bot-Schutz/WAF verhindert den Scan: ${botWall.reason ?? ''}`.trim(),
        );
      }
      if (statusCode !== undefined && statusCode >= 400) {
        await screenshot(page, files.shotEnd);
        throw new ScenarioAbort(
          'navigation-fehlgeschlagen',
          `Seite antwortet mit HTTP ${statusCode}.`,
        );
      }

      // ---- Banner ----------------------------------------------------------------------------
      phase = 'Banner-Erkennung';
      await driver.injectIntoExistingFrames();
      const detection = await detectBanner(page, driver, {
        ...bannerOpts,
        detectTimeoutMs: slowTuning.detectTimeoutMs,
        ...(action ? { action } : {}),
      });
      banner = bannerFromDetection(detection, navigationStart);
      if (detection.found) await screenshot(page, files.shotBanner);
      await checkpoint(page, 'nach-laden');

      if (action) {
        phase = 'Banner-Bedienung';
        banner = await operateBanner(page, driver, detection, action, navigationStart, bannerOpts);
        if (banner.clickAt !== undefined) timing.bannerClickAt = banner.clickAt;
        if (banner.attempted) {
          await screenshot(page, files.shotAfterClick);
          await checkpoint(page, 'nach-klick');
        }
        if (!detection.found) {
          status = {
            state: 'unvollstaendig',
            reasonCode: 'banner-nicht-gefunden',
            reason:
              `Kein Cookie-Banner gefunden – „${SCENARIO_LABEL[scenario]}“ konnte nicht ausgeführt werden. ` +
              'Falls die Website einwilligungspflichtige Dienste nutzt, ist eine manuelle Prüfung nötig.',
          };
        } else if (!banner.succeeded && banner.consentOrPay) {
          // Not a technical failure: the site offers no free way to reject.
          status = {
            state: 'unvollstaendig',
            reasonCode: 'banner-nicht-bedienbar',
            reason: `„${SCENARIO_LABEL[scenario]}“ nicht durchführbar: ${banner.failureReason ?? 'Ablehnen nur mit kostenpflichtigem Abo möglich.'}`,
          };
        } else if (!banner.succeeded) {
          status = {
            state: 'unvollstaendig',
            reasonCode: 'banner-nicht-bedienbar',
            reason: `Banner technisch nicht bedienbar („${SCENARIO_LABEL[scenario]}“): ${banner.failureReason ?? 'unbekannter Fehler'} Manuelle Prüfung nötig.`,
          };
        }
      }

      // ---- Passive reader --------------------------------------------------------------------
      phase = 'Passiver Leser';
      passive = await runPassiveReader(page, {
        ...(opts.passiveReader ?? {}),
        navigationStart,
        waitSeconds,
      });
      timing.scrollPhaseStartAt = passive.scrollPhaseStartAt;
      timing.scrollPhaseEndAt = passive.scrollPhaseEndAt;
      await screenshot(page, files.shotEnd);
      phase = 'DOM-Abbild';
      try {
        const html = await bounded(page.content(), 15_000, TIMED_OUT);
        if (html === TIMED_OUT) throw new Error('Zeitüberschreitung');
        await writeFile(files.dom, html);
        evidenceFiles.push(rel(files.dom));
      } catch (err) {
        warnings.push(`DOM-Abbild fehlgeschlagen: ${errorText(err)}`);
      }

      // ---- B: follow-up navigation -------------------------------------------------------------
      // A follow-up page that fails to load (error / HTTP ≥ 400) makes B incomplete: the
      // "rejection is remembered" check did not happen. A landing page without any internal
      // link only produces a warning (nothing to follow – the landing page itself was checked).
      const followCount = opts.followLinks ?? 2;
      if (scenario === 'B' && banner.succeeded && followCount > 0) {
        phase = 'Folgenavigation';
        const hrefs =
          ((await bounded(
            page.evaluate(HREFS_FN, null).catch(() => []),
            5_000,
            [],
          )) as string[]) ?? [];
        const links = pickInternalLinks(hrefs, page.url(), followCount);
        if (links.length === 0)
          warnings.push(
            'Keine internen Links für die Folgenavigation gefunden – nur die Startseite wurde nach dem Ablehnen geprüft.',
          );
        for (const link of links) {
          if (timedOut) return;
          // Leave enough budget for this page (as slow as the landing page) and the close.
          const needed = Math.max(30_000, 2 * landingLoadMs) + 20_000;
          if (remainingBudget() < needed) {
            warnings.push(
              `Folgenavigation zu ${link} aus Zeitgründen übersprungen (Restbudget ${Math.round(remainingBudget() / 1000)} s) – nur die bisher geladenen Seiten wurden nach dem Ablehnen geprüft.`,
            );
            continue;
          }
          const startEpoch = Date.now();
          const fu: FollowUpNavigation = { url: link, at: startEpoch - navigationStart, ok: false };
          followUps.push(fu);
          try {
            const r = await page.goto(link, {
              waitUntil: 'domcontentloaded',
              timeout: navTimeoutMs,
              referer: page.url(),
            });
            if (r) fu.status = r.status();
            if (fu.status !== undefined && fu.status >= 400) {
              fu.error = `Folgeseite antwortet mit HTTP ${fu.status}.`;
              warnings.push(`${link}: ${fu.error}`);
              continue;
            }
            await page
              .waitForLoadState('load', { timeout: opts.loadTimeoutMs ?? 20_000 })
              .catch(() => {});
            await driver.injectIntoExistingFrames();
            await runPassiveReader(page, {
              ...(opts.passiveReader ?? {}),
              navigationStart,
              waitSeconds: opts.followLinkWaitSeconds ?? Math.min(3, waitSeconds),
              maxScrollMs: Math.min(opts.passiveReader?.maxScrollMs ?? 15_000, 15_000),
            });
            const visible =
              driver.popups(startEpoch).length > 0 ||
              (
                await bounded(
                  scanForBanners(page).catch(() => []),
                  10_000,
                  [] as Awaited<ReturnType<typeof scanForBanners>>,
                )
              ).some(isDecisionBanner);
            fu.bannerVisible = visible;
            fu.ok = true;
            if (visible) {
              warnings.push(
                `Banner erscheint nach dem Ablehnen auf ${link} erneut (Entscheidung nicht gespeichert?).`,
              );
            }
          } catch (err) {
            fu.error = `Folgeseite nicht geladen: ${errorText(err)}`;
            warnings.push(fu.error);
          }
        }
        timing.followUpAt = followUps.map((f) => f.at);
        const failed = followUps.filter((f) => !f.ok);
        if (failed.length > 0) {
          fail(
            'navigation-fehlgeschlagen',
            `Folgenavigation nach dem Ablehnen fehlgeschlagen (${failed
              .map((f) => `${f.url}: ${f.error ?? 'unbekannter Fehler'}`)
              .join(
                '; ',
              )}). Ob die Ablehnung seitenübergreifend wirkt, ist ungeprüft – manuelle Prüfung nötig.`,
          );
        }
      }

      phase = 'Abschluss';
      await checkpoint(page, 'ende');
      if (crashed) throw new ScenarioAbort('browser-fehler', 'Browser-Tab ist abgestürzt.');
    } catch (err) {
      if (timedOut) return; // the budget handler already decided the status
      if (err instanceof ScenarioAbort) {
        status = { state: 'unvollstaendig', reasonCode: err.code, reason: err.reason };
      } else {
        status = {
          state: 'unvollstaendig',
          reasonCode: crashed ? 'browser-fehler' : 'sonstiges',
          reason: crashed
            ? 'Browser-Tab ist abgestürzt.'
            : `Unerwarteter Fehler im Szenario: ${errorText(err)}`,
        };
      }
    }
  };

  // ---- Run against the hard time budget ------------------------------------------------------
  runStart = Date.now();
  const bodyPromise = body();
  // The deadline is re-read on expiry: a slow landing page extends the budget while running.
  let budgetTimer: NodeJS.Timeout | undefined;
  const budgetExpired = new Promise<typeof TIMED_OUT>((resolve) => {
    const check = (): void => {
      const left = remainingBudget();
      if (left <= 0) resolve(TIMED_OUT);
      else budgetTimer = setTimeout(check, left);
    };
    check();
  });
  const outcome = await Promise.race([bodyPromise, budgetExpired]);
  if (budgetTimer) clearTimeout(budgetTimer);
  if (outcome === TIMED_OUT) {
    timedOut = true;
    killed = sb?.kill() ?? false;
    // If the browser is still starting, kill it as soon as it exists.
    void bodyPromise.finally(() => {
      if (sb && !killed) sb.kill();
    });
    status = {
      state: 'unvollstaendig',
      reasonCode: 'timeout',
      reason:
        `Zeitbudget von ${Math.round(budgetMs / 1000)} s für das Szenario überschritten (hing bei: ${phase}). ` +
        'Der Browser wurde zwangsweise beendet; das Szenario ist unvollständig – manuelle Prüfung nötig.',
    };
    warnings.push(status.reason);
  }
  if (hookFailures.length > 0) {
    fail(
      'kein-mitschnitt',
      `Mitschnitt unvollständig – ${hookFailures.join(' ')} Speicher- bzw. Fingerprinting-Befunde können fehlen; manuelle Prüfung nötig.`,
    );
  }

  // ---- Close & evaluate -------------------------------------------------------------------
  timing.endAt = navigationStart ? Date.now() - navigationStart : 0;
  if (cdp) {
    requests = cdp.records(navigationStart || Date.now());
    await bounded(
      cdp.stop().catch(() => {}),
      5_000,
      undefined,
    );
  }
  if (sb && !killed) {
    try {
      await sb.close(closeTimeoutMs);
    } catch (err) {
      const msg = `Browser ließ sich nicht sauber schließen: ${errorText(err)}`;
      warnings.push(msg);
      fail('browser-fehler', `${msg} NetLog/HAR sind möglicherweise unvollständig.`);
    }
  }

  let connections: HostConnection[] = [];
  const backgroundHosts: string[] = [];
  if (sb && navigationStart) {
    try {
      // No host filter during aggregation: Chrome-internal hosts are only dropped after
      // correlation (a page request to such a host is page-caused and must stay visible).
      const parsed = await hostConnectionsFromFile(files.netlog, navigationStart);
      correlate(parsed.connections, requests);
      for (const c of parsed.connections) {
        if (isBrowserBackgroundConnection(c)) backgroundHosts.push(c.host);
        else connections.push(c);
      }
      evidenceFiles.push(rel(files.netlog));
      if (parsed.log.truncated || parsed.log.malformedEvents > 0) {
        const what = [
          parsed.log.truncated ? 'abgeschnitten' : '',
          parsed.log.malformedEvents > 0
            ? `${parsed.log.malformedEvents} unlesbare Ereignisse`
            : '',
        ]
          .filter(Boolean)
          .join(', ');
        warnings.push(`NetLog unvollständig (${what}).`);
        fail(
          'browser-fehler',
          `NetLog unvollständig (${what}) – Socket-Beweise fehlen möglicherweise; manuelle Prüfung nötig.`,
        );
      }
      if (status.state === 'vollstaendig') {
        const sanity = mainDocumentCaptured(parsed.connections, [
          url,
          ...(mainDocument?.finalUrl ? [mainDocument.finalUrl] : []),
        ]);
        if (!sanity.ok) fail('kein-mitschnitt', sanity.reason);
      }
    } catch (err) {
      connections = [];
      fail(
        'browser-fehler',
        `NetLog konnte nicht ausgewertet werden – keine Socket-Beweise: ${errorText(err)}`,
      );
      warnings.push(`NetLog-Auswertung fehlgeschlagen: ${errorText(err)}`);
    }
    evidenceFiles.push(rel(files.har));
  }

  // cmpLoadedAt (see module doc).
  let cmpLoadedSource: ScenarioRunResult['cmpLoadedSource'];
  let cmpScriptUrl: string | undefined;
  const cmpScript = cmpScriptLoad(requests);
  const acDetected = driver?.detected()[0];
  if (cmpScript) {
    timing.cmpLoadedAt = Math.round(cmpScript.at);
    cmpLoadedSource = 'cmp-script';
    cmpScriptUrl = cmpScript.url;
    if (banner.found && !banner.cmp && cmpScript.name !== 'CMP') banner.cmp = cmpScript.name;
  } else if (acDetected && navigationStart) {
    timing.cmpLoadedAt = acDetected.time - navigationStart;
    cmpLoadedSource = 'autoconsent';
  } else if (banner.detectedAt !== undefined) {
    timing.cmpLoadedAt = banner.detectedAt;
    cmpLoadedSource = 'banner-sichtbar';
  }

  const result: ScenarioRunResult = {
    scenario,
    url,
    status,
    timing,
    banner,
    connections,
    requests,
    cookies: [],
    storage: [],
    fingerprinting: [],
    consentMode: [],
    evidenceFiles: [...new Set(evidenceFiles)],
    followUps,
    backgroundHosts,
    warnings,
    evidenceDir: rel(evidenceDirAbs),
    extras,
  };
  if (sb) result.browserVersion = sb.browserVersion;
  if (cmpLoadedSource) result.cmpLoadedSource = cmpLoadedSource;
  if (cmpScriptUrl) result.cmpScriptUrl = cmpScriptUrl;
  if (passive) result.passiveReader = passive;
  if (mainDocument) result.mainDocument = mainDocument;
  return result;
}
