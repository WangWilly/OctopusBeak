import { SpendingPageVersionError, type SpendingPageReadResult } from "../src/lib/spending/page-reader.ts";
import type { PGliteWithLive } from "@electric-sql/pglite/live";
import type { AssetsPageDto } from "../src/lib/assets/types.ts";
import type { LiabilitiesPageDto } from "../src/lib/liabilities/types.ts";
import type { OverviewHoldingPriceDto, OverviewPageDto } from "../src/lib/overview/types.ts";
import {
  applySpendingSummaryDelta,
  type SpendingCandidatePageDto,
  type SpendingCandidatePageRequest,
  type SpendingPageDto,
  type SpendingPageActionRequest,
  type SpendingPageActionResult,
  type SpendingRecordPageDto,
  type SpendingRecordPageRequest,
} from "../src/lib/spending/model.ts";
import type {
  SpendingLoadInput,
} from "../src/lib/spending/contracts.ts";
import type {
  SpendingCandidateActionInput,
  SpendingConfirmActionInput,
  SpendingPairingCandidatesInput,
  SpendingPairingCandidatesResult,
  SpendingLinkActionInput,
  SpendingPurchaseActionResult,
  SpendingPurchaseCategoryRequest,
  SpendingPurchaseCategoryResult,
  SpendingMergeLogDto,
  SpendingMergeLogRequest,
  SpendingMerchantStatsDto,
  SpendingMerchantStatsRequest,
  SpendingMonthInsightDto,
  SpendingMonthInsightRequest,
  SpendingPendingOverviewDto,
  SpendingPendingOverviewRequest,
  SpendingStrongConfirmRequest,
  SpendingStrongConfirmResult,
} from "../src/lib/spending/model.ts";
import { mapCanonicalCreditCard, mapCanonicalProduct } from "../src/lib/shared-ledger/server/canonical-product.ts";
import type { AccountRowDto, CurrencyAmountDto, SummaryMetricDto } from "../src/lib/shared-ledger/types.ts";
import type {
  CanonicalOverviewAmount,
} from "../src/ledger/canonical/canonical-overview-query.ts";
import {
  exactAmountToNumber,
} from "../src/ledger/pglite/overview-amount.ts";
import type { CanonicalOverviewCurrentQueryResult } from "../src/ledger/canonical/canonical-overview-query.ts";
import {
  createPGliteCanonicalOverviewQuery,
  selectPGliteOverviewAssets,
  selectPGliteOverviewLiabilities,
} from "../src/ledger/pglite/overview.ts";
import { readPGliteDailyHistoryWithAccounts, type PGliteDailyHistory } from "../src/ledger/pglite/daily-history.ts";
import { readPGliteHoldingPrices, type PGliteHoldingPrice } from "../src/ledger/pglite/holding-prices.ts";
import {
  NO_PREVIEW_VISIBILITY,
  readPreviewAccounts,
  readPreviewBalanceHistory,
  readPreviewTransactions,
  type PreviewVisibility,
} from "../src/ledger/pglite/preview-financial-data.ts";
import {
  readPreviewCreditAccounts,
  readPreviewCreditBalanceHistory,
  readPreviewPurchases,
  readPreviewStatements,
} from "../src/ledger/pglite/preview-credit.ts";
import {
  countableWithRates,
  previewAccountRow,
  previewBalanceSeries,
  previewCreditAccountRow,
  previewCreditSeries,
  previewSummaryMarkers,
  withPreviewHistory,
  type PreviewBalanceSeries,
} from "../src/ledger/pglite/preview-overview.ts";
import {
  createPGliteSpendingQuery,
} from "../src/ledger/pglite/spending-query.ts";
import {
  createPGliteSpendingCommands,
} from "../src/ledger/pglite/spending-command.ts";
import {
  createPGliteCanonicalSourceStore,
  type PGliteCanonicalFinancialCommitBatchRequest,
  type PGliteCanonicalFinancialCommitRequest,
  type PGliteCanonicalSourceAdmissionRequest,
} from "../src/ledger/pglite/canonical-source-store.ts";
import {
  commitPGliteCanonicalDepositCapture,
  type PGliteCanonicalDepositCommitRequest,
} from "../src/ledger/pglite/deposit.ts";
import {
  commitPGliteCanonicalMixedCapture,
  type PGliteCanonicalMixedCommitRequest,
} from "../src/ledger/pglite/mixed-commit.ts";
import {
  commitPGliteCanonicalBalanceCapture,
  type PGliteCanonicalBalanceCaptureRequest,
} from "../src/ledger/pglite/balance.ts";
import {
  commitPGliteCanonicalEInvoiceCapture,
  PGliteCanonicalEInvoiceAdmissionError,
} from "../src/ledger/pglite/einvoice.ts";
import {
  commitPGliteCanonicalCreditCardBalanceCapture,
  commitPGliteCanonicalCreditCardCapture,
  PGliteCanonicalCreditCardAdmissionError,
  type PGliteCanonicalCreditCardBalanceCaptureRequest,
  type PGliteCanonicalCreditCardCaptureRequest,
} from "../src/ledger/pglite/credit-card.ts";
import {
  commitPGliteCanonicalLoanCapture,
  type PGliteCanonicalLoanCommitRequest,
} from "../src/ledger/pglite/loan.ts";
import {
  commitPGliteCanonicalInvestmentCapture,
  listPGliteTdccFundAccounts,
  type PGliteCanonicalInvestmentCommitRequest,
} from "../src/ledger/pglite/investment.ts";
import {
  resolvePGliteAccountIdentityContinuity,
  type AccountIdentityContinuityRequest,
} from "../src/ledger/pglite/account-identity-continuity.ts";
import {
  resolvePGliteCanonicalLoanRepaymentRelations,
  resolvePGliteCanonicalInvestmentFundingRelations,
  queryPGliteCurrentLoanRepaymentRelations,
  queryPGliteCurrentLoanRepaymentSettlementGroups,
  queryPGliteCurrentInvestmentFundingRelations,
  type PGliteCanonicalLoanRelationResolutionRequest,
  type PGliteCanonicalInvestmentRelationResolutionRequest,
} from "../src/ledger/pglite/relations.ts";
import type { PGliteStore, PGliteTransaction } from "../src/ledger/pglite/transaction.ts";
import type { PGliteCanonicalCommitOptions } from "../src/ledger/pglite/canonical-source-store.ts";
import { PGliteCanonicalSourceAdmissionError } from "../src/ledger/pglite/source-admission-validation.ts";
import type { ExchangeRatePersistencePort, ExchangeRateRecord } from "../src/ledger/exchange-rates.ts";
import {
  appendWorkflowFailureDiagnostic,
  captureSafeWorkflowFailureError,
  type SafeWorkflowFailureError,
  isWorkflowFailureCorrelation,
  workflowFailureDiagnosticRepoRoot,
  WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV,
  type WorkflowFailureCorrelation,
} from "../src/lib/automation/server/workflow-failure-diagnostics.ts";
import type { CanonicalEInvoiceCaptureInput } from "../src/ledger/canonical/einvoice-contract.ts";

type Trace = NonNullable<CurrencyAmountDto["traces"]>[number];
type AggregatedAmount = { exact: { coefficient: string; scale: number }; traces: Trace[] };

import {
  isPGliteFinancialOperation,
  PGLITE_FINANCIAL_CONTRACTS,
  PGliteFinancialError,
  type PGliteFinancialCancelRequest,
  type PGliteFinancialExpectedSources,
  type PGliteFinancialFailureCategory,
  type PGliteFinancialOperation,
  type PGliteFinancialRequest,
  type PGliteFinancialResponse,
  type PGliteFinancialPort,
  type PGliteFinancialRegistry,
  type PGliteFinancialRpcClient,
  type PGliteFinancialRpcPort,
} from "./pglite-financial-rpc-client.ts";
export * from "./pglite-financial-rpc-client.ts";

type RpcPort = PGliteFinancialRpcPort;
type PGliteFinancialPageActionEvents = Readonly<{
  isSpendingPageActionInFlight?(): boolean;
  onSpendingPageActionSettled?(listener: (result: SpendingPageActionResult | null) => void): () => void;
  onPreviewVisibilityChanged?(listener: () => void): () => void;
}>;
type PGliteFinancialRegistryWithPageActionEvents = PGliteFinancialRegistry & Required<PGliteFinancialPageActionEvents>;

export type PGliteFinancialRpcServer = Readonly<{ close(): Promise<void> }>;

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validRequest(value: unknown): value is PGliteFinancialRequest {
  return plainRecord(value)
    && value.kind === "pglite-financial-request"
    && value.version === 1
    && Number.isSafeInteger(value.id)
    && (value.id as number) >= 0
    && typeof value.operation === "string"
    && Array.isArray(value.args)
    && (value.diagnosticContext === undefined || isWorkflowFailureCorrelation(value.diagnosticContext));
}

function validCancelRequest(value: unknown): value is PGliteFinancialCancelRequest {
  return plainRecord(value)
    && value.kind === "pglite-financial-cancel"
    && value.version === 1
    && Number.isSafeInteger(value.id)
    && (value.id as number) >= 0;
}

function genericFailure(
  id: number,
  code: "invalid-request" | "operation-failed" | "worker-closed" | "cancelled",
  category?: PGliteFinancialFailureCategory,
  diagnosticError?: SafeWorkflowFailureError,
): PGliteFinancialResponse {
  return {
    kind: "pglite-financial-response",
    version: 1,
    id,
    ok: false,
    code,
    message: code === "invalid-request"
      ? "Invalid PGlite financial request."
      : code === "worker-closed"
        ? "PGlite financial worker is closed."
        : code === "cancelled"
          ? "PGlite financial operation was cancelled."
        : "PGlite financial operation failed.",
    ...(category ? { category } : {}),
    ...(diagnosticError ? { diagnosticError } : {}),
  };
}

/**
 * Collapse domain errors into a small public vocabulary.  In particular, do
 * not forward Error.message: PostgreSQL and provider messages can contain
 * SQL, paths, account data, or request payload fragments.
 */
function failureCategory(error: unknown): PGliteFinancialFailureCategory {
  // A child socket can forward a request through an already wrapped worker
  // client. Preserve its safe category across that second RPC boundary.
  if (error instanceof PGliteFinancialError && error.code === "operation-failed")
    return error.category ?? "fatal";
  if (error instanceof PGliteCanonicalSourceAdmissionError) {
    if (error.reason === "infrastructure" || error.reason === "cancelled") return "fatal";
    if (error.reason === "capture-overwrite"
      || error.reason === "occurrence-conflict"
      || error.reason === "authority-route-drift") return "conflict";
    return "admission";
  }
  if (error instanceof PGliteCanonicalCreditCardAdmissionError) {
    return error.code === "identity-conflict" || error.code === "revision-conflict"
      ? "conflict"
      : "admission";
  }
  if (error instanceof PGliteCanonicalEInvoiceAdmissionError) {
    return error.code === "revision-conflict" ? "conflict" : "admission";
  }
  // Unknown exceptions may be database, transport, or programming failures.
  // They must remain fatal; matching arbitrary messages would turn a broken
  // schema such as "missing account table" into a recoverable item error.
  return "fatal";
}

function post(port: RpcPort, response: PGliteFinancialResponse): void {
  try {
    port.postMessage(response);
  } catch {
    // The renderer may close while a worker operation is finishing.
  }
}

function exactAmountToDto(amount: CanonicalOverviewAmount): CurrencyAmountDto {
  return {
    currency: amount.currency,
    value: exactAmountToNumber(amount.exact),
    exact: { ...amount.exact },
    traces: amount.traces.map((trace) => ({ ...trace })),
  };
}

function addExactAmounts(
  left: AggregatedAmount["exact"],
  right: AggregatedAmount["exact"],
): AggregatedAmount["exact"] {
  const scale = Math.max(left.scale, right.scale);
  return {
    coefficient: (
      BigInt(left.coefficient) * 10n ** BigInt(scale - left.scale)
      + BigInt(right.coefficient) * 10n ** BigInt(scale - right.scale)
    ).toString(),
    scale,
  };
}

function accumulateAmount(
  target: Map<string, AggregatedAmount>,
  currency: string,
  exact: AggregatedAmount["exact"],
  traces: readonly Trace[],
): void {
  const current = target.get(currency);
  if (!current) target.set(currency, { exact: { ...exact }, traces: [...traces] });
  else {
    current.exact = addExactAmounts(current.exact, exact);
    current.traces.push(...traces);
  }
}

function aggregateAmounts(accounts: readonly AccountRowDto[]): Map<string, AggregatedAmount> {
  const result = new Map<string, AggregatedAmount>();
  for (const account of accounts) {
    for (const amount of account.amountLines) {
      if (!amount.exact) continue;
      accumulateAmount(result, amount.currency, amount.exact, amount.traces ?? []);
    }
  }
  return result;
}

function amountLines(amounts: Map<string, AggregatedAmount>): CurrencyAmountDto[] {
  return [...amounts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([currency, value]) => ({
    currency,
    value: exactAmountToNumber(value.exact),
    exact: value.exact,
    traces: value.traces,
  }));
}

function addSigned(
  target: Map<string, AggregatedAmount>,
  source: Map<string, AggregatedAmount>,
  sign: 1 | -1,
): void {
  for (const [currency, value] of source) {
    const signed = sign === 1
      ? value.exact
      : { coefficient: (-BigInt(value.exact.coefficient)).toString(), scale: value.exact.scale };
    accumulateAmount(target, currency, signed, value.traces);
  }
}

function overviewSummary(accounts: readonly AccountRowDto[]): SummaryMetricDto[] {
  const assets = accounts.filter((account) => account.group === "asset" || account.group === "investment");
  const liabilities = accounts.filter((account) => account.group === "liability");
  const assetTotals = aggregateAmounts(accounts.filter((account) => account.group === "asset"));
  const investmentTotals = aggregateAmounts(accounts.filter((account) => account.group === "investment"));
  const liabilityTotals = aggregateAmounts(liabilities);
  const net = new Map<string, AggregatedAmount>();
  addSigned(net, assetTotals, 1);
  addSigned(net, investmentTotals, 1);
  addSigned(net, liabilityTotals, -1);
  const display = (account: AccountRowDto) => account.kind === "credit-card" ? "Credit card" : account.kind === "loan" ? "Loan" : account.kind === "other" ? "Other" : account.kind[0]!.toUpperCase() + account.kind.slice(1);
  const assetValue = new Map<string, AggregatedAmount>();
  addSigned(assetValue, assetTotals, 1);
  addSigned(assetValue, investmentTotals, 1);
  const preview = previewSummaryMarkers(accounts);
  return [
    { label: "Net position", amounts: amountLines(net), breakdown: [`${assets.length} asset accounts`, `${liabilities.length} debt accounts`], ...preview.net },
    { label: "Asset value", amounts: amountLines(assetValue), breakdown: assets.map(display), ...preview.assets },
    { label: "Liabilities", amounts: amountLines(liabilityTotals), breakdown: liabilities.map(display), ...preview.liabilities },
  ];
}

function mapOverview(
  result: CanonicalOverviewCurrentQueryResult,
  rates: readonly ExchangeRateRecord[],
  history: PGliteDailyHistory,
  prices: readonly PGliteHoldingPrice[],
  previewAccounts: readonly AccountRowDto[],
): OverviewPageDto {
  const projection = result.projection;
  const canonicalAccounts: AccountRowDto[] = projection.accounts.map((account) => ({
    id: account.id,
    canonicalAccountId: account.id,
    label: account.label,
    institution: account.institution,
    institutionKey: account.institutionKey,
    ...(account.viaSource ? { viaSource: account.viaSource } : {}),
    product: account.product,
    group: account.group,
    kind: account.kind,
    typeLabel: account.typeLabel,
    amountLines: account.amounts.map(exactAmountToDto),
    marginAmountLines: account.marginAmounts.map(exactAmountToDto),
    transactionCount: account.transactionCount,
    assetPositionCount: account.positions.length,
    lastUpdated: account.observedAt ? account.observedAt.slice(0, 10) : null,
    valueAvailability: account.availability,
    ...(account.creditCard ? { creditCard: mapCanonicalCreditCard(account.creditCard) } : {}),
  }));
  const accounts = [...canonicalAccounts, ...previewAccounts];
  return {
    availability: projection.availability,
    coverage: projection.availability === "unavailable" ? "unavailable" : projection.sourceGaps.length > 0 || projection.availability !== "available" ? "partial" : "complete",
    historyAvailability: history.dailyHistory.length > 0 ? "available" : "unavailable",
    sourceGaps: projection.sourceGaps.map((gap) => ({ ...gap })),
    importedAt: projection.importedAt,
    summary: overviewSummary(accounts),
    dailyHistory: history.dailyHistory.map((row) => ({ ...row })),
    dailyHistoryByAccount: history.dailyHistoryByAccount,
    accounts,
    holdingPrices: holdingPricesForPositions(projection.positions, prices),
    exchangeRates: rates.map(({ rateDate, currency, twdPerUnit }) => ({ rateDate, currency, twdPerUnit })),
  };
}

function holdingPricesForPositions(
  positions: CanonicalOverviewCurrentQueryResult["projection"]["positions"],
  prices: readonly PGliteHoldingPrice[],
): OverviewHoldingPriceDto[] {
  const byPosition = new Map<string, PGliteHoldingPrice[]>();
  for (const price of prices) {
    const key = `${price.accountId}:${price.securityId}`;
    byPosition.set(key, [...(byPosition.get(key) ?? []), price]);
  }
  return positions.map((position) => {
    const observations = byPosition.get(position.id) ?? [];
    return {
      accountId: position.accountId,
      symbol: position.symbol,
      name: position.name,
      kind: position.kind,
      cash: observations.some((observation) => observation.securityType === "cash"),
      currency: observations.at(-1)?.currency ?? position.currency,
      observations: observations.map(({ date, price }) => ({ date, price })),
    };
  });
}

type PGliteReader = Pick<PGliteStore, "query"> | Pick<PGliteTransaction, "query">;

async function readExchangeRatesOnReader(
  reader: PGliteReader,
  currencies?: readonly string[],
): Promise<ExchangeRateRecord[]> {
  if (currencies?.length === 0) return [];
  const params: readonly unknown[] = currencies ?? [];
  const where = currencies === undefined
    ? ""
    : `WHERE currency IN (${currencies.map((_, index) => `$${index + 1}`).join(", ")})`;
  const result = await reader.query<ExchangeRateRecord>(
    `SELECT rate_date AS "rateDate", currency,
            twd_per_unit AS "twdPerUnit", source,
            fetched_at AS "fetchedAt"
       FROM exchange_rates
       ${where}
      ORDER BY currency, rate_date`,
    params,
  );
  return result.rows.map((row) => ({ ...row }));
}

function readHeldCurrencyRates(
  reader: PGliteReader,
  result: CanonicalOverviewCurrentQueryResult,
  history: PGliteDailyHistory,
  preview: PreviewOverview,
): Promise<ExchangeRateRecord[]> {
  const currencies = [...new Set([
    ...result.projection.positions.map((position) => position.currency),
    ...result.projection.accounts.flatMap((account) => account.amounts.map((amount) => amount.currency)),
    ...history.dailyHistory.flatMap((row) => [
      ...row.netAssets,
      ...row.assets,
      ...row.liabilities,
    ].map((amount) => amount.currency)),
    ...preview.accounts.flatMap((account) => account.amountLines.map((amount) => amount.currency)),
    ...preview.series.flatMap((series) => series.points.map((point) => point.currency)),
  ].filter((currency) => currency !== "TWD" && currency !== "UNKNOWN"))];
  return currencies.length === 0 ? Promise.resolve([]) : readExchangeRatesOnReader(reader, currencies);
}

type PreviewOverview = Readonly<{ accounts: readonly AccountRowDto[]; series: readonly PreviewBalanceSeries[] }>;

const NO_PREVIEW: PreviewOverview = { accounts: [], series: [] };

async function readPreviewOverview(reader: PGliteReader, visibility: PreviewVisibility): Promise<PreviewOverview> {
  const views = await readPreviewAccounts(reader, visibility);
  const creditViews = await readPreviewCreditAccounts(reader, visibility);
  if (views.length === 0 && creditViews.length === 0) return NO_PREVIEW;
  const accounts: AccountRowDto[] = [];
  for (const view of views)
    accounts.push(previewAccountRow(view, await readPreviewTransactions(reader, visibility, view.previewAccountId)));
  for (const view of creditViews)
    accounts.push(previewCreditAccountRow(
      view,
      await readPreviewPurchases(reader, visibility, view.previewAccountId),
      await readPreviewStatements(reader, visibility, view.previewAccountId),
    ));
  return {
    accounts,
    series: [
      ...previewBalanceSeries(await readPreviewBalanceHistory(reader, visibility)),
      ...previewCreditSeries(await readPreviewCreditBalanceHistory(reader, visibility)),
    ],
  };
}

async function readHistoryWithPreview(
  reader: PGliteReader,
  result: CanonicalOverviewCurrentQueryResult,
  visibility: PreviewVisibility,
) {
  const canonical = await readPGliteDailyHistoryWithAccounts(
    reader,
    result.projection.knowledgePoint,
    result.projection.accounts,
  );
  const preview = await readPreviewOverview(reader, visibility);
  const rates = await readHeldCurrencyRates(reader, result, canonical, preview);
  const history = withPreviewHistory(canonical, preview.series, countableWithRates(rates));
  return { canonical, history, preview, rates };
}

export function createPGliteFinancialRegistry(
  store: PGliteStore,
  exchangeRates: ExchangeRatePersistencePort,
  previewVisibility: () => PreviewVisibility = () => NO_PREVIEW_VISIBILITY,
): PGliteFinancialRegistryWithPageActionEvents {
  const spending = createPGliteSpendingQuery(store);
  const commands = createPGliteSpendingCommands(store);
  const source = createPGliteCanonicalSourceStore(store);
  let spendingPageActionCount = 0;
  let latestSettledPageAction: SpendingPageActionResult | null = null;
  const pageActionListeners = new Set<(result: SpendingPageActionResult | null) => void>();
  const previewVisibilityListeners = new Set<() => void>();
  const versioned = async <T>(read: () => Promise<T>): Promise<SpendingPageReadResult<T>> => {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof SpendingPageVersionError)) throw error;
      return { stale: true, knowledgeAt: error.knowledgeAt };
    }
  };
  return Object.freeze({
    async "financial.overview.current"([expectedSources = []]) {
      // Keep the canonical projection, history, prices, and rate rows in one
      // repeatable read transaction so a worker commit between queries cannot
      // mix snapshots.
      return store.transaction(async (transaction) => {
        const result = await createPGliteCanonicalOverviewQuery(
          transaction,
          { expectedSources },
        ).current();
        const { history, preview, rates } = await readHistoryWithPreview(transaction, result, previewVisibility());
        const prices = await readPGliteHoldingPrices(transaction, result.projection.knowledgePoint);
        return mapOverview(result, rates, history, prices, preview.accounts);
      });
    },
    async "financial.assets.current"([expectedSources = []]) {
      return store.transaction(async (transaction) => {
        const result = await createPGliteCanonicalOverviewQuery(
          transaction,
          { expectedSources },
        ).current();
        const { canonical, history, preview, rates } = await readHistoryWithPreview(transaction, result, previewVisibility());
        const product = mapCanonicalProduct(selectPGliteOverviewAssets(result.projection), "assets", canonical);
        const previewAssets = preview.accounts.filter((account) => account.group !== "liability");
        return {
          ...product,
          accounts: [...product.accounts, ...previewAssets],
          dailyHistory: history.dailyHistory.map((row) => ({ ...row })),
          dailyHistoryByAccount: {
            ...product.dailyHistoryByAccount,
            ...Object.fromEntries(previewAssets.map((account) => [account.id, history.dailyHistoryByAccount[account.id] ?? []])),
          },
          exchangeRates: rates.map(({ rateDate, currency, twdPerUnit }) => ({ rateDate, currency, twdPerUnit })),
        };
      });
    },
    async "financial.liabilities.current"([expectedSources = []]) {
      return store.transaction(async (transaction) => {
        const result = await createPGliteCanonicalOverviewQuery(
          transaction,
          { expectedSources },
        ).current();
        const { canonical, history, preview, rates } = await readHistoryWithPreview(transaction, result, previewVisibility());
        const product = mapCanonicalProduct(selectPGliteOverviewLiabilities(result.projection), "liabilities", canonical);
        const previewLiabilities = preview.accounts.filter((account) => account.group === "liability");
        return {
          ...product,
          accounts: [...product.accounts, ...previewLiabilities],
          dailyHistory: history.dailyHistory.map((row) => ({ ...row })),
          dailyHistoryByAccount: {
            ...product.dailyHistoryByAccount,
            ...Object.fromEntries(previewLiabilities.map((account) => [account.id, history.dailyHistoryByAccount[account.id] ?? []])),
          },
          exchangeRates: rates.map(({ rateDate, currency, twdPerUnit }) => ({ rateDate, currency, twdPerUnit })),
        };
      });
    },
    "financial.spending.current": ([input = {}]) => spending.summaryPage(input),
    "financial.spending.recordPage": ([request]) => versioned(() => spending.recordPage(request)),
    "financial.spending.candidatePage": ([request]) => versioned(() => spending.candidatePage(request)),
    "financial.spending.pendingOverview": ([request]) => versioned(() => spending.pendingOverview(request)),
    "financial.spending.mergeLog": ([request]) => versioned(() => spending.mergeLog(request)),
    "financial.spending.monthInsight": ([request]) => versioned(() => spending.monthInsight(request)),
    "financial.spending.merchantStats": ([request]) => versioned(() => spending.merchantStats(request)),
    async "financial.spending.version"() {
      const result = await store.query<{ value: number | string }>(
        "SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits",
      );
      return Number(result.rows[0]?.value ?? 0);
    },
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
    "financial.spending.confirmCandidate"([input]) {
      return commands.confirmCandidate(input);
    },
    "financial.spending.denyCandidate"([input]) {
      return commands.denyCandidate(input);
    },
    "financial.spending.revokeLink"([input]) {
      return commands.revokeLink(input);
    },
    "financial.spending.setPurchaseCategory"([input]) {
      return commands.setPurchaseCategory(input);
    },
    "financial.spending.confirmStrongCandidates"([input]) {
      return commands.confirmStrongCandidates(input);
    },
    "financial.source.admit": ([request], options) => source.admit(request, options),
    "financial.source.commit": ([request], options) => source.commit(request, options),
    "financial.source.commitBatch": ([request], options) => source.commitBatch(request, options),
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
    "financial.exchangeRates.read": ([currencies]) => exchangeRates.readExchangeRates(currencies),
    "financial.exchangeRates.upsert": ([rows]) => exchangeRates.upsertExchangeRates(rows),
    "financial.tdccFundAccounts.list": ([connection]) => listPGliteTdccFundAccounts(store, connection),
    "financial.accountIdentity.continuity": ([request]) => resolvePGliteAccountIdentityContinuity(store, request),
  });
}

export type PGliteCanonicalCommitAssertion = (context: WorkflowFailureCorrelation) => void;

/**
 * Pairing, its page actions, and the purchase list they change answer a click;
 * the other page refreshes do not. They run before queued reads, still one
 * operation at a time.
 */
const INTERACTIVE_OPERATIONS: ReadonlySet<PGliteFinancialOperation> = new Set([
  "financial.spending.version",
  "financial.spending.prewarmPairing",
  "financial.spending.pairing",
  "financial.spending.confirmCandidate",
  "financial.spending.denyCandidate",
  "financial.spending.revokeLink",
  "financial.spending.pageAction",
  "financial.spending.recordPage",
]);

/**
 * Page reads whose caller only keeps the answer to its newest request. While
 * one is still queued, a newer request of the same operation replaces its
 * arguments, so stepping through months reads only the month reached; the
 * earlier callers receive that answer and discard it as superseded.
 */
const LATEST_WINS_OPERATIONS: ReadonlySet<PGliteFinancialOperation> = new Set([
  "financial.spending.monthInsight",
  "financial.spending.pendingOverview",
  "financial.spending.merchantStats",
]);

/**
 * Runs one PGlite operation at a time for a worker. Interactive work (a click
 * waiting on Pairing or its page action) starts before queued background work
 * such as page refreshes and live-view recomputes; a running operation is
 * never interrupted.
 */
export type PGliteWorkScheduler = Readonly<{
  schedule<T>(lane: "interactive" | "background", task: () => Promise<T>): Promise<T>;
}>;

export function createPGliteWorkScheduler(): PGliteWorkScheduler {
  const queued = { interactive: [] as Array<() => Promise<void>>, background: [] as Array<() => Promise<void>> };
  let running = false;
  let pumpScheduled = false;
  // A query blocks this thread, so requests that arrived meanwhile are still
  // undelivered messages. Choose the next job only after one event-loop turn,
  // and keep a single pending turn: several would run their jobs back to back
  // in one phase without ever delivering those messages.
  const schedulePump = () => {
    if (pumpScheduled) return;
    pumpScheduled = true;
    setImmediate(() => {
      pumpScheduled = false;
      if (running) return;
      const job = queued.interactive.shift() ?? queued.background.shift();
      if (!job) return;
      running = true;
      void job().finally(() => {
        running = false;
        schedulePump();
      });
    });
  };
  const schedule = <T>(lane: keyof typeof queued, task: () => Promise<T>) => new Promise<T>((resolve, reject) => {
    queued[lane].push(() => Promise.resolve().then(task).then(resolve, reject));
    schedulePump();
  });
  return Object.freeze({ schedule });
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

/** Install the named financial registry on the same worker MessagePort. */
export function createPGliteFinancialRpcServer(
  port: RpcPort,
  financial: PGliteFinancialPort,
  assertCommitAdmissible?: PGliteCanonicalCommitAssertion,
  scheduler: PGliteWorkScheduler = createPGliteWorkScheduler(),
): PGliteFinancialRpcServer {
  let closed = false;
  const active = new Set<Promise<void>>();
  const controllers = new Map<number, AbortController>();
  const queuedReads = new Map<string, { args: readonly unknown[]; outcome: Promise<unknown> }>();
  const onMessage = (value: unknown): void => {
    if (validCancelRequest(value)) {
      controllers.get(value.id)?.abort();
      return;
    }
    if (!validRequest(value)) return;
    if (closed) {
      post(port, genericFailure(value.id, "worker-closed"));
      return;
    }
    if (controllers.has(value.id)) {
      // Request identifiers are the response correlation key.  Reusing one
      // while it is active would otherwise overwrite its AbortController and
      // make one of the two writes impossible to cancel deterministically.
      post(port, genericFailure(value.id, "invalid-request"));
      return;
    }
    const contract = isPGliteFinancialOperation(value.operation)
      ? PGLITE_FINANCIAL_CONTRACTS[value.operation]
      : undefined;
    if (!contract?.accepts(value.args)) {
      post(port, genericFailure(value.id, "invalid-request"));
      return;
    }
    const operation = value.operation as PGliteFinancialOperation;
    const controller = new AbortController();
    controllers.set(value.id, controller);
    const latestWins = LATEST_WINS_OPERATIONS.has(operation);
    const queuedRead = latestWins ? queuedReads.get(operation) : undefined;
    let outcome: Promise<unknown>;
    if (queuedRead) {
      queuedRead.args = value.args;
      outcome = queuedRead.outcome;
    } else {
      const read = { args: value.args, outcome: Promise.resolve() as Promise<unknown> };
      outcome = scheduler.schedule(INTERACTIVE_OPERATIONS.has(operation) ? "interactive" : "background", async () => {
        if (latestWins && queuedReads.get(operation) === read) queuedReads.delete(operation);
        if (controller.signal.aborted) throw new Error("PGlite financial operation was cancelled before execution.");
        if (assertCommitAdmissible && value.diagnosticContext && contract.canonicalCommit) {
          assertCommitAdmissible(value.diagnosticContext);
        }
        return financial.request(operation, read.args as never, { signal: controller.signal });
      });
      read.outcome = outcome;
      if (latestWins) queuedReads.set(operation, read);
    }
    const work = outcome.then(
      (result) => {
        post(port, { kind: "pglite-financial-response", version: 1, id: value.id, ok: true, value: result });
      },
      async (error) => {
        // The inner database worker has no workflow correlation. Capture before
        // wrapping there and let the correlated outer server write the record.
        const diagnosticError = !controller.signal.aborted
          && process.env[WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV]?.trim()
          ? captureSafeWorkflowFailureError(error, workflowFailureDiagnosticRepoRoot())
          : undefined;
        if (!controller.signal.aborted && value.diagnosticContext) {
          await appendWorkflowFailureDiagnostic(process.env[WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV], {
            workflowId: value.diagnosticContext.workflowId,
            taskRunId: value.diagnosticContext.taskRunId,
            source: "financial-rpc",
            errorCode: "workflow-failed",
            stage: operation === "financial.source.admit" ? "validation" : "commit",
            operation,
            safeError: diagnosticError,
            error,
          }, { repoRoot: workflowFailureDiagnosticRepoRoot() });
        }
        post(
          port,
          genericFailure(
            value.id,
            controller.signal.aborted ? "cancelled" : "operation-failed",
            controller.signal.aborted ? undefined : failureCategory(error),
            diagnosticError,
          ),
        );
      },
    ).then(() => undefined);
    active.add(work);
    void work.finally(() => {
      active.delete(work);
      controllers.delete(value.id);
    }).catch(() => undefined);
  };
  port.on("message", onMessage);
  let closePromise: Promise<void> | undefined;
  return {
    close() {
      if (closePromise) return closePromise;
      closed = true;
      port.off("message", onMessage);
      for (const controller of controllers.values()) controller.abort();
      closePromise = Promise.all([...active]).then(() => undefined);
      return closePromise;
    },
  };
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
        const showsPreview = view === "financial.overview.current" || view === "financial.assets.current";
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
