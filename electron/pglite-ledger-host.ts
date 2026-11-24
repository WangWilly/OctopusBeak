import type { PGliteWithLive } from "@electric-sql/pglite/live";
import type { ViewSource } from "../src/lib/data-views/server/view-port.ts";
import type { PreviewVisibility } from "../src/ledger/pglite/preview-financial-data.ts";
import { createPGliteFinancialPageActions } from "../src/ledger/pglite/spending-command.ts";
import type { FinancialPageActions } from "../src/ledger/pglite/financial-page-actions.ts";
import type { PGliteStore } from "../src/ledger/pglite/transaction.ts";
import type { CardIdentitySecret } from "../src/lib/shared-identity/card-identity-secret.ts";
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
  cardIdentitySecret?: () => CardIdentitySecret | undefined;
}>;

/** The parts of the ledger that financial calls and live views share (ADR 0120). */
export type PGliteLedgerHost = Readonly<{
  registry: PGliteLedgerRegistry;
  /** The registry's own page actions, whose results the Spending view publishes. */
  financialPageActions: FinancialPageActions;
  views: ViewSource;
  /** Orders financial calls and view recomputes on the one database. */
  scheduler: PGliteWorkScheduler;
}>;

/** Assembles the ledger over a live-capable PGlite and the financial store installed on it. */
export function createPGliteLedgerHost(
  db: PGliteWithLive,
  store: PGliteStore,
  { clock, previewVisibility, expectedSources, cardIdentitySecret }: PGliteLedgerHostReaders,
): PGliteLedgerHost {
  // One queue lets a Pairing click start before view refreshes that are still waiting.
  const scheduler = createPGliteWorkScheduler();
  const registry = createPGliteFinancialRegistry(store, createPGliteFinancialPageActions(store), {
    previewVisibility,
    today: clock.today,
    cardIdentitySecret,
    runBackgroundStep: (step) => scheduler.scheduleStep(step),
  });
  const views = createPGliteFinancialLiveViews(
    registry,
    createPGliteLiveViewDependencies(db, registry, clock),
    expectedSources,
    scheduler,
  );
  return Object.freeze({ registry, financialPageActions: registry.financialPageActions, views, scheduler });
}
