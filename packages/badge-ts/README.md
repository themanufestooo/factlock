# @factlock/badge (T7)

Hosted badge page + embeddable JS badge for business websites. English and
Spanish from day one (the §9 legal gate requires plain language in both).

## What a business embeds

```html
<script src="https://badge.factlock.example/badge.js"
        data-factlock-badge
        data-attestation-id="fla_..."
        data-lang="es"></script>
```

The script (vanilla JS, **< 15KB**, no dependencies, no cookies — `fetch` with
`credentials: "omit"`) fetches `/badge/data/:id` and renders a compact badge:
status dot + "Verified by FactLock" + freshness word, linking to the full
verification API response. Works cross-origin via `Access-Control-Allow-Origin: *`.

## Routes

- `GET /badge/:attestation_id` — hosted HTML page. `?lang=es` wins, then
  `Accept-Language`, else English. Shows business name, claim summary, status
  chip, freshness, and a "Verified by FactLock" link to the verification API.
- `GET /badge/data/:id` — JSON payload for the embed script (CORS `*`).
- `GET /badge.js` — the embeddable script.
- `GET /healthz` — liveness.

## Disclosure & safety rules

- **Undisclosed price amounts are never rendered** — not on the page, not in
  the data payload, not in the embed (spec §2: signed and logged, never
  published). Withheld items appear as counts: *"2 prices attested — verified,
  details withheld"*.
- **Every attestation field is untrusted input**: business names, claim items,
  everything goes through HTML escaping (tested with an XSS probe).
- `DISPUTED` shows a prominent **UNDER REVIEW** banner (spec §7: agents must
  treat it as untrusted); `REVOKED`/`SUSPENDED` show their banners.
- The page footer carries the point-in-time disclaimer in the page language
  (EN/ES), per §9.

## Run

```bash
npm install && npm test   # build + node:test suite
```

`createBadgeServer({ store, keystore, log, statuses?, clock?, apiBaseUrl })` —
`apiBaseUrl` is the public base URL of the verification API (T6), used for the
"view full verification" links and the badge's outbound link.
