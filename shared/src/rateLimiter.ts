export class TokenBucketRateLimiter {
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private tokens: number;
  private lastRefillMs: number;

  public constructor(capacity: number, refillPerSec: number, nowMs = 0) {
    this.capacity = Math.max(1, capacity);
    this.refillPerSec = Math.max(0.1, refillPerSec);
    this.tokens = this.capacity;
    this.lastRefillMs = nowMs;
  }

  public tryConsume(nowMs: number, cost = 1): boolean {
    if (nowMs > this.lastRefillMs) {
      const elapsedSec = (nowMs - this.lastRefillMs) / 1000;
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
      this.lastRefillMs = nowMs;
    }
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  public get availableTokens(): number {
    return this.tokens;
  }
}
