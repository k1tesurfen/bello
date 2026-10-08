/**
 * Minimal Chrome DevTools Protocol client over WebSocket (Node ≥ 22 global `WebSocket`).
 *
 * Bello uses its own CDP connection (in addition to Playwright's pipe) because Playwright's
 * public CDPSession API cannot receive events from flattened child sessions, which we need to
 * capture requests in out-of-process iframes (e.g. a cross-site YouTube embed) and workers.
 */

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  /** Flattened child session the event belongs to; undefined for the browser session. */
  sessionId?: string;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  method: string;
}

export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(e: CdpEvent) => void>();
  private closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (ev: MessageEvent) => this.onMessage(String(ev.data)));
    ws.addEventListener('close', () => this.onClose());
    ws.addEventListener('error', () => this.onClose());
  }

  /** Connects to a browser-level DevTools WebSocket URL (`ws://127.0.0.1:<port>/devtools/browser/<id>`). */
  static connect(wsUrl: string, timeoutMs = 10_000): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`CDP-Verbindung zu ${wsUrl} nicht möglich (Timeout).`));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new CdpClient(ws));
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`CDP-Verbindung zu ${wsUrl} fehlgeschlagen.`));
      });
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`CDP closed (${method})`));
    const id = this.nextId++;
    const msg = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      this.ws.send(msg);
    });
  }

  /** Subscribes to all events (all sessions). Returns an unsubscribe function. */
  onEvent(listener: (e: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.ws.close();
    this.onClose();
  }

  private onMessage(data: string): void {
    let msg: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    try {
      msg = JSON.parse(data) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message ?? 'CDP error'}`));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) {
      const ev: CdpEvent = {
        method: msg.method,
        params: msg.params ?? {},
        ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
      };
      for (const l of this.listeners) l(ev);
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error(`CDP closed (${p.method})`));
    this.pending.clear();
  }
}
