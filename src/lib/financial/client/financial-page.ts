import { writable, type Readable } from "svelte/store";
import type { FinancialLiveViewDtos, PGliteFinancialLiveView } from "../../pglite-rpc/pglite-financial-live-views.ts";
import type { DataViewsApi } from "../../desktop/api.ts";
import { createViewStores, type ViewState } from "../../data-views/client/view-stores.ts";
import {
  beginViewLoad,
  failViewLoad,
  finishViewLoad,
  type ViewLoadState,
} from "../../shared-shell/view-load-state.ts";

const ROUTE_VIEWS = {
  overview: "financial.overview.current",
  assets: "financial.assets.current",
  liabilities: "financial.liabilities.current",
  spending: "financial.spending.current",
  "cash-flow": "financial.cashFlow.current",
} as const satisfies Record<string, PGliteFinancialLiveView>;

export type FinancialRoute = keyof typeof ROUTE_VIEWS;

/** Each route's page is the DTO its live view publishes. */
export type FinancialPageValues = {
  [Route in FinancialRoute]: FinancialLiveViewDtos[(typeof ROUTE_VIEWS)[Route]];
};

export type FinancialRouteState<Route extends FinancialRoute> = Readonly<{
  load: ViewLoadState<FinancialPageValues[Route]>;
  /** The route's live subscription failed and has not delivered since. */
  liveError: boolean;
}>;

export type FinancialPageState = Readonly<{
  capabilityResolved: boolean;
  enabled: boolean;
  /** The route whose live view is subscribed, if any. */
  shown: FinancialRoute | null;
  routes: Readonly<{ [Route in FinancialRoute]: FinancialRouteState<Route> }>;
}>;

/** A reload ended because another route was shown or reloaded; it did not fail. */
export class FinancialPageSuperseded extends Error {
  constructor() {
    super("The financial page reload was superseded.");
    this.name = "FinancialPageSuperseded";
  }
}

export type FinancialDataViews = Pick<DataViewsApi, "enabled" | "subscribe">;

type ViewStores = ReturnType<typeof createViewStores>;

export interface FinancialPage {
  readonly state: Readable<FinancialPageState>;
  /** Resolves once with whether live views are enabled; never rejects. */
  readonly capability: Promise<boolean>;
  /** Subscribe this route's live view (null stops the current one). */
  show(route: FinancialRoute | null): void;
  /** Show the route and re-read it; settles on its next delivered page. */
  reload(route: FinancialRoute): Promise<void>;
  /**
   * Change the parameters a route's view is read with. A shown route
   * subscribes the new key and keeps showing its last page while it loads.
   */
  setParams(route: FinancialRoute, params: object): void;
  overviewStore(): Readable<ViewState<FinancialPageValues["overview"]>> | null;
  dispose(): void;
}

const subscriptionFailed = "Financial page subscription failed.";
const unavailable = "PGlite financial page views are unavailable.";

export function isFinancialRoute(route: string): route is FinancialRoute {
  return Object.hasOwn(ROUTE_VIEWS, route);
}

/**
 * Owns the live-view lifecycle of the financial pages: which route is
 * subscribed, each route's load state and live error, and reloads that wait
 * for a fresh read.
 */
export function createFinancialPage(options: {
  dataViews: FinancialDataViews | undefined;
  params?: Partial<Record<FinancialRoute, object>>;
}): FinancialPage {
  const loading = { load: { status: "loading" }, liveError: false } as const;
  let value: FinancialPageState = {
    capabilityResolved: false,
    enabled: false,
    shown: null,
    routes: { overview: loading, assets: loading, liabilities: loading, spending: loading, "cash-flow": loading },
  };
  const params: Record<FinancialRoute, object> = {
    overview: {}, assets: {}, liabilities: {}, spending: {}, "cash-flow": {}, ...options.params,
  };
  const store = writable(value);
  let stores: ViewStores | null = null;
  let stopShown: (() => void) | null = null;
  let waiter: {
    route: FinancialRoute;
    promise: Promise<void>;
    resolve(): void;
    reject(error: Error): void;
  } | null = null;
  let disposed = false;

  function commit(next: Partial<FinancialPageState>) {
    value = { ...value, ...next };
    store.set(value);
  }

  function updateRoute<Route extends FinancialRoute>(
    route: Route,
    change: (current: FinancialRouteState<Route>) => FinancialRouteState<Route>,
  ) {
    commit({ routes: { ...value.routes, [route]: change(value.routes[route]) } });
  }

  function beginLoad(route: FinancialRoute) {
    updateRoute(route, (current) => ({ load: beginViewLoad(current.load), liveError: false }));
  }

  function settleWaiter(route: FinancialRoute, error?: Error) {
    if (waiter?.route !== route) return;
    const settled = waiter;
    waiter = null;
    if (error) settled.reject(error);
    else settled.resolve();
  }

  function supersede() {
    const superseded = waiter;
    waiter = null;
    superseded?.reject(new FinancialPageSuperseded());
  }

  function apply<Route extends FinancialRoute>(
    route: Route,
    state: ViewState<FinancialPageValues[Route]>,
  ) {
    if (state.status === "loading") {
      updateRoute(route, (current) => ({ ...current, load: beginViewLoad(current.load) }));
    } else if (state.status === "error") {
      const error = new Error(subscriptionFailed);
      updateRoute(route, (current) => ({ load: failViewLoad(current.load, error), liveError: true }));
      settleWaiter(route, error);
    } else {
      updateRoute(route, () => ({ load: finishViewLoad(state.data), liveError: false }));
      settleWaiter(route);
    }
  }

  function storeFor<Route extends FinancialRoute>(
    live: ViewStores,
    route: Route,
  ): Readable<ViewState<FinancialPageValues[Route]>> {
    return live.get<FinancialPageValues[Route]>(ROUTE_VIEWS[route], params[route]);
  }

  function stop() {
    stopShown?.();
    stopShown = null;
    if (value.shown) commit({ shown: null });
  }

  function subscribe(live: ViewStores, route: FinancialRoute) {
    stop();
    beginLoad(route);
    commit({ shown: route });
    // A store another consumer holds replays its cached value synchronously.
    stopShown = storeFor(live, route).subscribe((state) => apply(route, state));
  }

  function restart(live: ViewStores, route: FinancialRoute) {
    beginLoad(route);
    live.restart(ROUTE_VIEWS[route], params[route]);
  }

  const capability = Promise.resolve()
    .then(() => options.dataViews?.enabled?.() ?? false)
    .catch(() => false)
    .then((enabled) => {
      if (disposed) return false;
      if (enabled && options.dataViews) stores = createViewStores(options.dataViews);
      commit({ capabilityResolved: true, enabled: Boolean(stores) });
      return Boolean(stores);
    });

  return {
    state: { subscribe: store.subscribe },
    capability,

    show(route) {
      if (disposed) return;
      const next = stores ? route : null;
      if (waiter && waiter.route !== next) supersede();
      if (!stores || !next) {
        stop();
        return;
      }
      if (value.shown !== next) subscribe(stores, next);
      else if (value.routes[next].liveError) restart(stores, next);
    },

    reload(route) {
      if (disposed) return Promise.reject(new FinancialPageSuperseded());
      if (!stores) {
        const error = new Error(unavailable);
        updateRoute(route, (current) => ({ ...current, load: failViewLoad(beginViewLoad(current.load), error) }));
        return Promise.reject(error);
      }
      if (waiter?.route === route) return waiter.promise;
      supersede();
      if (value.shown !== route) subscribe(stores, route);
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      waiter = { route, promise, resolve, reject };
      // Always re-read: a fresh subscription may only have replayed the value
      // another consumer keeps cached.
      restart(stores, route);
      return promise;
    },

    setParams(route, next) {
      if (disposed || JSON.stringify(params[route]) === JSON.stringify(next)) return;
      params[route] = next;
      if (!stores || value.shown !== route) return;
      if (waiter?.route === route) supersede();
      subscribe(stores, route);
    },

    overviewStore() {
      return stores ? storeFor(stores, "overview") : null;
    },

    dispose() {
      if (disposed) return;
      supersede();
      stop();
      disposed = true;
      stores = null;
    },
  };
}
