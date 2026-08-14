import { describe, expect, it, vi } from 'vitest';

import type { KeeplineEvent } from '../src/core/types';
import { createConsoleLogger } from '../src/logger/index';

const createSink = () => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn()
});

const rejectSend = () => false;

describe('createConsoleLogger', () => {
  it('summarises the complete event stream at the appropriate levels', () => {
    const sink = createSink();
    const logger = createConsoleLogger({
      level: 'debug',
      prefix: 'feed',
      sink,
      includeEvent: false
    });
    const events: KeeplineEvent[] = [
      { type: 'status', previous: 'idle', status: 'connecting', at: 1 },
      { type: 'opening', url: 'wss://example.test', attempt: 0, at: 2 },
      {
        type: 'open',
        url: 'wss://example.test',
        attempt: 0,
        reconnected: false,
        downtimeMs: 0,
        send: rejectSend,
        at: 3
      },
      {
        type: 'open',
        url: 'wss://example.test',
        attempt: 2,
        reconnected: true,
        downtimeMs: 250,
        send: rejectSend,
        at: 4
      },
      { type: 'message', message: { n: 1 }, at: 5 },
      { type: 'sent', payload: { n: 1 }, at: 6 },
      { type: 'queued', payload: { n: 2 }, queueSize: 1, at: 7 },
      {
        type: 'dropped',
        payload: { n: 3 },
        reason: 'queue-full',
        at: 8
      },
      {
        type: 'close',
        code: 1006,
        reason: 'offline',
        wasClean: false,
        category: 'abnormal',
        willReconnect: true,
        at: 9
      },
      { type: 'error', error: new Error('boom'), phase: 'listener', at: 10 },
      { type: 'decode-error', error: new Error('bad json'), data: '{', at: 11 },
      {
        type: 'validation-error',
        issues: [{ message: 'invalid value' }],
        value: null,
        at: 12
      },
      {
        type: 'reconnect-scheduled',
        attempt: 2,
        delayMs: 500,
        cause: 'close',
        at: 13
      },
      { type: 'gave-up', attempts: 3, lastCode: 1006, at: 14 },
      { type: 'stale', sinceMs: 1_000, at: 15 },
      { type: 'heartbeat', rttMs: 12, at: 16 },
      { type: 'heartbeat-timeout', timeoutMs: 2_000, at: 17 },
      { type: 'connect-timeout', timeoutMs: 3_000, at: 18 },
      { type: 'paused', reason: 'offline', at: 19 },
      { type: 'resumed', reason: 'online', at: 20 },
      { type: 'destroyed', at: 21 }
    ];

    for (const event of events) logger(event);

    const messages = [
      ...sink.debug.mock.calls,
      ...sink.info.mock.calls,
      ...sink.warn.mock.calls,
      ...sink.error.mock.calls
    ].map(([message]) => message);

    expect(messages).toEqual(
      expect.arrayContaining([
        '[feed] idle -> connecting',
        '[feed] connecting to wss://example.test (attempt 0)',
        '[feed] connected to wss://example.test',
        '[feed] reconnected after 250ms down',
        '[feed] queued outbound message (1 waiting)',
        '[feed] dropped outbound message (queue-full)',
        '[feed] closed 1006 abnormal "offline"',
        '[feed] error during listener',
        '[feed] failed to decode an inbound frame',
        '[feed] inbound message failed validation (1 issue(s))',
        '[feed] retry 2 in 500ms (close)',
        '[feed] gave up after 3 attempts',
        '[feed] no traffic for 1000ms',
        '[feed] pong in 12ms',
        '[feed] no pong within 2000ms',
        '[feed] handshake timed out after 3000ms',
        '[feed] paused (offline)',
        '[feed] resumed (online)',
        '[feed] destroyed'
      ])
    );
    expect(sink.warn).toHaveBeenCalled();
    expect(sink.error).toHaveBeenCalledTimes(2);
    expect(sink.info).toHaveBeenCalled();
    expect(sink.debug).toHaveBeenCalled();
    expect(
      [...sink.debug.mock.calls, ...sink.info.mock.calls].every(
        (call) => call.length === 1
      )
    ).toBe(true);
  });

  it('honours the threshold and includes the original event by default', () => {
    const sink = createSink();
    const logger = createConsoleLogger({ level: 'warn', sink });
    const status: KeeplineEvent = {
      type: 'status',
      previous: 'idle',
      status: 'connecting',
      at: 1
    };
    const open: KeeplineEvent = {
      type: 'open',
      url: 'wss://example.test',
      attempt: 0,
      reconnected: false,
      downtimeMs: 0,
      send: rejectSend,
      at: 2
    };
    const dropped: KeeplineEvent = {
      type: 'dropped',
      payload: 'message',
      reason: 'queue-disabled',
      at: 3
    };

    logger(status);
    logger(open);
    logger(dropped);

    expect(sink.debug).not.toHaveBeenCalled();
    expect(sink.info).not.toHaveBeenCalled();
    expect(sink.warn).toHaveBeenCalledWith(
      '[keepline] dropped outbound message (queue-disabled)',
      dropped
    );
  });

  it('does nothing at the silent level', () => {
    const sink = createSink();
    const logger = createConsoleLogger({ level: 'silent', sink });

    logger({ type: 'gave-up', attempts: 10, at: 1 });

    expect(sink.debug).not.toHaveBeenCalled();
    expect(sink.info).not.toHaveBeenCalled();
    expect(sink.warn).not.toHaveBeenCalled();
    expect(sink.error).not.toHaveBeenCalled();
  });
});
