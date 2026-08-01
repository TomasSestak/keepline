import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { constantBackoff } from '../src/core/backoff';
import { createSocket } from '../src/core/create-socket';
import {
  ConnectionClosedError,
  GaveUpError,
  RequestTimeoutError
} from '../src/core/errors';
import type { KeeplineEvent } from '../src/core/types';
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

const collect = <T = unknown>(
  events: KeeplineEvent<T>[]
): ((event: KeeplineEvent<T>) => void) => {
  return (event) => {
    events.push(event);
  };
};

beforeEach(() => {
  MockWebSocket.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createSocket — connecting', () => {
  it('creates the connection synchronously for a literal url', () => {
    const instance = createSocket({
      url: 'wss://example.test/feed',
      socketFactory: mockSocketFactory
    });

    expect(instance.status).toBe('connecting');
    expect(socket().url).toBe('wss://example.test/feed');

    socket().acceptConnection();
    expect(instance.status).toBe('open');
    expect(instance.metrics.connections).toBe(1);
  });

  it('stays idle for a null url and connects once one appears', async () => {
    let url: string | null = null;
    const instance = createSocket({
      url: () => url,
      socketFactory: mockSocketFactory
    });

    await flushMicrotasks();
    expect(instance.status).toBe('idle');
    expect(MockWebSocket.instances).toHaveLength(0);

    url = 'wss://example.test/feed';
    instance.reconnect();
    await flushMicrotasks();

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('re-resolves the url on every attempt so tokens stay fresh', async () => {
    vi.useFakeTimers();
    let token = 'first';

    createSocket({
      url: () => `wss://example.test/feed?token=${token}`,
      socketFactory: mockSocketFactory,
      reconnect: { backoff: constantBackoff(50) }
    });

    await flushMicrotasks();
    socket().acceptConnection();

    token = 'second';
    socket().serverClose({ code: 1006 });

    await vi.advanceTimersByTimeAsync(60);
    await flushMicrotasks();

    expect(socket().url).toContain('token=second');
  });

  it('does not connect at all without a WebSocket implementation (SSR)', () => {
    const globals = globalThis as { WebSocket?: unknown };
    const original = globals.WebSocket;
    // `typeof WebSocket` reads 'undefined' either way, which is what the SSR
    // guard checks.
    globals.WebSocket = undefined;

    try {
      const instance = createSocket({ url: 'wss://example.test/feed' });
      expect(instance.status).toBe('idle');
    } finally {
      globals.WebSocket = original;
    }
  });
});

describe('createSocket — inbound messages', () => {
  it('decodes JSON and delivers to onMessage', () => {
    const received: unknown[] = [];
    createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      onMessage: (message) => received.push(message)
    });

    socket().acceptConnection();
    socket().serverSend({ type: 'tick', price: 1.5 });

    expect(received).toEqual([{ type: 'tick', price: 1.5 }]);
  });

  it('reports malformed frames without throwing or closing', () => {
    const events: KeeplineEvent[] = [];
    const received: unknown[] = [];
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      onMessage: (message) => received.push(message),
      onEvent: collect(events)
    });

    socket().acceptConnection();
    // A throw here would escape into the WebSocket's own event handler, where
    // no error boundary and no try/catch can reach it.
    expect(() => socket().serverSendRaw('{not json')).not.toThrow();

    expect(received).toEqual([]);
    expect(instance.status).toBe('open');
    expect(events.map((event) => event.type)).toContain('decode-error');
    expect(instance.metrics.decodeErrors).toBe(1);
  });

  it('rejects messages that fail the schema', () => {
    const events: KeeplineEvent[] = [];
    const received: unknown[] = [];

    createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      schema: z.object({ type: z.literal('tick'), price: z.number() }),
      onMessage: (message) => received.push(message),
      onEvent: collect(events)
    });

    socket().acceptConnection();
    socket().serverSend({ type: 'tick', price: 'not a number' });
    socket().serverSend({ type: 'tick', price: 2 });

    expect(received).toEqual([{ type: 'tick', price: 2 }]);
    expect(
      events.filter((event) => event.type === 'validation-error')
    ).toHaveLength(1);
  });

  it('keeps message order when the decoder is async', async () => {
    const received: unknown[] = [];
    createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      decode: async (data) => {
        const value = JSON.parse(data as string) as { n: number };
        // Deliberately invert the natural resolution order.
        await new Promise((resolve) => setTimeout(resolve, 10 - value.n));
        return value;
      },
      onMessage: (message) => received.push(message)
    });

    socket().acceptConnection();
    socket().serverSend({ n: 1 });
    socket().serverSend({ n: 2 });
    socket().serverSend({ n: 3 });

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(received).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });
});

describe('createSocket — outbound queue', () => {
  it('buffers sends made before open and flushes them in order', () => {
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory
    });

    expect(instance.send({ n: 1 })).toBe(true);
    expect(instance.send({ n: 2 })).toBe(true);
    expect(socket().sent).toHaveLength(0);

    socket().acceptConnection();

    expect(socket().sentJson).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('drops instead of buffering when the queue is disabled', () => {
    const events: KeeplineEvent[] = [];
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      queue: false,
      onEvent: collect(events)
    });

    expect(instance.send({ n: 1 })).toBe(false);
    expect(
      events.find(
        (event) => event.type === 'dropped' && event.reason === 'queue-disabled'
      )
    ).toBeDefined();
  });
});

describe('createSocket — reconnection', () => {
  it('retries after an abnormal close', async () => {
    vi.useFakeTimers();
    const events: KeeplineEvent[] = [];

    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: { backoff: constantBackoff(100) },
      onEvent: collect(events)
    });

    socket().acceptConnection();
    socket().serverClose({ code: 1006 });

    expect(instance.status).toBe('reconnecting');
    const scheduled = events.find(
      (event) => event.type === 'reconnect-scheduled'
    );
    expect(scheduled).toMatchObject({ attempt: 1, delayMs: 100 });

    await vi.advanceTimersByTimeAsync(100);
    expect(MockWebSocket.instances).toHaveLength(2);

    socket().acceptConnection();
    expect(instance.status).toBe('open');
    expect(instance.metrics.reconnects).toBe(1);
  });

  it('refuses to retry an auth failure', () => {
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: { backoff: constantBackoff(10) }
    });

    socket().acceptConnection();
    socket().serverClose({ code: 1008, reason: 'token expired' });

    // Retrying rejected credentials is how a client earns a rate limit.
    expect(instance.status).toBe('closed');
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('gives up after the retry budget and stops there', async () => {
    vi.useFakeTimers();
    const events: KeeplineEvent[] = [];

    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: { attempts: 2, backoff: constantBackoff(10) },
      onEvent: collect(events)
    });

    socket().acceptConnection();
    socket().serverClose({ code: 1006 });

    await vi.advanceTimersByTimeAsync(10);
    socket().serverClose({ code: 1006 });
    await vi.advanceTimersByTimeAsync(10);
    socket().serverClose({ code: 1006 });
    await vi.advanceTimersByTimeAsync(50);

    expect(instance.status).toBe('gave-up');
    expect(events.some((event) => event.type === 'gave-up')).toBe(true);
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it('ignores a late close from a socket it already abandoned', async () => {
    vi.useFakeTimers();
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: { backoff: constantBackoff(10) }
    });

    const first = socket();
    first.acceptConnection();
    instance.reconnect();

    const second = socket();
    second.acceptConnection();
    expect(instance.status).toBe('open');

    // The replaced socket's close must not tear down its replacement.
    first.serverClose({ code: 1006 });
    await flushMicrotasks();

    expect(instance.status).toBe('open');
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('ignores a connect timeout that fires after close() mid-handshake', async () => {
    vi.useFakeTimers();
    const events: KeeplineEvent[] = [];

    const instance = createSocket({
      url: 'wss://x',
      socketFactory: (url, protocols) => {
        const ws = new MockWebSocket(url, protocols);
        // A real handshake abort can surface its close event arbitrarily late;
        // model the worst case where it never does.
        ws.close = () => {};
        return ws as unknown as WebSocket;
      },
      connectTimeoutMs: 1_000,
      reconnect: { backoff: constantBackoff(10) },
      onEvent: collect(events)
    });

    instance.close();
    await vi.advanceTimersByTimeAsync(5_000);

    // Without clearing the connect timer, the timeout would abandon the
    // closing socket and strand the status, or schedule a retry nobody asked
    // for.
    expect(events.some((event) => event.type === 'connect-timeout')).toBe(
      false
    );
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('does not retry after an explicit close', async () => {
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: { backoff: constantBackoff(10) }
    });

    socket().acceptConnection();
    instance.close(1000, 'done');
    await flushMicrotasks();

    expect(instance.status).toBe('closed');
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});

describe('createSocket — liveness', () => {
  it('pings on an interval and reconnects when no pong arrives', async () => {
    vi.useFakeTimers();
    const events: KeeplineEvent[] = [];

    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      heartbeat: {
        message: { type: 'ping' },
        intervalMs: 1_000,
        timeoutMs: 500,
        isPong: (message) => (message as { type: string }).type === 'pong'
      },
      reconnect: { backoff: constantBackoff(10) },
      onEvent: collect(events)
    });

    socket().acceptConnection();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(socket().sentJson).toEqual([{ type: 'ping' }]);

    // A half-open socket stays OPEN forever and delivers nothing; only the
    // missing pong reveals it.
    await vi.advanceTimersByTimeAsync(500);
    expect(events.some((event) => event.type === 'heartbeat-timeout')).toBe(
      true
    );
    expect(instance.status).toBe('reconnecting');
  });

  it('measures round-trip time when a pong arrives', async () => {
    vi.useFakeTimers();
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      heartbeat: {
        message: { type: 'ping' },
        intervalMs: 1_000,
        timeoutMs: 500
      }
    });

    socket().acceptConnection();
    await vi.advanceTimersByTimeAsync(1_000);
    socket().serverSend({ type: 'pong' });

    expect(instance.metrics.lastRttMs).toBeGreaterThanOrEqual(0);
  });

  it('reconnects when the stream goes silent', async () => {
    vi.useFakeTimers();
    const events: KeeplineEvent[] = [];

    createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      staleAfterMs: 1_000,
      reconnect: { backoff: constantBackoff(10) },
      onEvent: collect(events)
    });

    socket().acceptConnection();
    socket().serverSend({ n: 1 });

    await vi.advanceTimersByTimeAsync(900);
    expect(events.some((event) => event.type === 'stale')).toBe(false);

    await vi.advanceTimersByTimeAsync(200);
    expect(events.some((event) => event.type === 'stale')).toBe(true);
  });

  it('abandons a handshake that never completes', async () => {
    vi.useFakeTimers();
    const events: KeeplineEvent[] = [];

    createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      connectTimeoutMs: 1_000,
      reconnect: { backoff: constantBackoff(10) },
      onEvent: collect(events)
    });

    // Never accepted — a black-holed host keeps the handshake open for tens of
    // seconds, and without this the first retry never happens.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events.some((event) => event.type === 'connect-timeout')).toBe(true);

    await vi.advanceTimersByTimeAsync(10);
    expect(MockWebSocket.instances).toHaveLength(2);
  });
});

describe('createSocket — pause reasons', () => {
  it('stays paused while hidden even when the network comes back', () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden');

    try {
      const instance = createSocket({
        url: 'wss://x',
        socketFactory: mockSocketFactory,
        pauseWhenHidden: true
      });

      expect(instance.status).toBe('paused');
      expect(MockWebSocket.instances).toHaveLength(0);

      // Only one of the two reasons clears; connecting now would defeat
      // pauseWhenHidden.
      onLine.mockReturnValue(true);
      window.dispatchEvent(new Event('online'));

      expect(instance.status).toBe('paused');
      expect(MockWebSocket.instances).toHaveLength(0);

      visibility.mockReturnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));

      expect(instance.status).toBe('connecting');
      expect(MockWebSocket.instances).toHaveLength(1);

      instance.destroy();
    } finally {
      onLine.mockRestore();
      visibility.mockRestore();
    }
  });
});

describe('createSocket — subscriptions', () => {
  it('replays subscriptions on reconnect and unsubscribes on release', async () => {
    vi.useFakeTimers();
    const instance = createSocket<unknown, unknown>({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: { backoff: constantBackoff(10) }
    });

    socket().acceptConnection();

    const release = instance.subscription({
      subscribe: { type: 'subscribe', topic: 'ticks' },
      unsubscribe: { type: 'unsubscribe', topic: 'ticks' }
    });

    expect(socket().sentJson).toEqual([{ type: 'subscribe', topic: 'ticks' }]);

    socket().serverClose({ code: 1006 });
    await vi.advanceTimersByTimeAsync(10);
    socket().acceptConnection();

    // Without replay the socket is open and the server is sending nothing.
    expect(socket().sentJson).toEqual([{ type: 'subscribe', topic: 'ticks' }]);

    release();
    expect(socket().sentJson).toEqual([
      { type: 'subscribe', topic: 'ticks' },
      { type: 'unsubscribe', topic: 'ticks' }
    ]);
  });
});

describe('createSocket — request/response', () => {
  it('resolves with the matching reply', async () => {
    const instance = createSocket<{ id: number; ok: boolean }>({
      url: 'wss://x',
      socketFactory: mockSocketFactory
    });

    socket().acceptConnection();

    const pending = instance.request(
      { id: 7 },
      {
        match: (message) => message.id === 7
      }
    );

    socket().serverSend({ id: 6, ok: false });
    socket().serverSend({ id: 7, ok: true });

    await expect(pending).resolves.toEqual({ id: 7, ok: true });
  });

  it('rejects on timeout', async () => {
    vi.useFakeTimers();
    const instance = createSocket<{ id: number }>({
      url: 'wss://x',
      socketFactory: mockSocketFactory
    });

    socket().acceptConnection();

    const pending = instance.request(
      { id: 1 },
      { match: () => false, timeoutMs: 100 }
    );
    const assertion =
      expect(pending).rejects.toBeInstanceOf(RequestTimeoutError);

    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it('rejects in-flight requests when the connection drops', async () => {
    const instance = createSocket<{ id: number }>({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: false
    });

    socket().acceptConnection();
    const pending = instance.request({ id: 1 }, { match: () => false });
    const assertion = expect(pending).rejects.toThrow(/closed/i);

    socket().serverClose({ code: 1006 });
    await assertion;
  });
});

describe('createSocket — teardown', () => {
  it('destroy() stops everything and does not reconnect', async () => {
    vi.useFakeTimers();
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: { backoff: constantBackoff(10) }
    });

    socket().acceptConnection();
    instance.destroy();

    expect(instance.destroyed).toBe(true);
    expect(instance.send({ n: 1 })).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('waitForOpen rejects immediately on a destroyed socket', async () => {
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory
    });

    instance.destroy();

    // No event will ever fire again, so waiting for one — even with a timeout
    // running — would report the wrong failure, late.
    await expect(instance.waitForOpen()).rejects.toBeInstanceOf(
      ConnectionClosedError
    );
  });

  it('waitForOpen rejects immediately after the retry budget is exhausted', async () => {
    vi.useFakeTimers();
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: { attempts: 1, backoff: constantBackoff(10) }
    });

    socket().acceptConnection();
    socket().serverClose({ code: 1006 });
    await vi.advanceTimersByTimeAsync(10);
    socket().serverClose({ code: 1006 });

    expect(instance.status).toBe('gave-up');
    await expect(instance.waitForOpen()).rejects.toBeInstanceOf(GaveUpError);
  });

  it('subscription() after destroy registers nothing and sends nothing', () => {
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory
    });

    socket().acceptConnection();
    instance.destroy();

    const release = instance.subscription({
      subscribe: { type: 'subscribe', topic: 'ticks' }
    });

    expect(() => release()).not.toThrow();
    expect(socket().sent).toHaveLength(0);
  });

  it('accounts for downtime across a reconnect', async () => {
    vi.useFakeTimers();
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: { backoff: constantBackoff(500) }
    });

    socket().acceptConnection();
    socket().serverClose({ code: 1006 });

    await vi.advanceTimersByTimeAsync(500);
    socket().acceptConnection();

    expect(instance.metrics.totalDowntimeMs).toBeGreaterThanOrEqual(500);
  });
});
