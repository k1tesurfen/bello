import { describe, expect, it } from 'vitest';
import {
  decodeGcd,
  decodeGcs,
  isAdvancedModePing,
  parseConsentModePing,
} from '../../src/capture/consentmode/index.js';

const DENIED =
  'https://www.google-analytics.com/g/collect?v=2&tid=G-ABC123&gtm=45je5920&_p=1&gcs=G100&gcd=13p3p3p2p5l1&npa=1&dma=0&dma_cps=sypham&en=page_view';
const GRANTED =
  'https://region1.google-analytics.com/g/collect?v=2&tid=G-ABC123&gcs=G111&gcd=13r3r3r2r5l1&dma=0';

describe('parseConsentModePing', () => {
  it('liest gcs/gcd/npa/dma aus einer GA4-URL (verweigert)', () => {
    const p = parseConsentModePing(DENIED, undefined, { time: 12 })!;
    expect(p.gcs).toBe('G100');
    expect(p.npa).toBe('1');
    expect(p.dma).toBe('0');
    expect(p.dmaCps).toBe('sypham');
    expect(p.adStorage).toBe('denied');
    expect(p.analyticsStorage).toBe('denied');
    expect(p.advancedMode).toBe(true);
    expect(p.host).toBe('www.google-analytics.com');
    expect(p.time).toBe(12);
    expect(p.gcdDecoded?.adStorage.state).toBe('denied');
  });

  it('erkennt erteilte Einwilligung', () => {
    const p = parseConsentModePing(GRANTED)!;
    expect(p.adStorage).toBe('granted');
    expect(p.analyticsStorage).toBe('granted');
    expect(p.advancedMode).toBe(false);
    expect(p.gcdDecoded?.adStorage.state).toBe('granted');
  });

  it('G101: nur Analytics erteilt', () => {
    const p = parseConsentModePing('https://stats.g.doubleclick.net/g/collect?gcs=G101')!;
    expect(p.adStorage).toBe('denied');
    expect(p.analyticsStorage).toBe('granted');
    expect(isAdvancedModePing(p)).toBe(true);
  });

  it('akzeptiert google.com/pagead und analytics.google.com, ignoriert andere Hosts', () => {
    expect(
      parseConsentModePing('https://www.google.com/pagead/1p-user-list/1?gcs=G111'),
    ).toBeDefined();
    expect(parseConsentModePing('https://analytics.google.com/g/collect?gcs=G100')).toBeDefined();
    expect(parseConsentModePing('https://www.google.com/search?gcs=G100')).toBeUndefined();
    expect(parseConsentModePing('https://example.org/collect?gcs=G100')).toBeUndefined();
  });

  it('liefert undefined ohne Consent-Mode-Parameter', () => {
    expect(
      parseConsentModePing('https://www.googletagmanager.com/gtm.js?id=GTM-X'),
    ).toBeUndefined();
  });

  it('liest Parameter aus gebatchten POST-Bodies', () => {
    const body = 'en=page_view&dl=https%3A%2F%2Fx.de\nen=scroll&gcs=G100&gcd=13p3p3p2p5l1';
    const p = parseConsentModePing('https://www.google-analytics.com/g/collect?v=2&tid=G-1', body)!;
    expect(p.gcs).toBe('G100');
    expect(p.advancedMode).toBe(true);
  });

  it('gcd mit unbekannten Buchstaben -> unbekannt', () => {
    const d = decodeGcd('13z3t3t2t5l1')!;
    expect(d.adStorage.state).toBe('unbekannt');
    expect(d.analyticsStorage.state).toBe('granted');
  });
});

describe('decode', () => {
  it('decodeGcs', () => {
    expect(decodeGcs('G111')).toEqual({ adStorage: 'granted', analyticsStorage: 'granted' });
    expect(decodeGcs('G100')?.adStorage).toBe('denied');
    expect(decodeGcs('X')).toBeUndefined();
  });
});
