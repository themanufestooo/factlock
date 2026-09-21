"""Generate packages/vectors/merkle-vectors.json — cross-language ground truth for T4.

RFC 6962 Merkle tree over SHA-256:
    leaf_hash = SHA256(0x00 || leaf)
    node_hash = SHA256(0x01 || left || right)

The generator EXHAUSTIVELY self-checks before writing:
  - fold(greedy_blocks) == naive recursive RFC root for every n in 1..24
  - every emitted inclusion proof verifies
  - every emitted consistency proof verifies (fold-based)
so merkle-vectors.json is ground truth both languages test against.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path


def sha256(b: bytes) -> bytes:
    return hashlib.sha256(b).digest()


def leaf_hash(leaf: bytes) -> bytes:
    return sha256(b"\x00" + leaf)


def node_hash(left: bytes, right: bytes) -> bytes:
    return sha256(b"\x01" + left + right)


def lpow2_lt(n: int) -> int:
    """Largest power of two strictly smaller than n (n >= 2)."""
    assert n >= 2
    return 1 << ((n - 1).bit_length() - 1)


def rfc_root(leaves: list[bytes], lo: int, n: int) -> bytes:
    """Naive recursive RFC 6962 root of leaves[lo:lo+n]."""
    if n == 1:
        return leaf_hash(leaves[lo])
    k = lpow2_lt(n)
    return node_hash(rfc_root(leaves, lo, k), rfc_root(leaves, lo + k, n - k))


def perfect_subtree(leaves: list[bytes], p: int, s: int) -> bytes:
    """Hash of the perfect subtree covering leaves[p:p+s]; s a power of two,
    p % s == 0."""
    assert s >= 1 and (s & (s - 1)) == 0 and p % s == 0
    if s == 1:
        return leaf_hash(leaves[p])
    return node_hash(
        perfect_subtree(leaves, p, s // 2),
        perfect_subtree(leaves, p + s // 2, s // 2),
    )


def greedy_blocks(leaves: list[bytes], lo: int, n: int) -> list[tuple[int, bytes]]:
    """Maximal perfect aligned blocks partitioning [lo, lo+n)."""
    blocks: list[tuple[int, bytes]] = []
    p, rem = lo, n
    while rem > 0:
        s = 1 << (rem.bit_length() - 1)  # largest power of two <= rem
        while p % s != 0:
            s >>= 1
        blocks.append((s, perfect_subtree(leaves, p, s)))
        p += s
        rem -= s
    return blocks


def fold(blocks: list[tuple[int, bytes]]) -> bytes:
    """RFC 6962 root from an ordered perfect-aligned block partition."""
    if len(blocks) == 1:
        return blocks[0][1]
    total = sum(s for s, _ in blocks)
    k = lpow2_lt(total)
    acc = 0
    left: list[tuple[int, bytes]] = []
    for b in blocks:
        if acc + b[0] <= k:
            left.append(b)
            acc += b[0]
        else:
            break
    right = blocks[len(left):]
    assert left and right and acc == k  # split falls on a block boundary
    return node_hash(fold(left), fold(right))


def audit_path(leaves: list[bytes], n: int, index: int) -> list[tuple[str, bool]]:
    """Inclusion proof as [(sibling_hash_hex, sibling_is_left)], leaf-up."""
    proof: list[tuple[str, bool]] = []

    def rec(lo: int, m: int) -> None:
        if m == 1:
            return
        k = lpow2_lt(m)
        if index < lo + k:
            rec(lo, k)
            proof.append((rfc_root(leaves, lo + k, m - k).hex(), False))
        else:
            rec(lo + k, m - k)
            proof.append((rfc_root(leaves, lo, k).hex(), True))

    rec(0, n)
    return proof


def verify_inclusion(leaf: bytes, path: list[tuple[str, bool]], root_hex: str) -> bool:
    h = leaf_hash(leaf)
    for sib_hex, left in path:
        sib = bytes.fromhex(sib_hex)
        h = node_hash(sib, h) if left else node_hash(h, sib)
    return h.hex() == root_hex


def consistency_proof(leaves: list[bytes], m: int, n: int) -> dict:
    assert 1 <= m <= n
    old_blocks = greedy_blocks(leaves, 0, m)
    new_blocks = greedy_blocks(leaves, m, n - m)
    blocks = old_blocks + new_blocks
    return {
        "old_size": m,
        "new_size": n,
        "old_root": fold(old_blocks).hex(),
        "new_root": fold(blocks).hex(),
        "blocks": [{"size": s, "hash": h.hex()} for s, h in blocks],
    }


def verify_consistency(p: dict) -> bool:
    blocks = [(b["size"], bytes.fromhex(b["hash"])) for b in p["blocks"]]
    m, n = p["old_size"], p["new_size"]
    if not (1 <= m <= n) or sum(s for s, _ in blocks) != n:
        return False
    acc = 0
    old_blocks: list[tuple[int, bytes]] = []
    for s, h in blocks:
        if s <= 0 or (s & (s - 1)) != 0:
            return False
        if acc < m:
            old_blocks.append((s, h))
            acc += s
    if acc != m:
        return False
    return (
        fold(old_blocks).hex() == p["old_root"]
        and fold(blocks).hex() == p["new_root"]
    )


def main() -> None:
    leaves = [f"factlock-merkle-leaf-{i:04d}".encode() for i in range(8)]

    # --- exhaustive self-check: fold == naive RFC root ---------------------
    for n in range(1, 25):
        big = leaves * ((n // 8) + 1)
        naive = rfc_root(big, 0, n).hex()
        assert fold(greedy_blocks(big, 0, n)).hex() == naive, f"fold mismatch n={n}"
        for m in range(1, n + 1):
            cp = consistency_proof(big, m, n)
            assert cp["new_root"] == naive, f"consistency new_root mismatch m={m} n={n}"
            assert cp["old_root"] == rfc_root(big, 0, m).hex()
            assert verify_consistency(cp), f"consistency verify failed m={m} n={n}"
            for i in range(n):
                path = audit_path(big, n, i)
                assert verify_inclusion(big[i], path, naive), f"inclusion failed n={n} i={i}"

    out: dict = {
        "description": (
            "RFC 6962 Merkle tree vectors (SHA-256). leaf_hash=SHA256(0x00||leaf), "
            "node_hash=SHA256(0x01||left||right). Leaves are UTF-8 bytes of "
            "'factlock-merkle-leaf-%04d'. Inclusion path entries are ordered leaf-up; "
            "'left'=true means the sibling hash goes on the left when recombining."
        ),
        "leaf_encoding": "utf8 of 'factlock-merkle-leaf-%04d'",
        "leaves_hex": [l.hex() for l in leaves],
        "roots": [],
        "inclusion_proofs": [],
        "consistency_proofs": [],
    }

    for n in (1, 2, 3, 4, 5, 8):
        out["roots"].append({"n": n, "root": rfc_root(leaves, 0, n).hex()})

    for n, index in ((5, 2), (8, 7)):
        root = rfc_root(leaves, 0, n).hex()
        path = audit_path(leaves, n, index)
        assert verify_inclusion(leaves[index], path, root)
        out["inclusion_proofs"].append(
            {
                "n": n,
                "index": index,
                "leaf": leaves[index].hex(),
                "path": [{"hash": h, "left": lf} for h, lf in path],
                "root": root,
            }
        )

    for m, n in ((1, 1), (3, 5), (5, 8), (4, 8)):
        cp = consistency_proof(leaves, m, n)
        assert verify_consistency(cp)
        out["consistency_proofs"].append(cp)

    dest = Path(__file__).resolve().parent / "merkle-vectors.json"
    dest.write_text(json.dumps(out, indent=2) + "\n")
    print(f"wrote {dest} "
          f"({len(out['roots'])} roots, "
          f"{len(out['inclusion_proofs'])} inclusion proofs, "
          f"{len(out['consistency_proofs'])} consistency proofs)")


if __name__ == "__main__":
    main()
