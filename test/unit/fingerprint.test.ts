import { describe, expect, it } from 'vitest';
import {
  analyzeFingerprinting,
  FONT_PROBE_MIN_FONTS,
  type RawFingerprintEvent,
} from '../../src/capture/fingerprint/index.js';

const ev = (api: string, url: string, detail?: string): RawFingerprintEvent => ({
  api,
  timestamp: 1,
  callerScriptUrl: url,
  ...(detail ? { detail } : {}),
});
const verdict = (events: RawFingerprintEvent[], url: string) =>
  analyzeFingerprinting(events).find((v) => v.scriptUrl === url)!;

describe('analyzeFingerprinting', () => {
  it('Canvas-Readback allein ist kein Fingerprinting', () => {
    expect(verdict([ev('canvas.toDataURL', 'a.js')], 'a.js').fingerprinting).toBe(false);
  });
  it('Canvas-Readback + hardwareConcurrency/deviceMemory ist kein Fingerprinting', () => {
    const v = verdict(
      [
        ev('canvas.toDataURL', 'a.js'),
        ev('navigator.hardwareConcurrency', 'a.js'),
        ev('navigator.deviceMemory', 'a.js'),
      ],
      'a.js',
    );
    expect(v.fingerprinting).toBe(false);
  });
  it('Canvas-Readback + ein schwaches Signal reicht nicht, zwei schon', () => {
    const one = verdict([ev('canvas.toDataURL', 'a.js'), ev('navigator.plugins', 'a.js')], 'a.js');
    expect(one.fingerprinting).toBe(false);
    const two = verdict(
      [
        ev('canvas.toDataURL', 'a.js'),
        ev('navigator.plugins', 'a.js'),
        ev('webgl.getSupportedExtensions', 'a.js'),
      ],
      'a.js',
    );
    expect(two.fingerprinting).toBe(true);
    expect(two.signals).toContain('canvas-readback');
  });
  it('WebGL UNMASKED_RENDERER', () => {
    expect(
      verdict([ev('webgl.getParameter', 'b.js', 'UNMASKED_RENDERER_WEBGL')], 'b.js').fingerprinting,
    ).toBe(true);
    expect(verdict([ev('webgl.getParameter', 'c.js', 'param:3379')], 'c.js').fingerprinting).toBe(
      false,
    );
  });
  it('Audio-Muster', () => {
    const v = verdict(
      [ev('audio.OfflineAudioContext', 'd.js'), ev('audio.createOscillator', 'd.js')],
      'd.js',
    );
    expect(v.fingerprinting).toBe(true);
  });
  it('Font-Probing nur ab Schwellwert verschiedener Fonts', () => {
    const many = Array.from({ length: FONT_PROBE_MIN_FONTS }, (_, i) =>
      ev('font.measureText', 'e.js', `12px Font${i}`),
    );
    expect(verdict(many, 'e.js').fingerprinting).toBe(true);
    expect(verdict(many.slice(1), 'e.js').fingerprinting).toBe(false);
  });
  it('gruppiert pro Script', () => {
    const r = analyzeFingerprinting([
      ev('canvas.toDataURL', 'a.js'),
      ev('navigator.plugins', 'b.js'),
    ]);
    expect(r.map((x) => x.scriptUrl).sort()).toEqual(['a.js', 'b.js']);
  });
});
