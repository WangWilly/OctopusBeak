import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const lifecycleOwners = new Map<string, symbol>();
const LIFECYCLE_LEASE_DEFAULT_TIMEOUT_MS = 250;
const LIFECYCLE_LEASE_MAX_TIMEOUT_MS = 1_000;

function lifecycleOwnerKey(databasePath: string): string | null {
  if (databasePath === ":memory:") return null;
  const absolute = resolve(databasePath);
  try {
    return realpathSync.native(absolute);
  } catch {
    try {
      return resolve(realpathSync.native(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  }
}

export function acquireCanonicalLifecycleOwner(databasePath: string): () => void {
  const key = lifecycleOwnerKey(databasePath);
  if (key === null) return () => {};
  if (lifecycleOwners.has(key))
    throw new Error(`Canonical schema path already has a live lifecycle owner: ${key}`);
  const owner = Symbol(key);
  lifecycleOwners.set(key, owner);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (lifecycleOwners.get(key) === owner) lifecycleOwners.delete(key);
  };
}

/**
 * Holds a crash-recoverable ownership lease in a sidecar SQLite database.
 * SQLite releases the lock when the process exits, so no PID liveness guess is
 * required after a crash.
 */
export function acquireCanonicalCrossProcessLifecycleLease(
  databasePath: string,
  requestedTimeoutMs: number | undefined,
): () => void {
  const key = lifecycleOwnerKey(databasePath);
  if (key === null) return () => {};
  const timeoutMs = Math.min(
    LIFECYCLE_LEASE_MAX_TIMEOUT_MS,
    Math.max(
      1,
      Number.isSafeInteger(requestedTimeoutMs) && requestedTimeoutMs !== undefined
        ? requestedTimeoutMs
        : LIFECYCLE_LEASE_DEFAULT_TIMEOUT_MS,
    ),
  );
  const leasePath = `${key}.lifecycle-lease.sqlite`;
  let leaseDb: DatabaseSync | undefined;
  try {
    leaseDb = new DatabaseSync(leasePath);
    leaseDb.exec(`PRAGMA busy_timeout = ${timeoutMs}; BEGIN IMMEDIATE`);
  } catch (error) {
    try {
      leaseDb?.close();
    } catch {
      /* Preserve the bounded ownership error below. */
    }
    throw new Error(
      `Canonical schema path has a live cross-process lifecycle owner: ${key}`,
      { cause: error },
    );
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      leaseDb!.exec("ROLLBACK");
    } finally {
      leaseDb!.close();
    }
  };
}
