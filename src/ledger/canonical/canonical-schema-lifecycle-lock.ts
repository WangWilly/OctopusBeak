import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type CanonicalLifecycleLeaseMode = "shared" | "exclusive";
export type CanonicalLifecycleLease = {
  switchMode(nextMode: CanonicalLifecycleLeaseMode): void;
  release(): void;
  onLost(callback: () => void): void;
};

const LIFECYCLE_LEASE_DEFAULT_TIMEOUT_MS = 250;
const LIFECYCLE_LEASE_MAX_TIMEOUT_MS = 1_000;

type LocalLeaseState =
  | { mode: "shared"; count: number }
  | { mode: "exclusive"; token: symbol };

const localLeases = new Map<string, LocalLeaseState>();

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

function leaseTimeout(requestedTimeoutMs: number | undefined): number {
  return Math.min(
    LIFECYCLE_LEASE_MAX_TIMEOUT_MS,
    Math.max(
      1,
      Number.isSafeInteger(requestedTimeoutMs) && requestedTimeoutMs !== undefined
        ? requestedTimeoutMs
        : LIFECYCLE_LEASE_DEFAULT_TIMEOUT_MS,
    ),
  );
}

function localConflict(key: string, mode: CanonicalLifecycleLeaseMode): Error {
  return new Error(
    mode === "exclusive"
      ? `Canonical schema path has a live lifecycle handle while a schema transition is requested: ${key}`
      : `Canonical schema path has a live lifecycle schema transition: ${key}`,
  );
}

function acquireLocalLease(
  key: string | null,
  mode: CanonicalLifecycleLeaseMode,
): {
  canSwitch(nextMode: CanonicalLifecycleLeaseMode): void;
  switchMode(nextMode: CanonicalLifecycleLeaseMode): void;
  release(): void;
} {
  if (key === null) {
    return {
      canSwitch() {},
      switchMode() {},
      release() {},
    };
  }

  const token = Symbol(key);
  let currentMode = mode;
  let released = false;
  const existing = localLeases.get(key);
  if (mode === "exclusive") {
    if (existing) throw localConflict(key, mode);
    localLeases.set(key, { mode: "exclusive", token });
  } else if (existing?.mode === "exclusive") {
    throw localConflict(key, mode);
  } else if (existing) {
    existing.count += 1;
  } else {
    localLeases.set(key, { mode: "shared", count: 1 });
  }

  return {
    canSwitch(nextMode) {
      if (released || nextMode === currentMode) return;
      const state = localLeases.get(key);
      if (nextMode === "exclusive") {
        if (!state || state.mode !== "shared" || state.count !== 1)
          throw localConflict(key, nextMode);
      } else if (!state || state.mode !== "exclusive" || state.token !== token) {
        throw localConflict(key, nextMode);
      }
    },
    switchMode(nextMode) {
      if (released || nextMode === currentMode) return;
      this.canSwitch(nextMode);
      if (nextMode === "exclusive") {
        localLeases.set(key, { mode: "exclusive", token });
      } else {
        localLeases.set(key, { mode: "shared", count: 1 });
      }
      currentMode = nextMode;
    },
    release() {
      if (released) return;
      released = true;
      const state = localLeases.get(key);
      if (currentMode === "exclusive") {
        if (state?.mode === "exclusive" && state.token === token)
          localLeases.delete(key);
      } else if (state?.mode === "shared") {
        state.count -= 1;
        if (state.count <= 0) localLeases.delete(key);
      }
    },
  };
}

function releaseSidecar(db: DatabaseSync | undefined): void {
  if (!db) return;
  try {
    db.exec("ROLLBACK");
  } catch {
    /* SQLite releases the transaction when the connection closes. */
  } finally {
    try {
      db.close();
    } catch {
      /* Preserve the operation that caused the lease to be released. */
    }
  }
}

function openSidecarLease(
  key: string,
  mode: CanonicalLifecycleLeaseMode,
  requestedTimeoutMs: number | undefined,
): DatabaseSync {
  const leasePath = `${key}.lifecycle-lease.sqlite`;
  const timeoutMs = leaseTimeout(requestedTimeoutMs);
  const db = new DatabaseSync(leasePath);
  try {
    // Apply the bounded wait before any journal-mode negotiation. This keeps
    // a stale sidecar or an in-flight mode change from bypassing the caller's
    // timeout and failing with an unbounded SQLite busy wait.
    db.exec(`PRAGMA busy_timeout = ${timeoutMs}`);
    // Keep this coordination database in rollback-journal mode. A shared
    // read transaction must prevent BEGIN EXCLUSIVE in another process;
    // WAL readers would allow that writer to proceed.
    const journalMode = String(
      (db.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown })
        .journal_mode ?? "",
    ).toLowerCase();
    if (journalMode !== "delete") db.exec("PRAGMA journal_mode = DELETE");
    if (mode === "exclusive") {
      db.exec("BEGIN EXCLUSIVE");
    } else {
      db.exec("BEGIN");
      // BEGIN is deferred. Touch sqlite_master so the lease owns a SHARED
      // lock for the lifetime of the validated runtime handle.
      db.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
    }
    return db;
  } catch (error) {
    releaseSidecar(db);
    throw new Error(
      `Canonical schema path has a live cross-process lifecycle owner during ${mode} acquisition: ${key}`,
      { cause: error },
    );
  }
}

function acquireSidecarLease(
  key: string | null,
  mode: CanonicalLifecycleLeaseMode,
  requestedTimeoutMs: number | undefined,
): {
  isHeld(): boolean;
  switchMode(nextMode: CanonicalLifecycleLeaseMode): void;
  release(): void;
} {
  if (key === null) {
    return {
      isHeld() {
        return true;
      },
      switchMode() {},
      release() {},
    };
  }
  let currentMode = mode;
  let db: DatabaseSync | undefined = openSidecarLease(
    key,
    mode,
    requestedTimeoutMs,
  );
  let released = false;
  let held = true;
  return {
    isHeld() {
      return held && !released;
    },
    switchMode(nextMode) {
      if (released || nextMode === currentMode) return;
      const previousMode = currentMode;
      releaseSidecar(db);
      db = undefined;
      try {
        db = openSidecarLease(key, nextMode, requestedTimeoutMs);
        currentMode = nextMode;
      } catch (error) {
        try {
          db = openSidecarLease(key, previousMode, requestedTimeoutMs);
        } catch {
          held = false;
        }
        throw error;
      }
    },
    release() {
      if (released) return;
      released = true;
      held = false;
      releaseSidecar(db);
    },
  };
}

/**
 * Acquire one schema lifecycle lease. Exclusive mode is used only while the
 * lifecycle may change physical schema. Once a path is validated, it is
 * downgraded to shared mode and retained by the returned handle, allowing
 * independent workflow processes to use the same current schema while still
 * blocking a later upgrade beneath an older live handle.
 */
export function acquireCanonicalLifecycleLease(
  databasePath: string,
  mode: CanonicalLifecycleLeaseMode,
  requestedTimeoutMs: number | undefined,
): CanonicalLifecycleLease {
  const key = lifecycleOwnerKey(databasePath);
  const local = acquireLocalLease(key, mode);
  try {
    const sidecar = acquireSidecarLease(key, mode, requestedTimeoutMs);
    let released = false;
    let lost = false;
    const lostCallbacks: Array<() => void> = [];
    const markLost = (): void => {
      if (lost) return;
      lost = true;
      // A mode transition can fail after restoring the old transaction. A
      // handle that cannot return to shared mode must still release that old
      // exclusive lease before it is revoked, otherwise it would strand the
      // path behind a closed runtime connection.
      sidecar.release();
      local.release();
      for (const callback of lostCallbacks.splice(0)) {
        try {
          callback();
        } catch {
          /* A lost lease must not prevent cleanup of the remaining owner. */
        }
      }
    };
    return {
      switchMode(nextMode) {
        if (released || lost || nextMode === mode) return;
        // Check the process-local reader count before releasing the sidecar;
        // otherwise a rejected upgrade could transiently acquire an exclusive
        // sidecar lock and leave this process's shared state inconsistent.
        local.canSwitch(nextMode);
        const previousMode = mode;
        try {
          sidecar.switchMode(nextMode);
          local.switchMode(nextMode);
          mode = nextMode;
        } catch (error) {
          // Shared-to-exclusive failures can safely retain the shared handle
          // when the old lease was restored. A failed exclusive-to-shared
          // downgrade is different: even a restored exclusive lease cannot
          // be handed to a runtime caller, so revoke it fail-closed.
          if (
            !sidecar.isHeld() ||
            (previousMode === "exclusive" && nextMode === "shared")
          )
            markLost();
          throw error;
        }
      },
      release() {
        if (released) return;
        released = true;
        try {
          sidecar.release();
        } finally {
          local.release();
        }
      },
      onLost(callback) {
        if (lost) callback();
        else lostCallbacks.push(callback);
      },
    };
  } catch (error) {
    local.release();
    throw error;
  }
}

/** Backwards-compatible local exclusive-owner seam for isolated callers. */
export function acquireCanonicalLifecycleOwner(databasePath: string): () => void {
  const lease = acquireLocalLease(lifecycleOwnerKey(databasePath), "exclusive");
  return lease.release;
}

/** Backwards-compatible sidecar exclusive-owner seam for isolated callers. */
export function acquireCanonicalCrossProcessLifecycleLease(
  databasePath: string,
  requestedTimeoutMs: number | undefined,
): () => void {
  const lease = acquireSidecarLease(
    lifecycleOwnerKey(databasePath),
    "exclusive",
    requestedTimeoutMs,
  );
  return lease.release;
}
