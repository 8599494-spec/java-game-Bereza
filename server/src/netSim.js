// Штучний інжектор затримки (latency), розкиду (jitter) та втрати пакетів (drop)
export class NetworkSimulator {
  #latencyMs;
  #jitterMs;
  #dropPct;

  constructor({ latencyMs = 0, jitterMs = 0, dropPct = 0 } = {}) {
    this.#latencyMs = latencyMs;
    this.#jitterMs = jitterMs;
    this.#dropPct = dropPct;
  }

  getSettings() {
    return {
      latencyMs: this.#latencyMs,
      jitterMs: this.#jitterMs,
      dropPct: this.#dropPct,
    };
  }

  update({ latencyMs, jitterMs, dropPct }) {
    if (latencyMs !== undefined) {
      this.#latencyMs = Math.max(0, Math.min(1000, Number(latencyMs) || 0));
    }
    if (jitterMs !== undefined) {
      this.#jitterMs = Math.max(0, Math.min(500, Number(jitterMs) || 0));
    }
    if (dropPct !== undefined) {
      this.#dropPct = Math.max(0, Math.min(50, Number(dropPct) || 0));
    }
    return this.getSettings();
  }

  schedule(fn) {
    if (this.#dropPct > 0 && Math.random() * 100 < this.#dropPct) {
      return;
    }
    const oneWay = this.#latencyMs * 0.5;
    const jitter = this.#jitterMs > 0 ? (Math.random() * 2 - 1) * (this.#jitterMs * 0.5) : 0;
    const delay = Math.max(0, oneWay + jitter);

    if (delay <= 0.5) {
      fn();
      return;
    }
    const timer = setTimeout(fn, delay);
    timer.unref();
  }
}
