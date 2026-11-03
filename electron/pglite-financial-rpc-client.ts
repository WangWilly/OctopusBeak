import { retainSafeWorkflowFailureError, type WorkflowFailureCorrelation } from "../src/lib/automation/server/workflow-failure-diagnostics.ts";
import { pgliteWorkflowAdmissionReason, type PGliteWorkflowAdmissionReason } from "../src/ledger/pglite/workflow-client.ts";
import type {
  PGliteFinancialCancelRequest,
  PGliteFinancialFailureCategory,
  PGliteFinancialOperation,
  PGliteFinancialPort,
  PGliteFinancialRequest,
  PGliteFinancialRequestOptions,
  PGliteFinancialRpcPort,
} from "./pglite-financial-contracts.ts";

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
      const error = new PGliteFinancialError(
        code,
        isFailureCategory(value.category) ? value.category : undefined,
        code === "operation-failed" ? pgliteWorkflowAdmissionReason(value.reason) : undefined,
      );
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
