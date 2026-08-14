'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { createSocket } from '../core/create-socket';
import { KeeplineError, ValidationError } from '../core/errors';
import { acquireSharedSocket } from '../core/shared';
import { formatIssues } from '../core/standard-schema';
import type {
  ErrorPhase,
  KeeplineEvent,
  RequestOptions,
  SendableData,
  Socket,
  SocketOptions,
  SubscriptionSpec,
  Unsubscribe
} from '../core/types';
import { identityOfList } from './identity';
import { useIsomorphicInsertionEffect } from './use-isomorphic-layout-effect';
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

const deriveIdentity = <TIn, TOut>(
  options: UseSocketOptions<TIn, TOut>
): string => {
  // Disabled is a lifecycle dimension of its own. A stable explicit key must
  // not mask a transition to `url: null`, otherwise the old lease stays live.
  if (options.url == null) return 'disabled';
  if (options.key !== undefined) return `key:${options.key}`;
  if (typeof options.url === 'string') return `url:${options.url}`;
  return 'resolver';
};

const protocolsIdentity = (protocols: SocketOptions['protocols']): string => {
  if (typeof protocols === 'function') return 'resolver';
  if (protocols === undefined) return 'none';
  return Array.isArray(protocols)
    ? `list:${JSON.stringify(protocols)}`
    : `value:${protocols}`;
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
  // Insertion timing closes the window in which a descendant layout effect can
  // synchronously drive a test transport with the previous callbacks.
  useIsomorphicInsertionEffect(() => {
    optionsRef.current = options;
  }, [options]);

  if (
    options.share &&
    options.key === undefined &&
    (typeof options.url === 'function' ||
      typeof options.protocols === 'function')
  ) {
    throw new KeeplineError(
      'share: true with a resolver `url` or `protocols` needs a `key`. A resolver is opaque, so without one unrelated hooks could silently share a connection.'
    );
  }

  const identity = JSON.stringify([
    deriveIdentity(options),
    protocolsIdentity(options.protocols),
    identityOfList(options.resetKeys),
    options.share ? 'shared' : 'own'
  ]);
  const [socketSnapshot, setSocketSnapshot] = useState<{
    identity: string;
    socket: Socket<TIn, TOut> | null;
  }>(() => ({ identity, socket: null }));
  const socket =
    socketSnapshot.identity === identity ? socketSnapshot.socket : null;
  const socketRef = useRef<Socket<TIn, TOut> | null>(null);
  const socketIdentityRef = useRef(identity);

  // The connection effect changes resources after layout effects. Invalidate
  // the old imperative handle earlier so a descendant layout effect in this
  // commit cannot send through the previous identity.
  useIsomorphicInsertionEffect(() => {
    if (socketIdentityRef.current === identity) return;
    socketIdentityRef.current = identity;
    socketRef.current = null;
  }, [identity]);

  useEffect(() => {
    const current = optionsRef.current;

    // A literal null URL means disabled, not an idle Socket facade. Besides
    // making the result truthful, this ensures a keyed connection is released
    // when its enable flag turns off.
    if (current.url == null) {
      socketRef.current = null;
      setSocketSnapshot({ identity, socket: null });
      return;
    }

    const notifyError = (error: unknown, phase: ErrorPhase): void => {
      const handler = optionsRef.current.onError;
      if (!handler) return;
      try {
        handler(error, phase);
      } catch {
        // A throwing error handler is not worth a second error.
      }
    };

    const invoke = (callback: () => void): void => {
      try {
        callback();
      } catch (error) {
        notifyError(error, 'listener');
      }
    };

    // Connection behaviour belongs to the physical socket. Consumer callbacks
    // are attached per lease below, so every `share: true` hook receives events
    // and an unmounted hook can detach without affecting the other leases.
    const socketOptions: SocketOptions<TIn, TOut> = {
      ...current,
      autoConnect: false,
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
      onOpen: undefined,
      onMessage: undefined,
      onClose: undefined,
      onError: undefined,
      onEvent: undefined
    };

    const bindCallbacks = (instance: Socket<TIn, TOut>): Unsubscribe => {
      const offMessage = instance.onMessage((message) => {
        invoke(() => optionsRef.current.onMessage?.(message));
      });

      const offEvent = instance.onEvent((event: KeeplineEvent<TIn, TOut>) => {
        invoke(() => optionsRef.current.onEvent?.(event));

        switch (event.type) {
          case 'open':
            invoke(() =>
              optionsRef.current.onOpen?.({
                url: event.url,
                attempt: event.attempt,
                reconnected: event.reconnected,
                send: event.send
              })
            );
            break;
          case 'close': {
            invoke(() =>
              optionsRef.current.onClose?.({
                code: event.code,
                reason: event.reason,
                wasClean: event.wasClean,
                category: event.category,
                willReconnect: event.willReconnect
              })
            );
            break;
          }
          case 'error':
            notifyError(event.error, event.phase);
            break;
          case 'decode-error':
            notifyError(event.error, 'socket');
            break;
          case 'validation-error':
            notifyError(
              new ValidationError(formatIssues(event.issues), event.issues),
              'socket'
            );
            break;
        }
      });

      return () => {
        offEvent();
        offMessage();
      };
    };

    if (current.share) {
      const lease = acquireSharedSocket<TIn, TOut>(identity, () =>
        createSocket<TIn, TOut>(socketOptions)
      );
      const instance = lease.socket;
      const unbind = bindCallbacks(instance);
      socketRef.current = instance;
      socketIdentityRef.current = identity;
      setSocketSnapshot({ identity, socket: instance });
      if (current.autoConnect !== false) instance.connect();

      return () => {
        unbind();
        if (socketRef.current === instance) socketRef.current = null;
        lease.release();
      };
    }

    const instance = createSocket<TIn, TOut>(socketOptions);
    const unbind = bindCallbacks(instance);
    socketRef.current = instance;
    socketIdentityRef.current = identity;
    setSocketSnapshot({ identity, socket: instance });
    if (current.autoConnect !== false) instance.connect();

    return () => {
      unbind();
      if (socketRef.current === instance) socketRef.current = null;
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
