'use client';

import type { ReactNode } from 'react';
import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore
} from 'react';

import { KeeplineError } from '../core/errors';
import type { Socket } from '../core/types';
import type { UseSocketOptions } from './use-socket';
import { useSocket } from './use-socket';

interface SocketContextValue {
  socket: Socket<unknown, unknown>;
}

const SocketContext = createContext<SocketContextValue | null>(null);

const subscribeToRenderEnvironment = () => () => {};
const getClientRenderSnapshot = () => false;
const getServerRenderSnapshot = () => true;

const useIsServerRender = (): boolean =>
  useSyncExternalStore(
    subscribeToRenderEnvironment,
    getClientRenderSnapshot,
    getServerRenderSnapshot
  );

export interface SocketProviderProps<TIn = unknown, TOut = unknown> {
  children: ReactNode;
  /** Options for a socket owned by this provider. */
  options?: UseSocketOptions<TIn, TOut>;
  /** A socket created elsewhere. Takes precedence over `options`. */
  socket?: Socket<TIn, TOut> | null;
}

function ReadySocketProvider<TIn, TOut>({
  children,
  socket
}: Required<Pick<SocketProviderProps<TIn, TOut>, 'children' | 'socket'>>) {
  const value = useMemo<SocketContextValue>(
    () => ({ socket: socket as Socket<unknown, unknown> }),
    [socket]
  );

  return (
    <SocketContext.Provider value={value}>{children}</SocketContext.Provider>
  );
}

function OwnedSocketProvider<TIn, TOut>({
  children,
  options
}: Pick<SocketProviderProps<TIn, TOut>, 'children' | 'options'>) {
  const owned = useSocket<TIn, TOut>(options ?? { url: null });
  const isServerRender = useIsServerRender();
  // `useSocket` creates its resource in an effect. Withhold descendants for
  // that one render so a required-context consumer can never capture an inert
  // placeholder and silently lose mount-only work.
  if (!owned.socket) {
    // A literal null URL is deliberately disabled, not still mounting. Server
    // renders also cannot create an owned socket, but must preserve ordinary
    // descendant markup for SSR. In both cases the provider explicitly
    // shadows any outer socket with a truthful null context.
    return options?.url == null || isServerRender ? (
      <SocketContext.Provider value={null}>{children}</SocketContext.Provider>
    ) : null;
  }

  return (
    <ReadySocketProvider socket={owned.socket}>{children}</ReadySocketProvider>
  );
}

function ExternalSocketProvider<TIn, TOut>({
  children,
  socket
}: Required<Pick<SocketProviderProps<TIn, TOut>, 'children' | 'socket'>>) {
  return <ReadySocketProvider socket={socket}>{children}</ReadySocketProvider>;
}

/**
 * Own one connection at the top of a tree and read it anywhere below.
 *
 * The alternative to `share: true`: explicit ownership and an explicit
 * lifetime, which is usually what you want for the one socket an app is built
 * around.
 */
export function SocketProvider<TIn = unknown, TOut = unknown>({
  children,
  options,
  socket
}: SocketProviderProps<TIn, TOut>) {
  if (socket != null) {
    return (
      <ExternalSocketProvider socket={socket}>
        {children}
      </ExternalSocketProvider>
    );
  }
  return (
    <OwnedSocketProvider options={options}>{children}</OwnedSocketProvider>
  );
}

// Declared as `function` rather than generic arrows: in a `.tsx` file Babel's
// parser reads `<TIn = unknown, ...>` as JSX, so an arrow generic makes the
// whole module unparseable for anyone running Babel over the source.

/** The provided socket, or `null` when called outside a provider. */
export function useSocketContext<TIn = unknown, TOut = unknown>(): Socket<
  TIn,
  TOut
> | null {
  return (useContext(SocketContext)?.socket ?? null) as Socket<
    TIn,
    TOut
  > | null;
}

/**
 * As {@link useSocketContext}, but throws when there is no provider.
 */
export function useRequiredSocketContext<
  TIn = unknown,
  TOut = unknown
>(): Socket<TIn, TOut> {
  const context = useContext(SocketContext);
  if (!context?.socket) {
    throw new KeeplineError(
      'No socket context. Wrap the tree in <SocketProvider> before calling useRequiredSocketContext().'
    );
  }
  return context.socket as Socket<TIn, TOut>;
}
