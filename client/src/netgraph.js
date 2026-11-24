export class NetgraphMonitor {
  #rttHistory = [];
  #corrHistory = [];
  #maxSamples = 70;

  pushSample({ rttMs, correctionPx }) {
    this.#rttHistory.push(rttMs);
    this.#corrHistory.push(correctionPx);
    if (this.#rttHistory.length > this.#maxSamples) this.#rttHistory.shift();
    if (this.#corrHistory.length > this.#maxSamples) this.#corrHistory.shift();
  }

  draw(
    ctx,
    {
      rttMs,
      snapshotAgeMs,
      bytesInPerSec,
      bytesOutPerSec,
      pendingInputs,
      correctionPx,
      interpDelayMs,
      codec,
    },
  ) {
    const x = 14;
    const y = 64;
    const w = 258;
    const h = 132;

    ctx.save();
    ctx.fillStyle = 'rgba(2, 6, 23, 0.82)';
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);

    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = '#38bdf8';
    ctx.fillText(`NETGRAPH [${codec}]`, x + 10, y + 16);

    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(`RTT: ${rttMs.toFixed(1)} ms   Snap age: ${snapshotAgeMs.toFixed(0)} ms`, x + 10, y + 32);
    ctx.fillText(
      `Down: ${(bytesInPerSec / 1024).toFixed(2)} KB/s  Up: ${(bytesOutPerSec / 1024).toFixed(2)} KB/s`,
      x + 10,
      y + 47,
    );
    ctx.fillText(`Input queue: ${pendingInputs}   Interp: ${interpDelayMs} ms`, x + 10, y + 62);

    ctx.fillStyle = correctionPx > 6 ? '#f43f5e' : '#22c55e';
    ctx.fillText(`Reconcile corr: ${correctionPx.toFixed(2)} px`, x + 10, y + 77);

    // Спарклайн RTT (зелений) та похибки звірки (рожевий)
    const gx = x + 10;
    const gy = y + 84;
    const gw = w - 20;
    const gh = 38;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
    ctx.fillRect(gx, gy, gw, gh);

    this.#drawSparkline(ctx, this.#rttHistory, gx, gy, gw, gh, 250, '#22c55e');
    this.#drawSparkline(ctx, this.#corrHistory, gx, gy, gw, gh, 40, '#f43f5e');
    ctx.restore();
  }

  #drawSparkline(ctx, data, x, y, w, h, maxVal, color) {
    if (data.length < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let i = 0; i < data.length; i += 1) {
      const px = x + (i / (this.#maxSamples - 1)) * w;
      const norm = Math.min(1, Math.max(0, data[i] / maxVal));
      const py = y + h - norm * (h - 4) - 2;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
}
