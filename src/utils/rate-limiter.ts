/**
 * Token bucket rate limiter for Cloudflare API calls
 */

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms
  // Serializes acquisitions so concurrent callers don't all read the same
  // token count and drive it negative.
  private queue: Promise<void> = Promise.resolve();

  constructor(maxRequestsPerSecond = 20, burstLimit = 50) {
    this.maxTokens = burstLimit;
    this.tokens = this.maxTokens;
    this.lastRefill = Date.now();
    this.refillRate = maxRequestsPerSecond / 1000;
  }

  async acquire(): Promise<void> {
    // Chain on the previous acquisition so token math runs one-at-a-time.
    const next = this.queue.then(() => this.take());
    // Keep the chain alive even if a caller's take() rejects.
    this.queue = next.catch(() => {});
    return next;
  }

  private async take(): Promise<void> {
    this.refillTokens();
    if (this.tokens < 1) {
      const waitMs = Math.ceil((1 - this.tokens) / this.refillRate);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.refillTokens();
    }
    this.tokens -= 1;
  }

  private refillTokens(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}
