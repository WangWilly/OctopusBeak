export type RouteLoadOptions = {
  force?: boolean;
};

type RouteKey<Routes extends object> = keyof Routes;

type PendingRoute = {
  kind: "pending";
  promise: Promise<unknown>;
  previous: unknown;
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
      if (existing?.kind === "pending") {
        return existing.promise as Promise<Routes[Route]>;
      }
      if (!options.force && existing?.kind === "ready") {
        return Promise.resolve(existing.value as Routes[Route]);
      }

      let entry: RouteEntry;
      const previous = existing?.kind === "ready" ? existing.value : undefined;
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
      entry = { kind: "pending", promise, previous };
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
