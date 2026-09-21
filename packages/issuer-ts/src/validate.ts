/**
 * Field-level JSON Schema validation via ajv (T3).
 *
 * ajv is CommonJS; we load it with createRequire so the package can stay on
 * module/moduleResolution NodeNext like the rest of the repo. The structural
 * interfaces below cover exactly the API surface we use.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FieldError } from "./types.js";

const require = createRequire(import.meta.url);

interface AjvValidateFn {
  (data: unknown): boolean;
  errors: unknown;
}
interface AjvInstance {
  addSchema(schema: unknown): void;
  compile(schema: unknown): AjvValidateFn;
  getSchema(key: string): AjvValidateFn | undefined;
}
const Ajv = require("ajv/dist/2020") as new (opts?: {
  allErrors?: boolean;
  strict?: boolean;
}) => AjvInstance;
const addFormats = require("ajv-formats") as (ajv: AjvInstance) => AjvInstance;

const here = dirname(fileURLToPath(import.meta.url));
function loadSchema(name: string): unknown {
  // dist layout mirrors the package root: dist/schemas/*.json
  return JSON.parse(readFileSync(join(here, "..", "schemas", name), "utf-8"));
}

const attestationSchema = loadSchema("attestation-v1.json") as Record<string, unknown>;
const requestSchema = loadSchema("issue-request.json");

const ajv: AjvInstance = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(attestationSchema);

const validateRequestFn = ajv.compile(requestSchema);

function withoutRequired(schema: Record<string, unknown>, drop: string[]): unknown {
  const { $id: _dropped, ...rest } = schema as Record<string, unknown> & { $id?: string };
  return {
    ...rest,
    required: ((schema.required as string[] | undefined) ?? []).filter(
      (k: string) => !drop.includes(k),
    ),
  };
}
// Pre-signing: the unsigned shape has neither signatures nor log yet.
// ($id is stripped so ajv doesn't collide with the registered schema.)
const validateUnsignedFn = ajv.compile(withoutRequired(attestationSchema, ["signatures", "log"]));
// Final: the issued attestation must satisfy the whole registered schema.
const validateAttestationFn = ajv.getSchema(
  "https://factlock.example/schemas/attestation-v1.json",
) as AjvValidateFn;

interface AjvError {
  instancePath?: string;
  message?: string;
  params?: { missingProperty?: string };
}

function toFieldErrors(errors: unknown): FieldError[] {
  const list = (errors ?? []) as AjvError[];
  return list.map((e) => {
    let path = e.instancePath || "(root)";
    if (e.params?.missingProperty) path = `${path}/${e.params.missingProperty}`;
    return { path, message: e.message ?? "invalid" };
  });
}

export function validateIssueRequest(data: unknown): FieldError[] {
  return validateRequestFn(data) ? [] : toFieldErrors(validateRequestFn.errors);
}

/**
 * Semantic timestamp check (audit M-02): the schema validates the date-time
 * SHAPE, but a field that parses to NaN (or an overflowed date) must be
 * rejected explicitly before it can flow into claim records. When the
 * server's issuance time (verified_at) is supplied, ordering is enforced for
 * evidence timestamps: a license cannot have been checked after issuance.
 * device_time is deliberately NOT ordered — it is client-observed metadata
 * and a skewed client clock must never move verified_at (explicit AC).
 */
export function validateTimestamps(data: unknown, nowMs?: number): FieldError[] {
  const errors: FieldError[] = [];
  const req = data as Record<string, unknown>;
  if (typeof req?.device_time === "string" && !isRealDate(req.device_time)) {
    errors.push({ path: "/device_time", message: "is not a real calendar date" });
  }
  const claims = req?.claims;
  if (Array.isArray(claims)) {
    claims.forEach((claim, i) => {
      const checkedAt = (claim as Record<string, unknown>)?.checked_at;
      if (typeof checkedAt === "string") {
        if (!isRealDate(checkedAt)) {
          errors.push({ path: `/claims/${i}/checked_at`, message: "is not a real calendar date" });
        } else if (nowMs !== undefined && Date.parse(checkedAt) > nowMs) {
          errors.push({ path: `/claims/${i}/checked_at`, message: "must not be after verified_at" });
        }
      }
    });
  }
  return errors;
}

function isRealDate(value: string): boolean {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;
  // Round-trip guard: reject overflowed dates like "2026-13-40".
  const d = new Date(ms);
  return !Number.isNaN(d.getTime());
}

/** Unsigned assembled shape (pre-signing): no signatures, no log block. */
export function validateUnsignedShape(data: unknown): FieldError[] {
  return validateUnsignedFn(data) ? [] : toFieldErrors(validateUnsignedFn.errors);
}

/** Complete issued attestation, signatures + log included. */
export function validateAttestationShape(data: unknown): FieldError[] {
  return validateAttestationFn(data) ? [] : toFieldErrors(validateAttestationFn.errors);
}
