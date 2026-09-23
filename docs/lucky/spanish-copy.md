# Spanish copy review — badge + landing

**Reviewer:** Lucky · **Date:** 2026-09-23 · **Repo head:** `387cc50`
**Source files:** `packages/badge-ts/src/i18n.ts`, `packages/badge-ts/src/render.ts`, `site/dist/index.html`, `site/dist/app.js`

## Verdict

The Spanish is native-sounding South Florida Spanish — formal *usted*, no textbook-Spain constructions, no Spanglish. Meaning matches EN on every string. **One overclaim found, and it's in the English landing copy** (flagged below, not in the ES strings).

## Line-by-line notes (`i18n.ts` ES dict)

| Key | ES | Note |
|---|---|---|
| `page_title` | "Verificación de negocio — {business}" | Natural. |
| `verified_by` | "Verificado por FactLock" | Good. |
| `view_full` | "Ver verificación completa" | Good. |
| `claims_heading` | "Afirmaciones verificadas" | Good ("datos verificados" would also work; no change needed). |
| `status_ACTIVE` | "Activa" | Feminine agrees with *la certificación* — consistent across all statuses, fine, but the agreement target is implicit. If the chip ever labels *el negocio*, this breaks. Worth a code comment. |
| `status_DISPUTED` | "En revisión" | Perfect. Matches the banner ("EN REVISIÓN"). |
| `status_SUSPENDED` | "Suspendida" | Good. |
| `status_REVOKED` | "Revocada" | Good. |
| `status_CORRECTED` | "Corregida" | Good. |
| `status_CLEARED` | "Desestimada" | **Nit.** EN "Cleared" = the attestation survived the dispute. "Desestimada" reads as "the complaint was dismissed" — close, but slightly legalistic and complaint-centered. Consider "Aclarada" or "Sin hallazgos". Not wrong enough to block. |
| `under_review_banner` | "EN REVISIÓN desde el {date} — considere estas afirmaciones como no confiables hasta su resolución." | Excellent. Usted form, unambiguous. |
| `revoked_banner` | "REVOCADA — esta certificación fue revocada permanentemente. No confíe en estas afirmaciones." | Good. |
| `suspended_banner` | "SUSPENDIDA — esta certificación está suspendida pendiente de revisión." | Good, natural. |
| `freshness_FRESH` | "Vigente" | **Good localization, not a literal translation.** "Fresco" would be nonsense here; "vigente" is what a Miamian says about an active license/verification. Keep. |
| `freshness_AGING` | "Por vencer" | Natural. |
| `freshness_STALE` | "Vencida" | Slight meaning shift from EN "Stale" (unreliable) → "expired", but for a verification past its re-verification date this is the natural SoFL reading. Acceptable. |
| `freshness_line` | "{verdict} · {age} días · verificado el {date}" | Good. |
| `expired_note` | "Vencida — pasó su fecha de re-verificación." | Good. |
| `prices_attested` | "{n} precios verificados" | Good. |
| `withheld` | "verificado, detalles no publicados" | Good — plain and honest. |
| `not_found` / `not_found_body` | "Certificación no encontrada" / "No existe una certificación con este ID. Revise el enlace e inténtelo de nuevo." | Natural, usted form consistent. |
| `point_in_time` | "Una declaración puntual de afirmaciones verificadas, no una garantía de desempeño futuro." | **The most important string on the badge, and it's translated correctly.** This is the anti-overclaim line — do not let anyone soften it in either language. |

## Overclaim scan

Checked for: self-custody implications, "on-chain guaranteed", "T14 production live", "signed by the business" without caveat.

- **ES strings: clean.** Nothing implies the business holds its own keys; nothing mentions a chain at all.
- **Landing FAQ (`site/dist/app.js`): clean.** The blockchain answer says "Periodic anchoring *can* establish that a log root existed at a given time; verification does not require a blockchain transaction for every claim." Honest.
- **🚩 Landing hero mock (`site/dist/index.html:57`): "Signed by business + FactLock".** This is the exact landmine Grok's handoff names. In v1 **FactLock holds the business key** — the business does not sign with its own key. "Signed by business" without the detectability caveat will mislead a reader into believing self-custody. Recommended fix: "Countersigned by FactLock · business-authorized" or add the one-line caveat ("v1: FactLock holds issuance keys; the signed auth trail makes rogue issuance detectable"). **Do not ship the landing page with this line as-is.**

## Notes for the demo

- `pickLang`: `?lang=es` wins, then first `Accept-Language` tag, default EN. Sensible.
- Currency formatting uses `Intl.NumberFormat("es")` for ES — amounts will render `89,00 US$`-style. Correct for the audience.
- No Spanish is claimed on the landing page itself (it's EN-only) — no inconsistency, just a future i18n job if the landing goes to the beachhead market.
