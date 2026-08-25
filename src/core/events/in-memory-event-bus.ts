import type { EventBus } from "./event-bus";

export class InMemoryEventBus<T> implements EventBus<T> {
  private handlers = new Set<(event: T) => void>();

  subscribe(handler: (event: T) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(event: T): void {
    for (const handler of [...this.handlers]) {
      try {
        handler(event);
      } catch {
        // A faulty subscriber must not break the bus.
      }
    }
  }
}
