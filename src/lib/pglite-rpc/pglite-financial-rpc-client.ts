import { retainSafeWorkflowFailureError, type WorkflowFailureCorrelation } from "../automation/server/workflow-failure-diagnostics.ts";
import { pgliteWorkflowAdmissionReason, type PGliteWorkflowAdmissionReason } from "../../ledger/pglite/workflow-client.ts";
import type {
  PGliteFinancialCancelRequest,
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
  readonly code: "invalid-request" | "operation-failed" | "worker-closed" | "cancelled";
  readonly category?: PGliteFinancialFailureCategory;
  readonly reason?: PGliteWorkflowAdmissionReason;
  constructor(
    code: "invalid-request" | "operation-failed" | "worker-closed" | "cancelled",
    category?: PGliteFinancialFailureCategory,
    reason?: PGliteWorkflowAdmissionReason,
  ) {
    super(code === "invalid-request" ? "Invalid PGlite financial request." : code === "worker-closed" ? "PGlite financial worker is closed." : code === "cancelled" ? "PGlite financial operation was cancelled." : "PGlite financial operation failed.");
    this.name = "PGliteFinancialError";
    this.code = code;
    this.category = category;
    if (reason) this.reason = reason;
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
      const code = value.code === "invalid-request" || value.code === "worker-closed" || value.code === "cancelled"
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
