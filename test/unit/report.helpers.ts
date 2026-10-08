import type { ScanReport, ScenarioId, ScenarioResult, HostConnection } from '../../src/types.js';

export function conn(host: string, at: number): HostConnection {
  return {
    host,
    ports: [443],
    remoteIps: ['127.0.0.1'],
    urlRequests: [],
    wasPreconnectOnly: false,
    sawPreconnect: false,
    firstSeen: at,
    firstConnectAt: at,
    level: 'tls',
    requested: true,
  };
}

export function scen(
  id: ScenarioId,
  hosts: string[],
  extra: Partial<ScenarioResult> = {},
): ScenarioResult {
  return {
    scenario: id,
    url: 'https://www.kunde.de/',
    status: { state: 'vollstaendig' },
    timing: {
      navigationStart: 0,
      cmpLoadedAt: 200,
      bannerClickAt: id === 'A' ? undefined : 900,
      scrollPhaseStartAt: 1000,
      scrollPhaseEndAt: 2500,
    },
    banner: { found: true, cmp: 'TestCMP' },
    connections: [conn('www.kunde.de', 5), ...hosts.map((h, i) => conn(h, 50 + i * 40))],
    requests: [],
    cookies: [],
    storage: [],
    fingerprinting: [],
    consentMode: [],
    evidenceFiles: [],
    ...extra,
  } as ScenarioResult;
}

export function fixtureReport(over: Partial<ScanReport> = {}): ScanReport {
  const evil = '<script>alert(1)</script>.evil.example';
  return {
    schemaVersion: 1,
    url: 'https://www.kunde.de/',
    customer: 'Kunde & Söhne <b>',
    meta: {
      startedAt: '2026-03-01T10:00:00.000Z',
      belloVersion: '0.1.0',
      crawl: false,
      chromiumVersion: '130.0',
      exitIp: '203.0.113.5',
      exitCountry: 'DE',
      commandLine: ['bello', 'scan', 'https://www.kunde.de/'],
      configHash: 'abc123',
    },
    trafficLight: 'rot',
    assessment: {
      trafficLight: 'rot',
      label: 'Rot',
      manualReview: false,
      incomplete: [],
      neutralized: [],
      counts: { KRITISCH: 1, HOCH: 0, MITTEL: 1, INFO: 0 },
      reasons: ['Verbindung zu www.youtube.com vor Einwilligung.'],
    },
    pages: [
      {
        url: 'https://www.kunde.de/',
        scenarios: [
          scen('A', ['www.youtube.com', evil], {
            cookies: [
              {
                name: '<img src=x onerror=alert(1)>',
                domain: '.youtube.com',
                path: '/',
                expires: -1,
                httpOnly: false,
                secure: true,
                source: 'context',
                firstParty: false,
                checkpoint: 'ende',
              },
            ],
          }),
          scen('B', ['www.youtube.com']),
          scen('C', ['www.youtube.com']),
        ],
        bannerDesign: {
          rejectFirstLayer: false,
          details: ['Kein „Ablehnen“ auf der ersten Ebene.'],
        },
        privacyPolicy: {
          url: 'https://www.kunde.de/datenschutz',
          mentioned: [],
          missing: ['YouTube'],
        },
      },
    ],
    classifications: [
      { host: 'www.kunde.de', stage: 'first-party', firstParty: true },
      {
        host: 'www.youtube.com',
        stage: 'vendors',
        firstParty: false,
        vendor: { id: 'google', name: 'Google LLC', country: 'US' },
        thirdCountry: true,
      },
      { host: evil, stage: 'unbekannt', firstParty: false },
    ],
    findings: [
      {
        id: 'f1',
        severity: 'KRITISCH',
        scenarios: ['A', 'B'],
        category: 'drittverbindung',
        host: evil,
        vendor: 'Google LLC',
        country: 'US',
        causeClass: 'html-quelltext',
        title: 'Verbindung zu www.youtube.com vor Einwilligung',
        description: 'Beschreibung <i>x</i>',
        fix: 'Iframe per data-src nachladen.',
        timing: { A: 50 },
        evidence: [
          {
            snippet: { text: '<iframe src="https://www.youtube.com/embed/x"></iframe>', line: 12 },
          },
        ],
      },
      {
        id: 'f2',
        severity: 'MITTEL',
        scenarios: ['C'],
        category: 'cookie',
        title: 'Cookie',
        description: 'd',
        evidence: [],
      },
    ],
    disclaimer: 'Dieser Bericht ist keine Rechtsberatung.',
    ...over,
  };
}
