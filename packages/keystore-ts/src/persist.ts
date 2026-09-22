import { chmodSync, renameSync, writeFileSync } from "node:fs";

/**
 * Write `data` to `path` via a same-directory temp file + rename so a crash
 * cannot leave a truncated registry. POSIX rename is atomic on one filesystem.
 */
export function atomicWriteFile(path: string, data: string, mode?: number): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { encoding: "utf8", ...(mode !== undefined ? { mode } : {}) });
  renameSync(tmp, path);
  if (mode !== undefined) chmodSync(path, mode);
}

export function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production" || process.env.FACTLOCK_ENV === "production";
}
