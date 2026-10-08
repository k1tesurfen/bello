/**
 * Tiny builder for hand-made NetLog samples in the exact on-disk format Chromium writes
 * (numeric ids resolved via a constants block, string tick times, one event per line).
 */
const EVENT_TYPES = [
  'REQUEST_ALIVE',
  'URL_REQUEST_START_JOB',
  'URL_REQUEST_REDIRECTED',
  'HTTP_STREAM_JOB_CONTROLLER',
  'TCP_CLIENT_SOCKET_POOL_REQUESTED_SOCKETS',
  'SOCKET_POOL_CONNECT_JOB_CREATED',
  'CONNECT_JOB_SET_SOCKET',
  'SOCKET_ALIVE',
  'TCP_CONNECT',
  'TCP_CONNECT_ATTEMPT',
  'SSL_CONNECT',
  'QUIC_SESSION',
  'QUIC_SESSION_PACKET_RECEIVED',
  'HOST_RESOLVER_MANAGER_REQUEST',
  'HOST_RESOLVER_MANAGER_JOB',
  'HOST_RESOLVER_SYSTEM_TASK',
  'HOST_RESOLVER_DNS_TASK_EXTRACTION_RESULTS',
  'HTTP_TRANSACTION_SEND_REQUEST',
  'HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS',
  'HTTP_TRANSACTION_QUIC_SEND_REQUEST_HEADERS',
] as const;
const SOURCE_TYPES = [
  'NONE',
  'URL_REQUEST',
  'HTTP_STREAM_JOB_CONTROLLER',
  'HTTP_STREAM_JOB',
  'SSL_CONNECT_JOB',
  'TCP_CONNECT_JOB',
  'SOCKET',
  'QUIC_SESSION',
  'HOST_RESOLVER_IMPL_JOB',
  'NETWORK_SERVICE_HOST_RESOLVER',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];
export type SourceType = (typeof SOURCE_TYPES)[number];

/** Arbitrary tick base; epoch = tick + TICK_OFFSET. */
export const TICK_OFFSET = 1_700_000_000_000;
export const TICK0 = 5_000_000;
/** Navigation start (epoch ms) used by the samples: tick TICK0 + 100. */
export const NAV_START = TICK_OFFSET + TICK0 + 100;

export class NetLogBuilder {
  private lines: string[] = [];

  /**
   * Adds an event at `t` ms after TICK0 (so t = 100 is navigation start).
   * Event type ids are offset by 100 to make sure the parser really uses the constants block.
   */
  add(
    t: number,
    sourceId: number,
    sourceType: SourceType,
    type: EventType,
    phase: 'begin' | 'end' | 'none',
    params?: Record<string, unknown>,
  ): this {
    const ev = {
      ...(params ? { params } : {}),
      phase: phase === 'begin' ? 1 : phase === 'end' ? 2 : 0,
      source: {
        id: sourceId,
        start_time: String(TICK0 + t),
        type: SOURCE_TYPES.indexOf(sourceType),
      },
      time: String(TICK0 + t),
      type: EVENT_TYPES.indexOf(type) + 100,
    };
    this.lines.push(JSON.stringify(ev));
    return this;
  }

  constants(): Record<string, unknown> {
    return {
      logEventTypes: Object.fromEntries(EVENT_TYPES.map((n, i) => [n, i + 100])),
      logSourceType: Object.fromEntries(SOURCE_TYPES.map((n, i) => [n, i])),
      logEventPhase: { PHASE_BEGIN: 1, PHASE_END: 2, PHASE_NONE: 0 },
      netError: { ERR_ABORTED: -3, ERR_NAME_NOT_RESOLVED: -105, ERR_CONNECTION_REFUSED: -102 },
      timeTickOffset: String(TICK_OFFSET),
    };
  }

  /** Complete file text in Chromium's layout. */
  toString(): string {
    return (
      `{"constants":${JSON.stringify(this.constants())},\n"events": [\n` +
      this.lines.join(',\n') +
      `\n],"polledData": {}}\n`
    );
  }

  /** File text as left behind by a crashed browser: no closing brackets, last line cut. */
  toTruncatedString(cutLastEventChars = 20): string {
    const full =
      `{"constants":${JSON.stringify(this.constants())},\n"events": [\n` +
      this.lines.map((l) => l + ',\n').join('');
    return full.slice(0, full.length - 2 - cutLastEventChars);
  }
}
