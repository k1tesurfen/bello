import { chromium } from 'playwright';
import { ConfigError } from '../config/index.js';
import { translateStartupError } from '../platform/errors.js';
import { BrowserStartError } from '../scan/index.js';

/**
 * German message for an error that aborts a command. For browser start failures the launch is
 * repeated once to get Playwright's full error text for {@link translateStartupError}.
 */
export async function describeError(err: unknown): Promise<string> {
  if (err instanceof ConfigError) return err.message;
  if (err instanceof BrowserStartError) {
    let detail: unknown = err;
    try {
      const b = await chromium.launch({ channel: 'chromium', timeout: 30_000 });
      await b.close();
    } catch (launchErr) {
      detail = launchErr;
    }
    return (
      translateStartupError(detail) ??
      translateStartupError(err) ??
      `${err.message}\nFühre \`bello doctor\` aus, um die Umgebung zu prüfen.`
    );
  }
  const translated = translateStartupError(err);
  if (translated) return translated;
  const msg = err instanceof Error ? err.message : String(err);
  return `Unerwarteter Fehler: ${msg}`;
}
