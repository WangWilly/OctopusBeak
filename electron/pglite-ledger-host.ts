import type { PGliteWithLive } from "@electric-sql/pglite/live";
import type { ViewSource } from "../src/lib/data-views/server/view-port.ts";
import type { PreviewVisibility } from "../src/ledger/pglite/preview-financial-data.ts";
import { createPGliteSpendingPageActions } from "../src/ledger/pglite/spending-command.ts";
import type { SpendingPageActions } from "../src/ledger/pglite/spending-page-actions.ts";
import type { PGliteStore } from "../src/ledger/pglite/transaction.ts";
import type { PGliteFinancialExpectedSources } from "../src/lib/pglite-rpc/pglite-financial-contracts.ts";
import { createPGliteLiveViewDependencies, type LocalDateClock } from "./pglite-financial-live-dependencies.ts";
import { createPGliteFinancialLiveViews } from "./pglite-financial-live-views.ts";
import { createPGliteFinancialRegistry, type PGliteLedgerRegistry } from "./pglite-financial-registry.ts";
import { createPGliteWorkScheduler, type PGliteWorkScheduler } from "./pglite-financial-rpc-server.ts";

/** What the ledger reads from the person's settings and clock. */
export type PGliteLedgerHostReaders = Readonly<{
  clock: LocalDateClock;
  previewVisibility?: () => PreviewVisibility;
  expectedSources?: () => PGliteFinancialExpectedSources;
}>;

/** The parts of the ledger that financial calls and live views share (ADR 0120). */
export type PGliteLedgerHost = Readonly<{
  registry: PGliteLedgerRegistry;
  /** The registry's own page actions, whose results the Spending view publishes. */
  spendingPageActions: SpendingPageActions;
  views: ViewSource;
  /** Orders financial calls and view recomputes on the one database. */
  scheduler: PGliteWorkScheduler;
}>;

/** Assembles the ledger over a live-capable PGlite and the financial store installed on it. */
export function createPGliteLedgerHost(
  db: PGliteWithLive,
  store: PGliteStore,
  { clock, previewVisibility, expectedSources }: PGliteLedgerHostReaders,
): PGliteLedgerHost {
  const registry = createPGliteFinancialRegistry(store, createPGliteSpendingPageActions(store), {
    previewVisibility,
    today: clock.today,
  });
  // One queue lets a Pairing click start before view refreshes that are still waiting.
  const scheduler = createPGliteWorkScheduler();
  const views = createPGliteFinancialLiveViews(
    registry,
    createPGliteLiveViewDependencies(db, registry, clock),
    expectedSources,
    scheduler,
  );
  return Object.freeze({ registry, spendingPageActions: registry.spendingPageActions, views, scheduler });
}
