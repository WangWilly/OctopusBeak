import type { MessagePort } from "node:worker_threads";
import type {
  WorkflowBrowserPort,
  WorkflowDefinition,
  WorkflowExecutorPorts,
  WorkflowFinancialCommitPort,
  WorkflowAccountIdentityPort,
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
  parseAppWorkflowWorkerStart,
  type AppWorkflowWorkerInboundFrame,
  type AppWorkflowWorkerOutboundFrame,
  type AppWorkflowWorkerStart,
} from "./app-workflow-worker-protocol.ts";
import {
  appWorkflowRegistration,
  type AppWorkflowRegistryDependencies,
} from "./app-workflow-registry.ts";
import { withAppWorkflowBrowserPage } from "./app-browser-host.ts";
import {
  createPGliteChildRpcClient,
  type PGliteChildRpcClient,
} from "../../../../electron/pglite-child-rpc-client.ts";
import { createExchangeRateSyncService } from "./exchange-rate-sync-service.ts";
import { takePreviewObservations, type WorkflowPreviewWritePort } from "../../preview-sources/workflow.ts";
import { previewResponseShapes } from "../../preview-sources/structure-report.ts";

function previewWritePort(
  definition: WorkflowDefinition,
  injected: WorkflowPreviewWritePort | undefined,
  fromChild: WorkflowPreviewWritePort | undefined,
): { previewWrite?: WorkflowPreviewWritePort } {
  if (!workflowUsesPreviewWrite(definition)) return {};
  const port = injected ?? fromChild;
  return port ? { previewWrite: port } : {};
}

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
  previewWrite?: WorkflowPreviewWritePort;
  accountIdentity?: WorkflowAccountIdentityPort;
  now?: WorkflowExecutorPorts["now"];
}>;

function childRpcCapabilityPorts(
  child: PGliteChildRpcClient,
  tdccSession: TdccSessionPort,
): Required<WorkflowCapabilityPorts> {
  return {
    financialCommit: createWorkflowFinancialCommitPort(child.workflow),
    maicoinPersistence: child.operationalProvider.maicoin,
    tdcc: {
      session: tdccSession,
      admittedFundAccounts: (connection) => child.financial.request("financial.tdccFundAccounts.list", [connection]),
    },
    accountIdentity: {
      continuity: (request) => child.financial.request("financial.accountIdentity.continuity", [request]),
    },
    previewWrite: child.operationalProvider.preview,
  };
}

function throwOnProtocolFailure() {
  return new AppWorkflowWorkerProtocolError();
}

function appBrowserPort(start: AppWorkflowWorkerStart): WorkflowBrowserPort {
  return {
    async withPage(run) {
      if (!start.browserConnection) throw new AppWorkflowWorkerProtocolError();
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

  let childRpc: PGliteChildRpcClient | undefined;
  let previewWorkflow = false;
  let progressQueue = Promise.resolve();
  const connectChildRpc = async (rpc: NonNullable<AppWorkflowWorkerStart["pgliteRpc"]>) => {
    childRpc = createPGliteChildRpcClient({
      endpoint: rpc.endpoint,
      token: rpc.token,
      diagnosticContext: { workflowId: start.workflowId, taskRunId: start.taskRunId },
    });
    await abortable(childRpc.ready, controller.signal);
    return childRpc;
  };
  try {
    const runtime = appWorkflowRegistration(start.workflowId)?.runtime;
    if (!runtime) throw new Error("worker-start-failed");
    if (start.pgliteRpc && runtime.kind === "nonbrowser") {
      await connectChildRpc(start.pgliteRpc);
    }
    const definitionDependencies: AppWorkflowRegistryDependencies = {
      ...(start.workflowId === "exchange-rates" && childRpc ? {
        exchangeRateSyncService: createExchangeRateSyncService({
          exchangeRates: childRpc.operationalProvider.exchangeRates,
          financial: { overviewCurrent: () => childRpc!.financial.request("financial.overview.current", []) },
        }),
        exchangeRateProgress: (event) => {
          progressQueue = progressQueue.then(async () => {
            await hostCalls.call("exchangeRateProgress", {
              phaseCode: event.phaseCode as "load-request" | "sync" | "complete",
              completed: event.completed ?? 0,
              total: event.total ?? 3,
              percent: event.percent ?? 0,
            });
          });
          void progressQueue.catch(() => undefined);
        },
      } : {}),
    };
    const definition = options.resolveDefinition
      ? options.resolveDefinition(start.workflowId, definitionDependencies)
      : appWorkflowRegistration(start.workflowId, definitionDependencies)?.definition;
    if (!definition || definition.id !== start.workflowId) throw new Error("worker-start-failed");
    previewWorkflow = definition.requiresPreviewWrite === true;
    const previewWrite = workflowUsesPreviewWrite(definition) ? options.previewWrite : undefined;
    const injected: Partial<WorkflowCapabilityPorts> = {
      ...(options.financialCommit ? { financialCommit: options.financialCommit } : {}),
      ...(options.accountIdentity ? { accountIdentity: options.accountIdentity } : {}),
      ...(previewWrite ? { previewWrite } : {}),
    };
    const servedByInjection = requiredCapabilityPorts(definition, injected);
    if (!childRpc && requiredWorkflowCapabilities(definition).some((capability) => !servedByInjection[capability])) {
      if (!start.pgliteRpc) throw new Error("worker-start-failed");
      await connectChildRpc(start.pgliteRpc);
    }
    const capabilityPorts = requiredCapabilityPorts(
      definition,
      injected,
      childRpc && childRpcCapabilityPorts(childRpc, tdccSessionPort),
    );

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
    const browser = options.browser ?? appBrowserPort(start);
    const ports: WorkflowExecutorPorts = {
      browser,
      text: strictSourceText,
      humanAssistance,
      ...capabilityPorts,
      ...(previewWritePort(definition, previewWrite, childRpc?.operationalProvider.preview)),
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
    await progressQueue;
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
    childRpc?.close();
  }
}
