import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

/** `2026-10-08T12-34-56Z` (PLAN §10). */
export function reportTimestamp(d: Date): string {
  return d
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-');
}

/** Host name (plus non-default port, `example.de_8080`) used as directory name. */
export function domainOf(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname
      .toLowerCase()
      .replace(/[^a-z0-9.-]/g, '_')
      .replace(/^\[|\]$/g, '');
    // Dot-only or empty hosts (`..`, `.`) would escape the output directory.
    if (!host || /^\.+$/.test(host)) return 'unbekannt';
    return u.port ? `${host}_${u.port}` : host;
  } catch {
    return 'unbekannt';
  }
}

/** Evidence sub-directory name of a page in multi-page scans, e.g. `01-startseite`. */
export function pageSlug(url: string, index: number): string {
  let p: string;
  try {
    const u = new URL(url);
    p = (u.pathname + (u.search ? `-${u.search.slice(1)}` : ''))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  } catch {
    p = '';
  }
  const name = (p || 'startseite').slice(0, 60).replace(/-+$/, '');
  return `${String(index + 1).padStart(2, '0')}-${name}`;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Creates `<outDir>/<domain>/<timestamp>/` (suffix `-2`, `-3`, … if it already exists). */
export async function createReportDir(outDir: string, url: string, at: Date): Promise<string> {
  const domainDir = path.resolve(outDir, domainOf(url));
  const root = path.resolve(outDir);
  if (path.dirname(domainDir) !== root)
    throw new Error('Ungültiger Host für das Berichtsverzeichnis.');
  const base = path.join(domainDir, reportTimestamp(at));
  let dir = base;
  for (let i = 2; await exists(dir); i++) dir = `${base}-${i}`;
  await mkdir(dir, { recursive: true });
  return dir;
}
