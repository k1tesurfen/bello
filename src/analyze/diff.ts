/**
 * `bello diff` (PLAN §12): new / fixed / unchanged findings between two reports, matched by the
 * stable finding id.
 */
import type { Finding, ScanReport, Severity, TrafficLight } from '../types.js';

export interface FindingChange {
  before: Finding;
  after: Finding;
}

export interface ReportDiff {
  /** In b, not in a. */
  new: Finding[];
  /** In a, not in b. */
  fixed: Finding[];
  /** In both with the same severity. */
  unchanged: Finding[];
  /** In both, severity changed. */
  changed: FindingChange[];
  trafficLight: { before: TrafficLight; after: TrafficLight };
}

export function diffFindings(a: Finding[], b: Finding[]): Omit<ReportDiff, 'trafficLight'> {
  const before = new Map(a.map((f) => [f.id, f]));
  const after = new Map(b.map((f) => [f.id, f]));
  const out: Omit<ReportDiff, 'trafficLight'> = { new: [], fixed: [], unchanged: [], changed: [] };
  for (const f of b) {
    const old = before.get(f.id);
    if (!old) out.new.push(f);
    else if (old.severity !== f.severity) out.changed.push({ before: old, after: f });
    else out.unchanged.push(f);
  }
  for (const f of a) if (!after.has(f.id)) out.fixed.push(f);
  return out;
}

export function diffReports(
  a: Pick<ScanReport, 'findings' | 'trafficLight'>,
  b: Pick<ScanReport, 'findings' | 'trafficLight'>,
): ReportDiff {
  return {
    ...diffFindings(a.findings, b.findings),
    trafficLight: { before: a.trafficLight, after: b.trafficLight },
  };
}

/** Severity counts helper for diff output. */
export function severityCounts(findings: Finding[]): Partial<Record<Severity, number>> {
  const c: Partial<Record<Severity, number>> = {};
  for (const f of findings) c[f.severity] = (c[f.severity] ?? 0) + 1;
  return c;
}
