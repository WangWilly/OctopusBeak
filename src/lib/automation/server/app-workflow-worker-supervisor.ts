import { join } from "node:path";
import { Worker, type WorkerOptions } from "node:worker_threads";
import type { HumanAssistanceCompletionStatus, HumanAssistanceContractInput } from "../human-assistance.ts";
import type { CathayGmailOtpPort } from "../../../workflows/cathay-statements.ts";
import type { WorkflowRunEvent } from "../workflow-executor.ts";
import type { TypedWorkflowOutcomeSummary, TypedWorkflowErrorCode } from "./typed-workflow-outcome.ts";
import { gmailOtpFallbackReason, type GmailOtpFallbackReason } from "../gmail-otp.ts";
import { createCathayGmailOtpPort } from "./cathay-otp-port.ts";
import {
  APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
  parseAppWorkflowWorkerInboundFrame,
  parseAppWorkflowWorkerOutboundFrame,
  parseAppWorkflowWorkerStart,
  type AppWorkflowWorkerInboundFrame,
  type AppWorkflowWorkerStart,
  type CathayGmailOtpOperation,
  type CathayGmailOtpRequestFrame,
  type CathayGmailOtpResponseFrame,
} from "./app-workflow-worker-protocol.ts";

export type AppWorkflowWorkerFailureCode = TypedWorkflowErrorCode | "worker-start-failed" | "protocol-invalid";

export type AppWorkflowWorkerOutcome =
  | Readonly<{ status: "completed"; errorCode: null; summary: TypedWorkflowOutcomeSummary | null }>
  | Readonly<{ status: "cancelled"; errorCode: "cancelled"; summary: null }>
  | Readonly<{
    status: "failed";
    errorCode: AppWorkflowWorkerFailureCode;
    summary: null;
    failureKind: "worker-start" | "worker-crash" | "workflow" | "unexpected-exit" | "protocol";
  }>;

type WorkerDataStream = {
  on(event: "data", listener: (chunk: unknown) => void): unknown;
  off(event: "data", listener: (chunk: unknown) => void): unknown;
  resume(): unknown;
};

/** The small part of Worker used here also gives focused tests a local fake seam. */
export interface AppWorkflowWorkerHandle {
  on(event: "online", listener: () => void): this;
  on(event: "message", listener: (value: unknown) => void): this;
  on(event: "error", listener: (error: unknown) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  off(event: "online", listener: () => void): this;
  off(event: "message", listener: (value: unknown) => void): this;
  off(event: "error", listener: (error: unknown) => void): this;
  off(event: "exit", listener: (code: number) => void): this;
  postMessage(value: AppWorkflowWorkerInboundFrame): void;
  terminate(): Promise<number> | number;
  readonly stdout?: WorkerDataStream | null;
  readonly stderr?: WorkerDataStream | null;
}

export type RunSupervisedAppWorkflowOptions = Readonly<{
  runId: string;
  workflowId: string;
  input: unknown;
  browserConnection: AppWorkflowWorkerStart["browserConnection"];
  pgliteRpc?: AppWorkflowWorkerStart["pgliteRpc"];
  signal: AbortSignal;
  appendEvent(event: WorkflowRunEvent, signal: AbortSignal): Promise<void>;
  requestHumanAssistance(
    contract: HumanAssistanceContractInput,
    signal: AbortSignal,
  ): Promise<Exclude<HumanAssistanceCompletionStatus, "pending">>;
  /** Test seam; production creates one host OTP adapter per Cathay run. */
  createCathayGmailOtpPort?: (signal: AbortSignal) => CathayGmailOtpPort;
  /** Defaults to the sibling bundle emitted by the Electron build. */
  workerPath?: string;
  /** Test seam; production always uses node:worker_threads. */
  workerFactory?: (path: string, options: WorkerOptions) => AppWorkflowWorkerHandle;
  /** Bounds how long a cancelled or unhealthy worker may ignore its cancel frame. */
  cancelGraceMs?: number;
  /** Bounds worker cleanup after a valid terminal frame. */
  terminalGraceMs?: number;
}>;

const CANCELLED: AppWorkflowWorkerOutcome = { status: "cancelled", errorCode: "cancelled", summary: null };
const MAX_EVENTS_PER_RUN = 512;
const DEFAULT_CANCEL_GRACE_MS = 2_000;
const DEFAULT_TERMINAL_GRACE_MS = 1_000;
const MAX_CATHAY_OTP_OPERATIONS_PER_RUN = 128;
const CATHAY_OTP_BOUNDARY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CATHAY_OTP_PATTERN = /^[A-Z]{4}-[0-9]{6}$/u;

function failed(
  errorCode: AppWorkflowWorkerFailureCode,
  failureKind: Extract<AppWorkflowWorkerOutcome, { status: "failed" }>['failureKind'],
): AppWorkflowWorkerOutcome {
  return { status: "failed", errorCode, summary: null, failureKind };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("cancelled"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      () => {
        signal.removeEventListener("abort", onAbort);
        reject(new Error("operation-failed"));
      },
    );
  });
}

function defaultWorkerFactory(path: string, options: WorkerOptions): AppWorkflowWorkerHandle {
  return new Worker(path, options);
}

function fallbackOtpResponse(
  request: CathayGmailOtpRequestFrame,
  reason: GmailOtpFallbackReason,
): CathayGmailOtpResponseFrame {
  return {
    protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
    kind: "cathay-gmail-otp-response",
    requestId: request.requestId,
    operation: request.operation,
    status: "fallback",
    reason,
  };
}

function resultOtpResponse(
  request: CathayGmailOtpRequestFrame,
  result: unknown,
): CathayGmailOtpResponseFrame {
  const record = result && typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, unknown>
    : null;
  const fallbackReason = gmailOtpFallbackReason(result);
  if (fallbackReason) return fallbackOtpResponse(request, fallbackReason);

  if (request.operation === "ensure-access") {
    return record?.status === "ready"
      ? {
        protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
        kind: "cathay-gmail-otp-response",
        requestId: request.requestId,
        operation: request.operation,
        status: "ready",
      }
      : fallbackOtpResponse(request, "protocol-error");
  }
  if (request.operation === "prepare-retrieval") {
    if (record?.status === "prepared" && typeof record.boundaryId === "string" && CATHAY_OTP_BOUNDARY_UUID.test(record.boundaryId)) {
      return {
        protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
        kind: "cathay-gmail-otp-response",
        requestId: request.requestId,
        operation: request.operation,
        status: "prepared",
        boundaryId: record.boundaryId,
      };
    }
    return fallbackOtpResponse(request, "protocol-error");
  }
  if (record?.status === "found" && typeof record.otp === "string" && CATHAY_OTP_PATTERN.test(record.otp)) {
    return {
      protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
      kind: "cathay-gmail-otp-response",
      requestId: request.requestId,
      operation: request.operation,
      status: "found",
      otp: record.otp,
    };
  }
  return fallbackOtpResponse(request, record?.status === "found" ? "malformed-candidate" : "protocol-error");
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
      browserConnection: options.browserConnection,
      ...(options.pgliteRpc ? { pgliteRpc: options.pgliteRpc } : {}),
    });
  } catch {
    return failed("protocol-invalid", "protocol");
  }

  const factory = options.workerFactory ?? defaultWorkerFactory;
  const workerPath = options.workerPath
    ?? (typeof __dirname === "string"
      ? join(__dirname, "app-workflow-worker.cjs")
      : join(process.cwd(), "build-electron", "app-workflow-worker.cjs"));
  let worker: AppWorkflowWorkerHandle;
  try {
    worker = factory(
      workerPath,
      { workerData: start, stdout: true, stderr: true },
    );
  } catch {
    return failed("worker-start-failed", "worker-start");
  }
  let cathayGmailOtpPort: CathayGmailOtpPort | undefined;
  try {
    if (options.workflowId === "cathay-all-statements") {
      const createPort = options.createCathayGmailOtpPort
        ?? ((runSignal: AbortSignal) => createCathayGmailOtpPort(undefined, { signal: runSignal }));
      cathayGmailOtpPort = createPort(signal);
    }
  } catch {
    void Promise.resolve(worker.terminate()).catch(() => undefined);
    return failed("worker-start-failed", "worker-start");
  }
  // workerData contains credentials. Drop the supervisor's reference as soon as
  // worker_threads has received its structured clone.
  start = undefined as unknown as AppWorkflowWorkerStart;

  let settled = false;
  let workerOnline = false;
  let cancellationRequested = false;
  let exitCode: number | null = null;
  let pendingOutcome: AppWorkflowWorkerOutcome | null = null;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  let terminalTimer: ReturnType<typeof setTimeout> | undefined;
  let eventInFlight = false;
  let assistanceInFlight = false;
  let cathayOtpInFlight = false;
  let cathayOtpRequestCount = 0;
  let eventCount = 0;
  const eventIds = new Set<string>();
  const assistanceIds = new Set<string>();
  const cathayOtpRequestIds = new Set<string>();
  const cathayOtpBoundaryIds = new Set<string>();
  const cathayOtpConsumedBoundaryIds = new Set<string>();
  const streamDrains: Array<{ stream: WorkerDataStream; listener: (chunk: unknown) => void }> = [];
  let appendEvent = options.appendEvent;
  let requestHumanAssistance = options.requestHumanAssistance;

  return await new Promise<AppWorkflowWorkerOutcome>((resolve) => {
    const clearTimers = () => {
      if (cancelTimer) clearTimeout(cancelTimer);
      if (terminalTimer) clearTimeout(terminalTimer);
      cancelTimer = undefined;
      terminalTimer = undefined;
    };
    const cleanup = () => {
      clearTimers();
      options.signal.removeEventListener("abort", onAbort);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      worker.off("online", onOnline);
      for (const { stream, listener } of streamDrains) stream.off("data", listener);
      streamDrains.length = 0;
      appendEvent = undefined as unknown as typeof appendEvent;
      requestHumanAssistance = undefined as unknown as typeof requestHumanAssistance;
      cathayGmailOtpPort = undefined;
      cathayOtpRequestIds.clear();
      cathayOtpBoundaryIds.clear();
      cathayOtpConsumedBoundaryIds.clear();
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
      pendingOutcome = cancellationRequested ? CANCELLED : outcome;
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
      pendingOutcome = cancellationRequested ? CANCELLED : outcome;
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
    const send = (frame: AppWorkflowWorkerInboundFrame): boolean => {
      if (settled || pendingOutcome) return false;
      try {
        worker.postMessage(parseAppWorkflowWorkerInboundFrame(frame));
        return true;
      } catch {
        protocolFailure();
        return false;
      }
    };
    const finishEvent = async (eventId: string, event: WorkflowRunEvent) => {
      let ok = false;
      try {
        await abortable(Promise.resolve().then(() => appendEvent(event, signal)), signal);
        ok = true;
      } catch {
        ok = false;
      }
      eventInFlight = false;
      if (settled || pendingOutcome || signal.aborted) return;
      send({
        protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
        kind: "event-ack",
        eventId,
        ok,
        ...(!ok ? { code: "event-persistence-failed" as const } : {}),
      });
    };
    const finishAssistance = async (requestId: string, contract: HumanAssistanceContractInput) => {
      let status: Exclude<HumanAssistanceCompletionStatus, "pending"> = "failed";
      try {
        status = await abortable(Promise.resolve().then(() => requestHumanAssistance(contract, signal)), signal);
      } catch {
        status = "failed";
      }
      assistanceInFlight = false;
      if (settled || pendingOutcome || signal.aborted) return;
      send({
        protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
        kind: "human-assistance-response",
        requestId,
        status,
      });
    };
    const finishCathayOtp = async (request: CathayGmailOtpRequestFrame) => {
      let response: CathayGmailOtpResponseFrame;
      try {
        if (signal.aborted) {
          cathayOtpInFlight = false;
          return;
        }
        const port = cathayGmailOtpPort;
        if (!port) throw new Error("otp-port-unavailable");
        const invoke = <T>(callback: () => Promise<T>) => Promise.resolve().then(() => {
          if (signal.aborted) throw new Error("cancelled");
          return callback();
        });
        let operation: Promise<unknown>;
        switch (request.operation) {
          case "ensure-access":
            operation = invoke(() => port.ensureAccess());
            break;
          case "prepare-retrieval":
            operation = invoke(() => port.prepareRetrieval());
            break;
          case "retrieve":
            operation = invoke(() => port.retrieve(request.boundaryId));
            break;
        }
        const result = await abortable(operation, signal);
        response = resultOtpResponse(request, result);
      } catch {
        if (signal.aborted) {
          cathayOtpInFlight = false;
          return;
        }
        response = fallbackOtpResponse(request, "gmail-request-failed");
      }
      cathayOtpInFlight = false;
      if (settled || pendingOutcome || signal.aborted) return;
      if (response.status === "prepared") {
        if (cathayOtpBoundaryIds.has(response.boundaryId) || cathayOtpBoundaryIds.size >= MAX_CATHAY_OTP_OPERATIONS_PER_RUN) {
          protocolFailure();
          return;
        }
        cathayOtpBoundaryIds.add(response.boundaryId);
      }
      send(response);
    };
    const onMessage = (value: unknown) => {
      if (settled || pendingOutcome) return;
      let frame: ReturnType<typeof parseAppWorkflowWorkerOutboundFrame>;
      try {
        frame = parseAppWorkflowWorkerOutboundFrame(value);
      } catch {
        protocolFailure();
        return;
      }

      if (frame.kind === "event") {
        if (
          eventInFlight
          || eventCount >= MAX_EVENTS_PER_RUN
          || eventIds.has(frame.eventId)
          || frame.event.runId !== options.runId
        ) {
          protocolFailure();
          return;
        }
        eventCount += 1;
        eventIds.add(frame.eventId);
        eventInFlight = true;
        void finishEvent(frame.eventId, frame.event);
        return;
      }
      if (frame.kind === "human-assistance-request") {
        if (assistanceInFlight || assistanceIds.has(frame.requestId)) {
          protocolFailure();
          return;
        }
        assistanceIds.add(frame.requestId);
        assistanceInFlight = true;
        void finishAssistance(frame.requestId, frame.contract);
        return;
      }
      if (frame.kind === "cathay-gmail-otp-request") {
        if (
          options.workflowId !== "cathay-all-statements"
          || cathayOtpInFlight
          || cathayOtpRequestCount >= MAX_CATHAY_OTP_OPERATIONS_PER_RUN
          || cathayOtpRequestIds.has(frame.requestId)
          || !cathayGmailOtpPort
        ) {
          protocolFailure();
          return;
        }
        if (frame.operation === "retrieve") {
          if (!cathayOtpBoundaryIds.has(frame.boundaryId) || cathayOtpConsumedBoundaryIds.has(frame.boundaryId)) {
            protocolFailure();
            return;
          }
          // Consume before awaiting Gmail so cancellation or failure cannot replay it.
          cathayOtpConsumedBoundaryIds.add(frame.boundaryId);
        }
        cathayOtpRequestCount += 1;
        cathayOtpRequestIds.add(frame.requestId);
        cathayOtpInFlight = true;
        void finishCathayOtp(frame);
        return;
      }

      if (eventInFlight || assistanceInFlight || cathayOtpInFlight) {
        protocolFailure();
        return;
      }
      if (frame.kind === "completed") {
        if (frame.taskRunId !== options.runId) return protocolFailure();
        terminalOutcome({ status: "completed", errorCode: null, summary: frame.summary });
      } else if (frame.kind === "cancelled") {
        if (frame.taskRunId !== options.runId) return protocolFailure();
        terminalOutcome(CANCELLED);
      } else if (frame.taskRunId !== options.runId) {
        protocolFailure();
      } else {
        terminalOutcome(failed(frame.errorCode as AppWorkflowWorkerFailureCode, "workflow"));
      }
    };
    const onOnline = () => { workerOnline = true; };
    const onError = (_error: unknown) => {
      requestStop(
        workerOnline
          ? failed("workflow-failed", "worker-crash")
          : failed("worker-start-failed", "worker-start"),
        true,
      );
    };
    const onExit = (code: number) => {
      exitCode = code;
      if (cancelTimer) clearTimeout(cancelTimer);
      cancelTimer = undefined;
      if (pendingOutcome) {
        settle(cancellationRequested ? CANCELLED : pendingOutcome);
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

    // Captured output is drained and discarded. It is never sent to a log.
    for (const stream of [worker.stdout, worker.stderr]) {
      if (!stream) continue;
      const discard = (_chunk: unknown) => undefined;
      streamDrains.push({ stream, listener: discard });
      stream.on("data", discard);
      stream.resume();
    }
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    worker.on("online", onOnline);
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) onAbort();
  });
}
