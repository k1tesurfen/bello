import { describe, expect, it } from 'vitest';
import {
  analyze,
  computeTrafficLight,
  determineCause,
  findHostInHtml,
  isRealConnection,
  rateConnection,
  type AnalyzePage,
  type AnalyzeScenario,
} from '../../src/analyze/index.js';
import {
  SCENARIO_IDS,
  SEVERITY_ORDER,
  type Classification,
  type ConnectionCause,
  type ScenarioId,
  type Severity,
} from '../../src/types.js';
import {
  ALLOWLISTED,
  classifier,
  CMP,
  conn,
  EASYPRIVACY,
  EU_ANALYTICS,
  EU_CDN,
  FIRST_PARTY,
  GTM,
  INCOMPLETE,
  page,
  scenario,
  SITE,
  US_CMP,
  YOUTUBE,
} from './analyze.helpers.js';

const cls = (host: string, c: Partial<Classification>): Classification => ({
  host,
  stage: 'unbekannt',
  firstParty: false,
  ...c,
});

const parserCause = (url: string, line: number): ConnectionCause => ({
  requestId: '1',
  url,
  initiator: { type: 'parser', url: 'https://www.kunde-test.de/', line },
  resourceType: 'Document',
  match: 'url',
});
const scriptCause = (url: string, script: string): ConnectionCause => ({
  requestId: '2',
  url,
  initiator: { type: 'script', url: script, stack: [{ url: script, line: 3 }] },
  resourceType: 'Script',
  match: 'url',
});

describe('rateConnection – Schweregrad-Matrix (PLAN §7)', () => {
  const cases: Array<[string, Partial<Classification>, Severity]> = [
    ['bekannter Tracker (Kategorie Tag-Manager, Drittland)', GTM, 'KRITISCH'],
    ['EU-Analyse-Anbieter (Tracker-Kategorie)', EU_ANALYTICS, 'KRITISCH'],
    ['EasyPrivacy-Treffer', EASYPRIVACY, 'KRITISCH'],
    ['Drittland-Vendor in Nicht-Tracking-Kategorie (YouTube)', YOUTUBE, 'KRITISCH'],
    ['EU-Vendor in notwendiger Kategorie (CDN)', EU_CDN, 'MITTEL'],
    ['unbekannter Drittanbieter', {}, 'HOCH'],
    [
      'unbekannter Host mit DB-IP-Treffer im Drittland',
      { stage: 'dbip', thirdCountry: true },
      'HOCH',
    ],
    ['Consent-Manager (EU)', CMP, 'INFO'],
    ['Consent-Manager (Drittland)', US_CMP, 'INFO'],
    ['Kunden-Allowlist', ALLOWLISTED, 'INFO'],
    ['Allowlist schlägt Tracker', { ...GTM, allowlist: { host: 'x', reason: 'r' } }, 'INFO'],
  ];
  for (const [name, c, expected] of cases) {
    for (const s of ['A', 'B'] as ScenarioId[]) {
      it(`${name} in ${s} (echte Verbindung) → ${expected}`, () => {
        expect(rateConnection(cls('h.example', c), s, true).severity).toBe(expected);
      });
    }
    it(`${name} nur DNS in A/B → INFO`, () => {
      expect(rateConnection(cls('h.example', c), 'A', false).severity).toBe('INFO');
      expect(rateConnection(cls('h.example', c), 'B', false).severity).toBe('INFO');
    });
    it(`${name} in C → INFO`, () => {
      expect(rateConnection(cls('h.example', c), 'C', true).severity).toBe('INFO');
    });
  }
  it('First Party ist nie ein Befund', () => {
    for (const s of SCENARIO_IDS) {
      expect(
        rateConnection(
          { host: 'www.kunde-test.de', stage: 'first-party', firstParty: true },
          s,
          true,
        ).severity,
      ).toBeNull();
    }
  });
});

describe('computeTrafficLight – Ampel-Matrix', () => {
  const combos: Severity[][] = [];
  for (let mask = 0; mask < 16; mask++) {
    combos.push(SEVERITY_ORDER.filter((_, i) => mask & (1 << i)));
  }
  for (const sevs of combos) {
    const findings = sevs.map((severity) => ({ severity }));
    const expectComplete: string = sevs.includes('KRITISCH')
      ? 'rot'
      : sevs.some((s) => s === 'HOCH' || s === 'MITTEL')
        ? 'gelb'
        : 'gruen';
    it(`[${sevs.join(',') || 'keine'}] vollständig → ${expectComplete}`, () => {
      expect(computeTrafficLight(findings, 0)).toBe(expectComplete);
    });
    for (const incomplete of [1, 2, 6]) {
      it(`[${sevs.join(',') || 'keine'}] mit ${incomplete} unvollständigen Szenarien → nie grün`, () => {
        const l = computeTrafficLight(findings, incomplete);
        expect(l).not.toBe('gruen');
        expect(l).toBe(sevs.includes('KRITISCH') ? 'rot' : 'gelb');
      });
    }
  }
  it('keine Seiten → gelb', () => {
    expect(computeTrafficLight([], 0, 0)).toBe('gelb');
  });
});

describe('analyze – Vollständigkeit (nie falsches Grün)', () => {
  const c = classifier();
  it('sauberer Lauf ohne Drittanbieter → grün', () => {
    const r = analyze({ pages: [page()], classify: c });
    expect(r.trafficLight).toBe('gruen');
    expect(r.assessment.manualReview).toBe(false);
    expect(r.assessment.label).toBe('Grün');
  });

  const codes = [
    'banner-nicht-bedienbar',
    'banner-nicht-gefunden',
    'navigation-fehlgeschlagen',
    'bot-schutz',
    'timeout',
    'browser-fehler',
    'sonstiges',
  ] as const;
  for (const id of SCENARIO_IDS) {
    for (const code of codes) {
      it(`${id} unvollständig (${code}) bei gefundenem Banner → Gelb – manuelle Prüfung nötig`, () => {
        const specs = [{}, {}, {}] as Parameters<typeof page>;
        specs[SCENARIO_IDS.indexOf(id)] = { status: INCOMPLETE(code) };
        const r = analyze({ pages: [page(...specs)], classify: c });
        expect(r.trafficLight).toBe('gelb');
        expect(r.assessment.manualReview).toBe(true);
        expect(r.assessment.label).toBe('Gelb – manuelle Prüfung nötig');
        expect(r.assessment.incomplete.map((i) => i.scenario)).toEqual([id]);
      });
    }
  }

  it('fehlendes Szenario → gelb', () => {
    const p = page();
    p.scenarios = p.scenarios.filter((s) => s.scenario !== 'B');
    const r = analyze({ pages: [p], classify: c });
    expect(r.trafficLight).toBe('gelb');
    expect(r.assessment.incomplete[0]?.reasonCode).toBe('nicht-ausgefuehrt');
  });

  it('vollständiges Szenario ohne jede Netzwerkaktivität → gelb (Mitschnitt fehlt)', () => {
    const r = analyze({ pages: [page({}, { connections: [] })], classify: c });
    expect(r.trafficLight).toBe('gelb');
    expect(r.assessment.incomplete[0]?.reasonCode).toBe('kein-mitschnitt');
  });

  it('keine Seiten → gelb', () => {
    expect(analyze({ pages: [], classify: c }).trafficLight).toBe('gelb');
  });

  it('eine von zwei Seiten unvollständig → gelb', () => {
    const p2 = { ...page({}, { status: INCOMPLETE() }), url: 'https://www.kunde-test.de/b' };
    expect(analyze({ pages: [page(), p2], classify: c }).trafficLight).toBe('gelb');
  });

  it('unvollständig + KRITISCH → rot mit Hinweis auf manuelle Prüfung', () => {
    const r = analyze({
      pages: [
        page(
          { connections: [FIRST_PARTY(), conn('www.googletagmanager.com')] },
          { status: INCOMPLETE() },
        ),
      ],
      classify: classifier({ 'www.googletagmanager.com': GTM }),
    });
    expect(r.trafficLight).toBe('rot');
    expect(r.assessment.label).toContain('manuelle Prüfung');
  });
});

describe('analyze – kein Banner (PLAN §7 „Nicht bedienbarer Banner“)', () => {
  const noBanner = (spec: Parameters<typeof scenario>[1] = {}): Parameters<typeof page> => [
    { banner: false, ...spec },
    { banner: false, status: INCOMPLETE('banner-nicht-gefunden'), ...spec },
    { banner: false, status: INCOMPLETE('banner-nicht-gefunden'), ...spec },
  ];

  it('kein Banner + nur First Party → grün, B/C gelten nicht als unvollständig', () => {
    const r = analyze({
      pages: [page(...noBanner())],
      classify: classifier(),
      exitIpStatus: 'ok',
    });
    expect(r.trafficLight).toBe('gruen');
    expect(r.assessment.incomplete).toEqual([]);
    expect(r.assessment.neutralized.map((n) => n.scenario)).toEqual(['B', 'C']);
    expect(r.findings.some((f) => f.severity === 'INFO' && f.category === 'banner')).toBe(true);
  });

  it('kein Banner + Google Fonts → rot mit KRITISCH „Kein Cookie-Banner gefunden“', () => {
    const conns = [FIRST_PARTY(), conn('fonts.googleapis.com')];
    const r = analyze({
      pages: [page(...noBanner({ connections: conns }))],
      classify: classifier({
        'fonts.googleapis.com': {
          stage: 'vendors',
          vendor: { id: 'gf', name: 'Google LLC (Google Fonts)', country: 'US', category: 'fonts' },
          thirdCountry: true,
        },
      }),
    });
    expect(r.trafficLight).toBe('rot');
    const banner = r.findings.find((f) => f.category === 'banner');
    expect(banner?.severity).toBe('KRITISCH');
    expect(banner?.title).toContain('Kein Cookie-Banner gefunden');
    expect(r.assessment.incomplete.map((i) => i.scenario)).toEqual(['B', 'C']);
  });

  it('kein Banner + Drittanbieter nur in C → trotzdem KRITISCH (C ohne Klick = A)', () => {
    const p = page(...noBanner());
    p.scenarios[2]!.connections = [FIRST_PARTY(), conn('unknown.example')];
    const r = analyze({ pages: [p], classify: classifier() });
    expect(r.trafficLight).toBe('rot');
  });

  it('kein Banner + Allowlist-Host → grün', () => {
    const r = analyze({
      pages: [page(...noBanner({ connections: [FIRST_PARTY(), conn('x.b-cdn.net')] }))],
      classify: classifier({ 'x.b-cdn.net': ALLOWLISTED }),
      exitIpStatus: 'ok',
    });
    expect(r.trafficLight).toBe('gruen');
  });

  it('kein Banner + nur DNS-Auflösung eines Dritten → grün (nur INFO)', () => {
    const r = analyze({
      pages: [
        page(...noBanner({ connections: [FIRST_PARTY(), conn('cdn.example', { dnsOnly: true })] })),
      ],
      classify: classifier(),
      exitIpStatus: 'ok',
    });
    expect(r.trafficLight).toBe('gruen');
    expect(r.findings.find((f) => f.host === 'cdn.example')?.category).toBe('nur-dns');
  });

  it('kein Banner + nur CMP-Host → gelb (B/C bleiben unvollständig)', () => {
    const r = analyze({
      pages: [page(...noBanner({ connections: [FIRST_PARTY(), conn('app.usercentrics.eu')] }))],
      classify: classifier({ 'app.usercentrics.eu': CMP }),
    });
    expect(r.trafficLight).toBe('gelb');
    expect(r.assessment.incomplete.length).toBe(2);
  });

  it('kein Banner + Tracking-Cookie (First Party) → rot', () => {
    const p = page(...noBanner());
    p.scenarios[0]!.cookies = [
      {
        name: '_ga',
        domain: '.kunde-test.de',
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: false,
        source: 'context',
        trackingMatch: { vendor: 'ga', pattern: '_ga', category: 'analyse' },
      },
    ];
    expect(analyze({ pages: [p], classify: classifier() }).trafficLight).toBe('rot');
  });

  it('A ohne Banner, aber A unvollständig → gelb, nichts neutralisiert', () => {
    const specs = noBanner();
    specs[0] = { banner: false, status: INCOMPLETE('timeout') };
    const r = analyze({ pages: [page(...specs)], classify: classifier() });
    expect(r.trafficLight).toBe('gelb');
    expect(r.assessment.neutralized).toEqual([]);
  });

  it('Banner in A gefunden, in B nicht → B bleibt unvollständig', () => {
    const r = analyze({
      pages: [page({}, { banner: false, status: INCOMPLETE('banner-nicht-gefunden') })],
      classify: classifier(),
    });
    expect(r.trafficLight).toBe('gelb');
  });
});

describe('analyze – Verbindungen, Ursachen, Zusammenführung', () => {
  const html = [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<link rel="preconnect" href="https://fonts.gstatic.com">',
    '<script src="https://www.googletagmanager.com/gtm.js?id=X"></script>',
    '</head>',
    '<body>',
    '<h1>Film</h1>',
    '<iframe width="560" src="http://www.youtube.com/embed/abc"></iframe>',
    '<iframe data-src="https://www.youtube-nocookie.com/embed/abc"></iframe>',
    '</body></html>',
  ].join('\n');

  it('YouTube-iframe im HTML vor CMP → KRITISCH, Ursache HTML-Quelltext mit Zeile', () => {
    const yt = conn('www.youtube.com', {
      at: 38,
      causes: [parserCause('http://www.youtube.com/embed/abc', 9)],
    });
    const r = analyze({
      pages: [page({ connections: [FIRST_PARTY(), yt], rawHtml: html, cmpLoadedAt: 450 })],
      classify: classifier({ 'www.youtube.com': YOUTUBE }),
    });
    expect(r.trafficLight).toBe('rot');
    const f = r.findings.find((x) => x.host === 'www.youtube.com')!;
    expect(f.severity).toBe('KRITISCH');
    expect(f.causeClass).toBe('html-quelltext');
    expect(f.country).toBe('US');
    expect(f.vendor).toBe('Google LLC (YouTube)');
    expect(f.description).toContain(
      'Verbindung zu www.youtube.com 38 ms nach Navigationsstart, 412 ms bevor das CMP geladen war',
    );
    const snip = f.evidence.find((e) => e.snippet)?.snippet;
    expect(snip?.line).toBe(9);
    expect(snip?.text).toContain('<iframe');
    expect(f.fix).toContain('data-src');
    expect(f.fix).toContain('YT-Fix');
    expect(f.timing).toEqual({ A: 38 });
  });

  it('eine Meldung pro Host über Szenarien, mit Liste der Szenarien und frühestem Zeitpunkt', () => {
    const r = analyze({
      pages: [
        page(
          { connections: [FIRST_PARTY(), conn('www.youtube.com', { at: 40 })] },
          { connections: [FIRST_PARTY(), conn('www.youtube.com', { at: 30 })] },
          { connections: [FIRST_PARTY(), conn('www.youtube.com', { at: 20 })] },
        ),
      ],
      classify: classifier({ 'www.youtube.com': YOUTUBE }),
    });
    const list = r.findings.filter((f) => f.host === 'www.youtube.com');
    expect(list).toHaveLength(1);
    expect(list[0]!.scenarios).toEqual(['A', 'B', 'C']);
    expect(list[0]!.timing).toEqual({ A: 40, B: 30, C: 20 });
    expect(list[0]!.severity).toBe('KRITISCH');
  });

  it('dieselbe ID über zwei Läufe (stabil für diff)', () => {
    const mk = () =>
      analyze({
        pages: [page({ connections: [FIRST_PARTY(), conn('www.youtube.com')] })],
        classify: classifier({ 'www.youtube.com': YOUTUBE }),
      }).findings[0]!.id;
    expect(mk()).toBe(mk());
  });

  it('nur in C → INFO und grün', () => {
    const r = analyze({
      pages: [
        page(
          {},
          {},
          {
            connections: [FIRST_PARTY(), conn('www.googletagmanager.com', { at: 900 })],
            bannerClickAt: 800,
          },
        ),
      ],
      classify: classifier({ 'www.googletagmanager.com': GTM }),
    });
    expect(r.findings.every((f) => f.severity === 'INFO')).toBe(true);
    expect(r.trafficLight).toBe('gruen');
  });

  it('nur DNS in A → INFO (nur-dns)', () => {
    const r = analyze({
      pages: [
        page({ connections: [FIRST_PARTY(), conn('www.googletagmanager.com', { dnsOnly: true })] }),
      ],
      classify: classifier({ 'www.googletagmanager.com': GTM }),
    });
    expect(r.findings[0]).toMatchObject({ severity: 'INFO', category: 'nur-dns' });
    expect(r.trafficLight).toBe('gruen');
  });

  it('Verbindung ohne eigenen Socket, aber beantwortete Anfrage (Proxy/Coalescing) zählt als echt', () => {
    const c = conn('www.google-analytics.com', { dnsOnly: true, level: 'none' });
    c.urlRequests = [
      {
        url: 'https://www.google-analytics.com/g/collect',
        startTime: 10,
        aborted: false,
        sourceId: 3,
      },
    ];
    expect(isRealConnection(c)).toBe(true);
    const r = analyze({
      pages: [page({ connections: [FIRST_PARTY(), c] })],
      classify: classifier({ 'www.google-analytics.com': EU_ANALYTICS }),
    });
    expect(r.trafficLight).toBe('rot');
  });

  it('Host nur im CDP-Mitschnitt mit Antwort → echte Verbindung', () => {
    const A = scenario('A');
    A.requests = [
      {
        id: '9',
        url: 'https://unknown.example/a.js',
        host: 'unknown.example',
        method: 'GET',
        resourceType: 'Script',
        initiator: { type: 'parser' },
        startTime: 12,
        status: 200,
      },
    ];
    const p: AnalyzePage = { url: A.url, scenarios: [A, scenario('B'), scenario('C')] };
    const r = analyze({ pages: [p], classify: classifier() });
    expect(r.findings.find((f) => f.host === 'unknown.example')?.severity).toBe('HOCH');
  });

  it('EU-CDN → MITTEL (gelb), mit Allowlist-Hinweis', () => {
    const r = analyze({
      pages: [page({ connections: [FIRST_PARTY(), conn('x.b-cdn.net')] })],
      classify: classifier({ 'x.b-cdn.net': EU_CDN }),
    });
    expect(r.findings[0]!.severity).toBe('MITTEL');
    expect(r.findings[0]!.fix).toContain('allowedProcessors');
    expect(r.trafficLight).toBe('gelb');
  });

  it('Allowlist → INFO mit Begründung, grün', () => {
    const r = analyze({
      pages: [page({ connections: [FIRST_PARTY(), conn('x.b-cdn.net')] })],
      classify: classifier({ 'x.b-cdn.net': ALLOWLISTED }),
    });
    expect(r.findings[0]!.severity).toBe('INFO');
    expect(r.findings[0]!.description).toContain('AVV vom 2026-03-01');
    expect(r.trafficLight).toBe('gruen');
  });

  it('CMP-Host in A → INFO „Consent-Manager, technisch notwendig“', () => {
    const r = analyze({
      pages: [page({ connections: [FIRST_PARTY(), conn('app.usercentrics.eu')] })],
      classify: classifier({ 'app.usercentrics.eu': CMP }),
    });
    expect(r.findings[0]!.severity).toBe('INFO');
    expect(r.findings[0]!.description).toContain('Consent-Manager, technisch notwendig');
    expect(r.trafficLight).toBe('gruen');
  });
});

describe('determineCause – Ursachenklassen (PLAN §8)', () => {
  const base = {
    scenario: 'A' as ScenarioId,
    timing: { navigationStart: 0, cmpLoadedAt: 300 },
    wasPreconnectOnly: false,
    pageUrls: ['https://www.kunde-test.de/'],
  };
  const html =
    '<html>\n<head>\n<link rel="preconnect" href="https://fonts.gstatic.com">\n<script src="https://www.googletagmanager.com/gtm.js"></script>\n</head>\n<body><img loading="lazy" src="https://img.example/a.png"></body></html>';

  it('Resource-Hint', () => {
    const r = determineCause({
      ...base,
      time: 20,
      causes: [],
      wasPreconnectOnly: true,
      rawHtml: html,
      host: 'fonts.gstatic.com',
    });
    expect(r.causeClass).toBe('resource-hint');
    expect(r.snippet?.line).toBe(3);
  });
  it('Script mit src im HTML vor CMP → script-vor-cmp', () => {
    const r = determineCause({
      ...base,
      time: 20,
      causes: [
        { ...parserCause('https://www.googletagmanager.com/gtm.js', 4), resourceType: 'Script' },
      ],
      rawHtml: html,
      host: 'www.googletagmanager.com',
    });
    expect(r.causeClass).toBe('script-vor-cmp');
    expect(r.snippet?.line).toBe(4);
  });
  it('Script-Initiator vor CMP → script-vor-cmp', () => {
    const r = determineCause({
      ...base,
      time: 100,
      causes: [scriptCause('https://t.example/x', 'https://www.kunde-test.de/app.js')],
      host: 't.example',
    });
    expect(r.causeClass).toBe('script-vor-cmp');
    expect(r.scriptUrl).toBe('https://www.kunde-test.de/app.js');
  });
  it('Script-Initiator nach CMP → nachgeladen-durch-script', () => {
    const r = determineCause({
      ...base,
      time: 500,
      causes: [scriptCause('https://t.example/x', 'https://cdn.example/lib.js')],
      host: 't.example',
    });
    expect(r.causeClass).toBe('nachgeladen-durch-script');
  });
  it('B nach dem Ablehnen-Klick → nach-ablehnen', () => {
    const r = determineCause({
      ...base,
      scenario: 'B',
      timing: { navigationStart: 0, bannerClickAt: 1000 },
      time: 1300,
      causes: [scriptCause('https://t.example/x', 'https://www.kunde-test.de/cmp.js')],
      host: 't.example',
    });
    expect(r.causeClass).toBe('nach-ablehnen');
  });
  it('erst während der Scroll-Phase → lazy-load-scroll', () => {
    const r = determineCause({
      ...base,
      timing: { navigationStart: 0, scrollPhaseStartAt: 2000, scrollPhaseEndAt: 4000 },
      time: 2500,
      causes: [],
      rawHtml: html,
      host: 'img.example',
    });
    expect(r.causeClass).toBe('lazy-load-scroll');
    expect(r.snippet?.line).toBe(6);
  });
  it('ohne jeden Hinweis → unbekannt', () => {
    expect(determineCause({ ...base, time: 10, causes: [], host: 'x.example' }).causeClass).toBe(
      'unbekannt',
    );
  });
});

describe('findHostInHtml', () => {
  it('data-src lädt nicht, src schon', () => {
    const refs = findHostInHtml(
      '<iframe data-src="https://a.example/x"></iframe>\n<iframe\n  src="https://a.example/y"></iframe>',
      'a.example',
    );
    expect(refs.map((r) => [r.kind, r.line])).toEqual([
      ['other', 1],
      ['src', 2],
    ]);
  });
  it('erkennt Subdomains nicht fälschlich', () => {
    expect(findHostInHtml('<img src="https://cdn.a.example/x">', 'a.example')).toEqual([]);
  });
  it('Stylesheet-Link ist src, preconnect ist hint', () => {
    const refs = findHostInHtml(
      '<link rel="stylesheet" href="https://f.example/c.css"><link rel="dns-prefetch" href="//f.example">',
      'f.example',
    );
    expect(refs.map((r) => r.kind)).toEqual(['src', 'hint']);
  });
});

describe('analyze – Speicher, Fingerprinting, Consent Mode, Banner, Datenschutzerklärung', () => {
  const c = classifier();
  const cookie = (name: string, category?: string, extra = {}) => ({
    name,
    domain: '.kunde-test.de',
    path: '/',
    expires: -1,
    httpOnly: false,
    secure: false,
    source: 'context' as const,
    checkpoint: 'nach-laden' as const,
    ...(category !== undefined ? { trackingMatch: { vendor: 'v', pattern: name, category } } : {}),
    ...extra,
  });

  for (const s of SCENARIO_IDS) {
    const expected = s === 'C' ? 'INFO' : 'KRITISCH';
    it(`Tracking-Cookie in ${s} → ${expected}`, () => {
      const specs = [{}, {}, {}] as Parameters<typeof page>;
      specs[SCENARIO_IDS.indexOf(s)] = { extra: { cookies: [cookie('_ga', 'analyse')] } };
      const r = analyze({ pages: [page(...specs)], classify: c });
      expect(r.findings.find((f) => f.category === 'cookie')?.severity).toBe(expected);
    });
  }
  it('CMP-Consent-Cookie wird nicht beanstandet', () => {
    const r = analyze({
      pages: [
        page({ extra: { cookies: [cookie('uc_settings', 'cmp', { isConsentCookie: true })] } }),
      ],
      classify: c,
    });
    expect(r.findings).toEqual([]);
    expect(r.trafficLight).toBe('gruen');
  });
  it('als notwendig markierter Cookie (Bot-Schutz) → INFO', () => {
    const r = analyze({
      pages: [
        page({
          extra: {
            cookies: [
              {
                ...cookie('__cf_bm', 'cdn'),
                trackingMatch: {
                  vendor: 'cloudflare',
                  pattern: '__cf_bm',
                  category: 'cdn',
                  necessary: true,
                },
              },
            ],
          },
        }),
      ],
      classify: c,
    });
    expect(r.findings[0]?.severity).toBe('INFO');
  });
  it('Cookie eines Nicht-CMP-Vendors außerhalb der Tracking-Kategorien (YouTube) → KRITISCH in A/B', () => {
    for (const [name, cat] of [
      ['VISITOR_INFO1_LIVE', 'video'],
      ['YSC', 'video'],
      ['NID', 'sonstiges'],
      ['__Secure-3PSID', 'sonstiges'],
    ] as const) {
      const r = analyze({
        pages: [page({}, { extra: { cookies: [cookie(name, cat)] } })],
        classify: c,
      });
      expect(r.findings[0]?.severity, name).toBe('KRITISCH');
      expect(r.trafficLight).toBe('rot');
    }
  });
  it('Cookie eines CMP-Vendors → INFO', () => {
    const r = analyze({ pages: [page({ extra: { cookies: [cookie('x', 'cmp')] } })], classify: c });
    expect(r.findings[0]?.severity).toBe('INFO');
  });
  it('Tracking-Storage in B → KRITISCH', () => {
    const r = analyze({
      pages: [
        page(
          {},
          {
            extra: {
              storage: [
                {
                  kind: 'localStorage',
                  origin: 'https://www.kunde-test.de',
                  key: '_hjSession_1',
                  checkpoint: 'ende',
                  trackingMatch: { vendor: 'hotjar', pattern: '_hj*', category: 'analyse' },
                },
              ],
            },
          },
        ),
      ],
      classify: c,
    });
    expect(r.findings[0]).toMatchObject({
      severity: 'KRITISCH',
      category: 'storage',
      scenarios: ['B'],
    });
  });
  it('Fingerprinting in A → KRITISCH', () => {
    const fp = [
      { api: 'canvas.toDataURL', time: 100, scriptUrl: 'https://fp.example/fp.js' },
      { api: 'navigator.plugins', time: 101, scriptUrl: 'https://fp.example/fp.js' },
      {
        api: 'webgl.getParameter',
        detail: 'UNMASKED_RENDERER_WEBGL',
        time: 102,
        scriptUrl: 'https://fp.example/fp.js',
      },
    ];
    const r = analyze({ pages: [page({ extra: { fingerprinting: fp } })], classify: c });
    expect(r.findings.find((f) => f.category === 'fingerprinting')?.severity).toBe('KRITISCH');
    expect(r.trafficLight).toBe('rot');
  });
  it('Consent Mode Advanced in A → HOCH, nur in C → INFO', () => {
    const ping = {
      url: 'https://region1.google-analytics.com/g/collect?gcs=G100',
      host: 'region1.google-analytics.com',
      time: 200,
      gcs: 'G100',
      advancedMode: true,
    };
    const a = analyze({ pages: [page({ extra: { consentMode: [ping] } })], classify: c });
    expect(a.findings[0]).toMatchObject({ severity: 'HOCH', causeClass: 'consent-mode-advanced' });
    expect(a.findings[0]!.fix).toContain('Basic');
    const cc = analyze({ pages: [page({}, {}, { extra: { consentMode: [ping] } })], classify: c });
    expect(cc.findings[0]!.severity).toBe('INFO');
  });
  it('keine Ablehnen-Option auf erster Ebene → HOCH', () => {
    const r = analyze({
      pages: [page({}, {}, {}, { bannerDesign: { rejectFirstLayer: false, details: [] } })],
      classify: c,
    });
    const p = r.findings.find((f) => f.category === 'banner');
    expect(p?.severity).toBe('HOCH');
  });
  it('B hat mit einem Klick abgelehnt → kein Befund trotz Design-Heuristik', () => {
    const p = page({}, {}, {}, { bannerDesign: { rejectFirstLayer: false, details: [] } });
    p.scenarios[1]!.banner = { found: true, rejectFirstLayer: true };
    expect(analyze({ pages: [p], classify: c }).findings).toEqual([]);
  });
  it('Banner verdeckt Impressum → MITTEL', () => {
    const r = analyze({
      pages: [
        page(
          {},
          {},
          {},
          { bannerDesign: { imprintReachable: false, privacyPolicyReachable: true, details: [] } },
        ),
      ],
      classify: c,
    });
    expect(r.findings[0]).toMatchObject({ severity: 'MITTEL', category: 'banner' });
    expect(r.trafficLight).toBe('gelb');
  });
  it('Design-Prüfung ohne Banner wird ignoriert', () => {
    const p = page(
      { banner: false },
      { banner: false, status: INCOMPLETE('banner-nicht-gefunden') },
      { banner: false, status: INCOMPLETE('banner-nicht-gefunden') },
      { bannerDesign: { rejectFirstLayer: false, imprintReachable: false, details: [] } },
    );
    expect(analyze({ pages: [p], classify: c, exitIpStatus: 'ok' }).trafficLight).toBe('gruen');
  });
  it('Vendor fehlt in der Datenschutzerklärung → MITTEL', () => {
    const r = analyze({
      pages: [
        page(
          {},
          {},
          {},
          {
            privacyPolicy: {
              url: 'https://www.kunde-test.de/ds',
              mentioned: [],
              missing: ['Google LLC (YouTube)'],
            },
          },
        ),
      ],
      classify: c,
    });
    expect(r.findings[0]).toMatchObject({ severity: 'MITTEL', category: 'datenschutzerklaerung' });
  });
  it('Datenschutzerklärung nicht gefunden → INFO', () => {
    const r = analyze({
      pages: [page({}, {}, {}, { privacyPolicy: { mentioned: [], missing: [] } })],
      classify: c,
    });
    expect(r.findings[0]?.severity).toBe('INFO');
    expect(r.trafficLight).toBe('gruen');
  });
});

describe('analyze – Review-Fixes (falsches Grün verhindern)', () => {
  const nb = INCOMPLETE('banner-nicht-gefunden');
  const noBannerPage = (extraA: Partial<AnalyzeScenario> = {}) =>
    page(
      { banner: false, extra: extraA },
      { banner: false, status: nb },
      { banner: false, status: nb },
    );

  it('kein Banner, aber CMP-Script geladen → B/C nicht neutralisiert (gelb)', () => {
    const r = analyze({
      pages: [
        noBannerPage({
          cmpScriptUrl: 'https://www.kunde-test.de/wp-content/plugins/borlabs-cookie/x.js',
          cmpLoadedSource: 'cmp-script',
        }),
      ],
      classify: classifier(),
      exitIpStatus: 'ok',
    });
    expect(r.trafficLight).toBe('gelb');
    expect(r.assessment.neutralized).toEqual([]);
    expect(r.findings.some((f) => f.title.includes('manuelle Prüfung'))).toBe(true);
  });
  it('kein Banner, autoconsent hat CMP erkannt → nicht neutralisiert', () => {
    const r = analyze({
      pages: [noBannerPage({ cmpLoadedSource: 'autoconsent' })],
      classify: classifier(),
      exitIpStatus: 'ok',
    });
    expect(r.trafficLight).toBe('gelb');
  });
  for (const status of [undefined, 'nicht-eu', 'unbekannt', 'fehlgeschlagen', 'uebersprungen']) {
    it(`kein Banner, Exit-IP-Check ${status ?? 'fehlt'} → nicht neutralisiert`, () => {
      const r = analyze({
        pages: [noBannerPage()],
        classify: classifier(),
        ...(status ? { exitIpStatus: status } : {}),
      });
      expect(r.trafficLight).toBe('gelb');
      expect(r.assessment.neutralized).toEqual([]);
    });
  }

  it('gebündelte HTTP/2-Verbindung: abgebrochene Anfrage mit gesendeten Headern zählt als echte Verbindung', () => {
    const yt = conn('www.youtube.com', {
      level: 'dns',
      urlRequests: [
        {
          url: 'https://www.youtube.com/embed/x',
          startTime: 40,
          aborted: true,
          netError: -3,
          headersSent: true,
          sourceId: 9,
        },
      ],
    });
    delete yt.tcp;
    delete yt.tls;
    delete yt.firstConnectAt;
    const mk = (id: 'A' | 'B' | 'C') => scenario(id, { connections: [FIRST_PARTY(), yt] });
    const r = analyze({
      pages: [{ url: SITE, scenarios: [mk('A'), mk('B'), mk('C')] }],
      classify: classifier({ 'www.youtube.com': YOUTUBE }),
    });
    expect(r.findings.find((f) => f.host === 'www.youtube.com')?.severity).toBe('KRITISCH');
    expect(r.trafficLight).toBe('rot');
  });

  it('CDP-Anfrage (ERR_ABORTED) an Host ohne NetLog-Spur → HOCH (unbestätigt), nie grün', () => {
    const yt = {
      id: '1',
      url: 'https://www.youtube.com/embed/x',
      host: 'www.youtube.com',
      method: 'GET',
      resourceType: 'Document',
      initiator: { type: 'parser' as const },
      startTime: 40,
      failed: true,
      errorText: 'net::ERR_ABORTED',
      canceled: true,
    };
    const mk = (id: 'A' | 'B' | 'C') =>
      scenario(id, { connections: [FIRST_PARTY()], extra: { requests: [yt] } });
    const r = analyze({
      pages: [{ url: SITE, scenarios: [mk('A'), mk('B'), mk('C')] }],
      classify: classifier({ 'www.youtube.com': YOUTUBE }),
    });
    const f = r.findings.find((x) => x.host === 'www.youtube.com');
    expect(f?.severity).toBe('HOCH');
    expect(f?.title).toContain('Unbestätigter Verbindungsversuch');
    expect(r.trafficLight).toBe('gelb');
  });

  it('von Chromium vor dem Senden blockierte Anfrage (CSP) → kein Befund', () => {
    const req = {
      id: '1',
      url: 'https://evil.example/x.js',
      host: 'evil.example',
      method: 'GET',
      resourceType: 'Script',
      initiator: { type: 'parser' as const },
      startTime: 40,
      failed: true,
      errorText: 'net::ERR_BLOCKED_BY_CLIENT',
      blockedReason: 'csp',
    };
    const p = page({ extra: { requests: [req] } }, { extra: { requests: [req] } });
    const r = analyze({ pages: [p], classify: classifier() });
    expect(r.findings.find((x) => x.host === 'evil.example')).toBeUndefined();
    expect(r.trafficLight).toBe('gruen');
  });

  it('NetLog ohne Verbindung zur Hauptseite → unvollständig (kein-mitschnitt)', () => {
    const p = page({ connections: [conn('www.other-host.de', { dnsOnly: true })] });
    const r = analyze({ pages: [p], classify: classifier() });
    expect(r.trafficLight).toBe('gelb');
    expect(r.assessment.incomplete).toEqual([
      expect.objectContaining({ scenario: 'A', reasonCode: 'kein-mitschnitt' }),
    ]);
  });

  it('Hauptseite nur über gesendete Header (gebündelte Verbindung) → vollständig', () => {
    const fp = conn('www.kunde-test.de', {
      level: 'dns',
      urlRequests: [{ url: SITE, startTime: 1, aborted: false, headersSent: true, sourceId: 1 }],
    });
    delete fp.tcp;
    delete fp.tls;
    const r = analyze({ pages: [page({ connections: [fp] })], classify: classifier() });
    expect(r.assessment.incomplete).toEqual([]);
  });
});
