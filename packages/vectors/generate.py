"""Generate packages/vectors/vectors.json — shared cross-language test vectors.

Canonical expectations below are HAND-COMPUTED per RFC 8785 (not copied from
the implementation). The generator asserts the Python implementation matches
them before writing, so vectors.json is ground truth both languages test against.
Ed25519 signatures are deterministic: both implementations must reproduce the
exact signature hex for the same seed + message.
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "core-py" / "src"))
from factlock_core import canonicalize_str, keypair_from_seed, sign  # noqa: E402

CTRL = "\u0001"  # U+0001 control character

# Hand-computed (input, expected JCS) pairs.
CANONICAL_CASES: list[tuple[str, object, str]] = [
    ("empty-object", {}, "{}"),
    ("empty-array", [], "[]"),
    ("key-order", {"b": 1, "a": 2}, '{"a":2,"b":1}'),
    (
        "nested",
        {"z": {"d": 4, "c": 3}, "a": [3, 2, 1], "m": None},
        '{"a":[3,2,1],"m":null,"z":{"c":3,"d":4}}',
    ),
    ("bools", {"t": True, "f": False}, '{"f":false,"t":true}'),
    ("unicode-bmp", {"café": 1}, '{"café":1}'),
    ("unicode-astral-value", {"emoji": "🍕"}, '{"emoji":"🍕"}'),
    # UTF-16 code-unit order: 'z'(007A) < 'é'(00E9) < '€'(20AC) < '𝄞'(D834 DD1E)
    (
        "astral-key-order",
        {"𝄞": 4, "€": 3, "é": 2, "z": 1},
        '{"z":1,"é":2,"€":3,"𝄞":4}',
    ),
    (
        "string-escapes",
        {'a"b': "x\ny\t\\end"},
        '{"a\\"b":"x\\ny\\t\\\\end"}',
    ),
    ("control-char", {"c": CTRL}, '{"c":"\\u0001"}'),
    ("int", {"n": -42}, '{"n":-42}'),
    ("int-max-safe", {"n": 9007199254740991}, '{"n":9007199254740991}'),
    ("float-point-one", {"f": 0.1}, '{"f":0.1}'),
    ("float-big-int-like", {"f": 1e16}, '{"f":10000000000000000}'),
    ("float-exp", {"f": 1e21}, '{"f":1e+21}'),
    ("float-trailing-zero", {"f": 89.0}, '{"f":89}'),
    ("float-decimal", {"f": 123.456}, '{"f":123.456}'),
    ("float-small", {"f": 1e-6}, '{"f":0.000001}'),
    ("float-tiny-exp", {"f": 5e-7}, '{"f":5e-7}'),
    ("float-hundred", {"f": 100.0}, '{"f":100}'),
    ("float-negative", {"f": -2.5}, '{"f":-2.5}'),
    ("float-repeating", {"f": 0.30000000000000004}, '{"f":0.30000000000000004}'),
    (
        "attestation-shaped",
        {
            "attestation_id": "fla_test01",
            "protocol_version": "1.1",
            "status": "ACTIVE",
            "claims": [
                {"type": "price", "item": "service_call", "amount": 8900,
                 "currency": "USD", "disclosed": True}
            ],
            "verified_at": "2026-09-19T12:00:05Z",
        },
        '{"attestation_id":"fla_test01","claims":[{"amount":8900,"currency":"USD",'
        '"disclosed":true,"item":"service_call","type":"price"}],'
        '"protocol_version":"1.1","status":"ACTIVE",'
        '"verified_at":"2026-09-19T12:00:05Z"}',
    ),
]

SIGN_MESSAGES = [
    "hello factlock",
    '{"a":2,"b":1}',
    "price attestation: $89.00 service call — cafés welcome 🍕",
]


def main() -> None:
    cases = []
    for name, value, expected in CANONICAL_CASES:
        if name == "control-char":
            value = {"c": CTRL}
            expected = '{"c":"\\u0001"}'
        got = canonicalize_str(value)
        assert got == expected, f"vector {name}: impl={got!r} expected={expected!r}"
        cases.append({"name": name, "input": value, "expected": expected})

    seed_a = hashlib.sha256(b"factlock-test-seed-a").digest()
    pub_a, priv_a = keypair_from_seed(seed_a)
    seed_b = hashlib.sha256(b"factlock-test-seed-b").digest()
    pub_b, _ = keypair_from_seed(seed_b)

    vectors = {
        "version": 1,
        "canonical": cases,
        "signatures": [
            {
                "name": f"sig-{i}",
                "seed_hex": seed_a.hex(),
                "public_key_hex": pub_a.hex(),
                "message": msg,
                "signature_hex": sign(priv_a, msg.encode("utf-8")).hex(),
            }
            for i, msg in enumerate(SIGN_MESSAGES)
        ],
        "negative": {
            "wrong_key_public_hex": pub_b.hex(),
            "note": "signatures must NOT verify under wrong_key_public_hex; "
                    "flipping any message byte must fail verification",
        },
    }
    out = Path(__file__).resolve().parent / "vectors.json"
    out.write_text(json.dumps(vectors, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out} ({len(cases)} canonical, {len(SIGN_MESSAGES)} signature vectors)")


if __name__ == "__main__":
    main()
