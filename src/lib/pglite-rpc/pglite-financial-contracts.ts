import type { AssetsPageDto } from "../assets/types.ts";
import type { LiabilitiesPageDto } from "../liabilities/types.ts";
import type { ManualAssetCommand, ManualAssetCommandResult } from "../manual-assets/manual-assets.ts";
import type { OverviewPageDto } from "../overview/types.ts";
import type { FinancialPageActionRequest, FinancialPageActionReply } from "../financial/page-actions.ts";
import type {
  SpendingPairingCandidatesInput,
  SpendingPairingCandidatesResult,
  SpendingPageDto,
  SpendingPageReadResult,
  SpendingCandidatePageDto,
  SpendingCandidatePageRequest,
  SpendingClassifyQueueDto,
  SpendingClassifyQueueRequest,
  SpendingMergeLogDto,
  SpendingMergeLogRequest,
  SpendingMerchantStatsDto,
  SpendingMerchantStatsRequest,
  SpendingMonthInsightDto,
  SpendingMonthInsightRequest,
  SpendingPendingOverviewDto,
  SpendingPendingOverviewRequest,
  SpendingRecordPageDto,
  SpendingRecordPageRequest,
} from "../spending/model.ts";
import type { SpendingLoadInput } from "../spending/contracts.ts";
import type { CashFlowPageDto, CashFlowPageRequest } from "../cash-flow/model.ts";
import type { CanonicalOverviewExpectedSource } from "../../ledger/canonical/canonical-overview-query.ts";
import type {
  PGliteCanonicalFinancialCommitRequest,
  PGliteCanonicalFinancialCommitResult,
  PGliteCanonicalSourceAdmissionRequest,
  PGliteCanonicalSourceAdmissionReceipt,
  PGliteCanonicalCommitOptions,
} from "../../ledger/pglite/canonical-source-store.ts";
import type {
  PGliteCanonicalDepositCommitRequest,
  PGliteCanonicalDepositCommitResult,
} from "../../ledger/pglite/deposit.ts";
import type {
  PGliteCanonicalBalanceCaptureRequest,
  PGliteCanonicalBalanceCommitResult,
} from "../../ledger/pglite/balance.ts";
import type {
  PGliteCanonicalEInvoiceCommitResult,
} from "../../ledger/pglite/einvoice.ts";
import type {
  PGliteCanonicalCreditCardBalanceCaptureRequest,
  PGliteCanonicalCreditCardCaptureRequest,
  PGliteCanonicalCreditCardCommitResult,
} from "../../ledger/pglite/credit-card.ts";
import type {
  PGliteCanonicalLoanCommitRequest,
  PGliteCanonicalLoanCommitResult,
} from "../../ledger/pglite/loan.ts";
import type {
  PGliteCanonicalInvestmentCommitRequest,
  PGliteCanonicalInvestmentCommitResult,
} from "../../ledger/pglite/investment.ts";
import type { TdccAdmittedFundAccount } from "../../ledger/canonical/tdcc-investment-admission.ts";
import type { AccountIdentityContinuity, AccountIdentityContinuityRequest } from "../../ledger/pglite/account-identity-continuity.ts";
import type { SpendingPageVersion } from "../../ledger/pglite/spending-page.ts";
import type { CompactionPlanResult } from "../../ledger/pglite/compaction-plan.ts";
import type {
  PGliteCanonicalLoanRelationResolutionRequest,
  PGliteCanonicalLoanRelationResolutionResult,
  PGliteCanonicalInvestmentRelationResolutionRequest,
  PGliteCanonicalInvestmentRelationResolutionResult,
} from "../../ledger/pglite/relations.ts";
import type { SafeWorkflowFailureError, WorkflowFailureCorrelation } from "../automation/server/workflow-failure-diagnostics.ts";
import type { PGliteWorkflowAdmissionReason } from "../../ledger/pglite/workflow-client.ts";
import type { CanonicalEInvoiceCaptureInput } from "../../ledger/canonical/einvoice-contract.ts";
import { plainRecord } from "./pglite-worker-call.ts";

/**
 * How the worker schedules an operation: interactive work answers a click and
 * runs before queued background work; a latest-wins read runs in the
 * background, and a newer request of the same operation replaces a queued one.
 * A background-steps operation is not queued itself: it queues each of its
 * short steps on the background lane, so other work runs between them.
 */
export type PGliteFinancialLane = "interactive" | "background" | "latest-wins" | "background-steps";

/**
 * Whether a workflow may call an operation over the child socket (ADR 0148).
 * The child socket refuses an operation without this flag.
 * - "commit": a canonical write of new evidence; refused unless the run's
 *   execution is current and its Collection scope is unchanged.
 * - "resolve": a canonical write derived only from rows already admitted,
 *   such as relation resolution; refused only when the run is not current.
 */
export type WorkflowAccess = "call" | "commit" | "resolve";

/** A gated write is checked inside its scheduled task, which a latest-wins read or a stepped operation never runs. */
type FinancialOperationFlags =
  | Readonly<{ lane: PGliteFinancialLane; workflow?: "call" }>
  | Readonly<{ lane: "interactive" | "background"; workflow: "commit" | "resolve" }>;

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
    { lane: "background", workflow: "call" },
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
  "financial.cashFlow.current": operation<[request: CashFlowPageRequest], CashFlowPageDto>(
    (args) => args.length === 1 && stringField(args[0], "startDate") && stringField(args[0], "endDate"),
    { lane: "background" },
  ),
  "financial.spending.recordPage": rendered("spending", "loadRecordPage", operation<[request: SpendingRecordPageRequest], SpendingPageReadResult<SpendingRecordPageDto>>(
    (args) => args.length === 1 && plainRecord(args[0]),
    { lane: "interactive" },
  )),
  "financial.spending.classifyQueue": rendered("spending", "loadClassifyQueue", operation<[request: SpendingClassifyQueueRequest], SpendingPageReadResult<SpendingClassifyQueueDto>>(
    (args) => args.length === 1 && stringField(args[0], "startDate") && stringField(args[0], "endDate"),
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
  "financial.pageAction": rendered("spending", "applyPageAction", operation<[request: FinancialPageActionRequest], FinancialPageActionReply>(
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
    { lane: "background", workflow: "call" },
  ),
  "financial.source.commit": operation<[request: PGliteCanonicalFinancialCommitRequest], PGliteCanonicalFinancialCommitResult>(
    (args) => args.length === 1 && sourceCommitShape(args[0]),
    { lane: "background", workflow: "commit" },
  ),
  "financial.deposit.commit": operation<[request: PGliteCanonicalDepositCommitRequest], PGliteCanonicalDepositCommitResult>(
    (args) => args.length === 1 && plainRecord(args[0])
      && plainRecord((args[0] as Record<string, unknown>).capture),
    { lane: "background", workflow: "commit" },
  ),
  "financial.balance.capture": operation<[request: PGliteCanonicalBalanceCaptureRequest], PGliteCanonicalBalanceCommitResult>(
    (args) => args.length === 1 && plainRecord(args[0])
      && sourceEvidenceShape((args[0] as Record<string, unknown>).capture)
      && plainRecord((args[0] as Record<string, unknown>).account)
      && Array.isArray((args[0] as Record<string, unknown>).observations),
    { lane: "background", workflow: "commit" },
  ),
  "financial.einvoice.commit": operation<[request: CanonicalEInvoiceCaptureInput], PGliteCanonicalEInvoiceCommitResult>(
    (args) => args.length === 1 && einvoiceCaptureShape(args[0]),
    { lane: "background", workflow: "commit" },
  ),
  "financial.creditCard.commit": operation<[request: PGliteCanonicalCreditCardCaptureRequest], PGliteCanonicalCreditCardCommitResult>(
    (args) => args.length === 1 && plainRecord(args[0])
      && sourceEvidenceShape((args[0] as Record<string, unknown>).capture)
      && plainRecord((args[0] as Record<string, unknown>).account)
      && plainRecord((args[0] as Record<string, unknown>).identity)
      && Array.isArray((args[0] as Record<string, unknown>).instruments)
      && Array.isArray((args[0] as Record<string, unknown>).transactions)
      && Array.isArray((args[0] as Record<string, unknown>).statements),
    { lane: "background", workflow: "commit" },
  ),
  "financial.creditCard.balance": operation<[request: PGliteCanonicalCreditCardBalanceCaptureRequest], PGliteCanonicalCreditCardCommitResult>(
    (args) => args.length === 1 && plainRecord(args[0])
      && sourceEvidenceShape((args[0] as Record<string, unknown>).capture)
      && plainRecord((args[0] as Record<string, unknown>).account)
      && plainRecord((args[0] as Record<string, unknown>).identity)
      && plainRecord((args[0] as Record<string, unknown>).balance),
    { lane: "background", workflow: "commit" },
  ),
  "financial.loan.commit": operation<[request: PGliteCanonicalLoanCommitRequest], PGliteCanonicalLoanCommitResult>(
    (args) => args.length === 1 && plainRecord(args[0])
      && plainRecord((args[0] as Record<string, unknown>).capture),
    { lane: "background", workflow: "commit" },
  ),
  "financial.investment.commit": operation<[request: PGliteCanonicalInvestmentCommitRequest], PGliteCanonicalInvestmentCommitResult>(
    (args) => args.length === 1 && plainRecord(args[0])
      && plainRecord((args[0] as Record<string, unknown>).capture),
    { lane: "background", workflow: "commit" },
  ),
  "financial.loanRelations.resolve": operation<[request: PGliteCanonicalLoanRelationResolutionRequest], PGliteCanonicalLoanRelationResolutionResult>(
    (args) => args.length === 1 && plainRecord(args[0])
      && typeof (args[0] as Record<string, unknown>).sourceConnectionKey === "string",
    { lane: "background", workflow: "resolve" },
  ),
  "financial.investmentRelations.resolve": operation<[request: PGliteCanonicalInvestmentRelationResolutionRequest], PGliteCanonicalInvestmentRelationResolutionResult>(
    (args) => args.length === 0 || (args.length === 1 && plainRecord(args[0])),
    { lane: "background", workflow: "resolve" },
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
    { lane: "background", workflow: "call" },
  ),
  "financial.accountIdentity.continuity": operation<[request: AccountIdentityContinuityRequest], AccountIdentityContinuity>(
    (args) => args.length === 1 && accountIdentityContinuityRequestShape(args[0]),
    { lane: "background", workflow: "call" },
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
  /** Integration namespaces holding a credit-card account, which a new Card identity secret would split (ADR 0149). */
  "financial.canonical.cardAccountNamespaces": operation<[], readonly string[]>(
    (args) => args.length === 0,
    { lane: "background" },
  ),
  /**
   * What a ledger compaction would remove, read without changing anything,
   * one step at a time. Host-only: no renderer route and no workflow access.
   * Do not wire it to the UI or call it on the live worker until a subject
   * step is split further, for example by record kind or occurrence-key
   * range; one large subject's step can hold the ledger for tens of seconds.
   */
  "financial.canonical.compactionPlan": operation<[], CompactionPlanResult>(
    (args) => args.length === 0,
    { lane: "background-steps" },
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

/** The financial operations a workflow may call over the child socket (ADR 0148). */
export const WORKFLOW_FINANCIAL_OPERATIONS: ReadonlySet<PGliteFinancialOperation> = new Set(
  PGLITE_FINANCIAL_OPERATIONS.filter((operation) => PGLITE_FINANCIAL_CONTRACTS[operation].workflow !== undefined),
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
    code: PGliteFinancialErrorCode;
    /** Safe domain classification; raw worker/database errors never cross IPC. */
    category?: PGliteFinancialFailureCategory;
    reason?: PGliteWorkflowAdmissionReason;
    diagnosticError?: SafeWorkflowFailureError;
    message: string;
  }>;

/** "not-allowed" refuses an operation this connection does not serve, such as a non-workflow operation on the child socket. */
export type PGliteFinancialErrorCode = "invalid-request" | "not-allowed" | "operation-failed" | "worker-closed" | "cancelled";

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
