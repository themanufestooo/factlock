/**
 * Fixed free-tier rate limiter (T6): in-memory token bucket per key (IP).
 * Verification stays free and keyless; the bucket only stops abuse.
 * 429 responses carry Retry-After.
 */
export class TokenBucket {
  private readonly states = new Map<string, { tokens: number; lastMs: number }>();
  readonly capacity: number;
  readonly windowMs: number;

  constructor(capacity: number, windowMs: number) {
    if (!(capacity > 0) || !(windowMs > 0)) {
      throw new Error("TokenBucket: capacity and windowMs must be positive");
    }
    this.capacity = capacity;
    this.windowMs = windowMs;
  }

  take(key: string, nowMs: number = Date.now()): { allowed: boolean; retryAfterSec: number } {
    let s = this.states.get(key);
    if (!s) {
      s = { tokens: this.capacity, lastMs: nowMs };
      this.states.set(key, s);
    }
    const elapsed = Math.max(0, nowMs - s.lastMs);
    s.tokens = Math.min(this.capacity, s.tokens + (elapsed * this.capacity) / this.windowMs);
    s.lastMs = nowMs;
    if (s.tokens >= 1) {
      s.tokens -= 1;
      return { allowed: true, retryAfterSec: 0 };
    }
    const deficit = 1 - s.tokens;
    const retryAfterSec = Math.ceil((deficit * this.windowMs) / this.capacity / 1000);
    return { allowed: false, retryAfterSec: Math.max(1, retryAfterSec) };
  }

  /** For tests. */
  reset(key: string): void {
    this.states.delete(key);
  }
}
