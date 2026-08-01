import type { CloseCategory } from './close-codes';

export class KeeplineError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'KeeplineError';
  }
}

/** A `request()` received no matching reply in time. */
export class RequestTimeoutError extends KeeplineError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`No matching response within ${timeoutMs}ms`);
    this.name = 'RequestTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** The connection closed while a `request()` was awaiting its reply. */
export class ConnectionClosedError extends KeeplineError {
  readonly code?: number;
  readonly category?: CloseCategory;

  constructor(code?: number, category?: CloseCategory) {
    super(
      code === undefined
        ? 'Connection closed'
        : `Connection closed (${code}${category ? `, ${category}` : ''})`
    );
    this.name = 'ConnectionClosedError';
    this.code = code;
    this.category = category;
  }
}

/** The payload could not be handed to the socket, or was dropped by the queue. */
export class SendFailedError extends KeeplineError {
  constructor(reason: string) {
    super(`Send failed: ${reason}`);
    this.name = 'SendFailedError';
  }
}

/** The retry budget ran out while something was waiting on the connection. */
export class GaveUpError extends KeeplineError {
  readonly attempts: number;

  constructor(attempts: number) {
    super(`Gave up reconnecting after ${attempts} attempt(s)`);
    this.name = 'GaveUpError';
    this.attempts = attempts;
  }
}

/** Inbound message rejected by the configured schema. */
export class ValidationError extends KeeplineError {
  readonly issues: ReadonlyArray<{ message: string }>;

  constructor(summary: string, issues: ReadonlyArray<{ message: string }>) {
    super(`Message failed validation: ${summary}`);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

/**
 * `WebSocket`'s `error` event is a bare `Event` with no diagnostic content — by
 * design, so that pages cannot probe internal networks. Wrapping it keeps a
 * useful `name` and the original event for anyone who wants it.
 */
export class SocketErrorEvent extends KeeplineError {
  readonly event: unknown;

  constructor(event: unknown) {
    super('WebSocket error event (no detail available — check the close code)');
    this.name = 'SocketErrorEvent';
    this.event = event;
  }
}
