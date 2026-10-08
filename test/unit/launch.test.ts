import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_TRAFFIC_ARGS,
  buildUserAgent,
  isChromeInternalHost,
} from '../../src/browser/launch.js';
import { BELLO_VERSION } from '../../src/version.js';

describe('launch', () => {
  it('baut einen realistischen Desktop-UA ohne Headless-Kennung', () => {
    const ua = buildUserAgent('156.0.8078.4');
    expect(ua).toMatch(
      /^Mozilla\/5\.0 \(.+\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/156\.0\.0\.0 Safari\/537\.36$/,
    );
    expect(ua).not.toMatch(/headless/i);
    expect(buildUserAgent('156.0.8078.4', true)).toBe(`${ua} Bello/${BELLO_VERSION}`);
  });

  it('unterdrückt Hintergrundverkehr und DoH', () => {
    expect(BACKGROUND_TRAFFIC_ARGS).toContain('--disable-background-networking');
    expect(BACKGROUND_TRAFFIC_ARGS).toContain('--disable-component-update');
    expect(BACKGROUND_TRAFFIC_ARGS).toContain('--no-pings');
    const features = BACKGROUND_TRAFFIC_ARGS.filter((a) => a.startsWith('--disable-features='));
    expect(features).toHaveLength(1); // Chromium only honours the last one
    expect(features[0]).toContain('DnsOverHttps');
    expect(features[0]).toContain('HttpsUpgrades');
  });

  it('kennt Chrome-interne Hosts', () => {
    expect(isChromeInternalHost('update.googleapis.com')).toBe(true);
    expect(isChromeInternalHost('r3---sn-abc.gvt1.com')).toBe(true);
    expect(isChromeInternalHost('www.google-analytics.com')).toBe(false);
  });
});
