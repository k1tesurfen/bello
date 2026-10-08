/** Batch overview (PLAN §11): `<outDir>/_batch/<timestamp>/summary.json` + `summary.html`. */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BatchResult, CustomerResult } from '../batch/run.js';
import { reportTimestamp } from '../scan/paths.js';
import { SEVERITY_ORDER, type TrafficLight } from '../types.js';

export const BATCH_DIR = '_batch';

const LIGHT_LABEL: Record<TrafficLight, string> = { gruen: 'Grün', gelb: 'Gelb', rot: 'Rot' };
const LIGHT_COLOR: Record<TrafficLight, string> = {
  gruen: '#1a7f37',
  gelb: '#b08800',
  rot: '#cf222e',
};

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const toPosix = (p: string): string => p.split(path.sep).join('/');

export interface BatchSummaryFiles {
  dir: string;
  jsonPath: string;
  htmlPath: string;
}

function changeText(c: CustomerResult): string {
  const ch = c.change;
  if (!ch) return 'Erster Lauf (kein Vorgänger)';
  const light =
    ch.trafficLight.before === ch.trafficLight.after
      ? `Ampel unverändert (${LIGHT_LABEL[ch.trafficLight.after]})`
      : `Ampel ${LIGHT_LABEL[ch.trafficLight.before]} → ${LIGHT_LABEL[ch.trafficLight.after]}`;
  return `${light}; ${ch.neu} neu, ${ch.behoben} behoben, ${ch.unveraendert} unverändert${ch.geaendert ? `, ${ch.geaendert} Schweregrad geändert` : ''}`;
}

export function renderBatchHtml(
  batch: BatchResult,
  dir: string,
  opts: { companyName?: string } = {},
): string {
  const counts = { gruen: 0, gelb: 0, rot: 0, fehler: 0 };
  for (const c of batch.customers) {
    if (c.status === 'fehler') counts.fehler++;
    else if (c.trafficLight) counts[c.trafficLight]++;
  }
  const rows = batch.customers
    .map((c) => {
      const light =
        c.status === 'fehler' || !c.trafficLight
          ? `<span class="pill" style="background:#57606a">Fehler</span>`
          : `<span class="pill" style="background:${LIGHT_COLOR[c.trafficLight]}">${LIGHT_LABEL[c.trafficLight]}</span>`;
      const sev =
        c.status === 'fehler'
          ? `<span class="err">${escapeHtml(c.error ?? 'Unbekannter Fehler')}</span>`
          : SEVERITY_ORDER.map((s) => `${s}: ${c.severityCounts?.[s] ?? 0}`)
              .map(escapeHtml)
              .join('<br>');
      const links =
        c.reportDir && c.status === 'ok'
          ? ['report.html', 'report.json']
              .map((f) => {
                const rel = toPosix(path.relative(dir, path.join(c.reportDir as string, f)));
                return `<a href="${escapeHtml(rel.split('/').map(encodeURIComponent).join('/'))}">${f}</a>`;
              })
              .join(' · ')
          : '–';
      return `<tr>
<td><strong>${escapeHtml(c.name)}</strong><br><span class="muted">${escapeHtml(c.id)} · ${escapeHtml(c.url)}</span></td>
<td>${light}</td>
<td class="sev">${sev}</td>
<td>${c.pagesScanned ?? '–'}</td>
<td>${c.status === 'ok' ? escapeHtml(changeText(c)) : '–'}</td>
<td>${links}</td>
</tr>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bello – Batch-Übersicht</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:1100px;padding:0 1rem;color:#1f2328}
h1{margin-bottom:.25rem}.muted{color:#656d76;font-size:.85em}
table{border-collapse:collapse;width:100%;margin-top:1.5rem}
th,td{border-bottom:1px solid #d0d7de;padding:.6rem .5rem;text-align:left;vertical-align:top}
th{background:#f6f8fa}.pill{color:#fff;border-radius:1em;padding:.1rem .7rem;font-weight:600}
.sev{font-size:.85em;white-space:nowrap}.err{color:#cf222e}
.sum span{margin-right:1.2rem}
</style>
</head>
<body>
<h1>Batch-Übersicht</h1>
<p class="muted">${opts.companyName ? `${escapeHtml(opts.companyName)} · ` : ''}Start: ${escapeHtml(batch.startedAt)} · Ende: ${escapeHtml(batch.finishedAt)}</p>
<p class="sum"><span>Grün: <strong>${counts.gruen}</strong></span><span>Gelb: <strong>${counts.gelb}</strong></span><span>Rot: <strong>${counts.rot}</strong></span><span>Fehler: <strong>${counts.fehler}</strong></span></p>
<table>
<thead><tr><th>Kunde</th><th>Ampel</th><th>Befunde</th><th>Seiten</th><th>Änderung zum letzten Lauf</th><th>Report</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<p class="muted">Bello liefert technische Befunde und Einschätzungen, keine Rechtsberatung.</p>
</body>
</html>
`;
}

/** Writes the batch summary and returns the paths. */
export async function writeBatchSummary(
  batch: BatchResult,
  opts: { companyName?: string; now?: Date } = {},
): Promise<BatchSummaryFiles> {
  const at = opts.now ?? new Date(batch.startedAt);
  const root = path.join(batch.outDir, BATCH_DIR);
  const base = path.join(root, reportTimestamp(at));
  let dir = base;
  for (let i = 2; existsSync(dir); i++) dir = `${base}-${i}`;
  await mkdir(dir, { recursive: true });
  const jsonPath = path.join(dir, 'summary.json');
  const htmlPath = path.join(dir, 'summary.html');
  const json = {
    schemaVersion: 1,
    startedAt: batch.startedAt,
    finishedAt: batch.finishedAt,
    exitCode: batch.exitCode,
    customers: batch.customers.map((c) => ({
      ...c,
      reportDir: c.reportDir ? toPosix(path.relative(dir, c.reportDir)) : undefined,
      reportPath: c.reportPath ? toPosix(path.relative(dir, c.reportPath)) : undefined,
      change: c.change
        ? {
            ...c.change,
            previousReportDir: toPosix(path.relative(dir, c.change.previousReportDir)),
          }
        : undefined,
    })),
  };
  await writeFile(jsonPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
  await writeFile(htmlPath, renderBatchHtml(batch, dir, opts), 'utf8');
  return { dir, jsonPath, htmlPath };
}
