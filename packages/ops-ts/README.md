# @factlock/ops — operations trust loop (T9–T12)

The human side of FactLock: field visits, the review console, the dispute
lifecycle engine, and the re-verification scheduler. Consumes
`@factlock/issuer`, `@factlock/verify-api`, `@factlock/keystore`,
`@factlock/merkle-log`. HTTP is `node:http` only; stores are interfaces with
in-memory v1 implementations (Postgres later).

## T9 — verifier visits

`POST /v1/visits` records a field visit. Enforced (spec §3):

- the business must exist in the directory;
- visit GPS must be within **500 m** of the registered coordinates
  (`422 gps_out_of_range`, with the measured distance);
- any **price** claim on the checklist requires `evidence_refs`
  (`422 evidence_required`).

`arrived_at` is stamped from the server clock; `device_time` is metadata only.

`GET /v1/verifiers/:id/accuracy` — the accuracy-based compensation input
(spec §3.2):

```
accuracy = (matured visits with no dispute opened within 30 days of the visit)
           / (matured visits)
```

A visit is *matured* once it is older than 30 days. A dispute counts against
a visit when it targets the visit's `attestation_id`, or — when the visit
produced no attestation — any dispute for the same business opened within 30
days after the visit. `accuracy` is `null` until the first visit matures.

## T10 — review console

- `POST /v1/flags` `{attestation_id, source, reason, evidence_refs?}` —
  source is `anomaly-detector | mystery-shopper | public-report`.
- `GET /v1/flags?status=open` — the review queue.
- `POST /v1/flags/:id/resolve` `{decision, reviewer_id, notes?}` —
  decision is `confirm | dispute | clear`. Every resolution appends an
  **immutable audit-trail entry** (spec §1.1: actor, action, subject, time).
  A `dispute` decision escalates into the T11 lifecycle engine and returns
  the new `dispute_id`.

## T11 — dispute lifecycle

```
ACTIVE → DISPUTED → CORRECTED | SUSPENDED | CLEARED
                               ↘ 3rd strike → REVOKED (permanent)
```

- `POST /v1/disputes` `{attestation_id, opened_by, reason}` — one open
  dispute per attestation; flips the verify-api status registry to
  `DISPUTED` in a single write (spec §7: verifiers see it immediately,
  no re-issuance).
- `POST /v1/disputes/:id/resolve` `{outcome, reviewer_id, notes?,
  corrected_request?}`:
  - `corrected` — requires `corrected_request` (a full issue request);
    re-issues through `@factlock/issuer` with `subject.supersedes_id` set,
    stores the new attestation, marks the old one `CORRECTED`. Strike +1.
  - `suspended` — marks `SUSPENDED`. Strike +1.
  - `cleared` — marks `CLEARED`. No strike.
  - `revoked`, or a third strike on any outcome — permanent `REVOKED`:
    appends a revocation record to the transparency log and marks the
    CDN-mirror entry (`CdnMirror` interface; in-memory v1, real CDN purge
    in production).

## T12 — re-verification scheduler

`dueForReverification(now, attestations)` returns attestations past **70%**
of their re-verification interval (the AGING threshold, spec §8), most
urgent first. Malformed intervals are skipped, never crash the run.

```bash
# daily cron — prints the due queue as JSON
0 6 * * * /usr/bin/node /opt/factlock/ops/dist/scripts/scheduler-run.js \
  --attestations /var/lib/factlock/attestations.jsonl
node dist/scripts/scheduler-run.js --attestations ./att.jsonl --now 2026-10-15T12:00:00Z
```

## Run

```bash
npm install && npm test   # 26 tests, node:test
```

Dependency build order (the `file:../` convention): npm symlinks `file:`
dependencies, so build `core-ts`, `log-ts`, `keystore-ts`, `issuer-ts` and
`verify-api-ts` (their `dist/`) before running `tsc` here — no reinstall
needed after that.
