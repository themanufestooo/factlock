/** FactLock Merkle transparency log — TypeScript (T4: RFC 6962). */
export {
  MerkleLog,
  verifyInclusionProof,
  verifyConsistencyProof,
} from "./tree.js";
export type {
  ProofStep,
  InclusionProof,
  ConsistencyBlock,
  ConsistencyProof,
} from "./tree.js";
export { sha256, leafHash, nodeHash, toHex, fromHex, HASH_LEN } from "./hash.js";
