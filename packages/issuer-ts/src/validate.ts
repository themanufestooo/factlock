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

/** Unsigned assembled shape (pre-signing): no signatures, no log block. */
export function validateUnsignedShape(data: unknown): FieldError[] {
  return validateUnsignedFn(data) ? [] : toFieldErrors(validateUnsignedFn.errors);
}

/** Complete issued attestation, signatures + log included. */
export function validateAttestationShape(data: unknown): FieldError[] {
  return validateAttestationFn(data) ? [] : toFieldErrors(validateAttestationFn.errors);
}
