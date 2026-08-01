import type { SocketFactory } from '../core/types';

type AnyHandler = ((event: unknown) => void) | null;

export interface ServerCloseOptions {
  code?: number;
  reason?: string;
  wasClean?: boolean;
}

/**
 * A scriptable `WebSocket` stand-in.
 *
 * Shipping this is a deliberate part of the library's job. Every application
 * that talks to a socket ends up writing some version of it, usually as a
 * module mock that stubs out the transport *and* the reconnection logic — which
 * means the reconnection logic is the one part that never gets tested. Here the
 * real state machine runs; only the wire is fake.
 *
 * ```ts
 * const { restore } = installMockWebSocket();
 * const socket = createSocket({ url: 'wss://x' });
 *
 * MockWebSocket.last()!.acceptConnection();
 * MockWebSocket.last()!.serverSend({ type: 'hello' });
 * MockWebSocket.last()!.serverClose({ code: 1006 });   // triggers a real retry
 * restore();
 * ```
 */
export class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  /** Every instance created since the last {@link MockWebSocket.reset}. */
  static instances: MockWebSocket[] = [];

  /** Open automatically on the next microtask. Off by default. */
  static autoOpen = false;

  static last(): MockWebSocket | undefined {
    return MockWebSocket.instances.at(-1);
  }

  static reset(): void {
    MockWebSocket.instances = [];
    MockWebSocket.autoOpen = false;
  }

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readonly url: string;
  readonly protocols: string | string[] | undefined;
  readyState = MockWebSocket.CONNECTING;
  binaryType: 'blob' | 'arraybuffer' = 'blob';
  bufferedAmount = 0;
  extensions = '';
  protocol = '';

  /** Raw frames the client has written, in order. */
  readonly sent: unknown[] = [];

  onopen: AnyHandler = null;
  onmessage: AnyHandler = null;
  onerror: AnyHandler = null;
  onclose: AnyHandler = null;

  private listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    MockWebSocket.instances.push(this);

    if (MockWebSocket.autoOpen) {
      queueMicrotask(() => {
        if (this.readyState === MockWebSocket.CONNECTING)
          this.acceptConnection();
      });
    }
  }

  /** Frames written by the client, JSON-parsed. Throws on non-JSON frames. */
  get sentJson(): unknown[] {
    return this.sent.map((frame) =>
      typeof frame === 'string' ? JSON.parse(frame) : frame
    );
  }

  // --- client side (what the code under test calls) -------------------------

  send(data: unknown): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error(
        `MockWebSocket: send() while readyState is ${this.readyState}`
      );
    }
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    if (
      this.readyState === MockWebSocket.CLOSED ||
      this.readyState === MockWebSocket.CLOSING
    ) {
      return;
    }
    this.readyState = MockWebSocket.CLOSING;
    queueMicrotask(() => {
      this.readyState = MockWebSocket.CLOSED;
      this.fire('close', { code, reason, wasClean: true });
    });
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  // --- server side (what the test drives) ----------------------------------

  /** Complete the handshake. */
  acceptConnection(protocol = ''): void {
    if (this.readyState !== MockWebSocket.CONNECTING) return;
    this.protocol = protocol;
    this.readyState = MockWebSocket.OPEN;
    this.fire('open', { type: 'open' });
  }

  /** Deliver a message. Non-strings are JSON-encoded first, as a server would. */
  serverSend(data: unknown): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error('MockWebSocket: serverSend() while not open');
    }
    this.fire('message', {
      data: typeof data === 'string' ? data : JSON.stringify(data)
    });
  }

  /** Deliver a frame verbatim — for testing malformed input. */
  serverSendRaw(data: unknown): void {
    this.fire('message', { data });
  }

  /** Close from the server. Defaults to 1006, the "network died" code. */
  serverClose({
    code = 1006,
    reason = '',
    wasClean = false
  }: ServerCloseOptions = {}): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.fire('close', { code, reason, wasClean });
  }

  /** Fire an `error` event. Browsers follow it with a close; do that yourself. */
  serverError(): void {
    this.fire('error', { type: 'error' });
  }

  private fire(
    type: 'open' | 'message' | 'error' | 'close',
    event: unknown
  ): void {
    const handler = (
      {
        open: this.onopen,
        message: this.onmessage,
        error: this.onerror,
        close: this.onclose
      } as const
    )[type];

    handler?.(event);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/** Use the mock for one socket without touching globals. */
export const mockSocketFactory: SocketFactory = (url, protocols) =>
  new MockWebSocket(url, protocols) as unknown as WebSocket;

export interface InstallOptions {
  /** Open every new socket automatically. Default false. */
  autoOpen?: boolean;
}

/**
 * Replace `globalThis.WebSocket` with {@link MockWebSocket}.
 *
 * Returns a `restore` function — call it in `afterEach`.
 *
 * Installed with `defineProperty` rather than assignment: jsdom and happy-dom
 * both define `WebSocket` as a non-writable own property of the global, so a
 * plain assignment throws `Cannot assign to read only property 'WebSocket'` in
 * exactly the environments this helper exists for.
 */
export const installMockWebSocket = ({
  autoOpen = false
}: InstallOptions = {}): {
  restore: () => void;
  MockWebSocket: typeof MockWebSocket;
} => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');

  MockWebSocket.reset();
  MockWebSocket.autoOpen = autoOpen;

  Object.defineProperty(globalThis, 'WebSocket', {
    value: MockWebSocket,
    writable: true,
    configurable: true,
    enumerable: original?.enumerable ?? false
  });

  return {
    restore: () => {
      // Restore the original descriptor verbatim, so a getter-backed or
      // non-writable global goes back exactly as it was.
      if (original) Object.defineProperty(globalThis, 'WebSocket', original);
      else Reflect.deleteProperty(globalThis, 'WebSocket');
      MockWebSocket.reset();
    },
    MockWebSocket
  };
};

/**
 * Let queued microtasks drain.
 *
 * Needed for the two places keepline defers: the mock's client-side `close`, and
 * connecting through an async `url`/`protocols` resolver. Several rounds,
 * because a promise chain takes more than one tick to settle — and unlike a
 * `setTimeout(0)`, this still works under fake timers.
 */
export const flushMicrotasks = async (rounds = 4): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) {
    await Promise.resolve();
  }
};
