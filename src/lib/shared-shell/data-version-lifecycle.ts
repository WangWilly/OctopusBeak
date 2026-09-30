import type {
  DataInvalidationEvent,
  DataVersionListener,
  DataVersionSnapshot,
} from "./data-version.ts";

/** The small event-target surface needed by renderer lifecycle checks. */
export type DataVersionLifecycleEventTarget = Readonly<{
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}>;

export type DataVersionLifecycleData = Readonly<{
  getVersion(): Promise<DataVersionSnapshot>;
  onInvalidated(listener: DataVersionListener): () => void;
}>;

export type DataVersionLifecycle = Readonly<{
  /** Recheck the lightweight version snapshot; concurrent calls share one read. */
  check(): Promise<void>;
  dispose(): void;
}>;

export type DataVersionLifecycleOptions = Readonly<{
  data: DataVersionLifecycleData;
  resumeTarget: DataVersionLifecycleEventTarget;
  visibilityTarget?: DataVersionLifecycleEventTarget;
  isVisible?: () => boolean;
  onInvalidated: DataVersionListener;
  onSnapshot: (snapshot: DataVersionSnapshot) => void;
  onQueryError?: (error: unknown) => void;
}>;

/**
 * Keep renderer freshness observable across missed IPC notifications.
 *
 * The invalidation subscription is installed before the first query so an
 * automation completion cannot win a reconnect race.  Focus, pageshow and a
 * visible visibilitychange only query the version authority; route data is
 * deliberately left to the existing refresh action.  A shared promise keeps
 * lifecycle bursts from creating duplicate IPC calls.
 */
export function installDataVersionLifecycle(
  options: DataVersionLifecycleOptions,
): DataVersionLifecycle {
  const visibilityTarget = options.visibilityTarget ?? options.resumeTarget;
  const isVisible = options.isVisible ?? (() => true);
  let active = true;
  let pending: Promise<void> | null = null;

  const check = (): Promise<void> => {
    if (pending) return pending;
    const request = options.data.getVersion()
      .then((snapshot) => {
        if (active) options.onSnapshot(snapshot);
      })
      .catch((error: unknown) => {
        if (active) options.onQueryError?.(error);
      })
      .finally(() => {
        if (pending === request) pending = null;
      });
    pending = request;
    return request;
  };

  const checkOnResume = () => {
    void check();
  };
  const checkOnVisible = () => {
    if (isVisible()) void check();
  };

  // Subscribe first, then attach reconnect checks and issue the initial query.
  // This order is part of the missed-notification contract.
  const unsubscribe = options.data.onInvalidated(options.onInvalidated);
  options.resumeTarget.addEventListener("focus", checkOnResume);
  options.resumeTarget.addEventListener("pageshow", checkOnResume);
  visibilityTarget.addEventListener("visibilitychange", checkOnVisible);
  void check();

  return {
    check,
    dispose() {
      if (!active) return;
      active = false;
      unsubscribe();
      options.resumeTarget.removeEventListener("focus", checkOnResume);
      options.resumeTarget.removeEventListener("pageshow", checkOnResume);
      visibilityTarget.removeEventListener("visibilitychange", checkOnVisible);
    },
  };
}
