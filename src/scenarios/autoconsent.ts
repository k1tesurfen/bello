/**
 * Drives `@duckduckgo/autoconsent` (MPL-2.0) from Playwright (PLAN §5.6).
 *
 * The package's `dist/autoconsent.playwright.js` content script expects two globals:
 * `window.autoconsentSendMessage` (page → Node, provided via `page.exposeBinding`) and
 * `window.autoconsentReceiveMessage` (Node → page, defined by the script itself). The script is
 * injected into every frame via `page.addInitScript` (and once more after navigation, for frames
 * that existed before). Each frame sends `init`; we answer `initResp` with config + the rules
 * relevant for that frame.
 *
 * Bello always runs autoconsent with `autoAction: null` (detection only) and triggers
 * `optOut` / `optIn` explicitly, so that we control the moment of the click (screenshot first).
 * Deliberately disabled:
 *  - cosmetic rules: they only *hide* a banner via CSS, which is no consent decision;
 *  - heuristic mode: in `tier1/tier2` it would click "accept" when no reject exists;
 *  - prehide: would alter what is visible on the page.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Frame, Page } from 'playwright';

const require = createRequire(import.meta.url);

interface RunContext {
  main?: boolean;
  frame?: boolean;
  urlPattern?: string;
}
interface Rule {
  name: string;
  runContext?: RunContext;
  cosmetic?: boolean;
  [k: string]: unknown;
}

let cached: { script: string; rules: Rule[] } | undefined;

/** Loads the content script and the full rule set (with optIn steps) once. */
function assets(): { script: string; rules: Rule[] } {
  if (!cached) {
    // `package.json` is not exported; `rules/rules.json` is, and sits one level below the root.
    const rulesFile = require.resolve('@duckduckgo/autoconsent/rules/rules.json');
    const pkgDir = path.dirname(path.dirname(rulesFile));
    const script = readFileSync(path.join(pkgDir, 'dist', 'autoconsent.playwright.js'), 'utf8');
    const bundle = JSON.parse(readFileSync(rulesFile, 'utf8')) as { autoconsent: Rule[] };
    cached = { script, rules: bundle.autoconsent };
  }
  return cached;
}

/** Rules applicable to a frame (same logic as autoconsent's own `checkRunContext`). */
export function rulesForFrame(rules: readonly Rule[], url: string, mainFrame: boolean): Rule[] {
  return rules.filter((r) => {
    const ctx = { main: true, frame: false, ...(r.runContext ?? {}) };
    if (mainFrame && !ctx.main) return false;
    if (!mainFrame && !ctx.frame) return false;
    if (ctx.urlPattern) {
      try {
        if (!new RegExp(ctx.urlPattern).test(url)) return false;
      } catch {
        return false;
      }
    }
    return true;
  });
}

type Step = Record<string, unknown>;

/** Step keys of a rule action, recursing into `if/then/else` and `any`. */
function stepKinds(steps: unknown, out: Array<{ key: string; value: unknown }> = []) {
  if (!Array.isArray(steps)) return out;
  for (const st of steps as Step[]) {
    if (!st || typeof st !== 'object') continue;
    for (const [key, value] of Object.entries(st)) {
      out.push({ key, value });
      if (key === 'then' || key === 'else' || key === 'any') stepKinds(value, out);
    }
  }
  return out;
}

/**
 * True for a rule whose opt-out only *hides* the banner (stylesheet / hide / removeClass,
 * scroll-restoring evals) without clicking anything or calling a consent API – e.g.
 * `sourcepoint-top`, the top-frame companion of Sourcepoint's iframe message. Such a rule would
 * report a successful "opt-out" although no decision was made, so Bello never loads it.
 */
export function isHideOnlyRule(rule: Rule): boolean {
  if (rule.cosmetic) return false; // cosmetic rules are disabled via config anyway
  const steps = stepKinds(rule.optOut);
  if (steps.length === 0) return false;
  return !steps.some(
    ({ key, value }) =>
      key === 'click' ||
      key === 'waitForThenClick' ||
      (key === 'eval' && !/RESTORE_SCROLL/.test(String(value))),
  );
}

const AUTOCONSENT_CONFIG = {
  enabled: true,
  autoAction: null,
  disabledCmps: [],
  enablePrehide: false,
  enableCosmeticRules: false,
  enableGeneratedRules: true,
  enableHeuristicDetection: false,
  heuristicMode: 'off',
  enablePopupMutationObserver: false,
  detectRetries: 20,
  isMainWorld: true,
  prehideTimeout: 2000,
  visualTest: false,
  performanceLoggingEnabled: false,
  heuristicPopupSearchTimeout: 0,
  logs: {
    lifecycle: false,
    rulesteps: false,
    detectionsteps: false,
    evals: false,
    errors: false,
    messages: false,
    waits: false,
  },
};

/** A message received from an autoconsent instance, with receive time (epoch ms). */
export interface AutoconsentMessage {
  type: string;
  frame: Frame;
  time: number;
  cmp?: string;
  url?: string;
  result?: boolean;
  isCosmetic?: boolean;
  totalClicks?: number;
  scheduleSelfTest?: boolean;
  state?: { lifecycle?: string; clicks?: number };
}

export interface AutoconsentRunResult {
  /** optOutResult / optInResult value; undefined if no result arrived in time. */
  result?: boolean;
  cmp?: string;
  /** True if the rule only hid the banner (should not happen, cosmetic rules are disabled). */
  cosmetic?: boolean;
  /** Clicks performed by the rule (from autoconsentDone / reports). */
  clicks?: number;
  /** Self-test result (opt-out only, if the rule has one); null = not run. */
  selfTest: boolean | null;
  /** Number of rule rounds (intermediate rules need several). */
  rounds: number;
}

/** The binding used to timestamp click events inside the page (see {@link AutoconsentDriver}). */
export const CLICK_BINDING = '__belloClick';

const CLICK_LISTENER_SCRIPT = `(() => {
  try {
    window.addEventListener('click', () => {
      try { window.${CLICK_BINDING} && window.${CLICK_BINDING}(Date.now()); } catch (e) {}
    }, true);
  } catch (e) {}
})();`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class AutoconsentDriver {
  readonly messages: AutoconsentMessage[] = [];
  /** Epoch ms of click events observed in any frame (capture-phase listener). */
  readonly clickTimes: number[] = [];
  private readonly listeners = new Set<() => void>();
  private constructor(
    private readonly page: Page,
    private readonly enabled: boolean,
  ) {}

  /**
   * Installs bindings and init scripts on a fresh page (before the first navigation).
   * With `enabled: false` only the click listener is installed.
   */
  static async attach(page: Page, opts: { enabled?: boolean } = {}): Promise<AutoconsentDriver> {
    const enabled = opts.enabled ?? true;
    const d = new AutoconsentDriver(page, enabled);
    await page.exposeBinding(CLICK_BINDING, (_src, t: unknown) => {
      d.clickTimes.push(typeof t === 'number' ? t : Date.now());
    });
    await page.addInitScript({ content: CLICK_LISTENER_SCRIPT });
    if (enabled) {
      const { script } = assets();
      await page.exposeBinding('autoconsentSendMessage', (src, msg: unknown) => {
        d.onMessage(src.frame, msg);
      });
      await page.addInitScript({ content: script });
    }
    return d;
  }

  /** Injects the content script into frames that were created before the init script ran. */
  async injectIntoExistingFrames(): Promise<void> {
    if (!this.enabled) return;
    const { script } = assets();
    // Bounded: evaluating in a frame without a document yet (e.g. a lazy iframe that has not
    // started loading) would wait until the frame navigates.
    await Promise.all(
      this.page
        .frames()
        .filter((f) => f.url() !== '')
        .map((f) => Promise.race([f.evaluate(script).catch(() => {}), sleep(2000)])),
    );
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  private onMessage(frame: Frame, raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const msg = raw as Record<string, unknown>;
    const type = String(msg.type);
    const m: AutoconsentMessage = { type, frame, time: Date.now() };
    if (typeof msg.cmp === 'string') m.cmp = msg.cmp;
    if (typeof msg.url === 'string') m.url = msg.url;
    if (typeof msg.result === 'boolean') m.result = msg.result;
    if (typeof msg.isCosmetic === 'boolean') m.isCosmetic = msg.isCosmetic;
    if (typeof msg.totalClicks === 'number') m.totalClicks = msg.totalClicks;
    if (typeof msg.scheduleSelfTest === 'boolean') m.scheduleSelfTest = msg.scheduleSelfTest;
    if (msg.state && typeof msg.state === 'object') {
      m.state = msg.state as AutoconsentMessage['state'];
    }
    this.messages.push(m);
    this.notify();

    switch (type) {
      case 'init': {
        const mainFrame = frame.parentFrame() === null;
        const rules = rulesForFrame(assets().rules, frame.url(), mainFrame).filter(
          (r) => !isHideOnlyRule(r),
        );
        void this.send(frame, {
          type: 'initResp',
          config: AUTOCONSENT_CONFIG,
          rules: { autoconsent: rules },
        });
        break;
      }
      case 'eval': {
        void (async () => {
          let result: unknown;
          try {
            result = await frame.evaluate(String(msg.code));
          } catch {
            result = false;
          }
          void this.send(frame, { type: 'evalResp', id: msg.id, result });
        })();
        break;
      }
      default:
        break;
    }
  }

  private send(frame: Frame, message: unknown): Promise<void> {
    const code = `window.autoconsentReceiveMessage && window.autoconsentReceiveMessage(${JSON.stringify(message)})`;
    // Not awaited by the caller in the message handler: optOut/optIn resolve only when done.
    return frame.evaluate(code).then(
      () => undefined,
      () => undefined,
    );
  }

  /** CMPs detected (cmpDetected), earliest first. */
  detected(): AutoconsentMessage[] {
    return this.messages.filter((m) => m.type === 'cmpDetected');
  }

  /** Visible popups reported (popupFound) in frames that are still attached. */
  popups(since = 0): AutoconsentMessage[] {
    return this.messages.filter(
      (m) => m.type === 'popupFound' && m.time >= since && !m.frame.isDetached(),
    );
  }

  /** Resolves once `pred` holds for a received message or the timeout elapses. */
  async waitFor(
    pred: (m: AutoconsentMessage) => boolean,
    timeoutMs: number,
  ): Promise<AutoconsentMessage | undefined> {
    const found = this.messages.find(pred);
    if (found) return found;
    return new Promise((resolve) => {
      const done = (v: AutoconsentMessage | undefined): void => {
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve(v);
      };
      const check = (): void => {
        const m = this.messages.find(pred);
        if (m) done(m);
      };
      const timer = setTimeout(() => done(undefined), timeoutMs);
      this.listeners.add(check);
    });
  }

  /**
   * Runs opt-out / opt-in in the frame that reported the popup. Follows intermediate rules
   * (a rule whose result is true but which sends no `autoconsentDone`) for up to 3 rounds.
   */
  async run(
    action: 'optOut' | 'optIn',
    popup: AutoconsentMessage,
    timeoutMs = 20_000,
  ): Promise<AutoconsentRunResult> {
    const resultType = action === 'optOut' ? 'optOutResult' : 'optInResult';
    const out: AutoconsentRunResult = { selfTest: null, rounds: 0 };
    let target: AutoconsentMessage | undefined = popup;
    const deadline = Date.now() + timeoutMs;
    while (target && out.rounds < 3 && Date.now() < deadline) {
      out.rounds++;
      const start = Date.now();
      const frame = target.frame;
      void this.send(frame, { type: action });
      // Some CMPs continue in a *different* frame (Sourcepoint: the message iframe opens the
      // privacy manager in a new iframe and the rule in the first frame then waits in vain).
      // A popup reported by another frame during the run takes over after a short grace period.
      const isResult = (m: AutoconsentMessage): boolean =>
        m.type === resultType && m.frame === frame && m.time >= start;
      const isOtherPopup = (m: AutoconsentMessage): boolean =>
        m.type === 'popupFound' && m.frame !== frame && m.time >= start && !m.frame.isDetached();
      let res = await this.waitFor(
        (m) => isResult(m) || isOtherPopup(m),
        Math.max(0, deadline - Date.now()),
      );
      if (res && !isResult(res)) {
        const other = res;
        res = await this.waitFor(isResult, Math.min(1500, Math.max(0, deadline - Date.now())));
        if (!res) {
          target = other;
          continue;
        }
      }
      if (!res) {
        delete out.result;
        return out;
      }
      out.result = res.result === true;
      out.cmp = res.cmp ?? target.cmp;
      if (!out.result) return out;
      const done = await this.waitFor(
        (m) => m.type === 'autoconsentDone' && m.frame === frame && m.time >= start,
        1500,
      );
      if (done) {
        out.cosmetic = done.isCosmetic === true;
        if (typeof done.totalClicks === 'number') out.clicks = done.totalClicks;
        if (action === 'optOut' && res.scheduleSelfTest) {
          out.selfTest = await this.selfTest(frame, 5000);
        }
        return out;
      }
      // Intermediate rule: wait for the next popup (possibly in another frame).
      const next = await this.waitFor(
        (m) => m.type === 'popupFound' && m.time >= start && !m.frame.isDetached(),
        Math.min(3000, Math.max(0, deadline - Date.now())),
      );
      target = next;
    }
    return out;
  }

  private async selfTest(frame: Frame, timeoutMs: number): Promise<boolean | null> {
    const start = Date.now();
    // Give the CMP a moment to persist its state before the self-test reads it.
    await sleep(500);
    void this.send(frame, { type: 'selfTest' });
    const r = await this.waitFor(
      (m) => m.type === 'selfTestResult' && m.frame === frame && m.time >= start,
      timeoutMs,
    );
    return r ? r.result === true : null;
  }
}
