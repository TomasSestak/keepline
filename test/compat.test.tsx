import { act, renderHook } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReadyState, useWebSocket } from '../src/compat/index';
import { resetSharedSockets } from '../src/core/shared';
import {
  MockWebSocket,
  flushMicrotasks,
  mockSocketFactory
} from '../src/testing/mock-websocket';

// The compat layer's whole job is to be a one-line import swap, so it does not
// expose `socketFactory`. Patching the global is how a real consumer would test.
const installFactory = () => {
  const globals = globalThis as { WebSocket?: unknown };
  const original = globals.WebSocket;
  globals.WebSocket = MockWebSocket;
  return () => {
    globals.WebSocket = original;
  };
};

let restore: () => void;

const socket = () => {
  const instance = MockWebSocket.last();
  if (!instance) throw new Error('no MockWebSocket was created');
  return instance;
};

beforeEach(() => {
  MockWebSocket.reset();
  restore = installFactory();
});

afterEach(() => {
  restore();
  resetSharedSockets();
  vi.useRealTimers();
});

describe('keepline/compat', () => {
  it('matches the react-use-websocket surface', () => {
    const { result } = renderHook(() =>
      useWebSocket<{ type: string }>('wss://x')
    );

    expect(result.current.readyState).toBe(ReadyState.CONNECTING);

    act(() => socket().acceptConnection());
    expect(result.current.readyState).toBe(ReadyState.OPEN);

    act(() => socket().serverSend({ type: 'tick' }));
    expect(result.current.lastJsonMessage).toEqual({ type: 'tick' });
    expect(result.current.lastMessage?.data).toBe('{"type":"tick"}');

    act(() => result.current.sendJsonMessage({ hello: true }));
    expect(socket().sentJson.at(-1)).toEqual({ hello: true });

    expect(result.current.getWebSocket()).toBe(socket());
  });

  it('honours filter by keeping messages out of state', () => {
    const { result } = renderHook(() =>
      useWebSocket('wss://x', {
        filter: (message) => JSON.parse(message.data as string).keep === true
      })
    );

    act(() => socket().acceptConnection());
    act(() => socket().serverSend({ keep: false }));
    expect(result.current.lastJsonMessage).toBeNull();

    act(() => socket().serverSend({ keep: true }));
    expect(result.current.lastJsonMessage).toEqual({ keep: true });
  });

  it('does not connect when the third argument is false', () => {
    const { result } = renderHook(() => useWebSocket('wss://x', {}, false));
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(result.current.readyState).toBe(ReadyState.UNINSTANTIATED);
  });

  it('reports a null url as uninstantiated', () => {
    const { result } = renderHook(() => useWebSocket(null));

    expect(MockWebSocket.instances).toHaveLength(0);
    expect(result.current.readyState).toBe(ReadyState.UNINSTANTIATED);
  });

  it('hides the old socket immediately when disabled', () => {
    const { result, rerender } = renderHook(
      ({ connect }: { connect: boolean }) =>
        useWebSocket('wss://disable-transition', {}, connect),
      { initialProps: { connect: true } }
    );

    act(() => socket().acceptConnection());
    expect(result.current.readyState).toBe(ReadyState.OPEN);

    rerender({ connect: false });
    expect(result.current.readyState).toBe(ReadyState.UNINSTANTIATED);
    expect(result.current.getWebSocket()).toBeNull();
  });

  it('closes a keyed physical socket when disabled', async () => {
    const { result, rerender } = renderHook(
      ({ connect }: { connect: boolean }) =>
        useWebSocket('wss://keyed-disable', { key: 'stable-key' }, connect),
      { initialProps: { connect: true } }
    );

    act(() => socket().acceptConnection());
    const wire = socket();
    rerender({ connect: false });

    expect(result.current.readyState).toBe(ReadyState.UNINSTANTIATED);
    expect(result.current.getWebSocket()).toBeNull();
    expect(wire.readyState).toBe(MockWebSocket.CLOSING);
    await act(async () => flushMicrotasks());
    expect(wire.readyState).toBe(MockWebSocket.CLOSED);
  });

  it('keeps auth failures closed without an explicit override', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() =>
      useWebSocket('wss://default-policy', {
        reconnectAttempts: 3,
        reconnectInterval: 10
      })
    );

    act(() => socket().acceptConnection());
    act(() => socket().serverClose({ code: 1008 }));
    await act(async () => vi.advanceTimersByTimeAsync(100));

    expect(result.current.readyState).toBe(ReadyState.CLOSED);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('does not let shouldReconnect override an auth close', async () => {
    vi.useFakeTimers();
    const shouldReconnect = vi.fn(() => true);
    const { result } = renderHook(() =>
      useWebSocket('wss://bounded-policy', {
        reconnectAttempts: 3,
        reconnectInterval: 10,
        shouldReconnect
      })
    );

    act(() => socket().acceptConnection());
    act(() => socket().serverClose({ code: 1008 }));
    await act(async () => vi.advanceTimersByTimeAsync(100));

    expect(shouldReconnect).not.toHaveBeenCalled();
    expect(result.current.readyState).toBe(ReadyState.CLOSED);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('appends queryParams', () => {
    renderHook(() =>
      useWebSocket('wss://x/feed', { queryParams: { token: 'abc', v: 2 } })
    );
    expect(socket().url).toBe('wss://x/feed?token=abc&v=2');
  });

  it('preserves existing query parameters and fragments', () => {
    renderHook(() =>
      useWebSocket('wss://x/feed?old=1#section', {
        queryParams: { token: 'abc' }
      })
    );

    expect(socket().url).toBe('wss://x/feed?old=1&token=abc#section');
  });

  it('appends query parameters to a relative URL before its fragment', () => {
    renderHook(() =>
      useWebSocket('/feed?old=1#section', {
        queryParams: { token: 'abc' }
      })
    );

    expect(socket().url).toBe('/feed?old=1&token=abc#section');
  });

  it('reconnects a resolver when query parameters change', async () => {
    const resolveUrl = () => 'wss://x/resolved';
    const { rerender } = renderHook(
      ({ token }: { token: string }) =>
        useWebSocket(resolveUrl, { queryParams: { token } }),
      { initialProps: { token: 'first' } }
    );
    await act(async () => flushMicrotasks());
    expect(socket().url).toBe('wss://x/resolved?token=first');

    rerender({ token: 'second' });
    await act(async () => flushMicrotasks());

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(socket().url).toBe('wss://x/resolved?token=second');
  });

  it('applies reconnect option changes at the same url', async () => {
    vi.useFakeTimers();
    const reconnecting = {
      reconnectAttempts: 1,
      reconnectInterval: 10
    };
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useWebSocket('wss://mutable-policy', enabled ? reconnecting : {}),
      { initialProps: { enabled: false } }
    );

    act(() => socket().acceptConnection());
    rerender({ enabled: true });
    expect(MockWebSocket.instances).toHaveLength(2);
    act(() => socket().acceptConnection());
    act(() => socket().serverClose({ code: 1006 }));
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(MockWebSocket.instances).toHaveLength(3);

    act(() => socket().acceptConnection());
    rerender({ enabled: false });
    expect(MockWebSocket.instances).toHaveLength(4);
    act(() => socket().acceptConnection());
    act(() => socket().serverClose({ code: 1006 }));
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(MockWebSocket.instances).toHaveLength(4);
  });

  it('honours keep: false by dropping instead of queueing', () => {
    const { result } = renderHook(() => useWebSocket('wss://x'));

    // Not open yet: keep (the default) queues, keep: false drops.
    act(() => result.current.sendMessage('queued'));
    act(() => result.current.sendMessage('dropped', false));
    act(() => result.current.sendJsonMessage({ n: 1 }, false));

    act(() => socket().acceptConnection());
    expect(socket().sent).toEqual(['queued']);
  });

  it('reconnects only when asked, and reports giving up', async () => {
    vi.useFakeTimers();
    const onReconnectStop = vi.fn();

    renderHook(() =>
      useWebSocket('wss://x', {
        shouldReconnect: () => true,
        reconnectAttempts: 1,
        reconnectInterval: 100,
        onReconnectStop
      })
    );

    act(() => socket().acceptConnection());
    act(() => socket().serverClose({ code: 1006 }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(MockWebSocket.instances).toHaveLength(2);

    act(() => socket().serverClose({ code: 1006 }));
    expect(onReconnectStop).toHaveBeenCalledWith(1);
  });

  it('provides native browser event instances to compatibility callbacks', () => {
    const onOpen = vi.fn();
    const onError = vi.fn();
    const onMessage = vi.fn();
    const onClose = vi.fn();
    const shouldReconnect = vi.fn((_event: CloseEvent): boolean => false);

    renderHook(() =>
      useWebSocket('wss://events', {
        onOpen,
        onError,
        onMessage,
        onClose,
        shouldReconnect
      })
    );

    act(() => socket().acceptConnection());
    act(() => socket().serverError());
    act(() => socket().serverSendRaw('hello'));
    act(() =>
      socket().serverClose({ code: 1006, reason: 'offline', wasClean: false })
    );

    const openEvent = onOpen.mock.calls[0]?.[0];
    const errorEvent = onError.mock.calls[0]?.[0];
    const messageEvent = onMessage.mock.calls[0]?.[0];
    const closeEvent = onClose.mock.calls[0]?.[0];
    const reconnectEvent = shouldReconnect.mock.calls[0]?.[0];

    expect(openEvent).toBeInstanceOf(Event);
    expect(openEvent?.type).toBe('open');
    expect(errorEvent).toBeInstanceOf(Event);
    expect(errorEvent?.type).toBe('error');
    expect(messageEvent).toBeInstanceOf(MessageEvent);
    expect(messageEvent).toMatchObject({ type: 'message', data: 'hello' });
    expect(closeEvent).toBeInstanceOf(CloseEvent);
    expect(closeEvent).toMatchObject({
      type: 'close',
      code: 1006,
      reason: 'offline',
      wasClean: false
    });
    expect(reconnectEvent).toBeInstanceOf(CloseEvent);
    expect(reconnectEvent).toMatchObject({
      type: 'close',
      code: 1006,
      reason: 'offline',
      wasClean: false
    });
  });

  it('uses the latest callbacks before layout effects can emit a frame', () => {
    const received: string[] = [];

    const useHarness = (label: string) => {
      useWebSocket('wss://fresh-callback', {
        onMessage: () => received.push(label)
      });
      useLayoutEffect(() => {
        if (label === 'new') socket().serverSendRaw('message');
      }, [label]);
    };

    const { rerender } = renderHook(({ label }) => useHarness(label), {
      initialProps: { label: 'old' }
    });
    act(() => socket().acceptConnection());
    rerender({ label: 'new' });

    expect(received).toEqual(['new']);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('clears last-message state when the connection identity changes', () => {
    const { result, rerender } = renderHook(
      ({ url }: { url: string }) => useWebSocket<{ feed: string }>(url),
      { initialProps: { url: 'wss://first' } }
    );

    act(() => socket().acceptConnection());
    act(() => socket().serverSend({ feed: 'first' }));
    expect(result.current.lastJsonMessage).toEqual({ feed: 'first' });

    rerender({ url: 'wss://second' });

    expect(result.current.lastMessage).toBeNull();
    expect(result.current.lastJsonMessage).toBeNull();
  });
});
