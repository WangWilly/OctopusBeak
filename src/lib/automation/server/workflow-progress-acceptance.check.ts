import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { WorkerOptions } from "node:worker_threads";
import { PGlite } from "@electric-sql/pglite";
import test from "node:test";
import {
  applyPgliteOperationalBaseline,
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import {
  PGLITE_CHILD_RPC_ENDPOINT_ENV,
  PGLITE_CHILD_RPC_TOKEN_ENV,
} from "../../../../electron/pglite-child-rpc-client.ts";
import { taskById } from "./tasks.ts";
import type {
  AppWorkflowWorkerHandle,
} from "./app-workflow-worker-supervisor.ts";
import type {
  AppWorkflowWorkerInboundFrame,
  AppWorkflowWorkerOutboundFrame,
  AppWorkflowWorkerStart,
} from "./app-workflow-worker-protocol.ts";
import { runAutomationTaskExecution } from "./task-run-execution.ts";

type ProgressSnapshot = Readonly<{
  phaseCode: string | null;
  percent: number | null;
  params?: Readonly<{
    statementType?: string;
    activity?: string;
    retrying?: boolean;
  }>;
}>;

type WorkflowEventInput = Readonly<{
  stage: string;
  code: string;
  statementType?: string;
  activity?: "query" | "download";
  retrying?: boolean;
}>;

type WorkerStep = Readonly<{
  eventId: string;
  event: WorkflowEventInput;
}>;

type ExchangeRateProgressFrame = Extract<AppWorkflowWorkerOutboundFrame, { kind: "exchange-rate-progress" }>;

type TerminalFrameInput = Readonly<{
  kind: "completed" | "failed" | "cancelled";
  errorCode?: string;
  summary?: unknown;
}>;

class SequencedWorkflowWorker extends EventEmitter implements AppWorkflowWorkerHandle {
  readonly stdout = null;
  readonly stderr = null;
  private readonly frames: AppWorkflowWorkerOutboundFrame[];
  private readonly taskRunId: string;
  private readonly onEventAcknowledged: (eventId: string, runId: string) => Promise<void>;
  private currentEventId: string | null = null;
  private currentRunId: string | null = null;

  constructor(
    start: AppWorkflowWorkerStart,
    steps: readonly WorkerStep[],
    terminal: TerminalFrameInput,
    onEventAcknowledged: (eventId: string, runId: string) => Promise<void>,
    progressFrames: readonly ExchangeRateProgressFrame[] = [],
  ) {
    super();
    this.taskRunId = start.taskRunId;
    this.onEventAcknowledged = onEventAcknowledged;
    this.frames = [
      ...steps.map(({ eventId, event }) => ({
        protocolVersion: 2 as const,
        kind: "event" as const,
        eventId,
        event: {
          runId: start.taskRunId,
          ...event,
          occurredAt: "2026-10-04T00:00:00.000Z",
        },
      } as AppWorkflowWorkerOutboundFrame)),
      ...progressFrames,
      terminal.kind === "completed"
        ? {
          protocolVersion: 2,
          kind: "completed",
          taskRunId: start.taskRunId,
          summary: terminal.summary === undefined ? null : terminal.summary as never,
        } as AppWorkflowWorkerOutboundFrame
        : terminal.kind === "failed"
          ? {
            protocolVersion: 2,
            kind: "failed",
            taskRunId: start.taskRunId,
            errorCode: terminal.errorCode ?? "workflow-failed",
            ...(terminal.summary === undefined ? {} : { summary: terminal.summary as never }),
          } as AppWorkflowWorkerOutboundFrame
          : {
            protocolVersion: 2,
            kind: "cancelled",
            taskRunId: start.taskRunId,
            ...(terminal.summary === undefined ? {} : { summary: terminal.summary as never }),
          } as AppWorkflowWorkerOutboundFrame,
    ];
    setImmediate(() => {
      this.emit("online");
      this.sendNextFrame();
    });
  }

  postMessage(frame: AppWorkflowWorkerInboundFrame) {
    if (frame.kind !== "event-ack" || frame.eventId !== this.currentEventId || !this.currentRunId) return;
    const eventId = this.currentEventId;
    const runId = this.currentRunId;
    this.currentEventId = null;
    this.currentRunId = null;
    void this.onEventAcknowledged(eventId, runId).then(() => {
      this.sendNextFrame();
    }).catch((error: unknown) => this.emit("error", error));
  }

  terminate() {
    setImmediate(() => this.emit("exit", 1));
    return Promise.resolve(1);
  }

  private sendNextFrame() {
    const frame = this.frames.shift();
    if (!frame) return;
    if (frame.kind === "event" || frame.kind === "exchange-rate-progress") {
      this.currentEventId = frame.eventId;
      this.currentRunId = frame.kind === "event" ? frame.event.runId : this.taskRunId;
    }
    setImmediate(() => {
      this.emit("message", frame);
      if (frame.kind === "completed" || frame.kind === "failed" || frame.kind === "cancelled") {
        setImmediate(() => this.emit("exit", frame.kind === "completed" ? 0 : 1));
      }
    });
  }
}

function makeSteps(retrying = false): readonly WorkerStep[] {
  return [
    { eventId: "run-start", event: { stage: "preparation", code: "run-started" } },
    {
      eventId: "domestic-query",
      event: {
        stage: "collection",
        code: "statement-query-started",
        statementType: "domestic",
        activity: "query",
      },
    },
    {
      eventId: "domestic-download",
      event: {
        stage: "collection",
        code: "statement-download-started",
        statementType: "domestic",
        activity: "download",
      },
    },
    {
      eventId: "domestic-commit",
      event: {
        stage: "commit",
        code: "canonical-commit-completed",
        statementType: "domestic",
      },
    },
    {
      eventId: retrying ? "foreign-query-retry" : "foreign-query",
      event: {
        stage: "collection",
        code: retrying ? "statement-query-retrying" : "statement-query-started",
        statementType: "foreign_currency",
        activity: "query",
        ...(retrying ? { retrying: true } : {}),
      },
    },
    {
      eventId: "foreign-download",
      event: {
        stage: "collection",
        code: "statement-download-started",
        statementType: "foreign_currency",
        activity: "download",
      },
    },
    { eventId: "run-completed", event: { stage: "finalization", code: "run-completed" } },
  ];
}

test("runner progress spans selected product stages, survives a same-run retry, and reserves 100% for full success", async () => {
  const task = taskById("cathay-all-statements");
  assert.ok(task);
  const store = new PGliteStore(await PGlite.create());
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const snapshots: Array<{ runId: string; eventId: string; progress: ProgressSnapshot | null }> = [];
    const persistence = new Proxy(provider.automation, {
      get(target, property) {
        if (property === "taskRunById") return target.taskRunById.bind(target);
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const onEventAcknowledged = async (eventId: string, runId: string) => {
      const run = await persistence.taskRunById(runId);
      snapshots.push({
        runId,
        eventId,
        progress: run?.progress as ProgressSnapshot | null ?? null,
      });
    };
    const launchEnv = {
      LIBRETTO_CLOUD_CATHAY_USER_ID: "synthetic-user-id",
      LIBRETTO_CLOUD_CATHAY_ACCOUNT: "synthetic-account",
      LIBRETTO_CLOUD_CATHAY_PASSWORD: "synthetic-password",
      LIBRETTO_CLOUD_CATHAY_STATEMENT_TYPES: "domestic,foreign_currency",
      [PGLITE_CHILD_RPC_ENDPOINT_ENV]: "http://127.0.0.1:43121/rpc",
      [PGLITE_CHILD_RPC_TOKEN_ENV]: "a".repeat(32),
    };
    const execute = async (input: {
      runId?: string;
      attempt: number;
      steps: readonly WorkerStep[];
      terminal: TerminalFrameInput;
      deferFinalization?: boolean;
    }) => {
      const lifecycle: { taskRunId: string; initialProgress: ProgressSnapshot | null } = {
        taskRunId: "",
        initialProgress: null,
      };
      const result = await runAutomationTaskExecution(task, persistence, {
        ...(input.runId ? { taskRunId: input.runId } : {}),
        attempt: input.attempt,
        maxAttempts: 3,
        launchEnv,
        deferFinalization: input.deferFinalization,
        workflowBrowserPortFactory: () => ({
          async withPage(run) { return await run({} as never); },
        }),
        appWorkflowBrowserConnectionForRun: (runId) => ({
          endpoint: "http://127.0.0.1:43121",
          targetId: `fixture-page-${runId}`,
        }),
        appWorkflowWorkerFactory: (_workerPath, options: WorkerOptions) =>
          new SequencedWorkflowWorker(
            options.workerData as AppWorkflowWorkerStart,
            input.steps,
            input.terminal,
            onEventAcknowledged,
          ),
      }, async (runId) => {
        lifecycle.taskRunId = runId;
        const run = await persistence.taskRunById(runId);
        lifecycle.initialProgress = run?.progress as ProgressSnapshot | null ?? null;
      });
      return { taskRunId: lifecycle.taskRunId, result, initialProgress: lifecycle.initialProgress };
    };

    const firstAttempt = await execute({
      attempt: 1,
      steps: makeSteps(false).slice(0, 5),
      terminal: { kind: "failed", errorCode: "workflow-failed" },
      deferFinalization: true,
    });
    assert.ok(
      firstAttempt.initialProgress?.percent === null || firstAttempt.initialProgress?.percent === 0,
      "a new run begins at the zero state",
    );
    const firstProgress = (await persistence.taskRunById(firstAttempt.taskRunId))?.progress as ProgressSnapshot | null;
    assert.ok(firstProgress?.percent !== null && firstProgress?.percent !== undefined && firstProgress.percent > 0);
    const retryBaseline = firstProgress.percent;

    const retried = await execute({
      runId: firstAttempt.taskRunId,
      attempt: 2,
      steps: [
        { eventId: "retry-run-start", event: { stage: "preparation", code: "run-started" } },
        {
          eventId: "foreign-query-retry",
          event: {
            stage: "collection",
            code: "statement-query-retrying",
            statementType: "foreign_currency",
            activity: "query",
            retrying: true,
          },
        },
        {
          eventId: "foreign-download-retry",
          event: {
            stage: "collection",
            code: "statement-download-started",
            statementType: "foreign_currency",
            activity: "download",
          },
        },
        { eventId: "run-completed", event: { stage: "finalization", code: "run-completed" } },
      ],
      terminal: {
        kind: "failed",
        errorCode: "workflow-failed",
        summary: {
          status: "partial",
          counts: { itemCount: 2, committedCount: 1, sourceCaptureCount: 1 },
          products: [
            { typeId: "domestic", status: "success", itemCount: 1, committedCount: 1 },
            { typeId: "foreign_currency", status: "failed", itemCount: 1, committedCount: 0, errorCode: "workflow-failed" },
          ],
        },
      },
    });
    assert.ok(
      retried.initialProgress?.percent !== null
        && retried.initialProgress?.percent !== undefined
        && retried.initialProgress.percent >= retryBaseline,
      "re-entering the same run for an automatic retry does not clear its progress",
    );
    const retryProgress = snapshots.find((snapshot) => snapshot.runId === firstAttempt.taskRunId && snapshot.eventId === "foreign-query-retry")?.progress;
    assert.ok(retryProgress?.percent !== null && retryProgress?.percent !== undefined);
    assert.ok(retryProgress.percent >= retryBaseline, "automatic retry keeps progress monotonic across execution calls");
    assert.equal(retryProgress.params?.retrying, true, "the current stage identifies its retry");
    const retriedRun = await persistence.taskRunById(firstAttempt.taskRunId);
    assert.equal(retriedRun?.status, "failed");
    assert.equal(retriedRun?.appWorkflowOutcome?.summary?.status, "partial");
    const prePartialPercent = snapshots.find(
      (snapshot) => snapshot.runId === firstAttempt.taskRunId && snapshot.eventId === "run-completed",
    )?.progress?.percent;
    assert.ok(prePartialPercent !== null && prePartialPercent !== undefined && prePartialPercent < 100);
    assert.equal(retriedRun?.progress?.percent, prePartialPercent, "partial terminal outcome retains the last stage progress");

    const runProgress = snapshots.filter((snapshot) => snapshot.runId === firstAttempt.taskRunId && snapshot.progress?.percent !== null);
    assert.ok(runProgress.length >= 3, "each meaningful worker stage reaches persisted task progress");
    for (let index = 1; index < runProgress.length; index += 1) {
      assert.ok(
        (runProgress[index]?.progress?.percent ?? -1) >= (runProgress[index - 1]?.progress?.percent ?? -1),
        `progress regressed at ${runProgress[index]?.eventId}`,
      );
    }
    const domesticCommit = snapshots.find((snapshot) => snapshot.runId === firstAttempt.taskRunId && snapshot.eventId === "domestic-commit")?.progress;
    const foreignQuery = snapshots.find((snapshot) => snapshot.runId === firstAttempt.taskRunId && snapshot.eventId === "foreign-query")?.progress;
    const foreignDownload = snapshots.find((snapshot) => snapshot.runId === firstAttempt.taskRunId && snapshot.eventId === "foreign-download-retry")?.progress;
    assert.ok(domesticCommit?.percent !== null && domesticCommit?.percent !== undefined);
    assert.ok(foreignQuery?.percent !== null && foreignQuery?.percent !== undefined);
    assert.ok(foreignQuery.percent > domesticCommit.percent, "the next selected product receives its own progress slice");
    assert.ok(foreignDownload?.percent !== null && foreignDownload?.percent !== undefined);
    assert.ok(foreignDownload.percent > foreignQuery.percent, "query and download are distinct visible stages");
    assert.ok((snapshots.find((snapshot) => snapshot.runId === firstAttempt.taskRunId && snapshot.eventId === "run-completed")?.progress?.percent ?? 100) < 100,
      "run-completed event alone cannot mark a partially successful run complete");

    const successful = await execute({
      attempt: 1,
      steps: makeSteps(false),
      terminal: {
        kind: "completed",
        summary: {
          status: "completed",
          counts: { itemCount: 2, committedCount: 2, sourceCaptureCount: 2 },
          products: [
            { typeId: "domestic", status: "success", itemCount: 1, committedCount: 1 },
            { typeId: "foreign_currency", status: "success", itemCount: 1, committedCount: 1 },
          ],
        },
      },
    });
    assert.ok(
      successful.initialProgress?.percent === null || successful.initialProgress?.percent === 0,
      "a separate run starts at zero instead of inheriting the previous run's progress",
    );
    assert.notEqual(successful.taskRunId, firstAttempt.taskRunId, "a new execution creates an independent run");
    const successfulRun = await persistence.taskRunById(successful.taskRunId);
    assert.equal(successfulRun?.status, "completed");
    assert.equal(successfulRun?.progress?.percent, 100, "only the successful terminal outcome reaches 100%");
    assert.ok((snapshots.find((snapshot) => snapshot.runId === successful.taskRunId && snapshot.eventId === "run-completed")?.progress?.percent ?? 100) < 100,
      "the final progress event is still below 100% until terminal success is established");

    const exchangeRateTask = taskById("exchange-rates");
    assert.ok(exchangeRateTask);
    const exchangeRateResult = await runAutomationTaskExecution(exchangeRateTask, persistence, {
      attempt: 1,
      maxAttempts: 1,
      launchEnv,
      workflowBrowserPortFactory: () => {
        throw new Error("Exchange-rate progress must not open a browser.");
      },
      appWorkflowWorkerFactory: (_workerPath, options: WorkerOptions) =>
        new SequencedWorkflowWorker(
          options.workerData as AppWorkflowWorkerStart,
          [{ eventId: "exchange-run-start", event: { stage: "preparation", code: "run-started" } }],
          { kind: "completed", summary: null },
          onEventAcknowledged,
          [{
            protocolVersion: 2,
            kind: "exchange-rate-progress",
            eventId: "exchange-complete",
            phaseCode: "complete",
            completed: 3,
            total: 3,
            percent: 100,
          }],
        ),
    }, async () => {});
    assert.equal(exchangeRateResult.status, "completed");
    const exchangeRunId = exchangeRateResult.taskRunId;
    assert.ok(exchangeRunId);
    const exchangeProgressBeforeTerminal = snapshots.find(
      (snapshot) => snapshot.runId === exchangeRunId && snapshot.eventId === "exchange-complete",
    )?.progress;
    assert.ok(exchangeProgressBeforeTerminal?.percent !== null && exchangeProgressBeforeTerminal?.percent !== undefined);
    assert.ok(exchangeProgressBeforeTerminal.percent < 100, "the exchange-rate complete phase is capped before terminal success");
    assert.equal((await persistence.taskRunById(exchangeRunId))?.status, "completed");

    const cancelled = await execute({
      attempt: 1,
      steps: makeSteps(false).slice(0, 3),
      terminal: { kind: "cancelled" },
    });
    assert.equal(cancelled.result.status, "cancelled");
    const cancelledRun = await persistence.taskRunById(cancelled.taskRunId);
    const preCancelPercent = snapshots.filter((snapshot) => snapshot.runId === cancelled.taskRunId).at(-1)?.progress?.percent;
    assert.equal(cancelledRun?.status, "cancelled");
    assert.ok(preCancelPercent !== null && preCancelPercent !== undefined && preCancelPercent < 100);
    assert.equal(cancelledRun?.progress?.percent, preCancelPercent, "cancellation retains the last reported workflow step");
  } finally {
    await store.close();
  }
});
