import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type KeeplineEvent, constantBackoff, createSocket } from '../src';
import { useSocket } from '../src/react';
import {
  REFUSED_CLOSE_CODE,
  SocketIoConnectError,
  SocketIoProtocolError,
  socketIo,
  socketIoUrl
} from '../src/socket-io';
import { parsePacket } from '../src/socket-io/parser';
import { MockWebSocket, mockSocketFactory } from '../src/testing';

interface ServerEvents {
  NEW: (notification: { id: number }) => void;
  pair: (a: string, b: number) => void;
}
interface ClientEvents {
  markRead: (id: number) => void;
}

const HANDSHAKE =
  '0{"sid":"e1","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}';

const last = (): MockWebSocket => {
  const ws = MockWebSocket.last();
  if (!ws) throw new Error('no socket');
  return ws;
};

const created: Array<{ destroy(): void }> = [];

const setup = (
  config: Parameters<typeof socketIo>[0] = {},
  extra: { reconnect?: false | { backoff?: (attempt: number) => number } } = {}
) => {
  const events: KeeplineEvent[] = [];
  const io = socketIo<ServerEvents, ClientEvents>({
    socketFactory: mockSocketFactory,
    ...config
  });
  const socket = createSocket({
    url: 'ws://example.test/socket.io/?EIO=4&transport=websocket',
    reconnect: { backoff: constantBackoff(10) },
    ...extra,
    ...io.options,
    onEvent: (event) => events.push(event as KeeplineEvent)
  });
  created.push(socket);
  return { io, socket, events };
};

/** Drive one connection through WebSocket open, handshake and CONNECT ack. */
const connect = async (ws = last(), ack = '40{"sid":"s1"}') => {
  ws.acceptConnection();
  ws.serverSendRaw(HANDSHAKE);
  await Promise.resolve();
  ws.serverSendRaw(ack);
};

const ofType = <T extends KeeplineEvent['type']>(
  events: KeeplineEvent[],
  type: T
) =>
  events.filter(
    (e): e is Extract<KeeplineEvent, { type: T }> => e.type === type
  );

/** Drive one connection up to a pending CONNECT (sent, not acknowledged). */
const awaitAck = async (ws = last()) => {
  ws.acceptConnection();
  ws.serverSendRaw(HANDSHAKE);
  await Promise.resolve();
  expect(ws.sent).toHaveLength(1);
};

/** The single `onConnectError` call, asserting there was exactly one. */
const onlyCall = (fn: ReturnType<typeof vi.fn>): SocketIoConnectError => {
  expect(fn).toHaveBeenCalledTimes(1);
  const [error] = fn.mock.calls[0] as [SocketIoConnectError];
  expect(error).toBeInstanceOf(SocketIoConnectError);
  return error;
};

beforeEach(() => {
  MockWebSocket.reset();
});

afterEach(() => {
  for (const socket of created.splice(0)) socket.destroy();
  vi.useRealTimers();
});

describe('parsePacket', () => {
  it('parses events in the default namespace', () => {
    expect(parsePacket('2["NEW",{"a":1}]')).toEqual({
      type: 2,
      nsp: '/',
      data: ['NEW', { a: 1 }]
    });
  });

  it('parses a namespace, an ack id and a payload', () => {
    expect(parsePacket('2/admin,12["x"]')).toEqual({
      type: 2,
      nsp: '/admin',
      id: 12,
      data: ['x']
    });
    expect(parsePacket('0/admin,')).toEqual({ type: 0, nsp: '/admin' });
    expect(parsePacket('1/admin')).toEqual({ type: 1, nsp: '/admin' });
    expect(parsePacket('0{"sid":"x"}')).toEqual({
      type: 0,
      nsp: '/',
      data: { sid: 'x' }
    });
  });

  it('skips the attachment count of binary packets', () => {
    expect(
      parsePacket('51-/admin,["x",{"_placeholder":true,"num":0}]')
    ).toMatchObject({
      type: 5,
      nsp: '/admin'
    });
    expect(() => parsePacket('5["x"]')).toThrow(SocketIoProtocolError);
  });

  it('rejects unknown types and malformed JSON', () => {
    expect(() => parsePacket('9')).toThrow(/unknown Socket.IO packet type/);
    expect(() => parsePacket('')).toThrow(SocketIoProtocolError);
    expect(() => parsePacket('2["x"')).toThrow(/malformed JSON/);
  });
});

describe('socketIoUrl', () => {
  it('builds the Engine.IO websocket URL with the app query', () => {
    expect(
      socketIoUrl('https://api.example.com', {
        language: 'en',
        skip: undefined
      })
    ).toBe(
      'wss://api.example.com/socket.io/?language=en&EIO=4&transport=websocket'
    );
    expect(socketIoUrl('http://localhost:3000/ignored')).toBe(
      'ws://localhost:3000/socket.io/?EIO=4&transport=websocket'
    );
  });

  it('honours a custom path and never lets the query pick the transport', () => {
    expect(
      socketIoUrl(
        'wss://x.test',
        { transport: 'polling', n: 1 },
        { path: '/api/socket.io/' }
      )
    ).toBe('wss://x.test/api/socket.io/?transport=websocket&n=1&EIO=4');
    expect(socketIoUrl('wss://x.test', {}, { path: '/realtime' })).toBe(
      'wss://x.test/realtime/?EIO=4&transport=websocket'
    );
  });
});

describe('handshake and CONNECT', () => {
  it('reports open only once the server acknowledges the CONNECT', async () => {
    const { socket, events } = setup();
    const ws = last();

    ws.acceptConnection();
    expect(socket.status).toBe('connecting');
    expect(socket.readyState).toBe(0);

    ws.serverSendRaw(HANDSHAKE);
    await Promise.resolve();
    expect(ws.sent).toEqual(['40']);
    expect(socket.status).toBe('connecting');

    ws.serverSendRaw('40{"sid":"s1"}');
    expect(socket.status).toBe('open');
    expect(socket.readyState).toBe(1);
    expect(ofType(events, 'open')).toHaveLength(1);
    // Control frames are not application messages.
    expect(socket.metrics.messagesReceived).toBe(0);
  });

  it('sends the auth payload, re-resolving it on every connection', async () => {
    let n = 0;
    const { socket } = setup({ auth: async () => ({ token: `t${++n}` }) });
    await connect();
    expect(last().sent).toEqual(['40{"token":"t1"}']);

    last().serverClose({ code: 1006 });
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    await connect();
    expect(last().sent).toEqual(['40{"token":"t2"}']);
    expect(socket.status).toBe('open');
  });

  it('connects a namespace and filters events by it', async () => {
    const { socket } = setup({ namespace: 'admin', auth: { k: 1 } });
    const received: unknown[] = [];
    socket.onMessage((m) => received.push(m));
    await connect(last(), '40/admin,{"sid":"s1"}');

    expect(last().sent).toEqual(['40/admin,{"k":1}']);
    expect(socket.status).toBe('open');

    last().serverSendRaw('42/admin,["NEW",{"id":1}]');
    expect(received).toEqual([{ event: 'NEW', args: [{ id: 1 }] }]);
  });

  it('ignores a CONNECT ack for another namespace', async () => {
    const { socket, events } = setup({ namespace: '/admin' });
    await connect(last(), '40{"sid":"s1"}');
    expect(socket.status).toBe('connecting');
    expect(ofType(events, 'decode-error')).toHaveLength(1);
  });

  it('closes with a protocol error on a malformed handshake, without retrying', () => {
    const { socket, events } = setup();
    last().acceptConnection();
    last().serverSendRaw('0{"sid":"x"}');
    expect(ofType(events, 'close')[0]).toMatchObject({
      code: 1002,
      category: 'protocol',
      willReconnect: false
    });
    expect(socket.status).toBe('closed');
  });
});

describe('ping/pong and liveness', () => {
  it('answers every ping with a pong at once', async () => {
    const { socket } = setup();
    await connect();
    last().serverSendRaw('2');
    last().serverSendRaw('2');
    expect(last().sent).toEqual(['40', '3', '3']);
    expect(socket.metrics.messagesReceived).toBe(0);
  });

  it('reconnects when pings stop for pingInterval + pingTimeout', async () => {
    vi.useFakeTimers();
    const { socket, events } = setup();
    await connect();

    vi.advanceTimersByTime(44_000);
    last().serverSendRaw('2'); // resets the window
    vi.advanceTimersByTime(44_000);
    expect(socket.status).toBe('open');

    vi.advanceTimersByTime(1_000);
    expect(ofType(events, 'close')[0]).toMatchObject({
      code: 1006,
      reason: 'socket.io: ping timeout',
      willReconnect: true
    });
    expect(socket.status).toBe('reconnecting');
  });
});

describe('events', () => {
  it('delivers events as { event, args } and routes them with io.on', async () => {
    const { io, socket } = setup();
    const onNew = vi.fn();
    const onPair = vi.fn();
    io.on(socket, 'NEW', onNew);
    const off = io.on(socket, 'pair', onPair);
    await connect();

    last().serverSendRaw('42["NEW",{"id":7}]');
    last().serverSendRaw('42["pair","a",2]');
    off();
    last().serverSendRaw('42["pair","b",3]');

    expect(onNew).toHaveBeenCalledWith({ id: 7 });
    expect(onPair).toHaveBeenCalledTimes(1);
    expect(onPair).toHaveBeenCalledWith('a', 2);
    expect(socket.metrics.messagesReceived).toBe(3);
  });

  it('queues emits until the CONNECT is acknowledged', async () => {
    const { io, socket } = setup({ namespace: '/admin' });
    last().acceptConnection();
    expect(io.emit(socket, 'markRead', 1)).toBe(true);
    last().serverSendRaw(HANDSHAKE);
    await Promise.resolve();
    expect(last().sent).toEqual(['40/admin,']);

    last().serverSendRaw('40/admin,{"sid":"s"}');
    expect(last().sent).toEqual(['40/admin,', '42/admin,["markRead",1]']);
  });

  it('refuses to encode binary payloads instead of sending {}', async () => {
    const { socket, events } = setup();
    await connect();
    const sent = socket.send({
      event: 'markRead',
      args: [new Uint8Array([1]) as unknown as number]
    });
    expect(sent).toBe(false);
    expect(ofType(events, 'error')[0]).toMatchObject({ phase: 'encode' });
    expect(last().sent).toEqual(['40']);
  });

  it.each([
    ['an acknowledgement', '43["x"]', /acknowledgements are not supported/],
    [
      'an event asking for an ack',
      '4212["NEW",{}]',
      /asks for an acknowledgement/
    ],
    [
      'a binary event',
      '451-["NEW",{"_placeholder":true,"num":0}]',
      /binary attachments/
    ],
    [
      'a binary ack',
      '461-1[{"_placeholder":true,"num":0}]',
      /acknowledgements/
    ],
    ['another namespace', '42/other,["NEW",{}]', /namespace \/other/],
    ['malformed JSON', '42["NEW",', /malformed JSON/],
    [
      'an event without a name',
      '42[1,2]',
      /must be an array starting with the event name/
    ],
    ['an upgrade', '5', /upgrade/],
    ['an unknown Engine.IO type', 'x', /unknown Engine.IO packet type/]
  ])(
    'reports %s as a decode-error and stays open',
    async (_, frame, message) => {
      const { socket, events } = setup();
      const received = vi.fn();
      socket.onMessage(received);
      await connect();

      last().serverSendRaw(frame);
      const [error] = ofType(events, 'decode-error');
      expect(error?.error).toBeInstanceOf(SocketIoProtocolError);
      expect(String((error?.error as Error).message)).toMatch(message);
      expect(error?.data).toBe(frame);
      expect(received).not.toHaveBeenCalled();
      expect(socket.status).toBe('open');
    }
  );

  it('reports binary frames as a decode-error', async () => {
    const { events } = setup();
    await connect();
    last().serverSendRaw(new ArrayBuffer(2));
    expect(
      String((ofType(events, 'decode-error')[0]?.error as Error).message)
    ).toMatch(/binary frames are not supported/);
  });
});

describe('refused connections stop reconnecting', () => {
  it('treats CONNECT_ERROR (44) as a policy close', async () => {
    const onConnectError = vi.fn();
    const { socket, events } = setup({
      auth: { token: 'bad' },
      onConnectError
    });
    last().acceptConnection();
    last().serverSendRaw(HANDSHAKE);
    await Promise.resolve();
    last().serverSendRaw('44{"message":"unauthorized","data":{"code":401}}');

    const [close] = ofType(events, 'close');
    expect(close).toMatchObject({
      code: REFUSED_CLOSE_CODE,
      category: 'policy',
      reason: 'socket.io: unauthorized',
      willReconnect: false
    });
    expect(socket.status).toBe('closed');
    const error = onlyCall(onConnectError);
    expect(error.reason).toBe('connect-error');
    expect(error.message).toBe('unauthorized');
    expect(error.data).toEqual({ code: 401 });
    expect(error.closeCode).toBeUndefined();

    // The raw transport is released, and nothing retries behind our back.
    await Promise.resolve();
    expect(last().readyState).toBe(MockWebSocket.CLOSED);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(MockWebSocket.instances).toHaveLength(1);

    // The app retries deliberately, e.g. after refreshing credentials.
    socket.reconnect();
    expect(MockWebSocket.instances).toHaveLength(2);
    await connect();
    expect(socket.status).toBe('open');
  });

  it('treats a close right after CONNECT as a refusal, however late the close', async () => {
    vi.useFakeTimers();
    const onConnectError = vi.fn();
    const { socket, events } = setup({ onConnectError });
    last().acceptConnection();
    last().serverSendRaw(HANDSHAKE);
    await Promise.resolve();
    expect(last().sent).toEqual(['40']);

    // The observed server behaviour: error, then a 1006 close — here delivered
    // after keepline's 50ms error grace period.
    last().serverError();
    vi.advanceTimersByTime(200);
    expect(onConnectError).not.toHaveBeenCalled();
    last().serverClose({ code: 1006 });

    const error = onlyCall(onConnectError);
    expect(error).toMatchObject({
      reason: 'closed-before-ack',
      closeCode: 1006,
      data: undefined,
      message: 'connection closed (1006) before CONNECT was acknowledged'
    });
    expect(ofType(events, 'error')).toHaveLength(1);
    expect(ofType(events, 'close')[0]).toMatchObject({
      code: 1008,
      category: 'policy',
      reason: 'socket.io: connection closed before CONNECT was acknowledged',
      willReconnect: false
    });
    expect(socket.status).toBe('closed');
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('refuses the attempt when auth() throws', async () => {
    const onConnectError = vi.fn();
    const cause = new Error('no token');
    const { socket, events } = setup({
      auth: () => {
        throw cause;
      },
      onConnectError
    });
    last().acceptConnection();
    last().serverSendRaw(HANDSHAKE);
    expect(socket.status).toBe('closed');
    expect(last().sent).toEqual([]);
    expect(onlyCall(onConnectError)).toMatchObject({
      reason: 'auth-failed',
      message: 'auth() failed: no token',
      data: undefined,
      cause
    });
    expect(ofType(events, 'close')).toEqual([
      expect.objectContaining({
        code: REFUSED_CLOSE_CODE,
        reason: 'socket.io: auth() failed: no token',
        willReconnect: false
      })
    ]);
  });

  it.each([
    ['sync', () => ({ id: 1n })],
    ['async', async () => ({ id: 1n })]
  ])(
    'refuses, rather than hangs, when %s auth cannot be serialized',
    async (_, auth) => {
      const onConnectError = vi.fn();
      const { socket } = setup({ auth, onConnectError });
      last().acceptConnection();
      last().serverSendRaw(HANDSHAKE);
      await vi.waitFor(() => expect(socket.status).toBe('closed'));
      expect(last().sent).toEqual([]);
      expect(onlyCall(onConnectError).reason).toBe('auth-failed');
    }
  );

  it('treats a CONNECT_ERROR with an unreadable payload as a refusal', async () => {
    const { socket, events } = setup();
    last().acceptConnection();
    last().serverSendRaw(HANDSHAKE);
    await Promise.resolve();
    last().serverSendRaw('44{not json');
    expect(ofType(events, 'close')[0]).toMatchObject({
      code: 1008,
      reason: 'socket.io: connection refused'
    });
    expect(socket.status).toBe('closed');
  });

  it.each([1001, 1012, 1013, 1014])(
    'retries a deliberate %i close that lands before the CONNECT ack',
    async (code) => {
      const onConnectError = vi.fn();
      const { socket, events } = setup({ onConnectError });
      await awaitAck();
      last().serverClose({ code });
      expect(ofType(events, 'close')[0]).toMatchObject({
        code,
        willReconnect: true
      });
      expect(socket.status).toBe('reconnecting');
      expect(onConnectError).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['Engine.IO close (1)', '1', 'server closed the session'],
    ['namespace DISCONNECT (41)', '41', 'server disconnected the namespace']
  ])(
    'treats %s in answer to the CONNECT as a refusal',
    async (_, frame, what) => {
      const onConnectError = vi.fn();
      const { socket, events } = setup({ onConnectError });
      await awaitAck();
      last().serverSendRaw(frame);

      expect(onlyCall(onConnectError)).toMatchObject({
        reason: 'session-ended',
        message: `${what} before acknowledging CONNECT`,
        data: undefined,
        closeCode: undefined
      });
      expect(ofType(events, 'close')).toEqual([
        expect.objectContaining({
          code: REFUSED_CLOSE_CODE,
          category: 'policy',
          reason: `socket.io: ${what} before acknowledging CONNECT`,
          willReconnect: false
        })
      ]);
      expect(socket.status).toBe('closed');
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(MockWebSocket.instances).toHaveLength(1);
    }
  );

  it('reports a pre-ack close with its code and reason, keeping the close reason stable', async () => {
    const onConnectError = vi.fn();
    const { socket, events } = setup({ onConnectError });
    await awaitAck();
    last().serverClose({ code: 4401, reason: 'token expired' });

    expect(onlyCall(onConnectError)).toMatchObject({
      reason: 'closed-before-ack',
      closeCode: 4401,
      message:
        'connection closed (4401 token expired) before CONNECT was acknowledged'
    });
    expect(ofType(events, 'close')).toEqual([
      expect.objectContaining({
        code: REFUSED_CLOSE_CODE,
        reason: 'socket.io: connection closed before CONNECT was acknowledged',
        willReconnect: false
      })
    ]);
    expect(socket.status).toBe('closed');
  });

  it('still refuses when onConnectError throws', async () => {
    const onConnectError = vi.fn(() => {
      throw new Error('observer bug');
    });
    const { socket, events } = setup({ onConnectError });
    await awaitAck();
    last().serverClose({ code: 1006 });

    expect(onConnectError).toHaveBeenCalledTimes(1);
    expect(ofType(events, 'close')).toEqual([
      expect.objectContaining({
        code: REFUSED_CLOSE_CODE,
        willReconnect: false
      })
    ]);
    expect(socket.status).toBe('closed');
  });

  it('does not report a client-initiated close before the ack as a refusal', async () => {
    const onConnectError = vi.fn();
    const { socket, events } = setup({ onConnectError });
    await awaitAck();
    socket.close();
    await vi.waitFor(() => expect(socket.status).toBe('closed'));
    expect(onConnectError).not.toHaveBeenCalled();
    expect(ofType(events, 'close')[0]?.code).not.toBe(REFUSED_CLOSE_CODE);
  });

  it('does not report a reconnect() before the ack as a refusal', async () => {
    const onConnectError = vi.fn();
    const { socket } = setup({ onConnectError });
    await awaitAck();
    socket.reconnect();
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    await connect();
    expect(socket.status).toBe('open');
    expect(onConnectError).not.toHaveBeenCalled();
  });

  it('still retries a connection that drops before the handshake', () => {
    const onConnectError = vi.fn();
    const { socket } = setup({ onConnectError });
    last().acceptConnection();
    last().serverClose({ code: 1006 });
    expect(socket.status).toBe('reconnecting');
    expect(onConnectError).not.toHaveBeenCalled();
  });
});

describe('server-side disconnects reconnect', () => {
  it.each([
    ['namespace DISCONNECT (41)', '41', 1000],
    ['Engine.IO close (1)', '1', 1001]
  ])('%s reconnects and re-sends CONNECT', async (_, frame, code) => {
    const onConnectError = vi.fn();
    const { socket, events } = setup({
      auth: () => ({ n: 1 }),
      onConnectError
    });
    await connect();
    last().serverSendRaw(frame);
    expect(onConnectError).not.toHaveBeenCalled();

    expect(ofType(events, 'close')[0]).toMatchObject({
      code,
      willReconnect: true
    });
    expect(socket.status).toBe('reconnecting');
    await vi.waitFor(() => expect(MockWebSocket.instances).toHaveLength(2));
    await connect();
    expect(last().sent).toEqual(['40{"n":1}']);
    expect(socket.status).toBe('open');
    expect(socket.metrics.reconnects).toBe(1);
  });

  it('lets the app veto reconnecting after a kick, as the README shows', async () => {
    const io = socketIo({ socketFactory: mockSocketFactory });
    const socket = createSocket({
      url: 'ws://x.test',
      ...io.options,
      reconnect: {
        shouldReconnect: ({ reason }) =>
          reason !== 'socket.io: server disconnected the namespace'
      }
    });
    created.push(socket);
    await connect();
    last().serverSendRaw('41');
    expect(socket.status).toBe('closed');
  });

  it('sends DISCONNECT before closing on socket.close()', async () => {
    const { socket } = setup({ namespace: '/admin' });
    await connect(last(), '40/admin,{"sid":"s"}');
    socket.close();
    expect(last().sent).toEqual(['40/admin,', '41/admin,']);
    await vi.waitFor(() => expect(socket.status).toBe('closed'));
  });
});

describe('composition', () => {
  it('stays idle without a WebSocket global or a factory', () => {
    vi.stubGlobal('WebSocket', undefined);
    try {
      const io = socketIo();
      expect(io.options.socketFactory).toBeUndefined();
      const socket = createSocket({ url: 'ws://x.test', ...io.options });
      created.push(socket);
      expect(socket.status).toBe('idle');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('picks up a WebSocket installed after the codec was created', () => {
    vi.stubGlobal('WebSocket', undefined);
    const io = socketIo();
    vi.unstubAllGlobals();
    vi.stubGlobal('WebSocket', MockWebSocket);
    try {
      const socket = createSocket({ url: 'ws://x.test', ...io.options });
      created.push(socket);
      last().acceptConnection();
      last().serverSendRaw(HANDSHAKE);
      expect(last().sent).toEqual(['40']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('names the mistake when the codec transport was replaced', () => {
    const io = socketIo();
    const events: KeeplineEvent[] = [];
    const socket = createSocket({
      url: 'ws://x.test',
      ...io.options,
      socketFactory: mockSocketFactory,
      onEvent: (event) => events.push(event as KeeplineEvent)
    });
    created.push(socket);
    last().acceptConnection();
    last().serverSendRaw(HANDSHAKE);
    expect(
      String((ofType(events, 'decode-error')[0]?.error as Error).message)
    ).toMatch(/Pass socketFactory to socketIo\(\), not to createSocket\(\)/);
  });

  it('works with useSocket: open means CONNECT acknowledged', async () => {
    const io = socketIo<ServerEvents, ClientEvents>({
      socketFactory: mockSocketFactory
    });
    const { result } = renderHook(() =>
      useSocket({ url: 'ws://example.test/socket.io/', ...io.options })
    );
    const ws = last();
    act(() => ws.acceptConnection());
    expect(result.current.isOpen).toBe(false);
    await act(async () => {
      ws.serverSendRaw(HANDSHAKE);
      await Promise.resolve();
      ws.serverSendRaw('40{"sid":"s"}');
    });
    expect(result.current.isOpen).toBe(true);
    act(() => {
      io.emit(result.current, 'markRead', 3);
    });
    expect(ws.sent).toEqual(['40', '42["markRead",3]']);
  });
});
