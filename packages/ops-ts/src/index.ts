/** Veritas operations trust loop — TypeScript (T9–T12). */
export { haversineMeters, withinVisitRadius, MAX_DISTANCE_M } from "./geo.js";
export {
  InMemoryBusinessDirectory,
  InMemoryVisitStore,
  InMemoryFlagStore,
  InMemoryAuditLog,
  InMemoryDisputeStore,
  InMemoryCdnMirror,
} from "./stores.js";
export type {
  BusinessDirectory,
  VisitStore,
  FlagStore,
  AuditLog,
  DisputeStore,
} from "./stores.js";
export { recordVisit, verifierAccuracy, newVisitId } from "./visits.js";
export type { VisitDeps } from "./visits.js";
export { openFlag, resolveFlag, newFlagId } from "./flags.js";
export type { FlagDeps } from "./flags.js";
export {
  openDispute,
  resolveDispute,
  newDisputeId,
  revocationInclusionOk,
} from "./disputes.js";
export type { DisputeDeps, ResolveInput, ResolveResult } from "./disputes.js";
export { dueForReverification, DUE_FRACTION } from "./scheduler.js";
export { createOpsServer } from "./server.js";
export type { OpsServerOptions } from "./server.js";
export { OpsError } from "./types.js";
export type {
  GpsPoint,
  ChecklistItem,
  VisitInput,
  Visit,
  BusinessRecord,
  VerifierAccuracy,
  FlagSource,
  FlagStatus,
  FlagDecision,
  Flag,
  AuditEntry,
  DisputeStatus,
  DisputeOutcome,
  Dispute,
  RevocationRecord,
  CdnMirror,
  DueAttestation,
  LifecycleStatus,
} from "./types.js";
