export type RouteLoadOptions = {
  force?: boolean;
};

type RouteKey<Routes extends object> = keyof Routes;

type PendingRoute = {
  kind: "pending";
  promise: Promise<unknown>;
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
      if (!options.force) {
        const entry = entries.get(route);
        if (entry?.kind === "ready") return Promise.resolve(entry.value as Routes[Route]);
        if (entry?.kind === "pending") return entry.promise as Promise<Routes[Route]>;
      } else {
        entries.delete(route);
      }

      let entry: RouteEntry;
      const promise = loader().then((value) => {
        if (entries.get(route) === entry) entries.set(route, { kind: "ready", value });
        return value;
      }, (error: unknown) => {
        if (entries.get(route) === entry) entries.delete(route);
        throw error;
      });
      entry = { kind: "pending", promise };
      entries.set(route, entry);
      return promise;
    },

    read<Route extends RouteKey<Routes>>(route: Route) {
      const entry = entries.get(route);
      return entry?.kind === "ready" ? entry.value as Routes[Route] : undefined;
    },

    clear<Route extends RouteKey<Routes>>(route: Route) {
      entries.delete(route);
    },

    clearAll() {
      entries.clear();
    },
  };
}
