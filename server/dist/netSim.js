export class NetworkSimulator {
    condition;
    timers = new Set();
    constructor(initial) {
        this.condition = { ...initial };
    }
    getCondition() {
        return this.condition;
    }
    update(next) {
        this.condition = {
            latencyMs: Math.max(0, Math.min(1000, next.latencyMs ?? this.condition.latencyMs)),
            jitterMs: Math.max(0, Math.min(500, next.jitterMs ?? this.condition.jitterMs)),
            dropRate: Math.max(0, Math.min(0.9, next.dropRate ?? this.condition.dropRate)),
        };
    }
    schedule(deliver) {
        const { latencyMs, jitterMs, dropRate } = this.condition;
        if (dropRate > 0 && Math.random() < dropRate) {
            return;
        }
        const jitterOffset = jitterMs > 0 ? (Math.random() * 2 - 1) * jitterMs : 0;
        const delayMs = Math.max(0, Math.round(latencyMs + jitterOffset));
        if (delayMs === 0) {
            deliver();
            return;
        }
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            deliver();
        }, delayMs);
        this.timers.add(timer);
    }
    dispose() {
        for (const timer of this.timers) {
            clearTimeout(timer);
        }
        this.timers.clear();
    }
}
