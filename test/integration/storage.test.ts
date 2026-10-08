import { afterAll, beforeAll, expect, it } from 'vitest';
import { collectStorage, type StorageSnapshot } from '../../src/capture/storage/index.js';
import { startFixtureServer, type FixtureServer } from '../fixtures/server.js';
import { openBrowser } from './capture.helpers.js';

let server: FixtureServer;
let cleanup: () => Promise<void>;
let snap: StorageSnapshot;

beforeAll(async () => {
  server = await startFixtureServer({ site: 'cap-storage' });
  const b = await openBrowser(server);
  cleanup = b.cleanup;
  const page = await b.sb.context.newPage();
  await page.goto(server.url('/'), { waitUntil: 'load' });
  await page.waitForTimeout(500);
  snap = await collectStorage(b.sb.context, 'nach-laden', server.url('/'));
});
afterAll(async () => {
  await cleanup?.();
  await server.close();
});

it('sammelt das von GTM gesetzte _ga-Cookie (1st Party, da im Seitenkontext gesetzt)', () => {
  const ga = snap.cookies.find((c) => c.name === '_ga');
  expect(ga, JSON.stringify(snap.cookies)).toBeDefined();
  expect(ga!.firstParty).toBe(true);
  expect(ga!.checkpoint).toBe('nach-laden');
});

it('sammelt localStorage der Hauptseite und des Cross-Origin-iframes', () => {
  const main = snap.storage.find((s) => s.key === '_gtm_key');
  expect(main).toMatchObject({ kind: 'localStorage', valuePreview: 'Länge 6' });
  expect(main!.origin).toBe('http://www.kunde-test.de');
  const fb = snap.storage.find((s) => s.key === 'fb_tracker');
  expect(fb, JSON.stringify(snap.storage)).toBeDefined();
  expect(fb!.origin).toContain('www.facebook.com');
  expect(snap.storage.find((s) => s.key === 'fb_session')?.kind).toBe('sessionStorage');
});
