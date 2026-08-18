import { DatabaseSync } from "node:sqlite";

export type CanonicalRuntimeOptions = {
  busyTimeoutMs?: number;
  maxAttempts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
};

export type CanonicalRetryObservation = {
  attempt: number;
  delayMs: number;
  error: unknown;
};

export class CanonicalBusyRetryExhaustedError extends Error {
  readonly attempts: number;
  readonly observations: CanonicalRetryObservation[];

  constructor(attempts: number, observations: CanonicalRetryObservation[], cause: unknown) {
    super(`Canonical writer busy retry exhausted after ${attempts} attempts.`, { cause });
    this.name = "CanonicalBusyRetryExhaustedError";
    this.attempts = attempts;
    this.observations = observations;
  }
}

const writerQueues = new Map<string, Promise<void>>();

export function configureCanonicalRuntime(db: DatabaseSync, options: { readOnly?: boolean; busyTimeoutMs?: number } = {}): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.floor(options.busyTimeoutMs ?? 30_000))}`);
  if (!options.readOnly) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
  }
}

export function verifyCanonicalRuntime(db: DatabaseSync, options: { readOnly?: boolean } = {}): void {
  const foreignKeys = Number((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: unknown }).foreign_keys ?? 0);
  if (foreignKeys !== 1) throw new Error("Canonical runtime requires foreign_keys=ON.");
  const journalMode = String((db.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown }).journal_mode ?? "").toLowerCase();
  if (journalMode !== "wal") throw new Error("Canonical runtime requires WAL journal mode.");
  const busyTimeout = Number((db.prepare("PRAGMA busy_timeout").get() as { timeout?: unknown }).timeout ?? 0);
  if (!Number.isFinite(busyTimeout) || busyTimeout <= 0) throw new Error("Canonical runtime requires a finite busy timeout.");
  if (!options.readOnly) {
    const synchronous = Number((db.prepare("PRAGMA synchronous").get() as { synchronous?: unknown }).synchronous ?? 0);
    if (synchronous !== 2) throw new Error("Canonical runtime requires FULL synchronous mode.");
  }
}

function isBusyError(error: unknown): boolean {
  return /busy|locked/i.test(error instanceof Error ? error.message : String(error));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Serialize writer operations per canonical database and retry the whole operation.
 * The operation is deliberately retried as one unit so BEGIN IMMEDIATE and its
 * rollback boundary are never split across attempts. */
export async function withCanonicalWriterQueue<T>(
  databasePath: string,
  operation: () => T,
  options: CanonicalRuntimeOptions = {},
): Promise<T> {
  const previous = writerQueues.get(databasePath) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => turn);
  writerQueues.set(databasePath, queued);
  await previous;
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const initialBackoffMs = Math.max(0, Math.floor(options.initialBackoffMs ?? 5));
  const maxBackoffMs = Math.max(initialBackoffMs, Math.floor(options.maxBackoffMs ?? 250));
  const observations: CanonicalRetryObservation[] = [];
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try { return operation(); }
      catch (error) {
        if (!isBusyError(error)) throw error;
        if (attempt === maxAttempts) throw new CanonicalBusyRetryExhaustedError(attempt, observations, error);
        const delayMs = Math.min(maxBackoffMs, initialBackoffMs * (2 ** (attempt - 1)));
        observations.push({ attempt, delayMs, error });
        await wait(delayMs);
      }
    }
    throw new Error("Canonical writer retry loop terminated unexpectedly.");
  } finally {
    release();
    if (writerQueues.get(databasePath) === queued) writerQueues.delete(databasePath);
  }
}

/** Keep a read transaction open for the complete query so all tables observe
 * one SQLite snapshot before or after an active-generation switch. */
export function withCanonicalSnapshot<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN");
  try {
    const value = operation();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve the query failure */ }
    throw error;
  }
}
