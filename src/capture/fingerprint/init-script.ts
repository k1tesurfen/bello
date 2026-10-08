/**
 * Init script (plain JS string, runs in every frame before page scripts) that instruments
 * fingerprinting-relevant APIs. Original results are always returned unchanged.
 * Events are sent to Node through the exposed binding `BINDING`.
 */
export const FP_BINDING_NAME = '__bello_fp_report';

export function buildFingerprintInitScript(binding: string = FP_BINDING_NAME): string {
  return String.raw`(() => {
  'use strict';
  const BINDING = ${JSON.stringify(binding)};
  if (window.__belloFpInstalled) return;
  try { Object.defineProperty(window, '__belloFpInstalled', { value: true, enumerable: false }); } catch (e) { return; }
  const report = window[BINDING];
  const send = (ev) => { try { const p = report(ev); if (p && p.catch) p.catch(() => {}); } catch (e) {} };
  const originals = new WeakMap();
  const MAX_PER_KEY = 300;
  const counts = new Map();
  const preCounts = new Map();
  // Cheap per-api(+detail) cap checked BEFORE the costly new Error().stack capture.
  const PRE_CAP = 40;
  let inside = false;

  const callerUrl = () => {
    try {
      const lines = String(new Error().stack || '').split('\n');
      for (const line of lines) {
        const m = /(https?:\/\/[^\s)]+?|file:\/\/[^\s)]+?):\d+:\d+/.exec(line);
        if (m) return m[1];
      }
    } catch (e) {}
    return undefined;
  };
  const emit = (api, detail, dedupe) => {
    if (inside) return;
    inside = true;
    try {
      const pre = api + '|' + (dedupe ? detail : '');
      const pn = (preCounts.get(pre) || 0) + 1;
      preCounts.set(pre, pn);
      if (pn > (dedupe ? PRE_CAP : MAX_PER_KEY)) return;
      const scriptUrl = callerUrl();
      const key = api + '|' + (scriptUrl || '') + (dedupe ? '|' + detail : '');
      const n = (counts.get(key) || 0) + 1;
      counts.set(key, n);
      if (dedupe ? n > 1 : n > MAX_PER_KEY) return;
      send({ api, timestamp: performance.timeOrigin + performance.now(), callerScriptUrl: scriptUrl, frameUrl: location.href, detail });
    } catch (e) {} finally { inside = false; }
  };

  const mimic = (fn, orig) => {
    try { Object.defineProperty(fn, 'name', { value: orig.name, configurable: true }); } catch (e) {}
    try { Object.defineProperty(fn, 'length', { value: orig.length, configurable: true }); } catch (e) {}
  };
  const wrapFn = (proto, name, api, detailFn, dedupe) => {
    try {
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (!desc || typeof desc.value !== 'function') return;
      const orig = desc.value;
      const wrapper = function () {
        try { emit(api, detailFn ? detailFn.call(this, arguments) : undefined, dedupe); } catch (e) {}
        return orig.apply(this, arguments);
      };
      mimic(wrapper, orig);
      originals.set(wrapper, orig);
      Object.defineProperty(proto, name, { ...desc, value: wrapper });
    } catch (e) {}
  };
  const wrapGetter = (obj, name, api) => {
    try {
      const desc = Object.getOwnPropertyDescriptor(obj, name);
      if (!desc || !desc.get) return;
      const origGet = desc.get;
      const getter = function () {
        try { emit(api, name, true); } catch (e) {}
        return origGet.call(this);
      };
      mimic(getter, origGet);
      originals.set(getter, origGet);
      Object.defineProperty(obj, name, { ...desc, get: getter });
    } catch (e) {}
  };

  // Canvas readback
  if (window.HTMLCanvasElement) {
    wrapFn(HTMLCanvasElement.prototype, 'toDataURL', 'canvas.toDataURL');
    wrapFn(HTMLCanvasElement.prototype, 'toBlob', 'canvas.toBlob');
  }
  if (window.OffscreenCanvas) wrapFn(OffscreenCanvas.prototype, 'convertToBlob', 'canvas.toBlob');
  if (window.CanvasRenderingContext2D) {
    wrapFn(CanvasRenderingContext2D.prototype, 'getImageData', 'canvas.getImageData');
    wrapFn(CanvasRenderingContext2D.prototype, 'measureText', 'font.measureText', function () { try { return this.font; } catch (e) { return undefined; } }, true);
  }

  // WebGL
  const UNMASKED = { 37445: 'UNMASKED_VENDOR_WEBGL', 37446: 'UNMASKED_RENDERER_WEBGL' };
  for (const ctor of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
    const C = window[ctor];
    if (!C) continue;
    wrapFn(C.prototype, 'getParameter', 'webgl.getParameter', (args) => UNMASKED[args[0]] || 'param:' + args[0], true);
    wrapFn(C.prototype, 'getSupportedExtensions', 'webgl.getSupportedExtensions');
  }

  // Audio
  for (const ctor of ['OfflineAudioContext', 'webkitOfflineAudioContext']) {
    const Orig = window[ctor];
    if (!Orig) continue;
    const P = new Proxy(Orig, {
      construct(target, args, newTarget) { try { emit('audio.OfflineAudioContext', undefined); } catch (e) {} return Reflect.construct(target, args, newTarget); },
    });
    try { Object.defineProperty(window, ctor, { value: P, writable: true, configurable: true, enumerable: false }); } catch (e) {}
  }
  if (window.AudioContext) {
    const Orig = window.AudioContext;
    const P = new Proxy(Orig, {
      construct(target, args, newTarget) { try { emit('audio.AudioContext', undefined, true); } catch (e) {} return Reflect.construct(target, args, newTarget); },
    });
    try { Object.defineProperty(window, 'AudioContext', { value: P, writable: true, configurable: true, enumerable: false }); } catch (e) {}
  }
  for (const base of [window.BaseAudioContext, window.OfflineAudioContext && OfflineAudioContext.prototype && Object.getPrototypeOf(OfflineAudioContext.prototype)]) {
    if (!base) continue;
    const proto = base.prototype || base;
    wrapFn(proto, 'createAnalyser', 'audio.createAnalyser', undefined, true);
    wrapFn(proto, 'createOscillator', 'audio.createOscillator', undefined, true);
    wrapFn(proto, 'createDynamicsCompressor', 'audio.createDynamicsCompressor', undefined, true);
  }

  // Navigator
  if (window.Navigator) {
    wrapGetter(Navigator.prototype, 'plugins', 'navigator.plugins');
    wrapGetter(Navigator.prototype, 'mimeTypes', 'navigator.mimeTypes');
    wrapGetter(Navigator.prototype, 'hardwareConcurrency', 'navigator.hardwareConcurrency');
    wrapGetter(Navigator.prototype, 'deviceMemory', 'navigator.deviceMemory');
  }

  // Keep toString plausible.
  try {
    const nativeToString = Function.prototype.toString;
    const patched = function toString() {
      const o = originals.get(this);
      return nativeToString.call(o || this);
    };
    originals.set(patched, nativeToString);
    Function.prototype.toString = patched;
  } catch (e) {}
})();`;
}
