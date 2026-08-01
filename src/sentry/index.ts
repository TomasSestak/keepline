import { formatIssues } from '../core/standard-schema';
import type { KeeplineEvent } from '../core/types';

/**
 * The slice of a Sentry SDK this adapter uses.
 *
 * Structural rather than imported, so there is no dependency on `@sentry/*` and
 * no version coupling: `@sentry/browser`, `@sentry/react`, `@sentry/node` and
 * every wrapper around them satisfy this shape.
 */
export interface SentryLike {
  addBreadcrumb: (breadcrumb: {
    type?: string;
    category?: string;
    message?: string;
    level?: 'debug' | 'info' | 'warning' | 'error' | 'fatal';
    data?: Record<string, unknown>;
  }) => void;
  captureException: (
    error: unknown,
    hint?: { extra?: Record<string, unknown>; tags?: Record<string, string> }
  ) => unknown;
}

export interface SentryReporterOptions {
  sentry: SentryLike;
  /** Breadcrumb category. Default `'websocket'`. */
  category?: string;
  /**
   * Decide which events become captured exceptions rather than breadcrumbs.
   *
   * The default captures only what a human should look at: exhausted retries,
   * and errors thrown by your own encode/listener code. Ordinary disconnects and
   * reconnects stay breadcrumbs — a socket that drops on a train is not an
   * incident, and treating it as one trains everyone to ignore the alerts.
   */
  shouldCapture?: (event: KeeplineEvent) => boolean;
  /**
   * Sanitise URLs before they are recorded. Default strips the query string and
   * any userinfo, because auth tokens live there and breadcrumbs are forever.
   */
  redactUrl?: (url: string) => string;
  /**
   * Include message payloads in breadcrumbs. Default false — payloads are
   * user data, and this is the switch that keeps it out of your error tracker
   * by default rather than by review.
   */
  includePayloads?: boolean;
  /** Extra tags on captured exceptions, e.g. `{ feed: 'ticks' }`. */
  tags?: Record<string, string>;
}

const defaultRedactUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url.split('?')[0] ?? url;
  }
};

const defaultShouldCapture = (event: KeeplineEvent): boolean => {
  if (event.type === 'gave-up') return true;
  if (event.type === 'error')
    return event.phase === 'listener' || event.phase === 'encode';
  return false;
};

/**
 * Turn a socket's event stream into Sentry breadcrumbs and exceptions.
 *
 * ```ts
 * import * as Sentry from '@sentry/react';
 * import { createSentryReporter } from 'keepline/sentry';
 *
 * createSocket({
 *   url,
 *   onEvent: createSentryReporter({ sentry: Sentry, tags: { feed: 'ticks' } })
 * });
 * ```
 *
 * The point is the breadcrumb trail: when an unrelated exception is reported
 * ten seconds after the feed silently dropped and retried four times, the trail
 * is the difference between a five-minute diagnosis and an unreproducible
 * ticket.
 */
export const createSentryReporter = ({
  sentry,
  category = 'websocket',
  shouldCapture = defaultShouldCapture,
  redactUrl = defaultRedactUrl,
  includePayloads = false,
  tags
}: SentryReporterOptions): ((event: KeeplineEvent) => void) => {
  const describe = (
    event: KeeplineEvent
  ): {
    message: string;
    level: 'debug' | 'info' | 'warning' | 'error';
    data?: Record<string, unknown>;
  } => {
    switch (event.type) {
      case 'opening':
        return {
          message: `connecting (attempt ${event.attempt})`,
          level: 'debug',
          data: { url: redactUrl(event.url), attempt: event.attempt }
        };
      case 'open':
        return {
          message: event.reconnected
            ? `reconnected after ${event.downtimeMs}ms down`
            : 'connected',
          level: 'info',
          data: {
            url: redactUrl(event.url),
            attempt: event.attempt,
            downtimeMs: event.downtimeMs
          }
        };
      case 'close':
        return {
          message: `closed ${event.code} (${event.category})${
            event.reason ? `: ${event.reason}` : ''
          }`,
          level: event.category === 'normal' ? 'info' : 'warning',
          data: {
            code: event.code,
            category: event.category,
            wasClean: event.wasClean
          }
        };
      case 'reconnect-scheduled':
        return {
          message: `retry ${event.attempt} in ${event.delayMs}ms (${event.cause})`,
          level: 'info',
          data: {
            attempt: event.attempt,
            delayMs: event.delayMs,
            cause: event.cause
          }
        };
      case 'gave-up':
        return {
          message: `gave up after ${event.attempts} attempts`,
          level: 'error',
          data: { attempts: event.attempts, lastCode: event.lastCode }
        };
      case 'stale':
        return {
          message: `no traffic for ${event.sinceMs}ms — forcing reconnect`,
          level: 'warning',
          data: { sinceMs: event.sinceMs }
        };
      case 'heartbeat-timeout':
        return {
          message: `heartbeat timed out after ${event.timeoutMs}ms`,
          level: 'warning',
          data: { timeoutMs: event.timeoutMs }
        };
      case 'connect-timeout':
        return {
          message: `handshake timed out after ${event.timeoutMs}ms`,
          level: 'warning',
          data: { timeoutMs: event.timeoutMs }
        };
      case 'decode-error':
        return { message: 'failed to decode message', level: 'warning' };
      case 'validation-error':
        return {
          message: `message failed validation: ${formatIssues(event.issues)}`,
          level: 'warning'
        };
      case 'dropped':
        return {
          message: `dropped an outbound message (${event.reason})`,
          level: 'warning',
          data: includePayloads ? { payload: event.payload } : undefined
        };
      case 'paused':
        return { message: `paused (${event.reason})`, level: 'debug' };
      case 'resumed':
        return { message: `resumed (${event.reason})`, level: 'debug' };
      case 'error':
        return {
          message: `error during ${event.phase}`,
          level: 'error',
          data: { phase: event.phase }
        };
      case 'status':
        return {
          message: `${event.previous} -> ${event.status}`,
          level: 'debug'
        };
      default:
        return { message: event.type, level: 'debug' };
    }
  };

  return (event) => {
    // Per-message noise would flood the breadcrumb buffer and push out the
    // events that actually explain a failure.
    if (event.type === 'message' || event.type === 'sent') return;

    const { message, level, data } = describe(event);
    sentry.addBreadcrumb({ type: 'default', category, message, level, data });

    if (!shouldCapture(event)) return;

    const error =
      event.type === 'error'
        ? event.error
        : new Error(`keepline: ${message}`, {
            cause: 'error' in event ? event.error : undefined
          });

    sentry.captureException(error, {
      tags: { 'keepline.event': event.type, ...tags },
      extra: data
    });
  };
};
