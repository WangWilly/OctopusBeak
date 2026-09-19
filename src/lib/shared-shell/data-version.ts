export type DataVersionReason = "automation-completed";

export type DataVersionSnapshot = Readonly<{
  version: number;
  stale: boolean;
  changedAt: string | null;
}>;

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
