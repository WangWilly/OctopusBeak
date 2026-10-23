import type { AssetsPageDto } from "../src/lib/assets/types.ts";
import type { LiabilitiesPageDto } from "../src/lib/liabilities/types.ts";
import type { OverviewPageDto } from "../src/lib/overview/types.ts";
import type {
  SpendingCandidateActionInput,
  SpendingConfirmActionInput,
  SpendingPairingCandidatesInput,
  SpendingPairingCandidatesResult,
  SpendingLinkActionInput,
  SpendingPurchaseActionResult,
  SpendingPurchaseCategoryRequest,
  SpendingPurchaseCategoryResult,
  SpendingPageDto,
  SpendingStrongConfirmRequest,
  SpendingStrongConfirmResult,
  SpendingCandidatePageDto,
  SpendingCandidatePageRequest,
  SpendingMergeLogDto,
  SpendingMergeLogRequest,
  SpendingMerchantStatsDto,
  SpendingMerchantStatsRequest,
  SpendingMonthInsightDto,
  SpendingMonthInsightRequest,
  SpendingPageActionRequest,
  SpendingPageActionResult,
  SpendingPendingOverviewDto,
  SpendingPendingOverviewRequest,
  SpendingRecordPageDto,
  SpendingRecordPageRequest,
} from "../src/lib/spending/model.ts";
import type { SpendingPageReadResult } from "../src/lib/spending/page-reader.ts";
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
  PGliteCanonicalMixedCommitRequest,
  PGliteCanonicalMixedCommitResult,
} from "../src/ledger/pglite/mixed-commit.ts";
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
import type {
  PGliteCanonicalLoanRelationResolutionRequest,
  PGliteCanonicalLoanRelationResolutionResult,
  PGliteCanonicalInvestmentRelationResolutionRequest,
  PGliteCanonicalInvestmentRelationResolutionResult,
} from "../src/ledger/pglite/relations.ts";
import type { ExchangeRateRecord } from "../src/ledger/exchange-rates.ts";
import { retainSafeWorkflowFailureError, type SafeWorkflowFailureError, type WorkflowFailureCorrelation } from "../src/lib/automation/server/workflow-failure-diagnostics.ts";
import type { CanonicalEInvoiceCaptureInput } from "../src/ledger/canonical/einvoice-contract.ts";

type FinancialOperationContract<Args extends readonly unknown[], Result> = Readonly<{
  accepts(args: readonly unknown[]): boolean;
  /** Canonical writes from a workflow run must pass isCommitAdmissible first. */
  canonicalCommit?: true;
  /** Type-only: the argument tuple a caller sends and the result it receives. */
  contract?: (args: Args) => Result;
}>;

function operation<Args extends readonly unknown[], Result>(
  accepts: (args: readonly unknown[]) => boolean,
  flags: Readonly<{ canonicalCommit?: true }> = {},
): FinancialOperationContract<Args, Result> {
  return Object.freeze({ accepts, ...flags });
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
    (args) => args.length === 0 || (args.length === 1 && Array.isArray(args[0]))
  ),
  "financial.assets.current": operation<[expectedSources?: PGliteFinancialExpectedSources], AssetsPageDto>(
    (args) => args.length === 0 || (args.length === 1 && Array.isArray(args[0]))
  ),
  "financial.liabilities.current": operation<[expectedSources?: PGliteFinancialExpectedSources], LiabilitiesPageDto>(
    (args) => args.length === 0 || (args.length === 1 && Array.isArray(args[0]))
  ),
  "financial.spending.current": operation<[input?: SpendingLoadInput], SpendingPageDto>(
    (args) => args.length === 0 || (args.length === 1 && plainRecord(args[0]))
  ),
  "financial.spending.recordPage": operation<[request: SpendingRecordPageRequest], SpendingPageReadResult<SpendingRecordPageDto>>(
    (args) => args.length === 1 && plainRecord(args[0])
  ),
  "financial.spending.candidatePage": operation<[request: SpendingCandidatePageRequest], SpendingPageReadResult<SpendingCandidatePageDto>>(
    (args) => args.length === 1 && plainRecord(args[0])
  ),
  "financial.spending.pendingOverview": operation<[request: SpendingPendingOverviewRequest], SpendingPageReadResult<SpendingPendingOverviewDto>>(
    (args) => args.length === 1 && plainRecord(args[0])
  ),
  "financial.spending.mergeLog": operation<[request: SpendingMergeLogRequest], SpendingPageReadResult<SpendingMergeLogDto>>(
    (args) => args.length === 1 && plainRecord(args[0])
  ),
  "financial.spending.monthInsight": operation<[request: SpendingMonthInsightRequest], SpendingPageReadResult<SpendingMonthInsightDto>>(
    (args) => args.length === 1 && plainRecord(args[0])
  ),
  "financial.spending.merchantStats": operation<[request: SpendingMerchantStatsRequest], SpendingPageReadResult<SpendingMerchantStatsDto>>(
    (args) => args.length === 1 && plainRecord(args[0])
  ),
  "financial.spending.pageAction": operation<[request: SpendingPageActionRequest], SpendingPageActionResult>(
    (args) => args.length === 1 && plainRecord(args[0])
  ),
  "financial.spending.version": operation<[], number>(
    (args) => args.length === 0
  ),
  /** Build the pairing index when the store is still at this version; returns the current version. */
  "financial.spending.prewarmPairing": operation<[dataVersion: number], number>(
    (args) => args.length === 1 && nonNegativeSafeInteger(args[0])
  ),
  "financial.preview.visibilityChanged": operation<[], void>(
    (args) => args.length === 0
  ),
  "financial.spending.pairing": operation<[input: SpendingPairingCandidatesInput], SpendingPairingCandidatesResult>(
    (args) => args.length === 1 && plainRecord(args[0])
      && typeof (args[0] as Record<string, unknown>).invoiceIdentityId === "string"
      && nonNegativeSafeInteger((args[0] as Record<string, unknown>).dataVersion)
  ),
  "financial.spending.confirmCandidate": operation<[input: SpendingConfirmActionInput], SpendingPurchaseActionResult>(
    (args) => args.length === 1 && plainRecord(args[0])
  ),
  "financial.spending.denyCandidate": operation<[input: SpendingCandidateActionInput], SpendingPurchaseActionResult>(
    (args) => args.length === 1 && plainRecord(args[0])
  ),
  "financial.spending.revokeLink": operation<[input: SpendingLinkActionInput], SpendingPurchaseActionResult>(
    (args) => args.length === 1 && plainRecord(args[0])
  ),
  "financial.spending.setPurchaseCategory": operation<[input: SpendingPurchaseCategoryRequest], SpendingPurchaseCategoryResult>(
    (args) => args.length === 1 && plainRecord(args[0])
      && stringField(args[0], "purchaseId")
      && nonNegativeSafeInteger((args[0] as Record<string, unknown>).knowledgeAt)
      && ((args[0] as Record<string, unknown>).categoryCode === null
        || typeof (args[0] as Record<string, unknown>).categoryCode === "string")
  ),
  "financial.spending.confirmStrongCandidates": operation<[input: SpendingStrongConfirmRequest], SpendingStrongConfirmResult>(
    (args) => args.length === 1 && plainRecord(args[0])
      && nonNegativeSafeInteger((args[0] as Record<string, unknown>).shownKnowledgeAt)
      && Array.isArray((args[0] as Record<string, unknown>).pairs)
  ),
  "financial.source.admit": operation<[request: PGliteCanonicalSourceAdmissionRequest], PGliteCanonicalSourceAdmissionReceipt>(
    (args) => args.length === 1 && sourceEvidenceShape(args[0])
  ),
  "financial.source.commit": operation<[request: PGliteCanonicalFinancialCommitRequest], PGliteCanonicalFinancialCommitResult>(
    (args) => args.length === 1 && sourceCommitShape(args[0]),
    { canonicalCommit: true },
  ),
  "financial.deposit.commit": operation<[request: PGliteCanonicalDepositCommitRequest], PGliteCanonicalDepositCommitResult>(
    (args) => args.length === 1 && plainRecord(args[0])
      && plainRecord((args[0] as Record<string, unknown>).capture),
    { canonicalCommit: true },
  ),
  "financial.mixed.commit": operation<[request: PGliteCanonicalMixedCommitRequest], PGliteCanonicalMixedCommitResult>(
    (args) => args.length === 1 && plainRecord(args[0])
      && Array.isArray((args[0] as Record<string, unknown>).steps)
      && ((args[0] as Record<string, unknown>).steps as unknown[]).length > 0
      && ((args[0] as Record<string, unknown>).steps as unknown[]).every((step) =>
        plainRecord(step)
        && (step.kind === "source" && sourceEvidenceShape(step.request)
          || step.kind === "financial" && sourceCommitShape(step.request)
          || step.kind === "deposit" && plainRecord(step.request)
            && plainRecord(step.request.capture))),
    { canonicalCommit: true },
  ),
  "financial.balance.capture": operation<[request: PGliteCanonicalBalanceCaptureRequest], PGliteCanonicalBalanceCommitResult>(
    (args) => args.length === 1 && plainRecord(args[0])
      && sourceEvidenceShape((args[0] as Record<string, unknown>).capture)
      && plainRecord((args[0] as Record<string, unknown>).account)
      && Array.isArray((args[0] as Record<string, unknown>).observations),
    { canonicalCommit: true },
  ),
  "financial.einvoice.commit": operation<[request: CanonicalEInvoiceCaptureInput], PGliteCanonicalEInvoiceCommitResult>(
    (args) => args.length === 1 && einvoiceCaptureShape(args[0]),
    { canonicalCommit: true },
  ),
  "financial.creditCard.commit": operation<[request: PGliteCanonicalCreditCardCaptureRequest], PGliteCanonicalCreditCardCommitResult>(
    (args) => args.length === 1 && plainRecord(args[0])
      && sourceEvidenceShape((args[0] as Record<string, unknown>).capture)
      && plainRecord((args[0] as Record<string, unknown>).account)
      && plainRecord((args[0] as Record<string, unknown>).identity)
      && Array.isArray((args[0] as Record<string, unknown>).instruments)
      && Array.isArray((args[0] as Record<string, unknown>).transactions)
      && Array.isArray((args[0] as Record<string, unknown>).statements),
    { canonicalCommit: true },
  ),
  "financial.creditCard.balance": operation<[request: PGliteCanonicalCreditCardBalanceCaptureRequest], PGliteCanonicalCreditCardCommitResult>(
    (args) => args.length === 1 && plainRecord(args[0])
      && sourceEvidenceShape((args[0] as Record<string, unknown>).capture)
      && plainRecord((args[0] as Record<string, unknown>).account)
      && plainRecord((args[0] as Record<string, unknown>).identity)
      && plainRecord((args[0] as Record<string, unknown>).balance),
    { canonicalCommit: true },
  ),
  "financial.loan.commit": operation<[request: PGliteCanonicalLoanCommitRequest], PGliteCanonicalLoanCommitResult>(
    (args) => args.length === 1 && plainRecord(args[0])
      && plainRecord((args[0] as Record<string, unknown>).capture),
    { canonicalCommit: true },
  ),
  "financial.investment.commit": operation<[request: PGliteCanonicalInvestmentCommitRequest], PGliteCanonicalInvestmentCommitResult>(
    (args) => args.length === 1 && plainRecord(args[0])
      && plainRecord((args[0] as Record<string, unknown>).capture),
    { canonicalCommit: true },
  ),
  "financial.loanRelations.resolve": operation<[request: PGliteCanonicalLoanRelationResolutionRequest], PGliteCanonicalLoanRelationResolutionResult>(
    (args) => args.length === 1 && plainRecord(args[0])
      && typeof (args[0] as Record<string, unknown>).sourceConnectionKey === "string"
  ),
  "financial.investmentRelations.resolve": operation<[request: PGliteCanonicalInvestmentRelationResolutionRequest], PGliteCanonicalInvestmentRelationResolutionResult>(
    (args) => args.length === 0 || (args.length === 1 && plainRecord(args[0]))
  ),
  "financial.loanRelations.current": operation<[options?: { sourceConnectionKey?: string; integrationNamespace?: string }], readonly Readonly<Record<string, unknown>>[]>(
    (args) => args.length === 0 || (args.length === 1 && plainRecord(args[0]))
  ),
  "financial.loanSettlementGroups.current": operation<[options?: { sourceConnectionKey?: string; integrationNamespace?: string }], readonly Readonly<Record<string, unknown>>[]>(
    (args) => args.length === 0 || (args.length === 1 && plainRecord(args[0]))
  ),
  "financial.investmentRelations.current": operation<[sourceConnectionKey?: string], readonly Readonly<Record<string, unknown>>[]>(
    (args) => args.length === 0 || (args.length === 1 && typeof args[0] === "string")
  ),
  "financial.exchangeRates.read": operation<[currencies?: string[]], ExchangeRateRecord[]>(
    (args) => args.length === 0 || (args.length === 1 && Array.isArray(args[0]) && (args[0] as unknown[]).every((value) => typeof value === "string"))
  ),
  "financial.tdccFundAccounts.list": operation<[connection: Readonly<{ sourceConnectionKey: string; identityEpochKey: string }>], readonly TdccAdmittedFundAccount[]>(
    (args) => args.length === 1 && stringField(args[0], "sourceConnectionKey") && stringField(args[0], "identityEpochKey")
  ),
  "financial.accountIdentity.continuity": operation<[request: AccountIdentityContinuityRequest], AccountIdentityContinuity>(
    (args) => args.length === 1 && accountIdentityContinuityRequestShape(args[0])
  ),
  "financial.exchangeRates.upsert": operation<[rows: readonly ExchangeRateRecord[]], void>(
    (args) => args.length === 1 && Array.isArray(args[0]) && (args[0] as unknown[]).every((row) => plainRecord(row))
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
    diagnosticError?: SafeWorkflowFailureError;
    message: string;
  }>;

export type PGliteFinancialRpcPort = {
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

export type PGliteFinancialRpcClient = PGliteFinancialPort & Readonly<{
  close(error?: Error): void;
}>;


function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
    || value === "refused"
    || value === "fatal";
}

export function createPGliteFinancialRpcClient(
  port: PGliteFinancialRpcPort,
  ready?: Promise<void>,
  diagnosticContext?: WorkflowFailureCorrelation,
): PGliteFinancialRpcClient {
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
      const error = new PGliteFinancialError(code, isFailureCategory(value.category) ? value.category : undefined);
      if (code === "operation-failed") retainSafeWorkflowFailureError(error, value.diagnosticError);
      request.reject(error);
    }
  };
  port.on("message", onMessage);
  const send = (operation: PGliteFinancialOperation, args: readonly unknown[], options: PGliteFinancialRequestOptions = {}): Promise<unknown> => {
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
          port.postMessage({
            kind: "pglite-financial-request",
            version: 1,
            id,
            operation,
            args,
            ...(diagnosticContext ? { diagnosticContext } : {}),
          } satisfies PGliteFinancialRequest);
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
  const request = send as PGliteFinancialPort["request"];
  return { request, close };
}
