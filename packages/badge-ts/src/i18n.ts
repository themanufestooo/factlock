/**
 * Badge i18n (T7) — English and Spanish from day one.
 * The terms page (§9 legal gate) requires plain language in both languages;
 * the badge carries the same obligation.
 */
export type Lang = "en" | "es";

type Dict = Record<string, string>;

const EN: Dict = {
  page_title: "Business verification — {business}",
  verified_by: "Verified by FactLock",
  view_full: "View full verification",
  claims_heading: "Verified claims",
  status_ACTIVE: "Active",
  status_DISPUTED: "Under review",
  status_SUSPENDED: "Suspended",
  status_REVOKED: "Revoked",
  status_CORRECTED: "Corrected",
  status_CLEARED: "Cleared",
  under_review_banner: "UNDER REVIEW since {date} — treat these claims as untrusted until resolved.",
  revoked_banner: "REVOKED — this attestation was permanently revoked. Do not trust these claims.",
  suspended_banner: "SUSPENDED — this attestation is suspended pending review.",
  freshness_FRESH: "Fresh",
  freshness_AGING: "Aging",
  freshness_STALE: "Stale",
  freshness_line: "{verdict} · {age} days old · verified {date}",
  expired_note: "Expired — past its re-verification date.",
  prices_attested: "{n} prices attested",
  withheld: "verified, details withheld",
  not_found: "Attestation not found",
  not_found_body: "No attestation exists with this ID. Check the link and try again.",
  point_in_time: "A point-in-time statement of verified claims, not a guarantee of future performance.",
};

const ES: Dict = {
  page_title: "Verificación de negocio — {business}",
  verified_by: "Verificado por FactLock",
  view_full: "Ver verificación completa",
  claims_heading: "Afirmaciones verificadas",
  status_ACTIVE: "Activa",
  status_DISPUTED: "En revisión",
  status_SUSPENDED: "Suspendida",
  status_REVOKED: "Revocada",
  status_CORRECTED: "Corregida",
  status_CLEARED: "Desestimada",
  under_review_banner: "EN REVISIÓN desde el {date} — considere estas afirmaciones como no confiables hasta su resolución.",
  revoked_banner: "REVOCADA — esta certificación fue revocada permanentemente. No confíe en estas afirmaciones.",
  suspended_banner: "SUSPENDIDA — esta certificación está suspendida pendiente de revisión.",
  freshness_FRESH: "Vigente",
  freshness_AGING: "Por vencer",
  freshness_STALE: "Vencida",
  freshness_line: "{verdict} · {age} días · verificado el {date}",
  expired_note: "Vencida — pasó su fecha de re-verificación.",
  prices_attested: "{n} precios verificados",
  withheld: "verificado, detalles no publicados",
  not_found: "Certificación no encontrada",
  not_found_body: "No existe una certificación con este ID. Revise el enlace e inténtelo de nuevo.",
  point_in_time: "Una declaración puntual de afirmaciones verificadas, no una garantía de desempeño futuro.",
};

const DICTS: Record<Lang, Dict> = { en: EN, es: ES };

/** `?lang=es` wins; otherwise the first Accept-Language tag; default en. */
export function pickLang(queryLang: string | null, acceptLanguage: string | null): Lang {
  const q = (queryLang ?? "").toLowerCase();
  if (q === "es" || q === "es-es" || q.startsWith("es-")) return "es";
  if (q === "en" || q.startsWith("en-")) return "en";
  const first = (acceptLanguage ?? "").split(",")[0].trim().toLowerCase();
  if (first === "es" || first.startsWith("es-")) return "es";
  return "en";
}

export function t(lang: Lang, key: string, vars: Record<string, string | number> = {}): string {
  let s = DICTS[lang][key] ?? DICTS.en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) {
    s = s.replace(`{${k}}`, String(v));
  }
  return s;
}
