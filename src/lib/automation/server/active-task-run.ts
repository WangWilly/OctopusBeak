import type { AutomationRuntimeTaskSnapshot } from "$lib/desktop/api.ts";
import {
  canTransitionTaskRun,
  isTerminalTaskRunStatus,
  type ActiveTaskRunStatus,
  type AutomationPersistencePort,
  type AutomationPersistenceProvider,
  type AutomationTaskRun,
  type AutomationTaskRunUpdate,
  type TerminalTaskRunStatus,
} from "./store.ts";
import { runtimeTaskSnapshotFromRun } from "./runtime-state.ts";
import type {
  TypedWorkflowErrorCode,
} from "./typed-workflow-outcome.ts";
import type { WorkflowRunResult } from "../workflow-run-result.ts";
import type { WorkflowRunEvent } from "../run-event.ts";
import type {
  HumanAssistanceCompletionStatus,
  HumanAssistanceContract,
  HumanAssistanceContractInput,
} from "../human-assistance.ts";
import type { HumanAssistanceRoute } from "./app-workflow-human-assistance.ts";
import type { LaunchedCollectionScope } from "./collection-scope.ts";
import type { Page } from "playwright";
import type { AppWorkflowBrowserConnection } from "./app-browser-host.ts";
import type { PageForRun } from "./automation-viewer.ts";
import {
  applyCommitAttemptReport,
  commitAttemptsErrorCode,
  commitAttemptsMayHaveCommitted,
  type CommitAttempt,
  type CommitAttemptReport,
} from "../commit-attempt.ts";
import { tdccIncompleteCollectionHasDurableReceipts } from "../tdcc-collection-summary.ts";
import { isValidExternalPrerequisiteMetadata } from "../external-prerequisite.ts";
import { taskById } from "./tasks.ts";
import {
  dataVersionStore as defaultDataVersionStore,
  type DataVersionStore,
} from "../../shared-shell/data-version.ts";

export type ActiveTaskRunFields = Pick<AutomationTaskRunUpdate, "attempt" | "maxAttempts" | "progress">;

/** Why an Active Automation Task Run was asked to stop before it ended on its own. */
export type TaskRunStop = "cancelled" | "forced" | "shutdown";

/**
 * Only a Commit attempt can make a run commit outcome unknown (ADR 0056), so
 * an execution cannot report it.
 */
export type TaskRunFailure = Readonly<{
  code: Exclude<TypedWorkflowErrorCode, "commit-outcome-unknown">;
  /** False when the code was classified from run events, so a failed Commit attempt explains the run better. */
  proven: boolean;
}>;

/** What an execution observed, before the run's Commit attempts and stop are applied. */
export type TaskRunReport = Readonly<{
  summary: WorkflowRunResult | null;
  /** Null when the workflow completed. */
  failure: TaskRunFailure | null;
}>;

export type TaskRunOutcome = Readonly<{
  status: TerminalTaskRunStatus;
  errorCode: TypedWorkflowErrorCode | null;
  summary: WorkflowRunResult | null;
  forced: boolean;
}>;

export type HumanAssistanceResolution = Exclude<HumanAssistanceCompletionStatus, "pending">;

/** The one human assistance request a Workflow execution is waiting on. */
export type HumanAssistanceWaiter = Readonly<{
  /** Settles once: resolved by the stage's completion, rejected otherwise. */
  completion: Promise<HumanAssistanceResolution>;
  /** Settle the completion and release the waiter. Later calls do nothing. */
  resolve(status: HumanAssistanceResolution): void;
  reject(error: Error): void;
}>;

/** The browser page the App hosts for one Workflow execution. */
export type HostedBrowserPage = Readonly<{
  page: Page;
  /** The loopback CDP target the worker attaches to; null when the host exposes none. */
  connection: AppWorkflowBrowserConnection | null;
}>;

/**
 * One start of the provider workflow within its Active Automation Task Run
 * (ADR 0067). It records every event of that start once, worker and host
 * events alike, and persists each through the run's write chain. "This
 * execution's events" is its log; nothing reads stored events back for it.
 * It also holds its human assistance route and at most one waiter, the
 * Collection scope version its commits are checked against, and its hosted
 * browser page, all released when it ends.
 */
export type WorkflowExecution = Readonly<{
  executionId: string;
  /** The route given when this execution began; null once it has ended or when none was given. */
  assistanceRoute(): HumanAssistanceRoute | null;
  /**
   * Hold this execution's human assistance waiter. Throws while another is
   * held or once this execution has ended. Ending rejects a held waiter.
   */
  holdAssistance(): HumanAssistanceWaiter;
  /** The held waiter, or null. */
  pendingAssistance(): HumanAssistanceWaiter | null;
  /** The Collection scope version given when this execution began; null once it has ended or when none was given. */
  collectionScope(): LaunchedCollectionScope | null;
  /**
   * Hold the page the browser host opened for this execution until the
   * returned release runs or the execution ends. Throws once this execution
   * has ended or while it already holds a page.
   */
  hostPage(hosted: HostedBrowserPage): () => void;
  /** The hosted page, or null when none is held. */
  page(): Page | null;
  /** The hosted page's worker connection, or null when no page or no connection is held. */
  browserConnection(): AppWorkflowBrowserConnection | null;
  /** Every event this execution recorded, in the order it recorded them. */
  events(): readonly WorkflowRunEvent[];
  /**
   * Record one event in this log, then persist it behind the run's earlier
   * writes. The log holds the event before the write, so a failed write
   * rejects but leaves it logged; once the run has finished the event is
   * logged and not persisted. Rejects and records nothing once this
   * execution has ended.
   */
  appendEvent(event: WorkflowRunEvent): Promise<void>;
  /** Release this execution as the run's current one. Idempotent. */
  end(): void;
}>;

export type WorkflowExecutionOptions = Readonly<{
  /** Answers the execution's human assistance requests. Fixed before the worker can ask. */
  assistanceRoute?: HumanAssistanceRoute;
  /** The Collection scope version this execution was launched with. Fixed before the worker can commit. */
  collectionScope?: LaunchedCollectionScope;
}>;

/** The sole owner of one Automation Task Run until its finalization (ADR 0052). */
export type ActiveAutomationTaskRun = Readonly<{
  taskId: string;
  taskRunId: string;
  persistence: AutomationPersistencePort;
  /** Start a Workflow execution. Throws while another is current or once the run has finished. */
  beginExecution(executionId: string, options?: WorkflowExecutionOptions): WorkflowExecution;
  /** The execution that has begun and not ended, or null. */
  currentExecution(): WorkflowExecution | null;
  /**
   * Durably record an event that belongs to no execution, such as a signal the
   * CAPTCHA Retry Campaign writes between rounds. It joins no execution's log,
   * so no classification reads it. Ignored once the run has finished.
   */
  appendEvent(event: WorkflowRunEvent): Promise<void>;
  /** Aborted with a TaskRunStop reason on cancellation, force-quit or shutdown. */
  signal: AbortSignal;
  /** Aborted only on force-quit, which allows no cleanup grace. */
  forceSignal: AbortSignal;
  /** The strongest stop requested so far, or null. */
  stopReason(): TaskRunStop | null;
  /** The last persisted row this owner wrote. */
  current(): AutomationTaskRun;
  /** Move to an active status. False when the table or the store refuses it. */
  transition(status: ActiveTaskRunStatus, fields?: ActiveTaskRunFields): Promise<boolean>;
  /** Record non-status fields. Ignored once the run has finished. */
  update(fields: ActiveTaskRunFields): Promise<void>;
  /** Present a new human assistance contract on the run's row. Rejects once the run has finished. */
  updateHumanAssistanceContract(contract: HumanAssistanceContractInput): Promise<HumanAssistanceContract>;
  /** Record the current contract's completion. Rejects once the run has finished. */
  updateHumanAssistanceCompletion(status: HumanAssistanceCompletionStatus): Promise<HumanAssistanceContract>;
  /** Durably append one Commit attempt phase and keep it for the run's outcome (ADR 0056). */
  recordCommitAttempt(report: CommitAttemptReport): Promise<void>;
  requestStop(reason: TaskRunStop): Promise<void>;
  /** The outcome this report and the run's Commit attempts give, before any stop is applied. */
  assess(report: TaskRunReport): TaskRunOutcome;
  /** Persist the terminal outcome. Later calls return the first result. */
  finish(report: TaskRunReport): Promise<AutomationTaskRun>;
}>;

type RuntimeStatePort = Readonly<{
  upsert(task: AutomationRuntimeTaskSnapshot): unknown;
}>;

const STOP_RANK: Readonly<Record<TaskRunStop, number>> = { shutdown: 1, cancelled: 2, forced: 3 };

/** Ordinary cancellation gets this long to clean up before force-quit is offered. */
export const FORCE_QUIT_AVAILABLE_AFTER_MS = 10_000;

/**
 * The run's Commit attempts outrank its report: an unsettled attempt makes it
 * commit outcome unknown and a refused one collection scope changed (ADR 0058).
 * Unknown also outranks every stop so an uncertain financial write is never
 * hidden; a person's cancellation outranks shutdown. A product the store
 * refused until a Canonical Reset names the run's outcome even when other
 * products committed, since only the person can clear it (ADR 0062).
 */
function decide(
  attempts: readonly CommitAttempt[],
  report: TaskRunReport,
  stop: TaskRunStop | null,
): TaskRunOutcome {
  const { failure, summary } = report;
  const commit = commitAttemptsErrorCode(attempts);
  const resetRequired = summary?.products?.some((product) => product.errorCode === "canonical-reset-required");
  const errorCode = commit === "commit-outcome-unknown" || commit === "collection-scope-changed"
    ? commit
    : resetRequired
      ? "canonical-reset-required"
      : failure === null
        ? null
        : failure.proven ? failure.code : commit ?? failure.code;
  const outcome = (
    status: TerminalTaskRunStatus,
    code: TypedWorkflowErrorCode | null,
    forced = false,
  ): TaskRunOutcome => ({ status, errorCode: code, summary, forced });
  if (errorCode === "commit-outcome-unknown") return outcome("failed", errorCode);
  if (stop === "forced") return outcome("cancelled", "cancelled", true);
  if (stop === "cancelled") return outcome("cancelled", "cancelled");
  if (stop === "shutdown") return outcome("interrupted", "cancelled");
  if (errorCode === "cancelled") return outcome("cancelled", "cancelled");
  if (tdccIncompleteCollectionHasDurableReceipts(summary, errorCode)) return outcome("partial", errorCode);
  if (errorCode === "canonical-reset-required") {
    return outcome(summary?.status === "partial" ? "partial" : "failed", errorCode);
  }
  if (errorCode !== null || summary?.status === "failed") return outcome("failed", errorCode);
  if (summary?.status === "partial") return outcome("partial", null);
  return outcome("completed", null);
}

/** Persist a terminal outcome once. A run that is already terminal is returned unchanged. */
async function persistTerminal(
  persistence: AutomationPersistencePort,
  taskRunId: string,
  outcome: TaskRunOutcome,
  attempts: readonly CommitAttempt[],
  dataVersionStore: DataVersionStore,
): Promise<AutomationTaskRun> {
  const current = await persistence.taskRunById(taskRunId);
  if (!current) throw new Error(`Missing automation task run: ${taskRunId}`);
  if (isTerminalTaskRunStatus(current.status)) return current;
  const finishedAt = new Date().toISOString();
  const transition = await persistence.transitionTaskRunToTerminal(taskRunId, {
    status: outcome.status,
    finishedAt,
    appWorkflowOutcome: { errorCode: outcome.errorCode, summary: outcome.summary },
    ...(outcome.status === "completed" ? {
      progress: current.progress?.phaseCode === "complete"
        ? { ...current.progress, percent: 100, attempt: current.attempt }
        : {
          ...current.progress,
          phaseCode: "workflow-finalization",
          completed: 1,
          total: 1,
          percent: 100,
          attempt: current.attempt,
        },
    } : {}),
    ...(outcome.forced ? { terminationMode: "forced" as const } : {}),
  });
  if (transition.applied) {
    const committedProductCount = outcome.summary?.counts.committedCount
      ?? outcome.summary?.products?.reduce((total, product) => total + product.committedCount, 0)
      ?? 0;
    if (outcome.status === "completed" || outcome.status === "partial"
      || committedProductCount > 0
      || commitAttemptsMayHaveCommitted(attempts)) {
      dataVersionStore.markStale("automation-completed");
    }
    if (outcome.status === "completed") {
      await persistence.resolveTaskPrerequisiteNotices(current.taskId, taskRunId, finishedAt);
    } else if (outcome.errorCode === "external-prerequisite-unavailable") {
      // The workflow names the missing component by the run event its metadata declares.
      const recorded = new Set(current.events.map((event) => event.code));
      for (const prerequisite of taskById(current.taskId)?.externalPrerequisites ?? []) {
        if (!isValidExternalPrerequisiteMetadata(prerequisite)) continue;
        if (!recorded.has(prerequisite.unavailableEventCode)) continue;
        await persistence.upsertTaskPrerequisiteNotice({
          taskId: current.taskId,
          prerequisiteId: prerequisite.id,
          taskRunId,
          detectedAt: finishedAt,
        });
      }
    }
  }
  const finalized = await persistence.taskRunById(taskRunId);
  if (!finalized) throw new Error(`Missing automation task run: ${taskRunId}`);
  return finalized;
}

/**
 * The App's page lookup (ADR 0067): the page hosted by the current Workflow
 * execution of the Active run with that id.
 */
export function activeRunPageLookup(
  activeRun: (taskRunId: string) => ActiveAutomationTaskRun | null,
): PageForRun {
  return (taskRunId) => activeRun(taskRunId)?.currentExecution()?.page() ?? null;
}

export function openActiveTaskRun(input: Readonly<{
  run: AutomationTaskRun;
  persistence: AutomationPersistencePort;
  runtime: RuntimeStatePort;
  forceQuitAvailableAfterMs?: number;
  dataVersionStore?: DataVersionStore;
}>): ActiveAutomationTaskRun {
  const { persistence, runtime } = input;
  const taskRunId = input.run.taskRunId;
  const stopController = new AbortController();
  const forceController = new AbortController();
  let row = input.run;
  let stop: TaskRunStop | null = null;
  let attempts: readonly CommitAttempt[] = [];
  let recording: Promise<unknown> = Promise.resolve();
  let cancellationRequestedAt: string | null = null;
  let forceTerminateAvailable = false;
  let forceQuitTimer: ReturnType<typeof setTimeout> | undefined;
  let finishing: Promise<AutomationTaskRun> | undefined;
  let writes: Promise<unknown> = Promise.resolve();

  // Writes are serialized so each transition is checked against the status
  // the previous write left, never against a status another write is replacing.
  const serialized = <T>(write: () => Promise<T>): Promise<T> => {
    const next = writes.then(write);
    writes = next.catch(() => undefined);
    return next;
  };

  const publish = () => {
    runtime.upsert({
      ...runtimeTaskSnapshotFromRun(row),
      ...(cancellationRequestedAt === null ? {} : { cancellationRequestedAt, forceTerminateAvailable }),
    });
  };

  const transition = (status: ActiveTaskRunStatus, fields: ActiveTaskRunFields = {}) =>
    serialized(async () => {
      if (finishing || !canTransitionTaskRun(row.status, status)) return false;
      const result = await persistence.transitionTaskRunToActive(taskRunId, { ...fields, status });
      if (!result.applied) return false;
      row = { ...row, ...fields, status };
      publish();
      return true;
    });

  // Decided when the append is accepted, not when its turn in the chain comes:
  // an event accepted before finish() is stored before the terminal write,
  // which reads the stored events for prerequisite notices.
  const persistEvent = (event: WorkflowRunEvent): Promise<void> =>
    finishing ? Promise.resolve() : serialized(() => persistence.appendRunEvent(event));

  let currentExecution: WorkflowExecution | null = null;
  const beginExecution = (executionId: string, options: WorkflowExecutionOptions = {}): WorkflowExecution => {
    if (finishing) throw new Error(`Automation task run has finished: ${taskRunId}`);
    if (currentExecution) {
      throw new Error(`Workflow execution ${currentExecution.executionId} of run ${taskRunId} is still current.`);
    }
    const log: WorkflowRunEvent[] = [];
    let ended = false;
    let route = options.assistanceRoute ?? null;
    let scope = options.collectionScope ?? null;
    let waiter: HumanAssistanceWaiter | null = null;
    let hostedPage: HostedBrowserPage | null = null;
    const endedError = () => new Error(`Workflow execution ${executionId} has ended.`);
    const execution: WorkflowExecution = {
      executionId,
      assistanceRoute: () => route,
      holdAssistance() {
        if (ended) throw endedError();
        if (waiter) throw new Error("This workflow run already has a pending human assistance request.");
        let settle!: (status: HumanAssistanceResolution) => void;
        let fail!: (error: Error) => void;
        const completion = new Promise<HumanAssistanceResolution>((resolve, reject) => {
          settle = resolve;
          fail = reject;
        });
        // A waiter released before anyone awaits it must not surface as unhandled.
        completion.catch(() => undefined);
        const held: HumanAssistanceWaiter = {
          completion,
          resolve(status) {
            if (waiter === held) waiter = null;
            settle(status);
          },
          reject(error) {
            if (waiter === held) waiter = null;
            fail(error);
          },
        };
        waiter = held;
        return held;
      },
      pendingAssistance: () => waiter,
      collectionScope: () => scope,
      hostPage(hosted) {
        if (ended) throw endedError();
        if (hostedPage) throw new Error(`Workflow execution ${executionId} already hosts a browser page.`);
        hostedPage = hosted;
        return () => {
          if (hostedPage === hosted) hostedPage = null;
        };
      },
      page: () => hostedPage?.page ?? null,
      browserConnection: () => hostedPage?.connection ?? null,
      events: () => [...log],
      appendEvent(event) {
        if (ended) return Promise.reject(new Error(`Workflow execution ${executionId} has ended.`));
        log.push(event);
        return persistEvent(event);
      },
      end() {
        ended = true;
        route = null;
        scope = null;
        hostedPage = null;
        waiter?.reject(endedError());
        if (currentExecution === execution) currentExecution = null;
      },
    };
    currentExecution = execution;
    return execution;
  };

  const run: ActiveAutomationTaskRun = {
    taskId: row.taskId,
    taskRunId,
    persistence,
    beginExecution,
    currentExecution: () => currentExecution,
    appendEvent: persistEvent,
    signal: stopController.signal,
    forceSignal: forceController.signal,
    stopReason: () => stop,
    current: () => row,
    transition,
    update: (fields) => serialized(async () => {
      if (finishing) return;
      await persistence.updateTaskRun(taskRunId, fields);
      row = { ...row, ...fields };
      publish();
    }),
    updateHumanAssistanceContract: (contract) => serialized(async () => {
      if (finishing) throw new Error(`Automation task run has finished: ${taskRunId}`);
      const recorded = await persistence.updateHumanAssistanceContract(taskRunId, contract);
      row = { ...row, humanAssistanceContract: recorded };
      return recorded;
    }),
    updateHumanAssistanceCompletion: (status) => serialized(async () => {
      if (finishing) throw new Error(`Automation task run has finished: ${taskRunId}`);
      const recorded = await persistence.updateHumanAssistanceCompletion(taskRunId, status);
      row = { ...row, humanAssistanceContract: recorded };
      return recorded;
    }),
    recordCommitAttempt(report) {
      const recorded = recording.then(async () => {
        // A settlement describes a commit that already ran, so it counts even
        // if storing it fails. The worker commits only after a start is
        // stored, so a start counts once it is durable.
        if (report.phase === "settled") attempts = applyCommitAttemptReport(attempts, report);
        await persistence.recordCommitAttempt(taskRunId, report);
        if (report.phase === "started") attempts = applyCommitAttemptReport(attempts, report);
      });
      recording = recorded.catch(() => undefined);
      return recorded;
    },
    async requestStop(reason) {
      if (finishing) return;
      if (stop === null || STOP_RANK[reason] > STOP_RANK[stop]) stop = reason;
      if (reason !== "shutdown") {
        cancellationRequestedAt ??= new Date().toISOString();
        if (reason === "forced") forceTerminateAvailable = true;
      }
      if (!stopController.signal.aborted) stopController.abort(reason);
      if (reason === "forced" && !forceController.signal.aborted) forceController.abort(reason);
      if (reason === "cancelled" && forceQuitTimer === undefined && !forceTerminateAvailable) {
        forceQuitTimer = setTimeout(() => {
          if (finishing) return;
          forceTerminateAvailable = true;
          publish();
        }, input.forceQuitAvailableAfterMs ?? FORCE_QUIT_AVAILABLE_AFTER_MS);
        forceQuitTimer.unref?.();
      }
      if (reason === "shutdown") return;
      if (!(await transition("cancelling")) && !finishing) publish();
    },
    assess: (report) => decide(attempts, report, null),
    finish(report) {
      finishing ??= serialized(async () => {
        if (forceQuitTimer) clearTimeout(forceQuitTimer);
        await recording;
        row = await persistTerminal(
          persistence,
          taskRunId,
          decide(attempts, report, stop),
          attempts,
          input.dataVersionStore ?? defaultDataVersionStore,
        );
        runtime.upsert(runtimeTaskSnapshotFromRun(row));
        return row;
      });
      return finishing;
    },
  };
  publish();
  return run;
}

/**
 * Finish the runs a previous process left active. No Active Automation Task
 * Run owns them, so their stored Commit attempts decide: an unsettled one is
 * commit outcome unknown, and any other leftover row is an Interrupted run.
 */
export async function finalizeOrphanedRuns(
  provider: AutomationPersistenceProvider,
  options: Readonly<{ dataVersionStore?: DataVersionStore }> = {},
): Promise<void> {
  const persistence = provider.automation;
  const errors: unknown[] = [];
  try {
    for (const run of await persistence.activeTaskRuns()) {
      try {
        const attempts = await persistence.commitAttempts(run.taskRunId);
        const report = { summary: run.appWorkflowOutcome?.summary ?? null, failure: null };
        await persistTerminal(
          persistence,
          run.taskRunId,
          decide(attempts, report, "shutdown"),
          attempts,
          options.dataVersionStore ?? defaultDataVersionStore,
        );
      } catch (error) {
        errors.push(error);
      }
    }
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) throw new AggregateError(errors, "Failed to finalize persisted automation runs");
}
