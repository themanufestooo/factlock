/** T6 tests: token bucket behavior. Run compiled: node --test dist/test/*.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";

import { TokenBucket } from "../src/index.js";

test("allows up to capacity, then denies with retry-after", () => {
  const b = new TokenBucket(2, 60_000);
  assert.equal(b.take("ip", 0).allowed, true);
  assert.equal(b.take("ip", 0).allowed, true);
  const denied = b.take("ip", 0);
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterSec >= 1);
});

test("tokens refill over the window", () => {
  const b = new TokenBucket(1, 10_000);
  assert.equal(b.take("ip", 0).allowed, true);
  assert.equal(b.take("ip", 1_000).allowed, false);
  assert.equal(b.take("ip", 10_000).allowed, true); // full window elapsed
});

test("buckets are per key", () => {
  const b = new TokenBucket(1, 60_000);
  assert.equal(b.take("a", 0).allowed, true);
  assert.equal(b.take("b", 0).allowed, true);
  assert.equal(b.take("a", 0).allowed, false);
});

test("rejects non-positive config", () => {
  assert.throws(() => new TokenBucket(0, 1000));
  assert.throws(() => new TokenBucket(1, 0));
});
