"""Veritas core protocol library (Python reference implementation)."""

from .canonicalize import canonicalize, canonicalize_str
from .ed25519 import (
    b64d,
    b64e,
    generate_keypair,
    keypair_from_seed,
    sign,
    verify,
)

__all__ = [
    "canonicalize",
    "canonicalize_str",
    "generate_keypair",
    "keypair_from_seed",
    "sign",
    "verify",
    "b64e",
    "b64d",
]
