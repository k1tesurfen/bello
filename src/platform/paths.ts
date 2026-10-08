import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PathEnv {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

/** Cache directory of Bello: XDG on Linux, ~/Library/Caches on macOS, %LOCALAPPDATA% on Windows. */
export function cacheDir(opts: PathEnv = {}): string {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const override = env['BELLO_CACHE_DIR'];
  if (override) return override;
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'bello');
  if (platform === 'win32')
    return join(env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), 'bello', 'Cache');
  const xdg = env['XDG_CACHE_HOME'];
  return join(xdg && xdg.startsWith('/') ? xdg : join(home, '.cache'), 'bello');
}

export interface DataPaths {
  dir: string;
  easyPrivacy: string;
  dbipCountry: string;
  dbipAsn: string;
  /** JSON file with download dates per dataset. */
  meta: string;
}

export function dataPaths(opts: PathEnv & { dir?: string } = {}): DataPaths {
  const dir = opts.dir ?? cacheDir(opts);
  return {
    dir,
    easyPrivacy: join(dir, 'easyprivacy.txt'),
    dbipCountry: join(dir, 'dbip-country.mmdb'),
    dbipAsn: join(dir, 'dbip-asn.mmdb'),
    meta: join(dir, 'data-meta.json'),
  };
}
