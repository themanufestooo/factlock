/**
 * JCS (RFC 8785) canonicalization for the FactLock attestation protocol.
 *
 * Produces the canonical JSON string that gets signed. Number formatting
 * relies on JSON.stringify, which implements ECMAScript Number::toString —
 * identical semantics to the Python reference implementation.
 *
 * I-JSON (RFC 7493): integers MUST be within the ECMAScript safe range
 * ±(2^53 - 1). Anything outside it is rejected — the same logical value
 * would canonicalize differently across implementations otherwise.
 */

/** Largest integer with an exact double representation. */
export const MAX_SAFE_INTEGER = 9007199254740991;

function assertNoLoneSurrogates(s: string, what: string): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) {
        throw new Error(`JCS: ${what} contains unpaired surrogate`);
      }
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new Error(`JCS: ${what} contains unpaired surrogate`);
    }
  }
}

export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) {
    if (value === undefined) throw new Error("JCS: undefined is not allowed");
    return "null";
  }
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new Error("JCS: non-finite numbers are not allowed");
    }
    // JSON.stringify(-0) === "0"; non-integer doubles keep ECMAScript
    // formatting. Integers outside the safe range are rejected outright —
    // JSON.parse("9007199254740993") is already 9007199254740992 by the time
    // we see it, so the signed bytes would silently differ from the Python
    // reference implementation.
    if (Number.isInteger(n) && !Number.isSafeInteger(n)) {
      throw new Error(
        `JCS: integer outside the safe range ±${MAX_SAFE_INTEGER}`,
      );
    }
    return JSON.stringify(n);
  }
  if (t === "string") {
    const s = value as string;
    assertNoLoneSurrogates(s, "string value");
    return JSON.stringify(s);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalize(v)).join(",") + "]";
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    // Default sort compares UTF-16 code units — exactly the RFC 8785 order.
    const keys = Object.keys(obj).sort();
    for (const k of keys) assertNoLoneSurrogates(k, "object key");
    return (
      "{" +
      keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") +
      "}"
    );
  }
  throw new Error(`JCS: unsupported type ${t}`);
}

/** Canonical UTF-8 bytes (what actually gets signed). */
export function canonicalizeBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}
