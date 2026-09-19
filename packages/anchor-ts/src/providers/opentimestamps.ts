/**
 * OpenTimestamps anchor provider (T5) — documented, NOT live.
 *
 * Shape of the production wiring: submit the anchor record_hash to one or more
 * public OTS calendars; they return an incomplete timestamp that upgrades to a
 * Bitcoin-anchored proof. Full wiring instructions are in the README.
 *
 * Safety: the provider is DISABLED by default. anchor() throws unless
 * explicitly enabled, so tests and dev runs can never broadcast or spend.
 * No network calls happen in the test suite.
 */
import { createHash } from "node:crypto";
import type { AnchorProvider, AnchorReceipt, AnchorRecord } from "../types.js";

export interface OtsOptions {
  /** Public calendar URLs, e.g. https://a.pool.opentimestamps.org */
  calendars?: string[];
  /** Must be true to allow any network activity. Default false. */
  enabled?: boolean;
}

/** Digest submitted to the calendar: SHA256("veritas-ots/1" || record_hash). */
export function otsDigestHex(recordHashHex: string): string {
  const h = createHash("sha256");
  h.update(Buffer.from("veritas-ots/1", "utf-8"));
  h.update(Buffer.from(recordHashHex, "hex"));
  return h.digest("hex");
}

/** Body POSTed to an OTS calendar's /digest endpoint (per the OTS REST API). */
export function buildCalendarPayload(digestHex: string): {
  url: string;
  method: "POST";
  body: string;
  contentType: string;
} {
  return {
    url: "/digest",
    method: "POST",
    body: JSON.stringify({ digest: digestHex }),
    contentType: "application/json",
  };
}

export class OpenTimestampsProvider implements AnchorProvider {
  readonly name = "opentimestamps";
  private readonly calendars: string[];
  private readonly enabled: boolean;

  constructor(opts: OtsOptions = {}) {
    this.calendars = opts.calendars ?? ["https://a.pool.opentimestamps.org"];
    this.enabled = opts.enabled ?? false;
  }

  async anchor(record: AnchorRecord): Promise<AnchorReceipt> {
    if (!this.enabled) {
      throw new Error(
        "OpenTimestampsProvider is disabled: refusing to broadcast. " +
          "Enable explicitly with { enabled: true, calendars } after reading " +
          "the README wiring section. No network request was attempted.",
      );
    }
    const digest = otsDigestHex(record.record_hash);
    // Real wiring (see README): POST buildCalendarPayload(digest) to each
    // calendar, collect the pending timestamp, poll /timestamp/:digest until
    // the calendar upgrades it to a Bitcoin attestation, then store the .ots
    // file next to the anchor log. Implemented on first production deploy.
    const at = new Date().toISOString();
    return {
      provider: this.name,
      ref: `ots:${digest.slice(0, 16)}:pending`,
      at,
    };
  }
}
