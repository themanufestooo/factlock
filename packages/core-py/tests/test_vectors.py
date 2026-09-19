"""Cross-language conformance tests: shared vectors in packages/vectors/vectors.json."""
import json
from pathlib import Path

import pytest

from veritas_core import canonicalize, keypair_from_seed, sign, verify

VECTORS = json.loads(
    (Path(__file__).resolve().parent.parent.parent / "vectors" / "vectors.json")
    .read_text(encoding="utf-8")
)


@pytest.mark.parametrize("case", VECTORS["canonical"], ids=lambda c: c["name"])
def test_canonical_vectors(case):
    assert canonicalize(case["input"]).decode("utf-8") == case["expected"]


@pytest.mark.parametrize("case", VECTORS["signatures"], ids=lambda c: c["name"])
def test_signature_vectors(case):
    msg = case["message"].encode("utf-8")
    pub = bytes.fromhex(case["public_key_hex"])
    sig = bytes.fromhex(case["signature_hex"])
    # exact deterministic reproduction from the seed
    _, priv = keypair_from_seed(bytes.fromhex(case["seed_hex"]))
    assert sign(priv, msg) == sig
    assert verify(pub, msg, sig) is True


@pytest.mark.parametrize("case", VECTORS["signatures"], ids=lambda c: c["name"])
def test_tampered_message_fails(case):
    msg = bytearray(case["message"].encode("utf-8"))
    msg[0] ^= 0x01
    assert (
        verify(bytes.fromhex(case["public_key_hex"]), bytes(msg),
               bytes.fromhex(case["signature_hex"]))
        is False
    )


@pytest.mark.parametrize("case", VECTORS["signatures"], ids=lambda c: c["name"])
def test_wrong_key_fails(case):
    wrong_pub = bytes.fromhex(VECTORS["negative"]["wrong_key_public_hex"])
    assert (
        verify(wrong_pub, case["message"].encode("utf-8"),
               bytes.fromhex(case["signature_hex"]))
        is False
    )


def test_rejects_garbage_lengths():
    assert verify(b"short", b"msg", b"short") is False
