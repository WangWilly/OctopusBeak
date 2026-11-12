import type { MessagePort } from "node:worker_threads";
import type {
  WorkflowBrowserPort,
  WorkflowDefinition,
  WorkflowExecutorPorts,
  WorkflowCapabilityPorts,
} from "../workflow-executor.ts";
import type { WorkflowRunEvent } from "../run-event.ts";
import { createHostCallClient } from "./app-workflow-host-calls.ts";
import type { TdccSessionPort } from "../../../workflows/tdcc-session.ts";
import { isWorkflowRunResult } from "../workflow-run-result.ts";
import {
  createWorkflowExecutor,
  requiredCapabilityPorts,
  requiredWorkflowCapabilities,
  workflowUsesPreviewWrite,
} from "../workflow-executor.ts";
import { strictSourceText } from "../source-text.ts";
import { createWorkflowFinancialCommitPort } from "../workflow-financial-commit.ts";
import type { CommitAttemptRecorder } from "../commit-attempt.ts";
import { classifyFailure } from "../failure-classification.ts";
import { summarizeInterruptedProductCollection } from "./typed-workflow-outcome.ts";
import {
  appendWorkflowFailureDiagnostic,
  captureSafeWorkflowFailureError,
  workflowFailureDiagnosticRepoRoot,
  WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV,
} from "./workflow-failure-diagnostics.ts";
import {
  AppWorkflowWorkerProtocolError,
  APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
  parseAppWorkflowWorkerInboundFrame,
  parseAppWorkflowWorkerOutboundFrame,
  parseAppWorkflowBrowserConnection,
  parseAppWorkflowWorkerStart,
  isRecord,
  type AppWorkflowWorkerInboundFrame,
  type AppWorkflowWorkerOutboundFrame,
  type AppWorkflowWorkerStart,
} from "./app-workflow-worker-protocol.ts";
import { appWorkflowRegistration } from "./app-workflow-registry.ts";
import { withAppWorkflowBrowserPage, type AppWorkflowBrowserConnection } from "./app-browser-host.ts";
import {
  createPGliteChildRpcClient,
  type PGliteWorkflowRpc,
} from "../../pglite-rpc/pglite-child-rpc-client.ts";
import { takePreviewObservations } from "../../preview-sources/workflow.ts";
import { previewResponseShapes } from "../../preview-sources/structure-report.ts";

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

/** What a capability source opens for one run: the definition it serves and the run it serves it to. */
export type CapabilityRequest = Readonly<{
  definition: WorkflowDefinition;
  workflowId: string;
  taskRunId: string;
  /** The run's TDCC session, which only the core can build: it is served through host calls. */
  tdccSession: TdccSessionPort;
  signal: AbortSignal;
}>;

/** The ports a definition's capabilities are served from for one run, and how to release them. */
export type CapabilitySource = Readonly<{
  open(request: CapabilityRequest): Promise<Readonly<{
    ports: Partial<WorkflowCapabilityPorts>;
    close(): void;
  }>>;
}>;

/** The ports the definition requires, and the preview write port it may carry without requiring it. */
function servedPorts(
  definition: WorkflowDefinition,
  ports: Partial<WorkflowCapabilityPorts>,
): Partial<WorkflowCapabilityPorts> {
  return {
    ...requiredCapabilityPorts(definition, ports),
    ...(workflowUsesPreviewWrite(definition) && ports.previewWrite ? { previewWrite: ports.previewWrite } : {}),
  };
}

/**
 * The App's source: every capability port is served from the authenticated
 * PGlite child RPC that `descriptor` names. A definition that declares no
 * capability never dials it.
 */
export function childRpcCapabilities(descriptor: PGliteWorkflowRpc | undefined): CapabilitySource {
  return {
    async open({ definition, workflowId, taskRunId, tdccSession, signal }) {
      if (requiredWorkflowCapabilities(definition).length === 0) return { ports: {}, close() {} };
      if (!descriptor) throw new Error("worker-start-failed");
      const child = createPGliteChildRpcClient({
        endpoint: descriptor.endpoint,
        token: descriptor.token,
        diagnosticContext: { workflowId, taskRunId },
      });
      try {
        await abortable(child.ready, signal);
      } catch (error) {
        child.close();
        throw error;
      }
      return {
        ports: servedPorts(definition, {
          financialCommit: createWorkflowFinancialCommitPort(child.workflow),
          maicoinPersistence: child.operationalProvider.maicoin,
          tdcc: {
            session: tdccSession,
            admittedFundAccounts: (connection) => child.financial.request("financial.tdccFundAccounts.list", [connection]),
          },
          exchangeRates: {
            persistence: child.operationalProvider.exchangeRates,
            overviewCurrent: () => child.financial.request("financial.overview.current", []),
          },
          accountIdentity: {
            continuity: (request) => child.financial.request("financial.accountIdentity.continuity", [request]),
          },
          previewWrite: child.operationalProvider.preview,
        }),
        close: () => child.close(),
      };
    },
  };
}

/** A check's source: the ports it was given, of which a run sees only those its definition may use. */
export function fixedCapabilities(ports: Partial<WorkflowCapabilityPorts>): CapabilitySource {
  return {
    async open({ definition }) {
      return { ports: servedPorts(definition, ports), close() {} };
    },
  };
}

export type AppWorkflowWorkerRuntimeOptions = Readonly<{
  port: MessagePort;
  /** Test seam; production resolves from the App's typed workflow catalog. */
  resolveDefinition?: (workflowId: string) => WorkflowDefinition | null;
  /** The page a browser workflow runs in; a nonbrowser workflow is refused one. */
  browser?: WorkflowBrowserPort;
  /** Where the definition's capability ports come from; opened once per run. */
  capabilities: CapabilitySource;
  /** Test seam for the run's clock; production reads the wall clock. */
  now?: WorkflowExecutorPorts["now"];
}>;

function throwOnProtocolFailure() {
  return new AppWorkflowWorkerProtocolError();
}

function appBrowserPort(connection: AppWorkflowBrowserConnection): WorkflowBrowserPort {
  return {
    async withPage(run) {
      return await withAppWorkflowBrowserPage(connection, run);
    },
  };
}

const nonbrowserPage: WorkflowBrowserPort = {
  async withPage() {
    throw new AppWorkflowWorkerProtocolError();
  },
};

function refuseStart(port: MessagePort) {
  const failed: AppWorkflowWorkerOutboundFrame = {
    protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
    kind: "failed",
    taskRunId: null,
    errorCode: "protocol-invalid",
  };
  try { port.postMessage(parseAppWorkflowWorkerOutboundFrame(failed)); } catch { /* no raw transport error */ }
}

/**
 * The worker thread's entry: a browser workflow's `workerData` carries the
 * loopback DevTools page it attaches to, which becomes the core's browser.
 */
export async function runAppWorkflowWorkerThread(
  options: Readonly<{ port: MessagePort; workerData: unknown }>,
): Promise<void> {
  const { port, workerData } = options;
  const capabilities = childRpcCapabilities(
    isRecord(workerData) ? workerData.pgliteRpc as PGliteWorkflowRpc | undefined : undefined,
  );
  if (!isRecord(workerData) || !Object.hasOwn(workerData, "browserConnection")) {
    return await runAppWorkflowWorker(workerData, { port, capabilities });
  }
  const { browserConnection, ...start } = workerData;
  let connection: AppWorkflowBrowserConnection;
  try {
    connection = parseAppWorkflowBrowserConnection(browserConnection);
  } catch {
    refuseStart(port);
    return;
  }
  await runAppWorkflowWorker(start, { port, browser: appBrowserPort(connection), capabilities });
}

/** Execute one typed definition inside the App-managed Node worker. */
export async function runAppWorkflowWorker(
  workerData: unknown,
  options: AppWorkflowWorkerRuntimeOptions,
): Promise<void> {
  let start: AppWorkflowWorkerStart;
  try {
    start = parseAppWorkflowWorkerStart(workerData);
    const nonbrowser = appWorkflowRegistration(start.workflowId)?.runtime.kind === "nonbrowser";
    if (nonbrowser === (options.browser !== undefined)) throw new AppWorkflowWorkerProtocolError();
  } catch {
    refuseStart(options.port);
    return;
  }
  const browser = options.browser;

  const controller = new AbortController();
  const events: WorkflowRunEvent[] = [];
  let protocolFailure = false;
  let terminal = false;

  const send = (frame: AppWorkflowWorkerOutboundFrame) => {
    const validated = parseAppWorkflowWorkerOutboundFrame(frame);
    options.port.postMessage(validated);
  };
  const failProtocol = () => {
    protocolFailure = true;
    if (!controller.signal.aborted) controller.abort(throwOnProtocolFailure());
  };
  const hostCalls = createHostCallClient({
    post: send,
    signal: controller.signal,
    abortError,
    protocolFailure: failProtocol,
  });

  const onMessage = (value: unknown) => {
    if (terminal) return;
    let frame: AppWorkflowWorkerInboundFrame;
    try {
      frame = parseAppWorkflowWorkerInboundFrame(value);
    } catch {
      failProtocol();
      return;
    }
    if (frame.kind === "cancel") {
      if (!controller.signal.aborted) controller.abort(abortError());
      return;
    }
    hostCalls.receive(frame);
  };

  options.port.on("message", onMessage);

  const tdccSessionPort: TdccSessionPort = {
    async open() {
      return await hostCalls.call("tdccSession", { operation: "open" }) as Awaited<ReturnType<TdccSessionPort["open"]>>;
    },
    async signInDetails() {
      return await hostCalls.call("tdccSession", { operation: "sign-in-details" }) as Awaited<ReturnType<TdccSessionPort["signInDetails"]>>;
    },
    saveSession(session) {
      // Sent even after cancellation: the rotated token is what the next run signs in with.
      hostCalls.notify("tdccSessionRotated", { session });
    },
  };

  let opened: Awaited<ReturnType<CapabilitySource["open"]>> | undefined;
  let previewWorkflow = false;
  try {
    const definition = options.resolveDefinition
      ? options.resolveDefinition(start.workflowId)
      : appWorkflowRegistration(start.workflowId)?.definition;
    if (!definition || definition.id !== start.workflowId) throw new Error("worker-start-failed");
    previewWorkflow = definition.requiresPreviewWrite === true;
    opened = await options.capabilities.open({
      definition,
      workflowId: start.workflowId,
      taskRunId: start.taskRunId,
      tdccSession: tdccSessionPort,
      signal: controller.signal,
    });

    const eventsPort: WorkflowExecutorPorts["events"] = {
      async append(event) {
        if (events.length >= 512) events.shift();
        events.push(event);
        await hostCalls.call("event", { event });
      },
    };
    const commitAttempts: CommitAttemptRecorder = {
      record: (attempt) => hostCalls.call("commitAttempt", { attempt }),
    };
    const humanAssistance: WorkflowExecutorPorts["humanAssistance"] = {
      async request(contract, signal) {
        signal.throwIfAborted();
        const { status } = await hostCalls.call("humanAssistance", { contract });
        signal.throwIfAborted();
        return status;
      },
    };
    const ports: WorkflowExecutorPorts = {
      browser: browser ?? nonbrowserPage,
      text: strictSourceText,
      humanAssistance,
      ...opened.ports,
      commitAttempts,
      events: eventsPort,
      now: options.now ?? (() => new Date().toISOString()),
      onEventFailure: () => undefined,
      productFailure: async (failure) => {
        await appendWorkflowFailureDiagnostic(process.env[WORKFLOW_FAILURE_DIAGNOSTICS_FILE_ENV], {
          workflowId: start.workflowId,
          taskRunId: start.taskRunId,
          source: "workflow-worker",
          errorCode: failure.errorCode,
          stage: failure.stage,
          statementType: failure.statementType,
          reason: failure.reason,
          error: failure.error,
        }, { repoRoot: workflowFailureDiagnosticRepoRoot() });
      },
    };

    const output = await createWorkflowExecutor([definition], ports).run(
      start.workflowId,
      start.taskRunId,
      start.input,
      controller.signal,
    );
    terminal = true;
    try {
      // A workflow returns exactly its run result; anything else could carry provider data.
      if (output !== undefined && !isWorkflowRunResult(output)) throw new AppWorkflowWorkerProtocolError();
      send({
        protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
        kind: "completed",
        taskRunId: start.taskRunId,
        summary: output ?? null,
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
    const previewResponses = previewWorkflow ? previewResponseShapes(takePreviewObservations(error)) : null;
    const summary = summarizeInterruptedProductCollection(error);
    const errorCode = protocolFailure
      ? "protocol-invalid"
      : classifyFailure({ error, events, stopped: controller.signal.aborted });
    if (errorCode === "cancelled" && controller.signal.aborted && !protocolFailure) {
      try {
        send({
          protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
          kind: "cancelled",
          taskRunId: start.taskRunId,
          ...(summary ? { summary } : {}),
        });
      } catch { /* an unavailable host cannot receive the terminal event */ }
    } else {
      try {
        send({
          protocolVersion: APP_WORKFLOW_WORKER_PROTOCOL_VERSION,
          kind: "failed",
          taskRunId: start.taskRunId,
          errorCode,
          ...(summary ? { summary } : {}),
          ...(previewResponses ? { previewResponses } : {}),
          diagnostic: captureSafeWorkflowFailureError(
            protocolFailure ? new AppWorkflowWorkerProtocolError() : error,
            workflowFailureDiagnosticRepoRoot(),
          ),
        });
      } catch { /* an unavailable host cannot receive the terminal event */ }
    }
  } finally {
    terminal = true;
    options.port.off("message", onMessage);
    hostCalls.close();
    opened?.close();
  }
}
