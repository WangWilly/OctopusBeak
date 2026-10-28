import type { PGliteWithLive } from "@electric-sql/pglite/live";
import type {
  PGliteFinancialExpectedSources,
  PGliteFinancialHandlerResult,
  PGliteFinancialOperation,
  PGliteFinancialRegistry,
} from "./pglite-financial-rpc-client.ts";
import type { PGliteFinancialPageActionEvents, PGliteWorkScheduler } from "./pglite-financial-registry.ts";
import { SPENDING_LIVE_VIEW } from "./pglite-financial-spending-live-view.ts";

const PREVIEW_DATA_FINGERPRINT_SQL = `SELECT
  (SELECT COUNT(*) FROM preview_accounts) AS accounts,
  (SELECT MAX(last_collected_at) FROM preview_accounts) AS account_collected_at,
  (SELECT COUNT(*) FROM preview_balance_observations) AS balances,
  (SELECT MAX(collected_at) FROM preview_balance_observations) AS balance_collected_at,
  (SELECT COUNT(*) FROM preview_transactions) AS transactions,
  (SELECT MAX(collected_at) FROM preview_transactions) AS transaction_collected_at,
  (SELECT COUNT(*) FROM preview_credit_accounts) AS credit_accounts,
  (SELECT MAX(last_collected_at) FROM preview_credit_accounts) AS credit_collected_at,
  (SELECT COUNT(*) FROM preview_credit_balance_observations) AS credit_balances,
  (SELECT COUNT(*) FROM preview_credit_purchases) AS purchases,
  (SELECT MAX(last_collected_at) FROM preview_credit_purchases) AS purchase_collected_at,
  (SELECT COUNT(*) FROM preview_credit_statements) AS statements,
  (SELECT COUNT(*) FROM preview_credit_relations) AS relations`;

type LiveViewRegistry = PGliteFinancialRegistry & PGliteFinancialPageActionEvents;

/**
 * What a live view reads besides canonical commits, which every financial
 * page depends on: source admissions, e-invoice/card commits, and projection
 * rebuilds can change the knowledge point even when a current projection
 * marker is unchanged.
 */
type LiveViewDependency =
  | "exchangeRates"
  /** Preview rows and the Preview features visibility setting. */
  | "preview";

export type FinancialLiveViewDefinition = Readonly<{
  load(registry: LiveViewRegistry, params: object, sources: PGliteFinancialExpectedSources): Promise<unknown>;
  dependsOn: readonly LiveViewDependency[];
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
    dependsOn: ["exchangeRates", "preview"],
  },
  "financial.assets.current": {
    load: (registry, _params, sources) => registry["financial.assets.current"]([sources]),
    dependsOn: ["exchangeRates", "preview"],
  },
  "financial.liabilities.current": {
    load: (registry, _params, sources) => registry["financial.liabilities.current"]([sources]),
    dependsOn: ["exchangeRates", "preview"],
  },
  "financial.spending.current": SPENDING_LIVE_VIEW,
} as const satisfies Partial<Record<PGliteFinancialOperation, FinancialLiveViewDefinition>>;

export type PGliteFinancialLiveView = keyof typeof FINANCIAL_LIVE_VIEWS;

/** The DTO each live view publishes: the result of the operation it loads. */
export type FinancialLiveViewDtos = {
  readonly [View in PGliteFinancialLiveView]: PGliteFinancialHandlerResult<View>;
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
  db: PGliteWithLive,
  registry: LiveViewRegistry,
  expectedSources: () => PGliteFinancialExpectedSources = () => [],
  scheduler?: PGliteWorkScheduler,
) {
  const entries = new Map<string, {
    stop: () => Promise<void>;
    listeners: Set<{ value(value: unknown): void; error(error: unknown): void }>;
    lastValue?: unknown;
  }>();
  return {
    async subscribe(view: string, params: object, onRows: (rows: unknown[]) => void, onError?: (error: unknown) => void): Promise<() => Promise<void>> {
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
        let stopPreviewVisibilityListener = () => {};
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
        const dependsOnPreview = definition.dependsOn.includes("preview");
        if (dependsOnPreview && registry.onPreviewVisibilityChanged)
          stopPreviewVisibilityListener = registry.onPreviewVisibilityChanged(trigger);
        // Each dependency is one bounded row set rather than a materialized
        // history result.
        const dependencyQueries = [
          db.live.query("SELECT MAX(commit_sequence) AS commit_sequence FROM canonical_commits", [], trigger),
          ...(definition.dependsOn.includes("exchangeRates")
            ? [db.live.query("SELECT rate_date, currency, twd_per_unit, source, fetched_at FROM exchange_rates", [], trigger)]
            : []),
          ...(dependsOnPreview ? [db.live.query(PREVIEW_DATA_FINGERPRINT_SQL, [], trigger)] : []),
        ];
        const stop = async () => {
          if (stopped) return;
          stopped = true;
          stopWatch();
          stopPreviewVisibilityListener();
          if (entries.get(key) === entry) entries.delete(key);
          const dependencies = await Promise.allSettled(dependencyQueries);
          await Promise.allSettled(dependencies.flatMap((result) =>
            result.status === "fulfilled" ? [result.value.unsubscribe()] : []));
        };
        entry = { stop, listeners };
        entries.set(key, entry);
        let delivered = false;
        const listener = {
          value: (value: unknown) => {
            delivered = true;
            onRows([value]);
          },
          error: (error: unknown) => onError?.(error),
        };
        entry.listeners.add(listener);
        try {
          await Promise.all(dependencyQueries);
          initialReady = true;
          await recompute();
        } catch (error) {
          for (const observer of listeners) observer.error(error);
          await stop();
          throw error;
        }
        if (!delivered && entry.lastValue !== undefined && !stopped) onRows([entry.lastValue]);
        return async () => {
          if (!entry) return;
          entry.listeners.delete(listener);
          if (entry.listeners.size === 0) await entry.stop();
        };
      }
      const listener = {
        value: (value: unknown) => onRows([value]),
        error: (error: unknown) => onError?.(error),
      };
      entry.listeners.add(listener);
      if (entry.lastValue !== undefined) onRows([entry.lastValue]);
      return async () => {
        if (!entry) return;
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0) await entry.stop();
      };
    },
  };
}
