/**
 * Badge rendering (T7): hosted HTML page + embeddable script + data payload.
 *
 * Security notes:
 * - Business names, claim items, and every other attestation field are
 *   untrusted input: everything interpolated into HTML goes through esc().
 * - Undisclosed price amounts are NEVER rendered (spec §2) — the data payload
 *   carries counts, not amounts, for withheld items.
 */
import type { Attestation } from "@veritas/issuer";
import type { VerificationResult } from "@veritas/verify-api";
import { pickLang, t, type Lang } from "./i18n.js";

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

export function businessName(att: Attestation): string {
  const s = att.subject as Record<string, unknown>;
  return String(s.legal_name ?? s.dba ?? s.business_id ?? "Unknown business");
}

function money(amount: unknown, currency: unknown, lang: Lang): string {
  const cur = typeof currency === "string" && currency ? currency : "USD";
  const major = Number(amount ?? 0) / 100;
  try {
    return new Intl.NumberFormat(lang === "es" ? "es" : "en", {
      style: "currency",
      currency: cur,
    }).format(major);
  } catch {
    return `${major.toFixed(2)} ${cur}`;
  }
}

export interface PriceLine {
  item: string;
  label: string;
  withheld: boolean;
}

export function priceLines(att: Attestation, lang: Lang): PriceLine[] {
  const out: PriceLine[] = [];
  for (const c of att.claims as Array<Record<string, unknown>>) {
    if (c.type !== "price") continue;
    const item = String(c.item ?? "price");
    if (c.disclosed === false) {
      out.push({ item, label: `${item} — ${t(lang, "withheld")}`, withheld: true });
    } else {
      out.push({ item, label: `${item} — ${money(c.amount, c.currency, lang)}`, withheld: false });
    }
  }
  return out;
}

function claimLabel(c: Record<string, unknown>): string {
  const s = c as Record<string, unknown>;
  switch (s.type) {
    case "identity":
      return `Identity: ${s.legal_name ?? s.dba ?? ""}`.trim();
    case "license":
      return `License: ${s.license_number ?? s.number ?? ""}`.trim();
    case "hours":
      return `Hours: ${s.timezone ?? ""}`.trim();
    case "availability":
      return `Availability: ${s.service ?? s.item ?? ""}`.trim();
    default:
      return String(s.type ?? "claim");
  }
}

const DOT: Record<string, string> = {
  ACTIVE: "#16a34a",
  DISPUTED: "#d97706",
  SUSPENDED: "#dc2626",
  REVOKED: "#7f1d1d",
  CORRECTED: "#2563eb",
  CLEARED: "#16a34a",
};

export function dotColor(status: string): string {
  return DOT[status] ?? "#6b7280";
}

export interface BadgePageInput {
  attestation: Attestation;
  result: VerificationResult;
  lang: Lang;
  /** Public base URL of the verification API, for the "view full" link. */
  apiBaseUrl: string;
}

const CSS = `
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;background:#f8fafc;color:#0f172a}
.badge{max-width:640px;margin:32px auto;padding:28px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.chip{display:inline-block;padding:4px 12px;border-radius:999px;font-size:13px;font-weight:600;color:#fff}
.banner{margin:16px 0;padding:12px 16px;border-radius:10px;font-weight:600;font-size:14px}
.banner-review{background:#fef3c7;color:#92400e;border:1px solid #fcd34d}
.banner-revoked{background:#fee2e2;color:#991b1b;border:1px solid #fca5a5}
.banner-suspended{background:#ffedd5;color:#9a3412;border:1px solid #fdba74}
h1{font-size:24px;margin:12px 0 4px}
.fresh{color:#475569;font-size:14px;margin:0 0 16px}
h2{font-size:16px;margin:20px 0 8px;color:#334155}
ul{list-style:none;padding:0;margin:0}
li{padding:10px 0;border-top:1px solid #f1f5f9;font-size:15px}
.withheld-note{color:#64748b;font-size:13px}
footer{margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:13px;color:#64748b}
footer a{color:#166534;font-weight:600;text-decoration:none}
footer a:hover{text-decoration:underline}
.terms{margin-top:8px;font-size:12px;color:#94a3b8}
`;

export function badgePage(input: BadgePageInput): string {
  const { attestation: att, result: r, lang, apiBaseUrl } = input;
  const name = businessName(att);
  const verifyUrl = `${apiBaseUrl}/v1/verify/${encodeURIComponent(att.attestation_id)}`;
  const dot = dotColor(r.status);

  const banner =
    r.status === "DISPUTED"
      ? `<div class="banner banner-review">${esc(t(lang, "under_review_banner", { date: esc(r.verified_at.slice(0, 10)) }))}</div>`
      : r.status === "REVOKED"
        ? `<div class="banner banner-revoked">${esc(t(lang, "revoked_banner"))}</div>`
        : r.status === "SUSPENDED"
          ? `<div class="banner banner-suspended">${esc(t(lang, "suspended_banner"))}</div>`
          : "";

  const prices = priceLines(att, lang);
  const open = prices.filter((p) => !p.withheld);
  const hidden = prices.filter((p) => p.withheld);
  const other = (att.claims as Array<Record<string, unknown>>)
    .filter((c) => c.type !== "price")
    .map(claimLabel);

  const items = [
    ...open.map((p) => `<li>${esc(p.label)}</li>`),
    ...other.map((l) => `<li>${esc(l)}</li>`),
  ];
  if (hidden.length > 0) {
    items.push(
      `<li class="withheld-note">${esc(t(lang, "prices_attested", { n: hidden.length }))} — ${esc(t(lang, "withheld"))}</li>`,
    );
  }

  const freshLine = r.expired
    ? esc(t(lang, "expired_note"))
    : esc(t(lang, "freshness_line", {
        verdict: t(lang, `freshness_${r.freshness}`),
        age: r.age_days,
        date: r.verified_at.slice(0, 10),
      }));

  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t(lang, "page_title", { business: name }))}</title>
<style>${CSS}</style></head>
<body><main class="badge">
<span class="chip" style="background:${dot}">${esc(t(lang, `status_${r.status}`))}</span>
<h1>${esc(name)}</h1>
<p class="fresh">${freshLine}</p>
${banner}
<h2>${esc(t(lang, "claims_heading"))}</h2>
<ul>${items.join("")}</ul>
<footer>
<a href="${esc(verifyUrl)}">${esc(t(lang, "verified_by"))}</a> ·
<a href="${esc(verifyUrl)}">${esc(t(lang, "view_full"))}</a>
<p class="terms">${esc(t(lang, "point_in_time"))}</p>
</footer>
</main></body></html>`;
}

export function notFoundPage(lang: Lang): string {
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t(lang, "not_found"))}</title><style>${CSS}</style></head>
<body><main class="badge">
<h1>${esc(t(lang, "not_found"))}</h1>
<p>${esc(t(lang, "not_found_body"))}</p>
</main></body></html>`;
}

/** JSON payload for the embeddable badge — precomputed display strings included. */
export function badgeData(input: BadgePageInput): Record<string, unknown> {
  const { attestation: att, result: r, lang, apiBaseUrl } = input;
  const prices = priceLines(att, lang);
  const open = prices.filter((p) => !p.withheld);
  return {
    attestation_id: att.attestation_id,
    business_name: businessName(att),
    status: r.status,
    freshness: r.freshness,
    freshness_word: t(lang, `freshness_${r.freshness}`),
    age_days: r.age_days,
    verified_at: r.verified_at,
    lang,
    verified_by: t(lang, "verified_by"),
    view_full: t(lang, "view_full"),
    verify_url: `${apiBaseUrl}/v1/verify/${encodeURIComponent(att.attestation_id)}`,
    dot: dotColor(r.status),
    prices: {
      disclosed: open.map((p) => ({ item: p.item, label: p.label })),
      attested_count: prices.length,
      withheld_count: prices.length - open.length,
    },
  };
}

/**
 * The embeddable badge script (/badge.js). Vanilla JS, no dependencies,
 * no cookies (fetch with credentials:"omit"), CORS-friendly.
 *
 * Usage:
 *   <script src="https://badge.example.com/badge.js" data-veritas-badge
 *           data-attestation-id="vat_..." data-lang="es"></script>
 */
export function badgeScript(): string {
  return `(function(){
"use strict";
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
function baseOf(el){
  var b=el.getAttribute("data-api-base");
  if(b) return b.replace(/\\/$/,"");
  try{ if(el.src) return new URL(el.src).origin; }catch(e){}
  return "";
}
function html(d){
  return '<a href="'+esc(d.verify_url)+'" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:8px;font-family:system-ui,sans-serif;font-size:13px;color:#0f172a;text-decoration:none;border:1px solid #e2e8f0;border-radius:999px;padding:6px 12px;background:#fff;">'
    +'<span style="width:10px;height:10px;border-radius:50%;background:'+esc(d.dot)+';display:inline-block;"></span>'
    +'<span><strong>'+esc(d.verified_by)+'</strong> &middot; '+esc(d.freshness_word)+'</span></a>';
}
function mount(el){
  var id=el.getAttribute("data-attestation-id");
  if(!id) return;
  var lang=el.getAttribute("data-lang")||"en";
  var base=baseOf(el);
  var target=el;
  if(el.tagName==="SCRIPT"){
    var s=document.createElement("span");
    if(el.parentNode) el.parentNode.insertBefore(s,el.nextSibling);
    target=s;
  }
  fetch(base+"/badge/data/"+encodeURIComponent(id)+"?lang="+encodeURIComponent(lang),{credentials:"omit"})
    .then(function(r){ if(!r.ok) throw new Error("bad status"); return r.json(); })
    .then(function(d){ target.innerHTML=html(d); })
    .catch(function(){ /* leave unrendered rather than show a broken badge */ });
}
function init(){
  var els=document.querySelectorAll("[data-veritas-badge]");
  for(var i=0;i<els.length;i++){ mount(els[i]); }
}
if(document.readyState==="loading"){ document.addEventListener("DOMContentLoaded",init); }
else { init(); }
})();`;
}

export { pickLang, t, type Lang };
