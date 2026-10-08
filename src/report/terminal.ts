/** Coloured terminal summary (PLAN §10 "Terminal"). */
import pc from 'picocolors';
import { CAUSE_LABEL } from '../analyze/cause.js';
import {
  SCENARIO_IDS,
  SCENARIO_LABEL,
  SEVERITY_ORDER,
  type Finding,
  type ScanReport,
  type Severity,
  type TrafficLight,
} from '../types.js';

export interface TerminalOptions {
  /** Force colours on/off (default: picocolors' detection). */
  color?: boolean;
  /** Max. number of top findings (default 8). */
  topFindings?: number;
}

type Colors = ReturnType<typeof pc.createColors>;

const LIGHT: Record<TrafficLight, { text: string; color: (c: Colors) => (s: string) => string }> = {
  rot: { text: 'ROT', color: (c) => (s) => c.bold(c.red(s)) },
  gelb: { text: 'GELB', color: (c) => (s) => c.bold(c.yellow(s)) },
  gruen: { text: 'GRÜN', color: (c) => (s) => c.bold(c.green(s)) },
};

function sevColor(c: Colors, s: Severity): (x: string) => string {
  switch (s) {
    case 'KRITISCH':
      return (x) => c.bold(c.red(x));
    case 'HOCH':
      return c.red;
    case 'MITTEL':
      return c.yellow;
    default:
      return c.dim;
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function findingLine(f: Finding): string {
  const parts: string[] = [];
  if (f.host) parts.push(f.host);
  if (f.vendor) parts.push(f.vendor);
  if (f.country) parts.push(f.country);
  if (f.causeClass) {
    const snippetLine = f.evidence.find((e) => e.snippet?.line)?.snippet?.line;
    parts.push(`${CAUSE_LABEL[f.causeClass]}${snippetLine ? ` (Zeile ${snippetLine})` : ''}`);
  }
  parts.push(`Szenario ${f.scenarios.join('/')}`);
  return parts.join(' · ');
}

/** Renders the summary as a string (one trailing newline). */
export function renderTerminal(
  report: ScanReport,
  reportPath: string | undefined,
  opts: TerminalOptions = {},
): string {
  const c = pc.createColors(opts.color ?? pc.isColorSupported);
  const out: string[] = [];
  const light = LIGHT[report.trafficLight];
  const label = report.assessment?.label ?? light.text;
  out.push('');
  out.push(c.bold(`Bello – Ergebnis für ${report.url}`));
  if (report.customer) out.push(`Kunde: ${report.customer}`);
  out.push('');
  out.push(`Gesamtampel: ${light.color(c)(`● ${label.toUpperCase()}`)}`);
  for (const r of report.assessment?.reasons ?? []) out.push(`  ${c.dim('–')} ${r}`);
  out.push('');

  // Scenario status.
  out.push(c.bold('Szenarien'));
  for (const page of report.pages) {
    if (report.pages.length > 1) out.push(`  ${page.url}`);
    for (const id of SCENARIO_IDS) {
      const s = page.scenarios.find((x) => x.scenario === id);
      const neutral = report.assessment?.neutralized.find(
        (n) => n.page === page.url && n.scenario === id,
      );
      let status: string;
      if (!s) status = c.red('✗ nicht ausgeführt');
      else if (s.status.state === 'vollstaendig') status = c.green('✓ vollständig');
      else if (neutral) status = c.dim(`– nicht erforderlich (${neutral.reason})`);
      else status = c.yellow(`✗ unvollständig: ${s.status.reason}`);
      out.push(`  ${id} ${pad(SCENARIO_LABEL[id], 18)} ${status}`);
    }
  }
  out.push('');

  // Counts per severity × scenario.
  out.push(c.bold('Befunde je Schweregrad und Szenario'));
  out.push(`  ${pad('', 10)}${SCENARIO_IDS.map((s) => pad(s, 5)).join('')}Gesamt`);
  for (const sev of SEVERITY_ORDER) {
    const list = report.findings.filter((f) => f.severity === sev);
    const per = SCENARIO_IDS.map((s) => list.filter((f) => f.scenarios.includes(s)).length);
    const row = `  ${pad(sev, 10)}${per.map((n) => pad(String(n), 5)).join('')}${list.length}`;
    out.push(list.length > 0 ? sevColor(c, sev)(row) : c.dim(row));
  }
  out.push('');

  const top = report.findings.filter((f) => f.severity !== 'INFO').slice(0, opts.topFindings ?? 8);
  if (top.length > 0) {
    out.push(c.bold('Wichtigste Befunde'));
    for (const f of top) {
      out.push(`  ${sevColor(c, f.severity)(`[${f.severity}]`)} ${f.title}`);
      out.push(`    ${c.dim(findingLine(f))}`);
    }
    const rest = report.findings.filter((f) => f.severity !== 'INFO').length - top.length;
    if (rest > 0) out.push(c.dim(`  … und ${rest} weitere (siehe Report)`));
    out.push('');
  }

  const meta = report.meta;
  const warnings = meta.warnings ?? [];
  if (meta.exitIpCheck?.status === 'nicht-eu' && meta.exitIpCheck.message) {
    out.push(c.yellow(`⚠ ${meta.exitIpCheck.message}`));
  }
  const shown = warnings.filter((w) => w !== meta.exitIpCheck?.message).slice(0, 5);
  if (shown.length > 0) {
    out.push(c.bold('Hinweise'));
    for (const w of shown) out.push(c.yellow(`  ⚠ ${w}`));
    if (warnings.length > shown.length + 1) out.push(c.dim(`  … weitere Hinweise im Report`));
    out.push('');
  }
  if (reportPath) out.push(`Report: ${c.cyan(reportPath)}`);
  out.push(c.dim('Hinweis: Technische Einschätzung, keine Rechtsberatung.'));
  return out.join('\n') + '\n';
}
