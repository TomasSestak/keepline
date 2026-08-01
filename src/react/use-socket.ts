'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { createSocket } from '../core/create-socket';
import { KeeplineError } from '../core/errors';
import { acquireSharedSocket } from '../core/shared';
import type {
  RequestOptions,
  SendableData,
  Socket,
  SocketOptions,
  SubscriptionSpec,
  Unsubscribe
} from '../core/types';
import { useSocketStatus } from './use-socket-status';

export interface UseSocketOptions<TIn = unknown, TOut = unknown>
  extends SocketOptions<TIn, TOut> {
  /**
   * Reuse one connection for every hook with the same identity, instead of
   * opening one per component. Requires `key` when `url` is a resolver.
   */
  share?: boolean;
  /**
   * Extra values that should force a fresh connection when they change.
   *
   * The escape hatch for auth that does not live in the URL: a token carried in
   * `protocols` is invisible to the default identity, so a refresh would
   * otherwise keep serving the old connection until the server drops it.
   */
  resetKeys?: readonly unknown[];
}

export interface UseSocketResult<TIn = unknown, TOut = unknown> {
  /** `null` until the mount effect has run (and on the server). */
  socket: Socket<TIn, TOut> | null;
  status: Socket<TIn, TOut>['status'];
  readyState: number;
  isOpen: boolean;
  /** Down, but a retry is scheduled or in flight. */
  isReconnecting: boolean;
  /** Down for good — retries are exhausted or disabled. */
  isFailed: boolean;
  send: (payload: TOut) => boolean;
  sendRaw: (data: SendableData) => boolean;
  request: <TResponse = TIn>(
    payload: TOut,
    options?: RequestOptions<TIn>
  ) => Promise<TResponse>;
  subscription: (spec: SubscriptionSpec<TOut>) => Unsubscribe;
  close: (code?: number, reason?: string) => void;
  reconnect: () => void;
}

const stableStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return String(value);
  }
};

const deriveIdentity = <TIn, TOut>(
  options: UseSocketOptions<TIn, TOut>
): string => {
  if (options.key) return `key:${options.key}`;
  if (typeof options.url === 'string') return `url:${options.url}`;
  if (options.url == null) return 'url:none';
  return 'resolver';
};

/**
 * Connect a component to a WebSocket.
 *
 * Callbacks (`onMessage`, `onOpen`, ...) are read from a ref, so inline arrow
 * functions are safe: they never cause a reconnect. Only the connection
 * *identity* — `key`, a string `url`, `protocols`, and `resetKeys` — does.
 *
 * ```tsx
 * const { status, send } = useSocket<ServerMessage>({
 *   url: enabled ? 'wss://api.example.com/feed' : null,
 *   onMessage: (message) => setRows((rows) => apply(rows, message))
 * });
 * ```
 *
 * `url: null` is the idiomatic "not yet" — no conditional hook, no placeholder
 * connection.
 */
export const useSocket = <TIn = unknown, TOut = unknown>(
  options: UseSocketOptions<TIn, TOut>
): UseSocketResult<TIn, TOut> => {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  if (options.share && !options.key && typeof options.url === 'function') {
    throw new KeeplineError(
      'share: true with a resolver `url` needs a `key`. A resolver is opaque, so without one every such hook would silently share a single connection.'
    );
  }

  const [socket, setSocket] = useState<Socket<TIn, TOut> | null>(null);
  const socketRef = useRef<Socket<TIn, TOut> | null>(null);

  const identity = `${deriveIdentity(options)}|${stableStringify(
    typeof options.protocols === 'function' ? 'resolver' : options.protocols
  )}|${stableStringify(options.resetKeys)}|${options.share ? 'shared' : 'own'}`;

  useEffect(() => {
    const current = optionsRef.current;

    // Every handler delegates through the ref, so the socket never has to be
    // recreated just because a caller passed a new closure this render.
    const socketOptions: SocketOptions<TIn, TOut> = {
      ...current,
      // Literals are passed through rather than wrapped, so the core keeps its
      // synchronous connect path: wrapping everything in a resolver would defer
      // every connection by a microtask for no reason.
      url:
        typeof current.url === 'function'
          ? () => {
              const { url } = optionsRef.current;
              return typeof url === 'function' ? url() : url;
            }
          : current.url,
      protocols:
        typeof current.protocols === 'function'
          ? () => {
              const { protocols } = optionsRef.current;
              return typeof protocols === 'function' ? protocols() : protocols;
            }
          : current.protocols,
      onOpen: (context) => optionsRef.current.onOpen?.(context),
      onMessage: (message) => optionsRef.current.onMessage?.(message),
      onClose: (context) => optionsRef.current.onClose?.(context),
      onError: (error, phase) => optionsRef.current.onError?.(error, phase),
      onEvent: (event) => optionsRef.current.onEvent?.(event)
    };

    if (current.share) {
      const lease = acquireSharedSocket<TIn, TOut>(identity, () =>
        createSocket<TIn, TOut>(socketOptions)
      );
      socketRef.current = lease.socket;
      setSocket(lease.socket);
      return lease.release;
    }

    const instance = createSocket<TIn, TOut>(socketOptions);
    socketRef.current = instance;
    setSocket(instance);

    return () => {
      socketRef.current = null;
      instance.destroy();
    };
  }, [identity]);

  const status = useSocketStatus(socket);

  const send = useCallback(
    (payload: TOut) => socketRef.current?.send(payload) ?? false,
    []
  );
  const sendRaw = useCallback(
    (data: SendableData) => socketRef.current?.sendRaw(data) ?? false,
    []
  );
  const request = useCallback(
    <TResponse = TIn>(payload: TOut, requestOptions?: RequestOptions<TIn>) =>
      socketRef.current
        ? socketRef.current.request<TResponse>(payload, requestOptions)
        : Promise.reject(new Error('Socket is not mounted yet')),
    []
  );
  const subscription = useCallback((spec: SubscriptionSpec<TOut>) => {
    return socketRef.current?.subscription(spec) ?? (() => {});
  }, []);
  const close = useCallback((code?: number, reason?: string) => {
    socketRef.current?.close(code, reason);
  }, []);
  const reconnect = useCallback(() => {
    socketRef.current?.reconnect();
  }, []);

  return {
    socket,
    status,
    readyState: socket?.readyState ?? 3,
    isOpen: status === 'open',
    isReconnecting: status === 'reconnecting',
    isFailed: status === 'gave-up',
    send,
    sendRaw,
    request,
    subscription,
    close,
    reconnect
  };
};
