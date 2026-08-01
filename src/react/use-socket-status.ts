'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import type { Socket, SocketMetrics, SocketStatus } from '../core/types';

const noopSubscribe = (): (() => void) => () => {};

/**
 * Subscribe to a socket's status.
 *
 * Built on `useSyncExternalStore`, which is what makes it safe under concurrent
 * rendering: the status is read from the socket at render time rather than
 * mirrored into React state by an effect, so there is no window in which a
 * component can render a status that is already stale.
 */
export const useSocketStatus = (
  socket: Socket<never, never> | Socket<unknown, unknown> | null
): SocketStatus => {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      socket ? socket.onStatusChange(onStoreChange) : noopSubscribe(),
    [socket]
  );

  return useSyncExternalStore(
    subscribe,
    () => socket?.status ?? 'idle',
    () => 'idle' as const
  );
};

export interface UseSocketMetricsOptions {
  /** Poll interval. Default 1000ms. Set 0 to only sample on status changes. */
  intervalMs?: number;
}

/**
 * Poll a socket's metrics into React state.
 *
 * Polling rather than subscribing is deliberate. Metrics change on every frame
 * of a busy feed; pushing each change into React would re-render the tree
 * thousands of times a second to update a counter nobody reads that often. One
 * sample per second is what a status panel actually needs.
 */
export const useSocketMetrics = (
  socket: Socket<never, never> | Socket<unknown, unknown> | null,
  { intervalMs = 1_000 }: UseSocketMetricsOptions = {}
): Readonly<SocketMetrics> | null => {
  const [snapshot, setSnapshot] = useState<Readonly<SocketMetrics> | null>(
    () => (socket ? { ...socket.metrics } : null)
  );

  useEffect(() => {
    if (!socket) {
      setSnapshot(null);
      return;
    }

    const sample = (): void => setSnapshot({ ...socket.metrics });
    sample();

    const offStatus = socket.onStatusChange(sample);
    if (intervalMs <= 0) return offStatus;

    const timer = setInterval(sample, intervalMs);
    return () => {
      offStatus();
      clearInterval(timer);
    };
  }, [socket, intervalMs]);

  return snapshot;
};
