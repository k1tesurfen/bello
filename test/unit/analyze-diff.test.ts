import { describe, expect, it } from 'vitest';
import { diffReports } from '../../src/analyze/diff.js';
import type { Finding } from '../../src/types.js';

const f = (id: string, severity: Finding['severity'] = 'HOCH'): Finding => ({
  id,
  severity,
  scenarios: ['A'],
  category: 'drittverbindung',
  title: id,
  description: '',
  evidence: [],
});

describe('diffReports', () => {
  it('neu / behoben / unverändert / geändert', () => {
    const d = diffReports(
      { trafficLight: 'rot', findings: [f('a'), f('b'), f('c', 'KRITISCH')] },
      { trafficLight: 'gelb', findings: [f('b'), f('c', 'MITTEL'), f('d')] },
    );
    expect(d.new.map((x) => x.id)).toEqual(['d']);
    expect(d.fixed.map((x) => x.id)).toEqual(['a']);
    expect(d.unchanged.map((x) => x.id)).toEqual(['b']);
    expect(d.changed.map((x) => [x.before.severity, x.after.severity])).toEqual([
      ['KRITISCH', 'MITTEL'],
    ]);
    expect(d.trafficLight).toEqual({ before: 'rot', after: 'gelb' });
  });
});
