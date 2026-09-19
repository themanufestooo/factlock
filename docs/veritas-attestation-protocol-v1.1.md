# Veritas Attestation Protocol — v1.1

**Status:** Build-ready · **Date:** 2026-09-19 · **Entity:** EYFE Services LLC (interim)
**Supersedes:** v1.0 draft. All eight red-team amendments (2026-09-19) folded in; see Changelog §12.

---

## 1. What an attestation is

An attestation is a **signed, timestamped, publicly-auditable statement** by a business about its own claims (price, hours, availability, license), countersigned by Veritas after verification. An agent uses it to answer one question before transacting: *"is this claim true, right now, and who stands behind it?"*

Design principles:
1. **Verifiable by a stranger.** Any agent, on any platform, verifies without asking Veritas for permission.
2. **Freshness is honest.** Every attestation says exactly when it was verified. Stale data is labeled stale, never silently trusted.
3. **Lying is expensive.** False attestation triggers disputes, flags, and suspension — enforced, not theoretical.
4. **Cheap to check, cheap to issue.** Verification of an attestation must be free and instant. (This is why the hot path is not on-chain.)

### 1.1 Trust model (read this first)

v1 uses **Veritas-custodied business keys** (see §3). We state this plainly because the alternative — implying the business holds keys it does not — would be theater:

- **What v1 trust actually is:** trust in Veritas *operations* (key custody, verifier program, review discipline).
- **What the real guarantee is:** **detectability, not prevention.** Every countersignature is appended to a public, append-only Merkle transparency log whose root is anchored on-chain daily (§4). Any forgery — by anyone, including a rogue Veritas insider — is permanently, publicly visible and provably attributable (or provably *un*attributable, via the authorization trail in §3.2, which is worse for the forger).
- **v2 (business self-custody, bring-your-own-key):** committed for **month 6** after launch, not "later." The authorization-trail schema in §3.2 is designed so v2 is a key-ownership migration, not a protocol rewrite.

This framing ships on the landing page, not just in this spec. It is a stronger story than pretending at decentralization.

---

## 2. Attestation object (JSON)

Canonical encoding: **JCS (RFC 8785)** before signing. All timestamps UTC (RFC 3339). Money in integer minor units.

```json
{
  "attestation_id": "vat_01K5EXAMPLE",
  "protocol_version": "1.1",
  "status": "ACTIVE",
  "subject": {
    "business_id": "biz_rapido_plumbing",
    "legal_name": "Rapido Plumbing LLC",
    "dba": "Rapido Plumbing",
    "address": {
      "street": "1234 W Broward Blvd",
      "city": "Fort Lauderdale",
      "state": "FL",
      "postal": "33312"
    },
    "phone": "+1-954-555-0142",
    "website": "https://rapidopb.example"
  },
  "claims": [
    {
      "type": "license",
      "authority": "FL DBPR",
      "license_number": "CFC1423456",
      "status": "active",
      "checked_at": "2026-09-19T12:00:00Z"
    },
    {
      "type": "hours",
      "timezone": "America/New_York",
      "schedule": [
        {"day": "mon", "open": "08:00", "close": "18:00"},
        {"day": "tue", "open": "08:00", "close": "18:00"},
        {"day": "wed", "open": "08:00", "close": "18:00"},
        {"day": "thu", "open": "08:00", "close": "18:00"},
        {"day": "fri", "open": "08:00", "close": "18:00"},
        {"day": "sat", "open": "09:00", "close": "13:00"}
      ]
    },
    {
      "type": "price",
      "item": "service_call_diagnostic",
      "description": "Diagnostic visit, fee credited toward repair",
      "amount": 8900,
      "currency": "USD",
      "unit": "per_visit",
      "disclosed": true
    },
    {
      "type": "price",
      "item": "water_heater_install_labor",
      "amount": 45000,
      "currency": "USD",
      "unit": "per_job",
      "disclosed": false
    },
    {
      "type": "availability",
      "service": "emergency_same_day",
      "available": true
    }
  ],
  "verified_at": "2026-09-19T12:00:05Z",
  "device_time": "2026-09-19T11:58:41Z",
  "valid_until": "2026-10-19T12:00:05Z",
  "verification_method": "field_visit",
  "verifier_id": "ver_007",
  "evidence_refs": [
    "photo:storefront_hours_sign",
    "photo:license_document",
    "gps:26.1224,-80.1373"
  ],
  "authorization": {
    "auth_id": "auth_9f31ab",
    "session_id": "sess_71c0d2",
    "sms_confirmation_ref": "sms_55e019",
    "authorized_at": "2026-09-19T11:59:58Z",
    "authorized_by": "owner-on-file"
  },
  "signatures": {
    "business": {"alg": "Ed25519", "key_id": "bkey_rapido_01", "sig": "BASE64..."},
    "veritas":  {"alg": "Ed25519", "key_id": "vkey_main_01",  "sig": "BASE64..."}
  },
  "log": {
    "tree": "veritas-main",
    "leaf_index": 48213,
    "root": "HEX..."
  }
}
```

### Claim types (v1) and exact freshness policy

`AGING` begins at **70%** of the re-verification interval; `STALE` at **100%** (past `valid_until` the attestation is rejected outright — never silently trusted). The verdict always carries the claim's age.

| Type | Attests | Re-verify interval | AGING at | STALE at |
|---|---|---|---|---|
| `identity` | Legal name, address, phone, website | 365 days | 256 days | 365 days |
| `license` | License number + active status at an authority | 30 days | 21 days | 30 days |
| `hours` | Weekly schedule + timezone | 90 days | 63 days | 90 days |
| `price` | A named price-list item, amount, unit | 30 days | 21 days | 30 days |
| `availability` | A named service/capability flag | 7 days | 5 days | 7 days |

v2 candidates: `insurance`, `reviews_aggregate`, `service_area` (geo-polygon).

### Selective price disclosure

Price claims carry a `disclosed` flag. The business chooses per item which prices are publicly attested — competitive sensitivity is real, and more attestations happen when disclosure is voluntary. The badge shows e.g. "12 prices attested" regardless; undisclosed items are signed and logged (so the business can't later deny them) but their amounts are not served on public endpoints.

---

## 3. Signing

- **Algorithm:** Ed25519. Keys identified by `key_id`; public keys published at `/.well-known/veritas-keys.json`.
- **Two signatures required:**
  1. **Business signature** — the business approves the exact claims. v1: Veritas generates and custodies the business keypair in an HSM; the business authorizes via a verified channel (logged-in approval + SMS confirmation). This is custodial and we say so openly (§1.1). v2 (month 6): business self-custody / bring-your-own-key.
  2. **Veritas countersignature** — applied only after verifier evidence passes review. This is what makes it a *Veritas attestation* rather than a self-assertion.
- **What is signed:** the canonical JSON of everything except the `signatures` and `log` blocks.

### 3.2 Business authorization trail (anti-forgery)

Every countersignature MUST reference an authorization record; issuance without one is rejected (§8, `POST /v1/businesses/{id}/attest` returns 422). The record contains:

- `auth_id`, `session_id` (owner's logged-in session), `sms_confirmation_ref` (SMS one-time confirmation; TCPA consent captured at onboarding — see §9)
- `authorized_at` (server time), `authorized_by` (`owner-on-file`)

Authorization records are stored immutably and hash-linked into the transparency log alongside the attestation. Consequence: a forged attestation with no matching authorization record is **provably rogue** — detectable by anyone replaying the log. This is the mechanism that makes custodial keys safe *enough* for v1: forgery doesn't require trusting us, it requires us to leave permanent public evidence of the forgery.

---

## 4. Transparency log + anchoring (the "blockchain question," answered)

- Every countersigned attestation is appended to the **`veritas-main` Merkle tree**. The log is public: anyone can fetch leaves and inclusion proofs.
- **Anchoring:** once every 24h (or every 10,000 leaves, whichever comes first), the Merkle root is published in a single on-chain transaction. The anchor record `{chain, tx_hash, block_height, root}` is published alongside the log.
- **What this guarantees:** history cannot be rewritten without breaking the anchored roots. Verification of any attestation = signature checks + Merkle inclusion proof against a root that is itself anchored on-chain.
- **Cost:** ~1 tx/day (a few dollars/month) instead of per-attestation fees. Verification stays free and instant.

### 4.1 Revocation without a single point of failure

Revocations are **log entries in the same anchored tree**, not just rows behind our API. The revocation list is published to the transparency log and mirrored on CDN. Agents can verify revocation status offline against the last anchored root.

- Cache TTL: **1 hour** for standard revocation data, **5 minutes** for dispute-flagged attestations.
- Our API is the convenient path, never the only path. If our API is down, censored, or gone, agents fail over to log + CDN + anchored roots.

---

## 5. Verification algorithm (what an agent does)

```
1. GET /v1/businesses/{id}/attestation  → attestation object
2. Reject if now > valid_until.
3. Reject if status != ACTIVE (see §7 lifecycle: DISPUTED/SUSPENDED/REVOKED).
4. Compute freshness per claim type against the §2 table (70%/100% rule).
   → return FRESH / AGING (with age in days) / STALE — never silently trust.
5. Verify business signature against published business public key.
6. Verify Veritas countersignature against published Veritas key.
7. Fetch inclusion proof; verify leaf against the published Merkle root.
8. (Optional, high-value transactions) verify the root's on-chain anchor.
9. Check the revocation list (log/CDN/API, in that fallback order) for attestation_id.
→ Return: claims + freshness verdict + status + proof bundle.
```

Total: milliseconds, zero cost, no API key required for verification. (Issuance and metered bulk queries are the paid surfaces — verification itself must be free or nobody builds on it.)

---

## 6. Freshness, re-verification, revocation

- **Re-verification cadence** per claim type (§2 table, exact day counts). Automated nudges to the business first ("confirm your prices are still current — one tap"), field re-check on a rotating sample.
- **`verified_at` is server-stamped.** It is set at evidence acceptance by Veritas servers. The verifier device's clock is recorded as `device_time` metadata only — device clocks can be wrong or manipulated, and v1.0's ambiguity here was a skew attack waiting to happen.
- **Revocation:** Veritas can revoke an attestation (key compromise, business closure, failed dispute → 3 strikes). Revocations are logged entries (§4.1). Agents check the revocation list as step 9.
- **Voluntary update:** business changes a price → new attestation supersedes the old; the old remains in the log (history is append-only).

---

## 7. Disputes (the trust engine)

### 7.1 Claim lifecycle

```
ACTIVE → DISPUTED → CORRECTED | SUSPENDED | CLEARED
              ↘ (3rd strike) REVOKED (permanent, public record)
```

- **Filing:** anyone (customer, agent, competitor) files: `POST /v1/disputes {attestation_id, claim_ref, evidence}`. Refundable deposit, rate-limited (anti-spam; forfeited if ruled frivolous).
- **The moment a dispute is filed,** the attestation's `status` flips to `DISPUTED` — within 60 seconds, on the badge page, the API, and the log. The public badge shows a prominent **UNDER REVIEW since {date}** banner. Agents MUST treat `DISPUTED` as untrusted (equivalent to STALE for selection purposes) until resolution. There is no window in which agents keep booking on a claim someone has credibly challenged.
- **Business has 48 hours** to respond with counter-evidence or a correction. **Unresolved at 48h → auto-escalation** to human review; the attestation stays flagged the entire time.
- **Outcomes:**
  - **CORRECTED** → attestation corrected + re-issued; strike recorded.
  - **CLEARED** → dispute rejected; attestation returns to ACTIVE; frivolous filers rate-limited, deposit forfeited.
  - **SUSPENDED** → 2 strikes in 12 months = badge suspended 30 days, public flag on the verification page.
  - **REVOKED** → 3 strikes = permanent revocation + public record.
- All dispute outcomes are published. **The willingness to suspend paying customers is the product.** If we won't do it, the badge means nothing.

---

## 8. Verifier program (the oracle problem, handled)

The system is only as honest as its field verifiers. v1 treats verifier fraud as the primary attack surface, not an edge case:

1. **Independent checks, not verifier-asserted.** License status is checked **server-side against FL DBPR at issuance time**. The verifier's job is identity binding (this business = this license), not the license lookup itself. A verifier cannot attest a license the state says is inactive — the countersignature is blocked automatically.
2. **Pay for accuracy.** Verifier comp = base per verification + accuracy bonus − clawback on failed audits. Auditor stats published internally; consistently low-accuracy verifiers are removed.
3. **Mystery-shopper re-verification.** Random, unannounced re-checks on **5% of attestations monthly**, weighted toward high-value claims (prices). Unpredictable selection — never round-robin guessable. This is the only real defense against "show one price to the verifier, charge another."
4. **Evidence standards.** Photos must be taken **in-app** (no uploads) with EXIF preserved; GPS captured at evidence time and cross-checked against the business address — **>500m mismatch flags for human review**; mock-location/spoofed GPS detected and flagged. Evidence bundles are hashed client-side; the server recomputes and compares.

---

## 9. Liability, terms, and consent (legal gate)

> **Build gate: an attorney must sign off on the terms below before the first paid badge ships. No exceptions.**

- An attestation is a **point-in-time statement of verified claims, not a guarantee of future performance.** The terms say this in plain language, in English and Spanish.
- **Liability cap:** Veritas's liability for any attestation is capped at the subscription fees paid by the attesting business in the 12 months preceding the claim (or a fixed low cap set by counsel, whichever is lower).
- **Remedy for wrong attestations is dispute/suspension** (§7), not damages.
- **TCPA consent:** the SMS confirmation used in the authorization trail (§3.2) requires express written consent captured at business onboarding, with the exact consent language counsel approves.
- These terms are versioned, and the terms version is recorded on each attestation's authorization record.

---

## 10. Identity proofing (Sybil resistance)

Field visits make fake businesses expensive to attest, but a determined actor could still poison agent selection or farm badges at scale. v1 defenses:

- **Onboarding proofing:** EIN confirmation + utility bill or lease in the business's legal name before the first verification visit is scheduled.
- **Cost-of-verification as economic barrier:** the verification fee itself prices out bulk fakery.
- **Anomaly detection on verifier patterns:** same device across supposedly distinct businesses, impossible travel times between visits, GPS clusters — all flag for human review.

---

## 11. API sketch (v1)

```
GET  /v1/businesses/{id}/attestation      → current attestation (free)
GET  /v1/attestations/{id}                → by ID, incl. superseded (free)
GET  /v1/log/proof?leaf={index}           → Merkle inclusion proof (free)
GET  /v1/log/anchors                      → on-chain anchor records (free)
GET  /v1/revocations                      → revocation list (free, CDN-mirrored)
POST /v1/disputes                         → file a dispute (refundable deposit, rate-limited)
POST /v1/businesses/{id}/attest           → issuance (authenticated, paid; 422 without authorization record)
```

**Distribution is three-legged from day one** (never MCP-only): direct REST API + **MCP server** (`veritas_check(business_id, claim_types[])` → claims + freshness verdict + proof bundle) + **embeddable JS badge** for business websites. Rented land gets no single points of failure.

**Reference implementations:** signing/verification libraries ship in **TypeScript and Python** with shared cross-language test vectors (build ticket T1).

---

## 12. Paid surfaces (where the money is)

1. **Verification subscription** — $49/mo founding, $79/mo standard. Badge, hosted page, re-verification.
2. **Issuance/re-verification fees** — bundled in subscription v1; metered later at volume.
3. **API tolls** — free verification; paid tiers for bulk/metered query volume (integrators, platforms).
4. **Dispute deposits** — refundable on filing; forfeited if ruled frivolous.
5. **Later:** reliability data products, attested-error insurance.

---

## 13. Open questions for v2

- Business self-custody of keys (committed: month 6 — this is a date, not a question).
- `insurance` and `service_area` claim types.
- Cross-attestation: one business attesting another (supply-chain truth).
- Second metro expansion criteria (what "ready" looks like).
- Whether anchor cadence should tighten to hourly at volume.

---

## 14. Changelog — v1.0 → v1.1 (red-team amendments)

| # | Amendment | Sections |
|---|---|---|
| 1 | Honest custodial-key framing; authorization-trail requirement; v2 self-custody committed to month 6 | §1.1, §3, §3.2 |
| 2 | Server-side license checks; verifier accuracy comp; 5% mystery-shopper program; in-app evidence standards (EXIF, GPS 500m rule) | §8 |
| 3 | `DISPUTED` claim lifecycle state; UNDER REVIEW flag within 60s; agents treat as untrusted; 48h auto-escalation | §2, §5, §7.1 |
| 4 | Liability cap (fees-paid); point-in-time language; attorney sign-off gate before first paid badge; TCPA consent | §9 |
| 5 | Revocation via anchored log + CDN mirror; cache TTLs (1h standard / 5min dispute-flagged); API never the only path | §4.1, §5 |
| 6 | Exact freshness table: AGING at 70%, STALE at 100%, per claim type, in days | §2 |
| 7 | `verified_at` = server timestamp at evidence acceptance; device time is metadata only | §2, §6 |
| 8 | Per-item selective price disclosure (`disclosed` flag) | §2 |
| + | Identity proofing / Sybil resistance (EIN + utility bill/lease, anomaly detection) | §10 |
| + | Three-legged distribution (REST + MCP + embed); TS + Python reference libs | §11 |

*Spec v1.1 — 2026-09-19 · Build-ready. Next: build tickets T1–T14.*
