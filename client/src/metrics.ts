export interface FrameStatsSummary {
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly fps: number;
  readonly sampleCount: number;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx] ?? 0;
}

export class FrameTimeTracker {
  private readonly samples: number[] = [];
  private readonly maxSamples: number;

  public constructor(maxSamples = 600) {
    this.maxSamples = Math.max(10, maxSamples);
  }

  public record(frameDurationMs: number): void {
    if (!Number.isFinite(frameDurationMs) || frameDurationMs < 0) return;
    this.samples.push(frameDurationMs);
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }

  public reset(): void {
    this.samples.length = 0;
  }

  public getSummary(): FrameStatsSummary {
    if (this.samples.length === 0) {
      return { p50Ms: 0, p95Ms: 0, p99Ms: 0, fps: 0, sampleCount: 0 };
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    const p50 = percentile(sorted, 0.5);
    const p95 = percentile(sorted, 0.95);
    const p99 = percentile(sorted, 0.99);
    const fps = p50 > 0 ? Math.min(240, 1000 / p50) : 60;

    return {
      p50Ms: Number(p50.toFixed(2)),
      p95Ms: Number(p95.toFixed(2)),
      p99Ms: Number(p99.toFixed(2)),
      fps: Number(fps.toFixed(1)),
      sampleCount: sorted.length,
    };
  }
}

export function markPerf(name: string): void {
  if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
    performance.mark(name);
  }
}

export function measurePerf(measureName: string, startMark: string, endMark: string): void {
  if (typeof performance !== 'undefined' && typeof performance.measure === 'function') {
    try {
      performance.measure(measureName, startMark, endMark);
    } catch {
      // Ignore missing marks when profiling starts mid-frame
    }
  }
}
