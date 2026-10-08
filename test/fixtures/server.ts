/**
 * Hermetic fixture web server (PLAN §15).
 *
 * One TCP port on 127.0.0.1 (random) serves every fake host, over plain HTTP *and* HTTPS
 * (protocol sniffing on the first byte). Chromium is started with `--host-resolver-rules`
 * mapping those hosts to this port, so fixture pages can reference e.g.
 * `http://www.youtube.com/embed/…` and the browser treats it as a real third party
 * (separate site, own socket, own process for iframes) while everything stays offline.
 *
 * Why HTTPS too: Chromium's built-in HSTS preload list upgrades `http://www.youtube.com`,
 * `fonts.googleapis.com` etc. to https:// internally (307 Internal Redirect). The server therefore
 * also speaks TLS with a self-signed certificate (`tls/`), and tests launch Chromium with
 * `--ignore-certificate-errors` (see {@link FixtureServer.chromiumArgs}).
 *
 * Content lookup for a request to `<scheme>://<host>/<path>`:
 *   1. custom route registered via {@link FixtureServer.route}
 *   2. `<sitesRoot>/<site>/<host>/<path>` where `<site>` is the fixture chosen via `useSite`
 *   3. `<sitesRoot>/_shared/<host>/<path>`        (shared stubs, e.g. the simulated CMP)
 *   4. first-party host: 404; third-party host: generic empty 200 typed by extension
 * A trailing `/` maps to `index.html`. Query `?delay=<ms>` delays the response.
 */
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SITES_ROOT = path.join(FIXTURES_DIR, 'sites');

/** First-party host of all fixtures. */
export const FIRST_PARTY_HOST = 'www.kunde-test.de';

/** Fake third-party hosts mapped to the fixture server. */
export const THIRD_PARTY_HOSTS: readonly string[] = [
  'www.youtube.com',
  'www.youtube-nocookie.com',
  'i.ytimg.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'www.googletagmanager.com',
  'www.google-analytics.com',
  'region1.google-analytics.com',
  'stats.g.doubleclick.net',
  'connect.facebook.net',
  'www.facebook.com',
  'maps.googleapis.com',
  'cdn.jsdelivr.net',
  'app.usercentrics.eu',
  'static.hotjar.com',
  'unknown-tracker.example',
];

export const FIXTURE_HOSTS: readonly string[] = [
  FIRST_PARTY_HOST,
  'kunde-test.de',
  ...THIRD_PARTY_HOSTS,
];

export interface ServedRequest {
  scheme: 'http' | 'https';
  host: string;
  method: string;
  /** Path incl. query. */
  path: string;
  /** Epoch ms when the request arrived. */
  time: number;
  status: number;
}

/** Custom handler; return `true` if the request was handled. */
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => boolean | Promise<boolean>;

export interface FixtureServer {
  port: number;
  /** All requests served so far (useful for assertions). */
  requests: ServedRequest[];
  /** Selects the fixture site directory (under `sitesRoot`) used for subsequent requests. */
  useSite(site: string): void;
  /** Registers a custom response for `host` + exact pathname. */
  route(host: string, pathname: string, handler: RouteHandler): void;
  /** `http://www.kunde-test.de<pathname>` – the URL to navigate to. */
  url(pathname?: string, host?: string): string;
  /** `--host-resolver-rules=…` switch for Chromium. */
  resolverArg(): string;
  /** All Chromium switches needed for fixture tests (resolver rules + accept test cert). */
  chromiumArgs(): string[];
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** 1×1 transparent GIF for pixel requests. */
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/**
 * Builds the value of Chromium's `--host-resolver-rules` mapping each host to `127.0.0.1:<port>`.
 * Everything else resolves to NOTFOUND so tests can never leak to the real internet.
 */
export function hostResolverRules(port: number, hosts: readonly string[] = FIXTURE_HOSTS): string {
  const rules = hosts.map((h) => `MAP ${h} 127.0.0.1:${port}`);
  rules.push('MAP * ~NOTFOUND', 'EXCLUDE localhost', 'EXCLUDE 127.0.0.1');
  return rules.join(',');
}

async function fileIfExists(file: string): Promise<string | undefined> {
  try {
    return (await stat(file)).isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}

export async function startFixtureServer(
  opts: { site?: string; sitesRoot?: string } = {},
): Promise<FixtureServer> {
  const sitesRoot = opts.sitesRoot ?? SITES_ROOT;
  let site = opts.site ?? 'default';
  const requests: ServedRequest[] = [];
  const routes = new Map<string, RouteHandler>();

  const handle = async (
    scheme: 'http' | 'https',
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    const url = new URL(req.url ?? '/', 'http://x');
    const record = (status: number): void => {
      requests.push({
        scheme,
        host,
        method: req.method ?? 'GET',
        path: url.pathname + url.search,
        time: Date.now(),
        status,
      });
    };

    const delay = Number(url.searchParams.get('delay') ?? 0);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));

    const custom = routes.get(`${host}${url.pathname}`);
    if (custom && (await custom(req, res))) {
      record(res.statusCode);
      return;
    }

    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    // Prevent path traversal outside the host directory.
    rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');

    let file: string | undefined;
    for (const c of [
      path.join(sitesRoot, site, host, rel),
      path.join(sitesRoot, '_shared', host, rel),
    ]) {
      if ((file = await fileIfExists(c))) break;
    }

    const ext = path.extname(rel).toLowerCase();
    if (file) {
      // Extension-less fixture files are HTML documents (e.g. `/embed/<videoId>`).
      const type = ext === '' ? MIME['.html'] : (MIME[ext] ?? 'application/octet-stream');
      res.writeHead(200, { 'content-type': type });
      res.end(await readFile(file));
      record(200);
    } else if (host === FIRST_PARTY_HOST || host === 'kunde-test.de') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Nicht gefunden');
      record(404);
    } else if (ext === '.gif') {
      res.writeHead(200, { 'content-type': 'image/gif' });
      res.end(PIXEL);
      record(200);
    } else {
      // Generic third-party stub: empty resource of the right type (extension-less = HTML).
      const isHtml = ext === '' || ext === '.html';
      res.writeHead(200, { 'content-type': isHtml ? MIME['.html'] : (MIME[ext] ?? 'text/plain') });
      res.end(isHtml ? `<!doctype html><title>${host}</title><p>${host}</p>` : '');
      record(200);
    }
  };

  const onError = (res: ServerResponse) => (err: unknown) => {
    if (!res.headersSent) res.writeHead(500);
    res.end(String(err));
  };
  const httpServer = createHttpServer((req, res) => {
    handle('http', req, res).catch(onError(res));
  });
  const httpsServer = createHttpsServer(
    {
      key: readFileSync(path.join(FIXTURES_DIR, 'tls', 'key.pem')),
      cert: readFileSync(path.join(FIXTURES_DIR, 'tls', 'cert.pem')),
    },
    (req, res) => {
      handle('https', req, res).catch(onError(res));
    },
  );

  // Protocol sniffing: TLS records start with 0x16 (handshake).
  const sockets = new Set<Socket>();
  const tcp = createNetServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.once('data', (buf) => {
      socket.pause();
      socket.unshift(buf);
      (buf[0] === 0x16 ? httpsServer : httpServer).emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  });
  await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
  const { port } = tcp.address() as AddressInfo;

  const resolverArg = (): string => `--host-resolver-rules=${hostResolverRules(port)}`;

  return {
    port,
    requests,
    useSite(s) {
      site = s;
    },
    route(host, pathname, handler) {
      routes.set(`${host}${pathname}`, handler);
    },
    url(pathname = '/', host = FIRST_PARTY_HOST) {
      return `http://${host}${pathname}`;
    },
    resolverArg,
    chromiumArgs() {
      return [resolverArg(), '--ignore-certificate-errors'];
    },
    close() {
      for (const s of sockets) s.destroy();
      httpServer.closeAllConnections();
      httpsServer.closeAllConnections();
      return new Promise<void>((resolve, reject) =>
        tcp.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
