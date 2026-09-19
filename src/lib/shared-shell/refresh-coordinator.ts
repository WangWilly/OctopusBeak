import type { DataVersionSnapshot } from "./data-version.ts";

export type RefreshLoader = (snapshot: DataVersionSnapshot) => Promise<unknown>;

/**
 * A route can complete its own DTO while one or more independently loaded
 * blocks fail.  Throwing this error keeps the coordinator's existing loader
 * seam small while preserving the precise block keys for the global partial
 * status.
 */
export class RefreshLoadError extends Error {
  readonly failedKeys: readonly string[];

  constructor(message: string, failedKeys: readonly string[]) {
    super(message);
    this.name = "RefreshLoadError";
    this.failedKeys = [...new Set(failedKeys)];
  }
}

export type RefreshItemError = Readonly<{
  key: string;
  error: unknown;
}>;

export type RefreshResult = Readonly<{
  status: "complete" | "partial";
  snapshot: DataVersionSnapshot;
  successful: readonly string[];
  failed: readonly string[];
  values: Readonly<Record<string, unknown>>;
  errors: readonly RefreshItemError[];
  acknowledged: boolean;
}>;

export type RefreshCoordinator = Readonly<{
  refresh(currentPage?: string): Promise<RefreshResult>;
}>;

type RefreshCoordinatorOptions = {
  readSnapshot: () => Promise<DataVersionSnapshot>;
  acknowledgeSnapshot: (version: number) => Promise<boolean>;
  loaders: Readonly<Record<string, RefreshLoader>>;
};

type ItemResult =
  | { status: "fulfilled"; value: unknown }
  | { status: "rejected"; error: unknown };

/**
 * Coordinates one app-wide refresh without doing synchronous projection work.
 * The visible page is awaited first; every other loader then starts together
 * with the exact immutable snapshot captured at the beginning of the round.
 */
export function createRefreshCoordinator(
  options: RefreshCoordinatorOptions,
): RefreshCoordinator {
  let inFlight: Promise<RefreshResult> | null = null;

  const run = async (currentPage?: string): Promise<RefreshResult> => {
    const snapshot = await options.readSnapshot();
    const keys = Object.keys(options.loaders);
    const first = currentPage && keys.includes(currentPage) ? currentPage : null;
    const background = first ? keys.filter((key) => key !== first) : keys;
    const results: Record<string, ItemResult> = {};

    const load = async (key: string) => {
      try {
        results[key] = {
          status: "fulfilled",
          value: await options.loaders[key]!(snapshot),
        };
      } catch (error) {
        results[key] = { status: "rejected", error };
      }
    };

    if (first) await load(first);
    await Promise.all(background.map((key) => load(key)));

    const successful = keys.filter((key) => results[key]?.status === "fulfilled");
    const failed = [...new Set(keys.flatMap((key) => {
      const result = results[key];
      if (result?.status !== "rejected") return [];
      const extraKeys = result.error instanceof RefreshLoadError
        ? result.error.failedKeys
        : [];
      return [key, ...extraKeys];
    }))];
    const values: Record<string, unknown> = {};
    const errors: RefreshItemError[] = [];
    for (const key of keys) {
      const result = results[key];
      if (!result) continue;
      if (result.status === "fulfilled") values[key] = result.value;
      else {
        errors.push({ key, error: result.error });
        if (result.error instanceof RefreshLoadError) {
          for (const failedKey of result.error.failedKeys) {
            if (failedKey !== key) errors.push({ key: failedKey, error: result.error });
          }
        }
      }
    }

    const acknowledged = failed.length === 0
      ? await options.acknowledgeSnapshot(snapshot.version)
      : false;
    return {
      status: failed.length === 0 ? "complete" : "partial",
      snapshot,
      successful,
      failed,
      values,
      errors,
      acknowledged,
    };
  };

  return {
    refresh(currentPage) {
      if (inFlight) return inFlight;
      inFlight = run(currentPage);
      const settled = inFlight;
      settled.then(
        () => {
          if (inFlight === settled) inFlight = null;
        },
        () => {
          if (inFlight === settled) inFlight = null;
        },
      );
      return settled;
    },
  };
}
