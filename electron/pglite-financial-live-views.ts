import type {
  PGliteFinancialExpectedSources,
  PGliteFinancialOperation,
  PGliteFinancialRegistry,
  PGliteFinancialResult,
} from "../src/lib/pglite-rpc/pglite-financial-contracts.ts";
import type { PGliteWorkScheduler } from "./pglite-financial-rpc-server.ts";
import type { PGliteFinancialPreviewEvents, PGliteFinancialRegistryPageActions } from "./pglite-financial-registry.ts";
import type { LiveViewDependencies, LiveViewDependencyName } from "./pglite-financial-live-dependencies.ts";
import { SPENDING_LIVE_VIEW } from "./pglite-financial-spending-live-view.ts";

/**
 * What a view reads its page and the store's events from. The Spending view
 * publishes the results of the registry's own page actions, so a view and its
 * registry cannot hold different ones.
 */
export type LiveViewRegistry = PGliteFinancialRegistry & PGliteFinancialPreviewEvents & PGliteFinancialRegistryPageActions;

export type FinancialLiveViewDefinition = Readonly<{
  load(registry: LiveViewRegistry, params: object, sources: PGliteFinancialExpectedSources): Promise<unknown>;
  /**
   * What the page reads besides canonical commits, which every Financial page
   * depends on: source admissions, e-invoice/card commits, and projection
   * rebuilds can change the knowledge point even when a current projection
   * marker is unchanged.
   */
  dependsOn: readonly LiveViewDependencyName[];
  /** Decides whether a dependency change needs a full recompute. */
  shouldRecompute?(registry: LiveViewRegistry, lastValue: () => unknown): Promise<boolean>;
  /** Subscribes to view-specific events; returns the unsubscribe. */
  watch?(context: Readonly<{
    registry: LiveViewRegistry;
    lastValue(): unknown;
    publish(value: unknown): void;
    recompute(): void;
    fail(error: unknown): void;
  }>): () => void;
}>;

const FINANCIAL_LIVE_VIEWS = {
  "financial.overview.current": {
    load: (registry, _params, sources) => registry["financial.overview.current"]([sources]),
    dependsOn: ["exchangeRates", "preview", "manual", "today"],
  },
  "financial.assets.current": {
    load: (registry, _params, sources) => registry["financial.assets.current"]([sources]),
    dependsOn: ["exchangeRates", "preview", "manual", "today"],
  },
  "financial.liabilities.current": {
    load: (registry, _params, sources) => registry["financial.liabilities.current"]([sources]),
    dependsOn: ["exchangeRates", "preview", "manual", "today"],
  },
  "financial.spending.current": SPENDING_LIVE_VIEW,
} as const satisfies Partial<Record<PGliteFinancialOperation, FinancialLiveViewDefinition>>;

export type PGliteFinancialLiveView = keyof typeof FINANCIAL_LIVE_VIEWS;

/** The DTO each live view publishes: the result of the operation it loads. */
export type FinancialLiveViewDtos = {
  readonly [View in PGliteFinancialLiveView]: PGliteFinancialResult<View>;
};

function isFinancialLiveView(view: string): view is PGliteFinancialLiveView {
  return Object.hasOwn(FINANCIAL_LIVE_VIEWS, view);
}

/**
 * Subscribe to a complete page DTO while using only the tables that the page
 * consumes as PGlite live dependencies.  Recomputations are coalesced and
 * serialized, so a burst of commits cannot publish an older DTO after a newer
 * one.  Automation progress/history has its own runtime stream and must not
 * invalidate a complete financial DTO on every task update.
 */
export function createPGliteFinancialLiveViews(
  registry: LiveViewRegistry,
  dependencies: LiveViewDependencies,
  expectedSources: () => PGliteFinancialExpectedSources = () => [],
  scheduler?: PGliteWorkScheduler,
) {
  const entries = new Map<string, {
    stop: () => Promise<void>;
    listeners: Set<{ value(value: unknown): void; error(error: unknown): void }>;
    lastValue?: unknown;
  }>();
  return {
    async subscribe(view: string, params: object, onValue: (value: unknown) => void, onError?: (error: unknown) => void): Promise<() => Promise<void>> {
      if (!isFinancialLiveView(view)) throw new Error(`Unknown financial live view: ${view}`);
      const definition: FinancialLiveViewDefinition = FINANCIAL_LIVE_VIEWS[view];
      const key = `${view}:${JSON.stringify(params)}`;
      let entry = entries.get(key);
      if (!entry) {
        const listeners = new Set<{ value(value: unknown): void; error(error: unknown): void }>();
        let running = false;
        let queued = false;
        let initialReady = false;
        let stopped = false;
        let stopWatch = () => {};
        const fail = (error: unknown) => {
          for (const listener of listeners) listener.error(error);
        };
        const publish = (value: unknown) => {
          entry!.lastValue = value;
          for (const listener of listeners) {
            try {
              listener.value(value);
            } catch {
              // One renderer observer cannot stop the shared publication.
            }
          }
        };
        const recompute = async () => {
          if (stopped) return;
          if (running) {
            queued = true;
            return;
          }
          running = true;
          try {
            do {
              queued = false;
              const requestedSources = (params as { expectedSources?: PGliteFinancialExpectedSources }).expectedSources;
              const sources = requestedSources ?? expectedSources();
              const load = () => definition.load(registry, params, sources);
              const value = scheduler ? await scheduler.schedule("background", load) : await load();
              if (stopped) return;
              publish(value);
            } while (queued && !stopped);
          } finally {
            running = false;
            if (queued && !stopped) {
              queued = false;
              void recompute().catch(fail);
            }
          }
        };
        const trigger = () => {
          if (!initialReady) return;
          void (async () => {
            if (definition.shouldRecompute && !await definition.shouldRecompute(registry, () => entry?.lastValue)) return;
            if (!stopped) await recompute();
          })().catch(fail);
        };
        if (definition.watch) {
          stopWatch = definition.watch({
            registry,
            lastValue: () => entry?.lastValue,
            publish,
            recompute: () => {
              if (!stopped) void recompute().catch(fail);
            },
            fail,
          });
        }
        const signals = { changed: trigger, failed: fail };
        const watching = [dependencies.canonical, ...definition.dependsOn.map((name) => dependencies[name])]
          .map((dependency) => dependency.watch(signals));
        const stop = async () => {
          if (stopped) return;
          stopped = true;
          stopWatch();
          if (entries.get(key) === entry) entries.delete(key);
          const started = await Promise.allSettled(watching);
          await Promise.allSettled(started.flatMap((result) =>
            result.status === "fulfilled" ? [result.value()] : []));
        };
        entry = { stop, listeners };
        entries.set(key, entry);
        let delivered = false;
        const listener = {
          value: (value: unknown) => {
            delivered = true;
            onValue(value);
          },
          error: (error: unknown) => onError?.(error),
        };
        entry.listeners.add(listener);
        try {
          await Promise.all(watching);
          initialReady = true;
          await recompute();
        } catch (error) {
          for (const observer of listeners) observer.error(error);
          await stop();
          throw error;
        }
        if (!delivered && entry.lastValue !== undefined && !stopped) onValue(entry.lastValue);
        return async () => {
          if (!entry) return;
          entry.listeners.delete(listener);
          if (entry.listeners.size === 0) await entry.stop();
        };
      }
      const listener = {
        value: onValue,
        error: (error: unknown) => onError?.(error),
      };
      entry.listeners.add(listener);
      if (entry.lastValue !== undefined) onValue(entry.lastValue);
      return async () => {
        if (!entry) return;
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0) await entry.stop();
      };
    },
  };
}
