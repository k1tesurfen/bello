/**
 * Builds findings (PLAN §7/§8) from scenario results and merges them across scenarios and pages:
 * one finding per host (connections) or per issue (cookie, storage key, script, banner check …).
 */
import { createHash } from 'node:crypto';
import {
  SCENARIO_IDS,
  SEVERITY_ORDER,
  type BannerDesignCheck,
  type CauseClass,
  type Classification,
  type CookieRecord,
  type EvidenceRef,
  type Finding,
  type FindingCategory,
  type HostConnection,
  type PrivacyPolicyCheck,
  type ScenarioId,
  type ScenarioResult,
  type Severity,
  type StorageRecord,
} from '../types.js';
import { analyzeFingerprinting } from '../capture/fingerprint/index.js';
import { CAUSE_FIX, CAUSE_LABEL, determineCause } from './cause.js';
import { describeTiming, joinGerman, scenarioName } from './format.js';
import {
  isRealConnection,
  isTrackingMatch,
  rateConnection,
  severityRank,
  type ConnectionRule,
} from './severity.js';

/** Scenario result plus analysis-only inputs. */
export interface AnalyzeScenario extends ScenarioResult {
  /** Raw HTML of the landing page (as delivered by the server). */
  rawHtml?: string;
  /** Final URL of the main document (for matching parser initiators). */
  finalUrl?: string;
  /** CMP script request seen (scenario runner, `cmpScriptLoad`). */
  cmpScriptUrl?: string;
  /** Where the runner's `cmpLoadedAt` came from (`autoconsent` = autoconsent detected a CMP). */
  cmpLoadedSource?: string;
}

export interface AnalyzePage {
  url: string;
  scenarios: AnalyzeScenario[];
  bannerDesign?: BannerDesignCheck;
  privacyPolicy?: PrivacyPolicyCheck;
}

/** One occurrence before merging. */
export interface Occurrence {
  key: string;
  severity: Severity;
  scenario: ScenarioId;
  page: string;
  time?: number;
  category: FindingCategory;
  host?: string;
  vendor?: string;
  country?: string;
  causeClass?: CauseClass;
  title: string;
  description: string;
  fix?: string;
  evidence: EvidenceRef[];
}

export function findingId(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

const MAX_EVIDENCE = 12;

/** Merges occurrences into findings (decisive = most severe, then earliest scenario/time). */
export function mergeOccurrences(occ: Occurrence[]): Finding[] {
  const groups = new Map<string, Occurrence[]>();
  for (const o of occ) {
    const g = groups.get(o.key);
    if (g) g.push(o);
    else groups.set(o.key, [o]);
  }
  const out: Finding[] = [];
  for (const [key, list] of groups) {
    const sorted = [...list].sort(
      (a, b) =>
        severityRank(a.severity) - severityRank(b.severity) ||
        SCENARIO_IDS.indexOf(a.scenario) - SCENARIO_IDS.indexOf(b.scenario) ||
        (a.time ?? Infinity) - (b.time ?? Infinity),
    );
    const d = sorted[0]!;
    const scenarios = SCENARIO_IDS.filter((s) => list.some((o) => o.scenario === s));
    const timing: Partial<Record<ScenarioId, number>> = {};
    for (const o of list) {
      if (o.time === undefined) continue;
      const cur = timing[o.scenario];
      if (cur === undefined || o.time < cur) timing[o.scenario] = o.time;
    }
    const pages = [...new Set(list.map((o) => o.page))];
    let description = d.description;
    const others = scenarios.filter((s) => s !== d.scenario);
    if (others.length > 0) {
      description += ` Ebenfalls festgestellt in ${joinGerman(others.map(scenarioName))}.`;
    }
    if (pages.length > 1) description += ` Betroffene Seiten: ${pages.length}.`;
    const evidence: EvidenceRef[] = [];
    const seen = new Set<string>();
    for (const o of sorted) {
      for (const e of o.evidence) {
        const k = JSON.stringify(e);
        if (seen.has(k) || evidence.length >= MAX_EVIDENCE) continue;
        seen.add(k);
        evidence.push(e);
      }
    }
    const f: Finding = {
      id: findingId(key),
      severity: d.severity,
      scenarios,
      category: d.category,
      title: d.title,
      description,
      evidence,
    };
    if (d.host) f.host = d.host;
    if (d.vendor) f.vendor = d.vendor;
    if (d.country) f.country = d.country;
    if (d.causeClass) f.causeClass = d.causeClass;
    if (d.fix) f.fix = d.fix;
    if (Object.keys(timing).length > 0) f.timing = timing;
    out.push(f);
  }
  return out.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      SCENARIO_IDS.indexOf(a.scenarios[0] ?? 'C') - SCENARIO_IDS.indexOf(b.scenarios[0] ?? 'C') ||
      firstTime(a) - firstTime(b) ||
      a.title.localeCompare(b.title),
  );
}

function firstTime(f: Finding): number {
  const ts = Object.values(f.timing ?? {});
  return ts.length ? Math.min(...ts) : Infinity;
}

function evidenceFile(s: ScenarioResult, name: string): string | undefined {
  return s.evidenceFiles.find((f) => f.endsWith(`/${name}`));
}

function companyText(cls: Classification): string {
  const parts: string[] = [];
  if (cls.vendor) {
    parts.push(`Anbieter: ${cls.vendor.name}`);
    if (cls.vendor.country) {
      parts.push(
        `Sitz: ${cls.vendor.country}${cls.thirdCountry ? ' (Drittland außerhalb EU/EWR)' : ''}`,
      );
    }
  } else {
    parts.push('Anbieter: unbekannt (nicht in den Vendor-Listen)');
  }
  if (cls.ipInfo?.country) {
    parts.push(
      `Server-Standort laut DB-IP: ${cls.ipInfo.country}${cls.ipInfo.asOrg ? ` (${cls.ipInfo.asOrg})` : ''}`,
    );
  }
  return parts.join(', ');
}

function levelText(conn: HostConnection, real: boolean): string {
  if (conn.unverified && !real)
    return 'Die Seite hat eine Anfrage an diesen Host gestartet (CDP), die abgebrochen wurde bzw. fehlschlug; im NetLog fehlt jede Spur davon. Ob die IP-Adresse übertragen wurde, lässt sich weder belegen noch ausschließen – manuelle Prüfung nötig.';
  if (conn.level === 'tls')
    return 'TCP-Verbindung und TLS-Handshake – die IP-Adresse des Besuchers wurde übertragen.';
  if (conn.level === 'connect')
    return conn.quic && !conn.tcp
      ? 'QUIC-Verbindung (HTTP/3) – die IP-Adresse des Besuchers wurde übertragen.'
      : 'TCP-Verbindungsaufbau – die IP-Adresse des Besuchers wurde übertragen.';
  if (real && conn.urlRequests.some((r) => r.headersSent))
    return 'Anfrage wurde über eine bestehende (gebündelte HTTP/2- bzw. QUIC-)Verbindung gesendet – die IP-Adresse des Besuchers wurde übertragen.';
  if (real)
    return 'Anfrage an den Host wurde beantwortet (über eine bestehende bzw. Proxy-Verbindung) – Daten wurden übertragen.';
  if (conn.level === 'dns')
    return 'Nur DNS-Auflösung, keine Verbindung (schwächeres Indiz, keine IP-Übertragung an den Dienst nachgewiesen).';
  return 'Anfrage ohne Verbindungsaufbau (abgebrochen bzw. blockiert).';
}

const RULE_NOTE: Partial<Record<ConnectionRule, string>> = {
  tracker: 'Bekannter Tracker',
  drittland: 'Anbieter mit Sitz bzw. Server in einem Drittland',
  'eu-vendor': 'Bekannter Anbieter in plausibel notwendiger Kategorie, aber ohne Allowlist-Eintrag',
  unbekannt: 'Unbekannter Drittanbieter',
  cmp: 'Consent-Manager, technisch notwendig',
  allowlist: 'Vom Kunden bestätigter Dienst (Allowlist)',
  'nur-c': 'Nur mit Einwilligung (Szenario C) – zur Dokumentation',
  'nur-dns': 'Nur DNS-Auflösung',
  unbestaetigt:
    'Verbindungsversuch ohne Socket-Nachweis (mindestens HOCH, da eine Übertragung nicht ausgeschlossen werden kann)',
};

/** Connection occurrences of one scenario. */
export function connectionOccurrences(
  page: AnalyzePage,
  s: AnalyzeScenario,
  classify: (host: string) => Classification,
): Occurrence[] {
  const out: Occurrence[] = [];
  const netlog = evidenceFile(s, 'netlog.json');
  const pageUrls = [page.url, s.url, ...(s.finalUrl ? [s.finalUrl] : [])];
  for (const conn of allConnections(s)) {
    const cls = classify(conn.host);
    const real = isRealConnection(conn, s.requests);
    const rating = rateConnection(cls, s.scenario, real, conn.unverified === true);
    if (rating.severity === null) continue;
    const time = real ? (conn.firstConnectAt ?? conn.firstSeen) : conn.firstSeen;
    const country = cls.vendor?.country ?? cls.ipInfo?.country;
    const vendorName = cls.vendor?.name;
    let title: string;
    switch (rating.rule) {
      case 'nur-c':
        title = `Verbindung zu ${conn.host} nach Einwilligung`;
        break;
      case 'nur-dns':
        title = `Nur DNS-Auflösung von ${conn.host}`;
        break;
      case 'unbestaetigt':
        title = `Unbestätigter Verbindungsversuch zu ${conn.host} ohne Einwilligung`;
        break;
      case 'allowlist':
        title = `Verbindung zu ${conn.host} (Kunden-Allowlist)`;
        break;
      case 'cmp':
        title = `Verbindung zu ${conn.host} (Consent-Manager)`;
        break;
      default:
        title = `Verbindung zu ${conn.host} ohne Einwilligung`;
    }
    const parts: string[] = [
      `Verbindung zu ${conn.host} ${describeTiming(time, s.timing, s.scenario)} (${scenarioName(s.scenario)}).`,
      levelText(conn, real),
      `${companyText(cls)}.`,
    ];
    const note = RULE_NOTE[rating.rule];
    if (rating.rule === 'allowlist' && cls.allowlist) {
      parts.push(`${note}: ${cls.allowlist.reason}.`);
    } else if (note) {
      parts.push(`Einstufung: ${note}.`);
    }

    const occ: Occurrence = {
      key: `conn|${conn.host}`,
      severity: rating.severity,
      scenario: s.scenario,
      page: page.url,
      category: real ? 'drittverbindung' : 'nur-dns',
      host: conn.host,
      title,
      description: '',
      evidence: [
        {
          scenario: s.scenario,
          ...(netlog ? { file: netlog } : {}),
          pointer: `host:${conn.host}`,
        },
      ],
    };
    if (time !== undefined) occ.time = time;
    if (vendorName) occ.vendor = vendorName;
    if (country) occ.country = country;

    const vendorFix = cls.vendor?.fix;
    if (real && s.scenario !== 'C' && rating.rule !== 'allowlist' && rating.rule !== 'cmp') {
      const cause = determineCause({
        scenario: s.scenario,
        time,
        timing: s.timing,
        causes: conn.causes ?? [],
        wasPreconnectOnly: conn.wasPreconnectOnly,
        ...(s.rawHtml !== undefined ? { rawHtml: s.rawHtml } : {}),
        pageUrls,
        host: conn.host,
      });
      occ.causeClass = cause.causeClass;
      parts.push(`Ursache: ${CAUSE_LABEL[cause.causeClass]}. ${cause.detail}`);
      if (cause.snippet) {
        const raw = evidenceFile(s, 'raw.html');
        occ.evidence.push({
          scenario: s.scenario,
          ...(raw ? { file: raw } : {}),
          snippet: cause.snippet,
        });
      }
      const first = conn.causes?.[0];
      if (first) occ.evidence.push({ scenario: s.scenario, pointer: `request:${first.url}` });
      occ.fix = vendorFix
        ? `${CAUSE_FIX[cause.causeClass]} ${vendorFix}`
        : CAUSE_FIX[cause.causeClass];
    } else if (
      rating.rule === 'eu-vendor' ||
      rating.rule === 'unbekannt' ||
      rating.rule === 'unbestaetigt'
    ) {
      occ.fix = vendorFix ?? CAUSE_FIX.unbekannt;
    }
    if (rating.rule === 'eu-vendor' && !occ.fix?.includes('Allowlist')) {
      occ.fix =
        `${occ.fix ?? ''} Falls der Dienst technisch notwendig ist und ein AVV besteht: als \`allowedProcessors\` in der Kunden-Konfiguration eintragen.`.trim();
    }
    occ.description = parts.join(' ');
    out.push(occ);
  }
  return out;
}

/**
 * NetLog connections plus hosts that only appear in CDP:
 *  - an answered request (e.g. HTTP/2 coalescing or proxy setups where no own socket exists for
 *    the host) → a real connection,
 *  - a request that failed (e.g. `net::ERR_ABORTED`) to a host the NetLog does not know at all →
 *    an *unverified* connection attempt (`unverified: true`). Rated at least HOCH in A/B
 *    (see `rateConnection`), because the NetLog can neither prove nor rule out the transmission.
 *    Requests Chromium blocked before sending (`blockedReason`: CSP, mixed content, …) are
 *    skipped – they provably never left the browser.
 */
export function allConnections(s: ScenarioResult): HostConnection[] {
  const conns = [...s.connections];
  const known = new Set(conns.map((c) => c.host));
  const extra = new Map<string, HostConnection>();
  for (const r of s.requests) {
    if (!r.host || known.has(r.host)) continue;
    if (!/^(https?|wss?):/i.test(r.url)) continue;
    const answered = !r.failed && r.status !== undefined;
    const unverified = !answered && r.failed === true && !r.blockedReason;
    if (!answered && !unverified) continue;
    const prev = extra.get(r.host);
    if (prev && (prev.unverified !== true || unverified)) continue; // answered wins
    extra.set(r.host, {
      host: r.host,
      ports: [],
      remoteIps: r.remoteIp ? [r.remoteIp] : [],
      urlRequests: [],
      wasPreconnectOnly: false,
      sawPreconnect: false,
      firstSeen: r.startTime,
      ...(answered ? { firstConnectAt: r.startTime } : {}),
      level: 'none',
      requested: true,
      ...(unverified ? { unverified: true } : {}),
      causes: [
        {
          requestId: r.id,
          url: r.url,
          initiator: r.initiator,
          resourceType: r.resourceType,
          ...(r.frameUrl ? { frameUrl: r.frameUrl } : {}),
          match: 'url',
        },
      ],
    });
  }
  return [...conns, ...extra.values()];
}

function tooEarly(s: ScenarioId): Severity {
  return s === 'C' ? 'INFO' : 'KRITISCH';
}

/** Tracking cookies / storage (PLAN §5.3). */
export function storageOccurrences(page: AnalyzePage, s: AnalyzeScenario): Occurrence[] {
  const out: Occurrence[] = [];
  const cookiesFile = evidenceFile(s, 'cookies.json');
  const storageFile = evidenceFile(s, 'storage.json');
  const cookieSeen = new Set<string>();
  for (const c of s.cookies as CookieRecord[]) {
    if (c.isConsentCookie || !c.trackingMatch) continue;
    const k = `${c.name}|${c.domain}`;
    if (cookieSeen.has(k)) continue;
    cookieSeen.add(k);
    const m = c.trackingMatch;
    const tracking = isTrackingMatch(m);
    const severity: Severity = tracking ? tooEarly(s.scenario) : 'INFO';
    const vendor = m.vendorName ?? m.vendor;
    const when =
      s.scenario === 'C'
        ? 'nach Einwilligung bzw. bis zum Klick auf „Akzeptieren“'
        : s.scenario === 'B'
          ? 'trotz „Ablehnen“ bzw. vor dem Klick'
          : 'ohne jede Interaktion mit dem Banner';
    out.push({
      key: `cookie|${m.vendor}|${c.name}`,
      severity,
      scenario: s.scenario,
      page: page.url,
      category: 'cookie',
      host: c.domain.replace(/^\./, ''),
      vendor,
      title: tracking
        ? `${s.scenario === 'C' ? 'Tracking-Cookie' : 'Tracking-Cookie ohne Einwilligung'}: ${c.name} (${vendor})`
        : `Cookie ${c.name} (${vendor})`,
      description:
        `Cookie „${c.name}“ (Domain ${c.domain}, ${c.firstParty ? 'First Party' : 'Third Party'}) wurde ${when} gesetzt (${scenarioName(s.scenario)}${c.checkpoint ? `, Zeitpunkt: ${c.checkpoint}` : ''}). ` +
        `Erkannt über Muster „${m.pattern}“ (${vendor}${m.category ? `, Kategorie ${m.category}` : ''}).` +
        (tracking
          ? ' Das Speichern bzw. Auslesen von Informationen auf dem Endgerät ist nach § 25 TDDDG einwilligungspflichtig.'
          : ' Kategorie gilt nicht als Tracking; zur Dokumentation.'),
      ...(tracking && s.scenario !== 'C'
        ? {
            fix: 'Den setzenden Dienst erst nach Einwilligung laden (CMP-Blockierung bzw. Consent-Trigger im Tag-Manager).',
          }
        : {}),
      evidence: [
        {
          scenario: s.scenario,
          ...(cookiesFile ? { file: cookiesFile } : {}),
          pointer: `cookie:${c.name}`,
        },
      ],
    });
  }
  const storageSeen = new Set<string>();
  for (const r of s.storage as StorageRecord[]) {
    if (r.isConsentKey || !r.trackingMatch) continue;
    const k = `${r.kind}|${r.origin}|${r.key}`;
    if (storageSeen.has(k)) continue;
    storageSeen.add(k);
    const m = r.trackingMatch;
    const tracking = isTrackingMatch(m);
    const vendor = m.vendorName ?? m.vendor;
    let host: string | undefined;
    try {
      host = new URL(r.origin).hostname;
    } catch {
      host = undefined;
    }
    out.push({
      key: `storage|${m.vendor}|${r.kind}|${r.key}`,
      severity: tracking ? tooEarly(s.scenario) : 'INFO',
      scenario: s.scenario,
      page: page.url,
      category: 'storage',
      ...(host ? { host } : {}),
      vendor,
      title: tracking
        ? `${s.scenario === 'C' ? 'Tracking-Speicher' : 'Tracking-Speicher ohne Einwilligung'}: ${r.kind} „${r.key}“ (${vendor})`
        : `${r.kind} „${r.key}“ (${vendor})`,
      description:
        `${r.kind}-Eintrag „${r.key}“ (Origin ${r.origin}) wurde in ${scenarioName(s.scenario)} gefunden (Zeitpunkt: ${r.checkpoint}). ` +
        `Erkannt über Muster „${m.pattern}“ (${vendor}).` +
        (tracking ? ' Speichern auf dem Endgerät ohne Einwilligung (§ 25 TDDDG).' : ''),
      ...(tracking && s.scenario !== 'C'
        ? { fix: 'Den speichernden Dienst erst nach Einwilligung laden.' }
        : {}),
      evidence: [
        {
          scenario: s.scenario,
          ...(storageFile ? { file: storageFile } : {}),
          pointer: `${r.kind}:${r.origin}:${r.key}`,
        },
      ],
    });
  }
  return out;
}

function hostOfUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Fingerprinting (PLAN §5.4). */
export function fingerprintOccurrences(
  page: AnalyzePage,
  s: AnalyzeScenario,
  classify: (host: string) => Classification,
): Occurrence[] {
  const file = evidenceFile(s, 'fingerprinting.json');
  const out: Occurrence[] = [];
  for (const v of analyzeFingerprinting(s.fingerprinting)) {
    if (!v.fingerprinting) continue;
    const host = hostOfUrl(v.scriptUrl);
    const cls = host ? classify(host) : undefined;
    const times = s.fingerprinting
      .filter((e) => (e.scriptUrl ?? '(unbekannt)') === v.scriptUrl)
      .map((e) => e.time);
    const time = times.length ? Math.min(...times) : undefined;
    const occ: Occurrence = {
      key: `fp|${v.scriptUrl.split('?')[0]}`,
      severity: tooEarly(s.scenario),
      scenario: s.scenario,
      page: page.url,
      category: 'fingerprinting',
      title: `Fingerprinting durch ${host ?? 'unbekanntes Script'}`,
      description:
        `Das Script ${v.scriptUrl} liest Gerätemerkmale aus (${v.reason}), ${describeTiming(time, s.timing, s.scenario)} (${scenarioName(s.scenario)}). ` +
        'Fingerprinting ist ein Zugriff auf Informationen im Endgerät und ohne Einwilligung unzulässig (§ 25 TDDDG).',
      ...(s.scenario !== 'C'
        ? { fix: 'Script erst nach Einwilligung laden oder Fingerprinting-Funktion deaktivieren.' }
        : {}),
      evidence: [
        { scenario: s.scenario, ...(file ? { file } : {}), pointer: `script:${v.scriptUrl}` },
      ],
    };
    if (host) occ.host = host;
    if (cls?.vendor) occ.vendor = cls.vendor.name;
    const country = cls?.vendor?.country ?? cls?.ipInfo?.country;
    if (country) occ.country = country;
    if (time !== undefined) occ.time = time;
    out.push(occ);
  }
  return out;
}

/** Google Consent Mode "Advanced" pings (PLAN §5.5). */
export function consentModeOccurrences(page: AnalyzePage, s: AnalyzeScenario): Occurrence[] {
  const pings = s.consentMode.filter((p) => p.advancedMode);
  if (pings.length === 0) return [];
  const first = pings.reduce((a, b) => (b.time < a.time ? b : a));
  const hosts = [...new Set(pings.map((p) => p.host))];
  const file = evidenceFile(s, 'consent-mode.json');
  return [
    {
      key: 'consent-mode-advanced',
      severity: s.scenario === 'C' ? 'INFO' : 'HOCH',
      scenario: s.scenario,
      page: page.url,
      time: first.time,
      category: 'consent-mode',
      host: first.host,
      vendor: 'Google',
      causeClass: 'consent-mode-advanced',
      title: 'Google Consent Mode „Advanced“: Pings trotz verweigerter Einwilligung',
      description:
        `${pings.length} Consent-Mode-Ping(s) an ${hosts.join(', ')} mit verweigerter Einwilligung (z. B. gcs=${first.gcs ?? '–'}${first.gcd ? `, gcd=${first.gcd}` : ''}), erster ${describeTiming(first.time, s.timing, s.scenario)} (${scenarioName(s.scenario)}). ` +
        'Im Advanced Mode senden Google-Tags auch ohne Einwilligung („denied“) cookielose Pings – dabei wird die IP-Adresse des Besuchers an Google übertragen.',
      ...(s.scenario !== 'C' ? { fix: CAUSE_FIX['consent-mode-advanced'] } : {}),
      evidence: [{ scenario: s.scenario, ...(file ? { file } : {}), pointer: first.url }],
    },
  ];
}

/** Banner design checks (PLAN §7). */
export function bannerDesignOccurrences(page: AnalyzePage): Occurrence[] {
  const out: Occurrence[] = [];
  const A = page.scenarios.find((s) => s.scenario === 'A');
  const B = page.scenarios.find((s) => s.scenario === 'B');
  const bannerFound = page.scenarios.some((s) => s.banner?.found);
  if (!bannerFound) return out;
  const scenario: ScenarioId = A?.banner?.found ? 'A' : B?.banner?.found ? 'B' : 'C';
  const d = page.bannerDesign;
  const reject =
    B?.banner?.rejectFirstLayer === true
      ? true
      : (d?.rejectFirstLayer ?? B?.banner?.rejectFirstLayer ?? A?.banner?.rejectFirstLayer);
  const shot = A?.evidenceFiles.find((f) => f.endsWith('banner.png'));
  const ev: EvidenceRef[] = [{ scenario, ...(shot ? { file: shot } : {}) }];
  if (reject === false) {
    const second = B?.banner?.secondLayer;
    out.push({
      key: 'banner|kein-ablehnen-erste-ebene',
      severity: 'HOCH',
      scenario,
      page: page.url,
      category: 'banner',
      title: 'Keine Ablehnen-Option auf der ersten Ebene des Banners',
      description:
        'Der Banner bietet auf der ersten Ebene keine Möglichkeit, mit einem Klick abzulehnen, während „Akzeptieren“ mit einem Klick möglich ist (Dark Pattern, vgl. OLG Köln 2022, DSK-Orientierungshilfe).' +
        (second?.tried
          ? second.succeeded
            ? ' Bello hat die Ablehnung über die zweite Ebene durchgeführt.'
            : ' Auch über die zweite Ebene konnte nicht abgelehnt werden.'
          : ''),
      fix: 'Auf der ersten Ebene einen gleichwertigen Button „Alle ablehnen“ bzw. „Nur notwendige“ anbieten.',
      evidence: ev,
    });
  }
  const hidden: string[] = [];
  if (d?.imprintReachable === false) hidden.push('Impressum');
  if (d?.privacyPolicyReachable === false) hidden.push('Datenschutzerklärung');
  if (hidden.length > 0) {
    out.push({
      key: 'banner|rechtstexte-verdeckt',
      severity: 'MITTEL',
      scenario,
      page: page.url,
      category: 'banner',
      title: `Banner verdeckt ${joinGerman(hidden)}`,
      description:
        `Bei geöffnetem Banner ist ${joinGerman(hidden)} nicht erreichbar. ${(d?.details ?? []).join(' ')}`.trim(),
      fix: 'Links zu Impressum und Datenschutzerklärung im Banner anzeigen bzw. die Seite nicht vollständig blockieren.',
      evidence: ev,
    });
  }
  return out;
}

/** Privacy policy comparison (PLAN §5.7). */
export function privacyPolicyOccurrences(page: AnalyzePage): Occurrence[] {
  const p = page.privacyPolicy;
  if (!p) return [];
  const ev: EvidenceRef[] = [{ scenario: 'C', ...(p.file ? { file: p.file } : {}) }];
  if (!p.url || p.error) {
    return [
      {
        key: 'dse|nicht-geprueft',
        severity: 'INFO',
        scenario: 'C',
        page: page.url,
        category: 'datenschutzerklaerung',
        title: p.url
          ? 'Datenschutzerklärung konnte nicht ausgewertet werden'
          : 'Keine Datenschutzerklärung gefunden',
        description:
          (p.error ?? 'Auf der Seite wurde kein Link zur Datenschutzerklärung gefunden.') +
          ' Der Abgleich der kontaktierten Dienste mit der Datenschutzerklärung muss manuell erfolgen.',
        evidence: ev,
      },
    ];
  }
  return p.missing.map((name) => ({
    key: `dse|${name}`,
    severity: 'MITTEL' as const,
    scenario: 'C' as const,
    page: page.url,
    category: 'datenschutzerklaerung' as const,
    vendor: name,
    title: `${name} nicht in der Datenschutzerklärung erwähnt`,
    description: `Die Website hat Verbindungen zu ${name} aufgebaut, die Datenschutzerklärung (${p.url}) erwähnt diesen Dienst aber nicht (weder Name noch bekannte Aliase).`,
    fix: `${name} mit Zweck, Rechtsgrundlage und ggf. Drittlandtransfer in der Datenschutzerklärung aufführen.`,
    evidence: ev,
  }));
}
