# @veritas/billing — subscriptions + metered API billing (T13/T14)

Money for Veritas: Stripe subscriptions, per-query metering for integrators,
and the dispute-deposit ledger. **Code only** — no live Stripe keys, no real
charges, no network in tests. Every Stripe call goes through
`StripeClientLike`; webhook signature verification is pure HMAC via the
official `stripe` package. HTTP is `node:http` only; stores are interfaces
with in-memory v1 implementations (Postgres later).

## T13 — subscriptions

Plans are **data** (`src/plans.ts`), not logic:

| plan     | price      | API units/mo included | overage       |
|----------|------------|----------------------|---------------|
| founding | $49, locked for life | 1,000 | $0.05 / call |
| standard | $79        | 5,000                | $0.03 / call  |

The price a customer pays is **snapshotted onto the subscription at
creation** — a later catalog change can never move an existing customer, and
founding customers are immune by construction (tested: raising standard to
$99 leaves founders at $49).

Lifecycle: `active → past_due → canceled`. A failed payment sets
`past_due` with a **7-day grace window** (`grace_until`). The badge never
goes silently dark:

- `active` → badge "active"
- `past_due` inside grace → badge "grace" (shows a payment notice)
- `past_due` past grace, or `canceled` → badge "lapsed" ("verification lapsed")

During grace, the badge and customer portal stay live but new issuance and
metered API calls are paused (`isEntitled(customer, feature)`).

Webhooks (`POST /v1/billing/webhook`, signature-verified over the raw body):
`checkout.session.completed` (plan/customer from metadata),
`customer.subscription.updated`, `customer.subscription.deleted`,
`invoice.payment_failed` → grace, `invoice.paid` → recovered. Tampered
payloads are rejected with 400 before any state changes.

## T14 — metered API billing

- `POST /v1/api-keys {customer_id}` → key id + secret (shown once; only a
  SHA-256 hash is stored). Revocation: `POST /v1/api-keys/:id/revoke`.
- `POST /v1/usage/ingest {key_id, endpoint, units}` — internal metering path
  (called by the verify-API middleware); revoked keys and non-positive units
  are rejected.
- `GET /v1/usage/summary?customer_id=&month=` — live usage, included quota,
  and the **projected end-of-month bill** (linear projection). This is the
  T14 "integrator can see live usage and projected bill" surface.
- `GET /v1/billing/preview?customer_id=&month=` — exact invoice math
  `{plan, base, usage_units, overage_units, overage_cents, total}` with
  `charged: false`. Computed locally; **never calls Stripe** (asserted in
  tests via the recording stub).
- **Reconciliation AC:** `reconcile(customer, month)` replays the raw usage
  records and asserts the stored rollup matches within ±0.1% (in practice
  exact — any drift means records were mutated or lost).

## Dispute deposits (spec §4.4)

`POST /v1/deposits/hold {dispute_id, customer_id, amount_cents}` holds the
refundable filing deposit (`dispute_id` is opaque — ties to `@veritas/ops`
dispute ids). `…/release` returns it when the dispute resolves in the
filer's favor; `…/forfeit` burns it when ruled frivolous. Settlement is
one-way: a settled deposit can never move again (422).

## Run

```bash
npm install && npm test   # 27 tests, strict TS, no network
```
