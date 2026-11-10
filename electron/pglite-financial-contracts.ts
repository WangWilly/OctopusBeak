import type { AssetsPageDto } from "../src/lib/assets/types.ts";
import type { LiabilitiesPageDto } from "../src/lib/liabilities/types.ts";
import type { ManualAssetCommand, ManualAssetCommandResult } from "../src/lib/manual-assets/manual-assets.ts";
import type { OverviewPageDto } from "../src/lib/overview/types.ts";
import type {
  SpendingPairingCandidatesInput,
  SpendingPairingCandidatesResult,
  SpendingPageDto,
  SpendingPageReadResult,
  SpendingCandidatePageDto,
  SpendingCandidatePageRequest,
  SpendingMergeLogDto,
  SpendingMergeLogRequest,
  SpendingMerchantStatsDto,
  SpendingMerchantStatsRequest,
  SpendingMonthInsightDto,
  SpendingMonthInsightRequest,
  SpendingPageActionRequest,
  SpendingPageActionReply,
  SpendingPendingOverviewDto,
  SpendingPendingOverviewRequest,
  SpendingRecordPageDto,
  SpendingRecordPageRequest,
} from "../src/lib/spending/model.ts";
import type { SpendingLoadInput } from "../src/lib/spending/contracts.ts";
import type { CanonicalOverviewExpectedSource } from "../src/ledger/canonical/canonical-overview-query.ts";
import type {
  PGliteCanonicalFinancialCommitRequest,
  PGliteCanonicalFinancialCommitResult,
  PGliteCanonicalSourceAdmissionRequest,
  PGliteCanonicalSourceAdmissionReceipt,
  PGliteCanonicalCommitOptions,
} from "../src/ledger/pglite/canonical-source-store.ts";
import type {
  PGliteCanonicalDepositCommitRequest,
  PGliteCanonicalDepositCommitResult,
} from "../src/ledger/pglite/deposit.ts";
import type {
  PGliteCanonicalBalanceCaptureRequest,
  PGliteCanonicalBalanceCommitResult,
} from "../src/ledger/pglite/balance.ts";
import type {
  PGliteCanonicalEInvoiceCommitResult,
} from "../src/ledger/pglite/einvoice.ts";
import type {
  PGliteCanonicalCreditCardBalanceCaptureRequest,
  PGliteCanonicalCreditCardCaptureRequest,
  PGliteCanonicalCreditCardCommitResult,
} from "../src/ledger/pglite/credit-card.ts";
import type {
  PGliteCanonicalLoanCommitRequest,
  PGliteCanonicalLoanCommitResult,
} from "../src/ledger/pglite/loan.ts";
import type {
  PGliteCanonicalInvestmentCommitRequest,
  PGliteCanonicalInvestmentCommitResult,
} from "../src/ledger/pglite/investment.ts";
import type { TdccAdmittedFundAccount } from "../src/ledger/canonical/tdcc-investment-admission.ts";
import type { AccountIdentityContinuity, AccountIdentityContinuityRequest } from "../src/ledger/pglite/account-identity-continuity.ts";
import type { SpendingPageVersion } from "../src/ledger/pglite/spending-page.ts";
import type {
  PGliteCanonicalLoanRelationResolutionRequest,
  PGliteCanonicalLoanRelationResolutionResult,
  PGliteCanonicalInvestmentRelationResolutionRequest,
  PGliteCanonicalInvestmentRelationResolutionResult,
} from "../src/ledger/pglite/relations.ts";
import type { SafeWorkflowFailureError, WorkflowFailureCorrelation } from "../src/lib/automation/server/workflow-failure-diagnostics.ts";
import type { PGliteWorkflowAdmissionReason } from "../src/ledger/pglite/workflow-client.ts";
import type { CanonicalEInvoiceCaptureInput } from "../src/ledger/canonical/einvoice-contract.ts";
import { plainRecord } from "./pglite-worker-call.ts";

/**
 * How the worker schedules an operation: interactive work answers a click and
 * runs before queued background work; a latest-wins read runs in the
 * background, and a newer request of the same operation replaces a queued one.
 */
export type PGliteFinancialLane = "interactive" | "background" | "latest-wins";

type FinancialOperationFlags = Readonly<{
  lane: PGliteFinancialLane;
  /** Canonical writes from a workflow run must pass isCommitAdmissible first. */
  canonicalCommit?: true;
}>;

type FinancialOperationContract<Args extends readonly unknown[], Result> = FinancialOperationFlags & Readonly<{
  accepts(args: readonly unknown[]): boolean;
  /** Type-only: the argument tuple a caller sends and the result it receives. */
  contract?: (args: Args) => Result;
}>;

function operation<Args extends readonly unknown[], Result>(
  accepts: (args: readonly unknown[]) => boolean,
  flags: FinancialOperationFlags,
): FinancialOperationContract<Args, Result> {
  return Object.freeze({ accepts, ...flags });
}

/** The renderer bridge groups a financial operation may join (ADR 0098). */
export type FinancialBridgeGroup = "spending" | "manualAssets";

/**
 * Opens an operation to the renderer as `window.octopusBeak[group][method]`.
 * Preload still spells the channel itself, because its sandbox loads only electron.
 */
function rendered<const Group extends FinancialBridgeGroup, const Method extends string, Contract>(
  group: Group,
  method: Method,
  contract: Contract,
): Contract & Readonly<{ renderer: Readonly<{ group: Group; method: Method }> }> {
  return Object.freeze({ ...contract, renderer: Object.freeze({ group, method }) });
}

function nonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function stringField(value: unknown, key: string): boolean {
  const field = plainRecord(value) ? value[key] : undefined;
  return typeof field === "string" && field.length > 0;
}
function accountIdentityContinuityRequestShape(value: unknown): boolean {
  return plainRecord(value)
    && Object.keys(value).length === 5
    && stringField(value, "integrationNamespace")
    && stringField(value, "sourceConnectionKey")
    && stringField(value, "identityEpochKey")
    && stringField(value, "stream")
    && plainRecord(value.identifier)
    && Object.keys(value.identifier).length === 2
    && stringField(value.identifier, "kind")
    && stringField(value.identifier, "value");
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

/** Every named financial operation: what it accepts, what it returns, and whether it writes canonical data. */
export const PGLITE_FINANCIAL_CONTRACTS = Object.freeze({
  "financial.overview.current": operation<[expectedSources?: PGliteFinancialExpectedSources], OverviewPageDto>(
    (args) => args.length === 0 || (args.length === 1 && Array.isArray(args[0])),
    { lane: "background" },
  ),
  "financial.assets.current": operation<[expectedSources?: PGliteFinancialExpectedSources], AssetsPageDto>(
    (args) => args.length === 0 || (args.length === 1 && Array.isArray(args[0])),
    { lane: "background" },
  ),
  "financial.liabilities.current": operation<[expectedSources?: PGliteFinancialExpectedSources], LiabilitiesPageDto>(
    (args) => args.length === 0 || (args.length === 1 && Array.isArray(args[0])),
    { lane: "background" },
  ),
  "financial.spending.current": operation<[input?: SpendingLoadInput], SpendingPageDto>(
    (args) => args.length === 0 || (args.length === 1 && plainRecord(args[0])),
    { lane: "background" },
  ),
  "financial.spending.recordPage": rendered("spending", "loadRecordPage", operation<[request: SpendingRecordPageRequest], SpendingPageReadResult<SpendingRecordPageDto>>(
    (args) => args.length === 1 && plainRecord(args[0]),
    { lane: "interactive" },
  )),
  "financial.spending.candidatePage": operation<[request: SpendingCandidatePageRequest], SpendingPageReadResult<SpendingCandidatePageDto>>(
    (args) => args.length === 1 && plainRecord(args[0]),
    { lane: "background" },
  ),
  "financial.spending.pendingOverview": rendered("spending", "loadPendingOverview", operation<[request: SpendingPendingOverviewRequest], SpendingPageReadResult<SpendingPendingOverviewDto>>(
    (args) => args.length === 1 && plainRecord(args[0]),
    { lane: "latest-wins" },
  )),
  "financial.spending.mergeLog": rendered("spending", "loadMergeLog", operation<[request: SpendingMergeLogRequest], SpendingPageReadResult<SpendingMergeLogDto>>(
    (args) => args.length === 1 && plainRecord(args[0]),
    { lane: "background" },
  )),
  "financial.spending.monthInsight": rendered("spending", "loadMonthInsight", operation<[request: SpendingMonthInsightRequest], SpendingPageReadResult<SpendingMonthInsightDto>>(
    (args) => args.length === 1 && plainRecord(args[0]),
    { lane: "latest-wins" },
  )),
  "financial.spending.merchantStats": rendered("spending", "loadMerchantStats", operation<[request: SpendingMerchantStatsRequest], SpendingPageReadResult<SpendingMerchantStatsDto>>(
    (args) => args.length === 1 && plainRecord(args[0]),
    { lane: "latest-wins" },
  )),
  "financial.spending.pageAction": rendered("spending", "applyPageAction", operation<[request: SpendingPageActionRequest], SpendingPageActionReply>(
    (args) => args.length === 1 && plainRecord(args[0]),
    { lane: "interactive" },
  )),
  /** The canonical knowledge point and the Manual Asset revision, read together (ADR 0089). */
  "financial.spending.version": operation<[], SpendingPageVersion>(
    (args) => args.length === 0,
    { lane: "interactive" },
  ),
  /** Build the pairing index when the store is still at this version; returns the current version. */
  "financial.spending.prewarmPairing": operation<[dataVersion: number], number>(
    (args) => args.length === 1 && nonNegativeSafeInteger(args[0]),
    { lane: "interactive" },
  ),
  "financial.preview.visibilityChanged": operation<[], void>(
    (args) => args.length === 0,
    { lane: "background" },
  ),
  "financial.spending.pairing": rendered("spending", "rankPairingCandidates", operation<[input: SpendingPairingCandidatesInput], SpendingPairingCandidatesResult>(
    (args) => args.length === 1 && plainRecord(args[0])
      && typeof (args[0] as Record<string, unknown>).invoiceIdentityId === "string"
      && nonNegativeSafeInteger((args[0] as Record<string, unknown>).dataVersion),
    { lane: "interactive" },
  )),
  "financial.source.admit": operation<[request: PGliteCanonicalSourceAdmissionRequest], PGliteCanonicalSourceAdmissionReceipt>(
    (args) => args.length === 1 && sourceEvidenceShape(args[0]),
    { lane: "background" },
  ),
  "financial.source.commit": operation<[request: PGliteCanonicalFinancialCommitRequest], PGliteCanonicalFinancialCommitResult>(
    (args) => args.length === 1 && sourceCommitShape(args[0]),
    { lane: "background", canonicalCommit: true },
  ),
  "financial.deposit.commit": operation<[request: PGliteCanonicalDepositCommitRequest], PGliteCanonicalDepositCommitResult>(
    (args) => args.length === 1 && plainRecord(args[0])
      && plainRecord((args[0] as Record<string, unknown>).capture),
    { lane: "background", canonicalCommit: true },
  ),
  "financial.balance.capture": operation<[request: PGliteCanonicalBalanceCaptureRequest], PGliteCanonicalBalanceCommitResult>(
    (args) => args.length === 1 && plainRecord(args[0])
      && sourceEvidenceShape((args[0] as Record<string, unknown>).capture)
      && plainRecord((args[0] as Record<string, unknown>).account)
      && Array.isArray((args[0] as Record<string, unknown>).observations),
    { lane: "background", canonicalCommit: true },
  ),
  "financial.einvoice.commit": operation<[request: CanonicalEInvoiceCaptureInput], PGliteCanonicalEInvoiceCommitResult>(
    (args) => args.length === 1 && einvoiceCaptureShape(args[0]),
    { lane: "background", canonicalCommit: true },
  ),
  "financial.creditCard.commit": operation<[request: PGliteCanonicalCreditCardCaptureRequest], PGliteCanonicalCreditCardCommitResult>(
    (args) => args.length === 1 && plainRecord(args[0])
      && sourceEvidenceShape((args[0] as Record<string, unknown>).capture)
      && plainRecord((args[0] as Record<string, unknown>).account)
      && plainRecord((args[0] as Record<string, unknown>).identity)
      && Array.isArray((args[0] as Record<string, unknown>).instruments)
      && Array.isArray((args[0] as Record<string, unknown>).transactions)
      && Array.isArray((args[0] as Record<string, unknown>).statements),
    { lane: "background", canonicalCommit: true },
  ),
  "financial.creditCard.balance": operation<[request: PGliteCanonicalCreditCardBalanceCaptureRequest], PGliteCanonicalCreditCardCommitResult>(
    (args) => args.length === 1 && plainRecord(args[0])
      && sourceEvidenceShape((args[0] as Record<string, unknown>).capture)
      && plainRecord((args[0] as Record<string, unknown>).account)
      && plainRecord((args[0] as Record<string, unknown>).identity)
      && plainRecord((args[0] as Record<string, unknown>).balance),
    { lane: "background", canonicalCommit: true },
  ),
  "financial.loan.commit": operation<[request: PGliteCanonicalLoanCommitRequest], PGliteCanonicalLoanCommitResult>(
    (args) => args.length === 1 && plainRecord(args[0])
      && plainRecord((args[0] as Record<string, unknown>).capture),
    { lane: "background", canonicalCommit: true },
  ),
  "financial.investment.commit": operation<[request: PGliteCanonicalInvestmentCommitRequest], PGliteCanonicalInvestmentCommitResult>(
    (args) => args.length === 1 && plainRecord(args[0])
      && plainRecord((args[0] as Record<string, unknown>).capture),
    { lane: "background", canonicalCommit: true },
  ),
  "financial.loanRelations.resolve": operation<[request: PGliteCanonicalLoanRelationResolutionRequest], PGliteCanonicalLoanRelationResolutionResult>(
    (args) => args.length === 1 && plainRecord(args[0])
      && typeof (args[0] as Record<string, unknown>).sourceConnectionKey === "string",
    { lane: "background" },
  ),
  "financial.investmentRelations.resolve": operation<[request: PGliteCanonicalInvestmentRelationResolutionRequest], PGliteCanonicalInvestmentRelationResolutionResult>(
    (args) => args.length === 0 || (args.length === 1 && plainRecord(args[0])),
    { lane: "background" },
  ),
  "financial.loanRelations.current": operation<[options?: { sourceConnectionKey?: string; integrationNamespace?: string }], readonly Readonly<Record<string, unknown>>[]>(
    (args) => args.length === 0 || (args.length === 1 && plainRecord(args[0])),
    { lane: "background" },
  ),
  "financial.loanSettlementGroups.current": operation<[options?: { sourceConnectionKey?: string; integrationNamespace?: string }], readonly Readonly<Record<string, unknown>>[]>(
    (args) => args.length === 0 || (args.length === 1 && plainRecord(args[0])),
    { lane: "background" },
  ),
  "financial.investmentRelations.current": operation<[sourceConnectionKey?: string], readonly Readonly<Record<string, unknown>>[]>(
    (args) => args.length === 0 || (args.length === 1 && typeof args[0] === "string"),
    { lane: "background" },
  ),
  "financial.tdccFundAccounts.list": operation<[connection: Readonly<{ sourceConnectionKey: string; identityEpochKey: string }>], readonly TdccAdmittedFundAccount[]>(
    (args) => args.length === 1 && stringField(args[0], "sourceConnectionKey") && stringField(args[0], "identityEpochKey"),
    { lane: "background" },
  ),
  "financial.accountIdentity.continuity": operation<[request: AccountIdentityContinuityRequest], AccountIdentityContinuity>(
    (args) => args.length === 1 && accountIdentityContinuityRequestShape(args[0]),
    { lane: "background" },
  ),
  /** One Manual Asset command (ADR 0087); the worker parses it against the category registry. */
  "financial.manualAssets.apply": rendered("manualAssets", "apply", operation<[command: ManualAssetCommand], ManualAssetCommandResult>(
    (args) => args.length === 1 && plainRecord(args[0]),
    { lane: "interactive" },
  )),
  /** Canonical Reset (ADR 0062): replaces all financial state with an empty store. */
  "financial.canonical.reset": operation<[], void>(
    (args) => args.length === 0,
    { lane: "interactive" },
  ),
  /** Integration namespaces whose card captures the store refuses until a Canonical Reset. */
  "financial.canonical.resetRequired": operation<[], readonly string[]>(
    (args) => args.length === 0,
    { lane: "background" },
  ),
});

export type PGliteFinancialOperation = keyof typeof PGLITE_FINANCIAL_CONTRACTS;
export type PGliteFinancialArgs<Op extends PGliteFinancialOperation> =
  NonNullable<(typeof PGLITE_FINANCIAL_CONTRACTS)[Op]["contract"]> extends (args: infer Args) => unknown ? Args : never;
export type PGliteFinancialResult<Op extends PGliteFinancialOperation> =
  NonNullable<(typeof PGLITE_FINANCIAL_CONTRACTS)[Op]["contract"]> extends (args: never) => infer Result ? Result : never;

export const PGLITE_FINANCIAL_OPERATIONS = Object.freeze(
  Object.keys(PGLITE_FINANCIAL_CONTRACTS) as PGliteFinancialOperation[],
);

type FinancialContracts = typeof PGLITE_FINANCIAL_CONTRACTS;
type BridgeRoute = Readonly<{ group: FinancialBridgeGroup; method: string }>;
type RendererRoute<Op extends PGliteFinancialOperation> =
  FinancialContracts[Op] extends Readonly<{ renderer: infer Route extends BridgeRoute }> ? Route : never;

/** The financial operations the renderer may call, each through its own preload channel. */
export type RendererFinancialOperation = {
  [Op in PGliteFinancialOperation]: [RendererRoute<Op>] extends [never] ? never : Op;
}[PGliteFinancialOperation];

export const RENDERER_FINANCIAL_OPERATIONS = Object.freeze(
  PGLITE_FINANCIAL_OPERATIONS.filter((operation) => "renderer" in PGLITE_FINANCIAL_CONTRACTS[operation]) as RendererFinancialOperation[],
);

export type RendererFinancialGroup<Op extends RendererFinancialOperation> =
  RendererRoute<Op> extends Readonly<{ group: infer Group extends FinancialBridgeGroup }> ? Group : never;
export type RendererFinancialMethod<Op extends RendererFinancialOperation> =
  RendererRoute<Op> extends Readonly<{ method: infer Method extends string }> ? Method : never;

/** The bridge methods a group's renderer operations give `window.octopusBeak[group]`. */
export type FinancialBridge<Group extends FinancialBridgeGroup> = {
  [Op in RendererFinancialOperation as RendererFinancialGroup<Op> extends Group ? RendererFinancialMethod<Op> : never]:
    (...args: Extract<PGliteFinancialArgs<Op>, readonly unknown[]>) => Promise<PGliteFinancialResult<Op>>;
};

export function isPGliteFinancialOperation(value: unknown): value is PGliteFinancialOperation {
  return typeof value === "string" && Object.hasOwn(PGLITE_FINANCIAL_CONTRACTS, value);
}

export type PGliteFinancialExpectedSources = readonly CanonicalOverviewExpectedSource[];

export type PGliteFinancialRequest = Readonly<{
  kind: "pglite-financial-request";
  version: 1;
  id: number;
  operation: PGliteFinancialOperation | string;
  args: readonly unknown[];
  diagnosticContext?: WorkflowFailureCorrelation;
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
    reason?: PGliteWorkflowAdmissionReason;
    diagnosticError?: SafeWorkflowFailureError;
    message: string;
  }>;

export type PGliteFinancialRequestOptions = Readonly<{
  signal?: AbortSignal;
}>;

/** Allowlisted categories used by workflow item/fatal handling and UI errors. */
export type PGliteFinancialFailureCategory =
  | "admission"
  | "stale"
  | "ineligible"
  | "conflict"
  | "refused"
  | "fatal";

/** The worker-owned implementation of every financial operation. */
export type PGliteFinancialRegistry = Readonly<{
  [Op in PGliteFinancialOperation]: (
    args: PGliteFinancialArgs<Op>,
    options?: PGliteCanonicalCommitOptions,
  ) => Promise<PGliteFinancialResult<Op>>;
}>;

/** Named financial operations, served in-process or across a worker port. */
export type PGliteFinancialPort = Readonly<{
  request<Op extends PGliteFinancialOperation>(
    operation: Op,
    args: PGliteFinancialArgs<Op>,
    options?: PGliteFinancialRequestOptions,
  ): Promise<PGliteFinancialResult<Op>>;
}>;
