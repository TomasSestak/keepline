'use client';

import { useEffect, useRef } from 'react';

import type { Socket, SubscriptionSpec } from '../core/types';
import { identityOfList, structuralIdentityOf } from './identity';
import { useIsomorphicInsertionEffect } from './use-isomorphic-layout-effect';

const identityOf = (
  spec: SubscriptionSpec<unknown> | null | undefined
): string => {
  if (!spec) return 'none';
  if (spec.key !== undefined) return `key:${spec.key}`;
  if (typeof spec.subscribe === 'function') return 'factory';
  return structuralIdentityOf(spec.subscribe);
};

/**
 * Declare a server-side subscription that survives reconnection.
 *
 * The `subscribe` payload is sent on mount and re-sent on every reconnect;
 * `unsubscribe` is sent when the spec changes or the component unmounts.
 *
 * This replaces the effect that every topic-based app hand-writes — send
 * unsubscribe for the previous value, send subscribe for the new one, remember
 * the previous value in a ref — and fixes the bug that version always has:
 * after a reconnect the server has forgotten the subscription, so the effect
 * never re-runs and the feed goes quiet with the socket showing `OPEN`.
 *
 * ```tsx
 * useSocketSubscription(socket, symbols.length ? {
 *   subscribe: { type: 'add', symbols },
 *   unsubscribe: { type: 'remove', symbols }
 * } : null);
 * ```
 *
 * Identity is derived from `key`, or from a structural JSON token for the
 * subscribe payload when no key is given — so an inline object literal does
 * not thrash. Cyclic/non-JSON payloads fall back to reference identity. Pass
 * `deps` to control it explicitly (required for a factory function).
 */
export const useSocketSubscription = <TOut>(
  socket: Socket<never, TOut> | Socket<unknown, TOut> | null,
  spec: SubscriptionSpec<TOut> | null | undefined,
  deps?: readonly unknown[]
): void => {
  const specRef = useRef(spec);
  useIsomorphicInsertionEffect(() => {
    specRef.current = spec;
  }, [spec]);

  const identity = deps ? identityOfList(deps) : identityOf(spec);

  // `identity` stands in for `spec` deliberately: depending on `spec` itself
  // would send an unsubscribe/subscribe pair to the server on every render that
  // passed a fresh object literal — which is every render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    const current = specRef.current;
    if (!socket || !current) return;
    return socket.subscription(current);
  }, [socket, identity]);
};
