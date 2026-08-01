import type { BackoffStrategy } from './backoff';
import type { CloseCategory } from './close-codes';
import type { QueueOptions } from './send-queue';
import type { StandardSchemaV1 } from './standard-schema';

/** Anything a WebSocket can hand you in a `message` event. */
export type RawData = string | ArrayBuffer | ArrayBufferView | Blob;

/** Anything you can hand to `WebSocket.send`. */
export type SendableData = string | ArrayBufferLike | ArrayBufferView | Blob;

export type Unsubscribe = () => void;

/**
 * The connection lifecycle, as one flat status.
 *
 * `readyState` cannot express the two states that matter most operationally:
 * "down but coming back" (`reconnecting`) and "down and not coming back"
 * (`gave-up`). Both look identical as `CLOSED`, which is why UIs built on
 * `readyState` alone cannot tell a blip from an outage.
 */
export type SocketStatus =
  /** Never connected, and not trying to (no URL, or `autoConnect: false`). */
  | 'idle'
  /** First connection attempt in flight. */
  | 'connecting'
  | 'open'
  | 'closing'
  /** Closed and not retrying — either intentionally or because retries are off. */
  | 'closed'
  /** Down, with a retry scheduled or in flight. */
  | 'reconnecting'
  /** Deliberately held down: tab hidden or browser offline. */
  | 'paused'
  /** Retry budget exhausted. Only `reconnect()` gets you out of here. */
  | 'gave-up';

export type ReconnectCause =
  | 'close'
  | 'error'
  | 'stale'
  | 'heartbeat-timeout'
  | 'connect-timeout'
  | 'manual';

export type DropReason = 'queue-full' | 'queue-disabled' | 'destroyed';

export type ErrorPhase =
  | 'url-resolution'
  | 'connect'
  | 'socket'
  | 'encode'
  | 'listener';

/**
 * Every observable thing the socket does, as one union.
 *
 * This is the whole observability surface: attach one listener and you can
 * build breadcrumbs, metrics, a devtools panel, or a log stream without the
 * library depending on any of them. See `keepline/sentry` and `keepline/logger`
 * for adapters built on exactly this.
 */
export type KeeplineEventPayload<TIn = unknown, TOut = unknown> =
  | { type: 'status'; status: SocketStatus; previous: SocketStatus }
  | { type: 'opening'; url: string; attempt: number }
  | {
      type: 'open';
      url: string;
      attempt: number;
      reconnected: boolean;
      /** Milliseconds spent down before this open. 0 for a first connection. */
      downtimeMs: number;
    }
  | { type: 'message'; message: TIn }
  | { type: 'decode-error'; error: unknown; data: RawData }
  | {
      type: 'validation-error';
      issues: ReadonlyArray<StandardSchemaV1.Issue>;
      value: unknown;
    }
  | { type: 'sent'; payload: TOut }
  | { type: 'queued'; payload: TOut; queueSize: number }
  | { type: 'dropped'; payload: TOut; reason: DropReason }
  | {
      type: 'close';
      code: number;
      reason: string;
      wasClean: boolean;
      category: CloseCategory;
    }
  | { type: 'error'; error: unknown; phase: ErrorPhase }
  | {
      type: 'reconnect-scheduled';
      attempt: number;
      delayMs: number;
      cause: ReconnectCause;
    }
  | { type: 'gave-up'; attempts: number; lastCode?: number }
  | { type: 'stale'; sinceMs: number }
  | { type: 'heartbeat'; rttMs: number }
  | { type: 'heartbeat-timeout'; timeoutMs: number }
  | { type: 'connect-timeout'; timeoutMs: number }
  | { type: 'paused'; reason: 'hidden' | 'offline' | 'manual' }
  | { type: 'resumed'; reason: 'visible' | 'online' | 'manual' }
  | { type: 'destroyed' };

/** A {@link KeeplineEventPayload} stamped with the time it was emitted. */
export type KeeplineEvent<TIn = unknown, TOut = unknown> = {
  at: number;
} & KeeplineEventPayload<TIn, TOut>;

export interface SocketMetrics {
  status: SocketStatus;
  /** Successful opens, including reconnections. */
  connections: number;
  reconnects: number;
  /** Attempts that never reached `open`. */
  failedAttempts: number;
  /** Attempt number of the retry currently scheduled or in flight. */
  currentAttempt: number;
  messagesReceived: number;
  messagesSent: number;
  messagesQueued: number;
  messagesDropped: number;
  decodeErrors: number;
  validationErrors: number;
  queueSize: number;
  /** Round-trip time of the last heartbeat, when heartbeats are enabled. */
  lastRttMs?: number;
  lastOpenedAt?: number;
  lastClosedAt?: number;
  lastMessageAt?: number;
  lastCloseCode?: number;
  lastCloseCategory?: CloseCategory;
  /** Cumulative time not open since creation. Your uptime denominator. */
  totalDowntimeMs: number;
}

export type UrlInput = string | null | undefined;
export type UrlResolver = () => UrlInput | Promise<UrlInput>;
export type ProtocolsInput = string | string[] | undefined;
export type ProtocolsResolver = () => ProtocolsInput | Promise<ProtocolsInput>;

export type SocketFactory = (
  url: string,
  protocols: ProtocolsInput
) => WebSocket;

export interface ReconnectContext {
  attempt: number;
  cause: ReconnectCause;
  code?: number;
  category?: CloseCategory;
  reason?: string;
  wasClean?: boolean;
  error?: unknown;
}

export interface ReconnectOptions {
  /** Retry budget. Default `Infinity`. */
  attempts?: number;
  /** Default: {@link exponentialBackoff} with equal jitter. */
  backoff?: BackoffStrategy;
  /** Retry after an `error` event with no close. Default true. */
  retryOnError?: boolean;
  /**
   * Final say on whether to retry. Called before each attempt, after the
   * built-in close-code check.
   *
   * The default refuses to retry auth failures and protocol errors — see
   * {@link isRetryableClose}. Return `true` here to override that.
   */
  shouldReconnect?: (context: ReconnectContext) => boolean | Promise<boolean>;
  /** Delay used when the server closed with 1013/1014. Default 30_000ms. */
  backpressureDelayMs?: number;
}

export interface HeartbeatOptions<TIn = unknown, TOut = unknown> {
  /** Payload to send. Omit to only *listen* for traffic without sending. */
  message?: TOut | (() => TOut);
  /** How often to ping. Default 30_000ms. */
  intervalMs?: number;
  /**
   * How long to wait for a pong before treating the socket as dead and forcing
   * a reconnect. Default 10_000ms.
   *
   * This is the half-open detection that plain `readyState` cannot give you: a
   * socket behind a dead NAT entry stays `OPEN` forever and silently delivers
   * nothing.
   */
  timeoutMs?: number;
  /** Which inbound messages count as a pong. Default: any message does. */
  isPong?: (message: TIn) => boolean;
}

export interface OpenContext<TOut = unknown> {
  url: string;
  attempt: number;
  reconnected: boolean;
  /** Send bypassing the queue — the socket is open by definition here. */
  send: (payload: TOut) => boolean;
}

export interface CloseContext {
  code: number;
  reason: string;
  wasClean: boolean;
  category: CloseCategory;
  willReconnect: boolean;
}

export interface SocketOptions<TIn = unknown, TOut = unknown> {
  /**
   * Target URL, or a resolver.
   *
   * `null`/`undefined` means "do not connect" — the idiomatic way to gate a
   * connection behind a feature flag or a not-yet-loaded value, with no
   * conditional hooks required.
   *
   * A resolver is re-invoked on every attempt, which is how you attach a
   * short-lived token that must be fresh at connect time rather than at
   * render time.
   */
  url: UrlInput | UrlResolver;
  /** Subprotocols, or a resolver (same freshness reasoning as `url`). */
  protocols?: ProtocolsInput | ProtocolsResolver;
  /**
   * Identity for socket sharing and for change detection. Defaults to the
   * resolved URL. Set it when the URL is stable but the connection identity is
   * not — e.g. when auth lives in `protocols` rather than the query string.
   */
  key?: string;
  /** Connect on creation. Default true. */
  autoConnect?: boolean;
  binaryType?: BinaryType;
  /**
   * Give up on an attempt that never opens. Default 10_000ms.
   *
   * Browsers will hang a WebSocket handshake for tens of seconds against a
   * black-holed host; without this the first retry never happens.
   */
  connectTimeoutMs?: number;
  /**
   * Raw frame to value. Default: `JSON.parse` for strings, pass-through for
   * binary. A throw here is reported as `decode-error`, never propagated into
   * the socket's event handler.
   */
  decode?: (data: RawData) => unknown | Promise<unknown>;
  /** Value to frame. Default `JSON.stringify` (strings pass through). */
  encode?: (payload: TOut) => SendableData;
  /**
   * Validation for inbound messages, via any Standard Schema library
   * (zod >= 3.24, valibot, arktype, ...). Failures become `validation-error`
   * events and are not delivered to `onMessage`.
   */
  schema?: StandardSchemaV1<unknown, TIn>;
  onOpen?: (context: OpenContext<TOut>) => void;
  onMessage?: (message: TIn) => void;
  onClose?: (context: CloseContext) => void;
  onError?: (error: unknown, phase: ErrorPhase) => void;
  /** Firehose of {@link KeeplineEvent}. The observability seam. */
  onEvent?: (event: KeeplineEvent<TIn, TOut>) => void;
  /** `false` disables reconnection entirely. */
  reconnect?: false | ReconnectOptions;
  /** `false` drops sends made while not open instead of buffering them. */
  queue?: false | QueueOptions;
  /** Application-level ping/pong and half-open detection. */
  heartbeat?: false | HeartbeatOptions<TIn, TOut>;
  /**
   * Force a reconnect if no message arrives for this long. A cruder liveness
   * check than `heartbeat`, for servers that push continuously and have no ping
   * message of their own.
   */
  staleAfterMs?: number;
  /**
   * Disconnect while the tab is hidden, reconnect when it is visible again.
   * Default false.
   *
   * Worth enabling for high-volume feeds: a backgrounded tab holding a tick
   * stream burns battery and server capacity to render nothing.
   */
  pauseWhenHidden?: boolean;
  /**
   * Reconnect immediately on `online` instead of waiting out the backoff, and
   * pause while offline. Default true.
   */
  reconnectWhenOnline?: boolean;
  /** Socket constructor. The seam `keepline/testing` plugs into. */
  socketFactory?: SocketFactory;
  /** Default response matcher for {@link Socket.request}. */
  matchResponse?: (message: TIn, sent: TOut) => boolean;
  /** Clock, injectable for tests. Default `Date.now`. */
  now?: () => number;
}

export interface RequestOptions<TIn = unknown> {
  /** Which inbound message answers this request. */
  match?: (message: TIn) => boolean;
  /** Reject after this long. Default 10_000ms. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * A subscribe/unsubscribe pair that survives reconnection.
 *
 * The `subscribe` payload is (re)sent on every open, and `unsubscribe` is sent
 * when you release it. This is the piece hand-rolled in every app that talks to
 * a topic-based server: without it, a reconnect leaves you connected to a
 * socket that is sending you nothing.
 */
export interface SubscriptionSpec<TOut = unknown> {
  subscribe: TOut | (() => TOut);
  unsubscribe?: TOut | (() => TOut);
  key?: string;
}

export interface Socket<TIn = unknown, TOut = unknown> {
  readonly status: SocketStatus;
  /** Raw `WebSocket.readyState`, or `CLOSED` when there is no socket. */
  readonly readyState: number;
  readonly url: string | null;
  readonly destroyed: boolean;
  readonly metrics: Readonly<SocketMetrics>;

  connect(): void;
  /** Close without reconnecting. `reconnect()` or `connect()` resumes. */
  close(code?: number, reason?: string): void;
  /** Drop the current connection and immediately open a new one. */
  reconnect(): void;
  /** Hold the connection down until `resume()`. */
  pause(): void;
  resume(): void;
  /** Close permanently and release all listeners, timers, and queues. */
  destroy(): void;

  /** Sends now if open, queues otherwise. `false` means dropped. */
  send(payload: TOut): boolean;
  sendRaw(data: SendableData): boolean;
  /** Send and await the matching reply. */
  request<TResponse = TIn>(
    payload: TOut,
    options?: RequestOptions<TIn>
  ): Promise<TResponse>;
  /** Register a reconnect-surviving subscription. Returns a release function. */
  subscription(spec: SubscriptionSpec<TOut>): Unsubscribe;

  onMessage(listener: (message: TIn) => void): Unsubscribe;
  onEvent(listener: (event: KeeplineEvent<TIn, TOut>) => void): Unsubscribe;
  /**
   * Fires on every {@link SocketStatus} transition, and only on those — message
   * traffic does not notify. This is the subscribe function for
   * `useSyncExternalStore`, and keeping it status-only is what stops a
   * high-volume feed from re-rendering React on every frame.
   */
  onStatusChange(listener: () => void): Unsubscribe;

  getWebSocket(): WebSocket | null;
  /** Resolves on the next `open`. Rejects on `gave-up`, destroy, or timeout. */
  waitForOpen(options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<void>;
}
