/**
 * Low-level NetLog reader.
 *
 * Chromium writes the NetLog as
 *   {"constants": {...},
 *   "events": [
 *   {...},
 *   {...},
 *   ],"polledData": {...}}
 * When Chromium crashes or is killed, the file ends somewhere inside the events array. We therefore
 * try a regular JSON.parse first and fall back to a tolerant scanner that recovers every complete
 * event object.
 *
 * Event/source/phase types are numeric and resolved through the file's own `constants` block
 * (the numbering changes between Chromium versions). Times are "tick" milliseconds encoded as
 * strings; `constants.timeTickOffset` converts them to epoch milliseconds.
 */
import { readFile } from 'node:fs/promises';

export type NetLogPhase = 'begin' | 'end' | 'none';

/** One NetLog event with all numeric ids resolved. */
export interface NetLogEvent {
  /** Event type name, e.g. `TCP_CONNECT`. */
  type: string;
  sourceId: number;
  /** Source type name, e.g. `SOCKET`, `URL_REQUEST`. */
  sourceType: string;
  phase: NetLogPhase;
  /** Epoch milliseconds. */
  time: number;
  params: Record<string, unknown>;
}

export interface NetLogConstants {
  logEventTypes: Record<string, number>;
  logSourceType: Record<string, number>;
  logEventPhase: Record<string, number>;
  netError?: Record<string, number>;
  timeTickOffset: string | number;
  [key: string]: unknown;
}

export interface ParsedNetLog {
  constants: NetLogConstants;
  /** Events in file order (which is chronological). */
  events: NetLogEvent[];
  /** Epoch ms = tick ms + timeTickOffset. */
  timeTickOffset: number;
  /** True if the file was incomplete and had to be recovered. */
  truncated: boolean;
  /** Number of events that could not be parsed (excluding a cut-off last event). */
  malformedEvents: number;
}

interface RawEvent {
  type: number;
  time: string | number;
  phase?: number;
  source: { id: number; type: number; start_time?: string };
  params?: Record<string, unknown>;
}

export class NetLogParseError extends Error {
  override name = 'NetLogParseError';
}

function invert(map: Record<string, number>): Map<number, string> {
  const out = new Map<number, string>();
  for (const [k, v] of Object.entries(map)) out.set(v, k);
  return out;
}

/**
 * Extracts complete top-level JSON objects from `text` starting at `start` (just after the `[` of
 * the events array). Stops at the closing `]` or at the end of input.
 */
function scanObjects(text: string, start: number): { objects: string[]; complete: boolean } {
  const objects: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objStart = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === 0x5c /* \ */) escaped = true;
      else if (ch === 0x22 /* " */) inString = false;
      continue;
    }
    if (ch === 0x22) inString = true;
    else if (ch === 0x7b /* { */) {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === 0x7d /* } */) {
      depth--;
      if (depth === 0 && objStart >= 0) {
        objects.push(text.slice(objStart, i + 1));
        objStart = -1;
      }
    } else if (ch === 0x5d /* ] */ && depth === 0) {
      return { objects, complete: true };
    }
  }
  return { objects, complete: false };
}

/** Recovers constants + events from a possibly truncated NetLog text. */
function recover(text: string): {
  constants: unknown;
  raw: RawEvent[];
  truncated: boolean;
  malformed: number;
} {
  const m = /"events"\s*:\s*\[/.exec(text);
  if (!m) throw new NetLogParseError('NetLog-Datei enthält keinen "events"-Block.');
  const eventsKey = m.index;
  // The constants block precedes "events": `{"constants":{...},` → close the outer object.
  const head = text.slice(0, eventsKey).trimEnd().replace(/,$/, '') + '}';
  let constants: unknown;
  try {
    constants = (JSON.parse(head) as { constants?: unknown }).constants;
  } catch {
    throw new NetLogParseError('NetLog-Datei: "constants"-Block ist unvollständig oder ungültig.');
  }
  const { objects, complete } = scanObjects(text, eventsKey + m[0].length);
  const raw: RawEvent[] = [];
  let malformed = 0;
  for (const o of objects) {
    try {
      raw.push(JSON.parse(o) as RawEvent);
    } catch {
      malformed++;
    }
  }
  return { constants, raw, truncated: !complete, malformed };
}

function isConstants(c: unknown): c is NetLogConstants {
  if (!c || typeof c !== 'object') return false;
  const o = c as Record<string, unknown>;
  return (
    typeof o.logEventTypes === 'object' &&
    typeof o.logSourceType === 'object' &&
    typeof o.logEventPhase === 'object'
  );
}

/** Parses NetLog JSON text (complete or truncated). */
export function parseNetLog(text: string): ParsedNetLog {
  let constants: unknown;
  let raw: RawEvent[];
  let truncated = false;
  let malformed = 0;
  try {
    const doc = JSON.parse(text) as { constants?: unknown; events?: RawEvent[] };
    constants = doc.constants;
    raw = doc.events ?? [];
  } catch {
    ({ constants, raw, truncated, malformed } = recover(text));
  }
  if (!isConstants(constants)) {
    throw new NetLogParseError('NetLog-Datei: "constants"-Block fehlt oder ist unvollständig.');
  }

  const eventNames = invert(constants.logEventTypes);
  const sourceNames = invert(constants.logSourceType);
  const phases = constants.logEventPhase;
  const timeTickOffset = Number(constants.timeTickOffset ?? 0);

  const events: NetLogEvent[] = [];
  for (const e of raw) {
    if (!e || typeof e.type !== 'number' || !e.source) {
      malformed++;
      continue;
    }
    const phase: NetLogPhase =
      e.phase === phases.PHASE_BEGIN ? 'begin' : e.phase === phases.PHASE_END ? 'end' : 'none';
    events.push({
      type: eventNames.get(e.type) ?? `UNKNOWN_${e.type}`,
      sourceId: e.source.id,
      sourceType: sourceNames.get(e.source.type) ?? `UNKNOWN_${e.source.type}`,
      phase,
      time: Number(e.time) + timeTickOffset,
      params: e.params ?? {},
    });
  }
  return { constants, events, timeTickOffset, truncated, malformedEvents: malformed };
}

/** Reads and parses a NetLog file. */
export async function readNetLog(file: string): Promise<ParsedNetLog> {
  return parseNetLog(await readFile(file, 'utf8'));
}

/** Resolves a net error code (e.g. -3) to its name (e.g. `ERR_ABORTED`) using the constants. */
export function netErrorName(code: number, constants?: NetLogConstants): string | undefined {
  if (code === 0) return 'OK';
  const table = constants?.netError;
  if (!table) return undefined;
  for (const [name, value] of Object.entries(table)) if (value === code) return name;
  return undefined;
}
