/**
 * Location check at start (PLAN §4): determine the own exit IP (through the proxy, if any), look
 * up its country via DB-IP and warn if it is outside the EU/EEA (many CMPs only show the banner
 * to EU visitors).
 */
import { request } from 'playwright';
import { isEuEeaCountry } from '../classify/index.js';
import type { ProxyOptions } from '../browser/launch.js';
import type { ScanMetadata } from '../types.js';

export const IP_ECHO_SERVICE = 'https://api.ipify.org?format=json';

export interface ExitIpResult {
  ip?: string;
  country?: string;
  check: NonNullable<ScanMetadata['exitIpCheck']>;
}

export interface ExitIpOptions {
  proxy?: ProxyOptions;
  /** DB-IP lookup (Classifier.lookupIp). */
  lookupCountry: (ip: string) => string | undefined;
  service?: string;
  timeoutMs?: number;
}

/** Fetches the public IP via an IP echo service. */
export async function fetchExitIp(
  proxy: ProxyOptions | undefined,
  service = IP_ECHO_SERVICE,
  timeoutMs = 15_000,
): Promise<string> {
  const ctx = await request.newContext({ ...(proxy ? { proxy } : {}), timeout: timeoutMs });
  try {
    const res = await ctx.get(service);
    if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
    const body = (await res.text()).trim();
    let ip = body;
    try {
      const j = JSON.parse(body) as { ip?: string };
      if (typeof j.ip === 'string') ip = j.ip;
    } catch {
      // plain-text answer
    }
    if (!/^[0-9a-f:.]+$/i.test(ip)) throw new Error(`unerwartete Antwort „${body.slice(0, 60)}“`);
    return ip;
  } finally {
    await ctx.dispose().catch(() => {});
  }
}

export async function checkExitIp(opts: ExitIpOptions): Promise<ExitIpResult> {
  const service = opts.service ?? IP_ECHO_SERVICE;
  let ip: string;
  try {
    ip = await fetchExitIp(opts.proxy, service, opts.timeoutMs);
  } catch (err) {
    return {
      check: {
        status: 'fehlgeschlagen',
        service,
        message: `Exit-IP konnte nicht ermittelt werden (${(err as Error).message.split('\n')[0]}). Bitte sicherstellen, dass der Scan von einer EU-IP läuft – viele CMPs zeigen den Banner nur EU-Besuchern.`,
      },
    };
  }
  const country = opts.lookupCountry(ip);
  if (!country) {
    return {
      ip,
      check: {
        status: 'unbekannt',
        service,
        message: `Land der Exit-IP ${ip} unbekannt (DB-IP nicht verfügbar? → \`bello setup\`). Bitte sicherstellen, dass der Scan von einer EU-IP läuft.`,
      },
    };
  }
  const inEu = isEuEeaCountry(country);
  return {
    ip,
    country,
    check: inEu
      ? { status: 'ok', inEu, service }
      : {
          status: 'nicht-eu',
          inEu,
          service,
          message: `Achtung: Die Exit-IP ${ip} liegt in ${country}, nicht in der EU/im EWR. Viele CMPs zeigen den Banner nur EU-Besuchern – Ergebnisse können abweichen. Empfehlung: Scan über einen EU-Proxy (--proxy) oder von einem Server in Deutschland ausführen.`,
        },
  };
}
