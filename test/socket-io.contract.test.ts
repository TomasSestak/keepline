// @vitest-environment node
/**
 * Contract tests against a real `socket.io` v4 server.
 *
 * The unit tests pin the frames this codec writes and reads; these pin that
 * those frames are the ones a real server speaks. The client is `ws` rather
 * than a global WebSocket so the suite runs on every Node in the CI matrix.
 */
import { type Server as HttpServer, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server, type ServerOptions } from 'socket.io';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import {
  type KeeplineEvent,
  type Socket,
  type WebSocketLike,
  constantBackoff,
  createSocket
} from '../src';
import {
  type SocketIoConnectError,
  type SocketIoOptions,
  socketIo,
  socketIoUrl
} from '../src/socket-io';

interface ServerEvents {
  NEW: (notification: { id: number }) => void;
}
interface ClientEvents {
  markRead: (id: number) => void;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const startServer = async (
  options: Partial<ServerOptions>,
  setup: (io: Server) => void
): Promise<{ io: Server; base: string }> => {
  const http: HttpServer = createServer();
  const io = new Server(http, { transports: ['websocket'], ...options });
  setup(io);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        io.close(() => resolve());
      })
  );
  return { io, base: `http://127.0.0.1:${port}` };
};

/** Frames the client received on the wire, for asserting on pings. */
const received: string[] = [];

const connectClient = (
  base: string,
  config: Omit<SocketIoOptions, 'socketFactory'> = {}
) => {
  received.length = 0;
  const events: KeeplineEvent[] = [];
  const io = socketIo<ServerEvents, ClientEvents>({
    ...config,
    socketFactory: (url, protocols) => {
      const ws = new WebSocket(url, protocols);
      ws.addEventListener('message', (event) => {
        if (typeof event.data === 'string') received.push(event.data);
      });
      return ws as unknown as WebSocketLike;
    }
  });
  const socket = createSocket({
    url: socketIoUrl(base, { language: 'en' }),
    reconnect: { backoff: constantBackoff(20) },
    ...io.options,
    onEvent: (event) => events.push(event as KeeplineEvent)
  });
  cleanups.push(() => socket.destroy());
  return { io, socket, events };
};

const settle = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const closes = (events: KeeplineEvent[]) =>
  events.filter(
    (event): event is Extract<KeeplineEvent, { type: 'close' }> =>
      event.type === 'close'
  );

const expectStaysDown = async (
  socket: Socket<unknown, unknown>,
  attempts: () => number
) => {
  await vi.waitFor(() => expect(socket.status).toBe('closed'));
  await settle(200); // ten backoff periods: a loop would have shown by now
  expect(socket.status).toBe('closed');
  expect(attempts()).toBe(1);
};

describe('against a real socket.io v4 server', () => {
  it('connects with auth and query, receives events, and emits', async () => {
    const handshakes: Array<{ auth: unknown; language: unknown }> = [];
    const markedRead: number[] = [];
    const { base } = await startServer({}, (io) => {
      io.on('connection', (socket) => {
        handshakes.push({
          auth: socket.handshake.auth,
          language: socket.handshake.query.language
        });
        socket.on('markRead', (id: number) => markedRead.push(id));
        socket.emit('NEW', { id: 1 });
      });
    });

    const { io, socket } = connectClient(base, {
      auth: async () => ({ token: 'Bearer abc' })
    });
    const onNew = vi.fn();
    io.on(socket, 'NEW', onNew);
    // Emitted before the CONNECT ack: queued by keepline, not lost.
    io.emit(socket, 'markRead', 42);

    await vi.waitFor(() => expect(onNew).toHaveBeenCalledWith({ id: 1 }));
    expect(socket.status).toBe('open');
    expect(handshakes).toEqual([
      { auth: { token: 'Bearer abc' }, language: 'en' }
    ]);
    await vi.waitFor(() => expect(markedRead).toEqual([42]));
  });

  it('answers pings, so the session outlives several ping intervals', async () => {
    const disconnects: string[] = [];
    const { base } = await startServer(
      { pingInterval: 50, pingTimeout: 50 },
      (io) => {
        io.on('connection', (socket) => {
          socket.on('disconnect', (reason) => disconnects.push(reason));
        });
      }
    );

    const { socket } = connectClient(base);
    await vi.waitFor(() => expect(socket.status).toBe('open'));
    // Without pongs the server drops us after 100ms; give it 400ms.
    await settle(400);

    expect(received.filter((frame) => frame === '2').length).toBeGreaterThan(3);
    expect(disconnects).toEqual([]);
    expect(socket.status).toBe('open');
    expect(socket.metrics.connections).toBe(1);
  });

  it('stops reconnecting when auth middleware rejects with next(error)', async () => {
    let attempts = 0;
    const { base } = await startServer({}, (io) => {
      io.use((_socket, next) => {
        attempts += 1;
        const error = new Error('unauthorized') as Error & { data?: unknown };
        error.data = { code: 401 };
        next(error);
      });
    });

    const onConnectError = vi.fn<(error: SocketIoConnectError) => void>();
    const { socket, events } = connectClient(base, {
      auth: { token: 'expired' },
      onConnectError
    });

    await expectStaysDown(socket, () => attempts);
    expect(closes(events)).toEqual([
      expect.objectContaining({
        code: 1008,
        category: 'policy',
        reason: 'socket.io: unauthorized',
        willReconnect: false
      })
    ]);
    expect(onConnectError).toHaveBeenCalledTimes(1);
    expect(onConnectError.mock.calls[0]?.[0]).toMatchObject({
      reason: 'connect-error',
      message: 'unauthorized',
      data: { code: 401 }
    });
  });

  it('stops reconnecting when the server drops the connection on CONNECT', async () => {
    let attempts = 0;
    const { base } = await startServer({}, (io) => {
      io.use((socket) => {
        attempts += 1;
        // What the dev notifications server does: no `44`, just a dead socket.
        socket.request.socket.destroy();
      });
    });

    const onConnectError = vi.fn<(error: SocketIoConnectError) => void>();
    const { socket, events } = connectClient(base, { onConnectError });

    await expectStaysDown(socket, () => attempts);
    expect(closes(events)).toEqual([
      expect.objectContaining({
        code: 1008,
        category: 'policy',
        willReconnect: false
      })
    ]);
    expect(onConnectError).toHaveBeenCalledTimes(1);
    expect(onConnectError.mock.calls[0]?.[0]).toMatchObject({
      reason: 'closed-before-ack',
      closeCode: 1006,
      data: undefined
    });

    // Credentials refreshed: the app asks again, explicitly.
    socket.reconnect();
    await vi.waitFor(() => expect(attempts).toBe(2));
  });

  it('reports the server closing the Engine.IO connection on CONNECT as a refusal', async () => {
    let attempts = 0;
    const { base } = await startServer({}, (io) => {
      io.use((socket) => {
        attempts += 1;
        // A clean close instead of an answer: the WebSocket ends with a close
        // frame (no status code) right after the client's `40`.
        socket.conn.close();
      });
    });

    const onConnectError = vi.fn<(error: SocketIoConnectError) => void>();
    const { socket, events } = connectClient(base, { onConnectError });

    await expectStaysDown(socket, () => attempts);
    expect(closes(events)).toEqual([
      expect.objectContaining({
        code: 1008,
        category: 'policy',
        reason: 'socket.io: connection closed before CONNECT was acknowledged',
        willReconnect: false
      })
    ]);
    expect(onConnectError).toHaveBeenCalledTimes(1);
    expect(onConnectError.mock.calls[0]?.[0]).toMatchObject({
      reason: 'closed-before-ack',
      closeCode: 1005,
      message: 'connection closed (1005) before CONNECT was acknowledged'
    });
  });

  it('reconnects after a server-side disconnect and re-sends CONNECT', async () => {
    const auths: unknown[] = [];
    const { base } = await startServer({}, (io) => {
      io.on('connection', (socket) => {
        auths.push(socket.handshake.auth);
        if (auths.length === 1) setTimeout(() => socket.disconnect(), 20);
      });
    });

    let n = 0;
    const { socket, events } = connectClient(base, {
      auth: () => ({ attempt: ++n })
    });

    await vi.waitFor(() => expect(auths).toHaveLength(2));
    await vi.waitFor(() => expect(socket.status).toBe('open'));
    expect(auths).toEqual([{ attempt: 1 }, { attempt: 2 }]);
    expect(closes(events)[0]).toMatchObject({
      code: 1000,
      willReconnect: true
    });
    expect(socket.metrics.reconnects).toBe(1);
  });
});
