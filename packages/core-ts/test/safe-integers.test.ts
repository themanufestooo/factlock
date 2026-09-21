/**
 * I-JSON safe-integer tests (audit H-06): integers outside ±(2^53 - 1) are
 * rejected so the same logical value can never canonicalize differently
 * across implementations. Includes the audit's 9007199254740993 case.
 * Run compiled: node --test dist/test/safe-integers.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, MAX_SAFE_INTEGER } from "../src/index.js";

test("boundary values are accepted", () => {
  assert.equal(canonicalize({ n: MAX_SAFE_INTEGER }), `{"n":${MAX_SAFE_INTEGER}}`);
  assert.equal(canonicalize({ n: -MAX_SAFE_INTEGER }), `{"n":${-MAX_SAFE_INTEGER}}`);
  assert.equal(canonicalize({ n: 0 }), '{"n":0}');
});

test("non-integer doubles are unaffected", () => {
  assert.equal(canonicalize({ n: 1.5 }), '{"n":1.5}');
  assert.equal(canonicalize({ n: -0.25 }), '{"n":-0.25}');
});

test("audit case: 9007199254740993 is rejected (arrives as 9007199254740992)", () => {
  // Any JSON parser delivers this as the double 9007199254740992 — an
  // unsafe integer — so canonicalize must refuse rather than sign it.
  const parsed = JSON.parse("9007199254740993");
  assert.equal(parsed, 9007199254740992);
  assert.equal(Number.isSafeInteger(parsed), false);
  assert.throws(() => canonicalize({ amount: parsed }), /safe range/);
});

test("unsafe integers throw a clear error", () => {
  assert.throws(() => canonicalize(9007199254740993), /safe range/);
  assert.throws(() => canonicalize({ n: -(MAX_SAFE_INTEGER + 1) }), /safe range/);
  assert.throws(() => canonicalize([MAX_SAFE_INTEGER + 2]), /safe range/);
});

test("integral floats outside the safe range are rejected like integers", () => {
  // 1e16 and 1e21 parse as floats in Python but as integral numbers in
  // JavaScript; both sides must fail closed on them (I-JSON).
  assert.throws(() => canonicalize({ f: 1e16 }), /safe range/);
  assert.throws(() => canonicalize({ f: 1e21 }), /safe range/);
  assert.throws(() => canonicalize({ f: -1e21 }), /safe range/);
});
