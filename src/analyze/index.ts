/**
 * Analysis (PLAN §7/§8): findings, severities, cause classes and the overall traffic light.
 *
 * Invariant: the traffic light is only ever `gruen` if every page ran all three scenarios
 * completely (or a scenario was "neutralized" because the site needs no banner at all) and every
 * finding is INFO. A false "Grün" is the worst possible bug.
 */
import {
  SCENARIO_IDS,
  SCENARIO_LABEL,
  SEVERITY_ORDER,
  type Assessment,
  type Classification,
  type Finding,
  type ScenarioId,
  type Severity,
  type TrafficLight,
} from '../types.js';
import { analyzeFingerprinting } from '../capture/fingerprint/index.js';
import {
  allConnections,
  bannerDesignOccurrences,
  connectionOccurrences,
  consentModeOccurrences,
  fingerprintOccurrences,
  mergeOccurrences,
  privacyPolicyOccurrences,
  storageOccurrences,
  type AnalyzePage,
  type AnalyzeScenario,
  type Occurrence,
} from './findings.js';
import { mainDocumentCaptured } from './capture-sanity.js';
import { joinGerman } from './format.js';
import { isCmpVendor, isRealConnection, isTrackingMatch } from './severity.js';

export * from './severity.js';
export * from './cause.js';
export * from './format.js';
export * from './diff.js';
export * from './capture-sanity.js';
export {
  allConnections,
  findingId,
  mergeOccurrences,
  type AnalyzePage,
  type AnalyzeScenario,
  type Occurrence,
} from './findings.js';

export interface AnalyzeInput {
  pages: AnalyzePage[];
  /** Classification per host (all hosts of all scenarios). */
  classify: (host: string) => Classification;
  /**
   * Result of the exit-IP check (`ScanMetadata.exitIpCheck.status`). Only `ok` (EU/EEA exit IP)
   * allows treating "no banner" as "no banner needed": many CMPs show the banner only to EU
   * visitors. Absent = unknown.
   */
  exitIpStatus?: string;
}

export interface AnalyzeResult {
  findings: Finding[];
  trafficLight: TrafficLight;
  assessment: Assessment;
}

export const TRAFFIC_LIGHT_LABEL: Readonly<Record<TrafficLight, string>> = {
  rot: 'Rot',
  gelb: 'Gelb',
  gruen: 'Grün',
};

/** Third-party activity of a page used to judge "no banner" (PLAN §7 "Nicht bedienbarer Banner"). */
export interface ThirdPartyActivity {
  /** Real connections to third-party hosts (not first party, not allowlisted, not CMP). */
  hosts: string[];
  /** Real connections to CMP hosts. */
  cmpHosts: string[];
  /** Tracking cookies / storage keys / fingerprinting scripts. */
  tracking: string[];
}

export function thirdPartyActivity(
  scenarios: AnalyzeScenario[],
  classify: (host: string) => Classification,
): ThirdPartyActivity {
  const hosts = new Set<string>();
  const cmpHosts = new Set<string>();
  const tracking = new Set<string>();
  for (const s of scenarios) {
    for (const c of allConnections(s)) {
      if (!isRealConnection(c, s.requests) && !c.unverified) continue;
      const cls = classify(c.host);
      if (cls.firstParty || cls.allowlist) continue;
      if (isCmpVendor(cls)) cmpHosts.add(c.host);
      else hosts.add(c.host);
    }
    for (const c of s.cookies) {
      if (!c.isConsentCookie && isTrackingMatch(c.trackingMatch)) tracking.add(`Cookie ${c.name}`);
    }
    for (const r of s.storage) {
      if (!r.isConsentKey && isTrackingMatch(r.trackingMatch)) tracking.add(`${r.kind} ${r.key}`);
    }
    for (const v of analyzeFingerprinting(s.fingerprinting)) {
      if (v.fingerprinting) tracking.add(`Fingerprinting ${v.scriptUrl}`);
    }
  }
  return {
    hosts: [...hosts].sort(),
    cmpHosts: [...cmpHosts].sort(),
    tracking: [...tracking].sort(),
  };
}

interface PageStatus {
  incomplete: Assessment['incomplete'];
  neutralized: Assessment['neutralized'];
  occurrences: Occurrence[];
}

/** Scenario completeness of one page, including the "no banner" rules. */
/**
 * Reasons why "no banner found" must not be read as "no banner needed" (German). Empty = the
 * B/C scenarios may be neutralized if there is no third-party activity.
 */
export function noBannerDoubts(page: AnalyzePage, exitIpStatus: string | undefined): string[] {
  const out: string[] = [];
  const cmpScript = page.scenarios.find((s) => s.cmpScriptUrl)?.cmpScriptUrl;
  if (cmpScript) out.push(`ein CMP-Script wurde geladen (${cmpScript})`);
  if (page.scenarios.some((s) => s.cmpLoadedSource === 'autoconsent'))
    out.push('autoconsent hat ein Consent-Management erkannt');
  else if (!cmpScript && page.scenarios.some((s) => s.cmpLoadedSource))
    out.push('ein Consent-Management wurde erkannt');
  if (page.scenarios.some((s) => s.banner?.cmp)) out.push('ein CMP wurde erkannt');
  if (exitIpStatus !== 'ok')
    out.push(
      exitIpStatus === 'nicht-eu'
        ? 'die Exit-IP liegt außerhalb der EU (viele CMPs zeigen den Banner nur EU-Besuchern)'
        : 'der Standort der Exit-IP ist nicht als EU bestätigt (viele CMPs zeigen den Banner nur EU-Besuchern)',
    );
  return out;
}

function pageStatus(
  page: AnalyzePage,
  classify: (host: string) => Classification,
  exitIpStatus: string | undefined,
): PageStatus {
  const incomplete: Assessment['incomplete'] = [];
  const neutralized: Assessment['neutralized'] = [];
  const occurrences: Occurrence[] = [];
  const by = new Map<ScenarioId, AnalyzeScenario>();
  for (const s of page.scenarios) if (!by.has(s.scenario)) by.set(s.scenario, s);
  const A = by.get('A');

  const noBannerAnywhere =
    page.scenarios.length > 0 && page.scenarios.every((s) => !s.banner?.found);
  let neutralize = false;
  if (A && A.status.state === 'vollstaendig' && noBannerAnywhere) {
    const act = thirdPartyActivity(page.scenarios, classify);
    const items = [...act.hosts, ...act.tracking];
    if (items.length > 0) {
      occurrences.push({
        key: 'banner|kein-banner-drittverbindungen',
        severity: 'KRITISCH',
        scenario: 'A',
        page: page.url,
        category: 'banner',
        title: 'Kein Cookie-Banner gefunden, aber Drittverbindungen',
        description:
          `Auf der Seite wurde kein Consent-Banner gefunden, trotzdem fanden einwilligungspflichtige Vorgänge statt: ${joinGerman(items.slice(0, 10))}${items.length > 10 ? ` (und ${items.length - 10} weitere)` : ''}. ` +
          'Ohne Banner kann keine Einwilligung eingeholt werden.',
        fix: 'Consent-Management einführen und alle nicht notwendigen Dienste erst nach Einwilligung laden – oder die Dienste entfernen bzw. selbst hosten.',
        evidence: [{ scenario: 'A' }],
      });
    } else if (act.cmpHosts.length === 0 && noBannerDoubts(page, exitIpStatus).length === 0) {
      neutralize = true;
      occurrences.push({
        key: 'banner|kein-banner-noetig',
        severity: 'INFO',
        scenario: 'A',
        page: page.url,
        category: 'banner',
        title: 'Kein Cookie-Banner gefunden – keine Drittverbindungen',
        description:
          'Es wurde kein Consent-Banner gefunden. In keinem Szenario fanden Verbindungen zu Drittanbietern, Tracking-Speicherungen oder Fingerprinting statt; ein Banner ist daher nicht erforderlich. Die Szenarien „Alle ablehnen“ und „Alle akzeptieren“ entsprechen damit „Keine Interaktion“.',
        evidence: [{ scenario: 'A' }],
      });
    } else {
      const doubts = noBannerDoubts(page, exitIpStatus);
      if (act.cmpHosts.length > 0)
        doubts.unshift(`Verbindungen zu Consent-Managern (${joinGerman(act.cmpHosts)})`);
      occurrences.push({
        key: 'banner|kein-banner-unklar',
        severity: 'INFO',
        scenario: 'A',
        page: page.url,
        category: 'banner',
        title: 'Kein Cookie-Banner gefunden – manuelle Prüfung nötig',
        description:
          `Bello hat keinen Consent-Banner gefunden und keine Drittanbieter-Aktivität festgestellt, kann daraus aber nicht schließen, dass kein Banner nötig ist: ${joinGerman(doubts)}. ` +
          'Die Szenarien „Alle ablehnen“ und „Alle akzeptieren“ bleiben daher unvollständig.',
        evidence: [{ scenario: 'A' }],
      });
    }
  }

  for (const id of SCENARIO_IDS) {
    const s = by.get(id);
    if (!s) {
      incomplete.push({
        page: page.url,
        scenario: id,
        reasonCode: 'nicht-ausgefuehrt',
        reason: `Szenario ${id} („${SCENARIO_LABEL[id]}“) wurde nicht ausgeführt.`,
      });
      continue;
    }
    if (s.status.state === 'unvollstaendig') {
      if (neutralize && s.status.reasonCode === 'banner-nicht-gefunden') {
        neutralized.push({
          page: page.url,
          scenario: id,
          reason:
            'Kein Banner vorhanden und keine Drittanbieter-Aktivität – Szenario nicht erforderlich.',
        });
        continue;
      }
      incomplete.push({
        page: page.url,
        scenario: id,
        reasonCode: s.status.reasonCode,
        reason: s.status.reason,
      });
      continue;
    }
    // Sanity check: a completed scenario without any recorded network activity, or without
    // socket evidence for the main document host, means the capture failed silently – never
    // trust it.
    if (s.connections.length === 0 && s.requests.length === 0) {
      incomplete.push({
        page: page.url,
        scenario: id,
        reasonCode: 'kein-mitschnitt',
        reason: `Szenario ${id}: keine Netzwerkaktivität aufgezeichnet – Mitschnitt unvollständig.`,
      });
      continue;
    }
    const sanity = mainDocumentCaptured(s.connections, [
      s.url,
      ...(s.finalUrl ? [s.finalUrl] : []),
    ]);
    if (!sanity.ok) {
      incomplete.push({
        page: page.url,
        scenario: id,
        reasonCode: 'kein-mitschnitt',
        reason: `Szenario ${id}: ${sanity.reason}`,
      });
    }
  }
  return { incomplete, neutralized, occurrences };
}

/** Traffic light per PLAN §7 (pure function, unit-tested exhaustively). */
export function computeTrafficLight(
  findings: Pick<Finding, 'severity'>[],
  incompleteCount: number,
  pageCount = 1,
): TrafficLight {
  if (findings.some((f) => f.severity === 'KRITISCH')) return 'rot';
  if (incompleteCount > 0 || pageCount === 0) return 'gelb';
  if (findings.some((f) => f.severity !== 'INFO')) return 'gelb';
  return 'gruen';
}

export function countBySeverity(findings: Pick<Finding, 'severity'>[]): Record<Severity, number> {
  const counts = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0])) as Record<Severity, number>;
  for (const f of findings) counts[f.severity]++;
  return counts;
}

export function analyze(input: AnalyzeInput): AnalyzeResult {
  const { classify } = input;
  const occ: Occurrence[] = [];
  const incomplete: Assessment['incomplete'] = [];
  const neutralized: Assessment['neutralized'] = [];
  for (const page of input.pages) {
    const st = pageStatus(page, classify, input.exitIpStatus);
    incomplete.push(...st.incomplete);
    neutralized.push(...st.neutralized);
    occ.push(...st.occurrences);
    for (const s of page.scenarios) {
      occ.push(...connectionOccurrences(page, s, classify));
      occ.push(...storageOccurrences(page, s));
      occ.push(...fingerprintOccurrences(page, s, classify));
      occ.push(...consentModeOccurrences(page, s));
    }
    occ.push(...bannerDesignOccurrences(page));
    occ.push(...privacyPolicyOccurrences(page));
  }
  const findings = mergeOccurrences(occ);
  const trafficLight = computeTrafficLight(findings, incomplete.length, input.pages.length);
  const counts = countBySeverity(findings);
  const manualReview = incomplete.length > 0 || input.pages.length === 0;

  const reasons: string[] = [];
  if (input.pages.length === 0) reasons.push('Es wurde keine Seite geprüft.');
  if (counts.KRITISCH > 0) reasons.push(`${counts.KRITISCH} kritische(r) Befund(e).`);
  if (counts.HOCH > 0) reasons.push(`${counts.HOCH} Befund(e) mit hohem Schweregrad.`);
  if (counts.MITTEL > 0) reasons.push(`${counts.MITTEL} Befund(e) mit mittlerem Schweregrad.`);
  for (const i of incomplete) {
    reasons.push(`Szenario ${i.scenario} unvollständig: ${i.reason}`);
  }
  if (trafficLight === 'gruen') {
    reasons.push(
      'Alle Szenarien vollständig durchgeführt; keine Verbindungen oder Speicherungen vor bzw. ohne Einwilligung festgestellt.',
    );
  }
  let label = TRAFFIC_LIGHT_LABEL[trafficLight];
  if (trafficLight === 'gelb' && manualReview) label = 'Gelb – manuelle Prüfung nötig';
  if (trafficLight === 'rot' && manualReview) label = 'Rot – zusätzlich manuelle Prüfung nötig';

  return {
    findings,
    trafficLight,
    assessment: { trafficLight, label, manualReview, incomplete, neutralized, counts, reasons },
  };
}
