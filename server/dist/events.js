export class TypedEventEmitter {
    listeners = new Map();
    on(event, listener) {
        let bucket = this.listeners.get(event);
        if (!bucket) {
            bucket = new Set();
            this.listeners.set(event, bucket);
        }
        const wrapped = (payload) => {
            // Safe narrowing: emit<K> enforces that payload matches Events[K]
            listener(payload);
        };
        bucket.add(wrapped);
        return () => {
            bucket?.delete(wrapped);
        };
    }
    emit(event, payload) {
        const bucket = this.listeners.get(event);
        if (!bucket)
            return;
        for (const listener of bucket) {
            listener(payload);
        }
    }
    clearListeners() {
        this.listeners.clear();
    }
}
