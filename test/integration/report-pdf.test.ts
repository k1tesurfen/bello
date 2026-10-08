import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeReportBundle } from '../../src/report/bundle.js';
import { verifyManifest } from '../../src/report/manifest.js';
import { fixtureReport } from '../unit/report.helpers.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'bello-pdf-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('report bundle', { timeout: 60_000 }, () => {
  it('writes json, html, pdf and manifest with matching hash', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(path.join(dir, 'evidence'), { recursive: true });
    await writeFile(path.join(dir, 'evidence/x.txt'), 'x');
    const report = fixtureReport();
    const warnings: string[] = [];
    const res = await writeReportBundle(report, dir, {
      pdf: true,
      onWarning: (m) => warnings.push(m),
    });
    expect(warnings).toEqual([]);
    expect(res.pdfPath).toBeDefined();
    const pdf = await readFile(res.pdfPath!);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await stat(res.htmlPath)).size).toBeGreaterThan(1000);
    const json = JSON.parse(await readFile(res.reportPath, 'utf8'));
    expect(json.manifestHash).toBe(res.manifestSha256);
    expect((await verifyManifest(dir, json.manifestHash)).ok).toBe(true);
  });
});
