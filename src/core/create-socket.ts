import { exponentialBackoff } from './backoff';
import {
  classifyCloseCode,
  isBackpressureClose,
  isRetryableClose
} from './close-codes';
import { Emitter } from './emitter';
import {
  ConnectionClosedError,
  GaveUpError,
  KeeplineError,
  RequestTimeoutError,
  SendFailedError,
  SocketErrorEvent,
  ValidationError
} from './errors';
import { SendQueue } from './send-queue';
import type { StandardSchemaV1 } from './standard-schema';
import { formatIssues } from './standard-schema';
import type {
  ErrorPhase,
  KeeplineEvent,
  KeeplineEventPayload,
  ProtocolsInput,
  RawData,
  ReconnectCause,
  ReconnectContext,
  RequestOptions,
  SendableData,
  Socket,
  SocketMetrics,
  SocketOptions,
  SocketStatus,
  SubscriptionSpec,
  Unsubscribe
} from './types';

const isPromiseLike = <T>(value: unknown): value is PromiseLike<T> =>
  typeof (value as PromiseLike<T> | null)?.then === 'function';

const resolveMaybeFactory = <T>(value: T | (() => T)): T =>
  typeof value === 'function' ? (value as () => T)() : value;

const hasWebSocket = (): boolean => typeof WebSocket !== 'undefined';

interface PendingRequest<TIn> {
  match: (message: TIn) => boolean;
  resolve: (message: TIn) => void;
  reject: (error: unknown) => void;
  dispose: () => void;
}

/**
 * Create a WebSocket connection that manages its own lifecycle.
 *
 * Framework-agnostic and dependency-free — the React bindings in
 * `keepline/react` are a thin `useSyncExternalStore` wrapper around this.
 *
 * ```ts
 * const socket = createSocket<ServerMessage>({
 *   url: () => `wss://api.example.com/feed?token=${getToken()}`,
 *   schema: serverMessage,          // any Standard Schema validator
 *   heartbeat: { message: { type: 'ping' } },
 *   onMessage: (message) => console.log(message.type)
 * });
 * ```
 */
export const createSocket = <TIn = unknown, TOut = unknown>(
  options: SocketOptions<TIn, TOut>
): Socket<TIn, TOut> => {
  const {
    autoConnect = true,
    binaryType,
    connectTimeoutMs = 10_000,
    pauseWhenHidden = false,
    reconnectWhenOnline = true,
    now = Date.now,
    socketFactory = (url, protocols) =>
      protocols === undefined
        ? new WebSocket(url)
        : new WebSocket(url, protocols)
  } = options;

  const reconnectOptions =
    options.reconnect === false ? null : (options.reconnect ?? {});
  const maxAttempts = reconnectOptions?.attempts ?? Number.POSITIVE_INFINITY;
  const backoff = reconnectOptions?.backoff ?? exponentialBackoff();
  const retryOnError = reconnectOptions?.retryOnError ?? true;
  const backpressureDelayMs = reconnectOptions?.backpressureDelayMs ?? 30_000;

  const queue =
    options.queue === false ? null : new SendQueue<TOut>(options.queue ?? {});

  const heartbeatOptions =
    options.heartbeat === false ? null : (options.heartbeat ?? null);

  const messageEmitter = new Emitter<TIn>();
  const eventEmitter = new Emitter<KeeplineEvent<TIn, TOut>>();
  const statusEmitter = new Emitter<void>();

  const subscriptions = new Map<string, SubscriptionSpec<TOut>>();
  const pendingRequests = new Set<PendingRequest<TIn>>();
  const pauseReasons = new Set<'hidden' | 'offline' | 'manual'>();

  let ws: WebSocket | null = null;
  let status: SocketStatus = 'idle';
  let currentUrl: string | null = null;
  let attempt = 0;
  let destroyed = false;
  /** Set by `close()`; suppresses reconnection until `connect()`/`reconnect()`. */
  let intentionallyClosed = false;
  /**
   * Incremented whenever we abandon a socket. Handlers captured with an older
   * generation become no-ops, which is what stops a replaced socket's late
   * `close` event from clobbering the state of its replacement.
   */
  let generation = 0;
  let subscriptionSeq = 0;
  let openedThisAttempt = false;
  let gaveUpAttempts = 0;

  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let pongTimer: ReturnType<typeof setTimeout> | undefined;
  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  let lastPingAt = 0;

  const metrics: SocketMetrics = {
    status,
    connections: 0,
    reconnects: 0,
    failedAttempts: 0,
    currentAttempt: 0,
    messagesReceived: 0,
    messagesSent: 0,
    messagesQueued: 0,
    messagesDropped: 0,
    decodeErrors: 0,
    validationErrors: 0,
    queueSize: 0,
    totalDowntimeMs: 0
  };

  // ---------------------------------------------------------------------------
  // events
  // ---------------------------------------------------------------------------

  const emit = (
    event: KeeplineEventPayload<TIn, TOut> & { at?: number }
  ): void => {
    const full = { ...event, at: event.at ?? now() } as KeeplineEvent<
      TIn,
      TOut
    >;
    eventEmitter.emit(full, (error) => report(error, 'listener', false));
    try {
      options.onEvent?.(full);
    } catch (error) {
      report(error, 'listener', false);
    }
  };

  /**
   * Surface an error without ever throwing into a socket event handler.
   *
   * `emitEvent: false` breaks the recursion when the failure *was* an event
   * listener throwing.
   */
  const report = (
    error: unknown,
    phase: ErrorPhase,
    emitEvent = true
  ): void => {
    if (emitEvent) emit({ type: 'error', error, phase });
    try {
      options.onError?.(error, phase);
    } catch {
      // A throwing error handler is not worth a second error.
    }
  };

  const setStatus = (next: SocketStatus): void => {
    if (status === next) return;
    const previous = status;
    status = next;
    metrics.status = next;
    emit({ type: 'status', status: next, previous });
    statusEmitter.emit(undefined, (error) => report(error, 'listener', false));
  };

  // ---------------------------------------------------------------------------
  // timers
  // ---------------------------------------------------------------------------

  const clearReconnectTimer = (): void => {
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  };

  const clearConnectTimer = (): void => {
    if (connectTimer !== undefined) clearTimeout(connectTimer);
    connectTimer = undefined;
  };

  const stopHeartbeat = (): void => {
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    if (pongTimer !== undefined) clearTimeout(pongTimer);
    pongTimer = undefined;
  };

  const clearStaleTimer = (): void => {
    if (staleTimer !== undefined) clearTimeout(staleTimer);
    staleTimer = undefined;
  };

  const armStaleTimer = (): void => {
    clearStaleTimer();
    const { staleAfterMs } = options;
    if (!staleAfterMs || staleAfterMs <= 0) return;

    staleTimer = setTimeout(() => {
      emit({ type: 'stale', sinceMs: staleAfterMs });
      forceReconnect('stale');
    }, staleAfterMs);
  };

  const startHeartbeat = (): void => {
    stopHeartbeat();
    if (!heartbeatOptions) return;

    const intervalMs = heartbeatOptions.intervalMs ?? 30_000;
    const timeoutMs = heartbeatOptions.timeoutMs ?? 10_000;

    heartbeatTimer = setInterval(() => {
      if (status !== 'open') return;

      lastPingAt = now();
      if (heartbeatOptions.message !== undefined) {
        send(resolveMaybeFactory(heartbeatOptions.message));
      }

      if (pongTimer !== undefined) return;
      pongTimer = setTimeout(() => {
        pongTimer = undefined;
        emit({ type: 'heartbeat-timeout', timeoutMs });
        forceReconnect('heartbeat-timeout');
      }, timeoutMs);
    }, intervalMs);
  };

  const noteHeartbeatResponse = (message: TIn): void => {
    if (!heartbeatOptions || pongTimer === undefined) return;
    if (heartbeatOptions.isPong && !heartbeatOptions.isPong(message)) return;

    clearTimeout(pongTimer);
    pongTimer = undefined;
    metrics.lastRttMs = Math.max(0, now() - lastPingAt);
    emit({ type: 'heartbeat', rttMs: metrics.lastRttMs });
  };

  // ---------------------------------------------------------------------------
  // inbound pipeline: decode -> validate -> deliver
  // ---------------------------------------------------------------------------

  /**
   * Async decoders/schemas must not reorder a stream, so once one message goes
   * async every following message is chained behind it.
   */
  let tail: Promise<unknown> = Promise.resolve();
  let inFlight = 0;

  const settle = (): void => {
    inFlight = Math.max(0, inFlight - 1);
  };

  const deliver = (message: TIn): void => {
    metrics.messagesReceived += 1;
    metrics.lastMessageAt = now();
    armStaleTimer();
    noteHeartbeatResponse(message);
    emit({ type: 'message', message });

    for (const request of [...pendingRequests]) {
      let matched = false;
      try {
        matched = request.match(message);
      } catch (error) {
        report(error, 'listener');
      }
      if (matched) {
        pendingRequests.delete(request);
        request.dispose();
        request.resolve(message);
        break;
      }
    }

    messageEmitter.emit(message, (error) => report(error, 'listener'));
    try {
      options.onMessage?.(message);
    } catch (error) {
      report(error, 'listener');
    }
  };

  const validateAndDeliver = (value: unknown): void | Promise<void> => {
    const { schema } = options;
    if (!schema) {
      deliver(value as TIn);
      return;
    }

    const result = schema['~standard'].validate(value);

    const finish = (settled: StandardSchemaV1.Result<TIn>): void => {
      if (settled.issues) {
        metrics.validationErrors += 1;
        emit({ type: 'validation-error', issues: settled.issues, value });
        report(
          new ValidationError(formatIssues(settled.issues), settled.issues),
          'socket',
          false
        );
        return;
      }
      deliver(settled.value);
    };

    if (isPromiseLike(result)) {
      return Promise.resolve(result).then(finish);
    }
    finish(result);
  };

  const decodeDefault = (data: RawData): unknown =>
    typeof data === 'string' ? JSON.parse(data) : data;

  const step = (data: RawData): void | Promise<void> => {
    const onFailure = (error: unknown): void => {
      metrics.decodeErrors += 1;
      emit({ type: 'decode-error', error, data });
      report(error, 'socket', false);
    };

    try {
      const decoded = (options.decode ?? decodeDefault)(data);

      if (isPromiseLike(decoded)) {
        return Promise.resolve(decoded)
          .then((value) => validateAndDeliver(value))
          .catch(onFailure);
      }

      const delivery = validateAndDeliver(decoded);
      if (isPromiseLike(delivery)) {
        return Promise.resolve(delivery).catch(onFailure);
      }
    } catch (error) {
      onFailure(error);
    }
  };

  const handleRaw = (data: RawData): void => {
    if (inFlight === 0) {
      const result = step(data);
      if (isPromiseLike(result)) {
        inFlight += 1;
        tail = Promise.resolve(result).then(settle, settle);
      }
      return;
    }

    inFlight += 1;
    tail = tail.then(() => step(data)).then(settle, settle);
  };

  // ---------------------------------------------------------------------------
  // outbound
  // ---------------------------------------------------------------------------

  const encodeDefault = (payload: TOut): SendableData =>
    typeof payload === 'string' ? payload : JSON.stringify(payload);

  const writeToSocket = (payload: TOut): boolean => {
    let data: SendableData;
    try {
      data = (options.encode ?? encodeDefault)(payload);
    } catch (error) {
      report(error, 'encode');
      return false;
    }

    try {
      ws?.send(data);
    } catch (error) {
      report(error, 'socket');
      return false;
    }

    metrics.messagesSent += 1;
    emit({ type: 'sent', payload });
    return true;
  };

  const drop = (
    payload: TOut,
    reason: 'queue-full' | 'queue-disabled' | 'destroyed'
  ): void => {
    metrics.messagesDropped += 1;
    emit({ type: 'dropped', payload, reason });
  };

  const send = (payload: TOut): boolean => {
    if (destroyed) {
      drop(payload, 'destroyed');
      return false;
    }

    if (status === 'open' && ws?.readyState === 1) {
      return writeToSocket(payload);
    }

    if (!queue) {
      drop(payload, 'queue-disabled');
      return false;
    }

    const { accepted, dropped } = queue.push(payload);
    metrics.queueSize = queue.size;

    if (dropped !== undefined) drop(dropped, 'queue-full');
    if (accepted) {
      metrics.messagesQueued += 1;
      emit({ type: 'queued', payload, queueSize: queue.size });
    } else if (dropped === undefined) {
      drop(payload, 'queue-full');
    }

    return accepted;
  };

  const flushQueue = (): void => {
    if (!queue) return;
    const pending = queue.drain();
    metrics.queueSize = 0;
    for (const payload of pending) {
      if (status !== 'open') {
        // Re-queue the remainder rather than losing it.
        queue.push(payload);
        metrics.queueSize = queue.size;
        continue;
      }
      writeToSocket(payload);
    }
  };

  const replaySubscriptions = (): void => {
    for (const spec of subscriptions.values()) {
      try {
        writeToSocket(resolveMaybeFactory(spec.subscribe));
      } catch (error) {
        report(error, 'encode');
      }
    }
  };

  // ---------------------------------------------------------------------------
  // connection lifecycle
  // ---------------------------------------------------------------------------

  const abandonSocket = (): void => {
    generation += 1;
    const abandoned = ws;
    ws = null;
    if (!abandoned) return;

    abandoned.onopen = null;
    abandoned.onmessage = null;
    abandoned.onerror = null;
    abandoned.onclose = null;
    try {
      abandoned.close();
    } catch {
      // Closing an already-dead socket is not interesting.
    }
  };

  const rejectPendingRequests = (error: unknown): void => {
    for (const request of [...pendingRequests]) {
      pendingRequests.delete(request);
      request.dispose();
      request.reject(error);
    }
  };

  const noteDown = (): void => {
    metrics.lastClosedAt = now();
    stopHeartbeat();
    clearStaleTimer();
    clearConnectTimer();
  };

  const shouldRetrySync = (context: ReconnectContext): boolean => {
    if (!reconnectOptions) return false;
    if (attempt + 1 > maxAttempts) return false;
    if (context.cause === 'error' && !retryOnError) return false;
    if (context.code !== undefined && !isRetryableClose(context.code))
      return false;
    return true;
  };

  const scheduleReconnect = (context: ReconnectContext): void => {
    if (destroyed || intentionallyClosed || pauseReasons.size > 0) return;
    if (!reconnectOptions) {
      setStatus('closed');
      return;
    }

    attempt += 1;
    metrics.currentAttempt = attempt;

    if (attempt > maxAttempts) {
      gaveUpAttempts = attempt - 1;
      emit({
        type: 'gave-up',
        attempts: gaveUpAttempts,
        lastCode: context.code
      });
      setStatus('gave-up');
      rejectPendingRequests(new GaveUpError(gaveUpAttempts));
      return;
    }

    setStatus('reconnecting');
    const decision = { ...context, attempt };

    const proceed = (allowed: boolean): void => {
      if (destroyed || intentionallyClosed || pauseReasons.size > 0) return;
      if (!allowed) {
        setStatus('closed');
        return;
      }

      const delayMs =
        context.code !== undefined && isBackpressureClose(context.code)
          ? backpressureDelayMs
          : backoff(attempt);

      emit({
        type: 'reconnect-scheduled',
        attempt,
        delayMs,
        cause: context.cause
      });

      clearReconnectTimer();
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        openSocket();
      }, delayMs);
    };

    let allowed: boolean | Promise<boolean> = true;
    try {
      allowed = reconnectOptions.shouldReconnect?.(decision) ?? true;
    } catch (error) {
      report(error, 'listener');
      allowed = false;
    }

    if (isPromiseLike(allowed)) {
      Promise.resolve(allowed).then(proceed, (error) => {
        report(error, 'listener');
        setStatus('closed');
      });
    } else {
      proceed(allowed);
    }
  };

  const handleClose = (event: {
    code: number;
    reason: string;
    wasClean: boolean;
  }): void => {
    const category = classifyCloseCode(event.code);

    ws = null;
    // Downtime accrues from `lastClosedAt`, set here and totalled on next open.
    noteDown();

    if (!openedThisAttempt) metrics.failedAttempts += 1;

    metrics.lastCloseCode = event.code;
    metrics.lastCloseCategory = category;

    const context: ReconnectContext = {
      attempt,
      cause: 'close',
      code: event.code,
      category,
      reason: event.reason,
      wasClean: event.wasClean
    };

    const willReconnect =
      !destroyed &&
      !intentionallyClosed &&
      pauseReasons.size === 0 &&
      shouldRetrySync(context);

    emit({
      type: 'close',
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
      category
    });

    try {
      options.onClose?.({
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
        category,
        willReconnect
      });
    } catch (error) {
      report(error, 'listener');
    }

    rejectPendingRequests(new ConnectionClosedError(event.code, category));

    if (destroyed) return;
    if (intentionallyClosed) {
      setStatus('closed');
      return;
    }
    if (pauseReasons.size > 0) {
      setStatus('paused');
      return;
    }

    if (willReconnect) {
      scheduleReconnect(context);
    } else if (reconnectOptions && attempt + 1 > maxAttempts) {
      gaveUpAttempts = attempt;
      emit({ type: 'gave-up', attempts: gaveUpAttempts, lastCode: event.code });
      setStatus('gave-up');
    } else {
      setStatus('closed');
    }
  };

  const handleOpen = (url: string): void => {
    clearConnectTimer();
    openedThisAttempt = true;

    const succeededOnAttempt = attempt;
    const reconnected = metrics.connections > 0;
    const downtimeMs =
      reconnected && metrics.lastClosedAt !== undefined
        ? Math.max(0, now() - metrics.lastClosedAt)
        : 0;

    metrics.connections += 1;
    if (reconnected) metrics.reconnects += 1;
    metrics.totalDowntimeMs += downtimeMs;
    metrics.lastOpenedAt = now();
    metrics.currentAttempt = 0;
    attempt = 0;

    setStatus('open');
    emit({
      type: 'open',
      url,
      attempt: succeededOnAttempt,
      reconnected,
      downtimeMs
    });

    try {
      options.onOpen?.({
        url,
        attempt: succeededOnAttempt,
        reconnected,
        send: writeToSocket
      });
    } catch (error) {
      report(error, 'listener');
    }

    // Order matters: caller's `onOpen` (auth) -> restored subscriptions ->
    // messages the app queued while down.
    replaySubscriptions();
    flushQueue();
    startHeartbeat();
    armStaleTimer();
  };

  const handleErrorEvent = (event: unknown): void => {
    // Browsers always fire `close` after `error`, so reconnection is driven by
    // `handleClose`; this only records the error. `retryOnError` is consulted
    // there, via `shouldRetrySync`.
    report(new SocketErrorEvent(event), 'socket');
  };

  const beginConnection = (
    gen: number,
    url: string | null | undefined,
    protocols: ProtocolsInput
  ): void => {
    if (destroyed || gen !== generation) return;

    if (!url) {
      currentUrl = null;
      setStatus('idle');
      return;
    }

    if (!options.socketFactory && !hasWebSocket()) {
      // Server-side render, or an environment without WebSocket. Staying idle
      // is correct: there is nothing to connect and nothing to warn about.
      setStatus('idle');
      return;
    }

    currentUrl = url;
    emit({ type: 'opening', url, attempt });

    let socket: WebSocket;
    try {
      socket = socketFactory(url, protocols);
    } catch (error) {
      report(error, 'connect');
      scheduleReconnect({ attempt, cause: 'error', error });
      return;
    }

    ws = socket;
    if (binaryType) socket.binaryType = binaryType;

    socket.onopen = () => {
      if (gen !== generation || destroyed) return;
      handleOpen(url as string);
    };
    socket.onmessage = (event: MessageEvent) => {
      if (gen !== generation || destroyed) return;
      handleRaw(event.data as RawData);
    };
    socket.onerror = (event) => {
      if (gen !== generation || destroyed) return;
      handleErrorEvent(event);
    };
    socket.onclose = (event) => {
      if (gen !== generation || destroyed) return;
      handleClose({
        code: event.code ?? 1006,
        reason: event.reason ?? '',
        wasClean: event.wasClean ?? false
      });
    };

    if (connectTimeoutMs > 0) {
      clearConnectTimer();
      connectTimer = setTimeout(() => {
        connectTimer = undefined;
        if (gen !== generation || status === 'open' || destroyed) return;

        emit({ type: 'connect-timeout', timeoutMs: connectTimeoutMs });
        abandonSocket();
        metrics.failedAttempts += 1;
        noteDown();
        scheduleReconnect({ attempt, cause: 'connect-timeout' });
      }, connectTimeoutMs);
    }
  };

  const openSocket = (): void => {
    if (destroyed || pauseReasons.size > 0) return;

    clearReconnectTimer();
    openedThisAttempt = false;

    const gen = ++generation;
    setStatus(attempt > 0 ? 'reconnecting' : 'connecting');

    const { url, protocols } = options;

    // Fast path: a literal URL connects synchronously, so `createSocket()`
    // returns with a live socket. Only resolvers defer to a microtask — and
    // deferring unconditionally would make every consumer, and every test,
    // await a tick for no reason.
    if (typeof url !== 'function' && typeof protocols !== 'function') {
      beginConnection(gen, url, protocols);
      return;
    }

    Promise.all([
      typeof url === 'function' ? url() : url,
      typeof protocols === 'function' ? protocols() : protocols
    ]).then(
      ([resolvedUrl, resolvedProtocols]) =>
        beginConnection(gen, resolvedUrl, resolvedProtocols),
      (error) => {
        report(error, 'url-resolution');
        scheduleReconnect({ attempt, cause: 'error', error });
      }
    );
  };

  const forceReconnect = (cause: ReconnectCause): void => {
    // After `close()`, a liveness timer must not abandon the socket the close
    // handshake still owns — that would drop its `close` event and strand the
    // status at 'closing'.
    if (destroyed || intentionallyClosed) return;

    abandonSocket();
    noteDown();
    rejectPendingRequests(new ConnectionClosedError());
    scheduleReconnect({ attempt, cause });
  };

  // ---------------------------------------------------------------------------
  // pause / resume (visibility + connectivity)
  // ---------------------------------------------------------------------------

  const pause = (reason: 'hidden' | 'offline' | 'manual'): void => {
    if (destroyed || pauseReasons.has(reason)) return;
    const wasPaused = pauseReasons.size > 0;
    pauseReasons.add(reason);
    if (wasPaused) return;

    clearReconnectTimer();
    abandonSocket();
    noteDown();
    emit({ type: 'paused', reason });
    setStatus('paused');
  };

  const resume = (reason: 'visible' | 'online' | 'manual'): void => {
    if (destroyed) return;

    const key =
      reason === 'visible'
        ? 'hidden'
        : reason === 'online'
          ? 'offline'
          : 'manual';
    if (!pauseReasons.delete(key) || pauseReasons.size > 0) return;

    emit({ type: 'resumed', reason });
    // A resume is new information about the world, so the backoff curve that
    // built up against the old conditions no longer applies.
    attempt = 0;
    metrics.currentAttempt = 0;
    if (!intentionallyClosed) openSocket();
    else setStatus('closed');
  };

  const teardownEnvironmentListeners: Unsubscribe[] = [];

  const bindEnvironment = (): void => {
    if (typeof document !== 'undefined' && pauseWhenHidden) {
      const onVisibility = (): void => {
        if (document.visibilityState === 'hidden') pause('hidden');
        else resume('visible');
      };
      document.addEventListener('visibilitychange', onVisibility);
      teardownEnvironmentListeners.push(() =>
        document.removeEventListener('visibilitychange', onVisibility)
      );
    }

    if (typeof window !== 'undefined' && reconnectWhenOnline) {
      const onOnline = (): void => resume('online');
      const onOffline = (): void => pause('offline');
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
      teardownEnvironmentListeners.push(() => {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
      });
    }
  };

  // ---------------------------------------------------------------------------
  // public surface
  // ---------------------------------------------------------------------------

  const request = <TResponse = TIn>(
    payload: TOut,
    requestOptions: RequestOptions<TIn> = {}
  ): Promise<TResponse> => {
    const match =
      requestOptions.match ??
      (options.matchResponse
        ? (message: TIn) => options.matchResponse?.(message, payload) ?? false
        : undefined);

    if (!match) {
      return Promise.reject(
        new KeeplineError(
          'request() needs a `match` function, either per call or as the `matchResponse` option'
        )
      );
    }

    const timeoutMs = requestOptions.timeoutMs ?? 10_000;

    return new Promise<TResponse>((resolve, reject) => {
      const cleanup: Array<() => void> = [];

      const entry: PendingRequest<TIn> = {
        match,
        resolve: (message) => resolve(message as unknown as TResponse),
        reject,
        dispose: () => {
          for (const undo of cleanup) undo();
          cleanup.length = 0;
        }
      };

      const fail = (error: unknown): void => {
        pendingRequests.delete(entry);
        entry.dispose();
        reject(error);
      };

      const { signal } = requestOptions;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      if (signal) {
        const onAbort = (): void => fail(signal.reason);
        signal.addEventListener('abort', onAbort);
        cleanup.push(() => signal.removeEventListener('abort', onAbort));
      }

      const timer = setTimeout(
        () => fail(new RequestTimeoutError(timeoutMs)),
        timeoutMs
      );
      cleanup.push(() => clearTimeout(timer));

      pendingRequests.add(entry);

      if (!send(payload)) {
        fail(
          new SendFailedError('payload was dropped before it could be sent')
        );
      }
    });
  };

  const socket: Socket<TIn, TOut> = {
    get status() {
      return status;
    },
    get readyState() {
      return ws?.readyState ?? 3;
    },
    get url() {
      return currentUrl;
    },
    get destroyed() {
      return destroyed;
    },
    get metrics() {
      return metrics;
    },

    connect() {
      if (destroyed) return;
      intentionallyClosed = false;
      if (status === 'open' || status === 'connecting') return;
      if (pauseReasons.size > 0) return;
      openSocket();
    },

    close(code, reason) {
      if (destroyed) return;
      intentionallyClosed = true;
      clearReconnectTimer();

      if (ws) {
        setStatus('closing');
        // The liveness timers must not outlive the intent to close: a connect,
        // stale, or pong timeout firing mid-close would abandon the socket,
        // drop its `close` event, and strand the status at 'closing'.
        stopHeartbeat();
        clearStaleTimer();
        clearConnectTimer();
        try {
          ws.close(code, reason);
        } catch {
          abandonSocket();
          noteDown();
          setStatus('closed');
        }
      } else {
        noteDown();
        setStatus('closed');
      }
    },

    reconnect() {
      if (destroyed) return;
      intentionallyClosed = false;
      attempt = 0;
      metrics.currentAttempt = 0;
      abandonSocket();
      noteDown();
      clearReconnectTimer();
      openSocket();
    },

    pause: () => pause('manual'),
    resume: () => resume('manual'),

    destroy() {
      if (destroyed) return;
      destroyed = true;

      clearReconnectTimer();
      abandonSocket();
      noteDown();
      rejectPendingRequests(new ConnectionClosedError());

      for (const teardown of teardownEnvironmentListeners) teardown();
      teardownEnvironmentListeners.length = 0;

      subscriptions.clear();
      queue?.clear();
      metrics.queueSize = 0;

      emit({ type: 'destroyed' });
      setStatus('closed');

      messageEmitter.clear();
      eventEmitter.clear();
      statusEmitter.clear();
    },

    send,

    sendRaw(data) {
      if (destroyed || status !== 'open' || ws?.readyState !== 1) return false;
      try {
        ws.send(data);
      } catch (error) {
        report(error, 'socket');
        return false;
      }
      metrics.messagesSent += 1;
      return true;
    },

    request,

    subscription(spec) {
      if (destroyed) return () => {};

      subscriptionSeq += 1;
      const key = spec.key ?? `keepline:sub:${subscriptionSeq}`;
      subscriptions.set(key, spec);

      if (status === 'open') {
        try {
          writeToSocket(resolveMaybeFactory(spec.subscribe));
        } catch (error) {
          report(error, 'encode');
        }
      }

      return () => {
        if (!subscriptions.delete(key)) return;
        if (spec.unsubscribe === undefined || status !== 'open') return;
        try {
          writeToSocket(resolveMaybeFactory(spec.unsubscribe));
        } catch (error) {
          report(error, 'encode');
        }
      };
    },

    onMessage: (listener) => messageEmitter.add(listener),
    onEvent: (listener) => eventEmitter.add(listener),
    onStatusChange: (listener) => statusEmitter.add(listener),

    getWebSocket: () => ws,

    waitForOpen({ timeoutMs = 10_000, signal } = {}) {
      if (status === 'open') return Promise.resolve();
      // Both of these states emit no further events, so waiting on the event
      // stream would hang until the timeout — or forever with `timeoutMs: 0`.
      if (destroyed) return Promise.reject(new ConnectionClosedError());
      if (status === 'gave-up')
        return Promise.reject(new GaveUpError(gaveUpAttempts));

      return new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = (): void => {
          off();
          if (timer !== undefined) clearTimeout(timer);
          if (onAbort) signal?.removeEventListener('abort', onAbort);
        };

        const off = eventEmitter.add((event) => {
          if (event.type === 'open') {
            cleanup();
            resolve();
          } else if (event.type === 'gave-up') {
            cleanup();
            reject(new GaveUpError(event.attempts));
          } else if (event.type === 'destroyed') {
            cleanup();
            reject(new ConnectionClosedError());
          }
        });

        const onAbort = signal
          ? () => {
              cleanup();
              reject(signal.reason);
            }
          : undefined;
        if (signal?.aborted) {
          cleanup();
          reject(signal.reason);
          return;
        }
        if (onAbort) signal?.addEventListener('abort', onAbort);

        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            cleanup();
            reject(new RequestTimeoutError(timeoutMs));
          }, timeoutMs);
        }
      });
    }
  };

  bindEnvironment();

  // Register every reason that applies, not just the first: a tab that starts
  // hidden *and* offline must stay paused when only one of the two clears.
  if (
    reconnectWhenOnline &&
    typeof navigator !== 'undefined' &&
    navigator.onLine === false
  ) {
    pauseReasons.add('offline');
  }
  if (
    pauseWhenHidden &&
    typeof document !== 'undefined' &&
    document.visibilityState === 'hidden'
  ) {
    pauseReasons.add('hidden');
  }

  if (pauseReasons.size > 0) {
    setStatus('paused');
  } else if (autoConnect) {
    openSocket();
  }

  return socket;
};
