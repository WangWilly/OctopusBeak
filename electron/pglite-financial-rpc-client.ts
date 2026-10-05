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
} from "../src/lib/spending/model.ts";
import type { SpendingLoadInput } from "../src/lib/spending/contracts.ts";
import type { CanonicalOverviewExpectedSource } from "../src/ledger/canonical/canonical-overview-query.ts";
import type {
  PGliteCanonicalFinancialCommitBatchRequest,
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
  executePGliteCanonicalEInvoiceCommit,
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
import type {
  PGliteCanonicalLoanRelationResolutionRequest,
  PGliteCanonicalLoanRelationResolutionResult,
  PGliteCanonicalInvestmentRelationResolutionRequest,
  PGliteCanonicalInvestmentRelationResolutionResult,
} from "../src/ledger/pglite/relations.ts";
import type { ExchangeRateRecord } from "../src/ledger/exchange-rates.ts";
import { retainSafeWorkflowFailureError, type SafeWorkflowFailureError, type WorkflowFailureCorrelation } from "../src/lib/automation/server/workflow-failure-diagnostics.ts";

/** Stable named query/command registry identifiers. */
export const PGLITE_FINANCIAL_OPERATIONS = [
  "financial.overview.current",
  "financial.assets.current",
  "financial.liabilities.current",
  "financial.spending.current",
  "financial.spending.version",
  "financial.spending.pairing",
  "financial.spending.confirmCandidate",
  "financial.spending.denyCandidate",
  "financial.spending.revokeLink",
  "financial.spending.setPurchaseCategory",
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
  | "fatal";

export type PGliteFinancialRegistry = Readonly<{
  overviewCurrent(expectedSources?: PGliteFinancialExpectedSources): Promise<OverviewPageDto>;
  assetsCurrent(expectedSources?: PGliteFinancialExpectedSources): Promise<AssetsPageDto>;
  liabilitiesCurrent(expectedSources?: PGliteFinancialExpectedSources): Promise<LiabilitiesPageDto>;
  spendingCurrent(input?: SpendingLoadInput): Promise<SpendingPageDto>;
  spendingVersion(): Promise<number>;
  spendingPairing(input: SpendingPairingCandidatesInput): Promise<SpendingPairingCandidatesResult>;
  confirmCandidate(input: SpendingConfirmActionInput): Promise<SpendingPurchaseActionResult>;
  denyCandidate(input: SpendingCandidateActionInput): Promise<SpendingPurchaseActionResult>;
  revokeLink(input: SpendingLinkActionInput): Promise<SpendingPurchaseActionResult>;
  setPurchaseCategory(input: SpendingPurchaseCategoryRequest): Promise<SpendingPurchaseCategoryResult>;
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

export type PGliteFinancialRpcClient = Readonly<{
  request<K extends PGliteFinancialOperation>(operation: K, args: readonly unknown[], options?: PGliteFinancialRequestOptions): Promise<unknown>;
  registry: PGliteFinancialRegistry;
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
  const call = <K extends PGliteFinancialOperation>(operation: K, args: readonly unknown[], options?: PGliteFinancialRequestOptions) => request(operation, args, options);
  const registry: PGliteFinancialRegistry = {
    overviewCurrent: (expectedSources) => call("financial.overview.current", expectedSources === undefined ? [] : [expectedSources]) as Promise<OverviewPageDto>,
    assetsCurrent: (expectedSources) => call("financial.assets.current", expectedSources === undefined ? [] : [expectedSources]) as Promise<AssetsPageDto>,
    liabilitiesCurrent: (expectedSources) => call("financial.liabilities.current", expectedSources === undefined ? [] : [expectedSources]) as Promise<LiabilitiesPageDto>,
    spendingCurrent: (input) => call("financial.spending.current", input === undefined ? [] : [input]) as Promise<SpendingPageDto>,
    spendingVersion: () => call("financial.spending.version", []) as Promise<number>,
    spendingPairing: (input) => call("financial.spending.pairing", [input]) as Promise<SpendingPairingCandidatesResult>,
    confirmCandidate: (input) => call("financial.spending.confirmCandidate", [input]) as Promise<SpendingPurchaseActionResult>,
    denyCandidate: (input) => call("financial.spending.denyCandidate", [input]) as Promise<SpendingPurchaseActionResult>,
    revokeLink: (input) => call("financial.spending.revokeLink", [input]) as Promise<SpendingPurchaseActionResult>,
    setPurchaseCategory: (input) => call("financial.spending.setPurchaseCategory", [input]) as Promise<SpendingPurchaseCategoryResult>,
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
