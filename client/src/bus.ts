export type BusListener<Payload> = (payload: Payload) => void;

export class Bus<E extends Record<string, unknown>> {
  private readonly handlers = new Map<keyof E, Set<BusListener<unknown>>>();

  public on<K extends keyof E>(name: K, fn: BusListener<E[K]>): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    const wrapper: BusListener<unknown> = (payload: unknown) => {
      // Safe narrowing: emit<K> guarantees payload type matches E[K]
      fn(payload as E[K]);
    };
    set.add(wrapper);
    return () => {
      set?.delete(wrapper);
    };
  }

  public emit<K extends keyof E>(name: K, payload: E[K]): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const fn of set) {
      fn(payload);
    }
  }
}
