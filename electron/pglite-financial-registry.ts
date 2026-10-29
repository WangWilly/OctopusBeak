import { SpendingPageVersionError, type SpendingPageReadResult } from "../src/lib/spending/page-reader.ts";
import {
  type SpendingCandidatePageDto,
  type SpendingCandidatePageRequest,
  type SpendingPageActionRequest,
  type SpendingPageActionResult,
  type SpendingRecordPageDto,
  type SpendingRecordPageRequest,
} from "../src/lib/spending/model.ts";
import type {
  SpendingPairingCandidatesInput,
  SpendingPairingCandidatesResult,
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
import { NO_PREVIEW_VISIBILITY, type PreviewVisibility } from "../src/ledger/pglite/preview-financial-data.ts";
import {
  createPGliteSpendingQuery,
} from "../src/ledger/pglite/spending-query.ts";
import {
  createPGliteSpendingCommands,
} from "../src/ledger/pglite/spending-command.ts";
import {
  createPGliteCanonicalSourceStore,
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
  canonicalResetRequiredNamespaces,
  resetPGliteCanonicalStore,
} from "../src/ledger/pglite/canonical-reset.ts";
import {
  resolvePGliteCanonicalLoanRepaymentRelations,
  resolvePGliteCanonicalInvestmentFundingRelations,
  queryPGliteCurrentLoanRepaymentRelations,
  queryPGliteCurrentLoanRepaymentSettlementGroups,
  queryPGliteCurrentInvestmentFundingRelations,
  type PGliteCanonicalLoanRelationResolutionRequest,
  type PGliteCanonicalInvestmentRelationResolutionRequest,
} from "../src/ledger/pglite/relations.ts";
import type { PGliteStore } from "../src/ledger/pglite/transaction.ts";
import type { PGliteCanonicalCommitOptions } from "../src/ledger/pglite/canonical-source-store.ts";
import { PGliteCanonicalSourceAdmissionError } from "../src/ledger/pglite/source-admission-validation.ts";
import { readAssetsPage, readLiabilitiesPage, readOverviewPage } from "../src/ledger/pglite/financial-pages.ts";
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
import { pgliteWorkflowAdmissionReason, type PGliteWorkflowAdmissionReason } from "../src/ledger/pglite/workflow-client.ts";


import {
  isPGliteFinancialOperation,
  PGLITE_FINANCIAL_CONTRACTS,
  PGliteFinancialError,
  type PGliteFinancialCancelRequest,
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
export type PGliteFinancialPageActionEvents = Readonly<{
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
  reason?: PGliteWorkflowAdmissionReason,
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
    ...(reason ? { reason } : {}),
    ...(diagnosticError ? { diagnosticError } : {}),
  };
}

/** The rejecting admission rule's fixed code, kept across a second RPC boundary like the category. */
function failureReason(error: unknown): PGliteWorkflowAdmissionReason | undefined {
  if (error instanceof PGliteFinancialError) return error.reason;
  if (error instanceof PGliteCanonicalSourceAdmissionError) return pgliteWorkflowAdmissionReason(error.reason);
  if (error instanceof PGliteCanonicalCreditCardAdmissionError || error instanceof PGliteCanonicalEInvoiceAdmissionError)
    return pgliteWorkflowAdmissionReason(error.code);
  return undefined;
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

export function createPGliteFinancialRegistry(
  store: PGliteStore,
  previewVisibility: () => PreviewVisibility = () => NO_PREVIEW_VISIBILITY,
): PGliteFinancialRegistryWithPageActionEvents {
  const spending = createPGliteSpendingQuery(store);
  const commands = createPGliteSpendingCommands(store);
  const source = createPGliteCanonicalSourceStore(store);
  let spendingPageActionCount = 0;
  let latestSettledPageAction: SpendingPageActionResult | null = null;
  const pageActionListeners = new Set<(result: SpendingPageActionResult | null) => void>();
  const previewVisibilityListeners = new Set<() => void>();
  return Object.freeze({
    "financial.overview.current": ([expectedSources = []]) =>
      store.transaction((transaction) => readOverviewPage(transaction, { expectedSources, previewVisibility: previewVisibility() })),
    "financial.assets.current": ([expectedSources = []]) =>
      store.transaction((transaction) => readAssetsPage(transaction, { expectedSources, previewVisibility: previewVisibility() })),
    "financial.liabilities.current": ([expectedSources = []]) =>
      store.transaction((transaction) => readLiabilitiesPage(transaction, { expectedSources, previewVisibility: previewVisibility() })),
    "financial.spending.current": ([input = {}]) => spending.summaryPage(input),
    "financial.spending.recordPage": ([request]) => spending.recordPage(request),
    "financial.spending.candidatePage": ([request]) => spending.candidatePage(request),
    "financial.spending.pendingOverview": ([request]) => spending.pendingOverview(request),
    "financial.spending.mergeLog": ([request]) => spending.mergeLog(request),
    "financial.spending.monthInsight": ([request]) => spending.monthInsight(request),
    "financial.spending.merchantStats": ([request]) => spending.merchantStats(request),
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
    "financial.canonical.reset": () => resetPGliteCanonicalStore(store),
    "financial.canonical.resetRequired": () => canonicalResetRequiredNamespaces(store),
  });
}

/**
 * False refuses a workflow's canonical write before it reaches the database
 * (ADR 0058). A throw is an ordinary failure, not a refusal.
 */
export type PGliteCanonicalCommitAdmission = (context: WorkflowFailureCorrelation) => boolean;

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

async function staleWhenVersionMoved<T>(read: Promise<T>): Promise<SpendingPageReadResult<T>> {
  try {
    return await read;
  } catch (error) {
    if (!(error instanceof SpendingPageVersionError)) throw error;
    return { stale: true, knowledgeAt: error.knowledgeAt };
  }
}

/**
 * Serve a worker-owned registry through the same port interface the RPC
 * client offers. A page read's stale version is answered here, once.
 */
export function createPGliteFinancialLocalPort(registry: PGliteFinancialRegistry): PGliteFinancialPort {
  return Object.freeze({
    request: (operation, args, options) => {
      const result = (registry[operation] as (
        args: unknown,
        options?: PGliteCanonicalCommitOptions,
      ) => Promise<never>)(args, options);
      return PGLITE_FINANCIAL_CONTRACTS[operation].pageRead
        ? staleWhenVersionMoved(result) as Promise<never>
        : result;
    },
  });
}

/** Install the named financial registry on the same worker MessagePort. */
export function createPGliteFinancialRpcServer(
  port: RpcPort,
  financial: PGliteFinancialPort,
  isCommitAdmissible?: PGliteCanonicalCommitAdmission,
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
    const latestWins = contract.lane === "latest-wins";
    const queuedRead = latestWins ? queuedReads.get(operation) : undefined;
    let outcome: Promise<unknown>;
    if (queuedRead) {
      queuedRead.args = value.args;
      outcome = queuedRead.outcome;
    } else {
      const read = { args: value.args, outcome: Promise.resolve() as Promise<unknown> };
      outcome = scheduler.schedule(contract.lane === "interactive" ? "interactive" : "background", async () => {
        if (latestWins && queuedReads.get(operation) === read) queuedReads.delete(operation);
        if (controller.signal.aborted) throw new Error("PGlite financial operation was cancelled before execution.");
        if (isCommitAdmissible && value.diagnosticContext && contract.canonicalCommit
          && !isCommitAdmissible(value.diagnosticContext)) {
          throw new PGliteFinancialError("operation-failed", "refused");
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
          const refused = error instanceof PGliteFinancialError && error.category === "refused";
          await appendWorkflowFailureDiagnostic(process.env[WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV], {
            workflowId: value.diagnosticContext.workflowId,
            taskRunId: value.diagnosticContext.taskRunId,
            source: "financial-rpc",
            errorCode: refused ? "collection-scope-changed" : "workflow-failed",
            stage: operation === "financial.source.admit" ? "validation" : "commit",
            operation,
            reason: failureReason(error),
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
            controller.signal.aborted ? undefined : failureReason(error),
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
