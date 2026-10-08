import { describe, expect, it } from 'vitest';
import {
  cmpFromUrl,
  cmpScriptLoad,
  detectBotWall,
  pickInternalLinks,
} from '../../src/scenarios/page-checks.js';
import type { RequestRecord } from '../../src/types.js';

describe('detectBotWall', () => {
  it('erkennt Cloudflare-Challenge am Titel und Header', () => {
    expect(detectBotWall({ status: 403, title: 'Just a moment...' }).botWall).toBe(true);
    expect(detectBotWall({ status: 200, headers: { 'cf-mitigated': 'challenge' } })).toMatchObject({
      botWall: true,
      vendor: 'Cloudflare',
    });
  });
  it('HTTP 403/429 gilt als Bot-Schutz, 503 nur mit WAF-Server', () => {
    expect(detectBotWall({ status: 403 }).botWall).toBe(true);
    expect(detectBotWall({ status: 429 }).botWall).toBe(true);
    expect(detectBotWall({ status: 503 }).botWall).toBe(false);
    expect(detectBotWall({ status: 503, headers: { server: 'cloudflare' } }).botWall).toBe(true);
  });
  it('DataDome/PerimeterX-Merkmale bei Fehlerstatus', () => {
    expect(
      detectBotWall({ status: 405, html: '<script src="https://geo.captcha-delivery.com/x">' }),
    ).toMatchObject({ botWall: true, vendor: 'DataDome' });
  });
  it('normale Seite mit Cloudflare-JS-Detections ist keine Bot-Wall', () => {
    expect(
      detectBotWall({
        status: 200,
        title: 'Startseite – Kunde',
        html: '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>',
      }).botWall,
    ).toBe(false);
    expect(
      detectBotWall({ status: 200, title: 'Kontakt', html: 'Formular mit captcha' }).botWall,
    ).toBe(false);
  });
});

describe('pickInternalLinks', () => {
  const page = 'https://www.kunde.de/';
  it('nur Same-Site, ohne Dateien, Duplikate, Login und aktuelle Seite', () => {
    const links = pickInternalLinks(
      [
        'https://www.kunde.de/#top',
        'https://www.kunde.de/prospekt.pdf',
        'https://extern.de/a',
        'mailto:info@kunde.de',
        'https://www.kunde.de/login',
        'https://shop.kunde.de/produkte',
        'https://shop.kunde.de/produkte#x',
        '/ueber-uns',
        'https://www.kunde.de/kontakt',
      ],
      page,
      2,
    );
    expect(links).toEqual(['https://shop.kunde.de/produkte', 'https://www.kunde.de/ueber-uns']);
  });
  it('max = 0 liefert nichts, ungültige Basis-URL ebenso', () => {
    expect(pickInternalLinks(['/a'], page, 0)).toEqual([]);
    expect(pickInternalLinks(['/a'], 'kein url', 2)).toEqual([]);
  });
});

describe('cmpFromUrl / cmpScriptLoad', () => {
  it('erkennt bekannte CMP-Hosts und -Pfade', () => {
    expect(cmpFromUrl('https://app.usercentrics.eu/browser-ui/latest/loader.js')).toBe(
      'Usercentrics',
    );
    expect(cmpFromUrl('https://consent.cookiebot.com/uc.js')).toBe('Cookiebot');
    expect(cmpFromUrl('https://cdn.cookielaw.org/scripttemplates/otSDKStub.js')).toBe('OneTrust');
    expect(cmpFromUrl('https://www.kunde.de/wp-content/plugins/borlabs-cookie/js/x.js')).toBe(
      'Borlabs Cookie',
    );
    expect(cmpFromUrl('https://www.kunde.de/js/cmp.js')).toBe('CMP');
    expect(cmpFromUrl('https://www.kunde.de/js/cookie-banner.min.js')).toBe('CMP');
    expect(cmpFromUrl('https://www.kunde.de/js/app.js')).toBeUndefined();
    expect(cmpFromUrl('https://www.googletagmanager.com/gtm.js')).toBeUndefined();
  });

  it('nimmt die früheste erfolgreiche CMP-Script-Antwort', () => {
    const req = (id: string, url: string, start: number, end?: number, extra = {}): RequestRecord =>
      ({
        id,
        url,
        host: new URL(url).hostname,
        method: 'GET',
        resourceType: 'Script',
        initiator: { type: 'parser' },
        startTime: start,
        ...(end !== undefined ? { endTime: end } : {}),
        ...extra,
      }) as RequestRecord;
    const r = cmpScriptLoad([
      req('1', 'https://www.kunde.de/js/app.js', 5, 10),
      req('2', 'https://consent.cookiebot.com/uc.js', 50, 120),
      req('3', 'https://www.kunde.de/js/consent.js', 20, 30, { failed: true }),
      req('4', 'https://app.usercentrics.eu/loader.js', 40, 90),
    ]);
    expect(r).toEqual({
      at: 90,
      url: 'https://app.usercentrics.eu/loader.js',
      name: 'Usercentrics',
    });
    expect(cmpScriptLoad([])).toBeUndefined();
  });
});
