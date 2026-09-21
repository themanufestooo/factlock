/**
 * Billing service authentication (audit H-05).
 *
 * Two credential families:
 *  1. Customer tokens — FACTLOCK_BILLING_TOKENS: a JSON object of
 *       token -> { customer_id, roles: ["customer"] }
 *     End-user endpoints (status, preview, keys, checkout, portal, usage
 *     summary) require one, and the caller may only touch its own
 *     customer_id (tenant isolation).
 *  2. Service tokens — same map, { roles: ["service"] }.
 *     Deposit hold/release/forfeit require the service role.
 *
 * Usage ingestion is the special case: the API key SECRET itself is the
 * credential, presented as `Authorization: Bearer <secret>` and verified
 * against the stored hash with a constant-time comparison. A key_id alone
 * never authenticates.
 */
import { timingSafeEqual, createHash } from "node:crypto";
import { BillingError } from "./types.js";

export type BillingRole = "customer" | "service";

export interface BillingTokenRecord {
  roles: BillingRole[];
  /** Required for the customer role: the token is bound to this tenant. */
  customer_id?: string;
}

export interface BillingAuthContext {
  roles: BillingRole[];
  customerId?: string;
}

const VALID_ROLES = new Set<BillingRole>(["customer", "service"]);

export function parseBillingTokens(raw: string | undefined): Map<string, BillingTokenRecord> {
  const map = new Map<string, BillingTokenRecord>();
  if (!raw || raw.trim() === "") return map;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BillingError("billing_tokens_invalid", "FACTLOCK_BILLING_TOKENS is not valid JSON", 500);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BillingError("billing_tokens_invalid", "FACTLOCK_BILLING_TOKENS must be a JSON object", 500);
  }
  for (const [token, rec] of Object.entries(parsed as Record<string, unknown>)) {
    const r = rec as Record<string, unknown>;
    const roles = Array.isArray(r?.roles) ? (r.roles as unknown[]) : [];
    if (token.length < 16) {
      throw new BillingError("billing_tokens_invalid", "billing tokens must be at least 16 characters", 500);
    }
    if (roles.length === 0) {
      throw new BillingError("billing_tokens_invalid", "billing token record is missing roles", 500);
    }
    for (const role of roles) {
      if (!VALID_ROLES.has(role as BillingRole)) {
        throw new BillingError("billing_tokens_invalid", `unknown billing role ${String(role)}`, 500);
      }
    }
    if ((roles as string[]).includes("customer")) {
      if (typeof r?.customer_id !== "string" || r.customer_id === "") {
        throw new BillingError("billing_tokens_invalid", "customer tokens must bind a customer_id", 500);
      }
    }
    map.set(token, {
      roles: roles as BillingRole[],
      ...(typeof r?.customer_id === "string" ? { customer_id: r.customer_id } : {}),
    });
  }
  return map;
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Verifies a raw secret against a stored hex sha256 hash, constant-time. */
export function verifySecretHash(presented: string, storedHash: string): boolean {
  const presentedHash = Buffer.from(createHash("sha256").update(presented).digest("hex"), "utf8");
  const expected = Buffer.from(storedHash, "utf8");
  if (presentedHash.length !== expected.length) {
    timingSafeEqual(presentedHash, presentedHash);
    return false;
  }
  return timingSafeEqual(presentedHash, expected);
}

export function authenticateBilling(
  authHeader: string | undefined,
  tokens: Map<string, BillingTokenRecord>,
): BillingAuthContext {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new BillingError("unauthorized", "a Bearer billing token is required", 401);
  }
  const presented = authHeader.slice("Bearer ".length).trim();
  for (const [token, rec] of tokens) {
    if (constantTimeEquals(presented, token)) {
      return { roles: rec.roles, customerId: rec.customer_id };
    }
  }
  throw new BillingError("unauthorized", "invalid billing token", 401);
}

export function requireBillingRole(ctx: BillingAuthContext, role: BillingRole): void {
  if (!ctx.roles.includes(role)) {
    throw new BillingError("forbidden", `the ${role} role is required`, 403);
  }
}

/**
 * Tenant isolation (audit H-05): a customer token may only act on its own
 * customer_id. Throws 403 otherwise.
 */
export function enforceTenant(ctx: BillingAuthContext, customerId: string): void {
  requireBillingRole(ctx, "customer");
  if (ctx.customerId !== customerId) {
    throw new BillingError("forbidden", "cannot access another customer's billing data", 403);
  }
}
