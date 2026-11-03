/**
 * keepline/socket-io — talk to a Socket.IO v4 server over a plain WebSocket.
 *
 * A codec, not a client: it plugs into `createSocket`/`useSocket` through
 * `socketFactory`, `decode`, `encode` and `schema`, and keepline keeps doing
 * what it already does — reconnection, queueing, status, observability.
 *
 * Supported: Engine.IO v4 / Socket.IO protocol v5 over the `websocket`
 * transport, one namespace per socket, JSON events in both directions.
 * Deliberately not supported: the long-polling transport, binary attachments
 * (`45`/`46`) and acknowledgements (`43`, or an event that asks for one).
 * Those arrive as `decode-error` events, never as silently wrong messages.
 */
import { KeeplineError } from '../core/errors';
import type { StandardSchemaV1 } from '../core/standard-schema';
import type {
  RawData,
  SendableData,
  SocketFactory,
  SocketOptions,
  Unsubscribe
} from '../core/types';
import {
  PacketType,
  SocketIoProtocolError,
  containsBinary,
  namespacePrefix,
  normalizeNamespace,
  parsePacket
} from './parser';
import {
  REFUSED_CLOSE_CODE,
  type SocketIoAuth,
  SocketIoConnectError,
  wrapTransport
} from './transport';

export { REFUSED_CLOSE_CODE, SocketIoConnectError, SocketIoProtocolError };
export type { SocketIoAuth };

/**
 * An event map, in the same shape `socket.io` uses for its typed events:
 * `{ NEW: (notification: Notification) => void }`. Interfaces written for a
 * `socket.io` server or client can be reused as-is.
 */
export type SocketIoEvents = object;

/** Any event name, any arguments. The default when no map is given. */
export type DefaultSocketIoEvents = Record<
  string,
  (...args: unknown[]) => void
>;

type EventName<TEvents> = keyof TEvents & string;
type EventArgs<THandler> = THandler extends (...args: infer A) => unknown
  ? A
  : never;

/**
 * One Socket.IO event, as keepline delivers it (inbound) or sends it
 * (outbound). Discriminated on `event`, so `message.event === 'NEW'` narrows
 * `args`.
 */
export type SocketIoMessage<
  TEvents extends SocketIoEvents = DefaultSocketIoEvents
> = {
  [K in EventName<TEvents>]: { event: K; args: EventArgs<TEvents[K]> };
}[EventName<TEvents>];

export interface SocketIoOptions {
  /** Namespace to connect. Default `'/'`. */
  namespace?: string;
  /**
   * Payload of the Socket.IO CONNECT packet — what a server reads as
   * `socket.handshake.auth`. An object, or a function (sync or async) that is
   * called again on every connection attempt, so a refreshed token is used on
   * the next reconnect. A throw or rejection refuses the attempt the same way
   * a server would (see {@link REFUSED_CLOSE_CODE}).
   */
  auth?: SocketIoAuth;
  /**
   * Called when the server refuses the CONNECT with a CONNECT_ERROR (`44`)
   * packet — typically an auth middleware's `next(new Error(...))` — or when
   * `auth()` fails. The socket closes with {@link REFUSED_CLOSE_CODE} either
   * way; this is only where the server's `message`/`data` are available.
   */
  onConnectError?: (error: SocketIoConnectError) => void;
  /**
   * Creates the underlying WebSocket — e.g. `ws` on Node < 22, or
   * `mockSocketFactory` in tests. Pass it here, not to `createSocket`: a
   * `socketFactory` there replaces the codec's own.
   */
  socketFactory?: SocketFactory;
}

/** The slice of `createSocket`/`useSocket` options the codec provides. */
export type SocketIoSocketOptions<
  TListen extends SocketIoEvents,
  TEmit extends SocketIoEvents
> = Required<
  Pick<
    SocketOptions<SocketIoMessage<TListen>, SocketIoMessage<TEmit>>,
    'decode' | 'encode' | 'schema'
  >
> &
  Pick<
    SocketOptions<SocketIoMessage<TListen>, SocketIoMessage<TEmit>>,
    'socketFactory'
  >;

export interface SocketIoCodec<
  TListen extends SocketIoEvents,
  TEmit extends SocketIoEvents
> {
  /** Spread into `createSocket({ url, ...io.options })` or `useSocket`. */
  readonly options: SocketIoSocketOptions<TListen, TEmit>;
  /**
   * Send an event (`42[...]`). Goes through keepline's queue, so an emit made
   * before the server acknowledged the CONNECT is sent right after it.
   * Accepts a `Socket` or the result of `useSocket`.
   */
  emit<K extends EventName<TEmit>>(
    target: { send(payload: SocketIoMessage<TEmit>): boolean },
    event: K,
    ...args: EventArgs<TEmit[K]>
  ): boolean;
  /** Listen for one event by name. Returns the unsubscribe function. */
  on<K extends EventName<TListen>>(
    socket: {
      onMessage(
        listener: (message: SocketIoMessage<TListen>) => void
      ): Unsubscribe;
    },
    event: K,
    handler: (...args: EventArgs<TListen[K]>) => void
  ): Unsubscribe;
}

const describeEngineType = (type: string): string => {
  switch (type) {
    case '0':
      // The wrapper consumes the handshake, so keepline seeing one means the
      // codec's socketFactory was replaced.
      return 'an Engine.IO handshake: is the codec bypassed? Pass socketFactory to socketIo(), not to createSocket()';
    case '1':
      return 'an Engine.IO close';
    case '2':
      return 'an Engine.IO ping with a payload';
    case '5':
      return 'an Engine.IO upgrade (only the websocket transport is supported)';
    default:
      return `unknown Engine.IO packet type ${JSON.stringify(type)}`;
  }
};

/**
 * Create a Socket.IO codec for one namespace.
 *
 * ```ts
 * const io = socketIo<ServerEvents, ClientEvents>({
 *   auth: async () => ({ token: await getToken() })
 * });
 * const socket = createSocket({
 *   url: socketIoUrl('https://api.example.com', { language: 'en' }),
 *   ...io.options
 * });
 * io.on(socket, 'NEW', (notification) => show(notification));
 * io.emit(socket, 'markRead', { id });
 * ```
 *
 * `status === 'open'` means the server acknowledged the CONNECT, not merely
 * that the WebSocket opened. The server's ping cadence from the handshake
 * (`pingInterval + pingTimeout`) is the liveness check, so keepline's
 * `heartbeat` and `staleAfterMs` are not needed and should stay unset.
 */
export const socketIo = <
  TListen extends SocketIoEvents = DefaultSocketIoEvents,
  TEmit extends SocketIoEvents = DefaultSocketIoEvents
>(
  config: SocketIoOptions = {}
): SocketIoCodec<TListen, TEmit> => {
  const namespace = normalizeNamespace(config.namespace);
  const prefix = namespacePrefix(namespace);
  const transportConfig = {
    namespace,
    auth: config.auth,
    onConnectError: config.onConnectError
  };

  const createRaw = config.socketFactory;
  const socketFactory: SocketFactory = (url, protocols) =>
    wrapTransport(
      createRaw
        ? createRaw(url, protocols)
        : protocols === undefined
          ? new WebSocket(url)
          : new WebSocket(url, protocols),
      transportConfig
    );

  const decode = (data: RawData): SocketIoMessage<TListen> => {
    if (typeof data !== 'string') {
      throw new SocketIoProtocolError(
        'binary frames are not supported (binary attachments are out of scope)'
      );
    }
    if (data.charAt(0) !== '4') {
      throw new SocketIoProtocolError(
        `received ${describeEngineType(data.charAt(0))}`
      );
    }

    const packet = parsePacket(data.slice(1));
    if (packet.nsp !== namespace) {
      throw new SocketIoProtocolError(
        `packet for namespace ${packet.nsp}, but this socket is connected to ${namespace}`
      );
    }

    switch (packet.type) {
      case PacketType.EVENT: {
        const { data: payload, id } = packet;
        if (
          !Array.isArray(payload) ||
          payload.length === 0 ||
          typeof payload[0] !== 'string'
        ) {
          throw new SocketIoProtocolError(
            'EVENT payload must be an array starting with the event name'
          );
        }
        const [event, ...args] = payload as [string, ...unknown[]];
        if (id !== undefined) {
          throw new SocketIoProtocolError(
            `event ${JSON.stringify(event)} asks for an acknowledgement, which is not supported`
          );
        }
        return { event, args } as SocketIoMessage<TListen>;
      }
      case PacketType.ACK:
      case PacketType.BINARY_ACK:
        throw new SocketIoProtocolError('acknowledgements are not supported');
      case PacketType.BINARY_EVENT:
        throw new SocketIoProtocolError('binary attachments are not supported');
      default:
        // CONNECT, DISCONNECT and CONNECT_ERROR for this namespace are
        // consumed by the transport; one reaching here arrived out of turn.
        throw new SocketIoProtocolError(
          `unexpected control packet of type ${packet.type}`
        );
    }
  };

  const encode = (payload: SocketIoMessage<TEmit>): SendableData => {
    const { event, args } = (payload ?? {}) as {
      event?: unknown;
      args?: unknown;
    };
    if (typeof event !== 'string' || !Array.isArray(args)) {
      throw new KeeplineError(
        'socket.io: send() takes { event, args }; use io.emit(socket, event, ...args)'
      );
    }
    if (containsBinary(args)) {
      throw new KeeplineError(
        `socket.io: event ${JSON.stringify(event)} contains binary data, and binary attachments are not supported`
      );
    }
    return `42${prefix}${JSON.stringify([event, ...args])}`;
  };

  // Validation is not the point: this carries the message type into
  // `createSocket`'s inference. Pass your own `schema` to validate payloads —
  // it replaces this one and receives the same `{ event, args }` values.
  const schema: StandardSchemaV1<unknown, SocketIoMessage<TListen>> = {
    '~standard': {
      version: 1,
      vendor: 'keepline',
      validate: (value) => ({ value: value as SocketIoMessage<TListen> })
    }
  };

  const options = { decode, encode, schema } as SocketIoSocketOptions<
    TListen,
    TEmit
  >;
  // Read when the options are spread, not when the codec is created. Without
  // a WebSocket global (SSR) and without a factory there is none, so keepline
  // stays idle exactly as it does without the codec; a WebSocket installed
  // after `socketIo()` — a polyfill, a test mock — is still picked up.
  Object.defineProperty(options, 'socketFactory', {
    enumerable: true,
    get: () =>
      createRaw || typeof WebSocket !== 'undefined' ? socketFactory : undefined
  });

  return {
    options,
    emit: (target, event, ...args) =>
      target.send({ event, args } as unknown as SocketIoMessage<TEmit>),
    on: (socket, event, handler) =>
      socket.onMessage((message) => {
        if (message.event !== event) return;
        (handler as (...args: unknown[]) => void)(...message.args);
      })
  };
};

export interface SocketIoUrlOptions {
  /** The server's `path` option. Default `'/socket.io/'`. */
  path?: string;
}

/**
 * Build the WebSocket URL of a Socket.IO server:
 * `<base>/socket.io/?EIO=4&transport=websocket&<query>`.
 *
 * `base` is the server origin, with `http(s)` mapped to `ws(s)`; its path is
 * replaced by `path`. Namespaces are not part of the URL — use
 * `socketIo({ namespace })`. Query values of `undefined`/`null` are skipped.
 */
export const socketIoUrl = (
  base: string,
  query: Record<string, string | number | boolean | null | undefined> = {},
  { path = '/socket.io/' }: SocketIoUrlOptions = {}
): string => {
  const url = new URL(
    base,
    typeof location === 'undefined' ? undefined : location.href
  );
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  // Engine.IO matches its path with a trailing slash, as socket.io-client sends.
  url.pathname = path.endsWith('/') ? path : `${path}/`;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  // Last, so a query can never select another protocol or transport.
  url.searchParams.set('EIO', '4');
  url.searchParams.set('transport', 'websocket');
  return url.toString();
};
