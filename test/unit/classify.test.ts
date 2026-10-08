import { describe, expect, it } from 'vitest';
import { Classifier } from '../../src/classify/classifier.js';
import { parseEasyPrivacyDomains, matchDomainSet } from '../../src/classify/easyprivacy.js';
import { matchHostGlob } from '../../src/classify/glob.js';
import { loadVendors, parseVendors } from '../../src/classify/vendors.js';

const EASYPRIVACY_SAMPLE = `[Adblock Plus 1.1]
! Title: EasyPrivacy
||tracker-one.example^
||tracker-two.example^$third-party
||tracker-3p.example^$3p
||with-path.example/track.js
||image-only.example^$image
||wild*.example^
@@||allowed.example^
##.banner
||ending.example^|
`;

const MINI_VENDORS = `
version: 1
vendors:
  - {id: gfonts, name: Google Fonts, country: US, category: fonts, hosts: ["fonts.googleapis.com"], fix: "lokal hosten"}
  - {id: googleapis, name: Google APIs, country: US, category: sonstiges, hosts: ["*.googleapis.com"]}
  - {id: dsvendor, name: DS Tracker, country: DE, category: analyse, hosts: ["*.tracker-one.example"], cookies: ["_ds_*", "IDE@*.ads.example"]}
  - {id: cmp1, name: CMP, country: DE, category: cmp, isCmp: true, hosts: ["*.cmp.example"], cookies: ["cmp_consent"], storageKeys: ["cmp_*"]}
  - {id: adsy, name: Ads, country: US, category: werbung, hosts: ["*.ads.example"], cookies: ["IDE@*.ads.example"]}
`;

async function makeClassifier(): Promise<Classifier> {
  return Classifier.create({
    vendors: parseVendors(MINI_VENDORS),
    easyPrivacyText: EASYPRIVACY_SAMPLE,
    skipExternalData: true,
  });
}

describe('EasyPrivacy parsing', () => {
  it('keeps only plain domain rules (optionally third-party)', () => {
    const set = parseEasyPrivacyDomains(EASYPRIVACY_SAMPLE);
    expect([...set].sort()).toEqual([
      'tracker-3p.example',
      'tracker-one.example',
      'tracker-two.example',
    ]);
  });
  it('matches parent domains', () => {
    const set = parseEasyPrivacyDomains(EASYPRIVACY_SAMPLE);
    expect(matchDomainSet(set, 'a.b.tracker-one.example')).toBe(true);
    expect(matchDomainSet(set, 'tracker-one.example')).toBe(true);
    expect(matchDomainSet(set, 'nottracker-one.example')).toBe(false);
  });
});

describe('host globs', () => {
  it('handles wildcard and apex', () => {
    expect(matchHostGlob('*.doubleclick.net', 'ad.doubleclick.net')).toBe(true);
    expect(matchHostGlob('*.doubleclick.net', 'doubleclick.net')).toBe(true);
    expect(matchHostGlob('*.doubleclick.net', 'xdoubleclick.net')).toBe(false);
    expect(matchHostGlob('cdn.example.com', 'cdn.example.com')).toBe(true);
    expect(matchHostGlob('cdn.example.com', 'a.cdn.example.com')).toBe(false);
  });
});

describe('classifyHost stage order', () => {
  const ctx = { site: 'https://www.kunde.de/' };

  it('first party by registrable domain', async () => {
    const c = await makeClassifier();
    const r = c.classifyHost('static.kunde.de', ctx);
    expect(r.stage).toBe('first-party');
    expect(r.firstParty).toBe(true);
    expect(r.registrableDomain).toBe('kunde.de');
  });

  it('first party aliases incl. subdomains', async () => {
    const c = await makeClassifier();
    const withAlias = { ...ctx, firstPartyAliases: ['kunde-cdn.de'] };
    expect(c.classifyHost('img.kunde-cdn.de', withAlias).stage).toBe('first-party');
    expect(c.classifyHost('img.kunde-cdn.de', ctx).stage).toBe('unbekannt');
    expect(c.classifyHost('evilkunde-cdn.de', withAlias).stage).toBe('unbekannt');
  });

  it('first party beats allowlist and vendors', async () => {
    const c = await makeClassifier();
    const r = c.classifyHost('fonts.gstatic.com', {
      site: 'www.gstatic.com',
      allowedProcessors: [{ host: 'fonts.gstatic.com', reason: 'x' }],
    });
    expect(r.stage).toBe('first-party');
  });

  it('allowlist beats vendors; carries reason and vendor', async () => {
    const c = await makeClassifier();
    const r = c.classifyHost('fonts.googleapis.com', {
      ...ctx,
      allowedProcessors: [{ host: 'fonts.googleapis.com', reason: 'AVV liegt vor' }],
    });
    expect(r.stage).toBe('allowlist');
    expect(r.allowlist).toEqual({ host: 'fonts.googleapis.com', reason: 'AVV liegt vor' });
    expect(r.vendor?.id).toBe('gfonts');
  });

  it('allowlist globs', async () => {
    const c = await makeClassifier();
    const actx = { ...ctx, allowedProcessors: [{ host: '*.partner.example', reason: 'Partner' }] };
    expect(c.classifyHost('api.partner.example', actx).stage).toBe('allowlist');
    expect(c.classifyHost('partner.example', actx).stage).toBe('allowlist');
    expect(c.classifyHost('partner.example.evil.org', actx).stage).toBe('unbekannt');
  });

  it('vendors beat EasyPrivacy; most specific pattern wins', async () => {
    const c = await makeClassifier();
    const r = c.classifyHost('x.tracker-one.example', ctx);
    expect(r.stage).toBe('vendors');
    expect(r.vendor?.id).toBe('dsvendor');
    expect(r.easyPrivacy).toBe(true);
    expect(r.thirdCountry).toBe(false);
    const g = c.classifyHost('fonts.googleapis.com', ctx);
    expect(g.vendor?.id).toBe('gfonts');
    expect(g.vendor?.fix).toBe('lokal hosten');
    expect(g.thirdCountry).toBe(true);
    expect(c.classifyHost('maps.googleapis.com', ctx).vendor?.id).toBe('googleapis');
  });

  it('category default fix when vendor has none', async () => {
    const c = await makeClassifier();
    expect(c.classifyHost('www.ads.example', ctx).vendor?.fix).toMatch(/Einwilligung/);
  });

  it('EasyPrivacy as fallback stage', async () => {
    const c = await makeClassifier();
    const r = c.classifyHost('cdn.tracker-two.example', ctx);
    expect(r.stage).toBe('easyprivacy');
    expect(r.easyPrivacy).toBe(true);
    expect(r.vendor).toBeUndefined();
  });

  it('unknown host; degraded sources recorded', async () => {
    const c = await makeClassifier();
    const r = c.classifyHost('unknown.example.org', { ...ctx, ips: ['93.184.216.34'] });
    expect(r.stage).toBe('unbekannt');
    expect(r.ipInfo).toBeUndefined();
    expect(c.unavailable).toEqual(['dbip-country', 'dbip-asn']);
  });

  it('missing data files do not crash', async () => {
    const c = await Classifier.create({
      vendors: parseVendors(MINI_VENDORS),
      dataDir: '/nonexistent/bello-test-dir',
    });
    expect(c.unavailable.sort()).toEqual(['dbip-asn', 'dbip-country', 'easyprivacy']);
    expect(c.classifyHost('foo.tracker-two.example', ctx).stage).toBe('unbekannt');
  });
});

describe('cookies and storage', () => {
  it('matches tracking cookies by name pattern', async () => {
    const c = await makeClassifier();
    expect(c.matchTrackingCookie('_ds_abc', 'www.kunde.de')?.vendor).toBe('dsvendor');
    expect(c.matchTrackingCookie('session', 'www.kunde.de')).toBeUndefined();
  });
  it('host-restricted patterns need a matching cookie domain', async () => {
    const c = await makeClassifier();
    expect(c.matchTrackingCookie('IDE', '.kunde.de')).toBeUndefined();
    expect(c.matchTrackingCookie('IDE', '.ads.example')?.pattern).toBe('IDE@*.ads.example');
  });
  it('cookie set on a known advertising domain counts as tracking', async () => {
    const c = await makeClassifier();
    expect(c.matchTrackingCookie('whatever', '.sub.ads.example')?.vendor).toBe('adsy');
  });
  it('CMP consent cookies are necessary, not tracking', async () => {
    const c = await makeClassifier();
    expect(c.isCmpConsentCookie('cmp_consent')).toBe(true);
    expect(c.matchTrackingCookie('cmp_consent', '.cmp.example')).toBeUndefined();
    expect(c.isCmpConsentStorageKey('cmp_state')).toBe(true);
    expect(c.matchTrackingStorageKey('cmp_state')).toBeUndefined();
  });
});

describe('built-in vendors.yaml', () => {
  it('validates and has the expected vendors', async () => {
    const vendors = await loadVendors();
    expect(vendors.length).toBeGreaterThanOrEqual(150);
    const ids = new Set(vendors.map((v) => v.id));
    for (const id of [
      'google-fonts',
      'google-analytics',
      'youtube',
      'facebook',
      'usercentrics',
      'ccm19',
      'cookiebot',
      'borlabs-cookie',
    ]) {
      expect(ids.has(id)).toBe(true);
    }
    const known = new Set([
      'werbung',
      'analyse',
      'video',
      'karten',
      'fonts',
      'cdn',
      'zahlung',
      'bot-schutz',
      'social',
      'tag-manager',
      'cmp',
      'chat',
      'sonstiges',
    ]);
    for (const v of vendors) expect(known.has(v.category), `${v.id}: ${v.category}`).toBe(true);
  });

  it('classifies well-known hosts and cookies', async () => {
    const c = await Classifier.create({ skipExternalData: true });
    const ctx = { site: 'www.kunde.de' };
    expect(c.classifyHost('fonts.gstatic.com', ctx).vendor?.id).toBe('google-fonts');
    expect(c.classifyHost('www.google-analytics.com', ctx).vendor?.id).toBe('google-analytics');
    expect(c.classifyHost('stats.g.doubleclick.net', ctx).vendor?.id).toBe('google-analytics');
    expect(c.classifyHost('www.youtube.com', ctx).vendor?.category).toBe('video');
    expect(c.classifyHost('app.usercentrics.eu', ctx).vendor?.id).toBe('usercentrics');
    expect(c.matchTrackingCookie('_ga_ABC123', 'kunde.de')?.vendor).toBe('google-analytics');
    expect(c.matchTrackingCookie('_fbp', 'kunde.de')?.vendor).toBe('facebook');
    expect(c.isCmpConsentCookie('CookieConsent')).toBe(true);
    expect(c.isCmpConsentCookie('uc_user_interaction')).toBe(true);
    expect(c.matchTrackingCookie('OptanonConsent', 'kunde.de')).toBeUndefined();
  });

  it('rejects invalid and duplicate vendor files', () => {
    expect(() => parseVendors('vendors: [{id: A, name: x}]')).toThrow(/ungültig/);
    const dup = '{vendors: [{id: a, name: x, category: cdn}, {id: a, name: y, category: cdn}]}';
    expect(() => parseVendors(dup)).toThrow(/doppelte/);
  });
});

describe('DB-IP (only if the dataset is cached locally)', () => {
  it('looks up country and ASN of a public IP', async () => {
    const c = await Classifier.create({ vendors: parseVendors(MINI_VENDORS), easyPrivacyText: '' });
    if (c.unavailable.includes('dbip-country') || c.unavailable.includes('dbip-asn')) return;
    const r = c.classifyHost('dns.google.example', { site: 'www.kunde.de', ips: ['8.8.8.8'] });
    expect(r.stage).toBe('dbip');
    expect(r.ipInfo).toMatchObject({ country: 'US', asn: 15169 });
    expect(r.thirdCountry).toBe(true);
  });
});

describe('Review-Fixes: Globs, private Suffixe, notwendige Cookies', () => {
  it('innere Wildcards überspringen keine Punkte; führendes *. bleibt', () => {
    expect(matchHostGlob('cdn.kunde.de*', 'cdn.kunde.de.evil.com')).toBe(false);
    expect(matchHostGlob('kunde-*.net', 'kunde-x.evil.net')).toBe(false);
    expect(matchHostGlob('kunde-*.net', 'kunde-x.net')).toBe(true);
    expect(matchHostGlob('khms*.google.com', 'khms1.google.com')).toBe(true);
    expect(matchHostGlob('*.b-cdn.net', 'evil-b-cdn.net')).toBe(false);
    expect(matchHostGlob('*.b-cdn.net', 'a.b.b-cdn.net')).toBe(true);
    expect(matchHostGlob('*.b-cdn.net', 'b-cdn.net')).toBe(true);
  });

  it('private Suffixe: tracker.github.io ist nicht First Party von kunde.github.io', async () => {
    const c = await makeClassifier();
    expect(
      c.classifyHost('tracker.github.io', { site: 'https://kunde.github.io/' }).firstParty,
    ).toBe(false);
    expect(
      c.classifyHost('evil.netlify.app', { site: 'https://kunde.netlify.app/' }).firstParty,
    ).toBe(false);
    expect(
      c.classifyHost('cdn.kunde.github.io', { site: 'https://kunde.github.io/' }).firstParty,
    ).toBe(true);
  });

  it('echte vendors.yaml: Nicht-CMP-Cookies sind Tracking, explizit notwendige nicht', async () => {
    const { isTrackingMatch } = await import('../../src/analyze/severity.js');
    const c = await Classifier.create({ skipExternalData: true });
    for (const [name, domain] of [
      ['VISITOR_INFO1_LIVE', '.youtube.com'],
      ['YSC', '.youtube.com'],
      ['NID', '.google.com'],
      ['__Secure-3PSID', '.google.com'],
      ['IDE', '.doubleclick.net'],
    ] as const) {
      const m = c.matchTrackingCookie(name, domain);
      expect(m, name).toBeDefined();
      expect(isTrackingMatch(m), name).toBe(true);
    }
    for (const [name, domain] of [
      ['__cf_bm', '.kunde.de'],
      ['cf_clearance', '.kunde.de'],
      ['__stripe_mid', '.kunde.de'],
    ] as const) {
      const m = c.matchTrackingCookie(name, domain);
      expect(m?.necessary, name).toBe(true);
      expect(isTrackingMatch(m), name).toBe(false);
    }
  });
});
