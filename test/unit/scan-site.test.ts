import { describe, expect, it } from 'vitest';
import { geoIps, redactCommandLine, scenarioBudgetFromEnv } from '../../src/scan/scan-site.js';

describe('scan-site Hilfsfunktionen', () => {
  it('entfernt Zugangsdaten aus der Kommandozeile', () => {
    const out = redactCommandLine([
      'node',
      'bello',
      'https://user:geheim@www.kunde.de/',
      '--proxy',
      'http://proxyuser:proxypass@proxy.example:3128',
      '--proxy=socks5://a:b@socks.example:1080',
      '--wait',
      '5',
    ]);
    const joined = out.join(' ');
    expect(joined).not.toContain('geheim');
    expect(joined).not.toContain('proxypass');
    expect(joined).not.toContain('proxyuser');
    expect(joined).not.toMatch(/a:b@/);
    expect(out[2]).toBe('https://***@www.kunde.de/');
    expect(out[4]).toContain('proxy.example:3128');
    expect(out.slice(-2)).toEqual(['--wait', '5']);
  });
  it('lässt Proxy ohne Zugangsdaten unverändert', () => {
    expect(redactCommandLine(['--proxy', 'http://proxy.example:3128'])).toEqual([
      '--proxy',
      'http://proxy.example:3128',
    ]);
  });
  it('liest das Zeitbudget aus BELLO_SCENARIO_BUDGET_S', () => {
    expect(scenarioBudgetFromEnv({ BELLO_SCENARIO_BUDGET_S: '90' })).toBe(90_000);
    expect(scenarioBudgetFromEnv({})).toBeUndefined();
    expect(scenarioBudgetFromEnv({ BELLO_SCENARIO_BUDGET_S: 'x' })).toBeUndefined();
  });
  it('geolokalisiert hinter einem Proxy nicht die Socket-IP (Proxy), sondern nur DNS-Antworten', () => {
    const c = { remoteIps: ['10.0.0.1'], dns: { startTime: 0, addresses: ['142.250.1.1'] } };
    expect(geoIps(c, false)).toEqual(['10.0.0.1']);
    expect(geoIps(c, true)).toEqual(['142.250.1.1']);
    expect(geoIps({ remoteIps: ['10.0.0.1'] }, true)).toEqual([]);
  });
});
