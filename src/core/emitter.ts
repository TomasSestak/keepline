export type Listener<T> = (value: T) => void;

/**
 * Minimal fan-out with listener-error isolation.
 *
 * Isolation matters more than it looks: a throwing `onMessage` in one consumer
 * must not stop delivery to the others, and must never escape into the
 * WebSocket's own event handler, where nothing can catch it.
 */
export class Emitter<T> {
  private listeners = new Set<Listener<T>>();

  get size(): number {
    return this.listeners.size;
  }

  add(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(value: T, onListenerError?: (error: unknown) => void): void {
    if (this.listeners.size === 0) return;

    // Copy: a listener may unsubscribe (or subscribe) during emit.
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch (error) {
        onListenerError?.(error);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
