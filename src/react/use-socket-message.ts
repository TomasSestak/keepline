'use client';

import { useEffect, useRef, useState } from 'react';

import type { KeeplineEvent, Socket } from '../core/types';

/**
 * Run a handler for every inbound message, without re-rendering.
 *
 * The default way to consume a feed. The handler is kept in a ref, so an inline
 * arrow function is fine and does not re-subscribe.
 *
 * ```tsx
 * useSocketMessage(socket, (tick) => chartRef.current?.update(tick));
 * ```
 */
export const useSocketMessage = <TIn>(
  socket: Socket<TIn, never> | Socket<TIn, unknown> | null,
  handler: (message: TIn) => void
): void => {
  const handlerRef = useRef(handler);
  // Synced in an effect rather than during render: writing to a ref while
  // rendering breaks the Rules of React and makes React Compiler bail out of
  // optimising this hook. Reading it is always asynchronous (a socket event),
  // so a one-commit lag is not observable.
  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    if (!socket) return;
    return socket.onMessage((message) => handlerRef.current(message));
  }, [socket]);
};

/** Same, for the full {@link KeeplineEvent} stream. */
export const useSocketEvent = <TIn, TOut>(
  socket: Socket<TIn, TOut> | null,
  handler: (event: KeeplineEvent<TIn, TOut>) => void
): void => {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    if (!socket) return;
    return socket.onEvent((event) => handlerRef.current(event));
  }, [socket]);
};

export interface UseLastMessageOptions<TIn, TSelected> {
  /** Ignore messages this rejects. */
  filter?: (message: TIn) => boolean;
  /** Derive the stored value. Return the same reference to skip a re-render. */
  selector?: (message: TIn) => TSelected;
}

/**
 * Keep the most recent message in state.
 *
 * Opt-in, and deliberately not the default: storing messages in state means one
 * re-render per message, for every component that reads it. On a feed that
 * delivers hundreds of messages a second that is the whole performance budget
 * gone — which is exactly why `react-use-websocket`'s always-on
 * `lastJsonMessage` has to be disabled with `filter: () => false` in most real
 * applications.
 *
 * Reach for `filter` to narrow, or {@link useSocketMessage} to avoid rendering
 * altogether.
 */
export const useLastMessage = <TIn, TSelected = TIn>(
  socket: Socket<TIn, never> | Socket<TIn, unknown> | null,
  options: UseLastMessageOptions<TIn, TSelected> = {}
): TSelected | null => {
  const { filter, selector } = options;
  const [value, setValue] = useState<TSelected | null>(null);
  const filterRef = useRef(filter);
  const selectorRef = useRef(selector);
  useEffect(() => {
    filterRef.current = filter;
    selectorRef.current = selector;
  });

  useEffect(() => {
    // A new socket identity means a new stream; the previous connection's last
    // message must not linger as if it came from this one.
    setValue(null);
    if (!socket) return;

    return socket.onMessage((message) => {
      if (filterRef.current && !filterRef.current(message)) return;
      const next = selectorRef.current
        ? selectorRef.current(message)
        : (message as unknown as TSelected);

      setValue((previous) => (Object.is(previous, next) ? previous : next));
    });
  }, [socket]);

  return value;
};
