import { describe, expect, it } from 'vitest';

import {
  constantBackoff,
  exponentialBackoff,
  linearBackoff
} from '../src/core/backoff';

describe('exponentialBackoff', () => {
  it('doubles from the initial delay and truncates at the ceiling', () => {
    const backoff = exponentialBackoff({
      initialDelayMs: 100,
      maxDelayMs: 800,
      jitter: 'none'
    });

    expect([1, 2, 3, 4, 5].map((attempt) => backoff(attempt))).toEqual([
      100, 200, 400, 800, 800
    ]);
  });

  it('spreads delays across the full range with full jitter', () => {
    const backoff = exponentialBackoff({
      initialDelayMs: 1000,
      jitter: 'full',
      random: () => 0.25
    });

    expect(backoff(1)).toBe(250);
  });

  it('keeps at least half the delay with equal jitter', () => {
    const backoff = exponentialBackoff({
      initialDelayMs: 1000,
      jitter: 'equal',
      random: () => 0
    });

    expect(backoff(1)).toBe(500);
  });
});

describe('linearBackoff', () => {
  it('reproduces a min(cap, attempt * step) curve', () => {
    // The shape hand-written in most codebases, kept as a named strategy so a
    // migration does not have to change reconnection timing at the same time as
    // everything else.
    const backoff = linearBackoff({
      stepMs: 200,
      maxDelayMs: 5000,
      jitter: 'none'
    });

    expect([1, 10, 25, 26].map((attempt) => backoff(attempt))).toEqual([
      200, 2000, 5000, 5000
    ]);
  });
});

describe('constantBackoff', () => {
  it('returns the same delay every time', () => {
    const backoff = constantBackoff(1234);
    expect([1, 2, 9].map((attempt) => backoff(attempt))).toEqual([
      1234, 1234, 1234
    ]);
  });
});
