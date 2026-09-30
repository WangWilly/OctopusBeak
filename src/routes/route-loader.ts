import type { DataVersionSnapshot } from "$lib/shared-shell/data-version.ts";

export type RouteLoadOptions = {
  force?: boolean;
  /** Generation captured by the refresh coordinator for this route read. */
  snapshot?: DataVersionSnapshot;
};

export type IndependentLoadResult<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; error: unknown };

/**
 * Settle route/block reads independently.  A failed read is data for its own
 * retry affordance and never rejects the sibling results.
 */
export async function settleIndependentLoads(
  loaders: Readonly<Record<string, () => Promise<unknown>>>,
): Promise<Readonly<Record<string, IndependentLoadResult<unknown>>>> {
  const settled = await Promise.all(
    Object.entries(loaders).map(async ([key, loader]) => {
      try {
        return [key, { status: "fulfilled", value: await loader() }] as const;
      } catch (error) {
        return [key, { status: "rejected", error }] as const;
      }
    }),
  );
  return Object.fromEntries(settled);
}

type RouteKey<Routes extends object> = keyof Routes;

type PendingRoute = {
  kind: "pending";
  promise: Promise<unknown>;
  previous: unknown;
  /** A pending read is reusable only for the generation it captured. */
  snapshotVersion: number | null;
};

type RouteEntry = PendingRoute | {
  kind: "ready";
  value: unknown;
};

export function createRouteLoadCache<Routes extends object>() {
  const entries = new Map<RouteKey<Routes>, RouteEntry>();

  return {
    load<Route extends RouteKey<Routes>>(
      route: Route,
      loader: () => Promise<Routes[Route]>,
      options: RouteLoadOptions = {},
    ) {
      const existing = entries.get(route);
      const snapshotVersion = options.snapshot?.version ?? null;
      if (
        existing?.kind === "pending"
        && existing.snapshotVersion === snapshotVersion
      ) {
        return existing.promise as Promise<Routes[Route]>;
      }
      if (!options.force && existing?.kind === "ready") {
        return Promise.resolve(existing.value as Routes[Route]);
      }

      let entry: RouteEntry;
      const previous = existing?.kind === "ready"
        ? existing.value
        : existing?.kind === "pending"
          ? existing.previous
          : undefined;
      const promise = loader().then((value) => {
        if (entries.get(route) === entry) entries.set(route, { kind: "ready", value });
        return value;
      }, (error: unknown) => {
        if (entries.get(route) === entry) {
          if (previous !== undefined) entries.set(route, { kind: "ready", value: previous });
          else entries.delete(route);
        }
        throw error;
      });
      entry = { kind: "pending", promise, previous, snapshotVersion };
      entries.set(route, entry);
      return promise;
    },

    read<Route extends RouteKey<Routes>>(route: Route) {
      const entry = entries.get(route);
      if (entry?.kind === "ready") return entry.value as Routes[Route];
      return entry?.previous as Routes[Route] | undefined;
    },

    clear<Route extends RouteKey<Routes>>(route: Route) {
      entries.delete(route);
    },

    clearAll() {
      entries.clear();
    },
  };
}
