import type { SpendingPageActionResult } from "../src/lib/spending/model.ts";
import { NO_PREVIEW_VISIBILITY, type PreviewVisibility } from "../src/ledger/pglite/preview-financial-data.ts";
import {
  createPGliteSpendingQuery,
} from "../src/ledger/pglite/spending-query.ts";
import {
  createPGliteSpendingCommands,
} from "../src/ledger/pglite/spending-command.ts";
import {
  createPGliteCanonicalSourceStore,
} from "../src/ledger/pglite/canonical-source-store.ts";
import {
  commitPGliteCanonicalDepositCapture,
} from "../src/ledger/pglite/deposit.ts";
import {
  commitPGliteCanonicalMixedCapture,
} from "../src/ledger/pglite/mixed-commit.ts";
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
import { dateInTimeZone } from "../src/lib/shared-ledger/twd-valuation.ts";
import { DEFAULT_SYSTEM_TIMEZONE } from "../src/lib/time/timezone.ts";
import type { PGliteCanonicalCommitOptions } from "../src/ledger/pglite/canonical-source-store.ts";
import {
  readAssetsPage,
  readLiabilitiesPage,
  readOverviewPage,
  type FinancialPageScope,
} from "../src/ledger/pglite/financial-pages.ts";
import type { PGliteFinancialPort, PGliteFinancialRegistry } from "./pglite-financial-contracts.ts";

export type PGliteFinancialPageActionEvents = Readonly<{
  isSpendingPageActionInFlight?(): boolean;
  onSpendingPageActionSettled?(listener: (result: SpendingPageActionResult | null) => void): () => void;
  onPreviewVisibilityChanged?(listener: () => void): () => void;
}>;
type PGliteFinancialRegistryWithPageActionEvents = PGliteFinancialRegistry & Required<PGliteFinancialPageActionEvents>;

export type PGliteFinancialRegistryOptions = Readonly<{
  /** The store holds the Manual Asset tables; the desktop worker installs them, a ledger-only check does not. */
  manualAssets?: boolean;
  /** The person's local date, which no manual row may be dated after, and which decides whether an ended asset still counts. */
  today?: () => string;
}>;

export function createPGliteFinancialRegistry(
  store: PGliteStore,
  previewVisibility: () => PreviewVisibility = () => NO_PREVIEW_VISIBILITY,
  options: PGliteFinancialRegistryOptions = {},
): PGliteFinancialRegistryWithPageActionEvents {
  const manualAssets = options.manualAssets === true;
  const today = options.today ?? (() => dateInTimeZone(new Date(), DEFAULT_SYSTEM_TIMEZONE));
  const manualClock = { now: () => new Date().toISOString(), today };
  const pageScope = (expectedSources: FinancialPageScope["expectedSources"]): FinancialPageScope =>
    ({ expectedSources, previewVisibility: previewVisibility(), manualAssets, today: today() });
  const spending = createPGliteSpendingQuery(store);
  const commands = createPGliteSpendingCommands(store);
  const source = createPGliteCanonicalSourceStore(store);
  let spendingPageActionCount = 0;
  let latestSettledPageAction: SpendingPageActionResult | null = null;
  const pageActionListeners = new Set<(result: SpendingPageActionResult | null) => void>();
  const previewVisibilityListeners = new Set<() => void>();
  return Object.freeze({
    "financial.overview.current": ([expectedSources = []]) =>
      store.transaction((transaction) => readOverviewPage(transaction, pageScope(expectedSources))),
    "financial.assets.current": ([expectedSources = []]) =>
      store.transaction((transaction) => readAssetsPage(transaction, pageScope(expectedSources))),
    "financial.liabilities.current": ([expectedSources = []]) =>
      store.transaction((transaction) => readLiabilitiesPage(transaction, pageScope(expectedSources))),
    "financial.spending.current": ([input = {}]) =>
      store.transaction((transaction) => readSpendingPage(transaction, { manualAssets }, input)),
    "financial.spending.recordPage": ([request]) => spending.recordPage(request),
    "financial.spending.candidatePage": ([request]) => spending.candidatePage(request),
    "financial.spending.pendingOverview": ([request]) => spending.pendingOverview(request),
    "financial.spending.mergeLog": ([request]) => spending.mergeLog(request),
    "financial.spending.monthInsight": ([request]) => spending.monthInsight(request),
    "financial.spending.merchantStats": ([request]) => spending.merchantStats(request),
    "financial.spending.version": () =>
      store.transaction((transaction) => readSpendingPageVersion(transaction, { manualAssets })),
    "financial.spending.prewarmPairing"([dataVersion]) {
      return spending.prewarmPairing(dataVersion);
    },
    "financial.spending.pairing"([input]) {
      return spending.pairingCandidates(input);
    },
    isSpendingPageActionInFlight() {
      return spendingPageActionCount > 0;
    },
    onSpendingPageActionSettled(listener) {
      pageActionListeners.add(listener);
      return () => pageActionListeners.delete(listener);
    },
    onPreviewVisibilityChanged(listener) {
      previewVisibilityListeners.add(listener);
      return () => previewVisibilityListeners.delete(listener);
    },
    async "financial.preview.visibilityChanged"() {
      for (const listener of previewVisibilityListeners) listener();
    },
    "financial.spending.pageAction"([request]) {
      if (spendingPageActionCount === 0) latestSettledPageAction = null;
      spendingPageActionCount += 1;
      return commands.pageAction(request).then((result) => {
        if (!latestSettledPageAction || result.knowledgeAt >= latestSettledPageAction.knowledgeAt)
          latestSettledPageAction = result;
        return result;
      }).finally(() => {
        spendingPageActionCount -= 1;
        if (spendingPageActionCount !== 0) return;
        const publication = latestSettledPageAction;
        latestSettledPageAction = null;
        for (const listener of pageActionListeners) {
          try {
            listener(publication);
          } catch {
            // A live view cannot change the action result or other listeners.
          }
        }
      });
    },
    "financial.spending.setPurchaseCategory"([input]) {
      return commands.setPurchaseCategory(input);
    },
    "financial.spending.confirmStrongCandidates"([input]) {
      return commands.confirmStrongCandidates(input);
    },
    "financial.source.admit": ([request], options) => source.admit(request, options),
    "financial.source.commit": ([request], options) => source.commit(request, options),
    "financial.deposit.commit": ([request], options) => commitPGliteCanonicalDepositCapture(store, request, options),
    "financial.mixed.commit": ([request], options) => commitPGliteCanonicalMixedCapture(store, request, options),
    "financial.balance.capture": ([request], options) => commitPGliteCanonicalBalanceCapture(store, request, options),
    "financial.einvoice.commit": ([request], options) => commitPGliteCanonicalEInvoiceCapture(store, request, options),
    "financial.creditCard.commit": ([request], options) => commitPGliteCanonicalCreditCardCapture(store, request, options),
    "financial.creditCard.balance": ([request], options) => commitPGliteCanonicalCreditCardBalanceCapture(store, request, options),
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
      if (!manualAssets) throw new Error("This store holds no Manual Asset tables.");
      return applyManualAssetCommand(store, command, manualClock);
    },
    "financial.canonical.reset": () => resetPGliteCanonicalStore(store),
    "financial.canonical.resetRequired": () => canonicalResetRequiredNamespaces(store),
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

/** Build the version's pairing index ahead of a click, never a full Spending read. */
export async function prewarmPGlitePairingCandidates(
  financial: PGliteFinancialPort,
  input: Readonly<{ dataVersion: number }>,
) {
  const currentVersion = await financial.request("financial.spending.prewarmPairing", [input.dataVersion]);
  return currentVersion === input.dataVersion
    ? { status: "ready" as const, dataVersion: input.dataVersion, reused: false }
    : { status: "stale" as const, dataVersion: currentVersion, requestedVersion: input.dataVersion };
}
