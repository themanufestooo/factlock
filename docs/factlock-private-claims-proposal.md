# FactLock private claims: commitment and controlled-disclosure proposal

Status: design proposal — not yet part of protocol v1.1.

## Decision

Do not place an undisclosed value in a public transparency-log leaf. Replace it with a salted commitment, keep the underlying evidence encrypted, and reveal the value only through an explicitly authorized disclosure.

## Public record

For a private claim, publish only:

```json
{
  "type": "price",
  "item": "vip_deal",
  "disclosed": false,
  "commitment": {
    "alg": "sha-256",
    "value": "BASE64URL_DIGEST",
    "schema": "factlock-private-claim-v1"
  }
}
```

The commitment is computed over canonical JSON containing the claim, a random 256-bit salt, the attestation id, and the business id. Binding both identifiers prevents a commitment from being copied between records or businesses.

## Private record

Store the plaintext claim, salt, evidence, and authorization trail in an encrypted evidence vault. Use a unique data-encryption key per attestation, wrap it with the deployment KMS, and keep access events in an append-only audit log. The public API must never return the ciphertext, salt, internal storage location, or a reversible evidence reference.

## Disclosure flow

1. A requester presents an authenticated identity and a declared purpose.
2. Policy checks business consent, requester role, purpose, and expiry.
3. FactLock returns the minimum necessary claim plus its salt and public-record locator.
4. The recipient recomputes the commitment locally.
5. FactLock records who received which claim, why, and when.

Disclosures should be short-lived, audience-bound, and non-cacheable. Bulk export and wildcard claim access should be denied by default.

## Security properties

- The public log proves that the private value existed without publishing it.
- A disclosed value can be checked against the immutable commitment.
- A random salt prevents practical guessing of low-entropy values such as common prices.
- Removing the salt from public storage prevents offline dictionary attacks.
- Identifier binding prevents replay across attestations.

## Failure behavior

- Missing commitment, unsupported algorithm, malformed canonical payload, or commitment mismatch: `valid: false`.
- Unavailable policy service or evidence vault: deny disclosure.
- Revoked, disputed, superseded, stale, or expired attestation: deny disclosure even when the commitment matches.
- Key rotation failure: keep the record unavailable; never fall back to plaintext.

## Migration

Existing v1.1 records that logged private plaintext cannot be made private retroactively. Mark them as legacy, stop serving their raw leaves through public convenience endpoints, rotate any reusable evidence references, and reissue the claim under the commitment format. The old transparency entry remains as an immutable historical exposure and should be treated accordingly.

## Open decisions before implementation

- Whether authorized disclosure is online-only or may use recipient public-key encryption.
- Consent duration and revocation rules by claim type.
- Regulatory retention windows for evidence and access logs.
- Whether commitments use plain salted SHA-256 initially or a standardized selective-disclosure credential format in v2.
