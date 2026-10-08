/**
 * Fingerprinting capture and heuristic (PLAN §5.4).
 */
import type { BrowserContext } from 'playwright';
import type { FingerprintApi, FingerprintEvent } from '../../types.js';
import { buildFingerprintInitScript, FP_BINDING_NAME } from './init-script.js';

export { buildFingerprintInitScript, FP_BINDING_NAME } from './init-script.js';

/** Event as reported from the page (absolute timestamp). */
export interface RawFingerprintEvent {
  api: FingerprintApi;
  /** performance.timeOrigin + performance.now() (epoch ms). */
  timestamp: number;
  callerScriptUrl?: string;
  frameUrl?: string;
  /** WebGL parameter name, font, navigator property. */
  detail?: string;
}

/** Minimum number of distinct fonts measured by one script to count as font probing. */
export const FONT_PROBE_MIN_FONTS = 8;
/** Signals that, together with a canvas readback, already indicate fingerprinting. */
export const STRONG_SIGNALS: readonly FingerprintSignal[] = [
  'webgl-unmasked',
  'audio-fingerprint',
  'font-probing',
];
/** Weak signals; `navigator-hardware` (cores/memory) is read by ordinary code and never counts. */
export const WEAK_SIGNALS: readonly FingerprintSignal[] = ['webgl-extensions', 'navigator-plugins'];
/** Without a strong signal, a canvas readback needs at least this many weak signals. */
export const CANVAS_MIN_WEAK_SIGNALS = 2;

export interface FingerprintCapture {
  events(): RawFingerprintEvent[];
}

/** Installs the instrumentation on a context (call before creating pages). */
export async function startFingerprintCapture(
  context: BrowserContext,
): Promise<FingerprintCapture> {
  const events: RawFingerprintEvent[] = [];
  await context.exposeBinding(FP_BINDING_NAME, (_src, ev: unknown) => {
    if (ev && typeof ev === 'object' && typeof (ev as RawFingerprintEvent).api === 'string') {
      events.push(ev as RawFingerprintEvent);
    }
  });
  await context.addInitScript(buildFingerprintInitScript());
  return { events: () => events.slice() };
}

/** Converts raw events to the shared FingerprintEvent model (time relative to navigation start). */
export function toFingerprintEvents(
  raw: RawFingerprintEvent[],
  navigationStart: number,
): FingerprintEvent[] {
  return raw.map((e) => {
    const ev: FingerprintEvent = { api: e.api, time: e.timestamp - navigationStart };
    if (e.frameUrl) ev.frameUrl = e.frameUrl;
    if (e.callerScriptUrl) ev.scriptUrl = e.callerScriptUrl;
    if (e.detail) ev.detail = e.detail;
    return ev;
  });
}

export type FingerprintSignal =
  | 'canvas-readback'
  | 'webgl-unmasked'
  | 'webgl-extensions'
  | 'audio-fingerprint'
  | 'navigator-plugins'
  | 'navigator-hardware'
  | 'font-probing';

export interface ScriptFingerprintVerdict {
  scriptUrl: string;
  signals: FingerprintSignal[];
  apis: string[];
  fontCount: number;
  fingerprinting: boolean;
  /** German explanation. */
  reason: string;
}

interface AnyEvent {
  api: string;
  scriptUrl?: string;
  detail?: string;
}

const UNKNOWN_SCRIPT = '(unbekannt)';

/** Heuristic verdict per script URL. Accepts raw or shared events. */
export function analyzeFingerprinting(
  events: Array<RawFingerprintEvent | FingerprintEvent>,
): ScriptFingerprintVerdict[] {
  const by = new Map<string, AnyEvent[]>();
  for (const e of events) {
    const url =
      ('callerScriptUrl' in e ? e.callerScriptUrl : undefined) ??
      ('scriptUrl' in e ? e.scriptUrl : undefined) ??
      UNKNOWN_SCRIPT;
    const list = by.get(url) ?? [];
    const ev: AnyEvent = { api: e.api, scriptUrl: url };
    if (e.detail) ev.detail = e.detail;
    list.push(ev);
    by.set(url, list);
  }

  const out: ScriptFingerprintVerdict[] = [];
  for (const [scriptUrl, list] of by) {
    const apis = new Set(list.map((e) => e.api));
    const fonts = new Set(list.filter((e) => e.api === 'font.measureText').map((e) => e.detail));
    const has = (a: string): boolean => apis.has(a);
    const signals: FingerprintSignal[] = [];

    const canvas = has('canvas.toDataURL') || has('canvas.toBlob') || has('canvas.getImageData');
    if (canvas) signals.push('canvas-readback');
    if (list.some((e) => e.api === 'webgl.getParameter' && /^UNMASKED_/.test(e.detail ?? ''))) {
      signals.push('webgl-unmasked');
    }
    if (has('webgl.getSupportedExtensions')) signals.push('webgl-extensions');
    if (
      has('audio.OfflineAudioContext') &&
      (has('audio.createOscillator') ||
        has('audio.createAnalyser') ||
        has('audio.createDynamicsCompressor'))
    ) {
      signals.push('audio-fingerprint');
    }
    if (has('navigator.plugins') || has('navigator.mimeTypes')) signals.push('navigator-plugins');
    if (has('navigator.hardwareConcurrency') || has('navigator.deviceMemory')) {
      signals.push('navigator-hardware');
    }
    if (fonts.size >= FONT_PROBE_MIN_FONTS) signals.push('font-probing');

    const others = signals.filter((s) => s !== 'canvas-readback');
    const strong = others.filter((s) => STRONG_SIGNALS.includes(s));
    const weak = others.filter((s) => WEAK_SIGNALS.includes(s));
    const reasons: string[] = [];
    if (canvas && (strong.length >= 1 || weak.length >= CANVAS_MIN_WEAK_SIGNALS)) {
      reasons.push(`Canvas-Auslesen kombiniert mit ${others.join(', ')}`);
    }
    if (signals.includes('webgl-unmasked'))
      reasons.push('WebGL UNMASKED_VENDOR/RENDERER ausgelesen');
    if (signals.includes('audio-fingerprint'))
      reasons.push('Audio-Fingerprint-Muster (OfflineAudioContext)');
    if (signals.includes('font-probing')) {
      reasons.push(`Font-Probing (${fonts.size} verschiedene Schriften vermessen)`);
    }
    out.push({
      scriptUrl,
      signals,
      apis: [...apis].sort(),
      fontCount: fonts.size,
      fingerprinting: reasons.length > 0,
      reason: reasons.join('; '),
    });
  }
  return out;
}
