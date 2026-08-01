'use client';

import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';

import { KeeplineError } from '../core/errors';
import type { Socket } from '../core/types';
import type { UseSocketOptions } from './use-socket';
import { useSocket } from './use-socket';

const SocketContext = createContext<Socket<unknown, unknown> | null>(null);

export interface SocketProviderProps<TIn = unknown, TOut = unknown> {
  children: ReactNode;
  /** Options for a socket owned by this provider. */
  options?: UseSocketOptions<TIn, TOut>;
  /** A socket created elsewhere. Takes precedence over `options`. */
  socket?: Socket<TIn, TOut> | null;
}

/**
 * Own one connection at the top of a tree and read it anywhere below.
 *
 * The alternative to `share: true`: explicit ownership and an explicit
 * lifetime, which is usually what you want for the one socket an app is built
 * around.
 */
export const SocketProvider = <TIn = unknown, TOut = unknown>({
  children,
  options,
  socket
}: SocketProviderProps<TIn, TOut>) => {
  const owned = useSocket<TIn, TOut>(options ?? { url: null });
  const value = (socket ?? owned.socket) as Socket<unknown, unknown> | null;

  return (
    <SocketContext.Provider value={value}>{children}</SocketContext.Provider>
  );
};

/** The provided socket, or `null` before the provider's mount effect has run. */
export const useSocketContext = <TIn = unknown, TOut = unknown>(): Socket<
  TIn,
  TOut
> | null => useContext(SocketContext) as Socket<TIn, TOut> | null;

/** As {@link useSocketContext}, but throws instead of returning null. */
export const useRequiredSocketContext = <
  TIn = unknown,
  TOut = unknown
>(): Socket<TIn, TOut> => {
  const socket = useContext(SocketContext);
  if (!socket) {
    throw new KeeplineError(
      "No socket in context. Wrap the tree in <SocketProvider> and read it below the provider (the socket is null during the provider's own first render)."
    );
  }
  return socket as Socket<TIn, TOut>;
};
