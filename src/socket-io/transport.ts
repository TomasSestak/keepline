import { KeeplineError } from '../core/errors';
import type { WebSocketBinaryType, WebSocketLike } from '../core/types';
import { PacketType, namespacePrefix, parseHeader } from './parser';

/**
 * Close code reported when the Socket.IO CONNECT is refused, whichever way the
 * refusal arrived (see {@link SocketIoConnectErrorReason}). keepline classifies
 * it as `policy` and never retries it on its own.
 */
export const REFUSED_CLOSE_CODE = 1008;

/**
 * How a Socket.IO CONNECT was refused:
 *
 * - `'connect-error'` — the server answered with a CONNECT_ERROR (`44`)
 *   packet, e.g. an auth middleware's `next(new Error(...))`. `message` and
 *   `data` are the server's.
 * - `'auth-failed'` — the `auth` option threw, rejected, or resolved to
 *   something that cannot be sent. Nothing reached the server; the original
 *   error is the `cause`.
 * - `'session-ended'` — the server ended the session (Engine.IO close `1`, or
 *   namespace DISCONNECT `41`) instead of acknowledging the CONNECT.
 * - `'closed-before-ack'` — the WebSocket closed after the CONNECT was sent
 *   but before it was acknowledged: a server, gateway or proxy that rejects by
 *   dropping the connection. `closeCode` is that close's code, the only detail
 *   there is.
 */
export type SocketIoConnectErrorReason =
  | 'connect-error'
  | 'auth-failed'
  | 'session-ended'
  | 'closed-before-ack';

/**
 * A refused Socket.IO CONNECT, passed to `onConnectError` once per refusal,
 * just before the socket closes with {@link REFUSED_CLOSE_CODE}.
 */
export class SocketIoConnectError extends KeeplineError {
  /** How the CONNECT was refused. */
  readonly reason: SocketIoConnectErrorReason;
  /**
   * The `data` field of the CONNECT_ERROR payload, if the server sent one.
   * Always `undefined` unless `reason` is `'connect-error'`.
   */
  readonly data: unknown;
  /**
   * Code of the WebSocket close that ended the attempt, when `reason` is
   * `'closed-before-ack'` (`undefined` if the close carried none). Always
   * `undefined` otherwise.
   */
  readonly closeCode: number | undefined;

  constructor(
    message: string,
    data?: unknown,
    options?: {
      cause?: unknown;
      /** Default `'connect-error'`. */
      reason?: SocketIoConnectErrorReason;
      closeCode?: number;
    }
  ) {
    super(message, options);
    this.name = 'SocketIoConnectError';
    this.reason = options?.reason ?? 'connect-error';
    this.data = data;
    this.closeCode = options?.closeCode;
  }
}

export type SocketIoAuth =
  | object
  | null
  | undefined
  | (() => object | null | undefined | Promise<object | null | undefined>);

export interface TransportConfig {
  namespace: string;
  auth: SocketIoAuth;
  onConnectError: ((error: SocketIoConnectError) => void) | undefined;
}

type Listener = (event: unknown) => void;
type Phase =
  /** Waiting for Engine.IO's `0` handshake. */
  | 'handshake'
  /** Handshake done; resolving `auth`. Nothing sent yet. */
  | 'authorizing'
  /** CONNECT sent; the server has not answered it yet. */
  | 'awaiting-ack'
  /** CONNECT acknowledged. keepline has seen `open`. */
  | 'connected'
  /** Closed and detached — reported, or closed by keepline itself. */
  | 'done';

interface CloseEventShape {
  code: number;
  reason: string;
  wasClean: boolean;
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as PromiseLike<unknown> | null)?.then === 'function';

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Close codes a server sends on purpose to say "come back later". Kept as-is
 * even before the CONNECT ack, so a restart is not mistaken for a refusal.
 */
const isDeliberateRetrySignal = (code: number | undefined): boolean =>
  // Inlined rather than imported from close-codes: sharing that module would
  // split it into its own chunk and cost the core entry bytes.
  code === 1001 || code === 1012 || code === 1013 || code === 1014;

/**
 * Wrap a raw WebSocket so keepline sees a Socket.IO session instead.
 *
 * The wrapper owns everything below the application layer: it answers the
 * Engine.IO handshake with a CONNECT, answers pings, watches the server's ping
 * cadence, and holds back keepline's `open` until the server acknowledges the
 * CONNECT. That last part is why `status === 'open'` means "Socket.IO
 * connected", and why keepline's own send queue cannot flush into a namespace
 * the server has not admitted yet.
 *
 * Failures are translated into close events keepline already has policy for:
 * a refused CONNECT becomes 1008 (policy — never retried), a dead ping loop
 * becomes 1006 (abnormal — retried), a server-side disconnect becomes
 * 1000/1001 (retried). Only application frames are forwarded as messages.
 */
export const wrapTransport = (
  raw: WebSocketLike,
  config: TransportConfig
): WebSocketLike => {
  const { namespace } = config;
  const prefix = namespacePrefix(namespace);
  const listeners = new Map<string, Set<Listener>>();

  let phase: Phase = 'handshake';
  /** `close()` was called by keepline; the raw close is forwarded verbatim. */
  let clientClosed = false;
  let pingWindowMs = 0;
  let pingTimer: ReturnType<typeof setTimeout> | undefined;
  /** An `error` seen while awaiting the ack, held until its `close`. */
  let heldError: { event: unknown } | undefined;

  const dispatch = (type: string, event: unknown): void => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
  };

  const clearPingTimer = (): void => {
    if (pingTimer !== undefined) clearTimeout(pingTimer);
    pingTimer = undefined;
  };

  const armPingTimer = (): void => {
    clearPingTimer();
    pingTimer = setTimeout(() => {
      pingTimer = undefined;
      terminate({
        code: 1006,
        reason: 'socket.io: ping timeout',
        wasClean: false
      });
    }, pingWindowMs);
  };

  const detach = (): void => {
    raw.removeEventListener('message', onRawMessage);
    raw.removeEventListener('error', onRawError);
    raw.removeEventListener('close', onRawClose);
  };

  /** Report a close keepline should act on, and drop the raw transport. */
  const terminate = (event: CloseEventShape): void => {
    if (phase === 'done') return;
    phase = 'done';
    clearPingTimer();
    detach();
    try {
      raw.close(1000);
    } catch {
      // Already closing or closed; the event below is what keepline acts on.
    }
    const held = heldError;
    heldError = undefined;
    if (held) dispatch('error', held.event);
    dispatch('close', event);
  };

  /**
   * The one way a CONNECT is refused: tell the app, then close with 1008.
   * `closeReason` defaults to the error's message.
   */
  const refuse = (error: SocketIoConnectError, closeReason?: string): void => {
    try {
      config.onConnectError?.(error);
    } catch {
      // A throwing observer must not keep a refused session alive.
    }
    terminate({
      code: REFUSED_CLOSE_CODE,
      reason: closeReason ?? `socket.io: ${error.message}`,
      wasClean: false
    });
  };

  const failAuth = (error: unknown): void => {
    if (phase !== 'authorizing' || clientClosed) return;
    refuse(
      new SocketIoConnectError(
        `auth() failed: ${errorMessage(error)}`,
        undefined,
        { reason: 'auth-failed', cause: error }
      )
    );
  };

  const sendConnect = (payload: unknown): void => {
    // keepline may have closed or abandoned the transport while auth resolved.
    if (phase !== 'authorizing' || clientClosed) return;
    let frame: string;
    try {
      if (payload != null && typeof payload !== 'object') {
        throw new TypeError(
          'auth must resolve to an object, null or undefined'
        );
      }
      frame =
        payload == null
          ? `40${prefix}`
          : `40${prefix}${JSON.stringify(payload)}`;
    } catch (error) {
      failAuth(error);
      return;
    }
    try {
      raw.send(frame);
    } catch {
      // The transport is going away; its close event drives recovery.
      return;
    }
    phase = 'awaiting-ack';
  };

  const beginConnect = (): void => {
    phase = 'authorizing';
    const { auth } = config;
    if (typeof auth !== 'function') {
      sendConnect(auth);
      return;
    }
    let resolved: unknown;
    try {
      resolved = (auth as () => unknown)();
    } catch (error) {
      failAuth(error);
      return;
    }
    if (isPromiseLike(resolved)) resolved.then(sendConnect, failAuth);
    else sendConnect(resolved);
  };

  const onHandshake = (frame: string): void => {
    let handshake: unknown;
    try {
      handshake = JSON.parse(frame.slice(1));
    } catch {
      handshake = undefined;
    }
    const { pingInterval, pingTimeout } = (handshake ?? {}) as {
      pingInterval?: unknown;
      pingTimeout?: unknown;
    };
    if (
      typeof pingInterval !== 'number' ||
      typeof pingTimeout !== 'number' ||
      !(pingInterval > 0) ||
      !(pingTimeout >= 0)
    ) {
      // A server speaking something else. A bug, not a blip: 1002 is a
      // protocol close, which keepline does not retry.
      terminate({
        code: 1002,
        reason: 'socket.io: malformed Engine.IO handshake',
        wasClean: false
      });
      return;
    }
    pingWindowMs = pingInterval + pingTimeout;
    armPingTimer();
    beginConnect();
  };

  /**
   * A server-initiated end. After the CONNECT ack it is an ordinary disconnect
   * and is retried; in answer to a pending CONNECT it is a refusal.
   */
  const endSession = (code: number, reason: string): void => {
    if (phase === 'awaiting-ack') {
      refuse(
        new SocketIoConnectError(
          `${reason} before acknowledging CONNECT`,
          undefined,
          { reason: 'session-ended' }
        )
      );
      return;
    }
    terminate({ code, reason: `socket.io: ${reason}`, wasClean: true });
  };

  /** Socket.IO control packets for this namespace. `false` = not handled. */
  const onControlPacket = (frame: string): boolean => {
    const kind = frame.charCodeAt(1) - 48;
    if (
      kind !== PacketType.CONNECT &&
      kind !== PacketType.DISCONNECT &&
      kind !== PacketType.CONNECT_ERROR
    )
      return false;

    // The header is enough to route a control packet. Its JSON is parsed only
    // where it is used, so a malformed payload cannot hide a refusal.
    const header = parseHeader(frame.slice(1));
    if (header.nsp !== namespace) return false;

    if (kind === PacketType.CONNECT) {
      if (phase !== 'awaiting-ack') return false;
      phase = 'connected';
      dispatch('open', { type: 'open' });
      return true;
    }

    if (kind === PacketType.CONNECT_ERROR) {
      let body: { message?: unknown; data?: unknown } = {};
      try {
        body = JSON.parse(header.payload) ?? {};
      } catch {
        // Still a refusal; just one without a readable reason.
      }
      refuse(
        new SocketIoConnectError(
          typeof body.message === 'string'
            ? body.message
            : 'connection refused',
          body.data
        )
      );
      return true;
    }

    endSession(1000, 'server disconnected the namespace');
    return true;
  };

  function onRawMessage(event: unknown): void {
    if (phase === 'done' || clientClosed) return;
    const { data } = event as { data: unknown };
    if (typeof data !== 'string') {
      dispatch('message', event);
      return;
    }

    switch (data.charAt(0)) {
      case '0':
        if (phase === 'handshake') {
          onHandshake(data);
          return;
        }
        break;
      case '1':
        endSession(1001, 'server closed the session');
        return;
      case '2':
        if (data === '2') {
          try {
            raw.send('3');
          } catch {
            // Closing; the close event takes over.
          }
          armPingTimer();
          return;
        }
        break;
      case '3':
      case '6':
        // Pong (keepline never pings) and noop.
        return;
      case '4':
        try {
          if (onControlPacket(data)) return;
        } catch {
          // Unparseable header: keepline's decode reports it by name.
        }
        break;
    }

    // Events, plus anything unsupported or malformed: keepline's `decode`
    // turns the latter into a `decode-error` naming what arrived.
    dispatch('message', event);
  }

  function onRawError(event: unknown): void {
    if (phase === 'done') return;
    if (phase === 'awaiting-ack' && !clientClosed) {
      // keepline abandons a transport whose `error` is not followed by `close`
      // within 50ms and retries it as a plain error. Hold the error so the
      // refusal below is classified by its (synthesized) close instead.
      heldError = { event };
      return;
    }
    dispatch('error', event);
  }

  function onRawClose(event: unknown): void {
    if (phase === 'done') return;
    const close = event as Partial<CloseEventShape>;

    if (
      phase === 'awaiting-ack' &&
      !clientClosed &&
      !isDeliberateRetrySignal(close.code)
    ) {
      // The server dropped the connection in answer to our CONNECT — what an
      // auth middleware that closes instead of sending `44` looks like.
      const detail =
        close.code === undefined
          ? ''
          : ` (${close.code}${close.reason ? ` ${close.reason}` : ''})`;
      refuse(
        new SocketIoConnectError(
          `connection closed${detail} before CONNECT was acknowledged`,
          undefined,
          { reason: 'closed-before-ack', closeCode: close.code }
        ),
        // Kept free of the transport's code, so the close reason is stable.
        'socket.io: connection closed before CONNECT was acknowledged'
      );
      return;
    }

    phase = 'done';
    clearPingTimer();
    detach();
    const held = heldError;
    heldError = undefined;
    if (held) dispatch('error', held.event);
    dispatch('close', {
      code: close.code ?? 1006,
      reason: close.reason ?? '',
      wasClean: close.wasClean ?? false
    });
  }

  raw.addEventListener('message', onRawMessage);
  raw.addEventListener('error', onRawError);
  raw.addEventListener('close', onRawClose);

  return {
    CONNECTING,
    OPEN,
    CLOSING: 2,
    CLOSED,
    get url() {
      return raw.url;
    },
    get readyState() {
      if (phase === 'done' && !clientClosed) return CLOSED;
      const state = raw.readyState;
      if (clientClosed || phase === 'connected') return state;
      // Open at the WebSocket layer is still connecting at the Socket.IO one.
      return state === raw.OPEN ? CONNECTING : state;
    },
    get bufferedAmount() {
      return raw.bufferedAmount;
    },
    get extensions() {
      return raw.extensions;
    },
    get protocol() {
      return raw.protocol;
    },
    get binaryType(): WebSocketBinaryType {
      return raw.binaryType;
    },
    set binaryType(value: WebSocketBinaryType) {
      raw.binaryType = value;
    },
    send(data) {
      raw.send(data);
    },
    close(code, reason) {
      if (clientClosed || phase === 'done') return;
      clientClosed = true;
      clearPingTimer();
      if (phase === 'connected' && raw.readyState === raw.OPEN) {
        try {
          raw.send(`41${prefix}`);
        } catch {
          // Best effort: the close below is what matters.
        }
      }
      if (code === undefined) raw.close();
      else raw.close(code, reason);
    },
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    }
  };
};
