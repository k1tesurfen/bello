/**
 * Banner design checks (PLAN §7 "Banner-Design-Prüfungen (v1)"):
 *  1. reject option on the first layer,
 *  2. imprint and privacy policy reachable while the banner is open.
 * Read-only: nothing is ever clicked.
 */
import type { Page } from 'playwright';
import { isDecisionBanner, scanForBanners } from '../../scenarios/banner-dom.js';
import type { BannerInfo } from '../../types.js';
import { scanLegalLinks, type LegalLink } from './links.js';

export interface BannerDesignResult {
  /** Reject on the first layer (undefined: could not be determined). */
  rejectFirstLayer: boolean | undefined;
  imprintReachable: boolean | undefined;
  privacyPolicyReachable: boolean | undefined;
  /** German explanations. */
  details: string[];
}

function reachability(links: LegalLink[]): boolean {
  return links.some((l) => l.visible && l.reachable);
}

function describe(name: string, links: LegalLink[]): string {
  if (links.length === 0) return `Kein Link „${name}“ auf der Seite gefunden.`;
  if (!links.some((l) => l.visible)) return `Link „${name}“ ist vorhanden, aber nicht sichtbar.`;
  if (reachability(links)) {
    const l = links.find((x) => x.visible && x.reachable)!;
    return `Link „${l.text}“ ist bei offenem Banner sichtbar und anklickbar${
      l.inOverlay ? ' (im Banner bzw. Overlay)' : ''
    }.`;
  }
  return `Link „${name}“ ist vorhanden, wird aber bei offenem Banner von diesem bzw. einem Overlay verdeckt.`;
}

export async function checkBannerDesign(
  page: Page,
  banner: BannerInfo,
): Promise<BannerDesignResult> {
  const details: string[] = [];

  let rejectFirstLayer: boolean | undefined = banner.found ? banner.rejectFirstLayer : undefined;
  if (banner.found) {
    try {
      const found = (await scanForBanners(page)).filter(isDecisionBanner);
      if (found.length > 0) rejectFirstLayer = found.some((b) => b.has.reject);
    } catch {
      // keep the value from the scenario runner
    }
    details.push(
      rejectFirstLayer === undefined
        ? 'Ablehnen-Option auf der ersten Ebene konnte nicht beurteilt werden.'
        : rejectFirstLayer
          ? 'Eine Ablehnen-Option ist auf der ersten Ebene des Banners vorhanden.'
          : 'Auf der ersten Ebene des Banners gibt es keine Ablehnen-Option.',
    );
  } else {
    details.push('Kein Banner gefunden; Ablehnen-Option nicht prüfbar.');
  }

  let imprintReachable: boolean | undefined;
  let privacyPolicyReachable: boolean | undefined;
  try {
    const links = await scanLegalLinks(page, { hitTest: true });
    const imprint = links.filter((l) => l.kind === 'imprint');
    const privacy = links.filter((l) => l.kind === 'privacy');
    imprintReachable = reachability(imprint);
    privacyPolicyReachable = reachability(privacy);
    details.push(describe('Impressum', imprint), describe('Datenschutz', privacy));
  } catch (e) {
    details.push(
      `Erreichbarkeit von Impressum/Datenschutz konnte nicht geprüft werden: ${(e as Error).message}`,
    );
  }
  return { rejectFirstLayer, imprintReachable, privacyPolicyReachable, details };
}
