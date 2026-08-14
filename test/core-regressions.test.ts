import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { constantBackoff } from '../src/core/backoff';
import { createSocket } from '../src/core/create-socket';
import {
  ConnectionClosedError,
  GaveUpError,
  RequestTimeoutError,
  SendFailedError
} from '../src/core/errors';
import type { StandardSchemaV1 } from '../src/core/standard-schema';
import type {
  CloseContext,
  ErrorPhase,
  KeeplineEvent,
  WebSocketLike
} from '../src/core/types';
import {
  MockWebSocket,
  flushMicrotasks,
  mockSocketFactory
} from '../src/testing/mock-websocket';

const socket = (): MockWebSocket => {
  const instance = MockWebSocket.last();
  if (!instance) throw new Error('no MockWebSocket was created');
  return instance;
};

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

class EventTargetSocket implements WebSocketLike {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly url: string;
  readyState = this.CONNECTING;
  bufferedAmount = 0;
  extensions = '';
  protocol = '';
  binaryType: 'blob' | 'arraybuffer' = 'blob';
  readonly sent: unknown[] = [];
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  send(data: unknown): void {
    if (this.readyState !== this.OPEN) throw new Error('not open');
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    this.fire('close', { code, reason, wasClean: true });
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  accept(): void {
    this.readyState = this.OPEN;
    this.fire('open', { type: 'open' });
  }

  message(data: unknown): void {
    this.fire('message', { data: JSON.stringify(data) });
  }

  error(event: unknown = { type: 'error' }): void {
    this.fire('error', event);
  }

  private fire(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])])
      listener(event);
  }
}

beforeEach(() => {
  MockWebSocket.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('queued request ownership', () => {
  it('removes a timed-out request before the connection opens', async () => {
    vi.useFakeTimers();
    const instance = createSocket<{ id: number }, { id: number }>({
      url: 'wss://x',
      socketFactory: mockSocketFactory
    });

    const pending = instance.request(
      { id: 1 },
      { match: () => false, timeoutMs: 100 }
    );
    const assertion =
      expect(pending).rejects.toBeInstanceOf(RequestTimeoutError);

    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(instance.metrics.queueSize).toBe(0);

    socket().acceptConnection();
    expect(socket().sent).toEqual([]);
    instance.destroy();
  });

  it('removes an aborted request without disturbing ordinary queued sends', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const instance = createSocket<{ id: number }, { id: number }>({
      url: 'wss://x',
      socketFactory: mockSocketFactory
    });

    const pending = instance.request(
      { id: 1 },
      { match: () => false, signal: controller.signal }
    );
    instance.send({ id: 2 });
    const assertion = expect(pending).rejects.toBe(reason);
    controller.abort(reason);

    await assertion;
    socket().acceptConnection();
    expect(socket().sentJson).toEqual([{ id: 2 }]);
    instance.destroy();
  });

  it('removes a queued request when URL resolution gives up', async () => {
    let resolution = 0;
    const instance = createSocket<{ id: number }, { id: number }>({
      url: async () => {
        resolution += 1;
        if (resolution === 1) throw new Error('no endpoint');
        return 'wss://x';
      },
      socketFactory: mockSocketFactory,
      reconnect: { attempts: 0 }
    });

    const pending = instance.request({ id: 1 }, { match: () => false });
    const assertion = expect(pending).rejects.toBeInstanceOf(GaveUpError);
    await flushMicrotasks(8);
    await assertion;
    expect(instance.metrics.queueSize).toBe(0);

    instance.reconnect();
    await flushMicrotasks();
    socket().acceptConnection();
    expect(socket().sent).toEqual([]);
    instance.destroy();
  });

  it('rejects an overflow-evicted request and sends only its replacement', async () => {
    const instance = createSocket<{ id: number }, { id: number }>({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      queue: { limit: 1, onOverflow: 'drop-oldest' }
    });

    const first = instance.request(
      { id: 1 },
      { match: (reply) => reply.id === 1 }
    );
    const firstAssertion =
      expect(first).rejects.toBeInstanceOf(SendFailedError);
    const second = instance.request(
      { id: 2 },
      { match: (reply) => reply.id === 2 }
    );

    await firstAssertion;
    socket().acceptConnection();
    expect(socket().sentJson).toEqual([{ id: 2 }]);
    socket().serverSend({ id: 2 });
    await expect(second).resolves.toEqual({ id: 2 });
    instance.destroy();
  });

  it('rejects a queued request whose encoder fails during flush', async () => {
    const instance = createSocket<{ id: number }, { id: number }>({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      encode: () => {
        throw new Error('cannot encode');
      }
    });
    const pending = instance.request({ id: 1 }, { match: () => false });
    const assertion = expect(pending).rejects.toBeInstanceOf(SendFailedError);

    socket().acceptConnection();
    await assertion;
    expect(instance.metrics.queueSize).toBe(0);
    expect(instance.status).toBe('open');
    instance.destroy();
  });

  it('skips written and settled payloads after synchronous replacement', async () => {
    const transports: EventTargetSocket[] = [];
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    const sentPayloads: Array<{ id: number }> = [];
    const instance = createSocket<{ id: number }, { id: number }>({
      url: 'wss://x',
      socketFactory: (url) => {
        const transport = new EventTargetSocket(url);
        if (transports.length === 0) {
          const send = transport.send.bind(transport);
          transport.send = (data) => {
            send(data);
            transport.close(1006, 'lost during send');
            holder.instance?.reconnect();
            transports[1]?.accept();
          };
        }
        transports.push(transport);
        return transport;
      },
      reconnect: false,
      onEvent: (event) => {
        if (event.type === 'sent') sentPayloads.push(event.payload);
      }
    });
    holder.instance = instance;

    instance.send({ id: 1 });
    const pending = instance.request(
      { id: 2 },
      { match: () => false, timeoutMs: 1_000 }
    );
    const assertion = expect(pending).rejects.toBeInstanceOf(
      ConnectionClosedError
    );
    instance.send({ id: 3 });

    transports[0]?.accept();
    await assertion;
    expect(transports[0]?.sent).toEqual(['{"id":1}']);
    expect(transports[1]?.sent).toEqual(['{"id":3}']);
    expect(instance.metrics.queueSize).toBe(0);
    expect(instance.metrics.messagesSent).toBe(2);
    expect(sentPayloads).toEqual([{ id: 3 }]);
    instance.destroy();
  });

  it('clears a queued request on destroy', async () => {
    const instance = createSocket<{ id: number }, { id: number }>({
      url: 'wss://x',
      socketFactory: mockSocketFactory
    });
    const pending = instance.request({ id: 1 }, { match: () => false });
    const assertion = expect(pending).rejects.toBeInstanceOf(
      ConnectionClosedError
    );

    instance.destroy();
    await assertion;
    expect(instance.metrics.queueSize).toBe(0);
    expect(socket().sent).toEqual([]);
  });

  it('clears a queued request as soon as close is requested', async () => {
    const instance = createSocket<{ id: number }, { id: number }>({
      url: 'wss://x',
      socketFactory: mockSocketFactory
    });
    const pending = instance.request({ id: 1 }, { match: () => false });
    const assertion = expect(pending).rejects.toBeInstanceOf(
      ConnectionClosedError
    );

    instance.close();
    await assertion;
    expect(instance.metrics.queueSize).toBe(0);
    await flushMicrotasks();
    expect(socket().sent).toEqual([]);
  });
});

describe('generation-scoped async work', () => {
  it('honors an exact EventTarget-only WebSocketLike transport', () => {
    const transports: EventTargetSocket[] = [];
    const received: unknown[] = [];
    const instance = createSocket({
      url: 'wss://event-target',
      socketFactory: (url) => {
        const transport = new EventTargetSocket(url);
        transports.push(transport);
        return transport;
      },
      onMessage: (message) => received.push(message)
    });

    transports[0]?.accept();
    expect(instance.status).toBe('open');
    transports[0]?.message({ ok: true });
    expect(received).toEqual([{ ok: true }]);

    instance.close(1000, 'done');
    expect(instance.status).toBe('closed');
    expect(
      [...(transports[0]?.listeners.values() ?? [])].flatMap((set) => [...set])
    ).toHaveLength(0);
  });

  it('abandons an opening frame superseded by its own event listener', () => {
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    let replaced = false;
    const instance = createSocket({
      url: 'wss://x',
      autoConnect: false,
      socketFactory: mockSocketFactory,
      onEvent: (event) => {
        if (event.type === 'opening' && !replaced) {
          replaced = true;
          holder.instance?.reconnect();
        }
      }
    });
    holder.instance = instance;

    instance.connect();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(instance.getWebSocket()).toBe(socket() as unknown as WebSocket);
    instance.destroy();
  });

  it('closes a factory result returned after a nested reconnect wins', () => {
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    let calls = 0;
    const instance = createSocket({
      url: 'wss://x',
      autoConnect: false,
      socketFactory: (url, protocols) => {
        calls += 1;
        if (calls === 1) holder.instance?.reconnect();
        return new MockWebSocket(url, protocols) as unknown as WebSocket;
      }
    });
    holder.instance = instance;

    instance.connect();
    expect(MockWebSocket.instances).toHaveLength(2);
    const nested = MockWebSocket.instances[0] as MockWebSocket;
    const stale = MockWebSocket.instances[1] as MockWebSocket;
    expect(instance.getWebSocket()).toBe(nested as unknown as WebSocket);
    expect(stale.readyState).not.toBe(MockWebSocket.OPEN);
    nested.acceptConnection();
    expect(instance.status).toBe('open');
    instance.destroy();
  });

  it('does not let onOpen replay or flush after a nested reconnect', () => {
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    let opens = 0;
    const instance = createSocket<unknown, string>({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      onOpen: () => {
        opens += 1;
        if (opens === 1) holder.instance?.reconnect();
      }
    });
    holder.instance = instance;
    instance.subscription({ subscribe: 'subscribe' });
    instance.send('queued');

    const first = socket();
    first.acceptConnection();
    const second = socket();
    expect(first.sent).toEqual([]);
    expect(instance.getWebSocket()).toBe(second as unknown as WebSocket);
    second.acceptConnection();
    expect(second.sent).toEqual(['subscribe', 'queued']);
    instance.destroy();
  });

  it('binds each onOpen sender to the transport that produced it', () => {
    let firstSend: ((payload: string) => boolean) | undefined;
    let currentSend: ((payload: string) => boolean) | undefined;
    let opens = 0;
    const instance = createSocket<unknown, string>({
      url: 'wss://open-sender',
      socketFactory: mockSocketFactory,
      onOpen: ({ send }) => {
        opens += 1;
        if (opens === 1) firstSend = send;
        else currentSend = send;
      }
    });

    const first = socket();
    first.acceptConnection();
    instance.reconnect();
    const second = socket();
    second.acceptConnection();

    if (!firstSend || !currentSend)
      throw new Error('open senders were missing');
    expect(firstSend('stale')).toBe(false);
    expect(currentSend('fresh')).toBe(true);
    expect(first.sent).toEqual([]);
    expect(second.sent).toEqual(['fresh']);
    expect(instance.metrics.queueSize).toBe(0);
    instance.destroy();
  });

  it('does not let a connect-timeout listener abandon its nested reconnect', async () => {
    vi.useFakeTimers();
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    let replaced = false;
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      connectTimeoutMs: 1,
      reconnect: { backoff: constantBackoff(1_000) },
      onEvent: (event) => {
        if (event.type === 'connect-timeout' && !replaced) {
          replaced = true;
          holder.instance?.reconnect();
        }
      }
    });
    holder.instance = instance;

    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(instance.getWebSocket()).toBe(
      MockWebSocket.instances[1] as unknown as WebSocket
    );
    expect(instance.status).toBe('connecting');
    instance.destroy();
  });

  it('keeps the nested reconnect when transport close reenters reconnect', () => {
    const transports: EventTargetSocket[] = [];
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    let nested = false;
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: (url) => {
        const transport = new EventTargetSocket(url);
        if (transports.length === 0) {
          const close = transport.close.bind(transport);
          transport.close = (code, reason) => {
            close(code, reason);
            if (!nested) {
              nested = true;
              holder.instance?.reconnect();
            }
          };
        }
        transports.push(transport);
        return transport;
      }
    });
    holder.instance = instance;
    transports[0]?.accept();

    instance.reconnect();

    expect(transports).toHaveLength(2);
    expect(instance.getWebSocket()).toBe(transports[1]);
    expect(instance.status).toBe('connecting');
    transports[1]?.accept();
    expect(instance.status).toBe('open');
    instance.destroy();
  });

  it('preserves a replacement binding when listener cleanup reenters', () => {
    const transports: EventTargetSocket[] = [];
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    let nested = false;
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: (url) => {
        const transport = new EventTargetSocket(url);
        if (transports.length === 0) {
          const remove = transport.removeEventListener.bind(transport);
          transport.removeEventListener = (type, listener) => {
            remove(type, listener);
            if (!nested) {
              nested = true;
              holder.instance?.reconnect();
            }
          };
        }
        transports.push(transport);
        return transport;
      }
    });
    holder.instance = instance;
    transports[0]?.accept();

    instance.reconnect();

    expect(transports).toHaveLength(2);
    expect(instance.getWebSocket()).toBe(transports[1]);
    transports[1]?.accept();
    expect(instance.status).toBe('open');
    instance.destroy();
    expect(
      [...(transports[1]?.listeners.values() ?? [])].flatMap((set) => [...set])
    ).toHaveLength(0);
  });

  it('keeps a nested reconnect when close-event cleanup reenters', () => {
    const transports: EventTargetSocket[] = [];
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    let nested = false;
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: (url) => {
        const transport = new EventTargetSocket(url);
        if (transports.length === 0) {
          const remove = transport.removeEventListener.bind(transport);
          transport.removeEventListener = (type, listener) => {
            remove(type, listener);
            if (!nested) {
              nested = true;
              holder.instance?.reconnect();
            }
          };
        }
        transports.push(transport);
        return transport;
      }
    });
    holder.instance = instance;
    transports[0]?.accept();

    transports[0]?.close(1006, 'server lost');

    expect(transports).toHaveLength(2);
    expect(instance.getWebSocket()).toBe(transports[1]);
    transports[1]?.accept();
    expect(instance.status).toBe('open');
    instance.destroy();
    expect(
      [...(transports[1]?.listeners.values() ?? [])].flatMap((set) => [...set])
    ).toHaveLength(0);
  });

  it('keeps a nested reconnect when manual-close cleanup reenters', () => {
    const transports: EventTargetSocket[] = [];
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    let nested = false;
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: (url) => {
        const transport = new EventTargetSocket(url);
        if (transports.length === 0) {
          const remove = transport.removeEventListener.bind(transport);
          transport.removeEventListener = (type, listener) => {
            remove(type, listener);
            if (!nested) {
              nested = true;
              holder.instance?.reconnect();
            }
          };
        }
        transports.push(transport);
        return transport;
      }
    });
    holder.instance = instance;
    transports[0]?.accept();

    instance.close();

    expect(transports).toHaveLength(2);
    expect(instance.getWebSocket()).toBe(transports[1]);
    transports[1]?.accept();
    expect(instance.status).toBe('open');
    instance.destroy();
    expect(
      [...(transports[1]?.listeners.values() ?? [])].flatMap((set) => [...set])
    ).toHaveLength(0);
  });

  it('preserves replacement binding when manual close-listener removal reenters', () => {
    const transports: EventTargetSocket[] = [];
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    let removals = 0;
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: (url) => {
        const transport = new EventTargetSocket(url);
        if (transports.length === 0) {
          const remove = transport.removeEventListener.bind(transport);
          transport.removeEventListener = (type, listener) => {
            remove(type, listener);
            removals += 1;
            if (removals === 5) holder.instance?.reconnect();
          };
        }
        transports.push(transport);
        return transport;
      }
    });
    holder.instance = instance;
    transports[0]?.accept();

    instance.close();

    expect(removals).toBeGreaterThanOrEqual(5);
    expect(transports).toHaveLength(2);
    expect(instance.getWebSocket()).toBe(transports[1]);
    transports[1]?.accept();
    instance.destroy();
    expect(
      [...(transports[1]?.listeners.values() ?? [])].flatMap((set) => [...set])
    ).toHaveLength(0);
  });

  it('ignores nested close during manual close-listener removal', () => {
    const transports: EventTargetSocket[] = [];
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    let removals = 0;
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: (url) => {
        const transport = new EventTargetSocket(url);
        if (transports.length === 0) {
          const remove = transport.removeEventListener.bind(transport);
          transport.removeEventListener = (type, listener) => {
            remove(type, listener);
            removals += 1;
            if (removals === 5) holder.instance?.close();
          };
        }
        transports.push(transport);
        return transport;
      }
    });
    holder.instance = instance;
    transports[0]?.accept();

    instance.close();

    expect(removals).toBe(5);
    expect(instance.status).toBe('closed');
    expect(instance.getWebSocket()).toBeNull();
    expect(instance.readyState).toBe(transports[0]?.CLOSED);
    expect(
      [...(transports[0]?.listeners.values() ?? [])].flatMap((set) => [...set])
    ).toHaveLength(0);
  });

  it('records nested close intent during ordinary close-event cleanup', async () => {
    vi.useFakeTimers();
    const transports: EventTargetSocket[] = [];
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    let nested = false;
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: (url) => {
        const transport = new EventTargetSocket(url);
        if (transports.length === 0) {
          const remove = transport.removeEventListener.bind(transport);
          transport.removeEventListener = (type, listener) => {
            remove(type, listener);
            if (!nested) {
              nested = true;
              holder.instance?.close();
            }
          };
        }
        transports.push(transport);
        return transport;
      },
      reconnect: { backoff: constantBackoff(10) }
    });
    holder.instance = instance;
    transports[0]?.accept();

    transports[0]?.close(1006, 'server lost');

    expect(instance.status).toBe('closed');
    expect(instance.getWebSocket()).toBeNull();
    expect(instance.readyState).toBe(transports[0]?.CLOSED);
    expect(instance.metrics.currentAttempt).toBe(0);
    expect(
      [...(transports[0]?.listeners.values() ?? [])].flatMap((set) => [...set])
    ).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(transports).toHaveLength(1);
  });

  it('preserves replacement binding when manual close-listener addition reenters', () => {
    const transports: EventTargetSocket[] = [];
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    let additions = 0;
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: (url) => {
        const transport = new EventTargetSocket(url);
        if (transports.length === 0) {
          const add = transport.addEventListener.bind(transport);
          transport.addEventListener = (type, listener) => {
            add(type, listener);
            additions += 1;
            if (additions === 5) holder.instance?.reconnect();
          };
        }
        transports.push(transport);
        return transport;
      }
    });
    holder.instance = instance;
    transports[0]?.accept();

    instance.close();

    expect(additions).toBe(5);
    expect(transports).toHaveLength(2);
    expect(instance.getWebSocket()).toBe(transports[1]);
    transports[1]?.accept();
    instance.destroy();
    expect(
      [...(transports[1]?.listeners.values() ?? [])].flatMap((set) => [...set])
    ).toHaveLength(0);
  });

  it('does not let a stale-timeout listener abandon its nested reconnect', async () => {
    vi.useFakeTimers();
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    let replaced = false;
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      staleAfterMs: 1,
      reconnect: { backoff: constantBackoff(1_000) },
      onEvent: (event) => {
        if (event.type === 'stale' && !replaced) {
          replaced = true;
          holder.instance?.reconnect();
        }
      }
    });
    holder.instance = instance;
    socket().acceptConnection();

    await vi.advanceTimersByTimeAsync(1);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(instance.getWebSocket()).toBe(
      MockWebSocket.instances[1] as unknown as WebSocket
    );
    expect(instance.status).toBe('connecting');
    instance.destroy();
  });

  it('does not clear a replacement connect timer after stale close reentry', async () => {
    vi.useFakeTimers();
    const transports: EventTargetSocket[] = [];
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    let nested = false;
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: (url) => {
        const transport = new EventTargetSocket(url);
        if (transports.length === 0) {
          const close = transport.close.bind(transport);
          transport.close = (code, reason) => {
            close(code, reason);
            if (!nested) {
              nested = true;
              holder.instance?.reconnect();
            }
          };
        }
        transports.push(transport);
        return transport;
      },
      connectTimeoutMs: 5,
      staleAfterMs: 1,
      reconnect: { backoff: constantBackoff(10) }
    });
    holder.instance = instance;
    transports[0]?.accept();

    await vi.advanceTimersByTimeAsync(1);
    expect(transports).toHaveLength(2);
    expect(instance.getWebSocket()).toBe(transports[1]);

    await vi.advanceTimersByTimeAsync(5);
    expect(instance.status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(10);
    expect(transports).toHaveLength(3);
    expect(instance.getWebSocket()).toBe(transports[2]);
    instance.destroy();
  });

  it('does not let an abandoned decoder block or deliver into a replacement', async () => {
    const oldDecode = deferred<unknown>();
    const received: unknown[] = [];
    let decodeCalls = 0;
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      decode: (data) => {
        decodeCalls += 1;
        return decodeCalls === 1
          ? oldDecode.promise
          : JSON.parse(data as string);
      },
      onMessage: (message) => received.push(message)
    });

    socket().acceptConnection();
    socket().serverSend({ source: 'old' });
    instance.reconnect();
    socket().acceptConnection();
    socket().serverSend({ source: 'new' });

    expect(received).toEqual([{ source: 'new' }]);
    expect(instance.metrics.messagesReceived).toBe(1);

    oldDecode.resolve({ source: 'old' });
    await flushMicrotasks(8);
    expect(received).toEqual([{ source: 'new' }]);
    expect(instance.metrics.messagesReceived).toBe(1);
    instance.destroy();
  });

  it('does not deliver an abandoned async schema result', async () => {
    const oldValidation =
      deferred<StandardSchemaV1.Result<{ source: string }>>();
    const received: Array<{ source: string }> = [];
    let validationCalls = 0;
    const schema: StandardSchemaV1<unknown, { source: string }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value) => {
          validationCalls += 1;
          return validationCalls === 1
            ? oldValidation.promise
            : { value: value as { source: string } };
        }
      }
    };
    const instance = createSocket<{ source: string }>({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      schema,
      onMessage: (message) => received.push(message)
    });

    socket().acceptConnection();
    socket().serverSend({ source: 'old' });
    instance.reconnect();
    socket().acceptConnection();
    socket().serverSend({ source: 'new' });
    expect(received).toEqual([{ source: 'new' }]);

    oldValidation.resolve({ value: { source: 'old' } });
    await flushMicrotasks(8);
    expect(received).toEqual([{ source: 'new' }]);
    instance.destroy();
  });

  it('ignores a decoder rejection after destroy', async () => {
    const decoding = deferred<unknown>();
    const events: KeeplineEvent[] = [];
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      decode: () => decoding.promise,
      onEvent: (event) => events.push(event)
    });

    socket().acceptConnection();
    socket().serverSendRaw('frame');
    instance.destroy();
    const eventCount = events.length;

    decoding.reject(new Error('late failure'));
    await flushMicrotasks(8);
    expect(events).toHaveLength(eventCount);
    expect(instance.metrics.decodeErrors).toBe(0);
  });

  it('invalidates pending URL resolution on close', async () => {
    const url = deferred<string>();
    const instance = createSocket({
      url: () => url.promise,
      socketFactory: mockSocketFactory
    });

    instance.close();
    url.resolve('wss://late');
    await flushMicrotasks(8);

    expect(instance.status).toBe('closed');
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('ignores a stale resolver rejection after a newer attempt starts', async () => {
    const firstUrl = deferred<string>();
    const errors: ErrorPhase[] = [];
    let resolutions = 0;
    const instance = createSocket({
      url: () => {
        resolutions += 1;
        return resolutions === 1 ? firstUrl.promise : 'wss://new';
      },
      socketFactory: mockSocketFactory,
      onError: (_error, phase) => errors.push(phase)
    });

    instance.reconnect();
    await flushMicrotasks();
    socket().acceptConnection();
    firstUrl.reject(new Error('stale'));
    await flushMicrotasks(8);

    expect(instance.status).toBe('open');
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(errors).toEqual([]);
    instance.destroy();
  });

  it('does not let a synchronous resolver error overwrite a nested reconnect', async () => {
    vi.useFakeTimers();
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    let resolutions = 0;
    let replaced = false;
    const instance = createSocket({
      url: () => {
        resolutions += 1;
        if (resolutions === 1) throw new Error('first resolution failed');
        return 'wss://replacement';
      },
      autoConnect: false,
      socketFactory: mockSocketFactory,
      reconnect: { backoff: constantBackoff(10) },
      onError: (_error, phase) => {
        if (phase === 'url-resolution' && !replaced) {
          replaced = true;
          holder.instance?.reconnect();
        }
      }
    });
    holder.instance = instance;

    instance.connect();
    await flushMicrotasks();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(instance.getWebSocket()).toBe(
      MockWebSocket.instances[0] as unknown as WebSocket
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(MockWebSocket.instances).toHaveLength(1);
    instance.destroy();
  });

  it('does not let an asynchronous resolver error overwrite a nested reconnect', async () => {
    vi.useFakeTimers();
    const firstUrl = deferred<string>();
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    let resolutions = 0;
    let replaced = false;
    const instance = createSocket({
      url: () => {
        resolutions += 1;
        return resolutions === 1 ? firstUrl.promise : 'wss://replacement';
      },
      autoConnect: false,
      socketFactory: mockSocketFactory,
      reconnect: { backoff: constantBackoff(10) },
      onError: (_error, phase) => {
        if (phase === 'url-resolution' && !replaced) {
          replaced = true;
          holder.instance?.reconnect();
        }
      }
    });
    holder.instance = instance;

    instance.connect();
    firstUrl.reject(new Error('first resolution failed'));
    await flushMicrotasks(8);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(instance.getWebSocket()).toBe(
      MockWebSocket.instances[0] as unknown as WebSocket
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(MockWebSocket.instances).toHaveLength(1);
    instance.destroy();
  });

  it('ignores an old async reconnect decision after manual reconnect', async () => {
    vi.useFakeTimers();
    const decision = deferred<boolean>();
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: {
        backoff: constantBackoff(10),
        shouldReconnect: () => decision.promise
      }
    });

    socket().acceptConnection();
    socket().serverClose({ code: 1006 });
    instance.reconnect();
    socket().acceptConnection();

    decision.resolve(true);
    await flushMicrotasks(8);
    await vi.advanceTimersByTimeAsync(100);

    expect(instance.status).toBe('open');
    expect(MockWebSocket.instances).toHaveLength(2);
    instance.destroy();
  });
});

describe('reconnect policy and error fallback', () => {
  it('does not arm an obsolete timer after reconnect-scheduled reentry', async () => {
    vi.useFakeTimers();
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    let replaced = false;
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: { backoff: constantBackoff(10) },
      onEvent: (event) => {
        if (event.type === 'reconnect-scheduled' && !replaced) {
          replaced = true;
          holder.instance?.reconnect();
        }
      }
    });
    holder.instance = instance;
    socket().acceptConnection();
    socket().serverClose({ code: 1006 });

    expect(MockWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(instance.getWebSocket()).toBe(
      MockWebSocket.instances[1] as unknown as WebSocket
    );
    instance.destroy();
  });

  it('does not duplicate a transport when resumed listener reconnects', () => {
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    let replaced = false;
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      onEvent: (event) => {
        if (event.type === 'resumed' && !replaced) {
          replaced = true;
          holder.instance?.reconnect();
        }
      }
    });
    holder.instance = instance;
    socket().acceptConnection();
    instance.pause();
    expect(instance.status).toBe('paused');

    instance.resume();
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(instance.getWebSocket()).toBe(
      MockWebSocket.instances[1] as unknown as WebSocket
    );
    instance.destroy();
  });

  it('keeps paused state when a paused listener tries to reconnect', () => {
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      onEvent: (event) => {
        if (event.type === 'paused') holder.instance?.reconnect();
      }
    });
    holder.instance = instance;
    socket().acceptConnection();

    instance.pause();
    expect(instance.status).toBe('paused');
    expect(instance.getWebSocket()).toBeNull();
    expect(MockWebSocket.instances).toHaveLength(1);
    instance.destroy();
  });

  it('keeps paused state when cancelling a policy reenters reconnect', () => {
    const decision = deferred<boolean>();
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: { shouldReconnect: () => decision.promise },
      onClose: ({ willReconnect }) => {
        if (!willReconnect) holder.instance?.reconnect();
      }
    });
    holder.instance = instance;
    socket().acceptConnection();
    socket().serverClose({ code: 1006 });

    instance.pause();
    expect(instance.status).toBe('paused');
    expect(instance.getWebSocket()).toBeNull();
    expect(MockWebSocket.instances).toHaveLength(1);
    decision.resolve(true);
    instance.destroy();
  });

  it('does not let gave-up observers clobber a nested reconnect', () => {
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: { attempts: 0 },
      onEvent: (event) => {
        if (event.type === 'gave-up') holder.instance?.reconnect();
      }
    });
    holder.instance = instance;

    socket().acceptConnection();
    socket().serverClose({ code: 1006 });

    expect(instance.status).toBe('connecting');
    expect(MockWebSocket.instances).toHaveLength(2);
    instance.destroy();
  });

  it('retries an error-only event when enabled', async () => {
    vi.useFakeTimers();
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: { backoff: constantBackoff(10) }
    });

    socket().acceptConnection();
    socket().serverError();
    await vi.advanceTimersByTimeAsync(50);
    expect(instance.status).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(10);
    expect(MockWebSocket.instances).toHaveLength(2);
    instance.destroy();
  });

  it('does not orphan a transport when error recovery close reenters', async () => {
    vi.useFakeTimers();
    const transports: EventTargetSocket[] = [];
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    let nested = false;
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: (url) => {
        const transport = new EventTargetSocket(url);
        if (transports.length === 0) {
          const close = transport.close.bind(transport);
          transport.close = (code, reason) => {
            close(code, reason);
            if (!nested) {
              nested = true;
              holder.instance?.reconnect();
            }
          };
        }
        transports.push(transport);
        return transport;
      },
      reconnect: { backoff: constantBackoff(10) }
    });
    holder.instance = instance;
    transports[0]?.accept();

    transports[0]?.error();
    await vi.advanceTimersByTimeAsync(50);

    expect(transports).toHaveLength(2);
    expect(instance.getWebSocket()).toBe(transports[1]);
    expect(instance.status).toBe('connecting');
    transports[1]?.accept();
    await vi.advanceTimersByTimeAsync(100);
    expect(transports).toHaveLength(2);
    expect(instance.status).toBe('open');
    instance.destroy();
  });

  it('lets a delayed non-retryable close own an error recovery', async () => {
    vi.useFakeTimers();
    const transports: EventTargetSocket[] = [];
    const closes: CloseContext[] = [];
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: (url) => {
        const transport = new EventTargetSocket(url);
        transports.push(transport);
        return transport;
      },
      reconnect: { backoff: constantBackoff(10) },
      onClose: (context) => closes.push(context)
    });
    transports[0]?.accept();

    transports[0]?.error();
    setTimeout(() => transports[0]?.close(4401, 'unauthorized'), 1);
    await vi.advanceTimersByTimeAsync(100);

    expect(transports).toHaveLength(1);
    expect(instance.status).toBe('closed');
    expect(closes).toEqual([
      expect.objectContaining({ code: 4401, willReconnect: false })
    ]);
    instance.destroy();
  });

  it('does not orphan a transport when connect-timeout close reenters', async () => {
    vi.useFakeTimers();
    const transports: EventTargetSocket[] = [];
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    let nested = false;
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: (url) => {
        const transport = new EventTargetSocket(url);
        if (transports.length === 0) {
          const close = transport.close.bind(transport);
          transport.close = (code, reason) => {
            close(code, reason);
            if (!nested) {
              nested = true;
              holder.instance?.reconnect();
            }
          };
        }
        transports.push(transport);
        return transport;
      },
      connectTimeoutMs: 1,
      reconnect: { backoff: constantBackoff(10) }
    });
    holder.instance = instance;

    await vi.advanceTimersByTimeAsync(1);

    expect(transports).toHaveLength(2);
    expect(instance.getWebSocket()).toBe(transports[1]);
    expect(instance.status).toBe('connecting');
    transports[1]?.accept();
    await vi.advanceTimersByTimeAsync(100);
    expect(transports).toHaveLength(2);
    expect(instance.status).toBe('open');
    instance.destroy();
  });

  it('keeps a transport opened by resume during pause cleanup', () => {
    const transports: EventTargetSocket[] = [];
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    let resumed = false;
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: (url) => {
        const transport = new EventTargetSocket(url);
        if (transports.length === 0) {
          const close = transport.close.bind(transport);
          transport.close = (code, reason) => {
            close(code, reason);
            if (!resumed) {
              resumed = true;
              holder.instance?.resume();
            }
          };
        }
        transports.push(transport);
        return transport;
      }
    });
    holder.instance = instance;
    transports[0]?.accept();

    instance.pause();

    expect(transports).toHaveLength(2);
    expect(instance.getWebSocket()).toBe(transports[1]);
    expect(instance.status).toBe('connecting');
    transports[1]?.accept();
    expect(instance.status).toBe('open');
    instance.destroy();
  });

  it('commits paused when transport cleanup reenters reconnect', () => {
    const transports: EventTargetSocket[] = [];
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    let nested = false;
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: (url) => {
        const transport = new EventTargetSocket(url);
        if (transports.length === 0) {
          const close = transport.close.bind(transport);
          transport.close = (code, reason) => {
            close(code, reason);
            if (!nested) {
              nested = true;
              holder.instance?.reconnect();
            }
          };
        }
        transports.push(transport);
        return transport;
      }
    });
    holder.instance = instance;
    transports[0]?.accept();

    instance.pause();

    expect(transports).toHaveLength(1);
    expect(instance.getWebSocket()).toBeNull();
    expect(instance.status).toBe('paused');

    instance.resume();
    expect(transports).toHaveLength(2);
    expect(instance.getWebSocket()).toBe(transports[1]);
    expect(instance.status).toBe('connecting');
    instance.destroy();
  });

  it('does not double-retry an error followed by close', async () => {
    vi.useFakeTimers();
    const events: KeeplineEvent[] = [];
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: { backoff: constantBackoff(10) },
      onEvent: (event) => events.push(event)
    });

    socket().acceptConnection();
    socket().serverError();
    socket().serverClose({ code: 1006 });
    await vi.advanceTimersByTimeAsync(100);

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(
      events.filter((event) => event.type === 'reconnect-scheduled')
    ).toHaveLength(1);
    instance.destroy();
  });

  it('settles a pre-open error-only transport when retryOnError is false', async () => {
    vi.useFakeTimers();
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      connectTimeoutMs: 1000,
      reconnect: { retryOnError: false, backoff: constantBackoff(10) }
    });

    const transport = socket();
    transport.serverError();
    await vi.advanceTimersByTimeAsync(50);

    expect(instance.status).toBe('closed');
    expect(instance.getWebSocket()).toBeNull();
    expect(transport.readyState).toBe(MockWebSocket.CLOSED);
    expect(instance.metrics.failedAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(MockWebSocket.instances).toHaveLength(1);
    instance.destroy();
  });

  it('settles a refused error before applying a zero retry budget', async () => {
    vi.useFakeTimers();
    const events: KeeplineEvent[] = [];
    const policy = vi.fn(() => true);
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: {
        attempts: 0,
        retryOnError: false,
        shouldReconnect: policy
      },
      onEvent: (event) => events.push(event)
    });

    socket().serverError();
    await vi.advanceTimersByTimeAsync(50);

    expect(policy).not.toHaveBeenCalled();
    expect(instance.status).toBe('closed');
    expect(events.some((event) => event.type === 'gave-up')).toBe(false);
    expect(MockWebSocket.instances).toHaveLength(1);
    instance.destroy();
  });

  it('lets a close within the error grace period own recovery', async () => {
    vi.useFakeTimers();
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: {
        retryOnError: false,
        backoff: constantBackoff(10)
      }
    });

    socket().serverError();
    socket().serverClose({ code: 1006 });
    await vi.advanceTimersByTimeAsync(11);

    expect(instance.status).toBe('reconnecting');
    expect(MockWebSocket.instances).toHaveLength(2);
    instance.destroy();
  });

  it('settles before a close delivered after the error grace period', async () => {
    vi.useFakeTimers();
    const policy = vi.fn(() => true);
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: {
        retryOnError: false,
        backoff: constantBackoff(10),
        shouldReconnect: policy
      }
    });

    const transport = socket();
    transport.serverError();
    setTimeout(
      () => transport.serverClose({ code: 4401, reason: 'unauthorized' }),
      75
    );
    await vi.advanceTimersByTimeAsync(500);

    expect(policy).not.toHaveBeenCalled();
    expect(instance.status).toBe('closed');
    expect(instance.getWebSocket()).toBeNull();
    expect(MockWebSocket.instances).toHaveLength(1);
    instance.destroy();
  });

  it('settles an error-only transport when reconnection is disabled', async () => {
    vi.useFakeTimers();
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: false
    });

    socket().serverError();
    await vi.advanceTimersByTimeAsync(50);

    expect(instance.status).toBe('closed');
    expect(instance.getWebSocket()).toBeNull();
    expect(MockWebSocket.instances).toHaveLength(1);
    instance.destroy();
  });

  it('settles an open error-only transport when retryOnError is false', async () => {
    vi.useFakeTimers();
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: { retryOnError: false }
    });

    socket().acceptConnection();
    socket().serverError();
    await vi.advanceTimersByTimeAsync(50);

    expect(instance.status).toBe('closed');
    expect(instance.getWebSocket()).toBeNull();
    expect(instance.metrics.failedAttempts).toBe(0);
    expect(MockWebSocket.instances).toHaveLength(1);
    instance.destroy();
  });

  it.each([1008, 1002])(
    'does not let shouldReconnect override refused close code %i',
    async (code) => {
      vi.useFakeTimers();
      const closes: CloseContext[] = [];
      const policy = vi.fn(() => true);
      const instance = createSocket({
        url: 'wss://x',
        socketFactory: mockSocketFactory,
        reconnect: { backoff: constantBackoff(10), shouldReconnect: policy },
        onClose: (context) => closes.push(context)
      });

      socket().acceptConnection();
      socket().serverClose({ code });

      // The callback narrows the built-in policy rather than replacing it, so a
      // blanket `true` cannot resurrect an auth failure. It is not consulted at
      // all once a hard bound has already refused.
      expect(policy).not.toHaveBeenCalled();
      expect(closes).toHaveLength(1);
      expect(closes[0]?.willReconnect).toBe(false);
      await vi.advanceTimersByTimeAsync(10);
      expect(MockWebSocket.instances).toHaveLength(1);
      expect(instance.status).toBe('closed');
      instance.destroy();
    }
  );

  it('settles a refused close before applying a zero retry budget', () => {
    const events: KeeplineEvent[] = [];
    const policy = vi.fn(() => true);
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: { attempts: 0, shouldReconnect: policy },
      onEvent: (event) => events.push(event)
    });

    socket().acceptConnection();
    socket().serverClose({ code: 1008 });

    expect(policy).not.toHaveBeenCalled();
    expect(instance.status).toBe('closed');
    expect(events.some((event) => event.type === 'gave-up')).toBe(false);
    expect(MockWebSocket.instances).toHaveLength(1);
    instance.destroy();
  });

  it('allows an explicit reconnect after a refused close code', () => {
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory
    });

    socket().acceptConnection();
    socket().serverClose({ code: 1008 });
    expect(instance.status).toBe('closed');

    instance.reconnect();
    expect(instance.status).toBe('connecting');
    expect(MockWebSocket.instances).toHaveLength(2);
    instance.destroy();
  });

  it('keeps refusing an auth close when the extra veto allows everything else', async () => {
    vi.useFakeTimers();
    // The shape almost every consumer writes: one extra stop condition, `true`
    // for everything else. While the close-code table was only a soft default,
    // such a callback silently disabled it and looped on a rejected token.
    let prevented = false;
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: {
        backoff: constantBackoff(10),
        shouldReconnect: () => !prevented
      }
    });

    socket().acceptConnection();
    socket().serverClose({ code: 1006 });
    await vi.advanceTimersByTimeAsync(10);
    expect(MockWebSocket.instances).toHaveLength(2);

    socket().acceptConnection();
    socket().serverClose({ code: 1008, reason: 'token rejected' });
    await vi.advanceTimersByTimeAsync(100);
    expect(MockWebSocket.instances).toHaveLength(2);

    prevented = true;
    instance.destroy();
  });

  it('reports a synchronous policy refusal truthfully', () => {
    const closes: CloseContext[] = [];
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: { shouldReconnect: () => false },
      onClose: (context) => closes.push(context)
    });

    socket().acceptConnection();
    socket().serverClose({ code: 1006 });

    expect(closes[0]?.willReconnect).toBe(false);
    expect(instance.status).toBe('closed');
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('does not clobber a reconnect started reentrantly from onClose', () => {
    const closes: CloseContext[] = [];
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: { shouldReconnect: () => false },
      onClose: (context) => {
        closes.push(context);
        holder.instance?.reconnect();
      }
    });
    holder.instance = instance;

    socket().acceptConnection();
    socket().serverClose({ code: 1006 });

    expect(closes[0]?.willReconnect).toBe(false);
    expect(instance.status).toBe('connecting');
    expect(MockWebSocket.instances).toHaveLength(2);
    instance.destroy();
  });

  it('allows connect from onClose after a refused reconnect', () => {
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: { shouldReconnect: () => false },
      onClose: ({ willReconnect }) => {
        if (!willReconnect) holder.instance?.connect();
      }
    });
    holder.instance = instance;

    socket().acceptConnection();
    socket().serverClose({ code: 1006 });

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(instance.getWebSocket()).toBe(
      MockWebSocket.instances[1] as unknown as WebSocket
    );
    expect(instance.status).toBe('connecting');
    instance.destroy();
  });

  it('settles close false when reconnect is called inside the policy', () => {
    const closes: CloseContext[] = [];
    const events: KeeplineEvent[] = [];
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: {
        shouldReconnect: () => {
          holder.instance?.reconnect();
          return true;
        }
      },
      onClose: (context) => closes.push(context),
      onEvent: (event) => events.push(event)
    });
    holder.instance = instance;

    socket().acceptConnection();
    socket().serverClose({ code: 1006 });

    expect(closes).toEqual([expect.objectContaining({ willReconnect: false })]);
    expect(events.filter((event) => event.type === 'close')).toHaveLength(1);
    expect(instance.status).toBe('connecting');
    expect(MockWebSocket.instances).toHaveLength(2);
    instance.destroy();
  });

  it('settles close false when reconnect is called inside backoff', () => {
    const closes: CloseContext[] = [];
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: {
        backoff: () => {
          holder.instance?.reconnect();
          return 10;
        }
      },
      onClose: (context) => closes.push(context)
    });
    holder.instance = instance;

    socket().acceptConnection();
    socket().serverClose({ code: 1006 });

    expect(closes).toEqual([expect.objectContaining({ willReconnect: false })]);
    expect(instance.status).toBe('connecting');
    expect(MockWebSocket.instances).toHaveLength(2);
    instance.destroy();
  });

  it('defers onClose until an async policy has a truthful answer', async () => {
    const decision = deferred<boolean>();
    const closes: CloseContext[] = [];
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: { shouldReconnect: () => decision.promise },
      onClose: (context) => closes.push(context)
    });

    socket().acceptConnection();
    socket().serverClose({ code: 1006 });
    expect(closes).toEqual([]);

    decision.resolve(false);
    await flushMicrotasks(8);
    expect(closes[0]?.willReconnect).toBe(false);
    expect(instance.status).toBe('closed');
  });

  it('settles a pending close decision when manual close supersedes it', async () => {
    const decision = deferred<boolean>();
    const closes: CloseContext[] = [];
    const events: KeeplineEvent[] = [];
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: { shouldReconnect: () => decision.promise },
      onClose: (context) => closes.push(context),
      onEvent: (event) => events.push(event)
    });

    socket().acceptConnection();
    socket().serverClose({ code: 1006 });
    instance.close();

    expect(closes).toEqual([
      expect.objectContaining({ code: 1006, willReconnect: false })
    ]);
    expect(events.filter((event) => event.type === 'close')).toEqual([
      expect.objectContaining({ code: 1006, willReconnect: false })
    ]);

    decision.resolve(true);
    await flushMicrotasks(8);
    expect(closes).toHaveLength(1);
    expect(instance.status).toBe('closed');
  });

  it('does not orphan a transport when connect cancels a policy reentrantly', async () => {
    const decision = deferred<boolean>();
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    let nested = false;
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: { shouldReconnect: () => decision.promise },
      onClose: ({ willReconnect }) => {
        if (!willReconnect && !nested) {
          nested = true;
          holder.instance?.reconnect();
        }
      }
    });
    holder.instance = instance;

    socket().acceptConnection();
    socket().serverClose({ code: 1006 });
    instance.connect();

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(
      MockWebSocket.instances.filter(
        (transport) => transport.readyState === MockWebSocket.CONNECTING
      )
    ).toHaveLength(1);
    expect(instance.getWebSocket()).toBe(
      MockWebSocket.instances[1] as unknown as WebSocket
    );

    decision.resolve(true);
    await flushMicrotasks(8);
    expect(MockWebSocket.instances).toHaveLength(2);
    instance.destroy();
  });

  it('preserves a reconnect decision created during cancellation', async () => {
    const decisions: Array<ReturnType<typeof deferred<boolean>>> = [];
    const closes: CloseContext[] = [];
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    let nested = false;
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: {
        shouldReconnect: () => {
          const decision = deferred<boolean>();
          decisions.push(decision);
          return decision.promise;
        }
      },
      onClose: (context) => {
        closes.push(context);
        if (!nested) {
          nested = true;
          holder.instance?.reconnect();
          socket().acceptConnection();
          socket().serverClose({ code: 1006 });
        }
      }
    });
    holder.instance = instance;
    socket().acceptConnection();
    socket().serverClose({ code: 1006 });

    instance.connect();
    expect(decisions).toHaveLength(2);
    instance.close();
    expect(closes).toEqual([
      expect.objectContaining({ willReconnect: false }),
      expect.objectContaining({ willReconnect: false })
    ]);

    for (const decision of decisions) decision.resolve(true);
    await flushMicrotasks(8);
    expect(closes).toHaveLength(2);
    expect(instance.status).toBe('closed');
  });
});

describe('heartbeat callback isolation', () => {
  it('does not let a heartbeat-timeout listener abandon its nested reconnect', async () => {
    vi.useFakeTimers();
    const holder: { instance?: ReturnType<typeof createSocket> } = {};
    let replaced = false;
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      heartbeat: { message: 'ping', intervalMs: 1, timeoutMs: 1 },
      reconnect: { backoff: constantBackoff(1_000) },
      onEvent: (event) => {
        if (event.type === 'heartbeat-timeout' && !replaced) {
          replaced = true;
          holder.instance?.reconnect();
        }
      }
    });
    holder.instance = instance;
    socket().acceptConnection();

    await vi.advanceTimersByTimeAsync(2);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(instance.getWebSocket()).toBe(
      MockWebSocket.instances[1] as unknown as WebSocket
    );
    expect(instance.status).toBe('connecting');
    instance.destroy();
  });

  it('contains a throwing heartbeat factory without arming a timeout', async () => {
    vi.useFakeTimers();
    const phases: ErrorPhase[] = [];
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      heartbeat: {
        message: () => {
          throw new Error('cannot create ping');
        },
        intervalMs: 100,
        timeoutMs: 50
      },
      reconnect: { backoff: constantBackoff(10) },
      onError: (_error, phase) => phases.push(phase)
    });

    socket().acceptConnection();
    await vi.advanceTimersByTimeAsync(150);

    expect(phases).toEqual(['encode']);
    expect(socket().sent).toEqual([]);
    expect(instance.status).toBe('open');
    instance.destroy();
  });

  it('delivers a message even when the pong predicate throws', async () => {
    vi.useFakeTimers();
    const received: unknown[] = [];
    const phases: ErrorPhase[] = [];
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      heartbeat: {
        message: { type: 'ping' },
        intervalMs: 100,
        timeoutMs: 50,
        isPong: () => {
          throw new Error('bad predicate');
        }
      },
      onMessage: (message) => received.push(message),
      onError: (_error, phase) => phases.push(phase)
    });

    socket().acceptConnection();
    await vi.advanceTimersByTimeAsync(100);
    socket().serverSend({ type: 'message' });

    expect(received).toEqual([{ type: 'message' }]);
    expect(instance.metrics.messagesReceived).toBe(1);
    expect(instance.metrics.decodeErrors).toBe(0);
    expect(phases).toEqual(['listener']);
    instance.destroy();
  });
});

describe('downtime and subscription ownership', () => {
  it('surfaces rejected remainder when queue flushing reenters reconnect', () => {
    const holder: {
      instance?: ReturnType<typeof createSocket<unknown, string>>;
    } = {};
    const events: KeeplineEvent<unknown, string>[] = [];
    let replaced = false;
    const instance = createSocket<unknown, string>({
      url: 'wss://x',
      autoConnect: false,
      socketFactory: mockSocketFactory,
      queue: { limit: 2, onOverflow: 'reject' },
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'sent' && event.payload === 'A' && !replaced) {
          replaced = true;
          holder.instance?.reconnect();
          holder.instance?.send('C');
          holder.instance?.send('D');
        }
      }
    });
    holder.instance = instance;

    instance.send('A');
    instance.send('B');
    instance.connect();
    socket().acceptConnection();
    socket().acceptConnection();

    expect(MockWebSocket.instances[0]?.sent).toEqual(['A']);
    expect(MockWebSocket.instances[1]?.sent).toEqual(['C', 'D']);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'dropped',
        payload: 'B',
        reason: 'queue-full'
      })
    );
    instance.destroy();
  });

  it('rejects an in-flight request when reconnect abandons its transport', async () => {
    const instance = createSocket<{ id: number }, { id: number }>({
      url: 'wss://x',
      socketFactory: mockSocketFactory
    });
    socket().acceptConnection();
    const pending = instance.request(
      { id: 1 },
      { match: (message) => message.id === 1 }
    );
    const assertion = expect(pending).rejects.toBeInstanceOf(
      ConnectionClosedError
    );

    instance.reconnect();
    socket().acceptConnection();
    socket().serverSend({ id: 1 });
    await assertion;
    instance.destroy();
  });

  it('rejects an in-flight request when pause abandons its transport', async () => {
    const instance = createSocket<{ id: number }, { id: number }>({
      url: 'wss://x',
      socketFactory: mockSocketFactory
    });
    socket().acceptConnection();
    const pending = instance.request(
      { id: 1 },
      { match: (message) => message.id === 1 }
    );
    const assertion = expect(pending).rejects.toBeInstanceOf(
      ConnectionClosedError
    );

    instance.pause();
    expect(instance.status).toBe('paused');
    await assertion;
    instance.destroy();
  });

  it('keeps the original outage start across failed reconnect attempts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const events: KeeplineEvent[] = [];
    const instance = createSocket({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: { backoff: constantBackoff(100) },
      onEvent: (event) => events.push(event)
    });

    socket().acceptConnection();
    await vi.advanceTimersByTimeAsync(100);
    socket().serverClose({ code: 1006 });
    await vi.advanceTimersByTimeAsync(100);
    socket().serverClose({ code: 1006 });
    await vi.advanceTimersByTimeAsync(100);
    socket().acceptConnection();

    const opens = events.filter((event) => event.type === 'open');
    expect(opens.at(-1)).toMatchObject({ downtimeMs: 200 });
    expect(instance.metrics.totalDowntimeMs).toBe(200);
    instance.destroy();
  });

  it('does not let an older duplicate-key release remove the newer owner', async () => {
    vi.useFakeTimers();
    const instance = createSocket<unknown, unknown>({
      url: 'wss://x',
      socketFactory: mockSocketFactory,
      reconnect: { backoff: constantBackoff(10) }
    });
    socket().acceptConnection();

    const releaseOld = instance.subscription({
      key: 'room',
      subscribe: { type: 'subscribe', room: 'old' },
      unsubscribe: { type: 'unsubscribe', room: 'old' }
    });
    const releaseNew = instance.subscription({
      key: 'room',
      subscribe: { type: 'subscribe', room: 'new' },
      unsubscribe: { type: 'unsubscribe', room: 'new' }
    });

    releaseOld();
    releaseOld();
    expect(socket().sentJson).toEqual([
      { type: 'subscribe', room: 'old' },
      { type: 'subscribe', room: 'new' }
    ]);

    socket().serverClose({ code: 1006 });
    await vi.advanceTimersByTimeAsync(10);
    socket().acceptConnection();
    expect(socket().sentJson).toEqual([{ type: 'subscribe', room: 'new' }]);

    releaseNew();
    releaseNew();
    expect(socket().sentJson).toEqual([
      { type: 'subscribe', room: 'new' },
      { type: 'unsubscribe', room: 'new' }
    ]);
    instance.destroy();
  });
});
