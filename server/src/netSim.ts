export interface NetworkCondition {
  latencyMs: number;
  jitterMs: number;
  dropRate: number;
}

export class NetworkSimulator {
  private condition: NetworkCondition;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  public constructor(initial: NetworkCondition) {
    this.condition = { ...initial };
  }

  public getCondition(): Readonly<NetworkCondition> {
    return this.condition;
  }

  public update(next: Partial<NetworkCondition>): void {
    this.condition = {
      latencyMs: Math.max(0, Math.min(1000, next.latencyMs ?? this.condition.latencyMs)),
      jitterMs: Math.max(0, Math.min(500, next.jitterMs ?? this.condition.jitterMs)),
      dropRate: Math.max(0, Math.min(0.9, next.dropRate ?? this.condition.dropRate)),
    };
  }

  public schedule(deliver: () => void): void {
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

  public dispose(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
