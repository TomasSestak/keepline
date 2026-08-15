import type { ReconnectContext } from './types';

/**
 * Reconnection delay strategies.
 *
 * `attempt` is 1-based: the first retry after a drop is attempt 1.
 *
 * `context` describes the failure being retried. It is what lets a strategy
 * charge a refused handshake a different delay from a dropped session — see
 * {@link ReconnectContext.wasOpen} — a distinction no close code carries. It is
 * optional in the signature so every existing one-argument strategy stays
 * assignable; keepline always passes it.
 */
export type BackoffStrategy = (
  attempt: number,
  context?: ReconnectContext
) => number;

export type JitterMode =
  /** No randomness. Every client in a fleet retries in lockstep. */
  | 'none'
  /** `random() * delay` — maximum spread, minimum predictability. */
  | 'full'
  /** `delay/2 + random() * delay/2` — spread without collapsing the curve. */
  | 'equal';

export interface ExponentialBackoffOptions {
  /** Delay before the first retry. Default 500ms. */
  initialDelayMs?: number;
  /** Ceiling for the computed delay. Default 15_000ms. */
  maxDelayMs?: number;
  /** Growth factor per attempt. Default 2. */
  factor?: number;
  /** Jitter mode. Default `'equal'`. */
  jitter?: JitterMode;
  /** Randomness source. Injectable so tests can be deterministic. */
  random?: () => number;
}

const applyJitter = (
  delay: number,
  jitter: JitterMode,
  random: () => number
): number => {
  switch (jitter) {
    case 'full':
      return random() * delay;
    case 'equal':
      return delay / 2 + random() * (delay / 2);
    default:
      return delay;
  }
};

/**
 * Truncated exponential backoff with jitter — the default, and what you almost
 * certainly want.
 *
 * Jitter is on by default because a server restart drops every client at the
 * same instant, and an un-jittered fleet then retries at the same instant,
 * repeatedly, until something gives. This is the thundering-herd failure that
 * turns a 2-second restart into a 5-minute outage.
 */
export const exponentialBackoff = ({
  initialDelayMs = 500,
  maxDelayMs = 15_000,
  factor = 2,
  jitter = 'equal',
  random = Math.random
}: ExponentialBackoffOptions = {}): BackoffStrategy => {
  return (attempt) => {
    const raw = initialDelayMs * factor ** Math.max(0, attempt - 1);
    return Math.round(applyJitter(Math.min(raw, maxDelayMs), jitter, random));
  };
};

export interface LinearBackoffOptions {
  /** Added per attempt. Default 500ms. */
  stepMs?: number;
  maxDelayMs?: number;
  jitter?: JitterMode;
  random?: () => number;
}

/** `attempt * stepMs`, capped. Gentler than exponential for short outages. */
export const linearBackoff = ({
  stepMs = 500,
  maxDelayMs = 15_000,
  jitter = 'equal',
  random = Math.random
}: LinearBackoffOptions = {}): BackoffStrategy => {
  return (attempt) =>
    Math.round(
      applyJitter(Math.min(attempt * stepMs, maxDelayMs), jitter, random)
    );
};

/** Fixed delay. Simple, and a thundering-herd generator without jitter. */
export const constantBackoff = (
  delayMs = 1_000,
  {
    jitter = 'none',
    random = Math.random
  }: Omit<
    ExponentialBackoffOptions,
    'initialDelayMs' | 'maxDelayMs' | 'factor'
  > = {}
): BackoffStrategy => {
  return () => Math.round(applyJitter(delayMs, jitter, random));
};
