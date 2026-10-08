/**
 * Host glob matching. A leading `*.` matches any number of subdomain labels and the bare apex
 * domain (`*.example.com` matches `a.b.example.com` and `example.com`). Every other `*` matches
 * within a single label only (`[^.]*`), so `cdn.kunde.de*` does NOT match
 * `cdn.kunde.de.evil.com` and `kunde-*.net` does not match `kunde-x.evil.net`.
 */
export function hostGlobToRegExp(pattern: string): RegExp {
  const p = pattern.trim().toLowerCase();
  const escape = (s: string): string =>
    s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]*');
  if (p.startsWith('*.')) {
    return new RegExp(`^(?:.*\\.)?${escape(p.slice(2))}$`);
  }
  return new RegExp(`^${escape(p)}$`);
}

export function matchHostGlob(pattern: string, host: string): boolean {
  return hostGlobToRegExp(pattern).test(host.toLowerCase().replace(/\.$/, ''));
}

/** Number of literal (non-wildcard) characters; used to prefer the most specific pattern. */
export function globSpecificity(pattern: string): number {
  return pattern.replace(/\*/g, '').length;
}
