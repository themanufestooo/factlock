import { chmodSync, closeSync, fsyncSync, openSync, renameSync, writeSync } from "node:fs";

/**
 * Write `data` to `path` via a same-directory temp file + fsync + rename so a
 * crash cannot leave a truncated registry. POSIX rename is atomic on one
 * filesystem; fsync makes the temp durable before the swap.
 */
export function atomicWriteFile(path: string, data: string, mode?: number): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", mode ?? 0o644);
  try {
    writeSync(fd, data, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  if (mode !== undefined) chmodSync(path, mode);
}

export function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production" || process.env.FACTLOCK_ENV === "production";
}
