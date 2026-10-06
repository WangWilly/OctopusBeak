import assert from "node:assert/strict";
import test from "node:test";
import type {
  AutomationDesktopModel,
  AutomationRuntimeSnapshot,
  AutomationRuntimeTaskSnapshot,
} from "../desktop/api.ts";
import type { AutomationTaskRow } from "../automation/types.ts";
import type { OverviewPageDto } from "../overview/types.ts";
import { createOnboardingApplicationPort } from "./application-port.ts";
import type { OnboardingRun } from "./state.ts";

const run: OnboardingRun = {
  taskId: "bank-task",
  runId: "run-1",
  startedAt: "2026-10-04T04:00:00.000Z",
  startToken: "progress-1:start:1",
};

function emptyOverview(): OverviewPageDto {
  return {
    availability: "empty",
    coverage: "unavailable",
    historyAvailability: "unavailable",
    sourceGaps: [],
    importedAt: null,
    summary: [],
    dailyHistory: [],
    dailyHistoryByAccount: {},
    accounts: [],
    holdingPrices: [],
    exchangeRates: [],
  };
}

function awaitingOverview(accounts: OverviewPageDto["accounts"] = []): OverviewPageDto {
  return {
    ...emptyOverview(),
    availability: "awaiting",
    coverage: "partial",
    sourceGaps: [{
      accountId: "fubon-account",
      sourceConnectionKey: "fubon",
      accountNo: null,
      reason: "source-not-collected",
    }],
    accounts,
  };
}

function model(taskOverrides: Partial<AutomationTaskRow> = {}): AutomationDesktopModel {
  const task = {
    id: "bank-task",
    label: "Bank workflow",
    kind: "sync",
    credentialGroupId: "bank",
    credentialKeys: [],
    dependencies: [],
    status: "running",
    attempt: 1,
    maxAttempts: 1,
    latestStartedAt: run.startedAt,
    latestFinishedAt: null,
    appWorkflowOutcome: null,
    events: [],
    progressPercent: null,
    progressText: "Running",
    humanSession: null,
    humanAssistanceContract: null,
    isActive: true,
    ranToday: true,
    primaryAction: "Cancel",
    canRun: true,
    ...taskOverrides,
  } as AutomationTaskRow;
  return {
    automation: {
      businessDate: "2026-10-04",
      active: task.isActive,
      activeTaskCount: Number(task.isActive),
      parallelRunnableTaskIds: [],
      credentials: {},
      externalPrerequisiteNotices: [],
      tasks: [task],
    },
    credentialGroups: [],
  };
}

function snapshot(
  status: AutomationRuntimeTaskSnapshot["status"],
  overrides: Partial<AutomationRuntimeTaskSnapshot> = {},
): AutomationRuntimeSnapshot {
  return {
    sessionId: "session-1",
    revision: 1,
    tasks: [{
      taskId: "bank-task",
      runId: "run-1",
      status,
      attempt: 1,
      maxAttempts: 1,
      progress: { phaseCode: null, completed: null, total: null, percent: null, attempt: 1 },
      appWorkflowOutcome: null,
      updatedAt: "2026-10-04T04:01:00.000Z",
      ...overrides,
    }],
  };
}

function dependencies(options: {
  loadAutomation?: () => Promise<AutomationDesktopModel>;
  loadOverview?: () => Promise<OverviewPageDto>;
  runtimeSnapshot?: () => Promise<AutomationRuntimeSnapshot>;
  cancelTask?: (taskId: string, expectedRunId?: string) => Promise<unknown>;
  forceTerminateTask?: (taskId: string, expectedRunId?: string) => Promise<unknown>;
  wait?: (milliseconds: number) => Promise<void>;
} = {}) {
  return {
    persist: () => {},
    now: () => "2026-10-04T04:00:00.000Z",
    navigate: () => {},
    loadAutomation: options.loadAutomation ?? (async () => model()),
    loadOverview: options.loadOverview ?? (async () => emptyOverview()),
    runtimeSnapshot: options.runtimeSnapshot ?? (async () => snapshot("running")),
    cancelTask: options.cancelTask ?? (async () => {}),
    forceTerminateTask: options.forceTerminateTask ?? (async () => {}),
    wait: options.wait ?? (async () => {}),
    cancellationTimeoutMs: 1_000,
    cancellationPollIntervalMs: 1,
  };
}

test("fresh Overview preparation accepts an explicit empty DTO without import metadata", async () => {
  let overviewReads = 0;
  const port = createOnboardingApplicationPort(dependencies({
    loadAutomation: async () => model({ status: "running", isActive: true }),
    runtimeSnapshot: async () => snapshot("completed"),
    loadOverview: async () => {
      overviewReads += 1;
      return emptyOverview();
    },
  }));

  assert.equal(await port.prepareOverview(run), "empty");
  assert.equal(overviewReads, 1);
});

test("awaiting zero-account Overview requires explicit no-data evidence from the tracked run", async () => {
  const unproven = createOnboardingApplicationPort(dependencies({
    loadAutomation: async () => model({ status: "completed", isActive: false }),
    runtimeSnapshot: async () => snapshot("completed"),
    loadOverview: async () => awaitingOverview(),
  }));
  await assert.rejects(unproven.prepareOverview(run), /still awaiting data/);

  const noDataOutcome = { errorCode: null, summary: { status: "no-data" as const, counts: {} } };
  const proven = createOnboardingApplicationPort(dependencies({
    loadAutomation: async () => model({
      status: "completed",
      isActive: false,
      appWorkflowOutcome: noDataOutcome,
    }),
    runtimeSnapshot: async () => snapshot("completed", { appWorkflowOutcome: noDataOutcome }),
    loadOverview: async () => awaitingOverview(),
  }));
  assert.equal(await proven.prepareOverview(run), "workflow-no-data");
});

test("typed no-data product dispositions are accepted, but skipped or unavailable data is not", async () => {
  const productOutcome = {
    errorCode: null,
    summary: {
      counts: {},
      products: [
        { typeId: "deposit", status: "no_data", itemCount: 0, committedCount: 0 },
        { typeId: "credit_card", status: "not_held", itemCount: 0, committedCount: 0 },
      ],
    },
  } as const;
  const productNoData = createOnboardingApplicationPort(dependencies({
    loadAutomation: async () => model({ status: "completed", isActive: false, appWorkflowOutcome: productOutcome }),
    runtimeSnapshot: async () => snapshot("completed", { appWorkflowOutcome: productOutcome }),
    loadOverview: async () => awaitingOverview(),
  }));
  assert.equal(await productNoData.prepareOverview(run), "workflow-no-data");

  const skippedProductOutcome = {
    errorCode: null,
    summary: {
      counts: {},
      products: [
        { typeId: "deposit", status: "no_data", itemCount: 0, committedCount: 0 },
        { typeId: "fund", status: "skipped", itemCount: 0, committedCount: 0, skipReason: "not_attempted" },
      ],
    },
  } as const;
  const skipped = createOnboardingApplicationPort(dependencies({
    loadAutomation: async () => model({ status: "completed", isActive: false, appWorkflowOutcome: skippedProductOutcome }),
    runtimeSnapshot: async () => snapshot("completed", { appWorkflowOutcome: skippedProductOutcome }),
    loadOverview: async () => awaitingOverview(),
  }));
  await assert.rejects(skipped.prepareOverview(run), /still awaiting data/);

  const unavailable = createOnboardingApplicationPort(dependencies({
    loadAutomation: async () => model({ status: "completed", isActive: false, appWorkflowOutcome: productOutcome }),
    runtimeSnapshot: async () => snapshot("completed", { appWorkflowOutcome: productOutcome }),
    loadOverview: async () => ({ ...awaitingOverview(), availability: "unavailable" }),
  }));
  await assert.rejects(unavailable.prepareOverview(run), /data is unavailable/);
});

test("partial coverage with actual accounts remains ready for Overview", async () => {
  const port = createOnboardingApplicationPort(dependencies({
    loadAutomation: async () => model({ status: "completed", isActive: false }),
    runtimeSnapshot: async () => snapshot("completed"),
    loadOverview: async () => awaitingOverview([{ id: "account-1" } as never]),
  }));

  assert.equal(await port.prepareOverview(run), "accounts");
});

test("stale run, partial outcome, and Overview read errors cannot complete preparation", async () => {
  let overviewReads = 0;
  const staleRun = createOnboardingApplicationPort(dependencies({
    loadAutomation: async () => model({ runId: "run-new", status: "completed", isActive: false }),
    runtimeSnapshot: async () => snapshot("completed", { runId: "run-new" }),
    loadOverview: async () => {
      overviewReads += 1;
      return emptyOverview();
    },
  }));
  await assert.rejects(staleRun.prepareOverview(run), /no longer the current run/);
  assert.equal(overviewReads, 0);

  const partial = createOnboardingApplicationPort(dependencies({
    loadAutomation: async () => model({ status: "completed", isActive: false }),
    runtimeSnapshot: async () => snapshot("partial", {
      appWorkflowOutcome: { errorCode: "workflow-failed", summary: { status: "partial", counts: {} } },
    }),
    loadOverview: async () => {
      overviewReads += 1;
      return emptyOverview();
    },
  }));
  await assert.rejects(partial.prepareOverview(run), /has not completed successfully/);
  assert.equal(overviewReads, 0);

  const readError = new Error("Overview subscription failed");
  const unreadable = createOnboardingApplicationPort(dependencies({
    loadAutomation: async () => model({ status: "completed", isActive: false }),
    runtimeSnapshot: async () => snapshot("completed"),
    loadOverview: async () => { throw readError; },
  }));
  await assert.rejects(unreadable.prepareOverview(run), readError);
});

test("restart waits for observed terminal state after the cancellation API acknowledges", async () => {
  const states = [snapshot("running"), snapshot("cancelling"), snapshot("cancelled")];
  let reads = 0;
  let waitCalls = 0;
  let expectedCancelledRunId: string | undefined;
  let cancellationAcknowledged = false;
  let terminalObserved = false;
  let resolved = false;
  let releasePoll!: () => void;
  const pollRelease = new Promise<void>((resolve) => { releasePoll = resolve; });
  const port = createOnboardingApplicationPort(dependencies({
    loadAutomation: async () => model({ status: "running", isActive: true }),
    runtimeSnapshot: async () => {
      const current = states[Math.min(reads++, states.length - 1)]!;
      if (current.tasks[0]?.status === "cancelled") terminalObserved = true;
      return current;
    },
    cancelTask: async (_taskId, expectedRunId) => {
      cancellationAcknowledged = true;
      expectedCancelledRunId = expectedRunId;
      return { cancelled: "bank-task" };
    },
    wait: async () => {
      waitCalls += 1;
      await pollRelease;
    },
  }));

  const cancellation = port.cancelRun(run).then(() => { resolved = true; });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(cancellationAcknowledged, true);
  assert.equal(expectedCancelledRunId, "run-1");
  assert.equal(terminalObserved, false);
  assert.equal(resolved, false);
  assert.ok(waitCalls > 0);

  releasePoll();
  await cancellation;
  assert.equal(terminalObserved, true);
  assert.equal(resolved, true);
});

test("force termination is scoped to the tracked run and only after the grace flag", async () => {
  const states = [
    snapshot("running"),
    snapshot("cancelling", { forceTerminateAvailable: false }),
    snapshot("cancelling", { forceTerminateAvailable: true }),
    snapshot("cancelled"),
  ];
  let reads = 0;
  const terminated: string[] = [];
  const expectedTerminatedRunIds: Array<string | undefined> = [];
  const port = createOnboardingApplicationPort(dependencies({
    loadAutomation: async () => model({ status: "running", isActive: true }),
    runtimeSnapshot: async () => states[Math.min(reads++, states.length - 1)]!,
    forceTerminateTask: async (taskId, expectedRunId) => {
      terminated.push(taskId);
      expectedTerminatedRunIds.push(expectedRunId);
    },
  }));

  await port.cancelRun(run);
  assert.deepEqual(terminated, ["bank-task"]);
  assert.deepEqual(expectedTerminatedRunIds, ["run-1"]);
  assert.equal(reads, 4);
});

test("an unrelated newer run under the same task id is never cancelled", async () => {
  const cancelled: string[] = [];
  const port = createOnboardingApplicationPort(dependencies({
    loadAutomation: async () => model({ runId: "run-new", status: "running", isActive: true }),
    runtimeSnapshot: async () => snapshot("running", { runId: "run-new" }),
    cancelTask: async (taskId) => { cancelled.push(taskId); },
  }));

  await port.cancelRun(run);
  assert.deepEqual(cancelled, []);
});
