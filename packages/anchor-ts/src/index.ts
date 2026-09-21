/** FactLock daily anchoring — TypeScript (T5). */
export { anchorDay } from "./anchor.js";
export type { AnchorDayOptions } from "./anchor.js";
export { verifyAnchorForDate, recomputeRootAt } from "./verify.js";
export type { VerifyAnchorOptions } from "./verify.js";
export {
  computeRecordHash,
  recordPreimageBytes,
  verifyChain,
  GENESIS_HASH,
} from "./chain.js";
export { FileAnchorLog, LocalAnchorProvider } from "./providers/local.js";
export {
  OpenTimestampsProvider,
  otsDigestHex,
  buildCalendarPayload,
} from "./providers/opentimestamps.js";
export type { OtsOptions } from "./providers/opentimestamps.js";
export type {
  AnchorRecord,
  AnchorReceipt,
  AnchorProvider,
  AnchorLog,
} from "./types.js";
