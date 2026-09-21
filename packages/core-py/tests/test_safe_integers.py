"""I-JSON safe-integer tests (audit H-06): integers outside ±(2**53 - 1) are
rejected so the same logical value can never canonicalize differently
across implementations. Mirrors the TypeScript safe-integers suite —
including the audit's 9007199254740993 case, which both sides must reject.
"""
import pytest

from factlock_core import canonicalize
from factlock_core.canonicalize import MAX_SAFE_INTEGER


def test_boundary_values_accepted():
    assert canonicalize({"n": MAX_SAFE_INTEGER}) == b'{"n":9007199254740991}'
    assert canonicalize({"n": -MAX_SAFE_INTEGER}) == b'{"n":-9007199254740991}'
    assert canonicalize({"n": 0}) == b'{"n":0}'


def test_non_integer_floats_unaffected():
    assert canonicalize({"n": 1.5}) == b'{"n":1.5}'
    assert canonicalize({"n": -0.25}) == b'{"n":-0.25}'


def test_audit_case_9007199254740993_rejected():
    # Python ints have arbitrary precision, so this value arrives intact —
    # and must still be refused, exactly like the TypeScript side refuses
    # the double it degrades to.
    with pytest.raises(ValueError, match="safe range"):
        canonicalize({"amount": 9007199254740993})
    with pytest.raises(ValueError, match="safe range"):
        canonicalize({"n": -(MAX_SAFE_INTEGER + 1)})
    with pytest.raises(ValueError, match="safe range"):
        canonicalize([MAX_SAFE_INTEGER + 2])


def test_cross_language_agreement_on_rejection():
    """Both implementations reject the audit case; neither signs it."""
    with pytest.raises(ValueError):
        canonicalize(9007199254740993)


def test_integral_floats_outside_safe_range_rejected():
    """1e16/1e21 parse as floats in Python but integral numbers in JS —
    both sides fail closed (I-JSON)."""
    for bad in (1e16, 1e21, -1e21):
        with pytest.raises(ValueError, match="safe range"):
            canonicalize({"f": bad})
