import { readFile } from 'node:fs/promises';
import maxmind, { type AsnResponse, type CountryResponse, type Reader } from 'maxmind';
import { getDomain } from 'tldts';
import type { Classification } from '../types.js';
import { dataPaths } from '../platform/paths.js';
import { isEuEeaCountry } from './countries.js';
import { parseEasyPrivacyDomains, matchDomainSet } from './easyprivacy.js';
import { globSpecificity, hostGlobToRegExp, matchHostGlob } from './glob.js';
import { defaultFix, loadVendors, type Vendor } from './vendors.js';

export interface AllowedProcessor {
  /** Host glob, e.g. `cdn.example.com` or `*.example.com`. */
  host: string;
  reason: string;
}

export interface ClassifyContext {
  /** Scanned site (host name or URL). */
  site: string;
  firstPartyAliases?: string[];
  allowedProcessors?: AllowedProcessor[];
  /** IPs the browser actually connected to for this host (NetLog). */
  ips?: string[];
}

export interface ClassifierOptions {
  vendorsFile?: string;
  extraVendorsFile?: string;
  /** Override the cache directory holding easyprivacy.txt / mmdb files. */
  dataDir?: string;
  /** Pre-parsed vendors (tests); skips loading vendors.yaml. */
  vendors?: Vendor[];
  /** Raw EasyPrivacy text (tests); skips reading the cache file. */
  easyPrivacyText?: string;
  /** Disable loading of external datasets (tests). */
  skipExternalData?: boolean;
}

export type DataSource = 'easyprivacy' | 'dbip-country' | 'dbip-asn';

export interface TrackingMatch {
  vendor: string;
  pattern: string;
  /** Vendor display name and category, so callers can decide whether the match is "tracking". */
  vendorName: string;
  category: string;
  /** Matched a `necessaryCookies` / `necessaryStorageKeys` entry (not tracking). */
  necessary?: boolean;
}

interface HostPattern {
  pattern: string;
  re: RegExp;
  spec: number;
  vendor: Vendor;
}

interface NamePattern {
  pattern: string;
  re: RegExp;
  hostRe?: RegExp;
  vendor: Vendor;
}

function nameGlob(p: string): RegExp {
  return new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
}

function compileNamePatterns(vendors: Vendor[], pick: (v: Vendor) => string[]): NamePattern[] {
  const out: NamePattern[] = [];
  for (const v of vendors) {
    for (const raw of pick(v)) {
      // Optional host restriction: `NID@*.google.com`
      const at = raw.lastIndexOf('@');
      const name = at > 0 ? raw.slice(0, at) : raw;
      const np: NamePattern = { pattern: raw, re: nameGlob(name), vendor: v };
      if (at > 0) np.hostRe = hostGlobToRegExp(raw.slice(at + 1));
      out.push(np);
    }
  }
  return out;
}

function siteHost(site: string): string {
  try {
    return new URL(site.includes('://') ? site : `https://${site}`).hostname.toLowerCase();
  } catch {
    return site.toLowerCase();
  }
}

export class Classifier {
  /** Data sources that were not available; the classification degrades accordingly. */
  readonly unavailable: DataSource[] = [];
  readonly vendors: Vendor[];
  private readonly hostPatterns: HostPattern[];
  private readonly cookiePatterns: NamePattern[];
  private readonly storagePatterns: NamePattern[];
  private readonly consentCookiePatterns: NamePattern[];
  private readonly consentStoragePatterns: NamePattern[];
  private readonly necessaryCookiePatterns: NamePattern[];
  private readonly necessaryStoragePatterns: NamePattern[];
  private easyPrivacy: Set<string> | undefined;
  private country: Reader<CountryResponse> | undefined;
  private asn: Reader<AsnResponse> | undefined;

  private constructor(vendors: Vendor[]) {
    this.vendors = vendors;
    this.hostPatterns = vendors.flatMap((v) =>
      v.hosts.map((p) => ({
        pattern: p,
        re: hostGlobToRegExp(p),
        spec: globSpecificity(p),
        vendor: v,
      })),
    );
    const normal = vendors.filter((v) => !v.isCmp);
    const cmps = vendors.filter((v) => v.isCmp);
    this.cookiePatterns = compileNamePatterns(normal, (v) => v.cookies);
    this.storagePatterns = compileNamePatterns(normal, (v) => v.storageKeys);
    this.consentCookiePatterns = compileNamePatterns(cmps, (v) => v.cookies);
    this.consentStoragePatterns = compileNamePatterns(cmps, (v) => v.storageKeys);
    this.necessaryCookiePatterns = compileNamePatterns(normal, (v) => v.necessaryCookies ?? []);
    this.necessaryStoragePatterns = compileNamePatterns(
      normal,
      (v) => v.necessaryStorageKeys ?? [],
    );
  }

  static async create(opts: ClassifierOptions = {}): Promise<Classifier> {
    const vendors =
      opts.vendors ??
      (await loadVendors({
        ...(opts.vendorsFile ? { vendorsFile: opts.vendorsFile } : {}),
        ...(opts.extraVendorsFile ? { extraVendorsFile: opts.extraVendorsFile } : {}),
      }));
    const c = new Classifier(vendors);
    if (opts.easyPrivacyText !== undefined) {
      c.easyPrivacy = parseEasyPrivacyDomains(opts.easyPrivacyText);
    }
    if (opts.skipExternalData) {
      if (opts.easyPrivacyText === undefined) c.unavailable.push('easyprivacy');
      c.unavailable.push('dbip-country', 'dbip-asn');
      return c;
    }
    const p = dataPaths(opts.dataDir ? { dir: opts.dataDir } : {});
    if (c.easyPrivacy === undefined) {
      try {
        c.easyPrivacy = parseEasyPrivacyDomains(await readFile(p.easyPrivacy, 'utf8'));
      } catch {
        c.unavailable.push('easyprivacy');
      }
    }
    try {
      c.country = await maxmind.open<CountryResponse>(p.dbipCountry);
    } catch {
      c.unavailable.push('dbip-country');
    }
    try {
      c.asn = await maxmind.open<AsnResponse>(p.dbipAsn);
    } catch {
      c.unavailable.push('dbip-asn');
    }
    return c;
  }

  /** Look up vendor by host (most specific pattern wins). */
  matchVendor(host: string): { vendor: Vendor; pattern: string } | undefined {
    const h = host.toLowerCase().replace(/\.$/, '');
    let best: HostPattern | undefined;
    for (const hp of this.hostPatterns) {
      if (hp.re.test(h) && (!best || hp.spec > best.spec)) best = hp;
    }
    return best ? { vendor: best.vendor, pattern: best.pattern } : undefined;
  }

  lookupIp(ip: string): Classification['ipInfo'] | undefined {
    let country: string | undefined;
    let asn: number | undefined;
    let asOrg: string | undefined;
    try {
      country = this.country?.get(ip)?.country?.iso_code;
      const a = this.asn?.get(ip);
      asn = a?.autonomous_system_number;
      asOrg = a?.autonomous_system_organization;
    } catch {
      return undefined;
    }
    if (!country && asn === undefined) return undefined;
    const info: NonNullable<Classification['ipInfo']> = { ip };
    if (country) info.country = country;
    if (asn !== undefined) info.asn = asn;
    if (asOrg) info.asOrg = asOrg;
    return info;
  }

  classifyHost(hostIn: string, ctx: ClassifyContext): Classification {
    const host = hostIn.toLowerCase().replace(/\.$/, '');
    const site = siteHost(ctx.site);
    const registrable = getDomain(host, { allowPrivateDomains: true }) ?? undefined;
    const base: Classification = { host, stage: 'unbekannt', firstParty: false };
    if (registrable) base.registrableDomain = registrable;

    // 1. First party
    const siteReg = getDomain(site, { allowPrivateDomains: true }) ?? site;
    const isFirst =
      host === site ||
      (registrable !== undefined && registrable === siteReg) ||
      (ctx.firstPartyAliases ?? []).some((a) => {
        const alias = siteHost(a);
        return host === alias || host.endsWith('.' + alias);
      });
    if (isFirst) return { ...base, stage: 'first-party', firstParty: true, thirdCountry: false };

    // IP information (for all external hosts)
    let ipInfo: Classification['ipInfo'] | undefined;
    for (const ip of ctx.ips ?? []) {
      ipInfo = this.lookupIp(ip);
      if (ipInfo) break;
    }
    const ipOutside = ipInfo?.country ? !isEuEeaCountry(ipInfo.country) : undefined;
    const withIp = (c: Classification): Classification => {
      if (ipInfo) c.ipInfo = ipInfo;
      return c;
    };

    // 2. Customer allowlist
    for (const ap of ctx.allowedProcessors ?? []) {
      if (matchHostGlob(ap.host, host)) {
        const c = withIp({
          ...base,
          stage: 'allowlist',
          allowlist: { host: ap.host, reason: ap.reason },
        });
        const v = this.matchVendor(host)?.vendor;
        if (v) c.vendor = vendorInfo(v);
        const tc = v ? v.thirdCountry || ipOutside === true : ipOutside;
        if (tc !== undefined) c.thirdCountry = tc;
        return c;
      }
    }

    // 3. vendors.yaml
    const m = this.matchVendor(host);
    if (m) {
      const c = withIp({ ...base, stage: 'vendors', vendor: vendorInfo(m.vendor) });
      c.thirdCountry = m.vendor.thirdCountry || ipOutside === true;
      if (this.easyPrivacy && matchDomainSet(this.easyPrivacy, host)) c.easyPrivacy = true;
      return c;
    }

    // 4. EasyPrivacy
    if (this.easyPrivacy && matchDomainSet(this.easyPrivacy, host)) {
      const c = withIp({ ...base, stage: 'easyprivacy', easyPrivacy: true });
      if (ipOutside !== undefined) c.thirdCountry = ipOutside;
      return c;
    }

    // 5. DB-IP
    if (ipInfo) {
      const c = withIp({ ...base, stage: 'dbip' });
      if (ipOutside !== undefined) c.thirdCountry = ipOutside;
      return c;
    }
    return base;
  }

  /** Tracking cookie by name pattern (host-restricted patterns also need a matching domain). */
  matchTrackingCookie(name: string, domain?: string): TrackingMatch | undefined {
    if (this.isCmpConsentCookie(name)) return undefined;
    const dom = domain?.replace(/^\./, '').toLowerCase();
    for (const p of this.necessaryCookiePatterns) {
      if (!p.re.test(name)) continue;
      if (p.hostRe && !(dom && p.hostRe.test(dom))) continue;
      return { ...matchOf(p.vendor, p.pattern), necessary: true };
    }
    for (const p of this.cookiePatterns) {
      if (!p.re.test(name)) continue;
      if (p.hostRe && !(dom && p.hostRe.test(dom))) continue;
      return matchOf(p.vendor, p.pattern);
    }
    // A cookie set by a known advertising/analytics/social host counts as tracking.
    if (dom) {
      const m = this.matchVendor(dom);
      if (m && ['werbung', 'analyse', 'social'].includes(m.vendor.category) && !m.vendor.isCmp) {
        return matchOf(m.vendor, `domain:${m.pattern}`);
      }
    }
    return undefined;
  }

  matchTrackingStorageKey(key: string): TrackingMatch | undefined {
    if (this.isCmpConsentStorageKey(key)) return undefined;
    for (const p of this.necessaryStoragePatterns) {
      if (p.re.test(key)) return { ...matchOf(p.vendor, p.pattern), necessary: true };
    }
    for (const p of this.storagePatterns) {
      if (p.re.test(key)) return matchOf(p.vendor, p.pattern);
    }
    return undefined;
  }

  /** True for the consent-state cookie of a CMP (necessary, never a finding). */
  isCmpConsentCookie(name: string): boolean {
    return this.consentCookiePatterns.some((p) => p.re.test(name));
  }

  isCmpConsentStorageKey(key: string): boolean {
    return this.consentStoragePatterns.some((p) => p.re.test(key));
  }

  /** Vendor that provides a CMP matching this host (e.g. to name the CMP). */
  matchCmpVendor(host: string): Vendor | undefined {
    const m = this.matchVendor(host);
    return m?.vendor.isCmp ? m.vendor : undefined;
  }
}

function matchOf(v: Vendor, pattern: string): TrackingMatch {
  return { vendor: v.id, pattern, vendorName: v.name, category: v.category };
}

function vendorInfo(v: Vendor): NonNullable<Classification['vendor']> {
  const info: NonNullable<Classification['vendor']> = {
    id: v.id,
    name: v.name,
    category: v.category,
    fix: v.fix ?? defaultFix(v.category),
  };
  if (v.country) info.country = v.country;
  return info;
}
