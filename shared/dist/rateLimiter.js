export class TokenBucketRateLimiter {
    capacity;
    refillPerSec;
    tokens;
    lastRefillMs;
    constructor(capacity, refillPerSec, nowMs = 0) {
        this.capacity = Math.max(1, capacity);
        this.refillPerSec = Math.max(0.1, refillPerSec);
        this.tokens = this.capacity;
        this.lastRefillMs = nowMs;
    }
    tryConsume(nowMs, cost = 1) {
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
    get availableTokens() {
        return this.tokens;
    }
}
