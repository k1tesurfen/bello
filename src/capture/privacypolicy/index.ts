/** Privacy policy discovery, text extraction and vendor comparison (PLAN §5.7). */
import type { BrowserContext, Page } from 'playwright';
import { pageFn } from '../../scenarios/banner-dom.js';
import { scanLegalLinks, type LegalLink } from '../banner/links.js';

export { matchVendorsInPolicy, type PolicyVendor } from './vendors.js';

const BODY_TEXT_FN = pageFn('() => (document.body ? document.body.innerText : "")');

const COOKIE_SETTINGS_HREF =
  /cookie[-_ ]?(einstellung|settings|preferences|consent|manager)|consent[-_ ]?(manager|settings)|manage[-_]?cookies|privacy[-_]?settings|datenschutz[-_]?einstellung/i;

function rank(text: string): number {
  const t = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (t === 'datenschutzerklärung' || t === 'datenschutzerklaerung') return 6;
  if (/^datenschutzerklärung|^datenschutzerklaerung/.test(t)) return 5;
  if (t === 'datenschutz') return 4;
  if (/^datenschutz/.test(t)) return 3;
  if (t === 'privacy policy' || t === 'privacy') return 2;
  return 1;
}

function usable(l: LegalLink, pageUrl: string): boolean {
  if (l.kind !== 'privacy' || !l.href) return false;
  if (/^(javascript|mailto|tel|data):/i.test(l.href)) return false;
  let u: URL;
  try {
    u = new URL(l.href, pageUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  // same-document anchor (e.g. "#cookie-settings")
  let cur: URL | undefined;
  try {
    cur = new URL(pageUrl);
  } catch {
    cur = undefined;
  }
  if (u.hash && cur && u.href.split('#')[0] === cur.href.split('#')[0]) return false;
  if (
    COOKIE_SETTINGS_HREF.test(u.pathname + u.hash) &&
    !/datenschutzerkl|privacy-?policy/i.test(u.pathname)
  ) {
    return false;
  }
  if (/cookie[-_ ]?(einstellung|settings)|einstellungen/i.test(l.text)) return false;
  return true;
}

/** Best privacy policy link (banner incl. shadow DOM/iframes, footer, rest of the page). */
export async function findPrivacyPolicyUrl(page: Page): Promise<string | undefined> {
  const links = await scanLegalLinks(page, { hitTest: false }).catch(() => []);
  const pageUrl = page.url();
  const cands = links.filter((l) => usable(l, pageUrl));
  if (cands.length === 0) return undefined;
  const score = (l: LegalLink): number => rank(l.text) * 10 + (l.visible ? 5 : 0);
  // stable: document order wins on equal score
  let best = cands[0]!;
  for (const c of cands) if (score(c) > score(best)) best = c;
  try {
    return new URL(best.href, pageUrl).href;
  } catch {
    return undefined;
  }
}

/** Opens `url` in a fresh page of `context`, extracts the visible text and closes the page. */
export async function fetchPrivacyPolicyText(
  context: BrowserContext,
  url: string,
): Promise<{ url: string; text: string }> {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    const raw = (await page.evaluate(BODY_TEXT_FN)) as string;
    return { url: page.url() || url, text: raw.replace(/\s+/g, ' ').trim() };
  } finally {
    await page.close().catch(() => {});
  }
}
