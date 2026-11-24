import { NO_PREVIEW_VISIBILITY, type PreviewVisibility } from "../src/ledger/pglite/preview-financial-data.ts";
import {
  createPGliteSpendingQuery,
} from "../src/ledger/pglite/spending-query.ts";
import {
  createPGliteCanonicalSourceStore,
} from "../src/ledger/pglite/canonical-source-store.ts";
import {
  commitPGliteCanonicalDepositCapture,
} from "../src/ledger/pglite/deposit.ts";
import {
  commitPGliteCanonicalBalanceCapture,
} from "../src/ledger/pglite/balance.ts";
import {
  commitPGliteCanonicalEInvoiceCapture,
} from "../src/ledger/pglite/einvoice.ts";
import {
  commitPGliteCanonicalCreditCardBalanceCapture,
  commitPGliteCanonicalCreditCardCapture,
} from "../src/ledger/pglite/credit-card.ts";
import {
  commitPGliteCanonicalLoanCapture,
} from "../src/ledger/pglite/loan.ts";
import {
  commitPGliteCanonicalInvestmentCapture,
  listPGliteTdccFundAccounts,
} from "../src/ledger/pglite/investment.ts";
import {
  resolvePGliteAccountIdentityContinuity,
} from "../src/ledger/pglite/account-identity-continuity.ts";
import {
  canonicalResetRequiredNamespaces,
  resetPGliteCanonicalStore,
} from "../src/ledger/pglite/canonical-reset.ts";
import {
  resolvePGliteCanonicalLoanRepaymentRelations,
  resolvePGliteCanonicalInvestmentFundingRelations,
  queryPGliteCurrentLoanRepaymentRelations,
  queryPGliteCurrentLoanRepaymentSettlementGroups,
  queryPGliteCurrentInvestmentFundingRelations,
} from "../src/ledger/pglite/relations.ts";
import type { PGliteStore } from "../src/ledger/pglite/transaction.ts";
import { applyManualAssetCommand } from "../src/ledger/pglite/manual-assets.ts";
import { readSpendingPage, readSpendingPageVersion } from "../src/ledger/pglite/spending-page.ts";
import { readCashFlowPage } from "../src/ledger/pglite/cash-flow-page.ts";
import type { FinancialPageActions } from "../src/ledger/pglite/financial-page-actions.ts";
import { dateInTimeZone } from "../src/lib/shared-ledger/twd-valuation.ts";
import { DEFAULT_SYSTEM_TIMEZONE } from "../src/lib/time/timezone.ts";
import type { PGliteCanonicalCommitOptions } from "../src/ledger/pglite/canonical-source-store.ts";
import type { CardIdentitySecret } from "../src/lib/shared-identity/card-identity-secret.ts";
import { cardAccountNamespaces } from "../src/ledger/pglite/card-identity-secret.ts";
import { planLedgerCompaction } from "../src/ledger/pglite/compaction-plan.ts";
import { compactLedgerDomainAndCounts } from "../src/ledger/pglite/compaction.ts";
import {
  readAssetsPage,
  readLiabilitiesPage,
  readOverviewPage,
  type FinancialPageScope,
} from "../src/ledger/pglite/financial-pages.ts";
import type { PGliteFinancialPort, PGliteFinancialRegistry } from "../src/lib/pglite-rpc/pglite-financial-contracts.ts";

export type PGliteFinancialPreviewEvents = Readonly<{
  onPreviewVisibilityChanged?(listener: () => void): () => void;
}>;

/** The Financial page actions a registry runs, which its live views watch (ADR 0105, ADR 0120). */
export type PGliteFinancialRegistryPageActions = Readonly<{
  financialPageActions: FinancialPageActions;
}>;

export type PGliteLedgerRegistry = PGliteFinancialRegistry
  & Required<PGliteFinancialPreviewEvents>
  & PGliteFinancialRegistryPageActions;

export type PGliteFinancialRegistryOptions = Readonly<{
  /** Which Preview data the pages show, read at each page read. */
  previewVisibility?: () => PreviewVisibility;
  /** The person's local date, which no manual row may be dated after, and which decides whether an ended asset still counts. */
  today?: () => string;
  /** The Card identity secret workflows derive card identities from, read at each card commit (ADR 0149). */
  cardIdentitySecret?: () => CardIdentitySecret | undefined;
  /**
   * Queues one step of a stepped operation on the background lane; by default
   * a step runs at once. It must not be called from inside a scheduled job,
   * where the step would wait behind that job: the worker passes
   * `scheduler.scheduleStep`, which refuses that call.
   */
  runBackgroundStep?: <T>(step: () => Promise<T>) => Promise<T>;
}>;

export function createPGliteFinancialRegistry(
  store: PGliteStore,
  financialPageActions: FinancialPageActions,
  options: PGliteFinancialRegistryOptions = {},
): PGliteLedgerRegistry {
  const previewVisibility = options.previewVisibility ?? (() => NO_PREVIEW_VISIBILITY);
  const today = options.today ?? (() => dateInTimeZone(new Date(), DEFAULT_SYSTEM_TIMEZONE));
  const cardIdentity = (commit: PGliteCanonicalCommitOptions | undefined) =>
    ({ ...commit, cardIdentitySecret: options.cardIdentitySecret?.() });
  const manualClock = { now: () => new Date().toISOString(), today };
  const pageScope = (expectedSources: FinancialPageScope["expectedSources"]): FinancialPageScope =>
    ({ expectedSources, previewVisibility: previewVisibility(), today: today() });
  const spending = createPGliteSpendingQuery(store);
  const source = createPGliteCanonicalSourceStore(store);
  const previewVisibilityListeners = new Set<() => void>();
  return Object.freeze({
    "financial.overview.current": ([expectedSources = []]) =>
      store.transaction((transaction) => readOverviewPage(transaction, pageScope(expectedSources))),
    "financial.assets.current": ([expectedSources = []]) =>
      store.transaction((transaction) => readAssetsPage(transaction, pageScope(expectedSources))),
    "financial.liabilities.current": ([expectedSources = []]) =>
      store.transaction((transaction) => readLiabilitiesPage(transaction, pageScope(expectedSources))),
    "financial.spending.current": ([input = {}]) =>
      store.transaction((transaction) => readSpendingPage(transaction, input)),
    "financial.cashFlow.current": ([request]) =>
      store.transaction((transaction) => readCashFlowPage(transaction, request)),
    "financial.spending.recordPage": ([request]) => spending.recordPage(request),
    "financial.spending.classifyQueue": ([request]) => spending.classifyQueue(request),
    "financial.spending.candidatePage": ([request]) => spending.candidatePage(request),
    "financial.spending.pendingOverview": ([request]) => spending.pendingOverview(request),
    "financial.spending.mergeLog": ([request]) => spending.mergeLog(request),
    "financial.spending.monthInsight": ([request]) => spending.monthInsight(request),
    "financial.spending.merchantStats": ([request]) => spending.merchantStats(request),
    "financial.spending.version": () =>
      store.transaction((transaction) => readSpendingPageVersion(transaction)),
    "financial.spending.prewarmPairing"([dataVersion]) {
      return spending.prewarmPairing(dataVersion);
    },
    "financial.spending.pairing"([input]) {
      return spending.pairingCandidates(input);
    },
    onPreviewVisibilityChanged(listener) {
      previewVisibilityListeners.add(listener);
      return () => previewVisibilityListeners.delete(listener);
    },
    async "financial.preview.visibilityChanged"() {
      for (const listener of previewVisibilityListeners) listener();
    },
    financialPageActions,
    "financial.pageAction": ([request]) => financialPageActions.run(request),
    "financial.source.admit": ([request], options) => source.admit(request, options),
    "financial.source.commit": ([request], options) => source.commit(request, options),
    "financial.deposit.commit": ([request], options) => commitPGliteCanonicalDepositCapture(store, request, options),
    "financial.balance.capture": ([request], options) => commitPGliteCanonicalBalanceCapture(store, request, options),
    "financial.einvoice.commit": ([request], options) => commitPGliteCanonicalEInvoiceCapture(store, request, options),
    "financial.creditCard.commit": ([request], commit) =>
      commitPGliteCanonicalCreditCardCapture(store, request, cardIdentity(commit)),
    "financial.creditCard.balance": ([request], commit) =>
      commitPGliteCanonicalCreditCardBalanceCapture(store, request, cardIdentity(commit)),
    "financial.loan.commit": ([request], options) => commitPGliteCanonicalLoanCapture(store, request, options),
    "financial.investment.commit": ([request], options) => commitPGliteCanonicalInvestmentCapture(store, request, options),
    "financial.loanRelations.resolve": ([request], options) => resolvePGliteCanonicalLoanRepaymentRelations(store, request, options),
    "financial.investmentRelations.resolve": ([request = {}], options) => resolvePGliteCanonicalInvestmentFundingRelations(store, request, options),
    "financial.loanRelations.current": ([options]) => queryPGliteCurrentLoanRepaymentRelations(store, options),
    "financial.loanSettlementGroups.current": ([options]) => queryPGliteCurrentLoanRepaymentSettlementGroups(store, options),
    "financial.investmentRelations.current": ([sourceConnectionKey]) => queryPGliteCurrentInvestmentFundingRelations(store, sourceConnectionKey),
    "financial.tdccFundAccounts.list": ([connection]) => listPGliteTdccFundAccounts(store, connection),
    "financial.accountIdentity.continuity": ([request]) => resolvePGliteAccountIdentityContinuity(store, request),
    "financial.manualAssets.apply"([command]) {
      return applyManualAssetCommand(store, command, manualClock);
    },
    "financial.canonical.reset": () => resetPGliteCanonicalStore(store),
    "financial.canonical.resetRequired": () =>
      canonicalResetRequiredNamespaces(store, options.cardIdentitySecret?.()),
    "financial.canonical.cardAccountNamespaces": () => cardAccountNamespaces(store),
    // Not yet for the UI or the live worker: one subject step can hold the
    // ledger for seconds to tens of seconds until it is split further, for
    // example by record kind or occurrence-key range (see planLedgerCompaction).
    "financial.canonical.compactionPlan": (_args, request) =>
      planLedgerCompaction(store, { runStep: options.runBackgroundStep, signal: request?.signal }),
    // Not for the UI: one transaction that holds the ledger until it ends (ADR 0154).
    "financial.canonical.compactDomainAndCounts": (_args, request) =>
      compactLedgerDomainAndCounts(store, { signal: request?.signal }),
  });
}

/** Serve a worker-owned registry through the same port interface the RPC client offers. */
export function createPGliteFinancialLocalPort(registry: PGliteFinancialRegistry): PGliteFinancialPort {
  return Object.freeze({
    request: (operation, args, options) => (registry[operation] as (
      args: unknown,
      options?: PGliteCanonicalCommitOptions,
    ) => Promise<never>)(args, options),
  });
}
