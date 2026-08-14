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
  Unsubscribe,
  WebSocketLike
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

interface QueuedPayload<TOut> {
  payload: TOut;
  /** Requests expose whether their queued wrapper still owns unsettled work. */
  isActive?: () => boolean;
  /** Requests use this to reject immediately when overflow evicts their send. */
  onDrop?: (reason: 'queue-full' | 'queue-disabled' | 'destroyed') => void;
  onWriteFailed?: () => void;
}

interface SubscriptionRegistration<TOut> {
  spec: SubscriptionSpec<TOut>;
}

type WebSocketTransport = WebSocketLike;

interface TransportBinding {
  socket: WebSocketTransport;
  cleanup: () => void;
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
    options.queue === false
      ? null
      : new SendQueue<QueuedPayload<TOut>>(options.queue ?? {});

  const heartbeatOptions =
    options.heartbeat === false ? null : (options.heartbeat ?? null);

  const messageEmitter = new Emitter<TIn>();
  const eventEmitter = new Emitter<KeeplineEvent<TIn, TOut>>();
  const statusEmitter = new Emitter<void>();

  const subscriptions = new Map<string, SubscriptionRegistration<TOut>>();
  const pendingRequests = new Set<PendingRequest<TIn>>();
  const pauseReasons = new Set<'hidden' | 'offline' | 'manual'>();

  let ws: WebSocketTransport | null = null;
  let transportBinding: TransportBinding | null = null;
  let closeCleanupDepth = 0;
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
  /** First instant of the current outage; failed retries must not overwrite it. */
  let outageStartedAt: number | undefined;

  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let pongTimer: ReturnType<typeof setTimeout> | undefined;
  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  let errorRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let lastPingAt = 0;
  const pendingReconnectDecisions = new Set<() => void>();

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

  const runCloseCleanup = (cleanup: () => void): void => {
    closeCleanupDepth += 1;
    try {
      cleanup();
    } finally {
      closeCleanupDepth -= 1;
    }
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

  const clearErrorRetryTimer = (): void => {
    if (errorRetryTimer !== undefined) clearTimeout(errorRetryTimer);
    errorRetryTimer = undefined;
  };

  /** Settle deferred close notifications when another lifecycle action wins. */
  const cancelPendingReconnectDecisions = (): void => {
    for (const cancel of [...pendingReconnectDecisions]) cancel();
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

  const armStaleTimer = (gen = generation): void => {
    clearStaleTimer();
    const { staleAfterMs } = options;
    if (!staleAfterMs || staleAfterMs <= 0) return;

    staleTimer = setTimeout(() => {
      if (!isCurrentGeneration(gen)) return;
      staleTimer = undefined;
      emit({ type: 'stale', sinceMs: staleAfterMs });
      if (!isCurrentGeneration(gen)) return;
      forceReconnect('stale');
    }, staleAfterMs);
  };

  const startHeartbeat = (gen = generation): void => {
    stopHeartbeat();
    if (!heartbeatOptions) return;

    const intervalMs = heartbeatOptions.intervalMs ?? 30_000;
    const timeoutMs = heartbeatOptions.timeoutMs ?? 10_000;

    heartbeatTimer = setInterval(() => {
      if (!isCurrentGeneration(gen) || status !== 'open') return;
      const interval = heartbeatTimer;

      if (heartbeatOptions.message !== undefined) {
        let message: TOut;
        try {
          message = resolveMaybeFactory(heartbeatOptions.message);
        } catch (error) {
          report(error, 'encode');
          return;
        }
        if (!isCurrentGeneration(gen) || status !== 'open') return;
        if (!send(message)) return;
        if (
          !isCurrentGeneration(gen) ||
          status !== 'open' ||
          heartbeatTimer !== interval
        )
          return;
      }

      if (heartbeatTimer !== interval) return;
      lastPingAt = now();
      if (pongTimer !== undefined) return;
      pongTimer = setTimeout(() => {
        if (!isCurrentGeneration(gen)) return;
        pongTimer = undefined;
        emit({ type: 'heartbeat-timeout', timeoutMs });
        if (!isCurrentGeneration(gen)) return;
        forceReconnect('heartbeat-timeout');
      }, timeoutMs);
    }, intervalMs);
  };

  const noteHeartbeatResponse = (message: TIn, gen: number): void => {
    if (!heartbeatOptions || pongTimer === undefined) return;
    const expectedPongTimer = pongTimer;
    if (heartbeatOptions.isPong) {
      let isPong = false;
      try {
        isPong = heartbeatOptions.isPong(message);
      } catch (error) {
        report(error, 'listener');
        return;
      }
      if (!isCurrentGeneration(gen) || pongTimer !== expectedPongTimer) return;
      if (!isPong) return;
    }

    if (!isCurrentGeneration(gen) || pongTimer !== expectedPongTimer) return;
    clearTimeout(expectedPongTimer);
    pongTimer = undefined;
    metrics.lastRttMs = Math.max(0, now() - lastPingAt);
    emit({ type: 'heartbeat', rttMs: metrics.lastRttMs });
  };

  // ---------------------------------------------------------------------------
  // inbound pipeline: decode -> validate -> deliver
  // ---------------------------------------------------------------------------

  /**
   * Async decoders/schemas must not reorder a stream, so once one message goes
   * async every following message from that connection is chained behind it.
   * A replacement connection gets a fresh pipeline, so abandoned work cannot
   * block or deliver into the new generation.
   */
  interface InboundPipeline {
    generation: number;
    tail: Promise<unknown>;
    inFlight: number;
  }
  let inboundPipeline: InboundPipeline = {
    generation,
    tail: Promise.resolve(),
    inFlight: 0
  };

  const isCurrentGeneration = (gen: number): boolean =>
    !destroyed && gen === generation;

  const deliver = (message: TIn, gen: number): void => {
    if (!isCurrentGeneration(gen)) return;

    metrics.messagesReceived += 1;
    metrics.lastMessageAt = now();
    armStaleTimer(gen);
    noteHeartbeatResponse(message, gen);
    if (!isCurrentGeneration(gen)) return;
    emit({ type: 'message', message });
    if (!isCurrentGeneration(gen)) return;

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

  const validateAndDeliver = (
    value: unknown,
    gen: number
  ): void | Promise<void> => {
    if (!isCurrentGeneration(gen)) return;

    const { schema } = options;
    if (!schema) {
      deliver(value as TIn, gen);
      return;
    }

    const result = schema['~standard'].validate(value);

    const finish = (settled: StandardSchemaV1.Result<TIn>): void => {
      if (!isCurrentGeneration(gen)) return;
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
      deliver(settled.value, gen);
    };

    if (isPromiseLike(result)) {
      return Promise.resolve(result).then(finish);
    }
    finish(result);
  };

  const decodeDefault = (data: RawData): unknown =>
    typeof data === 'string' ? JSON.parse(data) : data;

  const step = (data: RawData, gen: number): void | Promise<void> => {
    const onFailure = (error: unknown): void => {
      if (!isCurrentGeneration(gen)) return;
      metrics.decodeErrors += 1;
      emit({ type: 'decode-error', error, data });
      report(error, 'socket', false);
    };

    try {
      if (!isCurrentGeneration(gen)) return;
      const decoded = (options.decode ?? decodeDefault)(data);

      if (isPromiseLike(decoded)) {
        return Promise.resolve(decoded)
          .then((value) => validateAndDeliver(value, gen))
          .catch(onFailure);
      }

      const delivery = validateAndDeliver(decoded, gen);
      if (isPromiseLike(delivery)) {
        return Promise.resolve(delivery).catch(onFailure);
      }
    } catch (error) {
      onFailure(error);
    }
  };

  const handleRaw = (data: RawData, gen: number): void => {
    if (!isCurrentGeneration(gen)) return;
    if (inboundPipeline.generation !== gen) {
      inboundPipeline = {
        generation: gen,
        tail: Promise.resolve(),
        inFlight: 0
      };
    }
    const pipeline = inboundPipeline;
    const settle = (): void => {
      pipeline.inFlight = Math.max(0, pipeline.inFlight - 1);
    };

    if (pipeline.inFlight === 0) {
      const result = step(data, gen);
      if (isPromiseLike(result)) {
        pipeline.inFlight += 1;
        pipeline.tail = Promise.resolve(result).then(settle, settle);
      }
      return;
    }

    pipeline.inFlight += 1;
    pipeline.tail = pipeline.tail
      .then(() => step(data, gen))
      .then(settle, settle);
  };

  // ---------------------------------------------------------------------------
  // outbound
  // ---------------------------------------------------------------------------

  const encodeDefault = (payload: TOut): SendableData =>
    typeof payload === 'string' ? payload : JSON.stringify(payload);

  const writeToSocket = (payload: TOut): boolean => {
    const socket = ws;
    const gen = generation;
    if (!socket || status !== 'open' || socket.readyState !== socket.OPEN)
      return false;

    let data: SendableData;
    try {
      data = (options.encode ?? encodeDefault)(payload);
    } catch (error) {
      report(error, 'encode');
      return false;
    }

    if (
      destroyed ||
      gen !== generation ||
      ws !== socket ||
      status !== 'open' ||
      socket.readyState !== socket.OPEN
    )
      return false;

    try {
      socket.send(data);
    } catch (error) {
      report(error, 'socket');
      return false;
    }

    // A custom transport may synchronously close or otherwise reenter from
    // send(). Returning normally still means this payload was written, so it
    // must not be queued and sent again on the replacement transport.
    metrics.messagesSent += 1;
    if (!destroyed && gen === generation && ws === socket)
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

  const dropQueued = (
    queued: QueuedPayload<TOut>,
    reason: 'queue-full' | 'queue-disabled' | 'destroyed'
  ): void => {
    drop(queued.payload, reason);
    queued.onDrop?.(reason);
  };

  const enqueueQueued = (
    queued: QueuedPayload<TOut>
  ): { accepted: boolean; queued?: QueuedPayload<TOut> } => {
    const { payload } = queued;
    if (destroyed) {
      drop(payload, 'destroyed');
      queued.onDrop?.('destroyed');
      return { accepted: false };
    }

    if (status === 'open' && ws?.readyState === 1) {
      const accepted = writeToSocket(payload);
      if (!accepted) queued.onWriteFailed?.();
      return { accepted };
    }

    if (!queue) {
      dropQueued(queued, 'queue-disabled');
      return { accepted: false };
    }

    const { accepted, dropped } = queue.push(queued);
    metrics.queueSize = queue.size;

    if (dropped !== undefined) dropQueued(dropped, 'queue-full');
    if (accepted) {
      metrics.messagesQueued += 1;
      emit({ type: 'queued', payload, queueSize: queue.size });
    } else if (dropped === undefined) {
      dropQueued(queued, 'queue-full');
    }

    return accepted ? { accepted: true, queued } : { accepted: false };
  };

  const enqueue = (
    payload: TOut,
    callbacks: Pick<QueuedPayload<TOut>, 'onDrop' | 'onWriteFailed'> = {}
  ): { accepted: boolean; queued?: QueuedPayload<TOut> } =>
    enqueueQueued({ payload, ...callbacks });

  const send = (payload: TOut): boolean => enqueue(payload).accepted;

  const flushQueue = (): void => {
    if (!queue) return;
    const pending = queue.drain();
    metrics.queueSize = 0;
    for (let index = 0; index < pending.length; index += 1) {
      const queued = pending[index] as QueuedPayload<TOut>;
      // An earlier send can synchronously close, settle later requests, and
      // even open a replacement before returning to this drained loop.
      if (queued.isActive?.() === false) continue;
      const socket = ws;
      const gen = generation;
      if (status === 'open' && writeToSocket(queued.payload)) continue;

      const sameOpenTransport =
        !destroyed &&
        generation === gen &&
        ws === socket &&
        socket !== null &&
        status === 'open' &&
        socket.readyState === socket.OPEN;
      if (sameOpenTransport) {
        queued.onWriteFailed?.();
        continue;
      }

      // A send event can reenter the lifecycle. Requeue this item and every
      // unvisited item, surfacing any reject/drop-newest overflow explicitly.
      for (const remaining of pending.slice(index)) {
        // A synchronous close rejects pending requests while this drained
        // array is outside SendQueue. Do not resurrect their stale wrappers.
        if (remaining.isActive?.() === false) continue;
        const result = queue.push(remaining);
        if (!result.accepted && result.dropped === undefined) {
          dropQueued(remaining, 'queue-full');
        } else if (result.dropped !== undefined) {
          dropQueued(result.dropped, 'queue-full');
        }
      }
      metrics.queueSize = queue.size;
      return;
    }
  };

  const replaySubscriptions = (isCurrent: () => boolean = () => true): void => {
    for (const { spec } of subscriptions.values()) {
      if (!isCurrent()) return;
      try {
        const payload = resolveMaybeFactory(spec.subscribe);
        if (!isCurrent()) return;
        writeToSocket(payload);
      } catch (error) {
        report(error, 'encode');
      }
      if (!isCurrent()) return;
    }
  };

  // ---------------------------------------------------------------------------
  // connection lifecycle
  // ---------------------------------------------------------------------------

  const detachTransport = (socket: WebSocketTransport): void => {
    const binding = transportBinding;
    if (binding?.socket !== socket) return;
    binding.cleanup();
    // A user-supplied EventTarget may reenter from removeEventListener() and
    // install a replacement binding while the old cleanup is still running.
    if (transportBinding === binding) transportBinding = null;
  };

  const closeTransport = (socket: WebSocketTransport): void => {
    detachTransport(socket);
    try {
      socket.close();
    } catch {
      // Closing an already-dead socket is not interesting.
    }
  };

  const abandonSocket = (): void => {
    generation += 1;
    const abandoned = ws;
    ws = null;
    if (abandoned) closeTransport(abandoned);
  };

  const rejectPendingRequests = (error: unknown): void => {
    for (const request of [...pendingRequests]) {
      pendingRequests.delete(request);
      request.dispose();
      request.reject(error);
    }
  };

  const noteDown = (): void => {
    const closedAt = now();
    metrics.lastClosedAt = closedAt;
    if (metrics.connections > 0 && outageStartedAt === undefined) {
      outageStartedAt = closedAt;
    }
    stopHeartbeat();
    clearStaleTimer();
    clearConnectTimer();
    clearErrorRetryTimer();
  };

  const settleWithoutReconnect = (
    context: ReconnectContext,
    exhausted: boolean,
    expectedGeneration: number
  ): void => {
    if (expectedGeneration !== generation) return;
    if (destroyed) return;
    if (pauseReasons.size > 0) {
      setStatus('paused');
      return;
    }
    if (!exhausted) {
      setStatus('closed');
      return;
    }

    gaveUpAttempts = attempt;
    setStatus('gave-up');
    if (expectedGeneration !== generation || status !== 'gave-up') return;

    rejectPendingRequests(new GaveUpError(gaveUpAttempts));
    if (expectedGeneration !== generation || status !== 'gave-up') return;

    emit({
      type: 'gave-up',
      attempts: gaveUpAttempts,
      lastCode: context.code
    });
  };

  /** Resolve policy once, scoped to the connection generation that asked. */
  const scheduleReconnect = (
    context: ReconnectContext,
    onDecision: (willReconnect: boolean) => void = () => {}
  ): void => {
    const decisionGeneration = generation;
    let decisionNotified = false;
    let cancelDecision = (): void => {};
    const notifyDecision = (willReconnect: boolean): boolean => {
      if (decisionNotified) return decisionGeneration === generation;
      decisionNotified = true;
      pendingReconnectDecisions.delete(cancelDecision);
      onDecision(willReconnect);
      return decisionGeneration === generation;
    };
    cancelDecision = () => {
      notifyDecision(false);
    };
    // Register before user policy/backoff code can run reentrantly. Any
    // lifecycle action that starts a newer generation settles this decision
    // `false` exactly once before the user callback returns.
    pendingReconnectDecisions.add(cancelDecision);

    if (
      destroyed ||
      intentionallyClosed ||
      pauseReasons.size > 0 ||
      !reconnectOptions
    ) {
      if (notifyDecision(false))
        settleWithoutReconnect(context, false, decisionGeneration);
      return;
    }

    // `retryOnError: false` and non-retryable close codes are hard bounds, so
    // `shouldReconnect` narrows the built-in policy instead of replacing it.
    if (
      (context.cause === 'error' && !retryOnError) ||
      (context.code !== undefined && !isRetryableClose(context.code))
    ) {
      if (notifyDecision(false))
        settleWithoutReconnect(context, false, decisionGeneration);
      return;
    }

    const nextAttempt = attempt + 1;
    if (nextAttempt > maxAttempts) {
      if (notifyDecision(false))
        settleWithoutReconnect(context, true, decisionGeneration);
      return;
    }

    const decision: ReconnectContext = {
      ...context,
      attempt: nextAttempt
    };

    const proceed = (allowed: boolean): void => {
      if (
        destroyed ||
        intentionallyClosed ||
        pauseReasons.size > 0 ||
        decisionGeneration !== generation
      ) {
        return;
      }

      if (!allowed) {
        if (notifyDecision(false))
          settleWithoutReconnect(context, false, decisionGeneration);
        return;
      }

      let delayMs: number;
      try {
        delayMs =
          context.code !== undefined && isBackpressureClose(context.code)
            ? backpressureDelayMs
            : backoff(nextAttempt);
      } catch (error) {
        report(error, 'listener');
        if (decisionGeneration !== generation) return;
        if (notifyDecision(false))
          settleWithoutReconnect(context, false, decisionGeneration);
        return;
      }

      if (
        !notifyDecision(true) ||
        destroyed ||
        intentionallyClosed ||
        pauseReasons.size > 0 ||
        decisionGeneration !== generation
      ) {
        return;
      }

      attempt = nextAttempt;
      metrics.currentAttempt = attempt;
      setStatus('reconnecting');
      if (decisionGeneration !== generation || status !== 'reconnecting')
        return;

      emit({
        type: 'reconnect-scheduled',
        attempt,
        delayMs,
        cause: context.cause
      });
      if (decisionGeneration !== generation || status !== 'reconnecting')
        return;

      clearReconnectTimer();
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        if (decisionGeneration !== generation) return;
        openSocket();
      }, delayMs);
    };

    let allowed: boolean | Promise<boolean> = true;
    if (reconnectOptions.shouldReconnect) {
      try {
        allowed = reconnectOptions.shouldReconnect(decision);
      } catch (error) {
        report(error, 'listener');
        allowed = false;
      }
    }

    if (isPromiseLike(allowed)) {
      // The socket is already down while an async policy is deciding.
      setStatus('reconnecting');
      if (decisionGeneration !== generation || status !== 'reconnecting')
        return;
      Promise.resolve(allowed).then(proceed, (error) => {
        if (decisionGeneration !== generation || destroyed) return;
        report(error, 'listener');
        proceed(false);
      });
    } else {
      proceed(allowed);
    }
  };

  const handleClose = (
    event: { code: number; reason: string; wasClean: boolean },
    gen: number,
    socket: WebSocketTransport
  ): void => {
    if (destroyed || gen !== generation || ws !== socket) return;
    const category = classifyCloseCode(event.code);

    runCloseCleanup(() => detachTransport(socket));
    if (destroyed || gen !== generation || ws !== socket) return;
    ws = null;
    generation += 1;
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

    const notifyClose = (willReconnect: boolean): void => {
      emit({
        type: 'close',
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
        category,
        willReconnect
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
    };

    rejectPendingRequests(new ConnectionClosedError(event.code, category));
    const closeGeneration = generation;
    scheduleReconnect(context, notifyClose);
    if (closeGeneration !== generation) return;
  };

  const handleOpen = (
    url: string,
    gen: number,
    socket: WebSocketTransport
  ): void => {
    const isCurrentOpen = (): boolean =>
      !destroyed && gen === generation && ws === socket;
    if (!isCurrentOpen()) return;

    clearConnectTimer();
    openedThisAttempt = true;

    const succeededOnAttempt = attempt;
    const reconnected = metrics.connections > 0;
    const openedAt = now();
    const downtimeMs =
      reconnected && outageStartedAt !== undefined
        ? Math.max(0, openedAt - outageStartedAt)
        : 0;

    metrics.connections += 1;
    if (reconnected) metrics.reconnects += 1;
    metrics.totalDowntimeMs += downtimeMs;
    metrics.lastOpenedAt = openedAt;
    metrics.currentAttempt = 0;
    outageStartedAt = undefined;
    attempt = 0;

    setStatus('open');
    if (!isCurrentOpen() || status !== 'open') return;

    const openSend = (payload: TOut): boolean =>
      isCurrentOpen() && writeToSocket(payload);

    emit({
      type: 'open',
      url,
      attempt: succeededOnAttempt,
      reconnected,
      downtimeMs,
      send: openSend
    });
    if (!isCurrentOpen() || status !== 'open') return;

    try {
      options.onOpen?.({
        url,
        attempt: succeededOnAttempt,
        reconnected,
        send: openSend
      });
    } catch (error) {
      report(error, 'listener');
    }
    if (!isCurrentOpen() || status !== 'open') return;

    // Order matters: caller's `onOpen` (auth) -> restored subscriptions ->
    // messages the app queued while down.
    replaySubscriptions(() => isCurrentOpen() && status === 'open');
    if (!isCurrentOpen() || status !== 'open') return;
    flushQueue();
    if (!isCurrentOpen() || status !== 'open') return;
    startHeartbeat(gen);
    if (!isCurrentOpen() || status !== 'open') return;
    armStaleTimer(gen);
  };

  const handleErrorEvent = (
    event: unknown,
    gen: number,
    socket: WebSocketTransport
  ): void => {
    if (!isCurrentGeneration(gen) || ws !== socket) return;
    const error = new SocketErrorEvent(event);
    report(error, 'socket');
    if (!isCurrentGeneration(gen) || ws !== socket) return;

    if (errorRetryTimer !== undefined) return;

    // Give `close` a brief chance to own recovery. If none arrives, abandon the
    // errored transport and let the central policy either retry or settle it.
    errorRetryTimer = setTimeout(() => {
      errorRetryTimer = undefined;
      if (!isCurrentGeneration(gen) || intentionallyClosed || ws !== socket)
        return;

      const failedBeforeOpen = !openedThisAttempt;
      const recoveryGeneration = generation;
      abandonSocket();
      if (destroyed || generation !== recoveryGeneration + 1) return;
      if (failedBeforeOpen) metrics.failedAttempts += 1;
      noteDown();
      if (destroyed || generation !== recoveryGeneration + 1) return;
      rejectPendingRequests(new ConnectionClosedError());
      if (destroyed || generation !== recoveryGeneration + 1) return;
      scheduleReconnect({ attempt, cause: 'error', error });
    }, 50);
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
    if (destroyed || gen !== generation) return;

    let socket: WebSocketTransport;
    try {
      socket = socketFactory(url, protocols) as WebSocketTransport;
    } catch (error) {
      if (destroyed || gen !== generation) return;
      report(error, 'connect');
      if (destroyed || gen !== generation) return;
      scheduleReconnect({ attempt, cause: 'error', error });
      return;
    }

    if (destroyed || gen !== generation) {
      closeTransport(socket);
      return;
    }

    ws = socket;
    if (binaryType) {
      socket.binaryType = binaryType;
      if (destroyed || gen !== generation || ws !== socket) {
        closeTransport(socket);
        return;
      }
    }

    const isCurrentTransport = (): boolean =>
      !destroyed && gen === generation && ws === socket;
    const onOpen = (): void => {
      if (!isCurrentTransport()) return;
      handleOpen(url as string, gen, socket);
    };
    const onMessage = (event: unknown): void => {
      if (!isCurrentTransport()) return;
      handleRaw((event as { data: RawData }).data, gen);
    };
    const onError = (event: unknown): void => {
      if (!isCurrentTransport()) return;
      handleErrorEvent(event, gen, socket);
    };
    const onClose = (event: unknown): void => {
      if (!isCurrentTransport()) return;
      const close = event as {
        code?: number;
        reason?: string;
        wasClean?: boolean;
      };
      handleClose(
        {
          code: close.code ?? 1006,
          reason: close.reason ?? '',
          wasClean: close.wasClean ?? false
        },
        gen,
        socket
      );
    };

    const cleanup = (): void => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
    };
    socket.addEventListener('open', onOpen);
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);

    if (!isCurrentTransport()) {
      cleanup();
      try {
        socket.close();
      } catch {
        // The superseding lifecycle already owns the observable state.
      }
      return;
    }
    transportBinding = { socket, cleanup };

    if (connectTimeoutMs > 0) {
      clearConnectTimer();
      connectTimer = setTimeout(() => {
        connectTimer = undefined;
        if (gen !== generation || status === 'open' || destroyed) return;

        emit({ type: 'connect-timeout', timeoutMs: connectTimeoutMs });
        if (!isCurrentTransport()) return;
        const timeoutGeneration = generation;
        abandonSocket();
        if (destroyed || generation !== timeoutGeneration + 1) return;
        metrics.failedAttempts += 1;
        noteDown();
        if (destroyed || generation !== timeoutGeneration + 1) return;
        scheduleReconnect({ attempt, cause: 'connect-timeout' });
      }, connectTimeoutMs);
    }
  };

  const openSocket = (): void => {
    if (destroyed || pauseReasons.size > 0) return;

    // Claim the next lifecycle frame before cancelling older decisions: their
    // close callbacks may reenter, and must see this attempt already owns it.
    const gen = ++generation;
    cancelPendingReconnectDecisions();
    if (destroyed || gen !== generation || pauseReasons.size > 0) return;
    clearReconnectTimer();
    openedThisAttempt = false;

    setStatus(attempt > 0 ? 'reconnecting' : 'connecting');
    if (destroyed || gen !== generation || pauseReasons.size > 0) return;

    const { url, protocols } = options;

    // Fast path: a literal URL connects synchronously, so `createSocket()`
    // returns with a live socket. Only resolvers defer to a microtask — and
    // deferring unconditionally would make every consumer, and every test,
    // await a tick for no reason.
    if (typeof url !== 'function' && typeof protocols !== 'function') {
      beginConnection(gen, url, protocols);
      return;
    }

    let unresolvedUrl:
      | string
      | null
      | undefined
      | Promise<string | null | undefined>;
    let unresolvedProtocols: ProtocolsInput | Promise<ProtocolsInput>;
    try {
      unresolvedUrl = typeof url === 'function' ? url() : url;
      if (!isCurrentGeneration(gen)) return;
      unresolvedProtocols =
        typeof protocols === 'function' ? protocols() : protocols;
      if (!isCurrentGeneration(gen)) return;
    } catch (error) {
      if (!isCurrentGeneration(gen)) return;
      report(error, 'url-resolution');
      if (!isCurrentGeneration(gen)) return;
      scheduleReconnect({ attempt, cause: 'error', error });
      return;
    }

    Promise.all([unresolvedUrl, unresolvedProtocols]).then(
      ([resolvedUrl, resolvedProtocols]) =>
        beginConnection(gen, resolvedUrl, resolvedProtocols),
      (error) => {
        if (!isCurrentGeneration(gen)) return;
        report(error, 'url-resolution');
        if (!isCurrentGeneration(gen)) return;
        scheduleReconnect({ attempt, cause: 'error', error });
      }
    );
  };

  const forceReconnect = (cause: ReconnectCause): void => {
    // After `close()`, a liveness timer must not abandon the socket the close
    // handshake still owns — that would drop its `close` event and strand the
    // status at 'closing'.
    if (destroyed || intentionallyClosed) return;

    const forceGeneration = generation;
    abandonSocket();
    if (destroyed || generation !== forceGeneration + 1) return;
    noteDown();
    if (destroyed || generation !== forceGeneration + 1) return;
    rejectPendingRequests(new ConnectionClosedError());
    if (destroyed || generation !== forceGeneration + 1) return;
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

    const pauseGeneration = ++generation;
    clearReconnectTimer();
    const abandoned = ws;
    ws = null;
    if (abandoned) closeTransport(abandoned);
    if (destroyed || !pauseReasons.has(reason)) return;
    if (generation !== pauseGeneration) {
      // A nested reconnect cannot open while this reason is held, but it can
      // advance the generation. Commit the still-current paused truth without
      // touching timers that a nested resume may create from the notification.
      setStatus('paused');
      return;
    }
    noteDown();
    rejectPendingRequests(new ConnectionClosedError());
    setStatus('paused');
    if (destroyed || !pauseReasons.has(reason)) return;

    cancelPendingReconnectDecisions();
    if (destroyed || !pauseReasons.has(reason)) return;
    // A nested reconnect cannot open while the pause reason is held, but it may
    // have changed status through callbacks. Reassert the committed truth.
    setStatus('paused');
    emit({ type: 'paused', reason });
    if (destroyed || !pauseReasons.has(reason)) return;
    if (generation !== pauseGeneration) setStatus('paused');
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

    const resumeGeneration = ++generation;
    emit({ type: 'resumed', reason });
    if (destroyed || resumeGeneration !== generation || pauseReasons.size > 0)
      return;
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
      let settled = false;
      let queuedPayload: QueuedPayload<TOut> | undefined;

      const cancelQueuedPayload = (): void => {
        if (!queuedPayload || !queue) return;
        if (queue.remove(queuedPayload)) metrics.queueSize = queue.size;
        queuedPayload = undefined;
      };

      const entry: PendingRequest<TIn> = {
        match,
        resolve: (message) => {
          if (settled) return;
          settled = true;
          resolve(message as unknown as TResponse);
        },
        reject: (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        },
        dispose: () => {
          cancelQueuedPayload();
          for (const undo of cleanup) undo();
          cleanup.length = 0;
        }
      };

      const fail = (error: unknown): void => {
        if (settled) return;
        pendingRequests.delete(entry);
        entry.dispose();
        entry.reject(error);
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

      const requestPayload: QueuedPayload<TOut> = {
        payload,
        isActive: () => !settled,
        onDrop: (reason) =>
          fail(new SendFailedError(`payload was dropped (${reason})`)),
        onWriteFailed: () =>
          fail(new SendFailedError('payload could not be written'))
      };
      // Assign before enqueueing because queue events are synchronous and may
      // abort/close reentrantly from an observer.
      queuedPayload = requestPayload;
      const outcome = enqueueQueued(requestPayload);
      if (!outcome.queued) queuedPayload = undefined;

      if (!outcome.accepted) {
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
      if ((status === 'open' && ws !== null) || status === 'connecting') return;
      if (pauseReasons.size > 0) return;
      openSocket();
    },

    close(code, reason) {
      if (destroyed) return;
      intentionallyClosed = true;
      if (status === 'closing' || closeCleanupDepth > 0) return;
      const closingGeneration = ++generation;
      clearReconnectTimer();
      clearErrorRetryTimer();
      cancelPendingReconnectDecisions();
      if (destroyed || closingGeneration !== generation) return;
      rejectPendingRequests(new ConnectionClosedError(code));
      if (destroyed || closingGeneration !== generation) return;

      if (ws) {
        const closingSocket = ws;
        setStatus('closing');
        if (
          destroyed ||
          closingGeneration !== generation ||
          ws !== closingSocket
        )
          return;
        stopHeartbeat();
        clearStaleTimer();
        clearConnectTimer();

        // Invalidate message/decode work immediately, but retain one close
        // handler so callers still receive the actual close context.
        runCloseCleanup(() => detachTransport(closingSocket));
        if (
          destroyed ||
          closingGeneration !== generation ||
          ws !== closingSocket
        )
          return;
        let closeBinding: TransportBinding;
        const onClose = (event: unknown): void => {
          if (
            destroyed ||
            closingGeneration !== generation ||
            ws !== closingSocket
          )
            return;
          const close = event as {
            code?: number;
            reason?: string;
            wasClean?: boolean;
          };
          runCloseCleanup(() =>
            closingSocket.removeEventListener('close', onClose)
          );
          if (transportBinding === closeBinding) transportBinding = null;
          if (
            destroyed ||
            closingGeneration !== generation ||
            ws !== closingSocket
          )
            return;
          handleClose(
            {
              code: close.code ?? 1000,
              reason: close.reason ?? '',
              wasClean: close.wasClean ?? true
            },
            closingGeneration,
            closingSocket
          );
        };
        closeBinding = {
          socket: closingSocket,
          cleanup: () =>
            runCloseCleanup(() =>
              closingSocket.removeEventListener('close', onClose)
            )
        };
        closingSocket.addEventListener('close', onClose);
        if (
          destroyed ||
          closingGeneration !== generation ||
          ws !== closingSocket
        ) {
          closeBinding.cleanup();
          return;
        }
        transportBinding = closeBinding;
        try {
          closingSocket.close(code, reason);
        } catch {
          detachTransport(closingSocket);
          if (closingGeneration !== generation || ws !== closingSocket) return;
          ws = null;
          generation += 1;
          noteDown();
          setStatus('closed');
        }
      } else {
        noteDown();
        if (destroyed || closingGeneration !== generation) return;
        setStatus('closed');
      }
    },

    reconnect() {
      if (destroyed) return;
      intentionallyClosed = false;
      attempt = 0;
      metrics.currentAttempt = 0;
      const reconnectGeneration = generation;
      abandonSocket();
      if (destroyed || generation !== reconnectGeneration + 1) return;
      noteDown();
      if (destroyed || generation !== reconnectGeneration + 1) return;
      rejectPendingRequests(new ConnectionClosedError());
      if (destroyed || generation !== reconnectGeneration + 1) return;
      clearReconnectTimer();
      if (destroyed || generation !== reconnectGeneration + 1) return;
      openSocket();
    },

    pause: () => pause('manual'),
    resume: () => resume('manual'),

    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation += 1;

      clearReconnectTimer();
      cancelPendingReconnectDecisions();
      const abandoned = ws;
      ws = null;
      if (abandoned) closeTransport(abandoned);
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
      const socket = ws;
      if (
        destroyed ||
        !socket ||
        status !== 'open' ||
        socket.readyState !== socket.OPEN
      )
        return false;
      try {
        socket.send(data);
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
      const registration: SubscriptionRegistration<TOut> = { spec };
      subscriptions.set(key, registration);

      if (status === 'open') {
        try {
          writeToSocket(resolveMaybeFactory(spec.subscribe));
        } catch (error) {
          report(error, 'encode');
        }
      }

      return () => {
        if (subscriptions.get(key) !== registration) return;
        subscriptions.delete(key);
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
