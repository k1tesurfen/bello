/**
 * Extract plain domain rules (`||domain^`, optionally with only the `third-party` option)
 * from an EasyPrivacy/Adblock-Plus filter list. Everything else (paths, wildcards,
 * exceptions, element hiding, other options) is ignored on purpose.
 */
export function parseEasyPrivacyDomains(text: string): Set<string> {
  const out = new Set<string>();
  const re = /^\|\|([a-z0-9][a-z0-9.-]*[a-z0-9])\^(?:\$(.+))?$/;
  for (const lineRaw of text.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line.startsWith('||')) continue;
    const m = re.exec(line);
    if (!m) continue;
    const opts = m[2];
    if (opts !== undefined) {
      const list = opts.split(',').map((o) => o.trim());
      if (!list.every((o) => o === 'third-party' || o === '3p')) continue;
    }
    out.add(m[1] as string);
  }
  return out;
}

/** True if `host` or one of its parent domains is in `domains`. */
export function matchDomainSet(domains: ReadonlySet<string>, host: string): boolean {
  let h = host.toLowerCase().replace(/\.$/, '');
  for (;;) {
    if (domains.has(h)) return true;
    const i = h.indexOf('.');
    if (i < 0) return false;
    h = h.slice(i + 1);
    if (!h.includes('.')) return domains.has(h);
  }
}
