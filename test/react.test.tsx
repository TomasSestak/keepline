import { act, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { StrictMode, useEffect, useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSocket } from '../src/core/create-socket';
import { resetSharedSockets } from '../src/core/shared';
import {
  SocketProvider,
  useRequiredSocketContext,
  useSocketContext
} from '../src/react/socket-provider';
import { useSocket } from '../src/react/use-socket';
import {
  useLastMessage,
  useSocketEvent,
  useSocketMessage
} from '../src/react/use-socket-message';
import { useSocketMetrics } from '../src/react/use-socket-status';
import { useSocketSubscription } from '../src/react/use-socket-subscription';
import {
  MockWebSocket,
  flushMicrotasks,
  mockSocketFactory
} from '../src/testing/mock-websocket';

const socket = () => {
  const instance = MockWebSocket.last();
  if (!instance) throw new Error('no MockWebSocket was created');
  return instance;
};

const renderToString = async (children: ReactNode): Promise<string> => {
  const server = await vi.importActual<{
    renderToString(children: ReactNode): string;
  }>('react-dom/server');
  return server.renderToString(children);
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

  it('disables and releases a keyed socket when the url becomes null', async () => {
    const { result, rerender } = renderHook(
      ({ url }: { url: string | null }) =>
        useSocket({
          url,
          key: 'stable-feed-key',
          socketFactory: mockSocketFactory
        }),
      {
        initialProps: {
          url: 'wss://keyed-disable'
        } as { url: string | null }
      }
    );

    act(() => socket().acceptConnection());
    const wire = socket();
    rerender({ url: null });

    expect(result.current.socket).toBeNull();
    expect(result.current.status).toBe('idle');
    expect(wire.readyState).toBe(MockWebSocket.CLOSING);
    await act(async () => flushMicrotasks());
    expect(wire.readyState).toBe(MockWebSocket.CLOSED);
  });

  it('hides stale socket actions during an identity-change commit', () => {
    const observations: Array<{ hasSocket: boolean; sent: boolean }> = [];

    const Child = ({
      changed,
      hasSocket,
      send
    }: {
      changed: boolean;
      hasSocket: boolean;
      send: () => boolean;
    }) => {
      useLayoutEffect(() => {
        if (changed) observations.push({ hasSocket, sent: send() });
      }, [changed, hasSocket, send]);
      return null;
    };

    const Parent = ({ url }: { url: string }) => {
      const result = useSocket<unknown, { type: string }>({
        url,
        socketFactory: mockSocketFactory
      });
      return (
        <Child
          changed={url.endsWith('/b')}
          hasSocket={result.socket !== null}
          send={() => result.send({ type: 'stale' })}
        />
      );
    };

    const view = render(<Parent url="wss://identity/a" />);
    act(() => socket().acceptConnection());
    const firstWire = socket();
    view.rerender(<Parent url="wss://identity/b" />);

    expect(observations[0]).toEqual({ hasSocket: false, sent: false });
    expect(firstWire.sent).toEqual([]);
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

  it('keeps shared onOpen sends scoped during a reentrant reconnect', () => {
    let reconnect: (() => void) | undefined;
    let firstOpens = 0;
    let secondOpens = 0;
    const outcomes: Array<[label: string, sent: boolean]> = [];

    const First = () => {
      const result = useSocket<unknown, string>({
        url: 'wss://shared-open-sender',
        key: 'shared-open-sender',
        share: true,
        socketFactory: mockSocketFactory,
        onOpen: ({ send }) => {
          firstOpens += 1;
          if (firstOpens === 1) reconnect?.();
          const label = `first:${firstOpens}`;
          outcomes.push([label, send(label)]);
        }
      });
      reconnect = result.reconnect;
      return null;
    };

    const Second = () => {
      useSocket<unknown, string>({
        url: 'wss://shared-open-sender',
        key: 'shared-open-sender',
        share: true,
        socketFactory: mockSocketFactory,
        onOpen: ({ send }) => {
          secondOpens += 1;
          const label = `second:${secondOpens}`;
          outcomes.push([label, send(label)]);
        }
      });
      return null;
    };

    render(
      <>
        <First />
        <Second />
      </>
    );

    const first = socket();
    act(() => first.acceptConnection());
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(outcomes).toEqual([
      ['first:1', false],
      ['second:1', false]
    ]);
    expect(first.sent).toEqual([]);

    const replacement = socket();
    act(() => replacement.acceptConnection());
    expect(outcomes).toEqual([
      ['first:1', false],
      ['second:1', false],
      ['first:2', true],
      ['second:2', true]
    ]);
    expect(replacement.sent).toEqual(['first:2', 'second:2']);
  });

  it('fans messages out to every shared consumer and detaches per lease', () => {
    const first = vi.fn();
    const second = vi.fn();

    const Consumer = ({
      onMessage
    }: { onMessage: (value: unknown) => void }) => {
      useSocket({
        url: 'wss://shared-callbacks',
        key: 'shared-callbacks',
        share: true,
        socketFactory: mockSocketFactory,
        onMessage
      });
      return null;
    };

    const { rerender } = render(
      <>
        <Consumer onMessage={first} />
        <Consumer onMessage={second} />
      </>
    );

    act(() => socket().acceptConnection());
    act(() => socket().serverSend({ n: 1 }));

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();

    rerender(<Consumer onMessage={second} />);
    act(() => socket().serverSend({ n: 2 }));

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('fans lifecycle and error callbacks out to every shared consumer', () => {
    const callbacks = [0, 1].map(() => ({
      onOpen: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
      onEvent: vi.fn()
    }));

    const Consumer = ({ index }: { index: number }) => {
      useSocket({
        url: 'wss://shared-lifecycle',
        key: 'shared-lifecycle',
        share: true,
        reconnect: false,
        socketFactory: mockSocketFactory,
        ...callbacks[index]
      });
      return null;
    };

    render(
      <>
        <Consumer index={0} />
        <Consumer index={1} />
      </>
    );

    act(() => socket().acceptConnection());
    act(() => socket().serverError());
    act(() => socket().serverClose({ code: 1006, reason: 'offline' }));

    for (const callback of callbacks) {
      expect(callback.onOpen).toHaveBeenCalledOnce();
      expect(callback.onError).toHaveBeenCalledOnce();
      expect(callback.onClose).toHaveBeenCalledOnce();
      expect(callback.onClose).toHaveBeenCalledWith(
        expect.objectContaining({ code: 1006, reason: 'offline' })
      );
      expect(callback.onEvent.mock.calls.map(([event]) => event.type)).toEqual(
        expect.arrayContaining(['open', 'error', 'close'])
      );
    }
  });

  it('clears imperative actions when a shared lease is released', async () => {
    const { result, unmount } = renderHook(() =>
      useSocket<unknown, { type: string }>({
        url: 'wss://shared-actions',
        key: 'shared-actions',
        share: true,
        socketFactory: mockSocketFactory
      })
    );

    act(() => socket().acceptConnection());
    const wire = socket();
    const { request, send, subscription } = result.current;
    unmount();

    expect(send({ type: 'late-send' })).toBe(false);
    await expect(
      request({ type: 'late-request' }, { match: () => false, timeoutMs: 1 })
    ).rejects.toThrow(/not mounted/i);
    const release = subscription({
      subscribe: { type: 'late-subscribe' },
      unsubscribe: { type: 'late-unsubscribe' }
    });
    release();

    expect(wire.sent).toEqual([]);
  });

  it('compares resetKeys with Object.is semantics for arbitrary values', () => {
    type Props = { resetKeys: readonly unknown[] };
    const firstFunction = () => 1;
    const secondFunction = () => 2;
    const firstCycle: { self?: unknown } = {};
    const secondCycle: { self?: unknown } = {};
    firstCycle.self = firstCycle;
    secondCycle.self = secondCycle;
    const firstSymbol = Symbol('token');
    const secondSymbol = Symbol('token');

    const { rerender } = renderHook(
      ({ resetKeys }: Props) =>
        useSocket({
          url: 'wss://identity',
          resetKeys,
          socketFactory: mockSocketFactory
        }),
      {
        initialProps: {
          resetKeys: [firstFunction, firstCycle, firstSymbol, Number.NaN, 0]
        } as Props
      }
    );

    act(() => socket().acceptConnection());
    rerender({
      resetKeys: [firstFunction, firstCycle, firstSymbol, Number.NaN, 0]
    });
    expect(MockWebSocket.instances).toHaveLength(1);

    rerender({
      resetKeys: [secondFunction, firstCycle, firstSymbol, Number.NaN, 0]
    });
    expect(MockWebSocket.instances).toHaveLength(2);

    rerender({
      resetKeys: [secondFunction, secondCycle, firstSymbol, Number.NaN, 0]
    });
    expect(MockWebSocket.instances).toHaveLength(3);

    rerender({
      resetKeys: [secondFunction, secondCycle, secondSymbol, Number.NaN, 0]
    });
    expect(MockWebSocket.instances).toHaveLength(4);

    rerender({
      resetKeys: [secondFunction, secondCycle, secondSymbol, Number.NaN, -0]
    });
    expect(MockWebSocket.instances).toHaveLength(5);
  });

  it('uses the latest callbacks before layout effects can emit a frame', () => {
    const optionCalls: string[] = [];
    const messageCalls: string[] = [];
    const eventCalls: string[] = [];

    const Consumer = ({ label }: { label: string }) => {
      const { socket: instance } = useSocket({
        url: 'wss://callback-freshness',
        socketFactory: mockSocketFactory,
        onMessage: () => optionCalls.push(label)
      });
      useSocketMessage(instance, () => messageCalls.push(label));
      useSocketEvent(instance, (event) => {
        if (event.type === 'message') eventCalls.push(label);
      });
      useLayoutEffect(() => {
        if (label === 'new') socket().serverSend({ n: 1 });
      }, [label]);
      return null;
    };

    const { rerender } = render(<Consumer label="old" />);
    act(() => socket().acceptConnection());
    rerender(<Consumer label="new" />);

    expect(optionCalls).toEqual(['new']);
    expect(messageCalls).toEqual(['new']);
    expect(eventCalls).toEqual(['new']);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('updates a parent callback before a descendant layout effect emits', () => {
    const calls: string[] = [];

    const Child = ({ emit }: { emit: boolean }) => {
      useLayoutEffect(() => {
        if (emit) socket().serverSend({ n: 1 });
      }, [emit]);
      return null;
    };

    const Parent = ({ label }: { label: string }) => {
      useSocket({
        url: 'wss://parent-callback-freshness',
        socketFactory: mockSocketFactory,
        onMessage: () => calls.push(label)
      });
      return <Child emit={label === 'new'} />;
    };

    const view = render(<Parent label="old" />);
    act(() => socket().acceptConnection());
    view.rerender(<Parent label="new" />);

    expect(calls).toEqual(['new']);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('does not collide shared identities containing delimiter-like values', () => {
    const Consumer = ({ keyName }: { keyName: string }) => {
      useSocket({
        url: 'wss://identity-collision',
        key: keyName,
        share: true,
        socketFactory: mockSocketFactory
      });
      return null;
    };

    render(
      <>
        <Consumer keyName="feed|none|[]|shared" />
        <Consumer keyName="feed" />
      </>
    );

    expect(MockWebSocket.instances).toHaveLength(2);
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

  it('rejects shared protocol resolvers without an explicit key', () => {
    expect(() =>
      renderHook(() =>
        useSocket({
          url: 'wss://x',
          protocols: () => ['token'],
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

describe('SocketProvider', () => {
  it('preserves ordinary children with null context during server rendering', async () => {
    const Consumer = () => (
      <span>{useSocketContext() ? 'connected' : 'server-pending'}</span>
    );

    const html = await renderToString(
      <SocketProvider
        options={{ url: 'wss://ssr', socketFactory: mockSocketFactory }}
      >
        <Consumer />
      </SocketProvider>
    );

    expect(html).toContain('server-pending');
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('shadows an outer socket with null context during server rendering', async () => {
    const external = createSocket({
      url: null,
      autoConnect: false,
      reconnectWhenOnline: false
    });
    const Consumer = () => (
      <span>{useSocketContext() ? 'inherited' : 'server-disabled'}</span>
    );

    const html = await renderToString(
      <SocketProvider socket={external}>
        <SocketProvider options={{ url: null }}>
          <Consumer />
        </SocketProvider>
      </SocketProvider>
    );

    expect(html).toContain('server-disabled');
    external.destroy();
  });

  it('keeps ordinary children mounted while the provider is disabled', () => {
    const Consumer = () => (
      <span>{useSocketContext() ? 'connected' : 'disabled'}</span>
    );

    render(
      <SocketProvider options={{ url: null }}>
        <Consumer />
      </SocketProvider>
    );

    expect(screen.getByText('disabled')).toBeTruthy();
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('shadows an outer socket with null context while disabled', () => {
    const external = createSocket({
      url: null,
      autoConnect: false,
      reconnectWhenOnline: false
    });
    const OptionalConsumer = () => (
      <span>{useSocketContext() ? 'inherited' : 'inner-disabled'}</span>
    );
    const RequiredConsumer = () => {
      useRequiredSocketContext();
      return null;
    };
    const nested = (children: ReactNode) => (
      <SocketProvider socket={external}>
        <SocketProvider options={{ url: null }}>{children}</SocketProvider>
      </SocketProvider>
    );

    const { unmount } = render(nested(<OptionalConsumer />));
    expect(screen.getByText('inner-disabled')).toBeTruthy();
    unmount();

    expect(() => render(nested(<RequiredConsumer />))).toThrow(
      /SocketProvider/
    );
    external.destroy();
  });

  it('does not open an owned transport when an external socket wins', () => {
    const external = createSocket({
      url: null,
      autoConnect: false,
      reconnectWhenOnline: false
    });

    render(
      <SocketProvider
        socket={external}
        options={{
          url: 'wss://must-not-open',
          socketFactory: mockSocketFactory
        }}
      >
        <span>child</span>
      </SocketProvider>
    );

    expect(MockWebSocket.instances).toHaveLength(0);
    external.destroy();
  });

  it('distinguishes an owned provider mounting from a missing provider', () => {
    const Consumer = () => {
      const instance = useRequiredSocketContext();
      return <span>{instance.status}</span>;
    };

    expect(() =>
      render(
        <SocketProvider
          options={{ url: 'wss://owned', socketFactory: mockSocketFactory }}
        >
          <Consumer />
        </SocketProvider>
      )
    ).not.toThrow();
    expect(MockWebSocket.instances).toHaveLength(1);

    expect(() => render(<Consumer />)).toThrow(/SocketProvider/);
  });

  it('mounts required consumers only after the owned socket is real', () => {
    const Consumer = () => {
      const instance = useRequiredSocketContext<unknown, { type: string }>();
      useEffect(() => {
        instance.send({ type: 'boot' });
      }, [instance]);
      return <span>{instance.status}</span>;
    };

    render(
      <SocketProvider<unknown, { type: string }>
        options={{ url: 'wss://owned-boot', socketFactory: mockSocketFactory }}
      >
        <Consumer />
      </SocketProvider>
    );

    expect(MockWebSocket.instances).toHaveLength(1);
    act(() => socket().acceptConnection());
    expect(socket().sentJson).toEqual([{ type: 'boot' }]);
  });

  it('does not broadcast context updates for socket status changes', () => {
    let renders = 0;
    const Consumer = () => {
      useRequiredSocketContext();
      renders += 1;
      return null;
    };

    render(
      <SocketProvider
        options={{
          url: 'wss://stable-context',
          socketFactory: mockSocketFactory
        }}
      >
        <Consumer />
      </SocketProvider>
    );
    expect(renders).toBe(1);

    act(() => socket().acceptConnection());
    expect(renders).toBe(1);
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

  it('never exposes an old message or metrics under a new socket identity', () => {
    const first = createSocket<{ n: number }>({
      url: 'wss://first',
      socketFactory: mockSocketFactory
    });
    const firstWire = MockWebSocket.instances[0];
    const second = createSocket<{ n: number }>({
      url: 'wss://second',
      socketFactory: mockSocketFactory
    });
    const observations: Array<{
      connections: number | null;
      message: { n: number } | null;
    }> = [];

    if (!firstWire) throw new Error('first wire was not created');
    firstWire.acceptConnection();

    const Consumer = ({ instance }: { instance: typeof first }) => {
      const message = useLastMessage(instance);
      const metrics = useSocketMetrics(instance, { intervalMs: 0 });
      useLayoutEffect(() => {
        observations.push({
          connections: metrics?.connections ?? null,
          message
        });
      }, [message, metrics]);
      return null;
    };

    const view = render(<Consumer instance={first} />);
    act(() => firstWire.serverSend({ n: 1 }));
    observations.length = 0;

    view.rerender(<Consumer instance={second} />);

    expect(observations.length).toBeGreaterThan(0);
    expect(observations.every(({ message }) => message === null)).toBe(true);
    expect(observations.every(({ connections }) => connections !== 1)).toBe(
      true
    );

    view.unmount();
    first.destroy();
    second.destroy();
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

  it('compares explicit dependencies by Object.is without serialising them', () => {
    type Props = { dependency: unknown; label: string };
    const firstCycle: { self?: unknown } = {};
    const secondCycle: { self?: unknown } = {};
    firstCycle.self = firstCycle;
    secondCycle.self = secondCycle;

    const { rerender } = renderHook(
      ({ dependency, label }: Props) => {
        const { socket: instance } = useSocket({
          url: 'wss://subscription-deps',
          socketFactory: mockSocketFactory
        });
        useSocketSubscription(
          instance,
          {
            subscribe: { type: 'add', label },
            unsubscribe: { type: 'remove', label }
          },
          [dependency]
        );
      },
      {
        initialProps: { dependency: firstCycle, label: 'first' } as Props
      }
    );

    act(() => socket().acceptConnection());
    expect(socket().sentJson).toEqual([{ type: 'add', label: 'first' }]);

    rerender({ dependency: firstCycle, label: 'first' });
    expect(socket().sentJson).toHaveLength(1);

    rerender({ dependency: secondCycle, label: 'second' });
    expect(socket().sentJson.slice(-2)).toEqual([
      { type: 'remove', label: 'first' },
      { type: 'add', label: 'second' }
    ]);

    const firstFunction = () => 1;
    const secondFunction = () => 1;
    rerender({ dependency: firstFunction, label: 'function-one' });
    rerender({ dependency: secondFunction, label: 'function-two' });
    expect(socket().sentJson.slice(-2)).toEqual([
      { type: 'remove', label: 'function-one' },
      { type: 'add', label: 'function-two' }
    ]);

    const firstSymbol = Symbol('same-description');
    const secondSymbol = Symbol('same-description');
    rerender({ dependency: firstSymbol, label: 'symbol-one' });
    rerender({ dependency: secondSymbol, label: 'symbol-two' });
    expect(socket().sentJson.slice(-2)).toEqual([
      { type: 'remove', label: 'symbol-one' },
      { type: 'add', label: 'symbol-two' }
    ]);
  });
});
