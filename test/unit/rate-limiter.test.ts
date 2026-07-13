import { test } from "node:test";
import assert from "node:assert/strict";

import { TokenBucketRateLimiter, RateLimitError } from "../../src/utils/rate-limiter.js";

test("RateLimitError is an Error subclass with the right name", () => {
  const err = new RateLimitError("slow down");
  assert.ok(err instanceof Error);
  assert.ok(err instanceof RateLimitError);
  assert.equal(err.name, "RateLimitError");
  assert.equal(err.message, "slow down");
});

test("a large burst lets many sequential acquires through quickly", async () => {
  // maxTokens=50, refillRate=0.05 tokens/ms — plenty for 10 acquires, no waiting.
  const limiter = new TokenBucketRateLimiter(50, 50);

  const start = performance.now();
  for (let i = 0; i < 10; i++) {
    await limiter.acquire();
  }
  const elapsed = performance.now() - start;

  // Generous bound: no setTimeout wait should fire, so this is essentially instant.
  assert.ok(
    elapsed < 100,
    `expected 10 sequential acquires to be fast (<100ms), got ${elapsed.toFixed(1)}ms`,
  );
});

test("a starved limiter forces a wait on the second back-to-back acquire", async () => {
  // maxTokens=1, refillRate=0.01 tokens/ms.
  // First acquire is immediate (1 token available -> 0).
  // Second acquire: tokens<1, waitMs = ceil((1-0)/0.01) ~= 100ms.
  const limiter = new TokenBucketRateLimiter(10, 1);

  const start = performance.now();
  await limiter.acquire(); // immediate
  await limiter.acquire(); // must wait ~100ms
  const elapsed = performance.now() - start;

  // Tolerant lower bound to avoid timer-jitter flakiness.
  assert.ok(
    elapsed >= 80,
    `expected the second acquire to wait ~100ms (>=80ms total), got ${elapsed.toFixed(1)}ms`,
  );
});

test("concurrent acquires are serialized and all resolve without error", async () => {
  // Small burst: 3 tokens, then refills are needed. Fire many at once.
  const limiter = new TokenBucketRateLimiter(100, 3);

  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => limiter.acquire()),
  );

  // Every concurrent acquire must resolve; the serialization queue must keep
  // working across calls and never reject or blow up.
  for (const r of results) {
    assert.equal(r.status, "fulfilled", `expected all acquires to resolve, got ${JSON.stringify(r)}`);
  }

  // The queue must still be usable afterwards (no permanently-broken chain).
  await assert.doesNotReject(() => limiter.acquire());
});

test("the queue keeps working across separate concurrent batches", async () => {
  const limiter = new TokenBucketRateLimiter(200, 2);

  await Promise.all(Array.from({ length: 4 }, () => limiter.acquire()));
  // A second independent batch must also fully resolve.
  await assert.doesNotReject(() =>
    Promise.all(Array.from({ length: 4 }, () => limiter.acquire())),
  );
});
