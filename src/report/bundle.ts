/** Writes the complete report bundle in the order required for tamper evidence (PLAN §10). */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ScanReport } from '../types.js';
import { renderHtmlReport, type ReportCompany } from './html.js';
import { writeJsonReport } from './json.js';
import { writeManifest } from './manifest.js';
import { renderPdf } from './pdf.js';

export interface BundleOptions {
  pdf: boolean;
  company?: ReportCompany;
  /** Called for non-fatal problems (German). */
  onWarning?: (message: string) => void;
}

export interface BundleResult {
  reportPath: string;
  htmlPath: string;
  pdfPath?: string;
  manifestSha256: string;
}

/**
 * Evidence is complete → manifest → hash into the report → report.json / report.html / report.pdf.
 * A failing PDF never loses JSON or HTML.
 */
export async function writeReportBundle(
  report: ScanReport,
  reportDir: string,
  opts: BundleOptions,
): Promise<BundleResult> {
  const manifestSha256 = await writeManifest(reportDir, report.meta);
  report.manifestHash = manifestSha256;
  const reportPath = await writeJsonReport(report, reportDir);
  const htmlPath = path.resolve(reportDir, 'report.html');
  const html = await renderHtmlReport(report, { company: opts.company, reportDir });
  await writeFile(htmlPath, html, 'utf8');
  const result: BundleResult = { reportPath, htmlPath, manifestSha256 };
  if (opts.pdf) {
    const pdfPath = path.resolve(reportDir, 'report.pdf');
    try {
      await renderPdf(htmlPath, pdfPath, {
        footerLabel: `${opts.company?.name ?? 'Bello'} – ${report.url}`,
      });
      result.pdfPath = pdfPath;
    } catch (err) {
      const msg = `${err instanceof Error ? err.message : String(err)} (report.json und report.html wurden geschrieben.)`;
      opts.onWarning?.(msg);
    }
  }
  return result;
}
