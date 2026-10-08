import { afterEach, expect, it } from 'vitest';
import {
  analyzeFingerprinting,
  startFingerprintCapture,
} from '../../src/capture/fingerprint/index.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server.js';
import { openBrowser } from './capture.helpers.js';

let server: FixtureServer | undefined;
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  await server?.close();
});

async function run(site: string) {
  server = await startFixtureServer({ site });
  const b = await openBrowser(server);
  cleanup = b.cleanup;
  const cap = await startFingerprintCapture(b.sb.context);
  const page = await b.sb.context.newPage();
  await page.goto(server.url('/'), { waitUntil: 'load' });
  await page.waitForTimeout(500);
  return cap.events();
}

it('erkennt Canvas-Fingerprinting eines Drittanbieter-Scripts mit korrekter Aufrufer-URL', async () => {
  const events = await run('cap-fingerprint');
  const verdicts = analyzeFingerprinting(events);
  const v = verdicts.find((x) => x.scriptUrl === 'https://unknown-tracker.example/fp.js');
  expect(v, JSON.stringify(events)).toBeDefined();
  expect(v!.fingerprinting).toBe(true);
  expect(v!.signals).toContain('canvas-readback');
  expect(events.every((e) => typeof e.timestamp === 'number' && e.frameUrl)).toBe(true);
});

it('markiert normales Canvas-Zeichnen ohne Readback nicht', async () => {
  const events = await run('cap-canvas-plain');
  expect(analyzeFingerprinting(events).filter((v) => v.fingerprinting)).toEqual([]);
});
