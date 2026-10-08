/**
 * Normalize user input to an absolute http(s) URL. Adds https:// if no scheme
 * is present. Returns null if the result is not a valid http(s) URL.
 */
export function tryNormalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === '' || /\s/.test(trimmed)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname;
  const plausible = host.includes('.') || host === 'localhost' || host.startsWith('[');
  if (!plausible) return null;
  return url.toString();
}
