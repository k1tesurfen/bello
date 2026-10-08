/**
 * Storage capture (PLAN §5.3): cookies, localStorage/sessionStorage keys, IndexedDB names.
 */
import { getDomain } from 'tldts';
import type { BrowserContext, Frame } from 'playwright';
import type {
  CookieRecord,
  SetCookieRecord,
  StorageCheckpoint,
  StorageRecord,
} from '../../types.js';

export interface StorageSnapshot {
  cookies: CookieRecord[];
  storage: StorageRecord[];
  /**
   * URLs of frames whose storage could not be read because they did not answer in time (busy or
   * hung renderer). Their storage is unknown – callers must not treat the snapshot as complete.
   * Detached frames and frames navigating away are not listed (they no longer exist).
   */
  unreadableFrames: string[];
}

/** Max. time to read one frame's storage. */
export const FRAME_READ_TIMEOUT_MS = 5_000;

function registrableDomain(hostOrUrl: string): string {
  let host = hostOrUrl;
  try {
    host = new URL(hostOrUrl).hostname;
  } catch {
    /* already a host */
  }
  host = host.replace(/^\./, '').toLowerCase();
  return getDomain(host, { allowPrivateDomains: true }) ?? host;
}

/** First-party = cookie domain shares the registrable domain of the scanned site. */
export function isFirstPartyDomain(cookieDomain: string, siteUrl: string): boolean {
  return registrableDomain(cookieDomain) === registrableDomain(siteUrl);
}

function preview(len: number): string {
  return `Länge ${len}`;
}

interface FrameStorage {
  local: [string, number][];
  session: [string, number][];
  idb: string[];
  origin: string;
}

/** Evaluated inside each frame (string: the project has no DOM typings). */
const PAGE_SCRIPT = `(async () => {
  const dump = (get) => {
    try {
      const st = get();
      const out = [];
      for (let i = 0; i < st.length; i++) {
        const k = st.key(i);
        if (k !== null) out.push([k, (st.getItem(k) || '').length]);
      }
      return out;
    } catch (e) {
      return []; // storage blocked (sandboxed iframe, cookies disabled)
    }
  };
  let idb = [];
  try {
    const dbs = await indexedDB.databases();
    idb = dbs.map((d) => d.name || '').filter(Boolean);
  } catch (e) {}
  return { local: dump(() => localStorage), session: dump(() => sessionStorage), idb, origin: location.origin };
})()`;

const TIMEOUT = Symbol('timeout');

async function readFrame(
  frame: Frame,
  timeoutMs: number,
): Promise<FrameStorage | undefined | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      frame.evaluate(PAGE_SCRIPT) as Promise<FrameStorage>,
      new Promise<typeof TIMEOUT>((r) => {
        timer = setTimeout(() => r(TIMEOUT), timeoutMs);
      }),
    ]);
  } catch {
    return undefined; // detached frame, navigation in flight, about:blank without origin ...
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Snapshot of all cookies of the context plus web storage of every frame (incl. cross-origin
 * iframes) of every open page. `siteUrl` defines "first party".
 */
export async function collectStorage(
  context: BrowserContext,
  checkpoint: StorageCheckpoint,
  siteUrl: string,
  opts: { frameTimeoutMs?: number } = {},
): Promise<StorageSnapshot> {
  const cookies: CookieRecord[] = (await context.cookies()).map((c) => {
    const rec: CookieRecord = {
      name: c.name,
      domain: c.domain,
      path: c.path,
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      firstParty: isFirstPartyDomain(c.domain, siteUrl),
      source: 'context',
      checkpoint,
      valuePreview: preview(c.value.length),
    };
    if (c.sameSite) rec.sameSite = c.sameSite;
    return rec;
  });

  const storage: StorageRecord[] = [];
  const unreadableFrames: string[] = [];
  const seen = new Set<string>();
  const frameTimeout = opts.frameTimeoutMs ?? FRAME_READ_TIMEOUT_MS;
  for (const page of context.pages()) {
    // Frames are read in parallel: one hung frame must not delay the others.
    const frames = page.frames();
    const results = await Promise.all(frames.map((f) => readFrame(f, frameTimeout)));
    for (const [i, frame] of frames.entries()) {
      const data = results[i];
      if (data === TIMEOUT) {
        // Frames without a committed document of their own (empty URL, about:blank/srcdoc) never
        // get an execution context – Playwright's evaluate would wait forever (observed on
        // heise.de). They share their creator's origin, whose storage is read via that frame.
        const u = frame.url();
        if (!frame.isDetached() && u !== '' && !u.startsWith('about:')) unreadableFrames.push(u);
        continue;
      }
      if (!data || data.origin === 'null') continue;
      const frameUrl = frame.url();
      const push = (kind: StorageRecord['kind'], key: string, len?: number): void => {
        const id = `${kind}|${data.origin}|${key}`;
        if (seen.has(id)) return;
        seen.add(id);
        const rec: StorageRecord = { kind, origin: data.origin, frameUrl, key, checkpoint };
        if (len !== undefined) rec.valuePreview = preview(len);
        storage.push(rec);
      };
      for (const [k, l] of data.local) push('localStorage', k, l);
      for (const [k, l] of data.session) push('sessionStorage', k, l);
      for (const n of data.idb) push('indexedDB', n);
    }
  }
  return { cookies, storage, unreadableFrames };
}

/** Parses name/domain/attributes from a raw Set-Cookie line. */
function parseSetCookie(raw: string): {
  name: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  valueLength: number;
} {
  const [pair = '', ...attrs] = raw.split(';');
  const eq = pair.indexOf('=');
  const name = (eq >= 0 ? pair.slice(0, eq) : pair).trim();
  const value = eq >= 0 ? pair.slice(eq + 1).trim() : '';
  const out: ReturnType<typeof parseSetCookie> = {
    name,
    httpOnly: false,
    secure: false,
    valueLength: value.length,
  };
  for (const a of attrs) {
    const i = a.indexOf('=');
    const k = (i >= 0 ? a.slice(0, i) : a).trim().toLowerCase();
    const v = i >= 0 ? a.slice(i + 1).trim() : '';
    if (k === 'domain') out.domain = v.replace(/^\./, '');
    else if (k === 'path') out.path = v;
    else if (k === 'httponly') out.httpOnly = true;
    else if (k === 'secure') out.secure = true;
    else if (k === 'samesite') {
      const s = v.toLowerCase();
      if (s === 'strict') out.sameSite = 'Strict';
      else if (s === 'lax') out.sameSite = 'Lax';
      else if (s === 'none') out.sameSite = 'None';
    } else if (k === 'max-age' && /^-?\d+$/.test(v)) {
      out.expires = Date.now() / 1000 + Number(v);
    } else if (k === 'expires' && out.expires === undefined) {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) out.expires = t / 1000;
    }
  }
  return out;
}

/**
 * Converts CDP Set-Cookie records (incl. blocked ones) into CookieRecords.
 * `requestHost` is the host of the response; used when the cookie has no Domain attribute.
 */
export function cookiesFromSetCookieRecords(
  records: SetCookieRecord[],
  requestHost: string,
  siteUrl: string,
  checkpoint?: StorageCheckpoint,
): CookieRecord[] {
  return records.map((r) => {
    const p = parseSetCookie(r.raw);
    const domain = r.domain ?? p.domain ?? requestHost;
    const rec: CookieRecord = {
      name: r.name ?? p.name,
      domain,
      path: p.path ?? '/',
      expires: p.expires ?? -1,
      httpOnly: p.httpOnly,
      secure: p.secure,
      firstParty: isFirstPartyDomain(domain, siteUrl),
      source: 'set-cookie',
      valuePreview: preview(p.valueLength),
    };
    if (p.sameSite) rec.sameSite = p.sameSite;
    if (checkpoint) rec.checkpoint = checkpoint;
    return rec;
  });
}
