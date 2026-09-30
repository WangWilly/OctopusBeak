import type { PGliteWithLive } from "@electric-sql/pglite/live";
import type { AssetsPageDto } from "../src/lib/assets/types.ts";
import type { LiabilitiesPageDto } from "../src/lib/liabilities/types.ts";
import type { OverviewPageDto } from "../src/lib/overview/types.ts";
import { buildCanonicalOverviewSankeyGraph } from "../src/lib/overview/server/overview-sankey.ts";
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
} from "../src/lib/spending/model.ts";
import { mapCanonicalCreditCard, mapCanonicalProduct } from "../src/lib/shared-ledger/server/canonical-product.ts";
import type { AccountRowDto, CurrencyAmountDto, DailyHistoryRowDto, SummaryMetricDto } from "../src/lib/shared-ledger/types.ts";
import type {
  CanonicalOverviewAmount,
  CanonicalOverviewExpectedSource,
  CanonicalOverviewProjection,
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
import { readPGliteDailyHistory } from "../src/ledger/pglite/daily-history.ts";
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
  type PGliteCanonicalSourceAdmissionReceipt,
  type PGliteCanonicalFinancialCommitResult,
  type PGliteCanonicalSourceStore,
} from "../src/ledger/pglite/canonical-source-store.ts";
import {
  executePGliteCanonicalDepositCommit,
  type PGliteCanonicalDepositCommitRequest,
  type PGliteCanonicalDepositCommitResult,
} from "../src/ledger/pglite/deposit.ts";
import {
  commitPGliteCanonicalMixedCapture,
  type PGliteCanonicalMixedCommitRequest,
  type PGliteCanonicalMixedCommitResult,
} from "../src/ledger/pglite/mixed-commit.ts";
import {
  executePGliteCanonicalBalanceCapture,
  type PGliteCanonicalBalanceCaptureRequest,
  type PGliteCanonicalBalanceCommitResult,
} from "../src/ledger/pglite/balance.ts";
import {
  executePGliteCanonicalEInvoiceCommit,
  PGliteCanonicalEInvoiceAdmissionError,
  type PGliteCanonicalEInvoiceCommitResult,
} from "../src/ledger/pglite/einvoice.ts";
import {
  executePGliteCanonicalCreditCardCommand,
  PGliteCanonicalCreditCardAdmissionError,
  PGLITE_CANONICAL_CREDIT_CARD_BALANCE_COMMAND,
  PGLITE_CANONICAL_CREDIT_CARD_COMMIT_COMMAND,
  type PGliteCanonicalCreditCardBalanceCaptureRequest,
  type PGliteCanonicalCreditCardCaptureRequest,
  type PGliteCanonicalCreditCardCommitResult,
} from "../src/ledger/pglite/credit-card.ts";
import {
  executePGliteCanonicalLoanCommand,
  type PGliteCanonicalLoanCommitRequest,
  type PGliteCanonicalLoanCommitResult,
} from "../src/ledger/pglite/loan.ts";
import {
  executePGliteCanonicalInvestmentCommand,
  type PGliteCanonicalInvestmentCommitRequest,
  type PGliteCanonicalInvestmentCommitResult,
} from "../src/ledger/pglite/investment.ts";
import {
  executePGliteCanonicalLoanRelationCommand,
  executePGliteCanonicalInvestmentRelationCommand,
  queryPGliteCurrentLoanRepaymentRelations,
  queryPGliteCurrentLoanRepaymentSettlementGroups,
  queryPGliteCurrentInvestmentFundingRelations,
  type PGliteCanonicalLoanRelationResolutionRequest,
  type PGliteCanonicalLoanRelationResolutionResult,
  type PGliteCanonicalInvestmentRelationResolutionRequest,
  type PGliteCanonicalInvestmentRelationResolutionResult,
} from "../src/ledger/pglite/relations.ts";
import type { PGliteStore, PGliteTransaction } from "../src/ledger/pglite/transaction.ts";
import type { PGliteCanonicalCommitOptions } from "../src/ledger/pglite/canonical-source-store.ts";
import { PGliteCanonicalSourceAdmissionError } from "../src/ledger/pglite/source-admission-validation.ts";
import type { ExchangeRatePersistencePort, ExchangeRateRecord } from "../src/ledger/exchange-rates.ts";

type Trace = NonNullable<CurrencyAmountDto["traces"]>[number];
type AggregatedAmount = { exact: { coefficient: string; scale: number }; traces: Trace[] };

import {
  PGLITE_FINANCIAL_OPERATIONS,
  PGliteFinancialError,
  type PGliteFinancialCancelRequest,
  type PGliteFinancialExpectedSources,
  type PGliteFinancialFailureCategory,
  type PGliteFinancialOperation,
  type PGliteFinancialRequest,
  type PGliteFinancialRequestOptions,
  type PGliteFinancialResponse,
  type PGliteFinancialRegistry,
  type PGliteFinancialRpcClient,
  type PGliteFinancialRpcPort,
} from "./pglite-financial-rpc-client.ts";
export * from "./pglite-financial-rpc-client.ts";

type RpcPort = PGliteFinancialRpcPort;
type PGliteFinancialPageActionEvents = Readonly<{
  isSpendingPageActionInFlight?(): boolean;
  onSpendingPageActionSettled?(listener: (result: SpendingPageActionResult | null) => void): () => void;
}>;
type PGliteFinancialRegistryWithPageActionEvents = PGliteFinancialRegistry & Required<PGliteFinancialPageActionEvents>;

export type PGliteFinancialRpcServer = Readonly<{ close(): Promise<void> }>;

export type PGliteFinancialPageClient = Readonly<{
  load(page: "overview", options?: { expectedVersion?: number }): Promise<OverviewPageDto>;
  load(page: "assets", options?: { expectedVersion?: number }): Promise<AssetsPageDto>;
  load(page: "liabilities", options?: { expectedVersion?: number }): Promise<LiabilitiesPageDto>;
  load(page: "spending", input?: SpendingLoadInput, options?: { expectedVersion?: number }): Promise<SpendingPageDto>;
  loadSpendingRecordPage(request: SpendingRecordPageRequest): Promise<SpendingRecordPageDto>;
  loadSpendingCandidatePage(request: SpendingCandidatePageRequest, options?: { signal?: AbortSignal }): Promise<SpendingCandidatePageDto>;
  applySpendingPageAction(request: SpendingPageActionRequest): Promise<SpendingPageActionResult>;
  loadBlock(
    page: "overview" | "assets" | "liabilities" | "spending" | "automation",
    block: import("../src/lib/shared-shell/block-load-state.ts").DashboardBlockKey,
    options?: { expectedVersion?: number },
    automationCredentialState?: import("../src/lib/desktop/api.ts").AutomationCredentialStateDto,
    automationRuntimeState?: import("../src/lib/desktop/api.ts").AutomationRuntimeSnapshot,
  ): Promise<import("../src/lib/shared-shell/dashboard-blocks.ts").DashboardBlockPayload>;
  rankPairingCandidates(input: SpendingPairingCandidatesInput): Promise<SpendingPairingCandidatesResult>;
  prewarmPairingCandidates(input: { dataVersion: number }): Promise<{ status: "ready" | "stale"; dataVersion: number; reused?: boolean; requestedVersion?: number }>;
  confirmCandidate(input: SpendingConfirmActionInput): Promise<SpendingPurchaseActionResult>;
  denyCandidate(input: SpendingCandidateActionInput): Promise<SpendingPurchaseActionResult>;
  revokeLink(input: SpendingLinkActionInput): Promise<SpendingPurchaseActionResult>;
}>;

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
    && Array.isArray(value.args);
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

function nonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function stringField(value: unknown, key: string): boolean {
  const field = plainRecord(value) ? value[key] : undefined;
  return typeof field === "string" && field.length > 0;
}

function sourceEvidenceShape(value: unknown): boolean {
  return plainRecord(value)
    && [
      "captureId",
      "integrationNamespace",
      "sourceConnectionKey",
      "identityEpoch",
      "stream",
      "recordKind",
      "routeKey",
      "contractVersion",
      "subjectDigest",
      "observedAt",
    ].every((key) => stringField(value, key))
    && plainRecord(value.scope)
    && Array.isArray(value.pages)
    && Array.isArray(value.records);
}

function sourceCommitShape(value: unknown): boolean {
  return plainRecord(value)
    && sourceEvidenceShape(value.capture)
    && plainRecord(value.account)
    && Array.isArray(value.transactions);
}

function einvoiceCaptureShape(value: unknown): boolean {
  return plainRecord(value)
    && ["captureId", "sourceConnectionKey", "identityEpoch", "subjectDigest", "observedAt"]
      .every((key) => stringField(value, key))
    && plainRecord(value.scope)
    && Array.isArray(value.pages)
    && Array.isArray(value.invoices);
}

function validFinancialArgs(operation: PGliteFinancialOperation, args: readonly unknown[]): boolean {
  switch (operation) {
    case "financial.overview.current":
    case "financial.assets.current":
    case "financial.liabilities.current":
      return args.length === 0 || (args.length === 1 && Array.isArray(args[0]));
    case "financial.spending.current":
      return args.length === 0 || (args.length === 1 && plainRecord(args[0]));
    case "financial.spending.version":
      return args.length === 0;
    case "financial.spending.pairing":
      return args.length === 1 && plainRecord(args[0])
        && typeof (args[0] as Record<string, unknown>).invoiceIdentityId === "string"
        && nonNegativeSafeInteger((args[0] as Record<string, unknown>).dataVersion);
    case "financial.spending.confirmCandidate":
    case "financial.spending.denyCandidate":
    case "financial.spending.revokeLink":
      return args.length === 1 && plainRecord(args[0]);
    case "financial.source.admit":
      return args.length === 1 && sourceEvidenceShape(args[0]);
    case "financial.source.commit":
      return args.length === 1 && sourceCommitShape(args[0]);
    case "financial.source.commitBatch":
      return args.length === 1 && plainRecord(args[0])
        && Array.isArray((args[0] as Record<string, unknown>).commits)
        && ((args[0] as Record<string, unknown>).commits as unknown[]).length > 0
        && ((args[0] as Record<string, unknown>).commits as unknown[]).every(sourceCommitShape);
    case "financial.deposit.commit":
      return args.length === 1 && plainRecord(args[0])
        && plainRecord((args[0] as Record<string, unknown>).capture);
    case "financial.mixed.commit":
      return args.length === 1 && plainRecord(args[0])
        && Array.isArray((args[0] as Record<string, unknown>).steps)
        && ((args[0] as Record<string, unknown>).steps as unknown[]).length > 0
        && ((args[0] as Record<string, unknown>).steps as unknown[]).every((step) =>
          plainRecord(step)
          && (step.kind === "source" && sourceEvidenceShape(step.request)
            || step.kind === "financial" && sourceCommitShape(step.request)
            || step.kind === "deposit" && plainRecord(step.request)
              && plainRecord(step.request.capture)));
    case "financial.balance.capture":
      return args.length === 1 && plainRecord(args[0])
        && sourceEvidenceShape((args[0] as Record<string, unknown>).capture)
        && plainRecord((args[0] as Record<string, unknown>).account)
        && Array.isArray((args[0] as Record<string, unknown>).observations);
    case "financial.einvoice.commit":
      return args.length === 1 && einvoiceCaptureShape(args[0]);
    case "financial.creditCard.commit":
      return args.length === 1 && plainRecord(args[0])
        && sourceEvidenceShape((args[0] as Record<string, unknown>).capture)
        && plainRecord((args[0] as Record<string, unknown>).account)
        && plainRecord((args[0] as Record<string, unknown>).identity)
        && Array.isArray((args[0] as Record<string, unknown>).instruments)
        && Array.isArray((args[0] as Record<string, unknown>).transactions)
        && Array.isArray((args[0] as Record<string, unknown>).statements);
    case "financial.creditCard.balance":
      return args.length === 1 && plainRecord(args[0])
        && sourceEvidenceShape((args[0] as Record<string, unknown>).capture)
        && plainRecord((args[0] as Record<string, unknown>).account)
        && plainRecord((args[0] as Record<string, unknown>).identity)
        && plainRecord((args[0] as Record<string, unknown>).balance);
    case "financial.loan.commit":
    case "financial.investment.commit":
      return args.length === 1 && plainRecord(args[0])
        && plainRecord((args[0] as Record<string, unknown>).capture);
    case "financial.loanRelations.resolve":
      return args.length === 1 && plainRecord(args[0])
        && typeof (args[0] as Record<string, unknown>).sourceConnectionKey === "string";
    case "financial.investmentRelations.resolve":
    case "financial.loanRelations.current":
    case "financial.loanSettlementGroups.current":
      return args.length === 0 || (args.length === 1 && plainRecord(args[0]));
    case "financial.investmentRelations.current":
      return args.length === 0 || (args.length === 1 && typeof args[0] === "string");
    case "financial.exchangeRates.read":
      return args.length === 0 || (args.length === 1 && Array.isArray(args[0]) && (args[0] as unknown[]).every((value) => typeof value === "string"));
    case "financial.exchangeRates.upsert":
      return args.length === 1 && Array.isArray(args[0]) && (args[0] as unknown[]).every((row) => plainRecord(row));
    default:
      return false;
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
  return [
    { label: "Net position", amounts: amountLines(net), breakdown: [`${assets.length} asset accounts`, `${liabilities.length} debt accounts`] },
    { label: "Asset value", amounts: amountLines(assetValue), breakdown: assets.map(display) },
    { label: "Liabilities", amounts: amountLines(liabilityTotals), breakdown: liabilities.map(display) },
  ];
}

function mapOverview(
  result: CanonicalOverviewCurrentQueryResult,
  rates: readonly ExchangeRateRecord[],
  dailyHistory: readonly DailyHistoryRowDto[],
): OverviewPageDto {
  const projection = result.projection;
  const accounts: AccountRowDto[] = projection.accounts.map((account) => ({
    id: account.id,
    canonicalAccountId: account.id,
    label: account.label,
    institution: account.institution,
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
  const currencies = [...new Set(projection.positions.map((position) => position.currency).filter((currency) => currency !== "TWD"))];
  const rateMap = new Map(rates.map((rate) => [rate.currency, rate]));
  return {
    availability: projection.availability,
    coverage: projection.availability === "unavailable" ? "unavailable" : projection.sourceGaps.length > 0 || projection.availability !== "available" ? "partial" : "complete",
    historyAvailability: dailyHistory.length > 0 ? "available" : "unavailable",
    sourceGaps: projection.sourceGaps.map((gap) => ({ ...gap })),
    importedAt: projection.importedAt,
    summary: overviewSummary(accounts),
    dailyHistory: dailyHistory.map((row) => ({ ...row })),
    accounts,
    sankey: buildCanonicalOverviewSankeyGraph(projection.positions, rateMap),
    sankeyExchangeRates: rates.filter((rate) => currencies.includes(rate.currency)).map(({ rateDate, currency, twdPerUnit }) => ({ rateDate, currency, twdPerUnit })),
    sankeyLatestExchangeRateDate: latestRateDate(rates.filter((rate) => currencies.includes(rate.currency))),
    exchangeRates: rates.map(({ rateDate, currency, twdPerUnit }) => ({ rateDate, currency, twdPerUnit })),
    latestExchangeRateDate: latestRateDate(rates),
  };
}

function latestRateDate(rows: readonly { rateDate: string }[]): string | null {
  return rows.reduce<string | null>((latest, row) => !latest || row.rateDate > latest ? row.rateDate : latest, null);
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

export function createPGliteFinancialRegistry(
  store: PGliteStore,
  exchangeRates: ExchangeRatePersistencePort,
): PGliteFinancialRegistryWithPageActionEvents {
  const spending = createPGliteSpendingQuery(store);
  const commands = createPGliteSpendingCommands(store);
  const source = createPGliteCanonicalSourceStore(store);
  let spendingPageActionCount = 0;
  let latestSettledPageAction: SpendingPageActionResult | null = null;
  const pageActionListeners = new Set<(result: SpendingPageActionResult | null) => void>();
  return Object.freeze({
    async overviewCurrent(expectedSources = []) {
      // Keep the canonical projection and the rate rows in one repeatable
      // read transaction.  A worker commit between two independent queries
      // could otherwise produce a DTO whose knowledge point and Sankey rates
      // come from different snapshots.
      return store.transaction(async (transaction) => {
        const result = await createPGliteCanonicalOverviewQuery(
          transaction,
          { expectedSources },
        ).current();
        const dailyHistory = await readPGliteDailyHistory(
          transaction,
          result.projection.knowledgePoint,
          result.projection.accounts,
        );
        const currencies = [...new Set([
          ...result.projection.positions.map((position) => position.currency),
          ...dailyHistory.flatMap((row) => [
            ...row.netAssets,
            ...row.dailyChange,
            ...row.assets,
            ...row.liabilities,
          ].map((amount) => amount.currency)),
        ].filter((currency) => currency !== "TWD" && currency !== "UNKNOWN"))];
        const rates = currencies.length === 0 ? [] : await readExchangeRatesOnReader(transaction, currencies);
        return mapOverview(result, rates, dailyHistory);
      });
    },
    async assetsCurrent(expectedSources = []) {
      return store.transaction(async (transaction) => {
        const result = await createPGliteCanonicalOverviewQuery(
          transaction,
          { expectedSources },
        ).current();
        return mapCanonicalProduct(selectPGliteOverviewAssets(result.projection), "assets");
      });
    },
    async liabilitiesCurrent(expectedSources = []) {
      return store.transaction(async (transaction) => {
        const result = await createPGliteCanonicalOverviewQuery(
          transaction,
          { expectedSources },
        ).current();
        return mapCanonicalProduct(selectPGliteOverviewLiabilities(result.projection), "liabilities");
      });
    },
    async spendingCurrent(input = {}) {
      const tagged = input as SpendingLoadInput & Readonly<{
        __spendingRead?: "record-page" | "candidate-page";
        request?: SpendingRecordPageRequest | SpendingCandidatePageRequest;
      }>;
      if (tagged.__spendingRead === "record-page") {
        const result = await spending.recordPage(tagged.request as SpendingRecordPageRequest);
        return result as unknown as SpendingPageDto;
      }
      if (tagged.__spendingRead === "candidate-page") {
        const result = await spending.candidatePage(tagged.request as SpendingCandidatePageRequest);
        return result as unknown as SpendingPageDto;
      }
      return spending.summaryPage(input);
    },
    async spendingVersion() {
      const result = await store.query<{ value: number | string }>(
        "SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits",
      );
      return Number(result.rows[0]?.value ?? 0);
    },
    spendingPairing(input) {
      return spending.pairingCandidates(input);
    },
    isSpendingPageActionInFlight() {
      return spendingPageActionCount > 0;
    },
    onSpendingPageActionSettled(listener) {
      pageActionListeners.add(listener);
      return () => pageActionListeners.delete(listener);
    },
    confirmCandidate(input) {
      const tagged = input as SpendingConfirmActionInput & Readonly<{
        __spendingPageAction?: SpendingPageActionRequest;
      }>;
      if (tagged.__spendingPageAction) {
        if (spendingPageActionCount === 0) latestSettledPageAction = null;
        spendingPageActionCount += 1;
        return commands.pageAction(tagged.__spendingPageAction).then((result) => {
          if (!latestSettledPageAction || result.knowledgeAt >= latestSettledPageAction.knowledgeAt)
            latestSettledPageAction = result;
          return result as unknown as SpendingPurchaseActionResult;
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
      }
      return commands.confirmCandidate(input);
    },
    denyCandidate(input) {
      return commands.denyCandidate(input);
    },
    revokeLink(input) {
      return commands.revokeLink(input);
    },
    sourceAdmit: (request, options) => source.admit(request, options),
    sourceCommit: (request, options) => source.commit(request, options),
    sourceCommitBatch: (request, options) => source.commitBatch(request, options),
    depositCommit: (request, options) => executePGliteCanonicalDepositCommit(store, request, options),
    mixedCommit: (request, options) => commitPGliteCanonicalMixedCapture(store, request, options),
    balanceCapture: (request, options) => executePGliteCanonicalBalanceCapture(store, request, options),
    einvoiceCommit: (request, options) => executePGliteCanonicalEInvoiceCommit(store, request, options),
    creditCardCommit: (request, options) => executePGliteCanonicalCreditCardCommand(store, { kind: PGLITE_CANONICAL_CREDIT_CARD_COMMIT_COMMAND, request }, options),
    creditCardBalance: (request, options) => executePGliteCanonicalCreditCardCommand(store, { kind: PGLITE_CANONICAL_CREDIT_CARD_BALANCE_COMMAND, request }, options),
    loanCommit: (request, options) => executePGliteCanonicalLoanCommand(store, request, options),
    investmentCommit: (request, options) => executePGliteCanonicalInvestmentCommand(store, request, options),
    resolveLoanRelations: (request, options) => executePGliteCanonicalLoanRelationCommand(store, request, options),
    resolveInvestmentRelations: (request, options) => executePGliteCanonicalInvestmentRelationCommand(store, request, options),
    currentLoanRelations: (options) => queryPGliteCurrentLoanRepaymentRelations(store, options),
    currentLoanSettlementGroups: (options) => queryPGliteCurrentLoanRepaymentSettlementGroups(store, options),
    currentInvestmentRelations: (sourceConnectionKey) => queryPGliteCurrentInvestmentFundingRelations(store, sourceConnectionKey),
    readExchangeRates: (currencies) => exchangeRates.readExchangeRates(currencies),
    upsertExchangeRates: (rows) => exchangeRates.upsertExchangeRates(rows),
  });
}

async function invoke(
  registry: PGliteFinancialRegistry,
  operation: PGliteFinancialOperation,
  args: readonly unknown[],
  signal?: AbortSignal,
): Promise<unknown> {
  const options: PGliteCanonicalCommitOptions | undefined = signal ? { signal } : undefined;
  switch (operation) {
    case "financial.overview.current": return registry.overviewCurrent(args[0] as PGliteFinancialExpectedSources | undefined);
    case "financial.assets.current": return registry.assetsCurrent(args[0] as PGliteFinancialExpectedSources | undefined);
    case "financial.liabilities.current": return registry.liabilitiesCurrent(args[0] as PGliteFinancialExpectedSources | undefined);
    case "financial.spending.current": return registry.spendingCurrent(args[0] as SpendingLoadInput | undefined);
    case "financial.spending.version": return registry.spendingVersion();
    case "financial.spending.pairing": return registry.spendingPairing(args[0] as SpendingPairingCandidatesInput);
    case "financial.spending.confirmCandidate": return registry.confirmCandidate(args[0] as SpendingConfirmActionInput);
    case "financial.spending.denyCandidate": return registry.denyCandidate(args[0] as SpendingCandidateActionInput);
    case "financial.spending.revokeLink": return registry.revokeLink(args[0] as SpendingLinkActionInput);
    case "financial.source.admit": return registry.sourceAdmit(args[0] as PGliteCanonicalSourceAdmissionRequest, options);
    case "financial.source.commit": return registry.sourceCommit(args[0] as PGliteCanonicalFinancialCommitRequest, options);
    case "financial.source.commitBatch": return registry.sourceCommitBatch(args[0] as PGliteCanonicalFinancialCommitBatchRequest, options);
    case "financial.deposit.commit": return registry.depositCommit(args[0] as PGliteCanonicalDepositCommitRequest, options);
    case "financial.mixed.commit": return registry.mixedCommit(args[0] as PGliteCanonicalMixedCommitRequest, options);
    case "financial.balance.capture": return registry.balanceCapture(args[0] as PGliteCanonicalBalanceCaptureRequest, options);
    case "financial.einvoice.commit": return registry.einvoiceCommit(args[0] as Parameters<typeof executePGliteCanonicalEInvoiceCommit>[1], options);
    case "financial.creditCard.commit": return registry.creditCardCommit(args[0] as PGliteCanonicalCreditCardCaptureRequest, options);
    case "financial.creditCard.balance": return registry.creditCardBalance(args[0] as PGliteCanonicalCreditCardBalanceCaptureRequest, options);
    case "financial.loan.commit": return registry.loanCommit(args[0] as PGliteCanonicalLoanCommitRequest, options);
    case "financial.investment.commit": return registry.investmentCommit(args[0] as PGliteCanonicalInvestmentCommitRequest, options);
    case "financial.loanRelations.resolve": return registry.resolveLoanRelations(args[0] as PGliteCanonicalLoanRelationResolutionRequest, options);
    case "financial.investmentRelations.resolve": return registry.resolveInvestmentRelations(args[0] as PGliteCanonicalInvestmentRelationResolutionRequest ?? {}, options);
    case "financial.loanRelations.current": return registry.currentLoanRelations(args[0] as { sourceConnectionKey?: string; integrationNamespace?: string } | undefined);
    case "financial.loanSettlementGroups.current": return registry.currentLoanSettlementGroups(args[0] as { sourceConnectionKey?: string; integrationNamespace?: string } | undefined);
    case "financial.investmentRelations.current": return registry.currentInvestmentRelations(args[0] as string | undefined);
    case "financial.exchangeRates.read": return registry.readExchangeRates(args[0] as string[] | undefined);
    case "financial.exchangeRates.upsert": return registry.upsertExchangeRates(args[0] as readonly ExchangeRateRecord[]);
  }
}

/** Install the named financial registry on the same worker MessagePort. */
export function createPGliteFinancialRpcServer(
  port: RpcPort,
  registry: PGliteFinancialRegistry,
): PGliteFinancialRpcServer {
  let closed = false;
  let sequence = Promise.resolve();
  const active = new Set<Promise<void>>();
  const controllers = new Map<number, AbortController>();
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
    if (!PGLITE_FINANCIAL_OPERATIONS.includes(value.operation as PGliteFinancialOperation)
      || !validFinancialArgs(value.operation as PGliteFinancialOperation, value.args)) {
      post(port, genericFailure(value.id, "invalid-request"));
      return;
    }
    const operation = value.operation as PGliteFinancialOperation;
    const controller = new AbortController();
    controllers.set(value.id, controller);
    const work = sequence.then(() => {
      if (controller.signal.aborted) throw new Error("PGlite financial operation was cancelled before execution.");
      return invoke(registry, operation, value.args, controller.signal);
    }).then(
      (result) => {
        post(port, { kind: "pglite-financial-response", version: 1, id: value.id, ok: true, value: result });
      },
      (error) => {
        post(
          port,
          genericFailure(
            value.id,
            controller.signal.aborted ? "cancelled" : "operation-failed",
            controller.signal.aborted ? undefined : failureCategory(error),
          ),
        );
      },
    ).then(() => undefined);
    sequence = work.catch(() => undefined);
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

/** Create the page-shaped client used by Electron IPC handlers. */
export function createPGliteFinancialPageClient(
  rpc: PGliteFinancialRpcClient,
  subscribe?: (view: string, params: object, onRows: (rows: unknown[]) => void) => Promise<() => Promise<void>>,
  expectedSources: () => PGliteFinancialExpectedSources = () => [],
): PGliteFinancialPageClient & { subscribe?: typeof subscribe } {
  const page = {
    load(pageName: "overview" | "assets" | "liabilities" | "spending", inputOrOptions?: SpendingLoadInput | { expectedVersion?: number }, options?: { expectedVersion?: number }) {
      void inputOrOptions;
      void options;
      const sources = expectedSources();
      if (pageName === "overview") return rpc.registry.overviewCurrent(sources);
      if (pageName === "assets") return rpc.registry.assetsCurrent(sources);
      if (pageName === "liabilities") return rpc.registry.liabilitiesCurrent(sources);
      return rpc.registry.spendingCurrent(inputOrOptions as SpendingLoadInput | undefined);
    },
    loadSpendingRecordPage(request: SpendingRecordPageRequest) {
      return rpc.request("financial.spending.current", [{ __spendingRead: "record-page", request }]) as Promise<SpendingRecordPageDto>;
    },
    loadSpendingCandidatePage(request: SpendingCandidatePageRequest, options: { signal?: AbortSignal } = {}) {
      return rpc.request("financial.spending.current", [{ __spendingRead: "candidate-page", request }], options) as Promise<SpendingCandidatePageDto>;
    },
    applySpendingPageAction(request: SpendingPageActionRequest) {
      return rpc.request("financial.spending.confirmCandidate", [{ __spendingPageAction: request }]) as Promise<SpendingPageActionResult>;
    },
    async loadBlock(pageName: "overview" | "assets" | "liabilities" | "spending" | "automation", block: import("../src/lib/shared-shell/block-load-state.ts").DashboardBlockKey, options?: { expectedVersion?: number }, automationCredentialState?: import("../src/lib/desktop/api.ts").AutomationCredentialStateDto, automationRuntimeState?: import("../src/lib/desktop/api.ts").AutomationRuntimeSnapshot) {
      void options;
      void automationCredentialState;
      void automationRuntimeState;
      if (pageName === "automation") throw new Error("PGlite financial registry does not own automation page assembly.");
      const value = await this.load(pageName, pageName === "spending" ? undefined : undefined);
      const { projectFinancialBlock } = await import("./financial-page-block-loader.ts");
      return projectFinancialBlock(value, block as never, pageName as never) as import("../src/lib/shared-shell/dashboard-blocks.ts").DashboardBlockPayload;
    },
    rankPairingCandidates: (input: SpendingPairingCandidatesInput) => rpc.registry.spendingPairing(input),
    prewarmPairingCandidates: async (input: { dataVersion: number }) => {
      const currentVersion = await rpc.registry.spendingVersion();
      return currentVersion === input.dataVersion
        ? { status: "ready" as const, dataVersion: input.dataVersion, reused: false }
        : { status: "stale" as const, dataVersion: currentVersion, requestedVersion: input.dataVersion };
    },
    confirmCandidate: (input: SpendingConfirmActionInput) => rpc.registry.confirmCandidate(input),
    denyCandidate: (input: SpendingCandidateActionInput) => rpc.registry.denyCandidate(input),
    revokeLink: (input: SpendingLinkActionInput) => rpc.registry.revokeLink(input),
    ...(subscribe ? { subscribe } : {}),
  };
  return page as PGliteFinancialPageClient & { subscribe?: typeof subscribe };
}

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
              const value = view === "financial.overview.current"
                ? await registry.overviewCurrent(sources)
                : view === "financial.assets.current"
                  ? await registry.assetsCurrent(sources)
                  : view === "financial.liabilities.current"
                    ? await registry.liabilitiesCurrent(sources)
                  : await registry.spendingCurrent(params as SpendingLoadInput);
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
            void registry.spendingVersion().then((version) => {
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

              const currentVersion = await registry.spendingVersion();
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
        // Financial pages depend on every canonical commit because source
        // admissions, e-invoice/card commits, and projection rebuilds can
        // change the knowledge point even when a current projection marker
        // is unchanged.  The aggregate is one bounded dependency row rather
        // than a materialized history result.  Overview also consumes
        // exchange rates for Sankey conversion.  Automation progress/history
        // has its own runtime stream and must not invalidate a complete
        // financial DTO on every task update.
        const dependencyQueries = [
          db.live.query("SELECT MAX(commit_sequence) AS commit_sequence FROM canonical_commits", [], trigger),
          ...(view === "financial.overview.current"
            ? [db.live.query("SELECT rate_date, currency, twd_per_unit, source, fetched_at FROM exchange_rates", [], trigger)]
            : []),
        ];
        const stop = async () => {
          if (stopped) return;
          stopped = true;
          stopPageActionListener();
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
