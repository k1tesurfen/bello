/** report.json writer (PLAN §10, versioned schema). */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA_VERSION, type ScanReport } from '../types.js';

export const REPORT_JSON = 'report.json';

/** Writes `<reportDir>/report.json` and returns its absolute path. */
export async function writeJsonReport(report: ScanReport, reportDir: string): Promise<string> {
  const file = path.resolve(reportDir, REPORT_JSON);
  await writeFile(file, JSON.stringify(report, null, 2) + '\n', 'utf8');
  return file;
}

/** Reads a report.json (path to the file or its directory) with a German error on problems. */
export async function readJsonReport(fileOrDir: string): Promise<ScanReport> {
  let file = path.resolve(fileOrDir);
  if (!file.endsWith('.json')) file = path.join(file, REPORT_JSON);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new Error(`Report nicht gefunden oder nicht lesbar: ${file}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Report ist kein gültiges JSON: ${file}`);
  }
  const r = data as Partial<ScanReport>;
  if (!r || typeof r !== 'object' || !Array.isArray(r.findings) || !r.trafficLight) {
    throw new Error(`Datei ist kein Bello-Report: ${file}`);
  }
  if (r.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `Report-Schema ${String(r.schemaVersion)} wird nicht unterstützt (erwartet ${SCHEMA_VERSION}): ${file}`,
    );
  }
  return r as ScanReport;
}
