import type { Vector2 } from './types.ts';

export class SpatialHash<T> {
  private readonly cellSize: number;
  private readonly invCellSize: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly buckets: T[][];

  public constructor(width: number, height: number, cellSize = 100) {
    this.cellSize = Math.max(16, cellSize);
    this.invCellSize = 1 / this.cellSize;
    this.cols = Math.max(1, Math.ceil(width / this.cellSize));
    this.rows = Math.max(1, Math.ceil(height / this.cellSize));
    this.buckets = Array.from({ length: this.cols * this.rows }, () => []);
  }

  public clear(): void {
    for (let i = 0; i < this.buckets.length; i += 1) {
      const bucket = this.buckets[i];
      if (bucket) {
        bucket.length = 0;
      }
    }
  }

  private cellIndex(x: number, y: number): number {
    const cx = Math.max(0, Math.min(this.cols - 1, Math.floor(x * this.invCellSize)));
    const cy = Math.max(0, Math.min(this.rows - 1, Math.floor(y * this.invCellSize)));
    return cy * this.cols + cx;
  }

  public insert(pos: Vector2, item: T): void {
    const idx = this.cellIndex(pos.x, pos.y);
    const bucket = this.buckets[idx];
    if (bucket) {
      bucket.push(item);
    }
  }

  public queryRadius(pos: Vector2, radius: number, out: T[]): T[] {
    out.length = 0;
    const minCx = Math.floor((pos.x - radius) * this.invCellSize);
    const maxCx = Math.floor((pos.x + radius) * this.invCellSize);
    const minCy = Math.floor((pos.y - radius) * this.invCellSize);
    const maxCy = Math.floor((pos.y + radius) * this.invCellSize);

    for (let cy = minCy; cy <= maxCy; cy += 1) {
      const wrappedCy = ((cy % this.rows) + this.rows) % this.rows;
      for (let cx = minCx; cx <= maxCx; cx += 1) {
        const wrappedCx = ((cx % this.cols) + this.cols) % this.cols;
        const bucket = this.buckets[wrappedCy * this.cols + wrappedCx];
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i += 1) {
          const item = bucket[i];
          if (item !== undefined) {
            out.push(item);
          }
        }
      }
    }
    return out;
  }
}
