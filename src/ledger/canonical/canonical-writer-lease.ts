import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

// A full sync can queue more than ten providers, and an individual lifecycle
// open or capture commit can take tens of seconds on a populated ledger.
const DEFAULT_WAIT_MS = 600_000;
const POLL_MS = 25;

export class CanonicalWriterLeaseTimeoutError extends Error {
  constructor() {
    super("Canonical writer lease wait timed out before a transaction began.");
    this.name = "CanonicalWriterLeaseTimeoutError";
  }
}

export class CanonicalWriterLeaseCancelledError extends Error {
  constructor() {
    super("Canonical writer lease wait was cancelled before a transaction began.");
    this.name = "CanonicalWriterLeaseCancelledError";
  }
}

function ownerKey(databasePath: string): string | null {
  if (databasePath === ":memory:" || databasePath.startsWith(":memory:/")) return null;
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

function isBusy(error: unknown): boolean {
  return /busy|locked/i.test(error instanceof Error ? error.message : String(error));
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CanonicalWriterLeaseCancelledError());
    const timer = setTimeout(done, ms);
    function done(): void {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      reject(new CanonicalWriterLeaseCancelledError());
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

/** Coordinate only the active SQLite write/open operation across processes.
 * The sidecar uses rollback journal mode so BEGIN EXCLUSIVE is a real mutex;
 * an OS process exit releases its transaction without a stale PID lockfile.
 */
export async function withCanonicalWriterLease<T>(
  databasePath: string,
  operation: () => T | Promise<T>,
  options: { signal?: AbortSignal; waitTimeoutMs?: number } = {},
): Promise<T> {
  const key = ownerKey(databasePath);
  if (key === null) return operation();
  const budget = Number.isSafeInteger(options.waitTimeoutMs)
    ? Math.max(1, options.waitTimeoutMs!)
    : DEFAULT_WAIT_MS;
  const deadline = performance.now() + budget;
  const waitStarted = performance.now();
  let lease: DatabaseSync | undefined;
  while (!lease) {
    if (options.signal?.aborted) throw new CanonicalWriterLeaseCancelledError();
    const candidate = new DatabaseSync(`${key}.writer-lease.sqlite`);
    try {
      candidate.exec(`PRAGMA busy_timeout = ${POLL_MS}`);
      candidate.exec("PRAGMA journal_mode = DELETE");
      candidate.exec("BEGIN EXCLUSIVE");
      lease = candidate;
    } catch (error) {
      candidate.close();
      if (!isBusy(error)) throw error;
      if (performance.now() >= deadline) throw new CanonicalWriterLeaseTimeoutError();
      await wait(Math.min(POLL_MS, Math.max(1, deadline - performance.now())), options.signal);
    }
  }
  const waitMs = Math.round(performance.now() - waitStarted);
  const heldStarted = performance.now();
  try {
    return await operation();
  } finally {
    const heldMs = Math.round(performance.now() - heldStarted);
    try {
      lease.exec("ROLLBACK");
    } finally {
      lease.close();
    }
    if (waitMs >= 250 || heldMs >= 1_000)
      console.info(`[canonical-writer] pid=${process.pid} wait_ms=${waitMs} hold_ms=${heldMs}`);
  }
}
