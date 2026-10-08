import { describe, expect, it } from 'vitest';
import { matchVendorsInPolicy } from '../../src/capture/privacypolicy/index.js';

const v = (id: string, name: string, aliases: string[] = []) => ({ id, name, aliases });

describe('matchVendorsInPolicy', () => {
  it('ist case-insensitive und toleriert Bindestrich/Leerzeichen-Varianten', () => {
    const r = matchVendorsInPolicy('Wir nutzen Google-Analytics und Youtube.', [
      v('ga', 'Google Analytics'),
      v('yt', 'YouTube'),
      v('fb', 'Facebook'),
    ]);
    expect(r).toEqual({ mentioned: ['ga', 'yt'], missing: ['fb'] });
  });

  it('behandelt Rechtsformen als optional', () => {
    const text = 'Anbieter ist Google Ireland Limited, Gordon House, Dublin.';
    expect(matchVendorsInPolicy(text, [v('g', 'Google Ireland Limited')]).mentioned).toEqual(['g']);
    expect(
      matchVendorsInPolicy('Meta Platforms Ireland Ltd.', [v('m', 'Meta Platforms Inc.')])
        .mentioned,
    ).toEqual(['m']);
    expect(matchVendorsInPolicy('Hotjar Ltd. Malta', [v('h', 'Hotjar')]).mentioned).toEqual(['h']);
    expect(matchVendorsInPolicy('Die Mapbox GmbH', [v('x', 'Mapbox Inc.')]).mentioned).toEqual([
      'x',
    ]);
  });

  it('respektiert Wortgrenzen', () => {
    const r = matchVendorsInPolicy('Wir nutzen Matomotion und Hotjarring.', [
      v('mm', 'Matomo'),
      v('hj', 'Hotjar'),
    ]);
    expect(r.mentioned).toEqual([]);
    expect(matchVendorsInPolicy('Matomo, Hotjar.', [v('mm', 'Matomo')]).mentioned).toEqual(['mm']);
  });

  it('behandelt Umlaute (ü/ue) und Aliase', () => {
    expect(
      matchVendorsInPolicy('Anbieter: Müller Medien', [v('a', 'Mueller Medien')]).mentioned,
    ).toEqual(['a']);
    expect(
      matchVendorsInPolicy('Anbieter: Mueller Medien', [v('a', 'Müller Medien')]).mentioned,
    ).toEqual(['a']);
    expect(
      matchVendorsInPolicy('Wir nutzen Doubleclick.', [v('d', 'Google Ads', ['DoubleClick'])])
        .mentioned,
    ).toEqual(['d']);
  });

  it('findet Namen über Zeilenumbrüche und Satzzeichen hinweg', () => {
    expect(
      matchVendorsInPolicy('Google\n  Analytics (GA4)', [v('ga', 'Google Analytics')]).mentioned,
    ).toEqual(['ga']);
  });

  it('leerer Text: alles fehlt; ignoriert Zwei-Zeichen-Namen', () => {
    expect(matchVendorsInPolicy('', [v('a', 'Foo Bar')])).toEqual({
      mentioned: [],
      missing: ['a'],
    });
    expect(matchVendorsInPolicy('ab', [v('a', 'AB')]).missing).toEqual(['a']);
  });
});
