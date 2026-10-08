/** PDF rendering of report.html via Playwright Chromium (PLAN §10). */
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { translateStartupError } from '../platform/errors.js';

export interface PdfOptions {
  /** Footer left text (e.g. company name / URL). */
  footerLabel?: string;
  launchArgs?: string[];
}

function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Renders `htmlPath` to an A4 PDF. Throws an Error with a German message on failure. */
export async function renderPdf(
  htmlPath: string,
  pdfPath: string,
  opts: PdfOptions = {},
): Promise<void> {
  let browser;
  try {
    browser = await chromium.launch({ ...(opts.launchArgs ? { args: opts.launchArgs } : {}) });
    const page = await browser.newPage();
    // No network: the report is self-contained.
    await page.route(/^https?:/, (r) => r.abort());
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    const style =
      'font-size:8px;font-family:Arial,sans-serif;color:#666;width:100%;padding:0 15mm;';
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      margin: { top: '18mm', bottom: '18mm', left: '0', right: '0' },
      headerTemplate: '<span></span>',
      footerTemplate:
        `<div style="${style}display:flex;justify-content:space-between">` +
        `<span>${escHtml(opts.footerLabel ?? 'Bello')}</span>` +
        `<span>Seite <span class="pageNumber"></span> von <span class="totalPages"></span></span></div>`,
    });
  } catch (err) {
    const translated = translateStartupError(err);
    throw new Error(
      translated ??
        `PDF-Erzeugung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
