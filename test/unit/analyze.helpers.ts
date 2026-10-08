import type { AnalyzePage, AnalyzeScenario } from '../../src/analyze/index.js';
import type {
  Classification,
  ConnectionCause,
  HostConnection,
  ScenarioId,
  ScenarioStatus,
} from '../../src/types.js';

export const SITE = 'https://www.kunde-test.de/';

export function conn(
  host: string,
  opts: Partial<HostConnection> & {
    at?: number;
    dnsOnly?: boolean;
    causes?: ConnectionCause[];
  } = {},
): HostConnection {
  const at = opts.at ?? 50;
  const dnsOnly = opts.dnsOnly ?? false;
  const c: HostConnection = {
    host,
    ports: [443],
    remoteIps: dnsOnly ? [] : ['127.0.0.1'],
    urlRequests: dnsOnly
      ? []
      : [{ url: `https://${host}/x`, startTime: at, aborted: false, sourceId: 1 }],
    wasPreconnectOnly: false,
    sawPreconnect: false,
    firstSeen: at - 5,
    level: dnsOnly ? 'dns' : 'tls',
    requested: !dnsOnly,
    dns: { startTime: at - 5, addresses: ['127.0.0.1'] },
    ...(dnsOnly
      ? {}
      : {
          firstConnectAt: at,
          tcp: { startTime: at, remoteAddresses: ['127.0.0.1:443'], count: 1, connected: true },
          tls: { startTime: at + 1, count: 1, established: true },
        }),
    ...opts,
  };
  if (dnsOnly) {
    delete c.firstConnectAt;
    delete c.tcp;
    delete c.tls;
  }
  return c;
}

export const FIRST_PARTY = (): HostConnection => conn('www.kunde-test.de', { at: 1 });

export interface ScenarioSpec {
  status?: ScenarioStatus;
  banner?: boolean;
  connections?: HostConnection[];
  rawHtml?: string;
  cmpLoadedAt?: number;
  bannerClickAt?: number;
  scrollPhaseStartAt?: number;
  scrollPhaseEndAt?: number;
  extra?: Partial<AnalyzeScenario>;
}

export function scenario(id: ScenarioId, spec: ScenarioSpec = {}): AnalyzeScenario {
  const timing: AnalyzeScenario['timing'] = { navigationStart: 1_000_000 };
  if (spec.cmpLoadedAt !== undefined) timing.cmpLoadedAt = spec.cmpLoadedAt;
  if (spec.bannerClickAt !== undefined) timing.bannerClickAt = spec.bannerClickAt;
  if (spec.scrollPhaseStartAt !== undefined) timing.scrollPhaseStartAt = spec.scrollPhaseStartAt;
  if (spec.scrollPhaseEndAt !== undefined) timing.scrollPhaseEndAt = spec.scrollPhaseEndAt;
  return {
    scenario: id,
    url: SITE,
    status: spec.status ?? { state: 'vollstaendig' },
    timing,
    banner: { found: spec.banner ?? true },
    connections: spec.connections ?? [FIRST_PARTY()],
    requests: [],
    cookies: [],
    storage: [],
    fingerprinting: [],
    consentMode: [],
    evidenceFiles: [`evidence/${id}/netlog.json`, `evidence/${id}/raw.html`],
    ...(spec.rawHtml !== undefined ? { rawHtml: spec.rawHtml } : {}),
    ...(spec.extra ?? {}),
  };
}

export function page(
  a: ScenarioSpec = {},
  b: ScenarioSpec = {},
  c: ScenarioSpec = {},
  extra: Partial<AnalyzePage> = {},
): AnalyzePage {
  return {
    url: SITE,
    scenarios: [scenario('A', a), scenario('B', b), scenario('C', c)],
    ...extra,
  };
}

export const INCOMPLETE = (
  reasonCode: Extract<
    ScenarioStatus,
    { state: 'unvollstaendig' }
  >['reasonCode'] = 'banner-nicht-bedienbar',
): ScenarioStatus => ({ state: 'unvollstaendig', reasonCode, reason: 'Test' });

/** Simple fake classifier keyed by host. */
export function classifier(
  table: Record<string, Partial<Classification>> = {},
): (host: string) => Classification {
  return (host) => {
    if (host.endsWith('kunde-test.de')) return { host, stage: 'first-party', firstParty: true };
    const t = table[host];
    return { host, stage: 'unbekannt', firstParty: false, ...(t ?? {}) };
  };
}

export const YOUTUBE: Partial<Classification> = {
  stage: 'vendors',
  vendor: {
    id: 'youtube',
    name: 'Google LLC (YouTube)',
    country: 'US',
    category: 'video',
    fix: 'YT-Fix',
  },
  thirdCountry: true,
};
export const GTM: Partial<Classification> = {
  stage: 'vendors',
  vendor: {
    id: 'gtm',
    name: 'Google LLC (Google Tag Manager)',
    country: 'US',
    category: 'tag-manager',
  },
  thirdCountry: true,
};
export const EU_CDN: Partial<Classification> = {
  stage: 'vendors',
  vendor: { id: 'bunny', name: 'BunnyWay d.o.o.', country: 'SI', category: 'cdn' },
  thirdCountry: false,
};
export const EU_ANALYTICS: Partial<Classification> = {
  stage: 'vendors',
  vendor: { id: 'etracker', name: 'etracker GmbH', country: 'DE', category: 'analyse' },
  thirdCountry: false,
};
export const EASYPRIVACY: Partial<Classification> = { stage: 'easyprivacy', easyPrivacy: true };
export const CMP: Partial<Classification> = {
  stage: 'vendors',
  vendor: { id: 'usercentrics', name: 'Usercentrics GmbH', country: 'DE', category: 'cmp' },
  thirdCountry: false,
};
export const US_CMP: Partial<Classification> = {
  stage: 'vendors',
  vendor: { id: 'onetrust', name: 'OneTrust LLC', country: 'US', category: 'cmp' },
  thirdCountry: true,
};
export const ALLOWLISTED: Partial<Classification> = {
  stage: 'allowlist',
  allowlist: { host: '*.b-cdn.net', reason: 'CDN, AVV vom 2026-03-01' },
  thirdCountry: false,
};
