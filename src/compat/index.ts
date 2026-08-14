'use client';

import { useCallback, useMemo, useRef, useState } from 'react';

import { constantBackoff } from '../core/backoff';
import type { RawData, SendableData } from '../core/types';
import { identityOf } from '../react/identity';
import { useIsomorphicInsertionEffect } from '../react/use-isomorphic-layout-effect';
import { useSocket } from '../react/use-socket';

/**
 * Drop-in replacement layer for `react-use-websocket`.
 *
 * ```diff
 * - import useWebSocket, { ReadyState } from 'react-use-websocket';
 * + import { useWebSocket, ReadyState } from 'keepline/compat';
 * ```
 *
 * The point is to make the switch a one-line diff, then let you move call sites
 * to `keepline/react` one at a time.
 *
 * Two behavioural differences worth knowing: your `reconnectInterval` is
 * honoured exactly here (direct `keepline/react` use defaults to jittered
 * exponential backoff), and delivered auth or protocol close codes cannot be
 * retried by `shouldReconnect`. An `error` without a `close` during the grace
 * period has no code to classify and is controlled by `retryOnError`.
 * MIGRATION.md lists the rest.
 */
export const ReadyState = {
  UNINSTANTIATED: -1,
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3
} as const;

export type ReadyStateValue = (typeof ReadyState)[keyof typeof ReadyState];

export interface CompatHeartbeatOptions {
  message?: string;
  returnMessage?: string;
  /** Silence tolerated before the socket is considered dead. */
  timeout?: number;
  interval?: number;
}

export interface CompatOptions {
  onOpen?: (event: Event) => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (event: Event) => void;
  onMessage?: (event: MessageEvent) => void;
  onReconnectStop?: (attempts: number) => void;
  shouldReconnect?: (event: CloseEvent) => boolean;
  reconnectInterval?: number | ((attempt: number) => number);
  reconnectAttempts?: number;
  /** Return false to keep a message out of `lastMessage`/`lastJsonMessage`. */
  filter?: (message: MessageEvent) => boolean;
  retryOnError?: boolean;
  protocols?: string | string[];
  share?: boolean;
  heartbeat?: boolean | CompatHeartbeatOptions;
  queryParams?: Record<string, string | number>;
  /** Required when sharing a URL resolver, whose result is opaque to React. */
  key?: string;
}

export interface CompatResult<TJson = unknown> {
  sendMessage: (message: SendableData, keep?: boolean) => void;
  sendJsonMessage: (message: unknown, keep?: boolean) => void;
  lastMessage: MessageEvent | null;
  lastJsonMessage: TJson | null;
  readyState: ReadyStateValue;
  getWebSocket: () => WebSocket | null;
}

const makeEvent = (type: string): Event =>
  typeof Event === 'undefined' ? ({ type } as Event) : new Event(type);

const makeMessageEvent = (data: RawData): MessageEvent =>
  typeof MessageEvent === 'undefined'
    ? ({ type: 'message', data } as MessageEvent)
    : new MessageEvent('message', { data });

const makeCloseEvent = (context: {
  code: number;
  reason: string;
  wasClean: boolean;
}): CloseEvent =>
  typeof CloseEvent === 'undefined'
    ? ({ type: 'close', ...context } as CloseEvent)
    : new CloseEvent('close', context);

const withQueryParams = (
  url: string | null,
  queryParams: Record<string, string | number> | undefined
): string | null => {
  if (!url || !queryParams) return url;

  // WebSocket accepts relative URLs in browsers. Work on the URL text so query
  // parameters stay before a fragment without forcing callers to provide an
  // absolute URL (which `new URL(url)` would require without an explicit base).
  const fragmentIndex = url.indexOf('#');
  const fragment = fragmentIndex === -1 ? '' : url.slice(fragmentIndex);
  const withoutFragment =
    fragmentIndex === -1 ? url : url.slice(0, fragmentIndex);
  const queryIndex = withoutFragment.indexOf('?');
  const base =
    queryIndex === -1 ? withoutFragment : withoutFragment.slice(0, queryIndex);
  const existing =
    queryIndex === -1 ? '' : withoutFragment.slice(queryIndex + 1);
  const params = new URLSearchParams(existing);
  for (const [key, value] of Object.entries(queryParams)) {
    params.set(key, String(value));
  }
  const query = params.toString();
  return `${base}${query ? `?${query}` : ''}${fragment}`;
};

export type CompatUrl =
  | string
  | null
  | (() => string | null | Promise<string | null>);

export const useWebSocket = <TJson = unknown>(
  url: CompatUrl,
  options: CompatOptions = {},
  connect = true
): CompatResult<TJson> => {
  const [lastMessageSnapshot, setLastMessageSnapshot] = useState<{
    socket: object | null;
    event: MessageEvent;
  } | null>(null);
  const optionsRef = useRef(options);
  // Kept out of render so React Compiler can optimise this hook — see the same
  // note in `useSocket`.
  useIsomorphicInsertionEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const resolvedUrl = connect
    ? typeof url === 'function'
      ? async () => withQueryParams(await url(), optionsRef.current.queryParams)
      : withQueryParams(url, options.queryParams)
    : null;

  const heartbeat =
    options.heartbeat === true
      ? {}
      : options.heartbeat === false || options.heartbeat === undefined
        ? undefined
        : options.heartbeat;

  const reconnectEnabled =
    options.shouldReconnect !== undefined ||
    options.reconnectAttempts !== undefined ||
    options.retryOnError === true;

  // These settings are captured by the physical core socket. Give them a
  // semantic identity so same-URL rerenders replace the transport when its
  // lifecycle contract changes, while fresh but equivalent option objects do
  // not churn it. Callback-only options still flow through `optionsRef`.
  const queryIdentity = JSON.stringify(
    Object.entries(options.queryParams ?? {}).sort(([left], [right]) =>
      left.localeCompare(right)
    )
  );
  const heartbeatIdentity = JSON.stringify(
    heartbeat
      ? [
          heartbeat.message,
          heartbeat.returnMessage,
          heartbeat.timeout,
          heartbeat.interval
        ]
      : null
  );
  const reconnectIdentity = JSON.stringify([
    reconnectEnabled,
    options.reconnectAttempts,
    options.retryOnError,
    typeof options.reconnectInterval === 'function'
      ? identityOf(options.reconnectInterval)
      : options.reconnectInterval
  ]);

  const { socket, status, send } = useSocket<RawData, SendableData>({
    url: resolvedUrl,
    key: options.key,
    protocols: options.protocols,
    share: options.share,
    resetKeys: [queryIdentity, heartbeatIdentity, reconnectIdentity],
    // `lastMessage` is a MessageEvent in this API, so the raw frame must survive
    // the pipeline undecoded.
    decode: (data) => data,
    encode: (payload) => payload,
    reconnect: reconnectEnabled
      ? {
          attempts: options.reconnectAttempts ?? 20,
          retryOnError: options.retryOnError ?? false,
          backoff:
            typeof options.reconnectInterval === 'function'
              ? options.reconnectInterval
              : constantBackoff(options.reconnectInterval ?? 5_000),
          shouldReconnect: (context) => {
            const handler = optionsRef.current.shouldReconnect;
            if (!handler) return true;
            return handler(
              makeCloseEvent({
                code: context.code ?? 1006,
                reason: context.reason ?? '',
                wasClean: context.wasClean ?? false
              })
            );
          }
        }
      : false,
    heartbeat: heartbeat
      ? {
          message: heartbeat.message ?? 'ping',
          intervalMs: heartbeat.interval ?? 25_000,
          timeoutMs: heartbeat.timeout ?? 60_000,
          isPong: heartbeat.returnMessage
            ? (message) => message === heartbeat.returnMessage
            : undefined
        }
      : false,
    onOpen: () => optionsRef.current.onOpen?.(makeEvent('open')),
    onError: (error) => {
      const handler = optionsRef.current.onError;
      if (!handler) return;
      handler(error instanceof Event ? error : makeEvent('error'));
    },
    onClose: (context) => optionsRef.current.onClose?.(makeCloseEvent(context)),
    onMessage: (data) => {
      const event = makeMessageEvent(data);
      optionsRef.current.onMessage?.(event);

      const { filter } = optionsRef.current;
      if (filter && !filter(event)) return;
      setLastMessageSnapshot({ socket, event });
    },
    onEvent: (event) => {
      if (event.type === 'gave-up') {
        optionsRef.current.onReconnectStop?.(event.attempts);
      }
    }
  });

  const disabled = !connect || (typeof url !== 'function' && url === null);
  const visibleSocket = disabled ? null : socket;
  const visibleLastMessage =
    lastMessageSnapshot?.socket === visibleSocket
      ? lastMessageSnapshot.event
      : null;

  const lastJsonMessage = useMemo<TJson | null>(() => {
    if (visibleLastMessage === null) return null;

    // The branch is kept out of the `try` deliberately: React Compiler cannot
    // yet lower a conditional expression inside a try/catch, and bails out of
    // the whole hook when it meets one.
    const { data } = visibleLastMessage;
    if (typeof data !== 'string') return data as TJson;

    try {
      return JSON.parse(data) as TJson;
    } catch {
      return null;
    }
  }, [visibleLastMessage]);

  const sendMessage = useCallback(
    (message: SendableData, keep = true) => {
      // react-use-websocket semantics: `keep: false` means "only if connected
      // right now", never buffered for later delivery.
      if (disabled || (!keep && socket?.status !== 'open')) return;
      send(message);
    },
    [disabled, send, socket]
  );

  const sendJsonMessage = useCallback(
    (message: unknown, keep = true) => {
      sendMessage(JSON.stringify(message), keep);
    },
    [sendMessage]
  );

  const getWebSocket = useCallback(
    () => (visibleSocket?.getWebSocket() as WebSocket | null) ?? null,
    [visibleSocket]
  );

  const readyState: ReadyStateValue = !visibleSocket
    ? ReadyState.UNINSTANTIATED
    : status === 'idle'
      ? ReadyState.UNINSTANTIATED
      : status === 'open'
        ? ReadyState.OPEN
        : status === 'connecting' || status === 'reconnecting'
          ? ReadyState.CONNECTING
          : status === 'closing'
            ? ReadyState.CLOSING
            : ReadyState.CLOSED;

  return {
    sendMessage,
    sendJsonMessage,
    lastMessage: visibleLastMessage,
    lastJsonMessage,
    readyState,
    getWebSocket
  };
};

export default useWebSocket;
