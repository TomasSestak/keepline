import { KeeplineError } from '../core/errors';
import type { WebSocketBinaryType, WebSocketLike } from '../core/types';
import { PacketType, namespacePrefix, parsePacket } from './parser';

/** Close code reported when the server refuses the Socket.IO CONNECT. */
export const REFUSED_CLOSE_CODE = 1008;

/** Payload of a Socket.IO CONNECT_ERROR (`44`) packet. */
export class SocketIoConnectError extends KeeplineError {
  /** The `data` field of the CONNECT_ERROR payload, if the server sent one. */
  readonly data: unknown;

  constructor(message: string, data?: unknown, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SocketIoConnectError';
    this.data = data;
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
  /** Handshake done; resolving `auth` and/or awaiting the CONNECT ack. */
  | 'connecting'
  /** CONNECT acknowledged. keepline has seen `open`. */
  | 'connected'
  /** This wrapper has reported its own close and detached. */
  | 'terminated';

interface CloseEventShape {
  code: number;
  reason: string;
  wasClean: boolean;
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

const isPromiseLike = <T>(value: unknown): value is PromiseLike<T> =>
  typeof (value as PromiseLike<T> | null)?.then === 'function';

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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
  /** `close()` was called by keepline; its close event is forwarded verbatim. */
  let clientClosed = false;
  let connectSent = false;
  let pingWindowMs = 0;
  let pingTimer: ReturnType<typeof setTimeout> | undefined;
  /** An `error` seen while a CONNECT is pending, held until its `close`. */
  let heldError: unknown;
  let hasHeldError = false;

  const dispatch = (type: string, event: unknown): void => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
  };

  const clearPingTimer = (): void => {
    if (pingTimer !== undefined) clearTimeout(pingTimer);
    pingTimer = undefined;
  };

  const armPingTimer = (): void => {
    clearPingTimer();
    if (pingWindowMs <= 0) return;
    pingTimer = setTimeout(() => {
      pingTimer = undefined;
      terminate({
        code: 1006,
        reason: 'socket.io: ping timeout',
        wasClean: false
      });
    }, pingWindowMs);
  };

  const releaseHeldError = (): void => {
    if (!hasHeldError) return;
    hasHeldError = false;
    const error = heldError;
    heldError = undefined;
    dispatch('error', error);
  };

  const detach = (): void => {
    raw.removeEventListener('open', onRawOpen);
    raw.removeEventListener('message', onRawMessage);
    raw.removeEventListener('error', onRawError);
    raw.removeEventListener('close', onRawClose);
  };

  /** Report a close keepline should act on, and drop the raw transport. */
  const terminate = (event: CloseEventShape): void => {
    if (phase === 'terminated' || clientClosed) return;
    phase = 'terminated';
    clearPingTimer();
    detach();
    try {
      raw.close(1000);
    } catch {
      // Already closing or closed; the synthesized event below is the truth.
    }
    releaseHeldError();
    dispatch('close', event);
  };

  const refuse = (reason: string): void =>
    terminate({ code: REFUSED_CLOSE_CODE, reason, wasClean: false });

  /**
   * A server-initiated end. After the CONNECT ack it is an ordinary disconnect
   * and is retried; in answer to a pending CONNECT it is a refusal.
   */
  const endSession = (code: number, reason: string): void => {
    if (phase === 'connecting' && connectSent) {
      refuse(`${reason} before acknowledging CONNECT`);
      return;
    }
    terminate({ code, reason, wasClean: true });
  };

  const notifyConnectError = (error: SocketIoConnectError): void => {
    try {
      config.onConnectError?.(error);
    } catch {
      // A throwing observer must not keep a refused session alive.
    }
  };

  const sendConnect = (payload: unknown): void => {
    if (phase !== 'connecting' || clientClosed) return;
    if (payload != null && typeof payload !== 'object') {
      const error = new SocketIoConnectError(
        'auth must resolve to an object, null or undefined'
      );
      notifyConnectError(error);
      refuse(`socket.io: ${error.message}`);
      return;
    }
    const frame =
      payload == null ? `40${prefix}` : `40${prefix}${JSON.stringify(payload)}`;
    try {
      raw.send(frame);
    } catch {
      // The transport is going away; its close event drives recovery.
      return;
    }
    connectSent = true;
  };

  const failAuth = (error: unknown): void => {
    if (phase !== 'connecting' || clientClosed) return;
    const connectError = new SocketIoConnectError(
      `auth() failed: ${errorMessage(error)}`,
      undefined,
      { cause: error }
    );
    notifyConnectError(connectError);
    refuse(`socket.io: ${connectError.message}`);
  };

  const beginConnect = (): void => {
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
    if (isPromiseLike(resolved)) {
      Promise.resolve(resolved).then(sendConnect, failAuth);
    } else {
      sendConnect(resolved);
    }
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
    phase = 'connecting';
    armPingTimer();
    beginConnect();
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

    let packet: ReturnType<typeof parsePacket>;
    try {
      packet = parsePacket(frame.slice(1));
    } catch {
      return false;
    }
    if (packet.nsp !== namespace) return false;

    if (kind === PacketType.CONNECT) {
      if (phase !== 'connecting' || !connectSent) return false;
      phase = 'connected';
      dispatch('open', { type: 'open' });
      return true;
    }

    if (kind === PacketType.CONNECT_ERROR) {
      const payload = (packet.data ?? {}) as {
        message?: unknown;
        data?: unknown;
      };
      const message =
        typeof payload.message === 'string'
          ? payload.message
          : 'connection refused';
      notifyConnectError(new SocketIoConnectError(message, payload.data));
      refuse(`socket.io: ${message}`);
      return true;
    }

    // DISCONNECT: the server ended this namespace's session.
    endSession(1000, 'socket.io: server disconnected the namespace');
    return true;
  };

  function onRawOpen(): void {
    // Nothing to do: Engine.IO speaks first, with its `0` handshake.
  }

  function onRawMessage(event: unknown): void {
    if (phase === 'terminated') return;
    const { data } = event as { data: unknown };
    if (typeof data !== 'string' || clientClosed) {
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
        endSession(1001, 'socket.io: server closed the session');
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
        if (onControlPacket(data)) return;
        break;
    }

    // Events, plus anything unsupported or malformed: keepline's `decode`
    // turns the latter into a `decode-error` naming what arrived.
    dispatch('message', event);
  }

  function onRawError(event: unknown): void {
    if (phase === 'terminated') return;
    if (!clientClosed && phase === 'connecting' && connectSent) {
      // keepline abandons a transport whose `error` is not followed by `close`
      // within 50ms, and retries it as a plain error. Hold the error so the
      // refusal below is classified by its (synthesized) close instead.
      heldError = event;
      hasHeldError = true;
      return;
    }
    dispatch('error', event);
  }

  function onRawClose(event: unknown): void {
    if (phase === 'terminated') return;
    clearPingTimer();
    const close = event as Partial<CloseEventShape>;

    if (!clientClosed && phase === 'connecting' && connectSent) {
      // The server dropped the connection in answer to our CONNECT — what an
      // auth middleware that closes instead of sending `44` looks like.
      refuse('socket.io: connection closed before CONNECT was acknowledged');
      return;
    }

    phase = 'terminated';
    detach();
    releaseHeldError();
    dispatch('close', {
      code: close.code ?? 1006,
      reason: close.reason ?? '',
      wasClean: close.wasClean ?? false
    });
  }

  raw.addEventListener('open', onRawOpen);
  raw.addEventListener('message', onRawMessage);
  raw.addEventListener('error', onRawError);
  raw.addEventListener('close', onRawClose);

  const transport: WebSocketLike = {
    CONNECTING,
    OPEN,
    CLOSING: 2,
    CLOSED,
    get url() {
      return raw.url;
    },
    get readyState() {
      if (phase === 'terminated') return CLOSED;
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
      if (phase === 'terminated') return;
      const wasConnected = phase === 'connected';
      clientClosed = true;
      clearPingTimer();
      if (wasConnected && raw.readyState === raw.OPEN) {
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

  return transport;
};
