import { readFileSync } from 'node:fs';

/** Bello version from package.json (works from both `src/` and `dist/`). */
export const BELLO_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
