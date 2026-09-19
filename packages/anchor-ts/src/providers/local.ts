/**
 * Local anchor provider (T5) — dev/test default.
 *
 * Appends the anchor record to a JSONL anchor log. No network, no cost.
 * Production deployments swap in a chain provider (see providers/opentimestamps.ts).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AnchorLog,
  AnchorProvider,
  AnchorReceipt,
  AnchorRecord,
} from "../types.js";

export class FileAnchorLog implements AnchorLog {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  async records(): Promise<AnchorRecord[]> {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AnchorRecord);
  }

  async append(record: AnchorRecord): Promise<void> {
    appendFileSync(this.path, JSON.stringify(record) + "\n");
  }
}

export class LocalAnchorProvider implements AnchorProvider {
  readonly name = "local";

  /**
   * Mints the receipt. Persistence is owned by anchorDay (it appends the
   * record — including provider_ref — to the anchor log exactly once).
   */
  async anchor(record: AnchorRecord): Promise<AnchorReceipt> {
    const at = new Date().toISOString();
    return {
      provider: this.name,
      ref: `local:${record.date}:${record.record_hash.slice(0, 16)}`,
      at,
    };
  }
}
