import { retainSafeWorkflowFailureError, type WorkflowFailureCorrelation } from "../automation/server/workflow-failure-diagnostics.ts";
import { pgliteWorkflowAdmissionReason, type PGliteWorkflowAdmissionReason } from "../../ledger/pglite/workflow-client.ts";
import type {
  PGliteFinancialCancelRequest,
  PGliteFinancialErrorCode,
  PGliteFinancialFailureCategory,
  PGliteFinancialOperation,
  PGliteFinancialPort,
  PGliteFinancialRequest,
  PGliteFinancialRequestOptions,
} from "./pglite-financial-contracts.ts";
import { createWorkerCallClient, type WorkerPort } from "./pglite-worker-call.ts";

export type PGliteFinancialRpcClient = PGliteFinancialPort & Readonly<{
  close(error?: Error): void;
}>;

export class PGliteFinancialError extends Error {
  readonly code: PGliteFinancialErrorCode;
  readonly category?: PGliteFinancialFailureCategory;
  readonly reason?: PGliteWorkflowAdmissionReason;
  constructor(
    code: PGliteFinancialErrorCode,
    category?: PGliteFinancialFailureCategory,
    reason?: PGliteWorkflowAdmissionReason,
  ) {
    super(pgliteFinancialErrorMessage(code));
    this.name = "PGliteFinancialError";
    this.code = code;
    this.category = category;
    if (reason) this.reason = reason;
  }
}

export function pgliteFinancialErrorMessage(code: PGliteFinancialErrorCode): string {
  switch (code) {
    case "invalid-request": return "Invalid PGlite financial request.";
    case "not-allowed": return "This connection does not serve that PGlite financial operation.";
    case "worker-closed": return "PGlite financial worker is closed.";
    case "cancelled": return "PGlite financial operation was cancelled.";
    case "operation-failed": return "PGlite financial operation failed.";
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
  port: WorkerPort,
  ready?: Promise<void>,
  diagnosticContext?: WorkflowFailureCorrelation,
): PGliteFinancialRpcClient {
  const client = createWorkerCallClient({
    port,
    ready,
    response: { kind: "pglite-financial-response", version: 1 },
    failure: (value) => {
      const code = value.code === "invalid-request" || value.code === "not-allowed" || value.code === "worker-closed" || value.code === "cancelled"
        ? value.code
        : "operation-failed";
      const error = new PGliteFinancialError(
        code,
        isFailureCategory(value.category) ? value.category : undefined,
        code === "operation-failed" ? pgliteWorkflowAdmissionReason(value.reason) : undefined,
      );
      if (code === "operation-failed") retainSafeWorkflowFailureError(error, value.diagnosticError);
      return error;
    },
    closed: () => new PGliteFinancialError("worker-closed"),
  });
  const request = ((operation: PGliteFinancialOperation, args: readonly unknown[], options: PGliteFinancialRequestOptions = {}) =>
    client.call(
      (id) => ({
        kind: "pglite-financial-request",
        version: 1,
        id,
        operation,
        args,
        ...(diagnosticContext ? { diagnosticContext } : {}),
      } satisfies PGliteFinancialRequest),
      options.signal && {
        signal: options.signal,
        cancelled: () => new PGliteFinancialError("cancelled"),
        frame: (id) => ({ kind: "pglite-financial-cancel", version: 1, id } satisfies PGliteFinancialCancelRequest),
      },
    )) as PGliteFinancialPort["request"];
  return { request, close: client.close };
}
