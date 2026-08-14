/** What to do when the outbound queue is full. */
export type OverflowPolicy =
  /** Discard the oldest queued item. Right for state snapshots. */
  | 'drop-oldest'
  /** Discard the item being added. Right for append-only logs. */
  | 'drop-newest'
  /** Refuse the send — `send()` returns false, caller decides. */
  | 'reject';

export interface QueueOptions {
  /** Maximum items held while the socket is not open. Default 64. */
  limit?: number;
  /** Default `'drop-oldest'`. */
  onOverflow?: OverflowPolicy;
}

export interface PushResult<T> {
  accepted: boolean;
  /** Item evicted to make room, if any. Surfaced as a `dropped` event. */
  dropped?: T;
}

/**
 * Bounded FIFO for messages produced while the socket is connecting or
 * reconnecting.
 *
 * The bound is the point. An unbounded queue on a socket that has been down for
 * ten minutes is a memory leak that then delivers ten minutes of stale messages
 * in one burst the moment it reconnects.
 */
export class SendQueue<T> {
  private items: T[] = [];
  private readonly limit: number;
  private readonly policy: OverflowPolicy;

  constructor({ limit = 64, onOverflow = 'drop-oldest' }: QueueOptions = {}) {
    this.limit = Math.max(0, limit);
    this.policy = onOverflow;
  }

  get size(): number {
    return this.items.length;
  }

  push(item: T): PushResult<T> {
    if (this.limit === 0) return { accepted: false, dropped: item };

    if (this.items.length < this.limit) {
      this.items.push(item);
      return { accepted: true };
    }

    switch (this.policy) {
      case 'drop-oldest': {
        const dropped = this.items.shift();
        this.items.push(item);
        return { accepted: true, dropped };
      }
      case 'drop-newest':
        return { accepted: false, dropped: item };
      default:
        return { accepted: false };
    }
  }

  /** Remove and return everything, in insertion order. */
  drain(): T[] {
    const items = this.items;
    this.items = [];
    return items;
  }

  clear(): T[] {
    return this.drain();
  }

  /** Remove one exact queued item without disturbing FIFO order. */
  remove(item: T): boolean {
    const index = this.items.findIndex((candidate) =>
      Object.is(candidate, item)
    );
    if (index === -1) return false;
    this.items.splice(index, 1);
    return true;
  }
}
