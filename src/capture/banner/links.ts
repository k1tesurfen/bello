/**
 * In-page link scan shared by the banner design checks and the privacy policy finder.
 * Looks at DOM, open shadow roots and every frame. Never clicks; for hit testing it only
 * scrolls off-screen links to the viewport bottom (and restores the scroll position afterwards).
 */
import type { Frame, Page } from 'playwright';
import { pageFn } from '../../scenarios/banner-dom.js';

export type LegalLinkKind = 'imprint' | 'privacy';

export interface LegalLink {
  kind: LegalLinkKind;
  /** Visible label (trimmed, max. 80 chars). */
  text: string;
  /** Absolute href ('' if the element has none). */
  href: string;
  visible: boolean;
  /** Link is the top-most element at its center (only computed with `hitTest`). */
  reachable: boolean;
  mainFrame: boolean;
  /** Inside a fixed/sticky/dialog container, i.e. most likely part of the banner/overlay. */
  inOverlay: boolean;
}

const SCAN_SCRIPT = String.raw`(opts) => {
  const IMPRINT = /(^|[^\p{L}])(impressum|imprint|legal\s+notice|anbieterkennzeichnung)([^\p{L}]|$)/iu;
  const PRIVACY = /(^|[^\p{L}])(datenschutz\p{L}*|privacy|privatsph\p{L}*|data\s+protection)([^\p{L}]|$)/iu;
  const visible = (el) => {
    if (typeof el.checkVisibility === 'function' &&
        !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2;
  };
  const parentOf = (el) => el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
  const composedContains = (anc, el) => {
    for (let c = el; c; c = parentOf(c)) if (c === anc) return true;
    return false;
  };
  const deepHit = (x, y) => {
    let hit = document.elementFromPoint(x, y);
    for (let i = 0; hit && hit.shadowRoot && i < 10; i++) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  };
  const inOverlay = (el) => {
    for (let c = el, i = 0; c && i < 40; c = parentOf(c), i++) {
      if (c === document.body || c === document.documentElement) break;
      const cs = getComputedStyle(c);
      if (cs.position === 'fixed' || cs.position === 'sticky' || c.tagName === 'DIALOG' ||
          c.getAttribute('role') === 'dialog' || c.getAttribute('aria-modal') === 'true') return true;
    }
    return false;
  };
  const anchors = [];
  const collect = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.tagName === 'A' || el.getAttribute('role') === 'link') anchors.push(el);
      if (el.shadowRoot) collect(el.shadowRoot);
    }
  };
  collect(document);
  const sx = window.scrollX, sy = window.scrollY;
  const out = [];
  for (const el of anchors) {
    const label = ((el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()) ||
      el.getAttribute('aria-label') || el.getAttribute('title') || '';
    if (!label || label.length > 60) continue;
    const kind = IMPRINT.test(label) ? 'imprint' : PRIVACY.test(label) ? 'privacy' : null;
    if (!kind) continue;
    const vis = visible(el);
    let reachable = false;
    if (opts.hitTest && vis) {
      try {
        // Test where the user sees the link right now first. Only links outside the viewport are
        // scrolled in, placed at the bottom edge, where fixed bottom banners usually sit.
        const inView = (b) => b.left + b.width / 2 >= 0 && b.top + b.height / 2 >= 0 &&
          b.left + b.width / 2 < window.innerWidth && b.top + b.height / 2 < window.innerHeight;
        if (!inView(el.getBoundingClientRect())) {
          el.scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'instant' });
        }
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        if (x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight) {
          const hit = deepHit(x, y);
          reachable = !!hit && (hit === el || composedContains(el, hit));
          if (!reachable && hit && el.tagName === 'A' && hit.closest) {
            // transparent wrapper links etc. are not "reachable" unless the link itself is hit
            reachable = false;
          }
        }
      } catch (e) { reachable = false; }
    }
    let href = '';
    try { href = el.href && typeof el.href === 'string' ? el.href : (el.getAttribute('href') || ''); } catch (e) {}
    out.push({ kind, text: label.slice(0, 80), href, visible: vis, reachable,
      mainFrame: window === window.top, inOverlay: inOverlay(el) });
  }
  if (opts.hitTest) window.scrollTo(sx, sy);
  return out;
}`;

const SCAN_FN = pageFn(SCAN_SCRIPT);

async function scanFrame(frame: Frame, hitTest: boolean): Promise<LegalLink[]> {
  const res = (await frame.evaluate(SCAN_FN, { hitTest })) as LegalLink[];
  return res;
}

/** Scans all frames; frames that fail (detached, cross-origin crash) are skipped. */
export async function scanLegalLinks(
  page: Page,
  opts: { hitTest?: boolean; timeoutMs?: number } = {},
): Promise<LegalLink[]> {
  const timeoutMs = opts.timeoutMs ?? 4000;
  const results = await Promise.all(
    page
      .frames()
      .filter((f) => !f.isDetached())
      .map(async (f) => {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<LegalLink[]>((r) => {
          timer = setTimeout(() => r([]), timeoutMs);
        });
        try {
          return await Promise.race([scanFrame(f, opts.hitTest ?? false).catch(() => []), timeout]);
        } finally {
          clearTimeout(timer);
        }
      }),
  );
  return results.flat();
}
