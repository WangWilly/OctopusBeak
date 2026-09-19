export type RouteLoadOptions = {
  force?: boolean;
  cutoff?: Readonly<{ knowledgePoint: number }>;
};

type RouteKey<Routes extends object> = keyof Routes;

type PendingRoute = {
  kind: "pending";
  promise: Promise<unknown>;
  previous?: ReadyRoute;
};

type ReadyRoute = {
  kind: "ready";
  value: unknown;
  knowledgePoint: number | null;
  staleSince: number | null;
};

type RouteEntry = PendingRoute | ReadyRoute;

export type FinancialRouteGenerationCutoff = Readonly<{
  knowledgePoint: number;
}>;

export type FinancialRouteGenerationLoadContext<Route extends string> = Readonly<{
  route: Route;
  generation: number;
  cutoff: FinancialRouteGenerationCutoff;
  signal: AbortSignal;
}>;

export type FinancialRouteGenerationState = Readonly<{
  stale: boolean;
  updating: boolean;
  knowledgePoint: number | null;
  error: string | null;
}>;

export type FinancialRouteGenerationCoordinator<Route extends string> = Readonly<{
  start(): void;
  stop(): void;
  setVisibleRoute(route: Route | null): void;
  observeKnowledgePoint(knowledgePoint: number): void;
  reconcile(): Promise<void>;
  waitForIdle(): Promise<void>;
  markRouteLoaded(route: Route, knowledgePoint: number | null): void;
  isStale(route: Route): boolean;
  getState(route: Route): FinancialRouteGenerationState;
}>;

export function createRouteLoadCache<Routes extends object>() {
  const entries = new Map<RouteKey<Routes>, RouteEntry>();

  function markStale<Route extends RouteKey<Routes>>(route: Route, knowledgePoint: number) {
    const entry = entries.get(route);
    const ready = entry?.kind === "ready" ? entry : entry?.previous;
    if (!ready) return;
    ready.staleSince = ready.staleSince === null
      ? knowledgePoint
      : Math.max(ready.staleSince, knowledgePoint);
  }

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
      }

      let entry: RouteEntry;
      const previous = entries.get(route)?.kind === "ready"
        ? entries.get(route) as ReadyRoute
        : entries.get(route)?.kind === "pending"
          ? (entries.get(route) as PendingRoute).previous
          : undefined;
      const promise = loader().then((value) => {
        if (entries.get(route) === entry) {
          const staleSince = previous?.staleSince !== null
            && previous?.staleSince !== undefined
            && options.cutoff?.knowledgePoint !== undefined
            && previous.staleSince > options.cutoff.knowledgePoint
            ? previous.staleSince
            : null;
          entries.set(route, {
            kind: "ready",
            value,
            knowledgePoint: options.cutoff?.knowledgePoint ?? null,
            staleSince,
          });
        }
        return value;
      }, (error: unknown) => {
        if (entries.get(route) === entry) {
          if (previous) entries.set(route, previous);
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
      return entry?.kind === "ready"
        ? entry.value as Routes[Route]
        : entry?.previous?.value as Routes[Route] | undefined;
    },

    clear<Route extends RouteKey<Routes>>(route: Route) {
      entries.delete(route);
    },

    clearAll() {
      entries.clear();
    },

    markStale,

    markAllStale(knowledgePoint: number) {
      for (const route of entries.keys()) {
        markStale(route, knowledgePoint);
      }
    },

    markFresh<Route extends RouteKey<Routes>>(route: Route, knowledgePoint: number | null) {
      const entry = entries.get(route);
      if (entry?.kind !== "ready") return;
      entry.knowledgePoint = knowledgePoint;
      entry.staleSince = null;
    },

    isStale<Route extends RouteKey<Routes>>(route: Route) {
      const entry = entries.get(route);
      const ready = entry?.kind === "ready" ? entry : entry?.previous;
      return Boolean(ready?.staleSince !== null && ready?.staleSince !== undefined);
    },

    knowledgePoint<Route extends RouteKey<Routes>>(route: Route) {
      const entry = entries.get(route);
      const ready = entry?.kind === "ready" ? entry : entry?.previous;
      return ready?.knowledgePoint ?? null;
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createFinancialRouteGenerationCoordinator<Route extends string>(options: {
  routes: readonly Route[];
  subscribe(listener: (event: { knowledgePoint: number }) => void): () => void;
  latestKnowledgePoint(): Promise<number>;
  load(context: FinancialRouteGenerationLoadContext<Route>): Promise<void>;
  onRouteStale?: (route: Route, knowledgePoint: number) => void;
  onRouteRefreshStart?: (route: Route, knowledgePoint: number) => void;
  onRouteFresh?: (route: Route, knowledgePoint: number) => void;
  onRouteRefreshError?: (route: Route, error: string) => void;
  debounceMs?: number;
}): FinancialRouteGenerationCoordinator<Route> {
  const states = new Map<Route, {
    stale: boolean;
    updating: boolean;
    knowledgePoint: number | null;
    error: string | null;
  }>();
  for (const route of options.routes) {
    states.set(route, {
      stale: false,
      updating: false,
      knowledgePoint: null,
      error: null,
    });
  }

  let visibleRoute: Route | null = null;
  let latestObserved = 0;
  let generation = 0;
  let unsubscribe: (() => void) | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let active: {
    route: Route;
    knowledgePoint: number;
    generation: number;
    controller: AbortController;
  } | undefined;
  const idleWaiters: Array<() => void> = [];

  const stateFor = (route: Route) => {
    const state = states.get(route);
    if (!state) throw new Error(`Unknown financial route: ${String(route)}`);
    return state;
  };

  const settleIdle = () => {
    if (refreshTimer || active) return;
    const waiters = idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  };

  const scheduleRefresh = () => {
    if (refreshTimer || !visibleRoute) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void refreshVisible();
    }, options.debounceMs ?? 0);
  };

  const waitForIdle = () => {
    if (!refreshTimer && !active) return Promise.resolve();
    return new Promise<void>((resolve) => idleWaiters.push(resolve));
  };

  const refreshVisible = async () => {
    const route = visibleRoute;
    if (!route || active) {
      if (visibleRoute && active?.route !== visibleRoute && stateFor(visibleRoute).stale) {
        scheduleRefresh();
      }
      settleIdle();
      return;
    }
    const state = stateFor(route);
    if (!state.stale || latestObserved <= (state.knowledgePoint ?? -1)) {
      settleIdle();
      return;
    }

    const knowledgePoint = latestObserved;
    const currentGeneration = ++generation;
    const controller = new AbortController();
    active = { route, knowledgePoint, generation: currentGeneration, controller };
    state.updating = true;
    state.error = null;
    options.onRouteRefreshStart?.(route, knowledgePoint);
    try {
      await options.load({
        route,
        generation: currentGeneration,
        cutoff: { knowledgePoint },
        signal: controller.signal,
      });
      const current = active;
      const stillCurrent = current?.generation === currentGeneration
        && visibleRoute === route
        && latestObserved === knowledgePoint
        && !controller.signal.aborted;
      if (stillCurrent) {
        state.stale = false;
        state.updating = false;
        state.knowledgePoint = knowledgePoint;
        state.error = null;
        options.onRouteFresh?.(route, knowledgePoint);
      }
    } catch (error) {
      const current = active;
      const stillCurrent = current?.generation === currentGeneration
        && visibleRoute === route
        && !controller.signal.aborted;
      if (stillCurrent) {
        state.updating = false;
        state.error = errorMessage(error);
        options.onRouteRefreshError?.(route, state.error);
      }
    } finally {
      if (active?.generation === currentGeneration) active = undefined;
      if (
        visibleRoute === route
        && state.stale
        && !state.error
        && latestObserved > (state.knowledgePoint ?? -1)
      ) {
        scheduleRefresh();
      }
      settleIdle();
    }
  };

  const observeKnowledgePoint = (knowledgePoint: number) => {
    if (!Number.isSafeInteger(knowledgePoint) || knowledgePoint < 0) return;
    if (knowledgePoint <= latestObserved) return;
    latestObserved = knowledgePoint;
    for (const route of options.routes) {
      const state = stateFor(route);
      if (state.knowledgePoint === null || state.knowledgePoint < knowledgePoint) {
        state.stale = true;
        options.onRouteStale?.(route, knowledgePoint);
      }
    }

    // A newer commit supersedes the active read immediately. Keeping the old
    // generation active until its promise settles lets route loaders publish
    // stale primary/secondary sections before the next refresh can start.
    // Abort is part of the load contract; the generation bump also protects
    // non-abort-aware loaders from publishing through a late callback.
    if (active && knowledgePoint > active.knowledgePoint) {
      active.controller.abort();
      active = undefined;
      generation += 1;
    }
    scheduleRefresh();
  };

  return Object.freeze({
    start() {
      if (unsubscribe) return;
      unsubscribe = options.subscribe((event) => observeKnowledgePoint(event.knowledgePoint));
    },
    stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = undefined;
      }
      active?.controller.abort();
      active = undefined;
      settleIdle();
    },
    setVisibleRoute(route) {
      if (route !== null && !states.has(route)) {
        throw new Error(`Unknown financial route: ${String(route)}`);
      }
      if (visibleRoute === route) {
        if (route && stateFor(route).stale) scheduleRefresh();
        return;
      }
      if (active && active.route !== route) active.controller.abort();
      visibleRoute = route;
      if (route && stateFor(route).stale) scheduleRefresh();
    },
    observeKnowledgePoint,
    async reconcile() {
      const knowledgePoint = await options.latestKnowledgePoint();
      observeKnowledgePoint(knowledgePoint);
      await waitForIdle();
    },
    waitForIdle,
    markRouteLoaded(route, knowledgePoint) {
      const state = stateFor(route);
      state.knowledgePoint = knowledgePoint;
      if (knowledgePoint !== null && knowledgePoint >= latestObserved) {
        state.stale = false;
        state.error = null;
      }
      state.updating = false;
    },
    isStale(route) {
      return stateFor(route).stale;
    },
    getState(route) {
      const state = stateFor(route);
      return Object.freeze({ ...state });
    },
  });
}
