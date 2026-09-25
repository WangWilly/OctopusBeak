import { randomUUID } from "node:crypto";
import type { MessagePort } from "node:worker_threads";
import type {
  WorkflowBrowserPort,
  WorkflowDefinition,
  WorkflowExecutorPorts,
  WorkflowFinancialCommitPort,
  WorkflowRunEvent,
} from "../workflow-executor.ts";
import type { CathayGmailOtpPort } from "../../../workflows/cathay-statements.ts";
import { createWorkflowExecutor } from "../workflow-executor.ts";
import { strictSourceText } from "../source-text.ts";
import { createWorkflowFinancialCommitPort } from "../workflow-financial-commit.ts";
import {
  classifyTypedWorkflowFailure,
  summarizeTypedWorkflowOutput,
} from "./typed-workflow-outcome.ts";
import {
  AppWorkflowWorkerProtocolError,
  APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
  parseAppWorkflowWorkerInboundFrame,
  parseAppWorkflowWorkerOutboundFrame,
  parseAppWorkflowWorkerStart,
  type AppWorkflowWorkerInboundFrame,
  type AppWorkflowWorkerOutboundFrame,
  type AppWorkflowWorkerStart,
  type CathayGmailOtpOperation,
  type CathayGmailOtpRequestFrame,
  type CathayGmailOtpResponseFrame,
} from "./app-workflow-worker-protocol.ts";
import {
  workflowDefinitionForTask,
  type AppWorkflowRegistryDependencies,
} from "./app-workflow-registry.ts";
import { withAppWorkflowBrowserPage } from "./app-browser-host.ts";
import { createPGliteChildRpcClient } from "../../../../electron/pglite-child-rpc-client.ts";

const abortError = () => new Error("App workflow worker cancelled.");

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export type AppWorkflowWorkerRuntimeOptions = Readonly<{
  port: MessagePort;
  workerData: unknown;
  /** Test seam; production resolves from the App's typed workflow catalog. */
  resolveDefinition?: (
    workflowId: string,
    dependencies?: AppWorkflowRegistryDependencies,
  ) => WorkflowDefinition | null;
  /** Test seam; production attaches to the run-scoped App browser page. */
  browser?: WorkflowBrowserPort;
  /** Test seam; production creates this port from the authenticated PGlite RPC. */
  financialCommit?: WorkflowFinancialCommitPort;
  now?: WorkflowExecutorPorts["now"];
}>;

function throwOnProtocolFailure() {
  return new AppWorkflowWorkerProtocolError();
}

function appBrowserPort(start: AppWorkflowWorkerStart): WorkflowBrowserPort {
  return {
    async withPage(run) {
      return await withAppWorkflowBrowserPage(start.browserConnection, run);
    },
  };
}

/** Execute one typed definition inside the App-managed Node worker. */
export async function runAppWorkflowWorker(
  options: AppWorkflowWorkerRuntimeOptions,
): Promise<void> {
  let start: AppWorkflowWorkerStart;
  try {
    start = parseAppWorkflowWorkerStart(options.workerData);
  } catch {
    const failed: AppWorkflowWorkerOutboundFrame = {
      protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
      kind: "failed",
      taskRunId: null,
      errorCode: "protocol-invalid",
    };
    try { options.port.postMessage(parseAppWorkflowWorkerOutboundFrame(failed)); } catch { /* no raw transport error */ }
    return;
  }

  const controller = new AbortController();
  const pendingEvents = new Map<string, (frame: AppWorkflowWorkerInboundFrame) => void>();
  const pendingAssistance = new Map<string, (frame: AppWorkflowWorkerInboundFrame) => void>();
  const pendingCathayOtp = new Map<string, Readonly<{
    operation: CathayGmailOtpOperation;
    resolve(frame: AppWorkflowWorkerInboundFrame): void;
    reject(error: Error): void;
  }>>();
  const events: WorkflowRunEvent[] = [];
  let protocolFailure = false;
  let terminal = false;

  const send = (frame: AppWorkflowWorkerOutboundFrame) => {
    const validated = parseAppWorkflowWorkerOutboundFrame(frame);
    options.port.postMessage(validated);
  };
  const failPending = () => {
    pendingEvents.clear();
    pendingAssistance.clear();
    pendingCathayOtp.clear();
  };
  const onAbort = () => failPending();
  controller.signal.addEventListener("abort", onAbort, { once: true });

  const onMessage = (value: unknown) => {
    if (terminal) return;
    let frame: AppWorkflowWorkerInboundFrame;
    try {
      frame = parseAppWorkflowWorkerInboundFrame(value);
    } catch {
      protocolFailure = true;
      if (!controller.signal.aborted) controller.abort(throwOnProtocolFailure());
      return;
    }
    if (frame.kind === "cancel") {
      if (!controller.signal.aborted) controller.abort(abortError());
      return;
    }
    if (frame.kind === "event-ack") {
      const resolve = pendingEvents.get(frame.eventId);
      if (!resolve) {
        protocolFailure = true;
        if (!controller.signal.aborted) controller.abort(throwOnProtocolFailure());
        return;
      }
      pendingEvents.delete(frame.eventId);
      resolve(frame);
      return;
    }
    if (frame.kind === "cathay-gmail-otp-response") {
      const pending = pendingCathayOtp.get(frame.requestId);
      if (!pending || pending.operation !== frame.operation) {
        protocolFailure = true;
        if (!controller.signal.aborted) controller.abort(throwOnProtocolFailure());
        return;
      }
      pendingCathayOtp.delete(frame.requestId);
      pending.resolve(frame);
      return;
    }
    const resolve = pendingAssistance.get(frame.requestId);
    if (!resolve) {
      protocolFailure = true;
      if (!controller.signal.aborted) controller.abort(throwOnProtocolFailure());
      return;
    }
    pendingAssistance.delete(frame.requestId);
    resolve(frame);
  };

  options.port.on("message", onMessage);

  const request = <T extends Extract<AppWorkflowWorkerInboundFrame, { kind: "event-ack" | "human-assistance-response" }>>(
    frame: Extract<AppWorkflowWorkerOutboundFrame, { kind: "event" | "human-assistance-request" }>,
    pending: Map<string, (response: AppWorkflowWorkerInboundFrame) => void>,
    id: string,
  ): Promise<T> => new Promise<T>((resolve, reject) => {
    if (controller.signal.aborted) {
      reject(abortError());
      return;
    }
    if (pending.size >= 32) {
      reject(new AppWorkflowWorkerProtocolError());
      return;
    }
    const onAbortRequest = () => {
      pending.delete(id);
      reject(abortError());
    };
    controller.signal.addEventListener("abort", onAbortRequest, { once: true });
    pending.set(id, (value) => {
      controller.signal.removeEventListener("abort", onAbortRequest);
      resolve(value as T);
    });
    try {
      send(frame);
    } catch {
      controller.signal.removeEventListener("abort", onAbortRequest);
      pending.delete(id);
      reject(new AppWorkflowWorkerProtocolError());
    }
  });

  const requestCathayOtp = (
    operation: CathayGmailOtpOperation,
    boundaryId?: string,
  ): Promise<CathayGmailOtpResponseFrame> => new Promise((resolve, reject) => {
    if (controller.signal.aborted) {
      reject(abortError());
      return;
    }
    if (start.workflowId !== "cathay-all-statements" || pendingCathayOtp.size >= 8) {
      reject(new AppWorkflowWorkerProtocolError());
      return;
    }
    const requestId = randomUUID();
    const frame: CathayGmailOtpRequestFrame = operation === "retrieve"
      ? {
        protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
        kind: "cathay-gmail-otp-request",
        requestId,
        operation,
        boundaryId: boundaryId ?? "",
      }
      : {
        protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
        kind: "cathay-gmail-otp-request",
        requestId,
        operation,
      };
    const onAbortRequest = () => {
      pendingCathayOtp.delete(requestId);
      reject(abortError());
    };
    controller.signal.addEventListener("abort", onAbortRequest, { once: true });
    pendingCathayOtp.set(requestId, {
      operation,
      resolve: (value) => {
        controller.signal.removeEventListener("abort", onAbortRequest);
        resolve(value as CathayGmailOtpResponseFrame);
      },
      reject: (error) => {
        controller.signal.removeEventListener("abort", onAbortRequest);
        reject(error);
      },
    });
    try {
      send(frame);
    } catch {
      controller.signal.removeEventListener("abort", onAbortRequest);
      pendingCathayOtp.delete(requestId);
      reject(new AppWorkflowWorkerProtocolError());
    }
  });

  const cathayGmailOtpPort: CathayGmailOtpPort = {
    async ensureAccess() {
      const response = await requestCathayOtp("ensure-access");
      if (response.operation !== "ensure-access") throw new AppWorkflowWorkerProtocolError();
      if (response.status === "fallback") return { status: "fallback", reason: response.reason };
      if (response.status !== "ready") throw new AppWorkflowWorkerProtocolError();
      return { status: "ready" };
    },
    async prepareRetrieval() {
      const response = await requestCathayOtp("prepare-retrieval");
      if (response.operation !== "prepare-retrieval") throw new AppWorkflowWorkerProtocolError();
      if (response.status === "fallback") return { status: "fallback", reason: response.reason };
      if (response.status !== "prepared") throw new AppWorkflowWorkerProtocolError();
      return { status: "prepared", boundaryId: response.boundaryId };
    },
    async retrieve(boundaryId) {
      const response = await requestCathayOtp("retrieve", boundaryId);
      if (response.operation !== "retrieve") throw new AppWorkflowWorkerProtocolError();
      if (response.status === "fallback") return { status: "fallback", reason: response.reason };
      if (response.status !== "found") throw new AppWorkflowWorkerProtocolError();
      return { status: "found", otp: response.otp };
    },
  };

  let childRpc: ReturnType<typeof createPGliteChildRpcClient> | undefined;
  try {
    const definitionDependencies: AppWorkflowRegistryDependencies = start.workflowId === "cathay-all-statements"
      ? { cathayGmailOtpPort }
      : {};
    const definition = (options.resolveDefinition ?? workflowDefinitionForTask)(start.workflowId, definitionDependencies);
    if (!definition || definition.id !== start.workflowId) throw new Error("worker-start-failed");
    if (definition.requiresMaicoinPersistence) throw new Error("worker-start-failed");

    let financialCommit = options.financialCommit;
    if (definition.requiresFinancialCommit && !financialCommit) {
      if (!start.pgliteRpc) throw new Error("worker-start-failed");
      childRpc = createPGliteChildRpcClient({
        endpoint: start.pgliteRpc.endpoint,
        token: start.pgliteRpc.token,
      });
      await abortable(childRpc.ready, controller.signal);
      financialCommit = createWorkflowFinancialCommitPort(childRpc.workflow);
    }

    const eventsPort: WorkflowExecutorPorts["events"] = {
      async append(event) {
        if (events.length >= 512) events.shift();
        events.push(event);
        const eventId = randomUUID();
        const ack = await request(
          {
            protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
            kind: "event",
            eventId,
            event,
          },
          pendingEvents,
          eventId,
        );
        if (ack.kind !== "event-ack" || !ack.ok) throw new Error("event-persistence-failed");
      },
    };
    const humanAssistance: WorkflowExecutorPorts["humanAssistance"] = {
      async request(contract, signal) {
        signal.throwIfAborted();
        const requestId = randomUUID();
        const response = await request(
          {
            protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
            kind: "human-assistance-request",
            requestId,
            contract,
          },
          pendingAssistance,
          requestId,
        );
        signal.throwIfAborted();
        if (response.kind !== "human-assistance-response") throw new AppWorkflowWorkerProtocolError();
        return response.status;
      },
    };
    const browser = options.browser ?? appBrowserPort(start);
    const ports: WorkflowExecutorPorts = {
      browser,
      text: strictSourceText,
      humanAssistance,
      ...(financialCommit ? { financialCommit } : {}),
      events: eventsPort,
      now: options.now ?? (() => new Date().toISOString()),
      onEventFailure: () => undefined,
    };

    const output = await createWorkflowExecutor([definition], ports).run(
      start.workflowId,
      start.taskRunId,
      start.input,
      controller.signal,
    );
    terminal = true;
    try {
      send({
        protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
        kind: "completed",
        taskRunId: start.taskRunId,
        summary: summarizeTypedWorkflowOutput(output),
      });
    } catch {
      try {
        send({
          protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
          kind: "failed",
          taskRunId: start.taskRunId,
          errorCode: "protocol-invalid",
        });
      } catch { /* an unavailable host must not expose raw output */ }
    }
  } catch (error) {
    terminal = true;
    if (controller.signal.aborted && !protocolFailure) {
      try {
        send({
          protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
          kind: "cancelled",
          taskRunId: start.taskRunId,
        });
      } catch { /* an unavailable host cannot receive the terminal event */ }
    } else {
      const errorCode = protocolFailure
        ? "protocol-invalid"
        : classifyTypedWorkflowFailure(error, events, controller.signal.aborted);
      try {
        send({
          protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
          kind: "failed",
          taskRunId: start.taskRunId,
          errorCode,
        });
      } catch { /* an unavailable host cannot receive the terminal event */ }
    }
  } finally {
    terminal = true;
    options.port.off("message", onMessage);
    controller.signal.removeEventListener("abort", onAbort);
    failPending();
    childRpc?.close();
  }
}
