export type Listener<T> = (value: T) => void;

/** Minimal typed event emitter. */
export class Emitter<T> {
  private listeners = new Set<Listener<T>>();

  on(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(value: T): void {
    for (const l of [...this.listeners]) {
      try {
        l(value);
      } catch (err) {
        // Listener errors must never break the emitter's caller.
        console.error('[emitter] listener failed', err);
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }

  clear(): void {
    this.listeners.clear();
  }
}
