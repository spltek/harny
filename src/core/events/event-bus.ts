export interface EventBus<T> {
  subscribe(handler: (event: T) => void): () => void;
  emit(event: T): void;
}
