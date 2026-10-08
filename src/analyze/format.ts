/** German formatting helpers for findings. */
import { SCENARIO_LABEL, type ScenarioId, type TimingMarkers } from '../types.js';

/** `38 ms`, `1.250 ms`, `12,3 s`. */
export function formatMs(ms: number): string {
  const v = Math.round(Math.abs(ms));
  if (v < 10_000) return `${v.toLocaleString('de-DE')} ms`;
  return `${(v / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} s`;
}

/** `Szenario A („Keine Interaktion“)`. */
export function scenarioName(s: ScenarioId): string {
  return `Szenario ${s} („${SCENARIO_LABEL[s]}“)`;
}

/** `A, B und C`. */
export function joinGerman(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} und ${items[items.length - 1]}`;
}

const CLICK_LABEL: Record<ScenarioId, string> = {
  A: '',
  B: '„Ablehnen“',
  C: '„Akzeptieren“',
};

/**
 * Timing of an event relative to navigation start, CMP load and banner click, e.g.
 * „38 ms nach Navigationsstart, 412 ms bevor das CMP geladen war“.
 */
export function describeTiming(
  t: number | undefined,
  timing: Partial<TimingMarkers> | undefined,
  scenario: ScenarioId,
): string {
  if (t === undefined) return 'Zeitpunkt unbekannt';
  const parts: string[] = [
    t >= 0 ? `${formatMs(t)} nach Navigationsstart` : `${formatMs(t)} vor Navigationsstart`,
  ];
  const cmp = timing?.cmpLoadedAt;
  if (cmp !== undefined) {
    if (t < cmp) parts.push(`${formatMs(cmp - t)} bevor das CMP geladen war`);
    else parts.push(`${formatMs(t - cmp)} nachdem das CMP geladen war`);
  }
  const click = timing?.bannerClickAt;
  if (click !== undefined && scenario !== 'A') {
    if (t < click) parts.push(`${formatMs(click - t)} vor dem Klick auf ${CLICK_LABEL[scenario]}`);
    else parts.push(`${formatMs(t - click)} nach dem Klick auf ${CLICK_LABEL[scenario]}`);
  }
  return parts.join(', ');
}

/** Collapses whitespace and truncates for snippets / one-line texts. */
export function oneLine(text: string, max = 300): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
