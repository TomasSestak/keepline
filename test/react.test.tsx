import { act, render, renderHook, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetSharedSockets } from '../src/core/shared';
import { useSocket } from '../src/react/use-socket';
import { useLastMessage } from '../src/react/use-socket-message';
import { useSocketSubscription } from '../src/react/use-socket-subscription';
import {
  MockWebSocket,
  mockSocketFactory
} from '../src/testing/mock-websocket';

const socket = () => {
  const instance = MockWebSocket.last();
  if (!instance) throw new Error('no MockWebSocket was created');
  return instance;
};

beforeEach(() => {
  MockWebSocket.reset();
});

afterEach(() => {
  resetSharedSockets();
  vi.useRealTimers();
});

describe('useSocket', () => {
  it('connects on mount and tracks status', () => {
    const { result } = renderHook(() =>
      useSocket({ url: 'wss://x', socketFactory: mockSocketFactory })
    );

    expect(result.current.status).toBe('connecting');
    expect(result.current.isOpen).toBe(false);

    act(() => socket().acceptConnection());

    expect(result.current.status).toBe('open');
    expect(result.current.isOpen).toBe(true);
  });

  it('destroys the socket on unmount', () => {
    const { result, unmount } = renderHook(() =>
      useSocket({ url: 'wss://x', socketFactory: mockSocketFactory })
    );

    const instance = result.current.socket;
    act(() => socket().acceptConnection());
    unmount();

    expect(instance?.destroyed).toBe(true);
  });

  it('does not reconnect when only a callback identity changes', () => {
    const { rerender } = renderHook(
      ({ tick }: { tick: number }) =>
        useSocket({
          url: 'wss://x',
          socketFactory: mockSocketFactory,
          // A fresh closure every render — the common case, and the one that
          // makes naive implementations reconnect on every keystroke.
          onMessage: () => tick
        }),
      { initialProps: { tick: 0 } }
    );

    act(() => socket().acceptConnection());
    rerender({ tick: 1 });
    rerender({ tick: 2 });

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('reconnects when the url changes', () => {
    const { rerender } = renderHook(
      ({ url }: { url: string }) =>
        useSocket({ url, socketFactory: mockSocketFactory }),
      { initialProps: { url: 'wss://a' } }
    );

    act(() => socket().acceptConnection());
    rerender({ url: 'wss://b' });

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(socket().url).toBe('wss://b');
  });

  it('reconnects when resetKeys change, for auth outside the url', () => {
    const { rerender } = renderHook(
      ({ token }: { token: string }) =>
        useSocket({
          url: 'wss://x',
          protocols: ['proto', `Bearer.${token}`],
          resetKeys: [token],
          socketFactory: mockSocketFactory
        }),
      { initialProps: { token: 'first' } }
    );

    act(() => socket().acceptConnection());
    rerender({ token: 'second' });

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(socket().protocols).toEqual(['proto', 'Bearer.second']);
  });

  it('holds one shared connection across components', () => {
    const Consumer = () => {
      const { status } = useSocket({
        url: 'wss://shared',
        key: 'shared-feed',
        share: true,
        socketFactory: mockSocketFactory
      });
      return <span>{status}</span>;
    };

    render(
      <>
        <Consumer />
        <Consumer />
        <Consumer />
      </>
    );

    expect(MockWebSocket.instances).toHaveLength(1);

    act(() => socket().acceptConnection());
    expect(screen.getAllByText('open')).toHaveLength(3);
  });

  it('rejects share: true with a resolver url and no key', () => {
    // Without a key the resolver is opaque, so every such hook would collide
    // on one shared identity and silently read someone else's connection.
    expect(() =>
      renderHook(() =>
        useSocket({
          url: () => 'wss://x',
          share: true,
          socketFactory: mockSocketFactory
        })
      )
    ).toThrow(/key/);
  });

  it('survives StrictMode double-mounting with one live connection', () => {
    const Consumer = () => {
      const { status } = useSocket({
        url: 'wss://strict',
        key: 'strict-feed',
        share: true,
        socketFactory: mockSocketFactory
      });
      return <span>{status}</span>;
    };

    render(
      <StrictMode>
        <Consumer />
      </StrictMode>
    );

    // Development double-mount must not leave a dead socket behind, nor tear
    // down the one the remounted component is using.
    const live = MockWebSocket.instances.filter(
      (instance) => instance.readyState !== MockWebSocket.CLOSED
    );
    expect(live).toHaveLength(1);

    act(() => live[0]?.acceptConnection());
    expect(screen.getByText('open')).toBeTruthy();
  });
});

describe('useLastMessage', () => {
  it('stores the latest message and respects the filter', () => {
    const { result } = renderHook(() => {
      const { socket: instance } = useSocket<{ type: string; n?: number }>({
        url: 'wss://x',
        socketFactory: mockSocketFactory
      });
      return useLastMessage(instance, {
        filter: (message) => message.type === 'tick'
      });
    });

    act(() => socket().acceptConnection());
    act(() => socket().serverSend({ type: 'noise' }));
    expect(result.current).toBeNull();

    act(() => socket().serverSend({ type: 'tick', n: 1 }));
    expect(result.current).toEqual({ type: 'tick', n: 1 });
  });

  it('clears the stored message when the socket identity changes', () => {
    const { result, rerender } = renderHook(
      ({ url }: { url: string }) => {
        const { socket: instance } = useSocket<{ n: number }>({
          url,
          socketFactory: mockSocketFactory
        });
        return useLastMessage(instance);
      },
      { initialProps: { url: 'wss://a' } }
    );

    act(() => socket().acceptConnection());
    act(() => socket().serverSend({ n: 1 }));
    expect(result.current).toEqual({ n: 1 });

    // The old feed's last message must not masquerade as the new feed's.
    rerender({ url: 'wss://b' });
    expect(result.current).toBeNull();
  });
});

describe('useSocketSubscription', () => {
  it('subscribes, swaps on change, and releases when the spec goes away', () => {
    const { rerender } = renderHook(
      ({ symbols }: { symbols: string[] | null }) => {
        const { socket: instance } = useSocket({
          url: 'wss://x',
          socketFactory: mockSocketFactory
        });
        useSocketSubscription(
          instance,
          symbols
            ? {
                subscribe: { type: 'add', symbols },
                unsubscribe: { type: 'remove', symbols }
              }
            : null
        );
      },
      { initialProps: { symbols: ['EURUSD'] } as { symbols: string[] | null } }
    );

    act(() => socket().acceptConnection());
    expect(socket().sentJson).toEqual([{ type: 'add', symbols: ['EURUSD'] }]);

    // Identity is derived from the payload, so re-rendering with an equal
    // object must not churn the server.
    rerender({ symbols: ['EURUSD'] });
    expect(socket().sentJson).toHaveLength(1);

    rerender({ symbols: ['EURUSD', 'GBPUSD'] });
    expect(socket().sentJson).toEqual([
      { type: 'add', symbols: ['EURUSD'] },
      { type: 'remove', symbols: ['EURUSD'] },
      { type: 'add', symbols: ['EURUSD', 'GBPUSD'] }
    ]);

    rerender({ symbols: null });
    expect(socket().sentJson.at(-1)).toEqual({
      type: 'remove',
      symbols: ['EURUSD', 'GBPUSD']
    });
  });

  it('sends the unsubscribe when a child unmounts under a shared socket', () => {
    const Child = ({ symbol }: { symbol: string }) => {
      const { socket: instance } = useSocket({
        url: 'wss://x',
        key: 'child-feed',
        share: true,
        socketFactory: mockSocketFactory
      });
      useSocketSubscription(instance, {
        subscribe: { type: 'add', symbol },
        unsubscribe: { type: 'remove', symbol }
      });
      return null;
    };

    const Parent = ({ withChild }: { withChild: boolean }) => {
      useSocket({
        url: 'wss://x',
        key: 'child-feed',
        share: true,
        socketFactory: mockSocketFactory
      });
      return withChild ? <Child symbol="EURUSD" /> : null;
    };

    const { rerender } = render(<Parent withChild />);
    act(() => socket().acceptConnection());
    expect(socket().sentJson).toEqual([{ type: 'add', symbol: 'EURUSD' }]);

    // The parent's lease keeps the socket alive, so the child's unsubscribe
    // still reaches the server on the way out.
    rerender(<Parent withChild={false} />);
    expect(socket().sentJson.at(-1)).toEqual({
      type: 'remove',
      symbol: 'EURUSD'
    });
  });
});
