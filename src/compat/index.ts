'use client';

import { useCallback, useMemo, useRef, useState } from 'react';

import { constantBackoff } from '../core/backoff';
import type { RawData, SendableData } from '../core/types';
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
 * exponential backoff), and auth failures are never retried regardless of
 * `shouldReconnect`. MIGRATION.md lists the rest.
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
}

export interface CompatResult<TJson = unknown> {
  sendMessage: (message: string, keep?: boolean) => void;
  sendJsonMessage: (message: unknown, keep?: boolean) => void;
  lastMessage: MessageEvent | null;
  lastJsonMessage: TJson | null;
  readyState: ReadyStateValue;
  getWebSocket: () => WebSocket | null;
}

const makeEvent = (type: string): Event =>
  typeof Event === 'undefined' ? ({ type } as Event) : new Event(type);

const withQueryParams = (
  url: string | null,
  queryParams: Record<string, string | number> | undefined
): string | null => {
  if (!url || !queryParams) return url;

  const [base, existing] = url.split('?');
  const params = new URLSearchParams(existing);
  for (const [key, value] of Object.entries(queryParams)) {
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `${base}?${query}` : (base ?? url);
};

export const useWebSocket = <TJson = unknown>(
  url: string | null,
  options: CompatOptions = {},
  connect = true
): CompatResult<TJson> => {
  const [lastMessage, setLastMessage] = useState<MessageEvent | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const resolvedUrl = connect
    ? withQueryParams(url, options.queryParams)
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

  const { socket, status, send } = useSocket<RawData, SendableData>({
    url: resolvedUrl,
    protocols: options.protocols,
    share: options.share,
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
            return handler({
              code: context.code ?? 1006,
              reason: context.reason ?? '',
              wasClean: context.wasClean ?? false
            } as CloseEvent);
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
    onClose: (context) =>
      optionsRef.current.onClose?.({
        code: context.code,
        reason: context.reason,
        wasClean: context.wasClean
      } as CloseEvent),
    onMessage: (data) => {
      const event = { data } as MessageEvent;
      optionsRef.current.onMessage?.(event);

      const { filter } = optionsRef.current;
      if (filter && !filter(event)) return;
      setLastMessage(event);
    },
    onEvent: (event) => {
      if (event.type === 'gave-up') {
        optionsRef.current.onReconnectStop?.(event.attempts);
      }
    }
  });

  const lastJsonMessage = useMemo<TJson | null>(() => {
    if (lastMessage === null) return null;
    try {
      return typeof lastMessage.data === 'string'
        ? (JSON.parse(lastMessage.data) as TJson)
        : (lastMessage.data as TJson);
    } catch {
      return null;
    }
  }, [lastMessage]);

  const sendMessage = useCallback(
    (message: string, keep = true) => {
      // react-use-websocket semantics: `keep: false` means "only if connected
      // right now", never buffered for later delivery.
      if (!keep && socket?.status !== 'open') return;
      send(message);
    },
    [send, socket]
  );

  const sendJsonMessage = useCallback(
    (message: unknown, keep = true) => {
      sendMessage(JSON.stringify(message), keep);
    },
    [sendMessage]
  );

  const getWebSocket = useCallback(
    () => socket?.getWebSocket() ?? null,
    [socket]
  );

  const readyState: ReadyStateValue = !socket
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
    lastMessage,
    lastJsonMessage,
    readyState,
    getWebSocket
  };
};

export default useWebSocket;
