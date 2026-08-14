import { describe, expect, it } from 'vitest';

import { SendQueue } from '../src/core/send-queue';

describe('SendQueue', () => {
  it('drains in insertion order', () => {
    const queue = new SendQueue<number>({ limit: 4 });
    queue.push(1);
    queue.push(2);
    queue.push(3);

    expect(queue.size).toBe(3);
    expect(queue.drain()).toEqual([1, 2, 3]);
    expect(queue.size).toBe(0);
  });

  it('evicts the oldest item by default', () => {
    const queue = new SendQueue<number>({ limit: 2 });
    queue.push(1);
    queue.push(2);

    const result = queue.push(3);

    expect(result).toEqual({ accepted: true, dropped: 1 });
    expect(queue.drain()).toEqual([2, 3]);
  });

  it('rejects the incoming item with drop-newest', () => {
    const queue = new SendQueue<number>({
      limit: 1,
      onOverflow: 'drop-newest'
    });
    queue.push(1);

    expect(queue.push(2)).toEqual({ accepted: false, dropped: 2 });
    expect(queue.drain()).toEqual([1]);
  });

  it('reports failure without dropping anything with reject', () => {
    const queue = new SendQueue<number>({ limit: 1, onOverflow: 'reject' });
    queue.push(1);

    expect(queue.push(2)).toEqual({ accepted: false });
    expect(queue.drain()).toEqual([1]);
  });

  it('accepts nothing at limit 0', () => {
    const queue = new SendQueue<number>({ limit: 0 });
    expect(queue.push(1).accepted).toBe(false);
    expect(queue.size).toBe(0);
  });

  it('removes one exact item without reordering the rest', () => {
    const queue = new SendQueue<number>({ limit: 4 });
    queue.push(1);
    queue.push(2);
    queue.push(3);

    expect(queue.remove(2)).toBe(true);
    expect(queue.remove(2)).toBe(false);
    expect(queue.drain()).toEqual([1, 3]);
  });
});
