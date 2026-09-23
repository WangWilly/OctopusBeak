import type { PGliteWithLive } from "@electric-sql/pglite/live";
import type { AssetsPageDto } from "../src/lib/assets/types.ts";
import type { LiabilitiesPageDto } from "../src/lib/liabilities/types.ts";
import type { OverviewPageDto } from "../src/lib/overview/types.ts";
import { buildCanonicalOverviewSankeyGraph } from "../src/lib/overview/server/overview-sankey.ts";
import type { SpendingPageDto } from "../src/lib/spending/model.ts";
import type { SpendingLoadInput } from "../src/lib/spending/server/store.ts";
import type {
  SpendingCandidateActionInput,
  SpendingConfirmActionInput,
  SpendingPairingCandidatesInput,
  SpendingPairingCandidatesResult,
  SpendingLinkActionInput,
  SpendingPurchaseActionResult,
} from "../src/lib/spending/model.ts";
import { mapCanonicalCreditCard, mapCanonicalProduct } from "../src/lib/shared-ledger/server/canonical-product.ts";
import type { AccountRowDto, CurrencyAmountDto, SummaryMetricDto } from "../src/lib/shared-ledger/types.ts";
import type {
  CanonicalOverviewAmount,
  CanonicalOverviewExpectedSource,
  CanonicalOverviewProjection,
} from "../src/ledger/canonical/canonical-overview-query.ts";
import {
  exactAmountToNumber,
  type CanonicalOverviewCurrentQueryResult,
} from "../src/ledger/canonical/canonical-overview-query.ts";
import {
  createPGliteCanonicalOverviewQuery,
  selectPGliteOverviewAssets,
  selectPGliteOverviewLiabilities,
} from "../src/ledger/pglite/overview.ts";
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

/** Stable named query/command registry identifiers. */
export const PGLITE_FINANCIAL_OPERATIONS = [
  "financial.overview.current",
  "financial.assets.current",
  "financial.liabilities.current",
  "financial.spending.current",
  "financial.spending.pairing",
  "financial.spending.confirmCandidate",
  "financial.spending.denyCandidate",
  "financial.spending.revokeLink",
  "financial.source.admit",
  "financial.source.commit",
  "financial.source.commitBatch",
  "financial.deposit.commit",
  "financial.mixed.commit",
  "financial.balance.capture",
  "financial.einvoice.commit",
  "financial.creditCard.commit",
  "financial.creditCard.balance",
  "financial.loan.commit",
  "financial.investment.commit",
  "financial.loanRelations.resolve",
  "financial.investmentRelations.resolve",
  "financial.loanRelations.current",
  "financial.loanSettlementGroups.current",
  "financial.investmentRelations.current",
  "financial.exchangeRates.read",
  "financial.exchangeRates.upsert",
] as const;

export type PGliteFinancialOperation = typeof PGLITE_FINANCIAL_OPERATIONS[number];

export type PGliteFinancialExpectedSources = readonly CanonicalOverviewExpectedSource[];

export type PGliteFinancialRequest = Readonly<{
  kind: "pglite-financial-request";
  version: 1;
  id: number;
  operation: PGliteFinancialOperation | string;
  args: readonly unknown[];
}>;

export type PGliteFinancialCancelRequest = Readonly<{
  kind: "pglite-financial-cancel";
  version: 1;
  id: number;
}>;

export type PGliteFinancialResponse =
  | Readonly<{
    kind: "pglite-financial-response";
    version: 1;
    id: number;
    ok: true;
    value: unknown;
  }>
  | Readonly<{
    kind: "pglite-financial-response";
    version: 1;
    id: number;
    ok: false;
    code: "invalid-request" | "operation-failed" | "worker-closed" | "cancelled";
    /** Safe domain classification; raw worker/database errors never cross IPC. */
    category?: PGliteFinancialFailureCategory;
    message: string;
  }>;

type RpcPort = {
  on(event: "message", listener: (value: unknown) => void): unknown;
  off(event: "message", listener: (value: unknown) => void): unknown;
  postMessage(value: unknown): void;
};

export type PGliteFinancialRequestOptions = Readonly<{
  signal?: AbortSignal;
}>;

/** Allowlisted categories used by workflow item/fatal handling and UI errors. */
export type PGliteFinancialFailureCategory =
  | "admission"
  | "stale"
  | "ineligible"
  | "conflict"
  | "fatal";

export type PGliteFinancialRegistry = Readonly<{
  overviewCurrent(expectedSources?: PGliteFinancialExpectedSources): Promise<OverviewPageDto>;
  assetsCurrent(expectedSources?: PGliteFinancialExpectedSources): Promise<AssetsPageDto>;
  liabilitiesCurrent(expectedSources?: PGliteFinancialExpectedSources): Promise<LiabilitiesPageDto>;
  spendingCurrent(input?: SpendingLoadInput): Promise<SpendingPageDto>;
  spendingPairing(input: SpendingPairingCandidatesInput): Promise<SpendingPairingCandidatesResult>;
  confirmCandidate(input: SpendingConfirmActionInput): Promise<SpendingPurchaseActionResult>;
  denyCandidate(input: SpendingCandidateActionInput): Promise<SpendingPurchaseActionResult>;
  revokeLink(input: SpendingLinkActionInput): Promise<SpendingPurchaseActionResult>;
  sourceAdmit(request: PGliteCanonicalSourceAdmissionRequest, options?: PGliteCanonicalCommitOptions): Promise<PGliteCanonicalSourceAdmissionReceipt>;
  sourceCommit(request: PGliteCanonicalFinancialCommitRequest, options?: PGliteCanonicalCommitOptions): Promise<PGliteCanonicalFinancialCommitResult>;
  sourceCommitBatch(request: PGliteCanonicalFinancialCommitBatchRequest, options?: PGliteCanonicalCommitOptions): Promise<readonly PGliteCanonicalFinancialCommitResult[]>;
  depositCommit(request: PGliteCanonicalDepositCommitRequest, options?: PGliteCanonicalCommitOptions): Promise<PGliteCanonicalDepositCommitResult>;
  mixedCommit(request: PGliteCanonicalMixedCommitRequest, options?: PGliteCanonicalCommitOptions): Promise<PGliteCanonicalMixedCommitResult>;
  balanceCapture(request: PGliteCanonicalBalanceCaptureRequest, options?: PGliteCanonicalCommitOptions): Promise<PGliteCanonicalBalanceCommitResult>;
  einvoiceCommit(request: Parameters<typeof executePGliteCanonicalEInvoiceCommit>[1], options?: PGliteCanonicalCommitOptions): Promise<PGliteCanonicalEInvoiceCommitResult>;
  creditCardCommit(request: PGliteCanonicalCreditCardCaptureRequest, options?: PGliteCanonicalCommitOptions): Promise<PGliteCanonicalCreditCardCommitResult>;
  creditCardBalance(request: PGliteCanonicalCreditCardBalanceCaptureRequest, options?: PGliteCanonicalCommitOptions): Promise<PGliteCanonicalCreditCardCommitResult>;
  loanCommit(request: PGliteCanonicalLoanCommitRequest, options?: PGliteCanonicalCommitOptions): Promise<PGliteCanonicalLoanCommitResult>;
  investmentCommit(request: PGliteCanonicalInvestmentCommitRequest, options?: PGliteCanonicalCommitOptions): Promise<PGliteCanonicalInvestmentCommitResult>;
  resolveLoanRelations(request: PGliteCanonicalLoanRelationResolutionRequest, options?: PGliteCanonicalCommitOptions): Promise<PGliteCanonicalLoanRelationResolutionResult>;
  resolveInvestmentRelations(request: PGliteCanonicalInvestmentRelationResolutionRequest, options?: PGliteCanonicalCommitOptions): Promise<PGliteCanonicalInvestmentRelationResolutionResult>;
  currentLoanRelations(options?: { sourceConnectionKey?: string; integrationNamespace?: string }): Promise<readonly Readonly<Record<string, unknown>>[]>;
  currentLoanSettlementGroups(options?: { sourceConnectionKey?: string; integrationNamespace?: string }): Promise<readonly Readonly<Record<string, unknown>>[]>;
  currentInvestmentRelations(sourceConnectionKey?: string): Promise<readonly Readonly<Record<string, unknown>>[]>;
  readExchangeRates(currencies?: string[]): Promise<ExchangeRateRecord[]>;
  upsertExchangeRates(rows: readonly ExchangeRateRecord[]): Promise<void>;
}>;

export type PGliteFinancialRpcServer = Readonly<{ close(): Promise<void> }>;

export type PGliteFinancialRpcClient = Readonly<{
  request<K extends PGliteFinancialOperation>(operation: K, args: readonly unknown[], options?: PGliteFinancialRequestOptions): Promise<unknown>;
  registry: PGliteFinancialRegistry;
  close(error?: Error): void;
}>;

export type PGliteFinancialPageClient = Readonly<{
  load(page: "overview", options?: { expectedVersion?: number }): Promise<OverviewPageDto>;
  load(page: "assets", options?: { expectedVersion?: number }): Promise<AssetsPageDto>;
  load(page: "liabilities", options?: { expectedVersion?: number }): Promise<LiabilitiesPageDto>;
  load(page: "spending", input?: SpendingLoadInput, options?: { expectedVersion?: number }): Promise<SpendingPageDto>;
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

function aggregateAmounts(accounts: readonly AccountRowDto[]): Map<string, AggregatedAmount> {
  const result = new Map<string, AggregatedAmount>();
  for (const account of accounts) {
    for (const amount of account.amountLines) {
      if (!amount.exact) continue;
      const current = result.get(amount.currency);
      if (!current) result.set(amount.currency, { exact: { ...amount.exact }, traces: [...(amount.traces ?? [])] });
      else {
        const scale = Math.max(current.exact.scale, amount.exact.scale);
        current.exact = {
          coefficient: (BigInt(current.exact.coefficient) * 10n ** BigInt(scale - current.exact.scale) + BigInt(amount.exact.coefficient) * 10n ** BigInt(scale - amount.exact.scale)).toString(),
          scale,
        };
        current.traces.push(...(amount.traces ?? []));
      }
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
    const current = target.get(currency);
    if (!current) target.set(currency, { exact: signed, traces: [...value.traces] });
    else {
      const scale = Math.max(current.exact.scale, signed.scale);
      current.exact = {
        coefficient: (BigInt(current.exact.coefficient) * 10n ** BigInt(scale - current.exact.scale) + BigInt(signed.coefficient) * 10n ** BigInt(scale - signed.scale)).toString(),
        scale,
      };
      current.traces.push(...value.traces);
    }
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
    historyAvailability: "unavailable",
    sourceGaps: projection.sourceGaps.map((gap) => ({ ...gap })),
    importedAt: projection.importedAt,
    summary: overviewSummary(accounts),
    dailyHistory: [],
    accounts,
    sankey: buildCanonicalOverviewSankeyGraph(projection.positions, rateMap),
    sankeyExchangeRates: rates.filter((rate) => currencies.includes(rate.currency)).map(({ rateDate, currency, twdPerUnit }) => ({ rateDate, currency, twdPerUnit })),
    sankeyLatestExchangeRateDate: latestRateDate(rates.filter((rate) => currencies.includes(rate.currency))),
    exchangeRates: [],
    latestExchangeRateDate: null,
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
): PGliteFinancialRegistry {
  const spending = createPGliteSpendingQuery(store);
  const commands = createPGliteSpendingCommands(store);
  const source = createPGliteCanonicalSourceStore(store);
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
        const currencies = [...new Set(result.projection.positions.map((position) => position.currency).filter((currency) => currency !== "TWD"))];
        const rates = currencies.length === 0 ? [] : await readExchangeRatesOnReader(transaction, currencies);
        return mapOverview(result, rates);
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
    spendingCurrent(input = {}) {
      return spending.page(input);
    },
    spendingPairing(input) {
      return spending.pairingCandidates(input);
    },
    confirmCandidate(input) {
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
    const work = sequence.then(() => invoke(registry, operation, value.args, controller.signal)).then(
      (result) => post(port, { kind: "pglite-financial-response", version: 1, id: value.id, ok: true, value: result }),
      (error) => post(
        port,
        genericFailure(
          value.id,
          controller.signal.aborted ? "cancelled" : "operation-failed",
          controller.signal.aborted ? undefined : failureCategory(error),
        ),
      ),
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

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
};

export class PGliteFinancialError extends Error {
  readonly code: "invalid-request" | "operation-failed" | "worker-closed" | "cancelled";
  readonly category?: PGliteFinancialFailureCategory;
  constructor(
    code: "invalid-request" | "operation-failed" | "worker-closed" | "cancelled",
    category?: PGliteFinancialFailureCategory,
  ) {
    super(code === "invalid-request" ? "Invalid PGlite financial request." : code === "worker-closed" ? "PGlite financial worker is closed." : code === "cancelled" ? "PGlite financial operation was cancelled." : "PGlite financial operation failed.");
    this.name = "PGliteFinancialError";
    this.code = code;
    this.category = category;
  }
}

function isFailureCategory(value: unknown): value is PGliteFinancialFailureCategory {
  return value === "admission"
    || value === "stale"
    || value === "ineligible"
    || value === "conflict"
    || value === "fatal";
}

export function createPGliteFinancialRpcClient(port: RpcPort, ready?: Promise<void>): PGliteFinancialRpcClient {
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let closed = false;
  const onMessage = (value: unknown): void => {
    if (!plainRecord(value) || value.kind !== "pglite-financial-response" || value.version !== 1 || !Number.isSafeInteger(value.id) || typeof value.ok !== "boolean") return;
    const request = pending.get(value.id as number);
    if (!request) return;
    pending.delete(value.id as number);
    if (value.ok === true) request.resolve(value.value);
    else {
      const code = value.code === "invalid-request" || value.code === "worker-closed" || value.code === "cancelled"
        ? value.code
        : "operation-failed";
      request.reject(new PGliteFinancialError(code, isFailureCategory(value.category) ? value.category : undefined));
    }
  };
  port.on("message", onMessage);
  const request = <K extends PGliteFinancialOperation>(operation: K, args: readonly unknown[], options: PGliteFinancialRequestOptions = {}): Promise<unknown> => {
    if (closed) return Promise.reject(new PGliteFinancialError("worker-closed"));
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new PGliteFinancialError("cancelled"));
        return;
      }
      const send = () => {
        if (closed) {
          reject(new PGliteFinancialError("worker-closed"));
          return;
        }
        if (options.signal?.aborted) {
          reject(new PGliteFinancialError("cancelled"));
          return;
        }
        const id = nextId++;
        const abort = () => {
          // Keep the request pending until the worker sends its terminal
          // response.  A commit may have crossed the cancellation frame; in
          // that case the caller must receive the durable success receipt.
          // If the worker rolls back before its final cancellation check, it
          // sends the cancelled response and this same pending entry rejects.
          if (!pending.has(id)) return;
          try {
            port.postMessage({ kind: "pglite-financial-cancel", version: 1, id } satisfies PGliteFinancialCancelRequest);
          } catch {
            // A disconnected peer is indeterminate, so surface the transport
            // closure rather than claiming that the write rolled back.
            pending.delete(id);
            const entry = pendingEntry;
            entry?.cleanup();
            entry?.reject(new PGliteFinancialError("worker-closed"));
          }
        };
        const pendingEntry: Pending = {
          resolve: (value) => {
            options.signal?.removeEventListener("abort", abort);
            resolve(value);
          },
          reject: (error) => {
            options.signal?.removeEventListener("abort", abort);
            reject(error);
          },
          cleanup: () => options.signal?.removeEventListener("abort", abort),
        };
        options.signal?.addEventListener("abort", abort, { once: true });
        pending.set(id, pendingEntry);
        try {
          port.postMessage({ kind: "pglite-financial-request", version: 1, id, operation, args } satisfies PGliteFinancialRequest);
        } catch (error) {
          pending.delete(id);
          pendingEntry.cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      if (ready) void ready.then(send, (error) => reject(error instanceof Error ? error : new Error(String(error))));
      else send();
    });
  };
  const call = <K extends PGliteFinancialOperation>(operation: K, args: readonly unknown[], options?: PGliteFinancialRequestOptions) => request(operation, args, options);
  const registry: PGliteFinancialRegistry = {
    overviewCurrent: (expectedSources) => call("financial.overview.current", expectedSources === undefined ? [] : [expectedSources]) as Promise<OverviewPageDto>,
    assetsCurrent: (expectedSources) => call("financial.assets.current", expectedSources === undefined ? [] : [expectedSources]) as Promise<AssetsPageDto>,
    liabilitiesCurrent: (expectedSources) => call("financial.liabilities.current", expectedSources === undefined ? [] : [expectedSources]) as Promise<LiabilitiesPageDto>,
    spendingCurrent: (input) => call("financial.spending.current", input === undefined ? [] : [input]) as Promise<SpendingPageDto>,
    spendingPairing: (input) => call("financial.spending.pairing", [input]) as Promise<SpendingPairingCandidatesResult>,
    confirmCandidate: (input) => call("financial.spending.confirmCandidate", [input]) as Promise<SpendingPurchaseActionResult>,
    denyCandidate: (input) => call("financial.spending.denyCandidate", [input]) as Promise<SpendingPurchaseActionResult>,
    revokeLink: (input) => call("financial.spending.revokeLink", [input]) as Promise<SpendingPurchaseActionResult>,
    sourceAdmit: (input, options) => call("financial.source.admit", [input], options) as Promise<PGliteCanonicalSourceAdmissionReceipt>,
    sourceCommit: (input, options) => call("financial.source.commit", [input], options) as Promise<PGliteCanonicalFinancialCommitResult>,
    sourceCommitBatch: (input, options) => call("financial.source.commitBatch", [input], options) as Promise<readonly PGliteCanonicalFinancialCommitResult[]>,
    depositCommit: (input, options) => call("financial.deposit.commit", [input], options) as Promise<PGliteCanonicalDepositCommitResult>,
    mixedCommit: (input, options) => call("financial.mixed.commit", [input], options) as Promise<PGliteCanonicalMixedCommitResult>,
    balanceCapture: (input, options) => call("financial.balance.capture", [input], options) as Promise<PGliteCanonicalBalanceCommitResult>,
    einvoiceCommit: (input, options) => call("financial.einvoice.commit", [input], options) as Promise<PGliteCanonicalEInvoiceCommitResult>,
    creditCardCommit: (input, options) => call("financial.creditCard.commit", [input], options) as Promise<PGliteCanonicalCreditCardCommitResult>,
    creditCardBalance: (input, options) => call("financial.creditCard.balance", [input], options) as Promise<PGliteCanonicalCreditCardCommitResult>,
    loanCommit: (input, options) => call("financial.loan.commit", [input], options) as Promise<PGliteCanonicalLoanCommitResult>,
    investmentCommit: (input, options) => call("financial.investment.commit", [input], options) as Promise<PGliteCanonicalInvestmentCommitResult>,
    resolveLoanRelations: (input, options) => call("financial.loanRelations.resolve", [input], options) as Promise<PGliteCanonicalLoanRelationResolutionResult>,
    resolveInvestmentRelations: (input, options) => call("financial.investmentRelations.resolve", [input], options) as Promise<PGliteCanonicalInvestmentRelationResolutionResult>,
    currentLoanRelations: (input) => call("financial.loanRelations.current", input ? [input] : []) as Promise<readonly Readonly<Record<string, unknown>>[]>,
    currentLoanSettlementGroups: (input) => call("financial.loanSettlementGroups.current", input ? [input] : []) as Promise<readonly Readonly<Record<string, unknown>>[]>,
    currentInvestmentRelations: (input) => call("financial.investmentRelations.current", input ? [input] : []) as Promise<readonly Readonly<Record<string, unknown>>[]>,
    readExchangeRates: (currencies) => call("financial.exchangeRates.read", currencies === undefined ? [] : [currencies]) as Promise<ExchangeRateRecord[]>,
    upsertExchangeRates: (rows) => call("financial.exchangeRates.upsert", [rows]).then(() => undefined),
  };
  const close = (error = new PGliteFinancialError("worker-closed")): void => {
    if (closed) return;
    closed = true;
    port.off("message", onMessage);
    for (const item of pending.values()) {
      item.cleanup();
      item.reject(error);
    }
    pending.clear();
  };
  return { request, registry: Object.freeze(registry), close };
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
      const pageResult = await rpc.registry.spendingCurrent();
      return pageResult.canonical.knowledgePoint === input.dataVersion
        ? { status: "ready" as const, dataVersion: input.dataVersion, reused: false }
        : { status: "stale" as const, dataVersion: pageResult.canonical.knowledgePoint, requestedVersion: input.dataVersion };
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
  registry: PGliteFinancialRegistry,
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
          void recompute().catch((error) => {
            for (const listener of listeners) listener.error(error);
          });
        };
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
          stopped = true;
          entries.delete(key);
          const dependencies = await Promise.all(dependencyQueries);
          await Promise.all(dependencies.map((dependency) => dependency.unsubscribe()));
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
        await Promise.all(dependencyQueries);
        initialReady = true;
        await recompute();
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
