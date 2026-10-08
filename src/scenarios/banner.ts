/**
 * Banner detection and operation (PLAN §5.6, §7 "Nicht bedienbarer Banner").
 *
 * Order of methods for an action (reject / accept):
 *  1. customer selector override (`rejectSelector` / `acceptSelector`),
 *  2. `@duckduckgo/autoconsent` rule for the detected CMP,
 *  3. text heuristic over DOM, open shadow roots and iframes, including the second layer
 *     ("Einstellungen" → "Alle ablehnen" / "Auswahl speichern" with all optional toggles off).
 *
 * An operation only counts as successful if it was performed **and verified**: the banner
 * elements seen before the click are gone, no consent banner is visible after a settle delay,
 * and none re-appears shortly afterwards. Anything else is reported as failure so the scenario
 * becomes UNVOLLSTÄNDIG – Bello must never report "grün" for an action that did not happen.
 */
import type { ElementHandle, Page } from 'playwright';
import type { BannerInfo } from '../types.js';
import type { AutoconsentDriver, AutoconsentMessage } from './autoconsent.js';
import {
  checkedToggles,
  clickElement,
  isDecisionBanner,
  isElementVisible,
  isToggleChecked,
  scanForBanners,
  type BannerButton,
  type HeuristicBanner,
} from './banner-dom.js';

export type BannerAction = 'reject' | 'accept';
export type BannerMethod = NonNullable<BannerInfo['method']>;

export interface BannerOptions {
  /** CSS selector of the reject button (customer override). */
  rejectSelector?: string;
  /** CSS selector of the accept button (customer override). */
  acceptSelector?: string;
  /** Use autoconsent (default true). */
  autoconsent?: boolean;
  /** Max. time to wait for a banner after load (default 10 000 ms). */
  detectTimeoutMs?: number;
  /** Wait after the click before verifying the banner is gone (default 1000 ms). */
  settleMs?: number;
  /** Second verification after this additional delay, catches re-appearing banners (default 2000 ms). */
  reappearCheckMs?: number;
  /** Wait after opening the second layer (default 1000 ms). */
  secondLayerDelayMs?: number;
  /** Timeout for an autoconsent opt-out/opt-in run (default 20 000 ms). */
  autoconsentTimeoutMs?: number;
}

export interface BannerAttempt {
  method: BannerMethod;
  ok: boolean;
  /** German description of what was tried / why it failed. */
  detail: string;
}

/** Banner facts for one scenario; a superset of {@link BannerInfo}. */
export interface BannerResult extends BannerInfo {
  /** When the banner was first seen (ms relative to navigation start). */
  detectedAt?: number;
  /** Which detectors saw the banner. */
  detectedBy: BannerMethod[];
  /** Controls visible on the first layer (heuristic scan before any click). */
  firstLayer?: {
    reject: boolean;
    accept: boolean;
    settings: boolean;
    save: boolean;
    /** Paid alternative ("Pur-Abo", contentpass …) offered next to "accept". */
    pay?: boolean;
  };
  /**
   * "Consent or pay" banner: rejecting is only possible with a paid subscription (no free
   * reject on the first layer or in the settings). Set by the reject operation.
   */
  consentOrPay?: boolean;
  /** First ~300 characters of the banner text (heuristic). */
  bannerText?: string;
  /** Action requested for this scenario (none in A). */
  action?: BannerAction;
  /** An operation was attempted. */
  attempted: boolean;
  /** The action was performed and verified (banner gone and stayed gone). */
  succeeded: boolean;
  /** Banner disappeared after the (last) click. */
  disappeared?: boolean;
  /** Banner was gone after the click but showed up again. */
  reappeared?: boolean;
  /** Second layer handling (reject not on first layer). */
  secondLayer?: {
    tried: boolean;
    succeeded: boolean;
    via?: 'ablehnen' | 'auswahl-speichern' | 'akzeptieren';
    /** Optional toggles switched off before "Auswahl speichern". */
    uncheckedToggles?: number;
  };
  /** Decisive click (relative ms), see `bannerClickAt`. */
  clickAt?: number;
  /** All click events observed during the operation (relative ms). */
  clickTimes?: number[];
  /** Label of the decisive control (heuristic / selector). */
  clickedText?: string;
  autoconsent?: {
    cmp?: string;
    result?: boolean;
    selfTest: boolean | null;
    clicks?: number;
    cosmetic?: boolean;
  };
  attempts: BannerAttempt[];
  /** German reason if the operation failed. */
  failureReason?: string;
}

export interface BannerDetection {
  found: boolean;
  /** Epoch ms when first seen. */
  detectedAtEpoch?: number;
  cmp?: string;
  popup?: AutoconsentMessage;
  heuristic?: HeuristicBanner;
  /** All decision banners found by the heuristic (roots used for verification). */
  heuristicBanners: HeuristicBanner[];
  selectorVisible: boolean;
  detectedBy: BannerMethod[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Finds the first visible element for a CSS selector in any frame. */
async function findSelector(page: Page, selector: string): Promise<ElementHandle | undefined> {
  for (const frame of page.frames()) {
    if (frame.isDetached()) continue;
    try {
      const loc = frame.locator(selector).first();
      if (await loc.isVisible({ timeout: 0 })) {
        return (await loc.elementHandle({ timeout: 1000 })) ?? undefined;
      }
    } catch {
      // invalid selector in this frame or frame detached
    }
  }
  return undefined;
}

async function decisionBanners(page: Page): Promise<HeuristicBanner[]> {
  return (await scanForBanners(page)).filter(isDecisionBanner);
}

/**
 * Waits for a consent banner (autoconsent popup, heuristic, or override selector).
 * When the heuristic sees a banner first, autoconsent gets a short grace period to recognise
 * the CMP as well (preferred method for operating it).
 */
export async function detectBanner(
  page: Page,
  driver: AutoconsentDriver | undefined,
  opts: BannerOptions & { action?: BannerAction } = {},
): Promise<BannerDetection> {
  const timeout = opts.detectTimeoutMs ?? 10_000;
  const selector = opts.action === 'accept' ? opts.acceptSelector : opts.rejectSelector;
  const deadline = Date.now() + timeout;
  let heuristic: HeuristicBanner[] = [];
  let heuristicAt: number | undefined;
  let selectorAt: number | undefined;
  let graceUntil: number | undefined;

  const mainNothingDetected = (): boolean =>
    driver?.messages.some(
      (m) =>
        m.type === 'report' &&
        m.frame === page.mainFrame() &&
        m.state?.lifecycle === 'nothingDetected',
    ) ?? true;

  for (;;) {
    const popup = driver?.popups()[0];
    if (heuristic.length === 0) {
      heuristic = await decisionBanners(page).catch(() => []);
      if (heuristic.length) heuristicAt = Date.now();
    }
    if (selector && selectorAt === undefined && (await findSelector(page, selector))) {
      selectorAt = Date.now();
    }
    const now = Date.now();
    if (popup && heuristic.length === 0 && selectorAt === undefined) {
      // autoconsent saw it first: one more heuristic look for first-layer facts.
      await sleep(300);
      heuristic = await decisionBanners(page).catch(() => []);
      if (heuristic.length) heuristicAt = Date.now();
    }
    const anyFound = popup || heuristic.length > 0 || selectorAt !== undefined;
    if (popup) break;
    if (anyFound) {
      graceUntil ??= Math.min(deadline, now + 2000);
      if (now >= graceUntil || mainNothingDetected() || !driver) break;
    }
    if (now >= deadline) break;
    await sleep(400);
  }

  const popup = driver?.popups()[0];
  const detectedBy: BannerMethod[] = [];
  const times: number[] = [];
  if (popup) {
    detectedBy.push('autoconsent');
    times.push(popup.time);
  }
  if (heuristic.length) {
    detectedBy.push('heuristik');
    times.push(heuristicAt!);
  }
  if (selectorAt !== undefined) {
    detectedBy.push('selektor');
    times.push(selectorAt);
  }
  const cmp = popup?.cmp ?? driver?.detected()[0]?.cmp;
  return {
    found: detectedBy.length > 0,
    ...(times.length ? { detectedAtEpoch: Math.min(...times) } : {}),
    ...(cmp ? { cmp } : {}),
    ...(popup ? { popup } : {}),
    ...(heuristic[0] ? { heuristic: heuristic[0] } : {}),
    heuristicBanners: heuristic,
    selectorVisible: selectorAt !== undefined,
    detectedBy,
  };
}

/** Builds the banner facts of a detection (used as-is in scenario A). */
export function bannerFromDetection(det: BannerDetection, navigationStart: number): BannerResult {
  const h = det.heuristic;
  const res: BannerResult = {
    found: det.found,
    detectedBy: det.detectedBy,
    attempted: false,
    succeeded: false,
    attempts: [],
  };
  if (det.cmp) res.cmp = det.cmp;
  if (det.detectedAtEpoch !== undefined) res.detectedAt = det.detectedAtEpoch - navigationStart;
  if (h) {
    res.firstLayer = {
      reject: h.has.reject,
      accept: h.has.accept,
      settings: h.has.settings,
      save: h.has.save,
      ...(h.has.pay ? { pay: true } : {}),
    };
    res.rejectFirstLayer = h.has.reject;
    res.bannerText = h.text;
  }
  return res;
}

interface VerifyResult {
  disappeared: boolean;
  reappeared: boolean;
  detail: string;
}

/**
 * Verifies that the banner is gone: pre-click banner roots invisible/detached and no consent
 * banner visible after `settleMs`, and still none after `reappearCheckMs`.
 */
async function verifyGone(
  page: Page,
  preRoots: ElementHandle[],
  opts: BannerOptions,
): Promise<VerifyResult> {
  const stillVisible = async (): Promise<string | undefined> => {
    for (const r of preRoots) {
      if (await isElementVisible(r)) return 'Banner ist nach dem Klick weiterhin sichtbar.';
    }
    const fresh = await decisionBanners(page).catch(() => []);
    if (fresh.length) {
      return `Nach dem Klick ist weiterhin ein Consent-Banner sichtbar („${fresh[0]!.text.slice(0, 80)}…“).`;
    }
    return undefined;
  };
  await sleep(opts.settleMs ?? 1000);
  const first = await stillVisible();
  if (first) return { disappeared: false, reappeared: false, detail: first };
  await sleep(opts.reappearCheckMs ?? 2000);
  const second = await stillVisible();
  if (second) {
    return {
      disappeared: true,
      reappeared: true,
      detail: 'Banner war nach dem Klick kurz verschwunden, erscheint aber erneut.',
    };
  }
  return { disappeared: true, reappeared: false, detail: 'Banner nach dem Klick verschwunden.' };
}

function pick(b: HeuristicBanner, kind: BannerButton['kind']): BannerButton | undefined {
  return b.buttons.find((x) => x.kind === kind);
}

async function pollBanners(
  page: Page,
  pred: (b: HeuristicBanner) => boolean,
  timeoutMs: number,
): Promise<HeuristicBanner | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (await scanForBanners(page).catch(() => [])).find(pred);
    if (found || Date.now() >= deadline) return found;
    await sleep(300);
  }
}

interface ClickPlan {
  ok: boolean;
  detail: string;
  /** Epoch ms right before the decisive click. */
  decisiveAt?: number;
  clickedText?: string;
  secondLayer?: BannerResult['secondLayer'];
  /** Banner roots to verify (first + second layer). */
  roots: ElementHandle[];
}

/** Heuristic operation incl. second layer. */
async function heuristicOperate(
  page: Page,
  action: BannerAction,
  opts: BannerOptions,
  /** Second layer only via an explicit "reject all" control (no "save selection"). */
  strictReject = false,
): Promise<ClickPlan> {
  const banners = await decisionBanners(page).catch(() => []);
  const roots = banners.map((b) => b.root);
  const primary = action === 'reject' ? 'reject' : 'accept';
  const withPrimary = banners.find((b) => b.has[primary]);
  if (withPrimary) {
    const btn = pick(withPrimary, primary)!;
    const at = Date.now();
    const ok = await clickElement(btn.handle);
    return {
      ok,
      detail: ok
        ? `Heuristik: „${btn.text}“ geklickt.`
        : `Heuristik: Klick auf „${btn.text}“ fehlgeschlagen.`,
      decisiveAt: at,
      clickedText: btn.text,
      roots,
    };
  }
  const withSettings = banners.find((b) => b.has.settings);
  if (!withSettings) {
    return {
      ok: false,
      detail:
        banners.length === 0
          ? 'Heuristik: kein Consent-Banner mit bekannten Schaltflächen gefunden.'
          : action === 'reject'
            ? 'Heuristik: weder „Ablehnen“ noch „Einstellungen“ im Banner gefunden.'
            : 'Heuristik: weder „Akzeptieren“ noch „Einstellungen“ im Banner gefunden.',
      roots,
    };
  }
  // Second layer.
  const secondLayer: NonNullable<BannerResult['secondLayer']> = { tried: true, succeeded: false };
  const settingsBtn = pick(withSettings, 'settings')!;
  if (!(await clickElement(settingsBtn.handle))) {
    return {
      ok: false,
      detail: `Heuristik: „${settingsBtn.text}“ (zweite Ebene) ließ sich nicht klicken.`,
      secondLayer,
      roots,
    };
  }
  await sleep(opts.secondLayerDelayMs ?? 1000);
  const layer2 = await pollBanners(
    page,
    (b) => (action === 'reject' ? b.has.reject || (!strictReject && b.has.save) : b.has.accept),
    3000,
  );
  if (!layer2) {
    return {
      ok: false,
      detail:
        action === 'reject'
          ? strictReject
            ? `Heuristik: nach „${settingsBtn.text}“ keine Schaltfläche „Alle ablehnen“ gefunden.`
            : `Heuristik: nach „${settingsBtn.text}“ weder „Ablehnen“ noch „Auswahl speichern“ gefunden.`
          : `Heuristik: nach „${settingsBtn.text}“ kein „Akzeptieren“ gefunden.`,
      secondLayer,
      roots,
    };
  }
  roots.push(layer2.root);
  const reject = action === 'reject' ? pick(layer2, 'reject') : undefined;
  if (action === 'accept' || reject) {
    const btn = reject ?? pick(layer2, 'accept')!;
    const at = Date.now();
    const ok = await clickElement(btn.handle);
    secondLayer.succeeded = ok;
    secondLayer.via = action === 'accept' ? 'akzeptieren' : 'ablehnen';
    return {
      ok,
      detail: ok
        ? `Heuristik (zweite Ebene): „${settingsBtn.text}“ → „${btn.text}“ geklickt.`
        : `Heuristik (zweite Ebene): Klick auf „${btn.text}“ fehlgeschlagen.`,
      decisiveAt: at,
      clickedText: btn.text,
      secondLayer,
      roots,
    };
  }
  // "Auswahl speichern": switch off every optional toggle first, otherwise saving could be
  // a (pre-ticked) consent.
  const save = pick(layer2, 'save')!;
  const toggles = await checkedToggles(layer2.root).catch(() => [] as ElementHandle[]);
  let unchecked = 0;
  for (const t of toggles) {
    await clickElement(t, 1500);
    if (!(await isToggleChecked(t))) unchecked++;
  }
  const remaining = (await checkedToggles(layer2.root).catch(() => [] as ElementHandle[])).length;
  secondLayer.uncheckedToggles = unchecked;
  if (remaining > 0) {
    return {
      ok: false,
      detail: `Heuristik (zweite Ebene): ${remaining} optionale Kategorie(n) ließen sich nicht abwählen – „${save.text}“ wurde nicht geklickt.`,
      secondLayer,
      roots,
    };
  }
  const at = Date.now();
  const ok = await clickElement(save.handle);
  secondLayer.succeeded = ok;
  secondLayer.via = 'auswahl-speichern';
  return {
    ok,
    detail: ok
      ? `Heuristik (zweite Ebene): „${settingsBtn.text}“ → ${unchecked} Kategorie(n) abgewählt → „${save.text}“ geklickt.`
      : `Heuristik (zweite Ebene): Klick auf „${save.text}“ fehlgeschlagen.`,
    decisiveAt: at,
    clickedText: save.text,
    secondLayer,
    roots,
  };
}

/** A banner that offers "accept" and a paid alternative, but no free "reject". */
function payWallBanner(banners: readonly HeuristicBanner[]): HeuristicBanner | undefined {
  if (banners.some((b) => b.has.reject)) return undefined;
  return banners.find((b) => b.has.pay && b.has.accept);
}

/** German explanation for a "consent or pay" banner (scenario B cannot be performed). */
export function consentOrPayReason(
  b: HeuristicBanner | undefined,
  secondLayerTried: boolean,
): string {
  const accept = b ? pick(b, 'accept')?.text : undefined;
  // The most explicit paid option ("Pur-Abo abschließen" rather than an inline "Pur-Abo" link).
  const pay = b?.buttons
    .filter((x) => x.kind === 'pay')
    .sort((x, y) => y.text.length - x.text.length)[0]?.text;
  const offer =
    accept && pay
      ? `Der Banner bietet nur „${accept}“ oder „${pay}“`
      : 'Der Banner bietet nur Zustimmung oder ein kostenpflichtiges Abo';
  return (
    `Ablehnen nur mit kostenpflichtigem Abo möglich (Pur-Modell, „Consent or Pay“): ${offer}, ` +
    'aber keine kostenlose Möglichkeit, alle Einwilligungen abzulehnen.' +
    (secondLayerTried
      ? ' Auch in den Einstellungen wurde keine Schaltfläche „Alle ablehnen“ gefunden.'
      : '') +
    ' Ohne Bezahlung lässt sich das Szenario nicht ausführen; kein technischer Fehler.'
  );
}

/**
 * Performs `action` on the detected banner and verifies the result. Never throws; failures are
 * reported in the result (`succeeded: false`, `failureReason`).
 */
export async function operateBanner(
  page: Page,
  driver: AutoconsentDriver | undefined,
  det: BannerDetection,
  action: BannerAction,
  navigationStart: number,
  opts: BannerOptions = {},
): Promise<BannerResult> {
  const res = bannerFromDetection(det, navigationStart);
  res.action = action;
  if (!det.found) {
    res.failureReason = 'Kein Cookie-Banner gefunden.';
    return res;
  }
  res.attempted = true;
  const opStart = Date.now();
  const preRoots = det.heuristicBanners.map((b) => b.root);
  const rel = (t: number): number => t - navigationStart;

  const clicksBetween = (from: number, to: number): number[] =>
    (driver?.clickTimes ?? []).filter((t) => t >= from && t <= to);
  /** Click event caused by our own click on a control (first event right after the call). */
  const ownClickAt = (calledAt: number): number =>
    clicksBetween(calledAt - 5, calledAt + 2000)[0] ?? calledAt;

  const finish = async (
    method: BannerMethod,
    /** Epoch ms of the decisive click (see `bannerClickAt`). */
    clickAtEpoch: number,
    roots: ElementHandle[],
    detail: string,
    extra: Partial<BannerResult> = {},
  ): Promise<boolean> => {
    const clicks = clicksBetween(opStart, Date.now());
    const v = await verifyGone(page, roots, opts);
    res.attempts.push({
      method,
      ok: v.disappeared && !v.reappeared,
      detail: `${detail} ${v.detail}`,
    });
    if (v.disappeared && !v.reappeared) {
      res.succeeded = true;
      res.method = method;
      res.clicked = action;
      res.disappeared = true;
      res.reappeared = false;
      Object.assign(res, extra);
      res.clickTimes = clicks.map(rel);
      res.clickAt = rel(clickAtEpoch);
      return true;
    }
    res.disappeared = v.disappeared;
    res.reappeared = v.reappeared;
    res.failureReason = v.detail;
    return false;
  };

  // 1. Customer selector.
  const selector = action === 'reject' ? opts.rejectSelector : opts.acceptSelector;
  if (selector) {
    const el = await findSelector(page, selector);
    if (!el) {
      res.attempts.push({
        method: 'selektor',
        ok: false,
        detail: `Selektor „${selector}“ nicht gefunden oder nicht sichtbar.`,
      });
    } else {
      const at = Date.now();
      const ok = await clickElement(el);
      if (!ok) {
        res.attempts.push({
          method: 'selektor',
          ok: false,
          detail: `Klick auf „${selector}“ fehlgeschlagen.`,
        });
      } else if (
        await finish(
          'selektor',
          ownClickAt(at),
          [...preRoots, el],
          `Selektor „${selector}“ geklickt.`,
          {
            clickedText: selector,
          },
        )
      ) {
        return res;
      }
    }
  }

  // "Consent or pay": no free reject on the first layer, but a paid alternative. Autoconsent is
  // skipped for the rejection because its rules fall back to "save selection" in the settings,
  // which on such banners still grants the mandatory consent (e.g. personalised advertising).
  // Only an explicit "reject all" in the settings counts.
  const payWall = action === 'reject' ? payWallBanner(det.heuristicBanners) : undefined;

  // 2. autoconsent.
  if (driver && det.popup && !det.popup.frame.isDetached() && !payWall) {
    const r = await driver.run(
      action === 'reject' ? 'optOut' : 'optIn',
      det.popup,
      opts.autoconsentTimeoutMs,
    );
    res.autoconsent = {
      selfTest: r.selfTest,
      ...(r.cmp ? { cmp: r.cmp } : {}),
      ...(r.result !== undefined ? { result: r.result } : {}),
      ...(r.clicks !== undefined ? { clicks: r.clicks } : {}),
      ...(r.cosmetic !== undefined ? { cosmetic: r.cosmetic } : {}),
    };
    const label = action === 'reject' ? 'Opt-out' : 'Opt-in';
    if (r.result !== true) {
      res.attempts.push({
        method: 'autoconsent',
        ok: false,
        detail:
          r.result === undefined
            ? `autoconsent (${r.cmp ?? det.popup.cmp}): ${label} ohne Ergebnis (Zeitüberschreitung).`
            : `autoconsent (${r.cmp ?? det.popup.cmp}): ${label} fehlgeschlagen.`,
      });
    } else if (r.cosmetic) {
      res.attempts.push({
        method: 'autoconsent',
        ok: false,
        detail: `autoconsent (${r.cmp}): Banner nur ausgeblendet, keine Entscheidung getroffen.`,
      });
    } else if (r.selfTest === false) {
      res.attempts.push({
        method: 'autoconsent',
        ok: false,
        detail: `autoconsent (${r.cmp}): Selbsttest nach dem Ablehnen fehlgeschlagen (Einwilligungsstatus nicht wie erwartet).`,
      });
    } else {
      // The rule may click several times (e.g. settings → save); the last click before the
      // result is the decisive one. Without any click event (API-based rule) the result time
      // is used – later than the real action, i.e. conservative for scenario C.
      const doneAt = Date.now();
      const ok = await finish(
        'autoconsent',
        clicksBetween(opStart, doneAt).at(-1) ?? doneAt,
        preRoots,
        `autoconsent (${r.cmp}): ${label} ausgeführt${r.clicks !== undefined ? ` (${r.clicks} Klick(s))` : ''}.`,
      );
      if (ok) {
        if (res.cmp === undefined && r.cmp) res.cmp = r.cmp;
        // A successful one-click opt-out proves a reject option on the first layer, even if
        // the heuristic did not recognise its label.
        if (action === 'reject' && r.clicks === 1 && res.rejectFirstLayer === false) {
          res.rejectFirstLayer = true;
        }
        return res;
      }
    }
  }

  // 3. Heuristic (also covers the second layer).
  const plan = await heuristicOperate(page, action, opts, payWall !== undefined);
  if (!plan.ok) {
    res.attempts.push({ method: 'heuristik', ok: false, detail: plan.detail });
    if (plan.secondLayer) res.secondLayer = plan.secondLayer;
  } else {
    const ok = await finish(
      'heuristik',
      ownClickAt(plan.decisiveAt ?? Date.now()),
      [...preRoots, ...plan.roots],
      plan.detail,
      {
        ...(plan.clickedText ? { clickedText: plan.clickedText } : {}),
        ...(plan.secondLayer ? { secondLayer: plan.secondLayer } : {}),
      },
    );
    if (ok) return res;
    if (plan.secondLayer) res.secondLayer = { ...plan.secondLayer, succeeded: false };
  }

  res.succeeded = false;
  delete res.clicked;
  res.failureReason = res.attempts.length
    ? res.attempts.map((a) => a.detail).join(' / ')
    : 'Banner konnte nicht bedient werden.';
  if (action === 'reject') {
    // "Ablehnen" may also lead to a subscription wall: look at what is visible now.
    const wall =
      payWall ?? payWallBanner(await decisionBanners(page).catch(() => [] as HeuristicBanner[]));
    if (wall) {
      res.consentOrPay = true;
      res.failureReason = consentOrPayReason(wall, res.secondLayer?.tried === true);
    }
  }
  return res;
}
