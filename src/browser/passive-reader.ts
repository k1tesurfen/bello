/**
 * "Passiver Leser" (PLAN §3): behaves like a reader who ignores the banner.
 *
 *  1. wait for network idle (bounded),
 *  2. scroll slowly to the end of the page (step-wise, so `loading="lazy"` iframes/images and
 *     lazy scripts fire; follows pages that grow while scrolling; bounded duration),
 *  3. simulated mouse movements,
 *  4. wait `waitSeconds` (default 10 s).
 *
 * It never clicks anything. Scrolling uses `window.scrollBy` (fires real `scroll` events and
 * IntersectionObserver callbacks; works even when a modal banner sets `overflow: hidden`).
 * If the document itself is not scrollable, the largest scrollable element is scrolled instead.
 */
import type { Page } from 'playwright';

export interface PassiveReaderOptions {
  /** Epoch ms of navigation start; all returned times are relative to it. */
  navigationStart: number;
  /** Final wait in seconds (PLAN `--wait`, default 10). */
  waitSeconds?: number;
  /** Max. time to wait for network idle (default 15 000 ms). */
  networkIdleTimeoutMs?: number;
  /** Pixels per scroll step (default 400). */
  scrollStepPx?: number;
  /** Pause between scroll steps (default 250 ms). */
  scrollStepDelayMs?: number;
  /** Upper bound for the whole scroll phase (default 60 000 ms). */
  maxScrollMs?: number;
  /** Wait at the bottom to see whether the page grows (default 1000 ms). */
  bottomSettleMs?: number;
  /** Number of simulated mouse movements (default 6). */
  mouseMoves?: number;
}

export interface PassiveReaderResult {
  networkIdleReached: boolean;
  /** Start / end of the scroll phase (relative ms). */
  scrollPhaseStartAt: number;
  scrollPhaseEndAt: number;
  /** End of the final wait (relative ms). */
  endAt: number;
  reachedBottom: boolean;
  scrollSteps: number;
  /** Final document/scroll-container height in px. */
  scrollHeight: number;
  /** True if a nested scroll container was scrolled instead of the document. */
  usedScrollContainer: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Max. time for one page round trip (evaluate / mouse move). A busy renderer must not hang us. */
const STEP_TIMEOUT_MS = 5_000;

/** Resolves with `fallback` if `p` does not settle within `ms` (the original promise is left running). */
export function withTimeout<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
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

interface ScrollState {
  y: number;
  viewport: number;
  height: number;
  container: boolean;
}

/**
 * Page script: scrolls by `step` px (or 0 = just measure). Uses the document scroller; falls
 * back to the largest scrollable element if the document cannot scroll.
 * Built with `new Function` so no transpiler helper leaks into the serialized source.
 */
const SCROLL_FN = new Function(
  'step',
  String.raw`
  const doc = document.scrollingElement || document.documentElement;
  let target = null;
  if (doc.scrollHeight - window.innerHeight <= 2) {
    let best = 0;
    for (const el of document.querySelectorAll('body *')) {
      const extra = el.scrollHeight - el.clientHeight;
      if (extra > 50 && el.clientHeight > 100) {
        const ov = getComputedStyle(el).overflowY;
        if ((ov === 'auto' || ov === 'scroll' || ov === 'overlay') && extra > best) {
          best = extra;
          target = el;
        }
      }
    }
  }
  if (target) {
    if (step) target.scrollBy(0, step);
    return { y: target.scrollTop, viewport: target.clientHeight, height: target.scrollHeight, container: true };
  }
  if (step) window.scrollBy(0, step);
  return { y: window.scrollY, viewport: window.innerHeight, height: doc.scrollHeight, container: false };
`,
) as (step: number) => ScrollState;

async function scrollState(page: Page, step: number): Promise<ScrollState | undefined> {
  try {
    return await withTimeout(page.evaluate(SCROLL_FN, step), STEP_TIMEOUT_MS, undefined);
  } catch {
    return undefined; // navigation in progress / page closed
  }
}

/** Deterministic pseudo-random positions inside the viewport (no randomness in evidence runs). */
async function moveMouse(page: Page, count: number): Promise<void> {
  const vp = page.viewportSize() ?? { width: 1280, height: 720 };
  for (let i = 0; i < count; i++) {
    const x = Math.round(vp.width * (0.2 + ((i * 0.37) % 0.6)));
    const y = Math.round(vp.height * (0.25 + ((i * 0.53) % 0.5)));
    try {
      const done = await withTimeout(
        page.mouse.move(x, y, { steps: 8 }).then(() => true),
        STEP_TIMEOUT_MS,
        false,
      );
      if (!done) return;
    } catch {
      return;
    }
    await sleep(60);
  }
}

/** Runs the passive reader on the current page. Never clicks. */
export async function runPassiveReader(
  page: Page,
  opts: PassiveReaderOptions,
): Promise<PassiveReaderResult> {
  const rel = (): number => Date.now() - opts.navigationStart;
  const step = opts.scrollStepPx ?? 400;
  const stepDelay = opts.scrollStepDelayMs ?? 250;
  const maxScroll = opts.maxScrollMs ?? 60_000;
  const bottomSettle = opts.bottomSettleMs ?? 1000;
  const mouseMoves = opts.mouseMoves ?? 6;

  // 1. Network idle.
  let networkIdleReached = true;
  try {
    await page.waitForLoadState('networkidle', { timeout: opts.networkIdleTimeoutMs ?? 15_000 });
  } catch {
    networkIdleReached = false;
  }

  // 2. Scroll to the end.
  const scrollPhaseStartAt = rel();
  const scrollDeadline = Date.now() + maxScroll;
  await moveMouse(page, Math.min(2, mouseMoves));
  let steps = 0;
  let reachedBottom = false;
  let state = await scrollState(page, 0);
  let lastHeight = state?.height ?? 0;
  while (state && Date.now() < scrollDeadline) {
    const atBottom = state.y + state.viewport >= state.height - 2;
    if (atBottom) {
      // Infinite scroll / lazy content may extend the page: wait and re-check once.
      await sleep(bottomSettle);
      const after = await scrollState(page, 0);
      if (!after) break;
      if (after.height <= lastHeight + 2) {
        reachedBottom = true;
        state = after;
        break;
      }
      lastHeight = after.height;
      state = after;
      continue;
    }
    const next = await scrollState(page, step);
    steps++;
    if (!next) break;
    if (next.y <= state.y && next.height === state.height) {
      // Could not scroll any further (e.g. scroll blocked): treat as bottom.
      state = next;
      reachedBottom = next.y + next.viewport >= next.height - 2;
      break;
    }
    lastHeight = Math.max(lastHeight, next.height);
    state = next;
    await sleep(stepDelay);
  }
  const scrollPhaseEndAt = rel();

  // 3. Mouse movements.
  await moveMouse(page, Math.max(0, mouseMoves - 2));

  // 4. Final wait.
  await sleep(Math.max(0, (opts.waitSeconds ?? 10) * 1000));

  return {
    networkIdleReached,
    scrollPhaseStartAt,
    scrollPhaseEndAt,
    endAt: rel(),
    reachedBottom,
    scrollSteps: steps,
    scrollHeight: state?.height ?? 0,
    usedScrollContainer: state?.container ?? false,
  };
}
