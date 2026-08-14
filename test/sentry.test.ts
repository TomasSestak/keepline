import { describe, expect, it, vi } from 'vitest';

import type { KeeplineEvent } from '../src/core/types';
import { createSentryReporter } from '../src/sentry/index';

const createSentry = () => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn()
});

const rejectSend = () => false;

describe('createSentryReporter', () => {
  it('redacts connection URLs, omits payloads, and suppresses frame noise', () => {
    const sentry = createSentry();
    const report = createSentryReporter({ sentry });

    report({
      type: 'opening',
      url: 'wss://alice:secret@example.test/feed?token=private',
      attempt: 0,
      at: 1
    });
    report({ type: 'message', message: { private: true }, at: 2 });
    report({ type: 'sent', payload: { private: true }, at: 3 });
    report({
      type: 'dropped',
      payload: { private: true },
      reason: 'queue-full',
      at: 4
    });

    expect(sentry.addBreadcrumb).toHaveBeenCalledTimes(2);
    expect(sentry.addBreadcrumb.mock.calls[0]?.[0]).toMatchObject({
      category: 'websocket',
      data: { url: 'wss://example.test/feed', attempt: 0 },
      level: 'debug'
    });
    expect(sentry.addBreadcrumb.mock.calls[1]?.[0]).toMatchObject({
      message: 'dropped an outbound message (queue-full)',
      level: 'warning'
    });
    expect(sentry.addBreadcrumb.mock.calls[1]?.[0].data).toBeUndefined();
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('describes every operational event as a useful breadcrumb', () => {
    const sentry = createSentry();
    const report = createSentryReporter({
      sentry,
      shouldCapture: () => false
    });
    const events: KeeplineEvent[] = [
      {
        type: 'open',
        url: 'wss://example.test',
        attempt: 0,
        reconnected: false,
        downtimeMs: 0,
        send: rejectSend,
        at: 1
      },
      {
        type: 'open',
        url: 'wss://example.test',
        attempt: 2,
        reconnected: true,
        downtimeMs: 400,
        send: rejectSend,
        at: 2
      },
      {
        type: 'close',
        code: 1000,
        reason: '',
        wasClean: true,
        category: 'normal',
        willReconnect: false,
        at: 3
      },
      {
        type: 'close',
        code: 1006,
        reason: 'offline',
        wasClean: false,
        category: 'abnormal',
        willReconnect: true,
        at: 4
      },
      {
        type: 'reconnect-scheduled',
        attempt: 2,
        delayMs: 500,
        cause: 'close',
        at: 5
      },
      { type: 'gave-up', attempts: 3, lastCode: 1006, at: 6 },
      { type: 'stale', sinceMs: 1_000, at: 7 },
      { type: 'heartbeat-timeout', timeoutMs: 2_000, at: 8 },
      { type: 'connect-timeout', timeoutMs: 3_000, at: 9 },
      { type: 'decode-error', error: new Error('decode'), data: '{', at: 10 },
      {
        type: 'validation-error',
        issues: [{ message: 'expected number' }],
        value: 'nope',
        at: 11
      },
      {
        type: 'dropped',
        payload: { n: 1 },
        reason: 'queue-disabled',
        at: 12
      },
      { type: 'paused', reason: 'hidden', at: 13 },
      { type: 'resumed', reason: 'visible', at: 14 },
      {
        type: 'error',
        error: new Error('listener'),
        phase: 'listener',
        at: 15
      },
      {
        type: 'status',
        previous: 'connecting',
        status: 'open',
        at: 16
      },
      { type: 'queued', payload: { n: 2 }, queueSize: 1, at: 17 },
      { type: 'heartbeat', rttMs: 9, at: 18 },
      { type: 'destroyed', at: 19 }
    ];

    for (const event of events) report(event);

    const messages = sentry.addBreadcrumb.mock.calls.map(
      ([breadcrumb]) => breadcrumb.message
    );
    expect(messages).toEqual(
      expect.arrayContaining([
        'connected',
        'reconnected after 400ms down',
        'closed 1000 (normal)',
        'closed 1006 (abnormal): offline',
        'retry 2 in 500ms (close)',
        'gave up after 3 attempts',
        'no traffic for 1000ms — forcing reconnect',
        'heartbeat timed out after 2000ms',
        'handshake timed out after 3000ms',
        'failed to decode message',
        'message failed validation: expected number',
        'dropped an outbound message (queue-disabled)',
        'paused (hidden)',
        'resumed (visible)',
        'error during listener',
        'connecting -> open',
        'queued',
        'heartbeat',
        'destroyed'
      ])
    );
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('captures only actionable failures by default and preserves errors', () => {
    const sentry = createSentry();
    const report = createSentryReporter({
      sentry,
      tags: { feed: 'prices' }
    });
    const listenerError = new Error('listener failed');
    const encodeError = new Error('encode failed');

    report({ type: 'gave-up', attempts: 4, lastCode: 1006, at: 1 });
    report({ type: 'error', error: listenerError, phase: 'listener', at: 2 });
    report({ type: 'error', error: encodeError, phase: 'encode', at: 3 });
    report({
      type: 'error',
      error: new Error('ordinary socket failure'),
      phase: 'socket',
      at: 4
    });

    expect(sentry.captureException).toHaveBeenCalledTimes(3);
    expect(sentry.captureException.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        message: 'keepline: gave up after 4 attempts'
      })
    );
    expect(sentry.captureException.mock.calls[1]?.[0]).toBe(listenerError);
    expect(sentry.captureException.mock.calls[2]?.[0]).toBe(encodeError);

    for (const [, hint] of sentry.captureException.mock.calls) {
      expect(hint?.tags).toMatchObject({ feed: 'prices' });
    }
    expect(sentry.captureException.mock.calls[0]?.[1]?.tags).toMatchObject({
      'keepline.event': 'gave-up'
    });
  });

  it('supports payload opt-in and custom capture, category, and URL policies', () => {
    const sentry = createSentry();
    const shouldCapture = vi.fn(
      (event: KeeplineEvent) => event.type === 'dropped'
    );
    const redactUrl = vi.fn((url: string) => `safe:${url.length}`);
    const report = createSentryReporter({
      sentry,
      category: 'price-feed',
      includePayloads: true,
      redactUrl,
      shouldCapture
    });
    const payload = { accountId: 42 };

    report({ type: 'opening', url: 'not-a-url?secret', attempt: 1, at: 1 });
    report({ type: 'dropped', payload, reason: 'queue-full', at: 2 });

    expect(redactUrl).toHaveBeenCalledWith('not-a-url?secret');
    expect(sentry.addBreadcrumb.mock.calls[0]?.[0]).toMatchObject({
      category: 'price-feed',
      data: { url: 'safe:16' }
    });
    expect(sentry.addBreadcrumb.mock.calls[1]?.[0]).toMatchObject({
      category: 'price-feed',
      data: { payload }
    });
    expect(shouldCapture).toHaveBeenCalledTimes(2);
    expect(sentry.captureException).toHaveBeenCalledOnce();
    expect(sentry.captureException.mock.calls[0]?.[1]?.extra).toEqual({
      payload
    });
  });

  it('falls back to stripping query strings from invalid URLs', () => {
    const sentry = createSentry();
    const report = createSentryReporter({ sentry });

    report({
      type: 'opening',
      url: 'relative/path?token=secret',
      attempt: 0,
      at: 1
    });

    expect(sentry.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ data: { url: 'relative/path', attempt: 0 } })
    );
  });
});
