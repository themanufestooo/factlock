/** Veritas public verification API — TypeScript (T6). */
export { verifyAttestation, redactClaims } from "./verifier.js";
export { createVerifyServer } from "./server.js";
export { TokenBucket } from "./ratelimit.js";
export {
  InMemoryAttestationStore,
  InMemoryStatusRegistry,
} from "./store.js";
export {
  verdictFor,
  claimFreshness,
  attestationFreshness,
} from "./freshness.js";
export type {
  FreshnessVerdict,
  LifecycleStatus,
  ClaimFreshness,
  VerificationResult,
  AttestationStore,
  StatusOverride,
  StatusRegistry,
  LogReader,
  VerifyDeps,
  VerifyServerOptions,
} from "./types.js";
