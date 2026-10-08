/**
 * Self-contained German HTML report (PLAN §10). Server-side string templates, all CSS and images
 * inline. EVERY string that originates from the scan (hosts, cookie names, URLs, snippets, …) is
 * untrusted and goes through {@link esc}.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describeTiming, formatMs, scenarioName } from '../analyze/format.js';
import {
  SCENARIO_IDS,
  SCENARIO_LABEL,
  SEVERITY_ORDER,
  type Classification,
  type Finding,
  type PageResult,
  type ScanReport,
  type ScenarioId,
  type ScenarioResult,
  type Severity,
  type TrafficLight,
} from '../types.js';
import { reportCss } from './html/styles.js';

export interface ReportCompany {
  name?: string;
  /** Path to a logo (svg/png/jpg), absolute or relative to the cwd. */
  logo?: string;
  colors?: { primary?: string; [key: string]: string | undefined };
  contact?: string;
}

export interface HtmlOptions {
  company?: ReportCompany | undefined;
  /** Report directory; needed to inline screenshots from `evidence/`. */
  reportDir?: string | undefined;
}

const DEFAULT_PRIMARY = '#0a5';
const MAX_INLINE_BYTES = 4_000_000;

/** HTML-escapes untrusted text (also safe inside attribute values). */
export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"'`]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Accepts only plain CSS colours; anything else falls back (CSS injection guard). */
export function safeColor(c: string | undefined): string {
  const v = (c ?? '').trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(v) || /^[a-zA-Z]{3,20}$/.test(v)) return v;
  if (/^(rgb|hsl)a?\(\s*[\d.,%\s/]+\)$/.test(v)) return v;
  return DEFAULT_PRIMARY;
}

const MIME: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

async function dataUri(file: string): Promise<string | undefined> {
  const mime = MIME[path.extname(file).toLowerCase()];
  if (!mime) return undefined;
  try {
    const buf = await readFile(file);
    if (buf.length > MAX_INLINE_BYTES) return undefined;
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return undefined;
  }
}

const LIGHT: Record<TrafficLight, string> = {
  rot: 'Rot',
  gelb: 'Gelb – manuelle Prüfung nötig',
  gruen: 'Grün',
};

const CATEGORY: Record<string, string> = {
  drittverbindung: 'Drittverbindung',
  'nur-dns': 'Nur DNS-Auflösung',
  cookie: 'Cookie',
  storage: 'Browser-Speicher',
  fingerprinting: 'Fingerprinting',
  'consent-mode': 'Consent Mode',
  banner: 'Banner',
  datenschutzerklaerung: 'Datenschutzerklärung',
  sonstiges: 'Sonstiges',
};

const CAUSE: Record<string, string> = {
  'html-quelltext': 'Im HTML-Quelltext eingebunden',
  'resource-hint': 'Resource-Hint (preconnect/dns-prefetch)',
  'script-vor-cmp': 'Script läuft vor dem CMP',
  'nachgeladen-durch-script': 'Durch Script nachgeladen',
  'nach-ablehnen': 'Nach „Ablehnen“ weiterhin aktiv',
  'consent-mode-advanced': 'Consent Mode (Advanced)',
  'lazy-load-scroll': 'Lazy-Load beim Scrollen',
  unbekannt: 'Unbekannt',
};

const CHECKPOINT: Record<string, string> = {
  'nach-laden': 'nach Laden',
  'nach-klick': 'nach Klick',
  ende: 'Ende',
};

const yn = (v: boolean | undefined): string =>
  v === undefined ? '–' : v ? '<span class="no">ja</span>' : '<span class="yes">nein</span>';

function table(head: string[], rows: string[][]): string {
  if (rows.length === 0) return '';
  return (
    `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>` +
    rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('') +
    '</tbody></table>'
  );
}

function fmtTime(ms: number | undefined): string {
  if (ms === undefined) return '–';
  return `${Math.round(ms).toLocaleString('de-DE')} ms`;
}

// ---------------------------------------------------------------------------------------------

export async function renderHtmlReport(
  report: ScanReport,
  opts: HtmlOptions = {},
): Promise<string> {
  const company = opts.company ?? {};
  const companyName = company.name?.trim() || 'Bello';
  const primary = safeColor(company.colors?.primary);
  const clsByHost = new Map<string, Classification>(report.classifications.map((c) => [c.host, c]));
  const multi = report.pages.length > 1;

  let logoUri: string | undefined;
  if (company.logo) logoUri = await dataUri(path.resolve(company.logo));

  const shots = await collectScreenshots(report, opts.reportDir);

  const parts: string[] = [];
  parts.push(cover(report, companyName, logoUri, company.contact));
  parts.push(summary(report));
  parts.push(findingsSection(report));
  parts.push(timelineSection(report, clsByHost, multi));
  parts.push(comparisonSection(report, clsByHost, multi));
  parts.push(detailsSection(report, multi));
  parts.push(screenshotSection(report, shots, multi));
  parts.push(methodSection(report, companyName));

  return (
    `<!DOCTYPE html>\n<html lang="de"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(`Consent-Prüfbericht ${hostOf(report.url)}`)}</title>` +
    `<style>${reportCss(primary)}</style></head><body><main>\n` +
    parts.join('\n') +
    `\n</main></body></html>\n`
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ---- 1 cover ---------------------------------------------------------------------------------

function cover(
  report: ScanReport,
  name: string,
  logo: string | undefined,
  contact?: string,
): string {
  const date = report.meta.startedAt;
  return (
    `<section class="cover"><div class="brand">` +
    (logo ? `<img src="${esc(logo)}" alt="Logo ${esc(name)}">` : '') +
    `<span class="name">${esc(name)}</span></div>` +
    `<h1>Consent-Prüfbericht</h1>` +
    `<div class="sub">Prüfung der Wirksamkeit des Cookie-Banners (Consent-Management)</div>` +
    `<dl>` +
    (report.customer ? `<dt>Kunde</dt><dd>${esc(report.customer)}</dd>` : '') +
    `<dt>Geprüfte URL</dt><dd>${esc(report.url)}</dd>` +
    `<dt>Datum (UTC)</dt><dd>${esc(formatUtc(date))}</dd>` +
    `<dt>Ergebnis</dt><dd>${esc(report.assessment?.label ?? LIGHT[report.trafficLight])}</dd>` +
    (contact ? `<dt>Kontakt</dt><dd>${esc(contact).replace(/\n/g, '<br>')}</dd>` : '') +
    `</dl></section>`
  );
}

function formatUtc(iso: string | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, ' UTC');
}

// ---- 2 summary -------------------------------------------------------------------------------

function summary(report: ScanReport): string {
  const a = report.assessment;
  const light = report.trafficLight;
  const label = a?.label ?? LIGHT[light];
  const counts: Record<Severity, number> = a?.counts ?? {
    KRITISCH: report.findings.filter((f) => f.severity === 'KRITISCH').length,
    HOCH: report.findings.filter((f) => f.severity === 'HOCH').length,
    MITTEL: report.findings.filter((f) => f.severity === 'MITTEL').length,
    INFO: report.findings.filter((f) => f.severity === 'INFO').length,
  };
  const statements: string[] = [...(a?.reasons ?? [])];
  if (a?.manualReview) {
    statements.push(
      'Mindestens ein Szenario konnte nicht vollständig ausgeführt werden. Das Ergebnis ist daher nicht abschließend; eine manuelle Prüfung ist nötig.',
    );
  }
  const top = report.findings.filter((f) => f.severity === 'KRITISCH').slice(0, 5);
  const chk = report.meta.exitIpCheck;
  return (
    `<h2 class="nobreak">2 Management-Summary</h2>` +
    `<div class="ampel"><span class="dot ${esc(light)}"></span><span class="label">${esc(label)}</span></div>` +
    `<div class="counts">${SEVERITY_ORDER.map(
      (s) => `<div><b>${counts[s]}</b><span class="badge sev-${s}">${s}</span></div>`,
    ).join('')}</div>` +
    (statements.length
      ? `<h3>Kernaussagen</h3><ul>${statements.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`
      : '') +
    (top.length
      ? `<h3>Wichtigste Befunde</h3><ul>${top.map((f) => `<li>${esc(f.title)}</li>`).join('')}</ul>`
      : report.findings.length === 0
        ? '<p>Es wurden keine Befunde festgestellt.</p>'
        : '') +
    (a?.incomplete.length
      ? `<h3>Nicht vollständig ausgeführte Szenarien</h3>` +
        table(
          ['Seite', 'Szenario', 'Grund'],
          a.incomplete.map((i) => [esc(i.page), esc(scenarioName(i.scenario)), esc(i.reason)]),
        )
      : '') +
    (chk && chk.status !== 'ok'
      ? `<div class="warn"><b>Hinweis zum Prüf-Standort:</b> ${esc(chk.message ?? 'Der Standort des Ausgangs-IP konnte nicht bestätigt werden.')}</div>`
      : '')
  );
}

// ---- 3 findings ------------------------------------------------------------------------------

function findingCard(f: Finding, report: ScanReport): string {
  const cls = f.host ? report.classifications.find((c) => c.host === f.host) : undefined;
  const timing = (Object.entries(f.timing ?? {}) as Array<[ScenarioId, number]>)
    .map(([s, t]) => {
      const sc = report.pages.flatMap((p) => p.scenarios).find((x) => x.scenario === s);
      return `${esc(s)}: ${esc(describeTiming(t, sc?.timing, s))}`;
    })
    .join('<br>');
  const snippets = f.evidence.filter((e) => e.snippet?.text);
  const files = f.evidence.filter((e) => e.file).map((e) => e.file as string);
  const country = f.country ?? cls?.vendor?.country ?? cls?.ipInfo?.country;
  return (
    `<div class="finding ${f.severity}" id="f-${esc(f.id)}"><h4><span class="badge sev-${f.severity}">${f.severity}</span> ${esc(f.title)}</h4>` +
    `<p>${esc(f.description)}</p><dl class="meta">` +
    (f.host ? `<dt>Host</dt><dd>${esc(f.host)}</dd>` : '') +
    `<dt>Firma</dt><dd>${esc(f.vendor ?? cls?.vendor?.name ?? 'unbekannt')}</dd>` +
    `<dt>Land</dt><dd>${esc(country ?? 'unbekannt')}${cls?.thirdCountry ? ' (Drittland)' : ''}</dd>` +
    `<dt>Kategorie</dt><dd>${esc(CATEGORY[f.category] ?? f.category)}</dd>` +
    `<dt>Szenario(en)</dt><dd>${esc(f.scenarios.map((s) => `${s} (${SCENARIO_LABEL[s]})`).join(', '))}</dd>` +
    (timing ? `<dt>Zeitpunkt</dt><dd>${timing}</dd>` : '') +
    (f.causeClass ? `<dt>Ursache</dt><dd>${esc(CAUSE[f.causeClass] ?? f.causeClass)}</dd>` : '') +
    (files.length
      ? `<dt>Belege</dt><dd>${files.map((x) => `<code>${esc(x)}</code>`).join('<br>')}</dd>`
      : '') +
    `</dl>` +
    snippets
      .map(
        (e) =>
          `<div class="muted">Quelltext${e.snippet?.line ? ` (Zeile ${esc(e.snippet.line)})` : ''}:</div><pre>${esc(e.snippet?.text)}</pre>`,
      )
      .join('') +
    (f.fix ? `<div class="fix"><b>Empfehlung:</b> ${esc(f.fix)}</div>` : '') +
    `</div>`
  );
}

function findingsSection(report: ScanReport): string {
  let out = `<h2>3 Befunde nach Schweregrad</h2>`;
  if (report.findings.length === 0) return out + '<p>Keine Befunde.</p>';
  for (const sev of SEVERITY_ORDER) {
    const list = report.findings.filter((f) => f.severity === sev);
    if (!list.length) continue;
    out += `<h3><span class="badge sev-${sev}">${sev}</span> ${list.length} Befund${list.length === 1 ? '' : 'e'}</h3>`;
    out += list.map((f) => findingCard(f, report)).join('');
  }
  return out;
}

// ---- 4 timeline ------------------------------------------------------------------------------

function isThird(host: string, cls: Map<string, Classification>): boolean {
  return !(cls.get(host)?.firstParty ?? false);
}

function timelineSvg(s: ScenarioResult, cls: Map<string, Classification>): string {
  const rows = s.connections
    .filter((c) => isThird(c.host, cls))
    .map((c) => ({ c, t: c.firstConnectAt ?? c.firstSeen }))
    .sort((a, b) => a.t - b.t)
    .slice(0, 30);
  if (rows.length === 0) return '<p class="muted">Keine Drittverbindungen.</p>';
  const t = s.timing;
  const marks = [
    t.cmpLoadedAt,
    t.bannerClickAt,
    t.scrollPhaseEndAt,
    t.endAt,
    t.loadAt,
    ...rows.map((r) => r.t),
  ];
  const max = Math.max(1000, ...marks.filter((x): x is number => typeof x === 'number'));
  const min = Math.min(0, ...rows.map((r) => r.t));
  const W = 960;
  const L = 230;
  const rowH = 20;
  const top = 22;
  const H = top + rows.length * rowH + 22;
  const x = (v: number): number => L + ((v - min) / (max - min)) * (W - L - 16);
  let g = '';
  if (t.scrollPhaseStartAt !== undefined) {
    const end = t.scrollPhaseEndAt ?? max;
    g += `<rect x="${x(t.scrollPhaseStartAt).toFixed(1)}" y="${top}" width="${Math.max(2, x(end) - x(t.scrollPhaseStartAt)).toFixed(1)}" height="${rows.length * rowH}" fill="#ddf4ff"/>`;
  }
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    const level = r.c.level;
    const colour = level === 'dns' ? '#8c959f' : level === 'none' ? '#d0d7de' : '#cf222e';
    g += `<text x="${L - 6}" y="${y + 14}" font-size="11" text-anchor="end" fill="#1f2328">${esc(r.c.host.length > 36 ? r.c.host.slice(0, 35) + '…' : r.c.host)}</text>`;
    g += `<line x1="${L}" x2="${W - 16}" y1="${y + rowH - 1}" y2="${y + rowH - 1}" stroke="#eaeef2"/>`;
    g += `<circle cx="${x(r.t).toFixed(1)}" cy="${y + 10}" r="4.5" fill="${colour}"><title>${esc(r.c.host)}: ${esc(formatMs(r.t))} (${esc(level)})</title></circle>`;
  });
  const vline = (v: number | undefined, label: string, colour: string, dy: number): string =>
    v === undefined
      ? ''
      : `<line x1="${x(v).toFixed(1)}" x2="${x(v).toFixed(1)}" y1="${top - 4}" y2="${top + rows.length * rowH}" stroke="${colour}" stroke-width="2"/>` +
        `<text x="${(x(v) + 3).toFixed(1)}" y="${dy}" font-size="10" fill="${colour}">${esc(label)} ${esc(fmtTime(v))}</text>`;
  g += vline(t.cmpLoadedAt, 'CMP geladen', '#8250df', 10);
  g += vline(t.bannerClickAt, 'Klick', '#0969da', 20);
  g += `<text x="${L}" y="${H - 6}" font-size="10" fill="#59636e">${esc(fmtTime(min))}</text><text x="${W - 16}" y="${H - 6}" font-size="10" text-anchor="end" fill="#59636e">${esc(fmtTime(max))} (relativ zum Navigationsstart)</text>`;
  return (
    `<div class="tl"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Zeitleiste">${g}</svg>` +
    `<div class="legend"><span><i style="background:#cf222e"></i>Verbindung (TCP/QUIC/TLS)</span><span><i style="background:#8c959f"></i>nur DNS</span>` +
    `<span><i style="background:#8250df"></i>CMP geladen</span><span><i style="background:#0969da"></i>Klick auf Banner</span><span><i style="background:#ddf4ff;border:1px solid #9cd"></i>Scroll-Phase</span></div></div>`
  );
}

function perPage(
  report: ScanReport,
  multi: boolean,
  render: (p: PageResult, i: number) => string,
): string {
  return report.pages
    .map((p, i) => (multi ? `<h3>Seite: ${esc(p.url)}</h3>` : '') + render(p, i))
    .join('');
}

function timelineSection(
  report: ScanReport,
  cls: Map<string, Classification>,
  multi: boolean,
): string {
  return (
    `<h2>4 Zeitleiste je Szenario</h2>` +
    `<p class="muted">Erster Verbindungsaufbau je Drittanbieter-Host im Verhältnis zu CMP-Initialisierung, Klick und Scroll-Phase.</p>` +
    perPage(report, multi, (p) =>
      p.scenarios
        .map((s) => `<h4>${esc(scenarioName(s.scenario))}</h4>${timelineSvg(s, cls)}`)
        .join(''),
    )
  );
}

// ---- 5 comparison ----------------------------------------------------------------------------

function comparisonSection(
  report: ScanReport,
  cls: Map<string, Classification>,
  multi: boolean,
): string {
  return (
    `<h2>5 Szenario-Vergleich A/B/C</h2>` +
    `<p class="muted">Erster Verbindungszeitpunkt je Drittanbieter-Host und Szenario (A: keine Interaktion, B: alle ablehnen, C: alle akzeptieren). „–“ = keine Verbindung.</p>` +
    perPage(report, multi, (p) => {
      const hosts = new Map<string, Partial<Record<ScenarioId, string>>>();
      for (const s of p.scenarios) {
        for (const c of s.connections) {
          if (!isThird(c.host, cls)) continue;
          const row = hosts.get(c.host) ?? {};
          const t = c.firstConnectAt ?? c.firstSeen;
          row[s.scenario] =
            `${fmtTime(t)}${c.level === 'dns' || c.level === 'none' ? ' (nur DNS)' : ''}`;
          hosts.set(c.host, row);
        }
      }
      const status = p.scenarios
        .filter((s) => s.status.state !== 'vollstaendig')
        .map(
          (s) =>
            `<li>${esc(scenarioName(s.scenario))}: ${esc(s.status.state === 'unvollstaendig' ? s.status.reason : '')}</li>`,
        )
        .join('');
      const rows = [...hosts.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([h, r]) => {
          const c = cls.get(h);
          return [
            esc(h),
            esc(c?.vendor?.name ?? '–'),
            ...SCENARIO_IDS.map((s) =>
              r[s] ? `<b class="${s === 'A' || s === 'B' ? 'yes' : ''}">${esc(r[s])}</b>` : '–',
            ),
          ];
        });
      return (
        (status ? `<div class="warn">Nicht vollständig:<ul>${status}</ul></div>` : '') +
        (rows.length
          ? table(['Host', 'Firma', 'A Keine Interaktion', 'B Ablehnen', 'C Akzeptieren'], rows)
          : '<p>Keine Drittverbindungen in diesem Vergleich.</p>')
      );
    })
  );
}

// ---- 6 details -------------------------------------------------------------------------------

function detailsSection(report: ScanReport, multi: boolean): string {
  const LIMIT = 150;
  return (
    `<h2>6 Cookies, Speicher, Fingerprinting, Consent Mode, Banner und Datenschutzerklärung</h2>` +
    perPage(report, multi, (p) => {
      let out = '';
      for (const s of p.scenarios) {
        out += `<h4>${esc(scenarioName(s.scenario))}</h4>`;
        const consentBanner = s.banner
          ? `Banner: ${s.banner.found ? 'gefunden' : 'nicht gefunden'}${s.banner.cmp ? `, CMP: ${esc(s.banner.cmp)}` : ''}${s.banner.clicked ? `, Klick: ${s.banner.clicked === 'reject' ? 'Ablehnen' : 'Akzeptieren'}` : ''}`
          : '';
        if (consentBanner) out += `<p>${consentBanner}</p>`;
        const cookies = s.cookies.filter((c) => !c.isConsentCookie);
        out += cookies.length
          ? `<p><b>Cookies</b> (${cookies.length})</p>` +
            table(
              ['Name', 'Domain', 'Erstanbieter', 'Zeitpunkt', 'Ablauf', 'Tracking-Muster'],
              cookies
                .slice(0, LIMIT)
                .map((c) => [
                  esc(c.name),
                  esc(c.domain),
                  c.firstParty === undefined ? '–' : c.firstParty ? 'ja' : 'nein',
                  esc(c.checkpoint ? (CHECKPOINT[c.checkpoint] ?? c.checkpoint) : '–'),
                  c.expires > 0
                    ? esc(new Date(c.expires * 1000).toISOString().slice(0, 10))
                    : 'Sitzung',
                  esc(
                    c.trackingMatch ? (c.trackingMatch.vendorName ?? c.trackingMatch.vendor) : '–',
                  ),
                ]),
            ) +
            (cookies.length > LIMIT
              ? `<p class="muted">… ${cookies.length - LIMIT} weitere siehe report.json</p>`
              : '')
          : '<p class="muted">Keine Cookies außer dem Consent-Cookie.</p>';
        const storage = s.storage.filter((c) => !c.isConsentKey);
        if (storage.length)
          out +=
            `<p><b>Browser-Speicher</b> (${storage.length})</p>` +
            table(
              ['Art', 'Ursprung', 'Schlüssel', 'Zeitpunkt', 'Tracking-Muster'],
              storage
                .slice(0, LIMIT)
                .map((c) => [
                  esc(c.kind),
                  esc(c.origin),
                  esc(c.key),
                  esc(CHECKPOINT[c.checkpoint] ?? c.checkpoint),
                  esc(
                    c.trackingMatch ? (c.trackingMatch.vendorName ?? c.trackingMatch.vendor) : '–',
                  ),
                ]),
            );
        if (s.fingerprinting.length)
          out +=
            `<p><b>Fingerprinting-Aufrufe</b> (${s.fingerprinting.length})</p>` +
            table(
              ['API', 'Zeit', 'Script', 'Details'],
              s.fingerprinting
                .slice(0, LIMIT)
                .map((e) => [
                  esc(e.api),
                  esc(fmtTime(e.time)),
                  esc(e.scriptUrl ?? '–'),
                  esc(e.detail ?? ''),
                ]),
            );
        if (s.consentMode.length)
          out +=
            `<p><b>Google Consent Mode</b> (${s.consentMode.length} Ping${s.consentMode.length === 1 ? '' : 's'})</p>` +
            table(
              ['Host', 'Zeit', 'gcs', 'gcd', 'ad_storage', 'analytics_storage', 'Advanced Mode'],
              s.consentMode
                .slice(0, LIMIT)
                .map((m) => [
                  esc(m.host),
                  esc(fmtTime(m.time)),
                  esc(m.gcs ?? '–'),
                  esc(m.gcd ?? '–'),
                  esc(m.adStorage ?? '–'),
                  esc(m.analyticsStorage ?? '–'),
                  m.advancedMode ? '<span class="yes">ja</span>' : 'nein',
                ]),
            );
      }
      const b = p.bannerDesign;
      out += `<h4>Banner-Prüfungen</h4>`;
      out += b
        ? table(
            ['Prüfung', 'Ergebnis'],
            [
              ['„Ablehnen“ auf erster Ebene', yn(b.rejectFirstLayer)],
              ['Impressum erreichbar', yn(b.imprintReachable)],
              ['Datenschutzerklärung erreichbar', yn(b.privacyPolicyReachable)],
            ],
          ) +
          (b.details.length
            ? `<ul>${b.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>`
            : '')
        : '<p class="muted">Nicht geprüft.</p>';
      const pp = p.privacyPolicy;
      out += `<h4>Abgleich mit der Datenschutzerklärung</h4>`;
      if (!pp) out += '<p class="muted">Nicht geprüft.</p>';
      else if (pp.error) out += `<div class="warn">${esc(pp.error)}</div>`;
      else
        out +=
          `<p>${pp.url ? `Quelle: ${esc(pp.url)}` : 'Datenschutzerklärung nicht gefunden.'}</p>` +
          (pp.mentioned.length ? `<p>Genannt: ${esc(pp.mentioned.join(', '))}</p>` : '') +
          (pp.missing.length
            ? `<p><span class="yes">Kontaktiert, aber nicht genannt:</span> ${esc(pp.missing.join(', '))}</p>`
            : '');
      return out;
    })
  );
}

// ---- 7 screenshots ---------------------------------------------------------------------------

type ShotMap = Map<string, string>;

async function collectScreenshots(
  report: ScanReport,
  reportDir: string | undefined,
): Promise<ShotMap> {
  const m: ShotMap = new Map();
  if (!reportDir) return m;
  for (const p of report.pages)
    for (const s of p.scenarios)
      for (const f of s.evidenceFiles) {
        if (!/screenshots\/[^/]+\.(png|jpe?g|webp)$/i.test(f)) continue;
        const abs = path.resolve(reportDir, f);
        if (!abs.startsWith(path.resolve(reportDir) + path.sep)) continue;
        const uri = await dataUri(abs);
        if (uri) m.set(f, uri);
      }
  return m;
}

function screenshotSection(report: ScanReport, shots: ShotMap, multi: boolean): string {
  return (
    `<h2>7 Screenshots</h2>` +
    perPage(report, multi, (p) => {
      const figs = p.scenarios.flatMap((s) =>
        s.evidenceFiles
          .filter((f) => shots.has(f))
          .map(
            (f) =>
              `<figure><img src="${esc(shots.get(f))}" alt="${esc(f)}"><figcaption>${esc(scenarioName(s.scenario))} – ${esc(path.basename(f, path.extname(f)))}</figcaption></figure>`,
          ),
      );
      return figs.length
        ? `<div class="shots">${figs.join('')}</div>`
        : '<p class="muted">Keine Screenshots vorhanden.</p>';
    })
  );
}

// ---- 8 method & metadata ---------------------------------------------------------------------

function methodSection(report: ScanReport, companyName: string): string {
  const m = report.meta;
  const attributions = [
    ...(m.attributions ?? []),
    ...(m.attributions?.some((a) => /DB-IP/i.test(a))
      ? []
      : ['IP-Geolokation: DB-IP.com (CC BY 4.0)']),
    'Tracker-Domainliste: EasyPrivacy (EasyList-Projekt, GPL-3.0/CC BY-SA 3.0)',
  ];
  const kv = (k: string, v: string | undefined): string =>
    v === undefined || v === '' ? '' : `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`;
  return (
    `<h2>8 Methodik, Metadaten und Hinweise</h2>` +
    `<h3>Methodik</h3><ul>` +
    `<li>Drei Szenarien in jeweils frischem Browserprofil (Chromium, Headless): A ohne Interaktion, B „Alle ablehnen“, C „Alle akzeptieren“.</li>` +
    `<li>Ein passiver Leser scrollt die Seite; Banner werden automatisch bedient (Autoconsent bzw. Heuristik).</li>` +
    `<li>Netzwerk wird auf Socket-Ebene (NetLog: DNS, TCP/QUIC, TLS) erfasst und mit Request-Informationen (CDP) korreliert. Bereits der Verbindungsaufbau überträgt die IP-Adresse des Nutzers.</li>` +
    `<li>Zusätzlich: Cookies, localStorage/sessionStorage/IndexedDB, Fingerprinting-APIs, Google Consent Mode, Banner-Gestaltung und Abgleich mit der Datenschutzerklärung.</li>` +
    `<li>Hosts werden anhand Vendor-Liste, EasyPrivacy und IP-Geolokation klassifiziert. Die Szenario-Ergebnisse sind Momentaufnahmen des Prüfzeitpunkts.</li></ul>` +
    `<h3>Scan-Metadaten</h3><table><tbody>` +
    kv('Scan-Start (UTC)', formatUtc(m.startedAt)) +
    kv('Scan-Ende (UTC)', m.finishedAt ? formatUtc(m.finishedAt) : undefined) +
    kv(
      'Ausgangs-IP',
      m.exitIp ? `${m.exitIp}${m.exitCountry ? ` (${m.exitCountry})` : ''}` : undefined,
    ) +
    kv('Standortprüfung', m.exitIpCheck?.message ?? m.exitIpCheck?.status) +
    kv('Bello-Version', m.belloVersion) +
    kv('Chromium-Version', m.chromiumVersion) +
    kv('Konfiguration', m.configPath) +
    kv('Config-Hash (SHA-256)', m.configHash) +
    kv('Proxy', m.proxy) +
    kv('Kommandozeile', m.commandLine.join(' ')) +
    kv('Manifest-Hash (SHA-256 von evidence/manifest.json)', report.manifestHash) +
    `</tbody></table>` +
    (m.warnings?.length
      ? `<h3>Warnungen</h3><ul>${m.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`
      : '') +
    (m.unavailableData?.length
      ? `<div class="warn">Nicht verfügbare Datensätze (Klassifizierung eingeschränkt): ${esc(m.unavailableData.join(', '))}</div>`
      : '') +
    `<h3>Beweissicherung</h3><p>Alle Evidence-Dateien sind in <code>evidence/manifest.json</code> mit SHA-256 erfasst; der Hash des Manifests steht oben. Nachträgliche Änderungen sind damit erkennbar. Der Nachweis ist nicht rechtlich zertifiziert (kein qualifizierter Zeitstempel).</p>` +
    `<h3>Haftungsausschluss</h3><p>${esc(report.disclaimer ?? 'Dieser Bericht ist eine technische Analyse und keine Rechtsberatung.')} Die Bewertung erfolgt automatisiert; Fehlklassifikationen sind möglich.</p>` +
    `<h3>Quellen</h3><ul>${attributions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` +
    `<footer class="end">Erstellt mit Bello ${esc(m.belloVersion)} für ${esc(companyName)}.</footer>`
  );
}
