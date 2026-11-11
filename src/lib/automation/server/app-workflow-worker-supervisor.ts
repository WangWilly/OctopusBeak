import type { TypedWorkflowErrorCode } from "./typed-workflow-outcome.ts";
import type { WorkflowRunResult } from "../workflow-run-result.ts";
import {
  captureSafeWorkflowFailureError,
  workflowFailureDiagnosticRepoRoot,
  type SafeWorkflowFailureError,
} from "./workflow-failure-diagnostics.ts";
import {
  APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
  parseAppWorkflowWorkerInboundFrame,
  parseAppWorkflowWorkerOutboundFrame,
  parseAppWorkflowWorkerStart,
  type AppWorkflowWorkerStart,
} from "./app-workflow-worker-protocol.ts";
import type { AppWorkflowWorkerHandle } from "./execution-host.ts";
import { createHostCallDispatcher, HostCallRefusal, type HostCallHandlers } from "./app-workflow-host-calls.ts";
import type { PreviewResponseShapes } from "../../preview-sources/structure-report.ts";

export type AppWorkflowWorkerFailureCode = TypedWorkflowErrorCode | "worker-start-failed" | "protocol-invalid";

export type AppWorkflowWorkerOutcome =
  | Readonly<{ status: "completed"; errorCode: null; summary: WorkflowRunResult | null }>
  | Readonly<{ status: "cancelled"; errorCode: "cancelled"; summary: WorkflowRunResult | null }>
  | Readonly<{
    status: "failed";
    errorCode: AppWorkflowWorkerFailureCode;
    summary: WorkflowRunResult | null;
    failureKind: "worker-start" | "worker-crash" | "workflow" | "unexpected-exit" | "protocol";
    diagnostic?: SafeWorkflowFailureError;
    previewResponses?: PreviewResponseShapes;
  }>;

export type RunSupervisedAppWorkflowOptions = Readonly<{
  runId: string;
  workflowId: string;
  input: unknown;
  pgliteRpc?: AppWorkflowWorkerStart["pgliteRpc"];
  signal: AbortSignal;
  /** Force-quit: terminate the worker at once instead of waiting out the cancel grace. */
  forceSignal?: AbortSignal;
  /**
   * The host's answer to each host call this run may make (ADR 0072). An event
   * is answered only after its handler resolves, so after it is persisted.
   */
  hostCalls: HostCallHandlers;
  /** Starts this run's worker, as the execution host does. */
  launchWorker: (start: AppWorkflowWorkerStart) => AppWorkflowWorkerHandle;
  /** Bounds how long a cancelled or unhealthy worker may ignore its cancel frame. */
  cancelGraceMs?: number;
  /** Bounds worker cleanup after a valid terminal frame. */
  terminalGraceMs?: number;
}>;

function cancelled(summary: WorkflowRunResult | null = null): AppWorkflowWorkerOutcome {
  return { status: "cancelled", errorCode: "cancelled", summary };
}

const CANCELLED: AppWorkflowWorkerOutcome = cancelled();
const DEFAULT_CANCEL_GRACE_MS = 2_000;
const DEFAULT_TERMINAL_GRACE_MS = 1_000;

function failed(
  errorCode: AppWorkflowWorkerFailureCode,
  failureKind: Extract<AppWorkflowWorkerOutcome, { status: "failed" }>['failureKind'],
  diagnostic: SafeWorkflowFailureError | null = null,
  summary: WorkflowRunResult | null = null,
  previewResponses?: PreviewResponseShapes,
): AppWorkflowWorkerOutcome {
  return {
    status: "failed",
    errorCode,
    summary,
    failureKind,
    ...(diagnostic ? { diagnostic } : {}),
    ...(previewResponses ? { previewResponses } : {}),
  };
}

function uncertaintyCannotBeCancelled(outcome: AppWorkflowWorkerOutcome): boolean {
  return outcome.status === "failed" && outcome.errorCode === "commit-outcome-unknown";
}

/**
 * Own one typed workflow worker from Electron main. Events are acknowledged only
 * after their operational-database append finishes; raw worker errors and output
 * never cross this boundary.
 */
export async function runSupervisedAppWorkflow(
  options: RunSupervisedAppWorkflowOptions,
): Promise<AppWorkflowWorkerOutcome> {
  if (options.signal.aborted) return CANCELLED;
  const controller = new AbortController();
  const signal = controller.signal;

  let start: AppWorkflowWorkerStart;
  try {
    start = parseAppWorkflowWorkerStart({
      protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
      workflowId: options.workflowId,
      taskRunId: options.runId,
      input: options.input,
      ...(options.pgliteRpc ? { pgliteRpc: options.pgliteRpc } : {}),
    });
  } catch {
    return failed("protocol-invalid", "protocol");
  }

  let worker: AppWorkflowWorkerHandle;
  try {
    worker = options.launchWorker(start);
  } catch {
    return failed("worker-start-failed", "worker-start");
  }
  // The start contains credentials. Drop the supervisor's reference as soon as
  // the host has handed it to the worker.
  start = undefined as unknown as AppWorkflowWorkerStart;

  let settled = false;
  let workerOnline = false;
  let cancellationRequested = false;
  let exitCode: number | null = null;
  let pendingOutcome: AppWorkflowWorkerOutcome | null = null;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  let terminalTimer: ReturnType<typeof setTimeout> | undefined;

  return await new Promise<AppWorkflowWorkerOutcome>((resolve) => {
    const clearTimers = () => {
      if (cancelTimer) clearTimeout(cancelTimer);
      if (terminalTimer) clearTimeout(terminalTimer);
      cancelTimer = undefined;
      terminalTimer = undefined;
    };
    const cleanup = () => {
      clearTimers();
      hostCalls.close();
      options.signal.removeEventListener("abort", onAbort);
      options.forceSignal?.removeEventListener("abort", onForce);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      worker.off("online", onOnline);
      worker = undefined as unknown as AppWorkflowWorkerHandle;
    };
    const settle = (outcome: AppWorkflowWorkerOutcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    };
    const terminalOutcome = (outcome: AppWorkflowWorkerOutcome) => {
      if (settled || pendingOutcome) return;
      pendingOutcome = cancellationRequested && !uncertaintyCannotBeCancelled(outcome)
        ? cancelled(outcome.summary)
        : outcome;
      if (exitCode !== null) {
        settle(pendingOutcome);
        return;
      }
      terminalTimer = setTimeout(() => {
        const currentWorker = worker;
        if (!currentWorker) return;
        void Promise.resolve(currentWorker.terminate()).catch(() => undefined).finally(() => {
          settle(pendingOutcome ?? outcome);
        });
      }, Math.max(0, options.terminalGraceMs ?? DEFAULT_TERMINAL_GRACE_MS));
    };
    const requestStop = (
      outcome: AppWorkflowWorkerOutcome,
      cancelWorker: boolean,
    ) => {
      if (settled || pendingOutcome) return;
      pendingOutcome = cancellationRequested && !uncertaintyCannotBeCancelled(outcome)
        ? cancelled(outcome.summary)
        : outcome;
      if (!signal.aborted) controller.abort();
      if (cancelWorker) {
        try {
          worker.postMessage({ protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION, kind: "cancel" });
        } catch { /* termination timer remains authoritative */ }
      }
      cancelTimer = setTimeout(() => {
        const currentWorker = worker;
        if (!currentWorker) return;
        void Promise.resolve(currentWorker.terminate()).catch(() => undefined).finally(() => {
          settle(pendingOutcome ?? outcome);
        });
      }, Math.max(0, options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS));
    };
    const protocolFailure = () => requestStop(failed("protocol-invalid", "protocol"), true);
    const appendEvent = options.hostCalls.event;
    const hostCalls = createHostCallDispatcher({
      handlers: {
        ...options.hostCalls,
        ...(appendEvent ? {
          event: (request, eventSignal) => {
            if (request.event.runId !== options.runId) throw new HostCallRefusal();
            return appendEvent(request, eventSignal);
          },
        } : {}),
      },
      signal,
      stopping: () => signal.aborted || pendingOutcome !== null,
      settled: () => settled,
      post: (frame) => worker.postMessage(parseAppWorkflowWorkerInboundFrame(frame)),
      protocolFailure: () => protocolFailure(),
    });
    const onMessage = (value: unknown) => {
      if (settled) return;
      let frame: ReturnType<typeof parseAppWorkflowWorkerOutboundFrame>;
      try {
        frame = parseAppWorkflowWorkerOutboundFrame(value);
      } catch {
        protocolFailure();
        return;
      }
      if (frame.kind === "call") {
        hostCalls.receive(frame);
        return;
      }
      if (pendingOutcome) {
        if (pendingOutcome.status === "cancelled"
          && (frame.kind === "failed" || frame.kind === "cancelled")
          && frame.taskRunId === options.runId) {
          if (frame.kind === "failed" && frame.errorCode === "commit-outcome-unknown") {
            pendingOutcome = failed(
              "commit-outcome-unknown",
              "workflow",
              frame.diagnostic ?? null,
              frame.summary ?? null,
            );
            if (exitCode !== null) settle(pendingOutcome);
          } else if (frame.kind === "cancelled" && frame.summary) {
            pendingOutcome = cancelled(frame.summary);
            if (exitCode !== null) settle(pendingOutcome);
          }
        }
        return;
      }

      if (!hostCalls.idle()) {
        protocolFailure();
        return;
      }
      if (frame.kind === "completed") {
        if (frame.taskRunId !== options.runId) return protocolFailure();
        terminalOutcome({ status: "completed", errorCode: null, summary: frame.summary });
      } else if (frame.kind === "cancelled") {
        if (frame.taskRunId !== options.runId) return protocolFailure();
        terminalOutcome(frame.summary
          ? { status: "cancelled", errorCode: "cancelled", summary: frame.summary }
          : CANCELLED);
      } else if (frame.taskRunId !== options.runId) {
        protocolFailure();
      } else {
        terminalOutcome(failed(
          frame.errorCode as AppWorkflowWorkerFailureCode,
          "workflow",
          frame.diagnostic ?? null,
          frame.summary ?? null,
          frame.previewResponses,
        ));
      }
    };
    const onOnline = () => { workerOnline = true; };
    const onError = (error: unknown) => {
      requestStop(
        workerOnline
          ? failed("workflow-failed", "worker-crash", captureSafeWorkflowFailureError(error, workflowFailureDiagnosticRepoRoot()))
          : failed("worker-start-failed", "worker-start", captureSafeWorkflowFailureError(error, workflowFailureDiagnosticRepoRoot())),
        true,
      );
    };
    const onExit = (code: number) => {
      exitCode = code;
      if (cancelTimer) clearTimeout(cancelTimer);
      cancelTimer = undefined;
      if (pendingOutcome) {
        settle(cancellationRequested && !uncertaintyCannotBeCancelled(pendingOutcome)
          ? cancelled(pendingOutcome.summary)
          : pendingOutcome);
      } else if (cancellationRequested || options.signal.aborted) {
        settle(CANCELLED);
      } else {
        settle(workerOnline
          ? failed("workflow-failed", "unexpected-exit")
          : failed("worker-start-failed", "worker-start"));
      }
    };
    const onAbort = () => {
      if (pendingOutcome || settled) return;
      cancellationRequested = true;
      if (!signal.aborted) controller.abort();
      requestStop(CANCELLED, true);
    };
    const onForce = () => {
      if (settled) return;
      if (!pendingOutcome) {
        cancellationRequested = true;
        pendingOutcome = CANCELLED;
        if (!signal.aborted) controller.abort();
      }
      clearTimers();
      const currentWorker = worker;
      void Promise.resolve(currentWorker.terminate()).catch(() => undefined).finally(() => {
        settle(pendingOutcome ?? CANCELLED);
      });
    };

    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    worker.on("online", onOnline);
    options.signal.addEventListener("abort", onAbort, { once: true });
    options.forceSignal?.addEventListener("abort", onForce, { once: true });
    if (options.signal.aborted) onAbort();
    if (options.forceSignal?.aborted) onForce();
  });
}
