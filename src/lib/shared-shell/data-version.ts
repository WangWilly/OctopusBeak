export type DataVersionReason = "automation-completed";

export type DataVersionSnapshot = Readonly<{
  version: number;
  stale: boolean;
  changedAt: string | null;
}>;

/** An optional generation contract attached to a renderer-initiated read. */
export type DataReadOptions = Readonly<{
  expectedVersion?: number;
  /** Force a fresh main-process credential snapshot for automation details. */
  refreshCredentials?: boolean;
}>;

/**
 * A read crossed a data-version boundary while it was in flight.  Callers
 * must discard the result rather than presenting a block assembled from two
 * different financial generations.
 */
export class DataVersionMismatchError extends Error {
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(expectedVersion: number, actualVersion: number) {
    super(
      `Data version advanced while reading (expected ${expectedVersion}, actual ${actualVersion}).`,
    );
    this.name = "DataVersionMismatchError";
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export type DataInvalidationEvent = Readonly<{
  version: number;
  reason: DataVersionReason;
  changedAt: string;
}>;

export type DataVersionListener = (event: DataInvalidationEvent) => void;

export type DataVersionStore = Readonly<{
  snapshot(): DataVersionSnapshot;
  markStale(reason: DataVersionReason): DataInvalidationEvent;
  acknowledge(version: number): boolean;
  subscribe(listener: DataVersionListener): () => void;
}>;

/**
 * Guard an asynchronous read against the immutable generation captured by a
 * refresh round.  The boundary is checked immediately before and after the
 * operation.  This is deliberately a reject-on-advance contract: if the
 * backend cannot serve a historical generation, accepting a result is less
 * safe than asking the caller to retry against a fresh snapshot.
 */
export async function withExpectedDataVersion<T>(
  expectedVersion: number | undefined,
  readSnapshot: () => DataVersionSnapshot,
  operation: () => T | Promise<T>,
): Promise<T> {
  if (expectedVersion === undefined) return await operation();
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
    throw new TypeError("Expected data version must be a non-negative safe integer.");

  const before = readSnapshot();
  if (before.version !== expectedVersion)
    throw new DataVersionMismatchError(expectedVersion, before.version);

  const value = await operation();
  const after = readSnapshot();
  if (after.version !== expectedVersion)
    throw new DataVersionMismatchError(expectedVersion, after.version);
  return value;
}

export function createDataVersionStore(options: {
  initialVersion?: number;
  now?: () => Date;
} = {}): DataVersionStore {
  const initialVersion = options.initialVersion ?? 0;
  if (!Number.isSafeInteger(initialVersion) || initialVersion < 0) {
    throw new TypeError("Initial data version must be a non-negative safe integer.");
  }
  const now = options.now ?? (() => new Date());
  let current: DataVersionSnapshot = {
    version: initialVersion,
    stale: false,
    changedAt: null,
  };
  const listeners = new Set<DataVersionListener>();

  return {
    snapshot() {
      return current;
    },
    markStale(reason) {
      const version = current.version + 1;
      if (!Number.isSafeInteger(version)) {
        throw new RangeError("Data version exhausted safe integer range.");
      }
      const changedAt = now().toISOString();
      current = { version, stale: true, changedAt };
      const event = { version, reason, changedAt } satisfies DataInvalidationEvent;
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch {
          // Renderer listeners are observers and must never make finalization fail.
        }
      }
      return event;
    },
    acknowledge(version) {
      if (version !== current.version) return false;
      current = { ...current, stale: false };
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Main-process authority shared by automation finalization and Electron IPC. */
export const dataVersionStore = createDataVersionStore();
