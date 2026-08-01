import type { Socket } from './types';

interface Entry {
  socket: Socket<never, never>;
  refs: number;
  disposeTimer?: ReturnType<typeof setTimeout>;
}

const registry = new Map<string, Entry>();

export interface SharedSocketLease<TIn, TOut> {
  socket: Socket<TIn, TOut>;
  /** Drop this lease. The socket is destroyed once the last lease is released. */
  release: () => void;
}

export interface AcquireOptions {
  /**
   * How long to keep a socket alive after its last lease is released.
   * Default 250ms.
   *
   * A grace period is not an optimisation, it is a correctness requirement in
   * React: StrictMode mounts effects twice in development, and route
   * transitions unmount the old consumer before mounting the new one. Without
   * it, both patterns tear down a perfectly good connection and immediately
   * open another.
   */
  graceMs?: number;
}

/**
 * Reference-counted socket sharing.
 *
 * Ten components wanting the same feed should mean one connection, and the last
 * one leaving should close it. `create` is only called when no socket exists for
 * `key`.
 *
 * ```ts
 * const { socket, release } = acquireSharedSocket('ticks', () =>
 *   createSocket({ url: 'wss://example.com/ticks' })
 * );
 * ```
 */
export const acquireSharedSocket = <TIn = unknown, TOut = unknown>(
  key: string,
  create: () => Socket<TIn, TOut>,
  { graceMs = 250 }: AcquireOptions = {}
): SharedSocketLease<TIn, TOut> => {
  let entry = registry.get(key);

  if (entry?.socket.destroyed) {
    if (entry.disposeTimer !== undefined) clearTimeout(entry.disposeTimer);
    registry.delete(key);
    entry = undefined;
  }

  if (!entry) {
    entry = { socket: create() as unknown as Socket<never, never>, refs: 0 };
    registry.set(key, entry);
  }

  if (entry.disposeTimer !== undefined) {
    clearTimeout(entry.disposeTimer);
    entry.disposeTimer = undefined;
  }

  entry.refs += 1;
  const held = entry;
  let released = false;

  return {
    socket: held.socket as unknown as Socket<TIn, TOut>,
    release: () => {
      if (released) return;
      released = true;
      held.refs -= 1;
      if (held.refs > 0) return;

      const dispose = (): void => {
        if (held.refs > 0) return;
        if (registry.get(key) === held) registry.delete(key);
        held.socket.destroy();
      };

      if (graceMs <= 0) {
        dispose();
        return;
      }
      held.disposeTimer = setTimeout(() => {
        held.disposeTimer = undefined;
        dispose();
      }, graceMs);
    }
  };
};

/** Live view of shared sockets. For devtools and debugging. */
export const listSharedSockets = (): ReadonlyArray<{
  key: string;
  refs: number;
  status: string;
}> =>
  [...registry.entries()].map(([key, entry]) => ({
    key,
    refs: entry.refs,
    status: entry.socket.status
  }));

/** Destroy every shared socket. Call between tests. */
export const resetSharedSockets = (): void => {
  for (const [key, entry] of registry) {
    if (entry.disposeTimer !== undefined) clearTimeout(entry.disposeTimer);
    registry.delete(key);
    entry.socket.destroy();
  }
};
