import type { PGliteWithLive } from "@electric-sql/pglite/live";
import { MANUAL_ASSET_REVISION_SQL } from "../src/ledger/pglite/manual-assets.ts";
import { PREVIEW_DATA_REVISION_SQL } from "../src/ledger/pglite/preview-financial-data.ts";
import type { PGliteFinancialPageActionEvents } from "./pglite-financial-registry.ts";

export type LiveViewDependencySignals = Readonly<{
  /** The dependency changed; the view reads its page again. */
  changed(): void;
  /** The dependency itself failed; every listener of the view hears the error. */
  failed(error: unknown): void;
}>;

/** One thing a live view reads (ADR 0088). `watch` resolves with its stop once it is watching. */
export type LiveViewDependency = Readonly<{
  watch(signals: LiveViewDependencySignals): Promise<() => Promise<void>>;
}>;

/** What a view definition may name besides canonical commits, which every Financial page reads. */
export type LiveViewDependencyName = "exchangeRates" | "preview" | "manual" | "today";

export type LiveViewDependencies = Readonly<Record<"canonical" | LiveViewDependencyName, LiveViewDependency>>;

/** The person's date, read by the registry and watched by the views that count dated rows. */
export type LocalDateClock = LiveViewDependency & Readonly<{ today(): string }>;

export function liveRowDependency(db: PGliteWithLive, sql: string): LiveViewDependency {
  return {
    async watch({ changed }) {
      const query = await db.live.query(sql, [], changed);
      return () => query.unsubscribe();
    },
  };
}

/** Preview rows and the Preview features setting, which lives in settings rather than in preview data. */
function previewDependency(db: PGliteWithLive, events: PGliteFinancialPageActionEvents): LiveViewDependency {
  const revision = liveRowDependency(db, PREVIEW_DATA_REVISION_SQL);
  return {
    async watch(signals) {
      const stopRevision = await revision.watch(signals);
      const stopVisibility = events.onPreviewVisibilityChanged?.(signals.changed) ?? (() => {});
      return async () => {
        stopVisibility();
        await stopRevision();
      };
    },
  };
}

/**
 * One date watch per worker. Nothing is written when midnight passes, so it
 * reads the date each minute and reports only a change; reading it again also
 * follows a change of the configured timezone.
 */
export function createLocalDateClock(today: () => string, intervalMs = 60_000): LocalDateClock {
  const watchers = new Set<LiveViewDependencySignals>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let watchedDate: string | null = null;
  const read = () => {
    try {
      return today();
    } catch (error) {
      for (const watcher of watchers) watcher.failed(error);
      return null;
    }
  };
  const poll = () => {
    const date = read();
    if (date === null || date === watchedDate) return;
    const moved = watchedDate !== null;
    watchedDate = date;
    if (moved) for (const watcher of watchers) watcher.changed();
  };
  return {
    today,
    async watch(signals) {
      watchers.add(signals);
      if (!timer) {
        watchedDate = read();
        timer = setInterval(poll, intervalMs);
        timer.unref?.();
      }
      return async () => {
        watchers.delete(signals);
        if (watchers.size > 0 || !timer) return;
        clearInterval(timer);
        timer = undefined;
      };
    },
  };
}

export function createPGliteLiveViewDependencies(
  db: PGliteWithLive,
  events: PGliteFinancialPageActionEvents,
  clock: LocalDateClock,
): LiveViewDependencies {
  return {
    canonical: liveRowDependency(db, "SELECT MAX(commit_sequence) AS commit_sequence FROM canonical_commits"),
    exchangeRates: liveRowDependency(db, "SELECT rate_date, currency, twd_per_unit, source, fetched_at FROM exchange_rates"),
    preview: previewDependency(db, events),
    manual: liveRowDependency(db, MANUAL_ASSET_REVISION_SQL),
    today: clock,
  };
}
