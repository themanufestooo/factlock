/**
 * JCS (RFC 8785) canonicalization for the Veritas attestation protocol.
 *
 * Produces the canonical JSON string that gets signed. Number formatting
 * relies on JSON.stringify, which implements ECMAScript Number::toString —
 * identical semantics to the Python reference implementation.
 */

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
    // JSON.stringify(-0) === "0"; integers beyond 2^53 lose precision —
    // keep claim amounts within the safe integer range (spec: minor units).
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
