"""JCS (RFC 8785) canonicalization for the FactLock attestation protocol.

Produces the canonical JSON byte representation that gets signed.
Numbers follow ECMAScript Number::toString semantics (matching what the
TypeScript implementation produces via JSON.stringify).

I-JSON (RFC 7493): integers MUST be within the ECMAScript safe range
±(2**53 - 1). Anything outside it is rejected — the same logical value
would canonicalize differently across implementations otherwise.
"""
from __future__ import annotations

import json
import math
import re

#: Largest integer with an exact double representation (2**53 - 1).
MAX_SAFE_INTEGER = 9007199254740991


def _check_string(s: str) -> None:
    # JCS forbids unpaired surrogates; Python str can hold them.
    for ch in s:
        o = ord(ch)
        if 0xD800 <= o <= 0xDFFF:
            raise ValueError("JCS: string contains unpaired surrogate")


def _ecma_number_to_string(v: float) -> str:
    """ECMAScript Number::toString for a finite, nonzero double."""
    if not math.isfinite(v):
        raise ValueError("JCS: non-finite numbers are not allowed")
    if v == 0:
        return "0"  # covers -0.0
    neg = v < 0
    rep = repr(abs(v))  # shortest round-trip decimal, e.g. '0.1', '1e+16', '89.0'
    m = re.fullmatch(r"(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?", rep)
    if not m:
        raise ValueError(f"JCS: cannot parse float repr {rep!r}")
    int_part, frac_part, exp_part = m.group(1), m.group(2) or "", m.group(3)
    exp = int(exp_part) if exp_part else 0
    digits = int_part + frac_part
    # strip leading zeros, adjusting n
    leading = len(digits) - len(digits.lstrip("0"))
    digits = digits.lstrip("0")
    n = exp + len(int_part) - leading
    # strip trailing zeros (repr is shortest, but '89.0' -> '890' needs this)
    digits = digits.rstrip("0")
    if not digits:  # pragma: no cover - v == 0 handled above
        return "0"
    k = len(digits)
    if k <= n <= 21:
        out = digits + "0" * (n - k)
    elif 0 < n <= 21:
        out = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + digits
    else:
        out = digits[0]
        if k > 1:
            out += "." + digits[1:]
        out += "e" + ("-" if n - 1 < 0 else "+") + str(abs(n - 1))
    return ("-" if neg else "") + out


def _serialize(value) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int) and not isinstance(value, bool):
        if not -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER:
            raise ValueError(
                f"JCS: integer {value} is outside the safe range ±{MAX_SAFE_INTEGER}"
            )
        return str(value)
    if isinstance(value, float):
        # Integral floats outside the safe range are rejected exactly like
        # integers: e.g. 1e21 parses as a float in Python but as an integral
        # number in JavaScript, and the two sides must agree to fail closed.
        if value.is_integer() and not -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER:
            raise ValueError(
                f"JCS: integral float {value} is outside the safe range ±{MAX_SAFE_INTEGER}"
            )
        return _ecma_number_to_string(value)
    if isinstance(value, str):
        _check_string(value)
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_serialize(v) for v in value) + "]"
    if isinstance(value, dict):
        for key in value.keys():
            if not isinstance(key, str):
                raise TypeError("JCS: object keys must be strings")
            _check_string(key)
        # UTF-16 code-unit ordering per RFC 8785
        keys = sorted(value.keys(), key=lambda k: k.encode("utf-16-be"))
        return "{" + ",".join(
            _serialize(k) + ":" + _serialize(value[k]) for k in keys
        ) + "}"
    raise TypeError(f"JCS: unsupported type {type(value).__name__}")


def canonicalize(value) -> bytes:
    """Return the JCS canonical UTF-8 bytes for a JSON-compatible value."""
    return _serialize(value).encode("utf-8")


def canonicalize_str(value) -> str:
    """Return the JCS canonical string (for debugging / test vectors)."""
    return _serialize(value)
