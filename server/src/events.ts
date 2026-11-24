export type EventListener<Payload> = (payload: Payload) => void;

export class TypedEventEmitter<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<EventListener<unknown>>>();

  public on<K extends keyof Events>(event: K, listener: EventListener<Events[K]>): () => void {
    let bucket = this.listeners.get(event);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(event, bucket);
    }
    const wrapped: EventListener<unknown> = (payload: unknown) => {
      // Safe narrowing: emit<K> enforces that payload matches Events[K]
      listener(payload as Events[K]);
    };
    bucket.add(wrapped);
    return () => {
      bucket?.delete(wrapped);
    };
  }

  public emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const bucket = this.listeners.get(event);
    if (!bucket) return;
    for (const listener of bucket) {
      listener(payload);
    }
  }

  public clearListeners(): void {
    this.listeners.clear();
  }
}
