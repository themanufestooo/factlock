/**
 * Ops service authentication (audit H-04): every ops endpoint requires a
 * bearer service token. Tokens map to an actor with roles; the actor's id
 * and business scope are derived from the token and can never be forged
 * via request bodies.
 *
 * Token map is configured as FACTLOCK_OPS_TOKENS: a JSON object of
 *   token -> { actor_id, roles[], business_id? }
 * Tokens compare in constant time.
 */
import { timingSafeEqual, randomBytes } from "node:crypto";
import { OpsError } from "./types.js";

export type OpsRole = "verifier" | "reviewer" | "admin";

export interface OpsTokenRecord {
  actor_id: string;
  roles: OpsRole[];
  /** When present, the token is scoped to this business only. */
  business_id?: string;
}

export interface OpsAuthContext {
  actorId: string;
  roles: OpsRole[];
  businessId?: string;
}

const VALID_ROLES = new Set<OpsRole>(["verifier", "reviewer", "admin"]);

export function parseOpsTokens(raw: string | undefined): Map<string, OpsTokenRecord> {
  const map = new Map<string, OpsTokenRecord>();
  if (!raw || raw.trim() === "") return map;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OpsError(500, "ops_tokens_invalid", "FACTLOCK_OPS_TOKENS is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new OpsError(500, "ops_tokens_invalid", "FACTLOCK_OPS_TOKENS must be a JSON object");
  }
  for (const [token, rec] of Object.entries(parsed as Record<string, unknown>)) {
    const r = rec as Record<string, unknown>;
    const roles = Array.isArray(r?.roles) ? (r.roles as unknown[]) : [];
    if (token.length < 16) {
      throw new OpsError(500, "ops_tokens_invalid", "ops tokens must be at least 16 characters");
    }
    if (typeof r?.actor_id !== "string" || r.actor_id === "" || roles.length === 0) {
      throw new OpsError(500, "ops_tokens_invalid", `ops token record for actor is malformed`);
    }
    for (const role of roles) {
      if (!VALID_ROLES.has(role as OpsRole)) {
        throw new OpsError(500, "ops_tokens_invalid", `unknown ops role ${String(role)}`);
      }
    }
    if (r.business_id !== undefined && typeof r.business_id !== "string") {
      throw new OpsError(500, "ops_tokens_invalid", "business_id must be a string");
    }
    map.set(token, {
      actor_id: r.actor_id as string,
      roles: roles as OpsRole[],
      ...(r.business_id ? { business_id: r.business_id as string } : {}),
    });
  }
  return map;
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // Randomize over-length to avoid leaking which stored token is longest.
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function authenticateOps(
  authHeader: string | undefined,
  tokens: Map<string, OpsTokenRecord>,
): OpsAuthContext {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new OpsError(401, "unauthorized", "a Bearer ops token is required");
  }
  const presented = authHeader.slice("Bearer ".length).trim();
  for (const [token, rec] of tokens) {
    if (constantTimeEquals(presented, token)) {
      return { actorId: rec.actor_id, roles: rec.roles, businessId: rec.business_id };
    }
  }
  throw new OpsError(401, "unauthorized", "invalid ops token");
}

export function requireRole(ctx: OpsAuthContext, role: OpsRole): void {
  if (!ctx.roles.includes(role)) {
    throw new OpsError(403, "forbidden", `the ${role} role is required`);
  }
}

export function requireAnyRole(ctx: OpsAuthContext, ...roles: OpsRole[]): void {
  if (!roles.some((r) => ctx.roles.includes(r))) {
    throw new OpsError(403, "forbidden", `one of roles ${roles.join(", ")} is required`);
  }
}

/**
 * Business scoping (audit H-04): a token scoped to a business may only act
 * on that business. Throws 403 otherwise.
 */
export function enforceBusinessScope(ctx: OpsAuthContext, businessId: string): void {
  if (ctx.businessId && ctx.businessId !== businessId) {
    throw new OpsError(403, "forbidden", "token is scoped to a different business");
  }
}

export function mintTestToken(): string {
  return `ops_test_${randomBytes(24).toString("hex")}`;
}
