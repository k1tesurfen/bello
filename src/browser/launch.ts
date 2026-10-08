/**
 * Browser launch for one scenario run (PLAN §3/§4).
 *
 * Every scenario gets its own Chromium *process* because the NetLog is written per process.
 * The browser runs Playwright's full Chromium build in "new headless" mode
 * (`channel: 'chromium'`), not the separate headless shell.
 */
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { CdpClient } from '../capture/cdp/client.js';
import { BELLO_VERSION } from '../version.js';

/** NetLog capture modes understood by Chromium's `--net-log-capture-mode`. */
export type NetLogCaptureMode = 'Default' | 'IncludeSensitive' | 'Everything';

export interface ProxyOptions {
  /** e.g. `http://proxy:3128` or `socks5://proxy:1080`. */
  server: string;
  username?: string;
  password?: string;
  bypass?: string;
}

export interface LaunchOptions {
  /** Where Chromium writes its NetLog JSON. Directory is created if missing. */
  netLogPath: string;
  netLogCaptureMode?: NetLogCaptureMode;
  /** If set, Playwright records a HAR for the context (written on {@link ScenarioBrowser.close}). */
  harPath?: string;
  /** Embed response bodies in the HAR. Default: omit (keeps evidence small). */
  harContent?: 'omit' | 'embed';
  /** Run with a visible window (debugging, `--headful`). */
  headful?: boolean;
  proxy?: ProxyOptions;
  /** Additional Chromium switches, e.g. `--host-resolver-rules=…` in tests. */
  extraArgs?: string[];
  /** Append ` Bello/<version>` to the user agent (`--identify`). */
  identify?: boolean;
  /** Override the Chromium executable (e.g. a pinned build in Docker). */
  executablePath?: string;
  /** Launch timeout in ms (default 30 s). */
  timeoutMs?: number;
  /**
   * Open a DevTools port on 127.0.0.1 for Bello's own CDP capture (default: true).
   * See `capture/cdp` – Playwright's API cannot observe out-of-process iframes' sessions.
   */
  cdp?: boolean;
}

export interface ScenarioBrowser {
  browser: Browser;
  context: BrowserContext;
  /** User agent actually used by the context. */
  userAgent: string;
  /** Chromium version, e.g. `156.0.8078.4`. */
  browserVersion: string;
  netLogPath: string;
  harPath?: string;
  /** Browser-level DevTools WebSocket URL (if `cdp` was enabled). */
  cdpEndpoint?: string;
  /** PID of the Chromium browser process (if it could be determined). */
  pid?: number;
  /**
   * Closes context (flushes HAR) and browser (finalises NetLog). Safe to call more than once.
   * Always call this before parsing the NetLog.
   *
   * The graceful close races against `timeoutMs` (default 30 s). If it does not finish in time
   * (hung renderer, HAR flush of a huge page, …) the browser process is force-killed and the
   * returned promise rejects with {@link BrowserCloseTimeoutError} – the NetLog is then
   * truncated and the scenario must be treated as incomplete.
   */
  close(timeoutMs?: number): Promise<void>;
  /** Force-kills the browser process (SIGKILL). Never throws. Returns true if a kill was sent. */
  kill(): boolean;
}

/** Graceful browser close did not finish in time; the process was force-killed. */
export class BrowserCloseTimeoutError extends Error {
  override name = 'BrowserCloseTimeoutError';
  constructor(
    timeoutMs: number,
    readonly killed: boolean,
  ) {
    super(
      `Browser ließ sich nicht innerhalb von ${Math.round(timeoutMs / 1000)} s schließen` +
        (killed ? ' und wurde zwangsweise beendet.' : '; Zwangsbeendigung war nicht möglich.'),
    );
  }
}

/**
 * Features disabled by Playwright itself. Chromium honours only the *last* `--disable-features`
 * switch, so we must repeat Playwright's list when passing our own.
 * Keep in sync with playwright-core `chromiumSwitches.ts` when upgrading Playwright.
 */
const PLAYWRIGHT_DISABLED_FEATURES = [
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  'DestroyProfileOnBrowserClose',
  'DialMediaRouteProvider',
  'GlobalMediaControls',
  'HttpsUpgrades',
  'LensOverlay',
  'MediaRouter',
  'PaintHolding',
  'ThirdPartyStoragePartitioning',
  'BlockOriginHeaderModificationOnRedirect',
  'Translate',
  'AutoDeElevate',
  'OptimizationHints',
  'NetworkTimeServiceQuerying',
  'AimEnabled',
];

/** Additional features Bello disables to suppress Chrome's own background traffic. */
const BELLO_DISABLED_FEATURES = [
  // DNS over HTTPS would hide DNS resolutions from the NetLog's HOST_RESOLVER events.
  'DnsOverHttps',
  'CertificateTransparencyComponentUpdater',
  'AutofillServerCommunication',
  'InterestFeedContentSuggestions',
  'OptimizationGuideModelDownloading',
  'OptimizationHintsFetching',
  // Chrome preconnects to the default search engine (www.google.com) on startup.
  'PreconnectToSearch',
  'PreconnectToSearchDesktop',
];

/** Chromium switches suppressing background networking (PLAN §4). */
export const BACKGROUND_TRAFFIC_ARGS: readonly string[] = [
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-client-side-phishing-detection',
  '--safebrowsing-disable-auto-update',
  '--disable-sync',
  '--no-pings',
  '--no-first-run',
  '--no-default-browser-check',
  '--metrics-recording-only',
  '--disable-breakpad',
  `--disable-features=${[...PLAYWRIGHT_DISABLED_FEATURES, ...BELLO_DISABLED_FEATURES].join(',')}`,
];

/**
 * Hosts contacted by Chromium itself (updates, Safe Browsing, field trials, …), never by the
 * page. Analysis ignores connections to these hosts **unless** a page request is correlated
 * with them (see {@link isChromeInternalHost}).
 */
export const CHROME_INTERNAL_HOSTS: readonly string[] = [
  'clients1.google.com',
  'clients2.google.com',
  'clients3.google.com',
  'clients4.google.com',
  'clients5.google.com',
  'clients6.google.com',
  'clientservices.googleapis.com',
  'update.googleapis.com',
  'safebrowsing.googleapis.com',
  'safebrowsing.google.com',
  'sb-ssl.google.com',
  'content-autofill.googleapis.com',
  'optimizationguide-pa.googleapis.com',
  'android.clients.google.com',
  'chromewebstore.googleapis.com',
  'redirector.gvt1.com',
  'edgedl.me.gvt1.com',
  'dl.google.com',
  'dns.google',
  'chrome.cloudflare-dns.com',
];

/** Host suffixes used exclusively by Chrome internals. */
const CHROME_INTERNAL_SUFFIXES = ['.gvt1.com', '.gvt2.com'];

/** True if the host is known Chrome background traffic (exact match or internal suffix). */
export function isChromeInternalHost(host: string): boolean {
  const h = host.toLowerCase();
  return CHROME_INTERNAL_HOSTS.includes(h) || CHROME_INTERNAL_SUFFIXES.some((s) => h.endsWith(s));
}

/** Platform token for a realistic desktop UA matching the host OS (keeps navigator.platform consistent). */
function uaPlatformToken(): string {
  switch (os.platform()) {
    case 'darwin':
      return 'Macintosh; Intel Mac OS X 10_15_7';
    case 'win32':
      return 'Windows NT 10.0; Win64; x64';
    default:
      return 'X11; Linux x86_64';
  }
}

/**
 * Builds a desktop Chrome UA like real Chrome (reduced UA: only the major version is exposed).
 * Never contains "Headless".
 */
export function buildUserAgent(browserVersion: string, identify = false): string {
  const major = browserVersion.split('.')[0] ?? '0';
  const ua =
    `Mozilla/5.0 (${uaPlatformToken()}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${major}.0.0.0 Safari/537.36`;
  return identify ? `${ua} Bello/${BELLO_VERSION}` : ua;
}

/** Finds a free TCP port on 127.0.0.1. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Resolves the browser-level DevTools WebSocket URL from the debugging port. */
async function devtoolsEndpoint(port: number, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      const json = (await res.json()) as { webSocketDebuggerUrl?: string };
      if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`DevTools-Endpunkt auf Port ${port} nicht erreichbar: ${String(lastErr)}`);
}

/** Asks the browser for its own PID via CDP (`SystemInfo.getProcessInfo`). */
async function browserPidViaCdp(wsUrl: string): Promise<number | undefined> {
  let client: CdpClient | undefined;
  try {
    client = await CdpClient.connect(wsUrl, 5_000);
    const info = await Promise.race([
      client.send<{ processInfo?: Array<{ type?: string; id?: number }> }>(
        'SystemInfo.getProcessInfo',
      ),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 5_000).unref()),
    ]);
    const pid = info?.processInfo?.find((p) => p.type === 'browser')?.id;
    return typeof pid === 'number' && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  } finally {
    client?.close();
  }
}

/** Linux fallback: finds the browser process by its unique `--log-net-log=<path>` switch. */
async function browserPidViaProc(netLogPath: string): Promise<number | undefined> {
  if (os.platform() !== 'linux') return undefined;
  const needle = `--log-net-log=${netLogPath}`;
  let entries: string[];
  try {
    entries = await readdir('/proc');
  } catch {
    return undefined;
  }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const cmd = (await readFile(`/proc/${e}/cmdline`, 'utf8')).split('\0');
      // The browser process has no --type= switch (renderers/GPU/utility processes do).
      if (cmd.includes(needle) && !cmd.some((a) => a.startsWith('--type='))) return Number(e);
    } catch {
      /* process vanished */
    }
  }
  return undefined;
}

/** Launches a fresh Chromium process + context configured for one scenario run. */
export async function launchScenarioBrowser(opts: LaunchOptions): Promise<ScenarioBrowser> {
  await mkdir(path.dirname(opts.netLogPath), { recursive: true });
  if (opts.harPath) await mkdir(path.dirname(opts.harPath), { recursive: true });

  const cdpPort = opts.cdp === false ? undefined : await freePort();
  const args = [
    ...BACKGROUND_TRAFFIC_ARGS,
    ...(cdpPort ? [`--remote-debugging-port=${cdpPort}`] : []),
    `--log-net-log=${opts.netLogPath}`,
    `--net-log-capture-mode=${opts.netLogCaptureMode ?? 'Default'}`,
    ...(opts.extraArgs ?? []),
  ];

  const browser = await chromium.launch({
    channel: 'chromium', // full Chromium in new headless mode
    headless: !opts.headful,
    args,
    ...(opts.proxy ? { proxy: opts.proxy } : {}),
    ...(opts.executablePath ? { executablePath: opts.executablePath } : {}),
    timeout: opts.timeoutMs ?? 30_000,
  });

  const browserVersion = browser.version();
  const userAgent = buildUserAgent(browserVersion, opts.identify);

  let context: BrowserContext;
  let cdpEndpoint: string | undefined;
  try {
    if (cdpPort) cdpEndpoint = await devtoolsEndpoint(cdpPort);
    context = await browser.newContext({
      locale: 'de-DE',
      timezoneId: 'Europe/Berlin',
      viewport: { width: 1920, height: 1080 },
      userAgent,
      extraHTTPHeaders: { 'Accept-Language': 'de-DE,de' },
      ...(opts.harPath
        ? { recordHar: { path: opts.harPath, content: opts.harContent ?? 'omit' } }
        : {}),
    });
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }

  const pid =
    (cdpEndpoint ? await browserPidViaCdp(cdpEndpoint) : undefined) ??
    (await browserPidViaProc(opts.netLogPath));

  const kill = (): boolean => {
    if (!pid) return false;
    try {
      process.kill(pid, 'SIGKILL');
      return true;
    } catch {
      return false; // already gone
    }
  };

  let graceful: Promise<void> | undefined;
  let closed: Promise<void> | undefined;
  const close = (timeoutMs = 30_000): Promise<void> => {
    graceful ??= (async () => {
      try {
        await context.close();
      } finally {
        await browser.close();
      }
    })();
    closed ??= new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const killed = kill();
        // Let Playwright notice the dead process; never wait on it again.
        void browser.close().catch(() => {});
        reject(new BrowserCloseTimeoutError(timeoutMs, killed));
      }, timeoutMs);
      graceful!.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
    return closed;
  };

  return {
    browser,
    context,
    userAgent,
    browserVersion,
    netLogPath: opts.netLogPath,
    ...(opts.harPath ? { harPath: opts.harPath } : {}),
    ...(cdpEndpoint ? { cdpEndpoint } : {}),
    ...(pid ? { pid } : {}),
    close,
    kill,
  };
}
