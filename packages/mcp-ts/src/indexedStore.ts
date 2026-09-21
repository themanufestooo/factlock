/**
 * Indexed attestation store (T8) — in-memory v1.
 * Wraps InMemoryAttestationStore and tracks the latest attestation per business.
 */
import { InMemoryAttestationStore } from "@factlock/verify-api";
import type { Attestation } from "@factlock/issuer";
import { bizId } from "./tool.js";
import type { BusinessIndex } from "./tool.js";

export class IndexedAttestationStore
  extends InMemoryAttestationStore
  implements BusinessIndex
{
  private readonly latestByBusiness = new Map<string, string>();

  async put(a: Attestation): Promise<void> {
    await super.put(a);
    const prev = this.latestByBusiness.get(bizId(a));
    if (!prev || a.verified_at >= (await super.get(prev))!.verified_at) {
      this.latestByBusiness.set(bizId(a), a.attestation_id);
    }
  }

  async latestForBusiness(businessId: string): Promise<Attestation | null> {
    const id = this.latestByBusiness.get(businessId);
    if (!id) return null;
    return this.get(id);
  }
}
