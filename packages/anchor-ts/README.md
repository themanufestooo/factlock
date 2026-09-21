# @factlock/anchor (T5)

Daily anchoring of the Merkle transparency-log root. One anchor record per day:

```json
{
  "version": "factlock-anchor/1",
  "date": "2026-09-19",
  "tree": "factlock-main",
  "root": "9f2c…",
  "leaf_count": 1042,
  "prev_anchor_hash": "b71d…",
  "anchored_at": "2026-09-20T02:00:03Z",
  "provider": "local",
  "provider_ref": "local:2026-09-19:9f2c…",
  "record_hash": "c44a…"
}
```

`record_hash = SHA256(JCS(record minus record_hash and provider_ref))`.
Each record commits to the previous record's hash, so the chain is
tamper-evident. Anyone holding the log journal can recompute any historical
root — the journal is append-only, so replaying the first `leaf_count` leaves
reproduces the log's exact state on that date (`verifyAnchorForDate`).

## The cron job

```bash
cd packages/anchor-ts && npm install && npm run build
node dist/scripts/anchor-daily.js \
  --journal /var/lib/factlock/log.jsonl \
  --anchors /var/lib/factlock/anchors.jsonl \
  [--date 2026-09-19] [--tree factlock-main] [--verify]
```

Cron (daily 02:00 UTC):

```
0 2 * * * /usr/bin/node /opt/factlock/packages/anchor-ts/dist/scripts/anchor-daily.js --journal /var/lib/factlock/log.jsonl --anchors /var/lib/factlock/anchors.jsonl --verify >> /var/log/factlock-anchor.log 2>&1
```

systemd alternative: a `factlock-anchor.service` (oneshot, same ExecStart) plus a
`factlock-anchor.timer` with `OnCalendar=daily`.

Exit codes: 0 anchored (+ verified with `--verify`), 1 verification failed,
2 bad CLI args.

## Providers

- **local** (default): appends to the anchor JSONL. Free, offline, sufficient
  for dev and for v1 while the log itself is the trust anchor.
- **opentimestamps** (`src/providers/opentimestamps.ts`): shape of the
  production wiring — submits `SHA256("factlock-ots/1" || record_hash)` to
  public OTS calendars for a Bitcoin-anchored proof. **Disabled by default**;
  `anchor()` throws unless constructed with `{ enabled: true, calendars }`,
  so tests and dev runs can never broadcast or spend. No network calls in
  the test suite.

Going live with OTS (first production deploy):
1. `npm i opentimestamps` (or use the `ots` CLI) alongside this package.
2. Replace the stub return in `OpenTimestampsProvider.anchor` with: POST
   `buildCalendarPayload(digest)` to each calendar's `/digest` endpoint,
   collect the pending `.ots`, poll `/timestamp/:digest` until the calendar
   upgrades it to a Bitcoin attestation.
3. Store the resulting `.ots` file next to the anchor log as
   `anchors/2026-09-19.ots` and set `provider_ref` to `ots:<digest>`.
4. Publish the anchor log itself (it's small: one JSON line/day).

## Tests

`npm test` — 8 tests: 3-day chain build, per-date verification from the
journal, unknown date, journal tamper → `root_mismatch`, anchor tamper →
`record_hash_mismatch`, backwards-date refusal, OTS disabled-by-default.
