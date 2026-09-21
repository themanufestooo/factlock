"""Ed25519 signing/verification for the FactLock attestation protocol.

Thin wrapper over libsodium (PyNaCl). Signatures are deterministic:
the same key + canonical bytes always yield the same signature, which is
what lets the TypeScript and Python implementations share test vectors.
"""
from __future__ import annotations

import base64

from nacl.exceptions import BadSignatureError
from nacl.signing import SigningKey, VerifyKey

SEED_BYTES = 32
PUBLIC_KEY_BYTES = 32
PRIVATE_KEY_BYTES = 64
SIGNATURE_BYTES = 64


def generate_keypair() -> tuple[bytes, bytes]:
    """Return (public_key, private_key). Private key material: keep in KMS/HSM."""
    sk = SigningKey.generate()
    return sk.verify_key.encode(), sk.encode() + sk.verify_key.encode()


def keypair_from_seed(seed: bytes) -> tuple[bytes, bytes]:
    """Deterministic keypair from a 32-byte seed (tests, vectors — never prod)."""
    if len(seed) != SEED_BYTES:
        raise ValueError("seed must be 32 bytes")
    sk = SigningKey(seed)
    return sk.verify_key.encode(), seed + sk.verify_key.encode()


def sign(private_key: bytes, message: bytes) -> bytes:
    """Sign message bytes; return the 64-byte detached signature."""
    if len(private_key) != PRIVATE_KEY_BYTES:
        raise ValueError("private key must be 64 bytes")
    return SigningKey(private_key[:SEED_BYTES]).sign(message).signature


def verify(public_key: bytes, message: bytes, signature: bytes) -> bool:
    """Return True iff signature is valid for message under public_key."""
    if len(public_key) != PUBLIC_KEY_BYTES or len(signature) != SIGNATURE_BYTES:
        return False
    try:
        VerifyKey(public_key).verify(signature + message)
        return True
    except BadSignatureError:
        return False


def b64e(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def b64d(s: str) -> bytes:
    return base64.b64decode(s.encode("ascii"))
