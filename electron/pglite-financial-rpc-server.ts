import { AsyncLocalStorage } from "node:async_hooks";
import { PGliteCanonicalEInvoiceAdmissionError } from "../src/ledger/pglite/einvoice.ts";
import { PGliteCanonicalCreditCardAdmissionError } from "../src/ledger/pglite/credit-card.ts";
import { PGliteCanonicalSourceAdmissionError } from "../src/ledger/pglite/source-admission-validation.ts";
import {
  appendWorkflowFailureDiagnostic,
  captureSafeWorkflowFailureError,
  type SafeWorkflowFailureError,
  workflowFailureDiagnosticRepoRoot,
  WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV,
  type WorkflowFailureCorrelation,
} from "../src/lib/automation/server/workflow-failure-diagnostics.ts";
import { pgliteWorkflowAdmissionReason, type PGliteWorkflowAdmissionReason } from "../src/ledger/pglite/workflow-client.ts";
import {
  refusalDiagnosticCode,
  workflowWriteAdmission,
  type WorkflowWriteAdmission,
  type WorkflowWriteAdmissionCheck,
} from "../src/lib/pglite-rpc/workflow-admission.ts";
import {
  isPGliteFinancialOperation,
  PGLITE_FINANCIAL_CONTRACTS,
  type PGliteFinancialCancelRequest,
  type PGliteFinancialErrorCode,
  type PGliteFinancialFailureCategory,
  type PGliteFinancialOperation,
  type PGliteFinancialResponse,
  type PGliteFinancialPort,
} from "../src/lib/pglite-rpc/pglite-financial-contracts.ts";
import { PGliteFinancialError, pgliteFinancialErrorMessage } from "../src/lib/pglite-rpc/pglite-financial-rpc-client.ts";
import { createWorkerCallServer, plainRecord, type WorkerCall, type WorkerPort } from "../src/lib/pglite-rpc/pglite-worker-call.ts";

export type PGliteFinancialRpcServer = Readonly<{ close(): Promise<void> }>;

function validCancelRequest(value: unknown): value is PGliteFinancialCancelRequest {
  return plainRecord(value)
    && value.kind === "pglite-financial-cancel"
    && value.version === 1
    && Number.isSafeInteger(value.id)
    && (value.id as number) >= 0;
}

function genericFailure(
  id: number,
  code: PGliteFinancialErrorCode,
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
    message: pgliteFinancialErrorMessage(code),
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

/**
 * Anything but `admitted` refuses a workflow's canonical write before it
 * reaches the database (ADR 0058). A throw is an ordinary failure, not a
 * refusal. A commit that names no run is refused without asking (ADR 0148).
 */
export type PGliteCanonicalCommitAdmission = WorkflowWriteAdmissionCheck;

/** A gated write the host refused; nothing was written. */
class RefusedWorkflowWrite extends PGliteFinancialError {
  readonly admission: Exclude<WorkflowWriteAdmission, "admitted">;
  constructor(admission: Exclude<WorkflowWriteAdmission, "admitted">) {
    super("operation-failed", "refused");
    this.admission = admission;
  }
}

export type PGliteFinancialRpcServerOptions = Readonly<{
  /** Gates every `workflow: "commit"` operation. Without it, commits are not gated. */
  isCommitAdmissible?: PGliteCanonicalCommitAdmission;
  /** The operations this connection serves; any other is refused as `not-allowed`. Defaults to all. */
  serves?: (operation: PGliteFinancialOperation) => boolean;
  scheduler?: PGliteWorkScheduler;
}>;

/**
 * Runs one PGlite operation at a time for a worker. Interactive work (a click
 * waiting on Pairing or its page action) starts before queued background work
 * such as page refreshes and live-view recomputes; a running operation is
 * never interrupted.
 */
export type PGliteWorkScheduler = Readonly<{
  schedule<T>(lane: "interactive" | "background", task: () => Promise<T>): Promise<T>;
  /**
   * Queues one step of a stepped operation on the background lane. Throws
   * when called from inside one of this scheduler's jobs: the step would
   * wait behind the very job that awaits it.
   */
  scheduleStep<T>(step: () => Promise<T>): Promise<T>;
}>;

export function createPGliteWorkScheduler(): PGliteWorkScheduler {
  const queued = { interactive: [] as Array<() => Promise<void>>, background: [] as Array<() => Promise<void>> };
  const insideJob = new AsyncLocalStorage<true>();
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
    queued[lane].push(() => insideJob.run(true, () => Promise.resolve().then(task)).then(resolve, reject));
    schedulePump();
  });
  const scheduleStep = <T>(step: () => Promise<T>): Promise<T> => {
    if (insideJob.getStore()) {
      return Promise.reject(new Error("A stepped operation cannot run inside a scheduled job: its first step would wait behind that job."));
    }
    return schedule("background", step);
  };
  return Object.freeze({ schedule, scheduleStep });
}

type CoalescedRead = {
  args: readonly unknown[];
  callers: number;
  controller: AbortController;
  outcome: Promise<unknown>;
};

/** Install the named financial registry on the same worker MessagePort. */
export function createPGliteFinancialRpcServer(
  port: WorkerPort,
  financial: PGliteFinancialPort,
  {
    isCommitAdmissible,
    serves = () => true,
    scheduler = createPGliteWorkScheduler(),
  }: PGliteFinancialRpcServerOptions = {},
): PGliteFinancialRpcServer {
  const controllers = new Map<number, AbortController>();
  const queuedReads = new Map<PGliteFinancialOperation, CoalescedRead>();
  /**
   * Attach a caller to the queued read of its kind, or queue one. The read
   * runs with the newest caller's arguments. A caller whose signal aborts
   * leaves at once with a cancellation; the read itself is aborted only when
   * no caller is left on it.
   */
  const joinLatestRead = (operation: PGliteFinancialOperation, args: readonly unknown[], signal: AbortSignal): Promise<unknown> => {
    let read = queuedReads.get(operation);
    if (read) read.args = args;
    else {
      const created: CoalescedRead = { args, callers: 0, controller: new AbortController(), outcome: Promise.resolve() };
      created.outcome = scheduler.schedule("background", async () => {
        if (queuedReads.get(operation) === created) queuedReads.delete(operation);
        if (created.controller.signal.aborted) throw new Error("PGlite financial operation was cancelled before execution.");
        return financial.request(operation, created.args as never, { signal: created.controller.signal });
      });
      server.track(created.outcome);
      queuedReads.set(operation, created);
      read = created;
    }
    const joined = read;
    joined.callers += 1;
    return new Promise((resolve, reject) => {
      const leave = () => {
        joined.callers -= 1;
        if (joined.callers === 0) {
          if (queuedReads.get(operation) === joined) queuedReads.delete(operation);
          joined.controller.abort();
        }
        reject(new Error("PGlite financial operation was cancelled."));
      };
      signal.addEventListener("abort", leave, { once: true });
      void joined.outcome
        .finally(() => signal.removeEventListener("abort", leave))
        .then(resolve, reject);
    });
  };
  const start = (call: WorkerCall): Promise<PGliteFinancialResponse> | undefined => {
    const { id, operation, args, diagnosticContext } = call;
    if (!isPGliteFinancialOperation(operation)) return undefined;
    if (!serves(operation)) {
      return (async () => {
        if (diagnosticContext) {
          await appendWorkflowFailureDiagnostic(process.env[WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV], {
            workflowId: diagnosticContext.workflowId,
            taskRunId: diagnosticContext.taskRunId,
            source: "financial-rpc",
            errorCode: "operation-not-allowed",
            operation,
          }, { repoRoot: workflowFailureDiagnosticRepoRoot() });
        }
        return genericFailure(id, "not-allowed");
      })();
    }
    const contract = PGLITE_FINANCIAL_CONTRACTS[operation];
    if (!contract.accepts(args)) return undefined;
    const controller = new AbortController();
    controllers.set(id, controller);
    const lane = contract.lane;
    const outcome = lane === "latest-wins"
      ? joinLatestRead(operation, args, controller.signal)
      // A stepped operation queues its own steps on the background lane; queuing it too would wait on itself.
      : lane === "background-steps"
      ? Promise.resolve().then(() => financial.request(operation, args as never, { signal: controller.signal }))
      : scheduler.schedule(lane, async () => {
        if (controller.signal.aborted) throw new Error("PGlite financial operation was cancelled before execution.");
        if (isCommitAdmissible && (contract.workflow === "commit" || contract.workflow === "resolve")) {
          const admission = workflowWriteAdmission(isCommitAdmissible, diagnosticContext);
          // A resolution derives rows only from evidence admitted earlier, so a changed scope does not stop it.
          if (admission !== "admitted" && (contract.workflow === "commit" || admission === "run-not-current")) {
            throw new RefusedWorkflowWrite(admission);
          }
        }
        return financial.request(operation, args as never, { signal: controller.signal });
      });
    return outcome.then(
      (result): PGliteFinancialResponse => ({ kind: "pglite-financial-response", version: 1, id, ok: true, value: result }),
      async (error) => {
        // The inner database worker has no workflow correlation. Capture before
        // wrapping there and let the correlated outer server write the record.
        const diagnosticError = !controller.signal.aborted
          && process.env[WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV]?.trim()
          ? captureSafeWorkflowFailureError(error, workflowFailureDiagnosticRepoRoot())
          : undefined;
        if (!controller.signal.aborted && diagnosticContext) {
          await appendWorkflowFailureDiagnostic(process.env[WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV], {
            workflowId: diagnosticContext.workflowId,
            taskRunId: diagnosticContext.taskRunId,
            source: "financial-rpc",
            errorCode: error instanceof RefusedWorkflowWrite ? refusalDiagnosticCode(error.admission) : "workflow-failed",
            // Relation resolution has no stage in the workflow stage vocabulary; its operation names it.
            ...(contract.workflow === "resolve" ? {} : {
              stage: operation === "financial.source.admit" ? "validation" as const : "commit" as const,
            }),
            operation,
            reason: failureReason(error),
            safeError: diagnosticError,
            error,
          }, { repoRoot: workflowFailureDiagnosticRepoRoot() });
        }
        return genericFailure(
          id,
          controller.signal.aborted ? "cancelled" : "operation-failed",
          controller.signal.aborted ? undefined : failureCategory(error),
          diagnosticError,
          controller.signal.aborted ? undefined : failureReason(error),
        );
      },
    ).finally(() => controllers.delete(id));
  };
  const server = createWorkerCallServer({
    port,
    request: { kind: "pglite-financial-request", version: 1 },
    refusal: (id, code) => genericFailure(id, code),
    start,
    other: (value) => {
      if (validCancelRequest(value)) controllers.get(value.id)?.abort();
    },
    closing: () => {
      for (const controller of controllers.values()) controller.abort();
    },
  });
  return { close: server.close };
}
