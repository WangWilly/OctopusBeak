import type { PGliteWithLive } from "@electric-sql/pglite/live";
import { applySpendingSummaryDelta, type SpendingPageDto } from "../src/lib/spending/model.ts";
import type { SpendingLoadInput } from "../src/lib/spending/contracts.ts";
import type { PGliteFinancialExpectedSources, PGliteFinancialRegistry } from "./pglite-financial-rpc-client.ts";
import type { PGliteFinancialPageActionEvents, PGliteWorkScheduler } from "./pglite-financial-registry.ts";

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

export type PGliteFinancialLiveView =
  | "financial.overview.current"
  | "financial.assets.current"
  | "financial.liabilities.current"
  | "financial.spending.current";

/**
 * Subscribe to a complete page DTO while using only the tables that the page
 * consumes as PGlite live dependencies.  Recomputations are coalesced and
 * serialized, so a burst of commits cannot publish an older DTO after a newer
 * one.
 */
export function createPGliteFinancialLiveViews(
  db: PGliteWithLive,
  registry: PGliteFinancialRegistry & PGliteFinancialPageActionEvents,
  expectedSources: () => PGliteFinancialExpectedSources = () => [],
  scheduler?: PGliteWorkScheduler,
) {
  const entries = new Map<string, {
    stop: () => Promise<void>;
    listeners: Set<{ value(value: unknown): void; error(error: unknown): void }>;
    lastValue?: unknown;
  }>();
  const supported = new Set<string>([
    "financial.overview.current",
    "financial.assets.current",
    "financial.liabilities.current",
    "financial.spending.current",
  ]);
  return {
    async subscribe(view: string, params: object, onRows: (rows: unknown[]) => void, onError?: (error: unknown) => void): Promise<() => Promise<void>> {
      if (!supported.has(view)) throw new Error(`Unknown financial live view: ${view}`);
      const key = `${view}:${JSON.stringify(params)}`;
      let entry = entries.get(key);
      if (!entry) {
        const listeners = new Set<{ value(value: unknown): void; error(error: unknown): void }>();
        let running = false;
        let queued = false;
        let initialReady = false;
        let stopped = false;
        let stopPageActionListener = () => {};
        let stopPreviewVisibilityListener = () => {};
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
              const load = (): Promise<unknown> => view === "financial.overview.current"
                ? registry["financial.overview.current"]([sources])
                : view === "financial.assets.current"
                  ? registry["financial.assets.current"]([sources])
                  : view === "financial.liabilities.current"
                    ? registry["financial.liabilities.current"]([sources])
                  : registry["financial.spending.current"]([params as SpendingLoadInput]);
              const value = scheduler ? await scheduler.schedule("background", load) : await load();
              if (stopped) return;
              entry!.lastValue = value;
              for (const listener of listeners) {
                try {
                  listener.value(value);
                } catch {
                  // One renderer observer cannot stop the shared publication.
                }
              }
            } while (queued && !stopped);
          } finally {
            running = false;
            if (queued && !stopped) {
              queued = false;
              void recompute().catch((error) => {
                for (const listener of listeners) listener.error(error);
              });
            }
          }
        };
        const trigger = () => {
          if (!initialReady) return;
          if (view === "financial.spending.current") {
            if (registry.isSpendingPageActionInFlight?.()) return;
            // A page action already publishes its exact summary delta. The
            // commit notification may arrive just after that publication;
            // avoid rebuilding the same full summary ahead of a Pairing click.
            // A separate commit still has a newer version and is recomputed.
            void registry["financial.spending.version"]([]).then((version) => {
              if (stopped) return;
              const published = (entry?.lastValue as SpendingPageDto | undefined)?.purchaseReport.knowledgeAt ?? -1;
              if (version > published) return recompute();
            }).catch((error) => {
              for (const listener of listeners) listener.error(error);
            });
            return;
          }
          void recompute().catch((error) => {
            for (const listener of listeners) listener.error(error);
          });
        };
        if (view === "financial.spending.current" && registry.onSpendingPageActionSettled) {
          stopPageActionListener = registry.onSpendingPageActionSettled((result) => {
            void (async () => {
              let actionResultPublished = false;
              if (result) {
                const previous = entry?.lastValue as SpendingPageDto | undefined;
                const previousVersion = previous?.purchaseReport.knowledgeAt;
                if (previous?.purchaseReport.summary && previousVersion === result.baseKnowledgeAt) {
                  try {
                    const summary = applySpendingSummaryDelta(
                      previous.purchaseReport.summary,
                      result.baseKnowledgeAt,
                      result.knowledgeAt,
                      result.summaryDelta,
                    );
                    const purchaseReport = Object.freeze({
                      ...previous.purchaseReport,
                      knowledgeAt: result.knowledgeAt,
                      totalsByCurrency: summary.totalsByCurrency,
                      summary,
                    });
                    const patched: SpendingPageDto = Object.freeze({
                      ...previous,
                      canonical: Object.freeze({
                        ...previous.canonical,
                        availability: summary.recordCount > 0 ? "available" : "empty",
                        knowledgePoint: result.knowledgeAt,
                        totalsByCurrency: summary.totalsByCurrency.map((amount) => ({
                          currency: amount.currency,
                          value: Number(amount.coefficient) / 10 ** amount.scale,
                          exact: { coefficient: amount.coefficient, scale: amount.scale },
                        })),
                        totalStatus: "complete",
                      }),
                      purchaseReport,
                    });
                    entry!.lastValue = patched;
                    for (const listener of listeners) {
                      try {
                        listener.value(patched);
                      } catch {
                        // One renderer observer cannot stop the shared publication.
                      }
                    }
                    actionResultPublished = true;
                  } catch {
                    // The version check below schedules an authoritative refresh if this delta no longer applies.
                  }
                } else if (previousVersion === result.knowledgeAt) {
                  actionResultPublished = true;
                }
              }

              const currentVersion = await registry["financial.spending.version"]([]);
              const published = entry?.lastValue as SpendingPageDto | undefined;
              const publishedVersion = published?.purchaseReport.knowledgeAt ?? -1;
              const actionVersion = result?.knowledgeAt ?? -1;
              if (currentVersion > publishedVersion || (result && !actionResultPublished && currentVersion >= actionVersion)) {
                if (!stopped) void recompute().catch((error) => {
                  for (const listener of listeners) listener.error(error);
                });
              }
            })().catch((error) => {
              for (const listener of listeners) listener.error(error);
            });
          });
        }
        const showsPreview = view === "financial.overview.current" || view === "financial.assets.current" || view === "financial.liabilities.current";
        if (showsPreview && registry.onPreviewVisibilityChanged)
          stopPreviewVisibilityListener = registry.onPreviewVisibilityChanged(trigger);
        // Financial pages depend on every canonical commit because source
        // admissions, e-invoice/card commits, and projection rebuilds can
        // change the knowledge point even when a current projection marker
        // is unchanged.  The aggregate is one bounded dependency row rather
        // than a materialized history result.  Overview also converts
        // with exchange rates.  Automation progress/history
        // has its own runtime stream and must not invalidate a complete
        // financial DTO on every task update.
        const dependencyQueries = [
          db.live.query("SELECT MAX(commit_sequence) AS commit_sequence FROM canonical_commits", [], trigger),
          ...(view === "financial.overview.current"
            ? [db.live.query("SELECT rate_date, currency, twd_per_unit, source, fetched_at FROM exchange_rates", [], trigger)]
            : []),
          ...(showsPreview ? [db.live.query(PREVIEW_DATA_FINGERPRINT_SQL, [], trigger)] : []),
        ];
        const stop = async () => {
          if (stopped) return;
          stopped = true;
          stopPageActionListener();
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
