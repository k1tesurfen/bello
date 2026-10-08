/**
 * Captures network requests with their initiator chain via CDP (PLAN §5.2).
 *
 * Attaches at browser level with `Target.setAutoAttach({flatten: true})` and recursively on
 * every attached target, so requests from pages, out-of-process iframes (cross-site embeds such
 * as YouTube), dedicated/shared workers and service workers are all captured. New targets are
 * paused (`waitForDebuggerOnStart`) until `Network.enable` is active, so no early request is
 * missed.
 *
 * Must be started *before* the page is created / navigated.
 */
import type {
  InitiatorType,
  RequestInitiator,
  RequestRecord,
  SetCookieRecord,
  StackFrameRef,
} from '../../types.js';
import { isConsentModeCandidate } from '../consentmode/index.js';
import { CdpClient, type CdpEvent } from './client.js';

/** Upper bound for captured request bodies. */
const MAX_POST_DATA = 64 * 1024;

interface CdpRequest {
  url: string;
  method: string;
  postData?: string;
  hasPostData?: boolean;
  postDataEntries?: Array<{ bytes?: string }>;
}

/**
 * Request body of Google consent-mode endpoints (GA4 sends `gcs`/`gcd` in POST batches).
 * Other bodies are never stored (they may contain form data).
 */
export function consentModePostData(request: CdpRequest): string | undefined {
  if (request.method !== 'POST' || !isConsentModeCandidate(request.url)) return undefined;
  let body = request.postData;
  if (body === undefined && request.postDataEntries?.length) {
    body = request.postDataEntries
      .map((e) => (e.bytes ? Buffer.from(e.bytes, 'base64').toString('utf8') : ''))
      .join('');
  }
  if (!body) return undefined;
  return body.length > MAX_POST_DATA ? body.slice(0, MAX_POST_DATA) : body;
}

/** Target types whose network activity we record. */
const NETWORK_TARGET_TYPES = new Set([
  'page',
  'iframe',
  'worker',
  'shared_worker',
  'service_worker',
]);

/** Internal record: times are epoch ms until {@link RequestCapture.records} converts them. */
interface Acc {
  rec: Omit<RequestRecord, 'startTime' | 'endTime'>;
  start: number;
  end?: number;
  sessionId?: string;
}

export interface RequestCapture {
  /** Requests captured so far, with times relative to `navigationStart` (epoch ms). */
  records(navigationStart: number): RequestRecord[];
  /** Waits briefly for in-flight events, detaches and closes the CDP connection. */
  stop(): Promise<void>;
  /** Errors encountered while attaching to targets (diagnostics). */
  readonly errors: string[];
}

interface CdpCallFrame {
  url?: string;
  functionName?: string;
  lineNumber?: number;
  columnNumber?: number;
}
interface CdpStack {
  callFrames?: CdpCallFrame[];
  parent?: CdpStack;
}
interface CdpInitiator {
  type?: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  requestId?: string;
  stack?: CdpStack;
}

/** Converts a CDP `Network.Initiator` into Bello's simplified form (1-based lines). */
export function mapInitiator(i: CdpInitiator | undefined): RequestInitiator {
  const type: InitiatorType =
    i?.type === 'parser' || i?.type === 'script' || i?.type === 'preload' ? i.type : 'other';
  const stack: StackFrameRef[] = [];
  for (let s: CdpStack | undefined = i?.stack; s; s = s.parent) {
    for (const f of s.callFrames ?? []) {
      if (!f.url) continue;
      stack.push({
        url: f.url,
        ...(f.functionName ? { functionName: f.functionName } : {}),
        ...(typeof f.lineNumber === 'number' ? { line: f.lineNumber + 1 } : {}),
        ...(typeof f.columnNumber === 'number' ? { column: f.columnNumber + 1 } : {}),
      });
    }
  }
  const top = stack[0];
  const url = i?.url ?? top?.url;
  const line = typeof i?.lineNumber === 'number' ? i.lineNumber + 1 : top?.line;
  const column = typeof i?.columnNumber === 'number' ? i.columnNumber + 1 : top?.column;
  return {
    type,
    ...(url ? { url } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
    ...(stack.length ? { stack } : {}),
    ...(i?.requestId ? { requestId: i.requestId } : {}),
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

/** Parses Set-Cookie header lines into records. */
function parseSetCookies(headers: Record<string, unknown> | undefined): SetCookieRecord[] {
  if (!headers) return [];
  const out: SetCookieRecord[] = [];
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== 'set-cookie' || typeof v !== 'string') continue;
    for (const line of v.split('\n')) if (line.trim()) out.push(cookieFromLine(line.trim()));
  }
  return out;
}

function cookieFromLine(raw: string): SetCookieRecord {
  const name = raw.split('=')[0]?.trim();
  const domain = /;\s*domain=([^;]+)/i.exec(raw)?.[1]?.trim();
  return { raw, ...(name ? { name } : {}), ...(domain ? { domain } : {}) };
}

/**
 * Starts request capture on a browser-level DevTools endpoint
 * (see {@link import('../../browser/launch.js').ScenarioBrowser.cdpEndpoint}).
 */
export async function startRequestCapture(wsEndpoint: string): Promise<RequestCapture> {
  const client = await CdpClient.connect(wsEndpoint);
  const byId = new Map<string, Acc>();
  const order: Acc[] = [];
  const errors: string[] = [];
  /** Per session: epoch ms − monotonic ms (from requestWillBeSent wallTime/timestamp). */
  const clockOffset = new Map<string, number>();
  const oopifSessions = new Set<string>();
  const pendingExtra = new Map<string, Record<string, unknown>[]>();
  const redirectCount = new Map<string, number>();

  const toEpoch = (sessionId: string | undefined, monotonicSec: unknown): number | undefined => {
    if (typeof monotonicSec !== 'number') return undefined;
    const off = clockOffset.get(sessionId ?? '');
    return off === undefined ? undefined : monotonicSec * 1000 + off;
  };

  const autoAttachParams = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

  const onAttached = async (sessionId: string, targetType: string): Promise<void> => {
    try {
      if (targetType === 'iframe') oopifSessions.add(sessionId);
      if (NETWORK_TARGET_TYPES.has(targetType)) {
        // Runtime must be enabled on the session, otherwise V8 does not capture JS stacks and
        // script-initiated requests are reported as "parser" with the document's last position.
        // (Playwright enables Runtime on its own sessions anyway, so this adds no detectability.)
        await Promise.all([
          client.send('Network.enable', {}, sessionId),
          client.send('Runtime.enable', {}, sessionId),
        ]);
      }
      if (targetType === 'page' || targetType === 'iframe') {
        await client.send('Target.setAutoAttach', autoAttachParams, sessionId);
      }
    } catch (err) {
      errors.push(`${targetType}: ${(err as Error).message}`);
    } finally {
      await client.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
    }
  };

  const applyExtraInfo = (acc: Acc, p: Record<string, unknown>): void => {
    const cookies = parseSetCookies(p.headers as Record<string, unknown> | undefined);
    const blocked =
      (p.blockedCookies as Array<{ blockedReasons?: string[]; cookieLine?: string }>) ?? [];
    for (const b of blocked) {
      const line = b.cookieLine;
      const match = line ? cookies.find((c) => c.raw === line) : undefined;
      if (match) match.blockedReasons = b.blockedReasons ?? [];
      else if (line)
        cookies.push({ ...cookieFromLine(line), blockedReasons: b.blockedReasons ?? [] });
    }
    if (cookies.length) acc.rec.setCookies = [...(acc.rec.setCookies ?? []), ...cookies];
    if (typeof p.statusCode === 'number' && acc.rec.status === undefined)
      acc.rec.status = p.statusCode;
  };

  const onEvent = (ev: CdpEvent): void => {
    const p = ev.params;
    switch (ev.method) {
      case 'Target.attachedToTarget': {
        const sessionId = p.sessionId as string;
        const info = p.targetInfo as { type?: string } | undefined;
        void onAttached(sessionId, info?.type ?? 'other');
        break;
      }
      case 'Network.requestWillBeSent': {
        const requestId = p.requestId as string;
        const request = p.request as CdpRequest;
        const wall = typeof p.wallTime === 'number' ? p.wallTime * 1000 : Date.now();
        if (typeof p.timestamp === 'number')
          clockOffset.set(ev.sessionId ?? '', wall - p.timestamp * 1000);

        const existing = byId.get(requestId);
        const redirectResponse = p.redirectResponse as { status?: number } | undefined;
        if (existing && redirectResponse) {
          // Redirect hop: archive the previous record under a suffixed id.
          const n = (redirectCount.get(requestId) ?? 0) + 1;
          redirectCount.set(requestId, n);
          existing.rec.id = `${requestId}#${n}`;
          existing.rec.redirectedTo = request.url;
          if (typeof redirectResponse.status === 'number')
            existing.rec.status = redirectResponse.status;
          existing.end = wall;
        } else if (existing && existing.sessionId !== ev.sessionId) {
          // Same navigation reported by parent and OOPIF session: keep the first record.
          if (ev.sessionId && oopifSessions.has(ev.sessionId)) existing.rec.oopif = true;
          break;
        }

        const frameUrl = (p.documentURL as string | undefined) ?? undefined;
        const postData = consentModePostData(request);
        const acc: Acc = {
          rec: {
            id: requestId,
            url: request.url,
            host: hostOf(request.url),
            method: request.method,
            resourceType: (p.type as string | undefined) ?? 'Other',
            initiator: mapInitiator(p.initiator as CdpInitiator | undefined),
            ...(frameUrl ? { frameUrl } : {}),
            ...(typeof p.frameId === 'string' ? { frameId: p.frameId } : {}),
            ...(ev.sessionId && oopifSessions.has(ev.sessionId) ? { oopif: true } : {}),
            ...(postData !== undefined ? { postData } : {}),
          },
          start: wall,
          ...(ev.sessionId ? { sessionId: ev.sessionId } : {}),
        };
        byId.set(requestId, acc);
        order.push(acc);
        for (const extra of pendingExtra.get(requestId) ?? []) applyExtraInfo(acc, extra);
        pendingExtra.delete(requestId);
        break;
      }
      case 'Network.responseReceived': {
        const acc = byId.get(p.requestId as string);
        if (!acc) break;
        const r = p.response as { status?: number; remoteIPAddress?: string; remotePort?: number };
        if (typeof r.status === 'number') acc.rec.status = r.status;
        if (r.remoteIPAddress) acc.rec.remoteIp = r.remoteIPAddress.replace(/^\[|\]$/g, '');
        if (typeof r.remotePort === 'number') acc.rec.remotePort = r.remotePort;
        if (typeof p.type === 'string') acc.rec.resourceType = p.type;
        break;
      }
      case 'Network.responseReceivedExtraInfo': {
        const id = p.requestId as string;
        const acc = byId.get(id);
        if (acc) applyExtraInfo(acc, p);
        else pendingExtra.set(id, [...(pendingExtra.get(id) ?? []), p]);
        break;
      }
      case 'Network.loadingFinished': {
        const acc = byId.get(p.requestId as string);
        if (acc) acc.end = toEpoch(ev.sessionId, p.timestamp) ?? Date.now();
        break;
      }
      case 'Network.loadingFailed': {
        const acc = byId.get(p.requestId as string);
        if (!acc) break;
        acc.end = toEpoch(ev.sessionId, p.timestamp) ?? Date.now();
        acc.rec.failed = true;
        if (typeof p.errorText === 'string') acc.rec.errorText = p.errorText;
        if (p.canceled === true) acc.rec.canceled = true;
        if (typeof p.blockedReason === 'string') acc.rec.blockedReason = p.blockedReason;
        break;
      }
      default:
        break;
    }
  };

  client.onEvent(onEvent);
  await client.send('Target.setAutoAttach', autoAttachParams);

  return {
    errors,
    records(navigationStart: number): RequestRecord[] {
      return order.map((a) => ({
        ...a.rec,
        startTime: Math.round(a.start - navigationStart),
        ...(a.end !== undefined ? { endTime: Math.round(a.end - navigationStart) } : {}),
      }));
    },
    async stop(): Promise<void> {
      await new Promise((r) => setTimeout(r, 50));
      client.close();
    },
  };
}
