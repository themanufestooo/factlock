# Test vector review — `packages/vectors/vectors.json`

**Reviewer:** Lucky · **Date:** 2026-09-23 · **Repo head:** `387cc50`
**Rule followed:** spot-check by hand; if a vector is wrong, file it — do not touch protocol math.

## Verdict: PASS — no wrong vectors found

File layout: `version: 1`, 22 `canonical` vectors, 2 `rejects`, 3 `signatures`, 1 `negative` bundle.

## Agreement (run 2026-09-23, fresh clone)

| Suite | Result |
|---|---|
| `npm ci && npm run build` | clean |
| `npm test` (10 workspaces) | **311/311 pass** (core 39, keystore 22, merkle-log 71, billing 39, issuer 44, anchor 8, verify-api 31, ops 35, badge 10, mcp 12) |
| `npm run test:py` (venv per README) | **39/39 pass** |

TS and Python agree on every shared vector. Note: the sandbox had no system `pytest`; I created a venv and installed `requirements.txt` exactly as the README prescribes — that path works.

## Hand spot-checks (against RFC 8785, not against the code)

| Vector | Check | Result |
|---|---|---|
| `unicode-bmp` (`{"café":1}`) | BMP chars must be emitted as raw UTF-8, not `\u00e9` | ✅ expected `{"café":1}` — correct |
| `unicode-astral-value` (`{"emoji":"🍕"}`) | Astral chars in values: raw UTF-8, no surrogate escaping | ✅ correct |
| `astral-key-order` (`𝄞,€,é,z`) | Sort by UTF-16 code units: `z`(0x7A) < `é`(0xE9) < `€`(0x20AC) < `𝄞`(0xD834…) | ✅ expected `{"z":1,"é":2,"€":3,"𝄞":4}` — correct |
| `nested` | Recursive key sort, zero whitespace | ✅ `{"a":[3,2,1],"m":null,"z":{"c":3,"d":4}}` — correct |
| `float-big-int-like` (`5000000000000000.0`) | Integral-valued float serializes as integer (RFC 8785 §3.2.2.4) | ✅ `5000000000000000` — correct |
| `float-repeating` (`0.30000000000000004`) | Shortest round-trip representation preserved | ✅ correct |
| `attestation-shaped` | Realistic attestation: nested claim objects also key-sorted | ✅ correct |
| `rejects` (`float-exp`, `unsafe-int`) | Non-JCS inputs rejected | ✅ present and tested |
| `negative` (`wrong_key_public_hex`) | Signatures must NOT verify under wrong key; flipped message byte must fail | ✅ present; tamper tests pass in both languages |

## Notes

- The three `signatures` vectors are deterministic Ed25519 test vectors; both implementations verify them, and the negative bundle covers the failure modes. No independent third-party regeneration of the sig vectors was performed in this pass — they are self-consistent across the two implementations, which is what the AC requires.
- `version: 1` is present; any future vector change must bump it and be re-reviewed. Do not silently edit expectations.
