# FactLock Protocol v1 — Red-Team Report

**Date:** 2026-09-19 · **Role:** adversarial review · **Verdict:** shippable after 5 required amendments. No fatal flaws; 3 structural weaknesses that must be designed around, not patched later.

---

## FINDING 1 — CRITICAL: Custodial keys make the business signature theater

**The attack:** In v1, FactLock generates and holds the business keypair. That means the "business signature" proves nothing — FactLock can sign any claim *as* the business. The dual-signature model collapses to single-party trust. If our HSM is compromised (or a rogue employee exists), every attestation is forgeable.

**Why it matters:** The whole pitch is "signed by the actual business." A sophisticated buyer or journalist will spot this in one reading.

**Recommended fix (spec amendment):**
- Be radically honest: v1 trust = trust in FactLock *operations*, and the real guarantee is **detectability, not prevention**. The transparency log + daily anchoring means any forgery is permanently, publicly visible. Say this on the landing page. It is a stronger story than pretending at decentralization.
- Business authorization trail: every countersignature must reference an authorization record (login session + SMS confirmation + timestamp), stored immutably. A forged attestation without an authorization record is provably rogue.
- v2 (self-custody) gets a committed date, not a vague "later": target month 6.

---

## FINDING 2 — CRITICAL: The oracle problem (verifiers can lie)

**The attack:** The system trusts the field verifier. Bribe a verifier $50 to attest a fake license; submit staged photos; spoof GPS on a rooted phone. At $20/verification with per-job pay, the incentive is speed, not accuracy.

**Recommended fixes (spec amendments):**
- **Independent checks, not verifier-asserted:** license status is checked *server-side* against FL DBPR at issuance time — the verifier's job is identity binding (this business = this license), not the license lookup itself.
- **Pay for accuracy:** verifier comp = base per verification + accuracy bonus − clawback on failed audits. Publish auditor stats internally.
- **Mystery-shopper re-verification:** random, unannounced re-checks on 5% of attestations monthly, focused on high-value claims (prices). This is the only real defense against "show one price to the verifier, charge another."
- **Evidence standards:** photos must include EXIF + be taken in-app (no uploads); GPS cross-checked against business address (flag >500m mismatch for human review).

---

## FINDING 3 — CRITICAL: Disputes need a DISPUTED state

**The attack:** A customer files a dispute against a false price attestation. The business has 48 hours to respond. During those 48 hours, the attestation is still live and agents keep booking on a lie. The dispute system protects FactLock's reputation *after* damage, not the customer *during* it.

**Recommended fix (spec amendment):** claim lifecycle becomes
`ACTIVE → DISPUTED (visible flag, agents treat as AGING/untrusted) → CORRECTED | SUSPENDED | CLEARED`.
The verification page shows "under review since {date}" prominently. A dispute that isn't resolved in 48h auto-escalates to human review + the attestation stays flagged. This is the difference between a trust system and a complaint box.

---

## FINDING 4 — HIGH: Liability must be capped before attestation #1

**The attack:** "FactLock attested the price was $89 and I got charged $400." Without a liability cap, every wrong attestation is a potential lawsuit, and plaintiffs will name the deeper pocket (FactLock, not the plumber).

**Recommended fix (spec amendment + legal):** Terms define attestation as a **point-in-time statement of verified claims, not a guarantee of future performance**. Liability capped at the subscription fee paid (or a fixed low cap). Dispute/suspension is the remedy, not damages. Attorney must sign off before the first paid badge ships. (Also: TCPA consent language for the SMS authorization flow.)

---

## FINDING 5 — HIGH: Revocation can't live only behind our API

**The attack/outage:** Agents check the revocation list via our API. If our API is down (or censored, or we're acquired and shut it down), agents either trust revoked attestations or fail closed and break. A trust primitive with a single point of failure isn't a primitive.

**Recommended fix (spec amendment):** revocation list is itself a logged, anchored data structure — published to the transparency log, mirrored on CDN, with a defined max cache TTL (1 hour for standard, 5 minutes for dispute-flagged). Agents can verify revocation status offline against the last anchored root. Our API is the convenient path, never the only path.

---

## FINDING 6 — MEDIUM: Freshness thresholds need exact numbers

The spec says FRESH / AGING / STALE but never defines the boundaries. An agent needs deterministic rules. **Recommended:** per claim type, `AGING` begins at 70% of the re-verification interval, `STALE` at 100% (past `valid_until` = rejected outright). A price attestation verified 29 days ago on a 30-day policy is *technically valid but practically stale* — the verdict must weight age, not just expiry. Exact table goes in spec v1.1.

## FINDING 7 — MEDIUM: Clock skew on `verified_at`

Verifier device clocks can be wrong (or manipulated). **Recommended:** `verified_at` = server timestamp at evidence acceptance, not device time. Device time is recorded as metadata only.

## FINDING 8 — MEDIUM: Price-list privacy (selective disclosure)

Some businesses won't want full price lists public (competitive sensitivity). **Recommended:** price claims are opt-in per item — the business chooses which items to attest publicly. The badge shows "12 prices attested" without forcing the whole book open. More attestations happen when disclosure is voluntary.

## FINDING 9 — MEDIUM: Sybil resistance for fake businesses

**The attack:** attest 1,000 fake businesses to poison agent selection or farm badges. Field visits make this expensive, but a determined actor could do it. **Recommended:** identity proofing at onboarding (EIN confirmation + utility bill or lease), cost-of-verification as the economic barrier, and anomaly detection on verifier patterns (same device, impossible travel times between visits).

## FINDING 10 — LOW: MCP dependence

The MCP wedge is strong distribution but it's rented land — platform owners can gate or tax it. **Recommended:** parallel paths from the start: direct REST API + embeddable JS badge widget for business websites. Never single-channel on distribution.

## FINDING 11 — LOW: Reference implementations

JCS (RFC 8785) canonicalization is correct, but integrators need it in their language. **Recommended:** ship reference signing/verification implementations in TypeScript + Python with cross-language test vectors. (Covered in build tickets.)

---

## Required spec amendments (v1.1)

1. Honest custodial-key framing + authorization-trail requirement + v2 self-custody date (month 6).
2. Server-side license checks; verifier accuracy comp; mystery-shopper program; in-app evidence standards.
3. `DISPUTED` claim state with agent-visible flagging + 48h auto-escalation.
4. Liability cap language (pending attorney sign-off) + TCPA consent.
5. Revocation via anchored log + CDN mirror; max cache TTLs defined.
6. Exact freshness threshold table (70%/100% rule).
7. Server-stamped `verified_at`.
8. Per-item selective price disclosure.

**Say the word and I cut spec v1.1 with all eight folded in.**
