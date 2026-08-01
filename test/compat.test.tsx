import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReadyState, useWebSocket } from '../src/compat/index';
import { resetSharedSockets } from '../src/core/shared';
import {
  MockWebSocket,
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
    renderHook(() => useWebSocket('wss://x', {}, false));
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('appends queryParams', () => {
    renderHook(() =>
      useWebSocket('wss://x/feed', { queryParams: { token: 'abc', v: 2 } })
    );
    expect(socket().url).toBe('wss://x/feed?token=abc&v=2');
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
});
