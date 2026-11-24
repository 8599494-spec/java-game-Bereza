export interface NetMetricsSnapshot {
  readonly rttMs: number;
  readonly downKBps: number;
  readonly upKBps: number;
  readonly queueLen: number;
  readonly reconcileErrorPx: number;
  readonly codecName: string;
}

export class NetgraphHud {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly rttHistory: number[] = [];
  private readonly downHistory: number[] = [];
  private bytesDownAcc = 0;
  private bytesUpAcc = 0;
  private lastSampleMs = performance.now();
  private currentDownKBps = 0;
  private currentUpKBps = 0;
  private currentRttMs = 0;

  public constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Failed to acquire 2D context for Netgraph');
    }
    this.ctx = context;
  }

  public recordBytesDown(bytes: number): void {
    this.bytesDownAcc += bytes;
  }

  public recordBytesUp(bytes: number): void {
    this.bytesUpAcc += bytes;
  }

  public recordRtt(rttMs: number): void {
    this.currentRttMs = rttMs;
    this.rttHistory.push(rttMs);
    if (this.rttHistory.length > 60) {
      this.rttHistory.shift();
    }
  }

  public tick(nowMs: number, queueLen: number, reconcileErrorPx: number, codecName: string): void {
    const elapsedMs = nowMs - this.lastSampleMs;
    if (elapsedMs >= 500) {
      const sec = elapsedMs / 1000;
      this.currentDownKBps = this.bytesDownAcc / 1024 / sec;
      this.currentUpKBps = this.bytesUpAcc / 1024 / sec;
      this.bytesDownAcc = 0;
      this.bytesUpAcc = 0;
      this.lastSampleMs = nowMs;

      this.downHistory.push(this.currentDownKBps);
      if (this.downHistory.length > 60) {
        this.downHistory.shift();
      }
    }

    this.render({
      rttMs: this.currentRttMs,
      downKBps: this.currentDownKBps,
      upKBps: this.currentUpKBps,
      queueLen,
      reconcileErrorPx,
      codecName,
    });
  }

  private render(m: NetMetricsSnapshot): void {
    const { width, height } = this.canvas;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, width, height);

    ctx.font = '11px Consolas, monospace';
    ctx.fillStyle = '#38bdf8';
    ctx.fillText(`NETGRAPH · ${m.codecName.toUpperCase()}`, 10, 16);

    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(`RTT:   ${m.rttMs.toFixed(1)} ms`, 10, 34);
    ctx.fillText(`Down:  ${m.downKBps.toFixed(2)} KB/s`, 10, 50);
    ctx.fillText(`Up:    ${m.upKBps.toFixed(2)} KB/s`, 10, 66);
    ctx.fillText(`Queue: ${m.queueLen} cmds`, 10, 82);

    ctx.fillStyle = m.reconcileErrorPx > 4 ? '#f59e0b' : '#22c55e';
    ctx.fillText(`Corr:  ${m.reconcileErrorPx.toFixed(2)} px`, 10, 98);

    this.drawSparkline(this.downHistory, 10, 108, width - 20, 28, '#38bdf8', 50);
  }

  private drawSparkline(
    values: readonly number[],
    x: number,
    y: number,
    w: number,
    h: number,
    color: string,
    minCeiling: number,
  ): void {
    if (values.length < 2) return;
    const ctx = this.ctx;
    let maxVal = minCeiling;
    for (const v of values) {
      if (v > maxVal) maxVal = v;
    }

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.2)';
    ctx.strokeRect(x, y, w, h);

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;

    for (let i = 0; i < values.length; i += 1) {
      const val = values[i] ?? 0;
      const px = x + (i / (values.length - 1)) * w;
      const py = y + h - Math.min(1, val / maxVal) * h;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
}
