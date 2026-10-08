/**
 * In-page part of the heuristic banner fallback: finds visible consent banners (DOM, open shadow
 * roots, every frame) and their controls, and returns element handles for clicking.
 *
 * The page code is kept as a plain JavaScript *string* (not a serialized TS function) so that no
 * transpiler helper can leak into it.
 */
import type { ElementHandle, Frame, JSHandle, Page } from 'playwright';
import {
  BUTTON_KIND_ORDER,
  BUTTON_PATTERNS,
  CMP_BUTTON_SELECTORS,
  CONSENT_KEYWORDS,
  ROOT_HINTS,
  type ButtonKind,
} from './banner-patterns.js';

/** One classified control inside a banner. */
export interface BannerButton {
  kind: ButtonKind;
  /** Visible label (trimmed, max. 80 chars). */
  text: string;
  handle: ElementHandle;
}

/** A visible consent banner found by the heuristic. */
export interface HeuristicBanner {
  frame: Frame;
  frameUrl: string;
  mainFrame: boolean;
  root: ElementHandle;
  /** First ~300 characters of the banner text. */
  text: string;
  buttons: BannerButton[];
  has: Record<ButtonKind, boolean>;
}

const PAGE_CONFIG = {
  order: BUTTON_KIND_ORDER,
  patterns: BUTTON_PATTERNS,
  selectors: CMP_BUTTON_SELECTORS,
  keywords: CONSENT_KEYWORDS,
  hints: ROOT_HINTS,
};

/** Shared page helpers (visibility, shadow-aware parent). Plain JS. */
const PAGE_HELPERS = String.raw`
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === 'function' &&
        !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.right <= 0 || r.left >= window.innerWidth) return false;
    if (r.bottom + window.scrollY <= 0) return false;
    return true;
  };
  const parentOf = (el) => {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode && el.getRootNode();
    return root && root.host ? root.host : null;
  };
`;

/**
 * Scans the current frame. Returns `{banners, elements}` where banners reference indexes into
 * `elements` (so Node can turn them into ElementHandles).
 */
const SCAN_SCRIPT = String.raw`(cfg) => {
  const P = {};
  for (const k of cfg.order) P[k] = cfg.patterns[k].map((s) => new RegExp(s, 'iu'));
  const KW = new RegExp(cfg.keywords, 'i');
  const HINT = new RegExp(cfg.hints, 'i');
  __HELPERS__
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  const classify = (t) => {
    if (!t || t.length > 80) return null;
    for (const k of cfg.order) if (P[k].some((r) => r.test(t))) return k;
    return null;
  };
  const labelOf = (el) => {
    let t = '';
    if (el.tagName === 'INPUT') t = el.value || '';
    else t = el.innerText || el.textContent || '';
    if (!norm(t)) t = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    return t.replace(/\s+/g, ' ').trim();
  };
  const SEL = {};
  for (const k of cfg.order) SEL[k] = cfg.selectors[k].join(', ');
  const matches = (el, sel) => { try { return !!sel && el.matches(sel); } catch (e) { return false; } };
  // Known CMP markup wins over the label (labels are customisable, the markup is not).
  const kindBySelector = (el) => {
    for (const k of cfg.order) if (matches(el, SEL[k])) return k;
    return null;
  };
  const ALL_SEL = cfg.order.map((k) => SEL[k]).filter(Boolean).join(', ');
  const CLICK = 'button, [role="button"], a, input[type="button"], input[type="submit"], [onclick], [tabindex]:not([tabindex="-1"]), [class*="button" i], [class*="btn" i]' + (ALL_SEL ? ', ' + ALL_SEL : '');
  const disabled = (el) => el.disabled === true || el.getAttribute('aria-disabled') === 'true';
  const candidates = [];
  const collect = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.matches(CLICK)) candidates.push(el);
      if (el.shadowRoot) collect(el.shadowRoot);
    }
  };
  collect(document);
  const textOf = (el) => (el.innerText || el.textContent || '');
  const isTop = window === window.top;
  // Dedicated CMP iframe (e.g. Sourcepoint's message iframe): the whole document is the banner,
  // so that controls in different rows (accept / settings) end up in one banner.
  const bodyText = !isTop && document.body ? textOf(document.body) : '';
  const cmpDocument = !isTop && document.body && KW.test(bodyText) && bodyText.length < 8000;
  const findRoot = (el) => {
    if (cmpDocument) return document.body;
    let cur = parentOf(el);
    let weak = null;
    for (let i = 0; cur && i < 30; i++) {
      if (cur === document.body || cur === document.documentElement) break;
      const cs = getComputedStyle(cur);
      const ident = (cur.id || '') + ' ' + (typeof cur.className === 'string' ? cur.className : '') +
        ' ' + (cur.getAttribute('aria-label') || '');
      const strong = cs.position === 'fixed' || cs.position === 'sticky' ||
        cur.tagName === 'DIALOG' || cur.getAttribute('role') === 'dialog' ||
        cur.getAttribute('role') === 'alertdialog' || cur.getAttribute('aria-modal') === 'true';
      if ((strong || HINT.test(ident)) && KW.test(textOf(cur))) {
        // Prefer the outermost overlay/dialog container; a hinted inner block is a fallback.
        if (strong) return cur;
        if (!weak) weak = cur;
      }
      cur = parentOf(cur);
    }
    return weak;
  };
  const elements = [];
  const indexOf = (el) => {
    let i = elements.indexOf(el);
    if (i < 0) { elements.push(el); i = elements.length - 1; }
    return i;
  };
  const seen = new Set();
  const byRoot = new Map();
  for (const el of candidates) {
    if (!visible(el)) continue;
    // Skip nested candidates of an already classified control (e.g. <a class=btn><span class=btn-text>).
    let p = parentOf(el), nested = false;
    for (let d = 0; p && d < 4; d++, p = parentOf(p)) if (seen.has(p)) { nested = true; break; }
    if (nested) continue;
    if (disabled(el)) continue;
    const text = labelOf(el);
    const bySel = kindBySelector(el);
    const kind = bySel || classify(norm(text));
    if (!kind) continue;
    const root = findRoot(el);
    if (!root || !visible(root)) continue;
    seen.add(el);
    let entry = byRoot.get(root);
    if (!entry) {
      entry = { root: indexOf(root), text: textOf(root).replace(/\s+/g, ' ').trim().slice(0, 300), buttons: [] };
      byRoot.set(root, entry);
    }
    entry.buttons.push({ kind, text: text.slice(0, 80), el: indexOf(el), norm: norm(text), cmp: !!bySel });
  }
  // Per-item controls: a list of purposes/vendors each with its own "Zustimmen"/"Ablehnen" is
  // not a global decision. Two or more identical labels of one kind in one banner are dropped
  // (markup-identified CMP controls are always global and kept).
  for (const entry of byRoot.values()) {
    const count = new Map();
    for (const b of entry.buttons) {
      if (b.cmp || (b.kind !== 'reject' && b.kind !== 'accept')) continue;
      const key = b.kind + '|' + b.norm;
      count.set(key, (count.get(key) || 0) + 1);
    }
    entry.buttons = entry.buttons
      .filter((b) => b.cmp || !((count.get(b.kind + '|' + b.norm) || 0) >= 2))
      .map((b) => ({ kind: b.kind, text: b.text, el: b.el }));
  }
  const banners = [...byRoot.values()].filter((b) =>
    b.buttons.some((x) => x.kind !== 'settings' && x.kind !== 'pay'));
  return { banners, elements };
}`.replace('__HELPERS__', PAGE_HELPERS);

const SCAN_FN = pageFn(SCAN_SCRIPT);

/** Page function: is the element still visible? */
const VISIBLE_SCRIPT = String.raw`(el) => { ${PAGE_HELPERS} return visible(el); }`;

/** Page function: returns the enabled, checked toggles inside `root` (incl. open shadow roots). */
const CHECKED_TOGGLES_SCRIPT = String.raw`(root) => {
  ${PAGE_HELPERS}
  const out = [];
  const walk = (r) => {
    for (const el of r.querySelectorAll('*')) {
      if (el.shadowRoot) walk(el.shadowRoot);
      if (el.tagName === 'INPUT' && el.type === 'checkbox') {
        if (el.checked && !el.disabled) out.push(el);
      } else if (el.getAttribute('role') === 'switch' || el.getAttribute('role') === 'checkbox') {
        if (el.getAttribute('aria-checked') === 'true' && el.getAttribute('aria-disabled') !== 'true' &&
            !el.hasAttribute('disabled')) out.push(el);
      }
    }
  };
  walk(root);
  return out;
}`;

/** Page function: is this toggle checked? */
const IS_CHECKED_SCRIPT = String.raw`(el) => el.tagName === 'INPUT' ? el.checked : el.getAttribute('aria-checked') === 'true'`;

/**
 * Wraps a page-function source string into a real function. Playwright evaluates *strings* as
 * plain expressions (never calls them), and serializes functions via `toString()`, which for a
 * `new Function` is exactly the source below, free of transpiler helpers.
 */
export function pageFn(src: string): (arg: unknown) => unknown {
  return new Function('arg', `return (${src})(arg);`) as (arg: unknown) => unknown;
}

const VISIBLE_FN = pageFn(VISIBLE_SCRIPT);
const CHECKED_TOGGLES_FN = pageFn(CHECKED_TOGGLES_SCRIPT);
const IS_CHECKED_FN = pageFn(IS_CHECKED_SCRIPT);
const DOM_CLICK_FN = pageFn('(el) => el.click()');

export async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface RawScan {
  banners: Array<{
    root: number;
    text: string;
    buttons: Array<{ kind: ButtonKind; text: string; el: number }>;
  }>;
}

async function scanFrame(frame: Frame, mainFrame: boolean): Promise<HeuristicBanner[]> {
  // A frame without URL has no document yet (e.g. a lazy iframe); evaluating would block.
  if (frame.isDetached() || frame.url() === '') return [];
  if (!mainFrame) {
    // A CMP iframe only counts if its <iframe> element is visible in the parent.
    const fe = await frame.frameElement().catch(() => undefined);
    if (!fe) return [];
    const ok = await fe.isVisible().catch(() => false);
    await fe.dispose().catch(() => {});
    if (!ok) return [];
  }
  const result: JSHandle = await frame.evaluateHandle(SCAN_FN, PAGE_CONFIG);
  try {
    const raw: RawScan = {
      banners: (await (await result.getProperty('banners')).jsonValue()) as RawScan['banners'],
    };
    if (raw.banners.length === 0) return [];
    const elsHandle = await result.getProperty('elements');
    const props = await elsHandle.getProperties();
    const handles: ElementHandle[] = [];
    for (let i = 0; i < props.size; i++) {
      const h = props.get(String(i))?.asElement();
      if (h) handles[i] = h as ElementHandle;
    }
    const out: HeuristicBanner[] = [];
    for (const b of raw.banners) {
      const root = handles[b.root];
      if (!root) continue;
      const buttons: BannerButton[] = [];
      for (const btn of b.buttons) {
        const handle = handles[btn.el];
        if (handle) buttons.push({ kind: btn.kind, text: btn.text, handle });
      }
      const has = { reject: false, save: false, accept: false, pay: false, settings: false };
      for (const btn of buttons) has[btn.kind] = true;
      out.push({ frame, frameUrl: frame.url(), mainFrame, root, text: b.text, buttons, has });
    }
    return out;
  } finally {
    await result.dispose().catch(() => {});
  }
}

/** Heuristically scans all frames of the page for visible consent banners. */
export async function scanForBanners(page: Page, timeoutMs = 2000): Promise<HeuristicBanner[]> {
  const main = page.mainFrame();
  const results = await Promise.all(
    page.frames().map((f) =>
      withTimeout(
        scanFrame(f, f === main).catch(() => []),
        timeoutMs,
        [],
      ),
    ),
  );
  const all = results.flat();
  // Strongest banner first: one with reject/accept controls, main frame before iframes.
  const score = (b: HeuristicBanner): number =>
    (b.has.reject ? 8 : 0) +
    (b.has.accept ? 4 : 0) +
    (b.has.settings || b.has.save ? 2 : 0) +
    (b.mainFrame ? 1 : 0);
  return all.sort((a, b) => score(b) - score(a));
}

/** True if a banner offers a primary consent decision (accept or reject). */
export function isDecisionBanner(b: HeuristicBanner): boolean {
  return b.has.accept || b.has.reject;
}

/** True if the element is still attached and visible (false on any error). */
export async function isElementVisible(handle: ElementHandle): Promise<boolean> {
  try {
    return Boolean(await handle.evaluate(VISIBLE_FN));
  } catch {
    return false;
  }
}

/** Enabled, checked toggles (checkbox / switch) inside a banner root. */
export async function checkedToggles(root: ElementHandle): Promise<ElementHandle[]> {
  const res = await root.evaluateHandle(CHECKED_TOGGLES_FN);
  try {
    const props = await res.getProperties();
    const out: ElementHandle[] = [];
    for (const p of props.values()) {
      const el = p.asElement();
      if (el) out.push(el as ElementHandle);
    }
    return out;
  } finally {
    await res.dispose().catch(() => {});
  }
}

export async function isToggleChecked(handle: ElementHandle): Promise<boolean> {
  try {
    return Boolean(await handle.evaluate(IS_CHECKED_FN));
  } catch {
    return false;
  }
}

/**
 * Clicks exactly this element: first a real (trusted) Playwright click; if the actionability
 * checks fail (e.g. element covered or off-screen), a DOM `click()` on the same element.
 * Never falls back to a coordinate click, which could hit a different element.
 */
export async function clickElement(handle: ElementHandle, timeoutMs = 3000): Promise<boolean> {
  try {
    await handle.click({ timeout: timeoutMs });
    return true;
  } catch {
    try {
      await handle.evaluate(DOM_CLICK_FN);
      return true;
    } catch {
      return false;
    }
  }
}
