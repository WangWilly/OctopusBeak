import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import { createDataVersionStore, type DataVersionStore } from "../../shared-shell/data-version.ts";
import type { CommitAttemptReport } from "../commit-attempt.ts";
import {
  finalizeOrphanedRuns,
  openActiveTaskRun,
  type TaskRunFailure,
  type TaskRunReport,
  type TaskRunStop,
} from "./active-task-run.ts";
import { hydrateAutomationRuntimeState } from "./runner.ts";
import { createAutomationRuntimeState } from "./runtime-state.ts";
import type { AutomationTaskStatus } from "./store.ts";
import type { TypedWorkflowOutcomeSummary } from "./typed-workflow-outcome.ts";
import { createTestPGlite } from "../../../ledger/pglite/baseline-test-template.ts";

const database = await createTestPGlite("operational");
const store = new PGliteStore(database);
after(() => database.close());
const provider = createPgliteOperationalProvider(store);
const persistence = provider.automation;

async function createRun(taskId = "exchange-rates", status: AutomationTaskStatus = "preparing") {
  const kind = taskId.startsWith("sync-") || taskId === "exchange-rates" ? "sync" : "crawler";
  const { taskRunId } = await persistence.createTaskRun({
    taskId, kind, status, attempt: 1, maxAttempts: 1, startedAt: new Date().toISOString(),
  });
  return taskRunId;
}

async function open(options: {
  taskId?: string;
  status?: AutomationTaskStatus;
  forceQuitAvailableAfterMs?: number;
  dataVersionStore?: DataVersionStore;
} = {}) {
  const taskRunId = await createRun(options.taskId, options.status);
  const runtime = createAutomationRuntimeState();
  const row = await persistence.taskRunById(taskRunId);
  const run = openActiveTaskRun({
    run: row!,
    persistence,
    runtime,
    dataVersionStore: options.dataVersionStore ?? createDataVersionStore(),
    ...(options.forceQuitAvailableAfterMs === undefined ? {} : { forceQuitAvailableAfterMs: options.forceQuitAvailableAfterMs }),
  });
  const published = () => runtime.snapshot().tasks.find((task) => task.runId === taskRunId);
  return { run, runtime, published, taskRunId };
}

const ok = (summary: TypedWorkflowOutcomeSummary | null = null): TaskRunReport => ({ summary, failure: null });
const fail = (
  code: TaskRunFailure["code"],
  summary: TypedWorkflowOutcomeSummary | null = null,
  proven = true,
): TaskRunReport => ({ summary, failure: { code, proven } });
const started = (attemptId: string): CommitAttemptReport =>
  ({ phase: "started", attemptId, product: "deposit", total: 1 });
const settled = (attemptId: string, outcome: "completed" | "failed" | "refused", committedCount = 0): CommitAttemptReport =>
  ({ phase: "settled", attemptId, outcome, committedCount });

const complete = { status: "completed", counts: {} } as const;
const partial = {
  status: "partial",
  counts: { committedCount: 1, itemCount: 1 },
  products: [{ typeId: "deposit", status: "success", itemCount: 1, committedCount: 1 }],
} as const;
const incomplete: TypedWorkflowOutcomeSummary = {
  status: "partial",
  counts: { committedCount: 1, itemCount: 1, excludedUnknownInstitutionCount: 1 },
  products: [{
    typeId: "settlement", status: "success", itemCount: 1, committedCount: 1,
    collection: { status: "incomplete", exclusionCounts: { excludedUnknownInstitutionCount: 1 } },
  }],
};

type Scenario = Readonly<{
  name: string;
  attempts?: readonly CommitAttemptReport[];
  report: TaskRunReport;
  stops?: readonly TaskRunStop[];
  expected: Readonly<{ status: string; errorCode: string | null; forced?: boolean }>;
}>;

const scenarios: Scenario[] = [
  { name: "a success report without a summary", report: ok(), expected: { status: "completed", errorCode: null } },
  { name: "a successful typed summary", report: ok(complete), expected: { status: "completed", errorCode: null } },
  {
    name: "a typed failure overrides a completed summary",
    report: fail("source-integrity-failed", complete),
    expected: { status: "failed", errorCode: "source-integrity-failed" },
  },
  {
    name: "a failed summary without a code keeps its null code",
    report: ok({ status: "failed", counts: {} }),
    expected: { status: "failed", errorCode: null },
  },
  { name: "a partial summary without a fatal code", report: ok(partial), expected: { status: "partial", errorCode: null } },
  {
    name: "a non-TDCC partial summary cannot mask a typed fatal error",
    report: fail("source-unavailable", partial),
    expected: { status: "failed", errorCode: "source-unavailable" },
  },
  {
    name: "a TDCC incomplete collection with durable receipts keeps the interruption code",
    report: fail("source-unavailable", incomplete),
    expected: { status: "partial", errorCode: "source-unavailable" },
  },
  {
    name: "TDCC durable receipts keep partial even when the interrupted summary says failed",
    report: fail("source-unavailable", { ...incomplete, status: "failed" }),
    expected: { status: "partial", errorCode: "source-unavailable" },
  },
  {
    name: "a TDCC incomplete collection without receipts cannot override failure",
    report: fail("source-unavailable", {
      ...incomplete, status: "failed", counts: { committedCount: 0 },
      products: incomplete.products!.map((product) => ({ ...product, committedCount: 0 })),
    }),
    expected: { status: "failed", errorCode: "source-unavailable" },
  },
  {
    name: "inconsistent TDCC receipt counts cannot override failure",
    report: fail("source-unavailable", { ...incomplete, counts: { committedCount: 2 } }),
    expected: { status: "failed", errorCode: "source-unavailable" },
  },
  {
    name: "a workflow-reported cancellation overrides TDCC durable receipts",
    report: fail("cancelled", incomplete),
    expected: { status: "cancelled", errorCode: "cancelled" },
  },
  {
    name: "an unsettled attempt without a summary is commit outcome unknown",
    attempts: [started("a")],
    report: fail("workflow-failed", null, false),
    expected: { status: "failed", errorCode: "commit-outcome-unknown" },
  },
  {
    name: "an unsettled attempt outranks TDCC durable receipts",
    attempts: [started("a")],
    report: fail("source-unavailable", incomplete),
    expected: { status: "failed", errorCode: "commit-outcome-unknown" },
  },
  {
    name: "an unsettled attempt from an earlier round outranks a later successful round",
    attempts: [started("round-1"), started("round-2"), settled("round-2", "completed", 1)],
    report: ok(complete),
    expected: { status: "failed", errorCode: "commit-outcome-unknown" },
  },
  {
    name: "an unsettled attempt outranks a code the worker proved",
    attempts: [started("a")],
    report: fail("source-validation-failed"),
    expected: { status: "failed", errorCode: "commit-outcome-unknown" },
  },
  {
    name: "a refused attempt names the run even when the worker completed",
    attempts: [started("a"), settled("a", "refused")],
    report: ok(complete),
    expected: { status: "failed", errorCode: "collection-scope-changed" },
  },
  {
    name: "a refused attempt outranks a code the worker proved",
    attempts: [started("a"), settled("a", "completed", 1), started("b"), settled("b", "refused")],
    report: fail("workflow-failed"),
    expected: { status: "failed", errorCode: "collection-scope-changed" },
  },
  {
    name: "a refused attempt never hides an unsettled one",
    attempts: [started("a"), started("b"), settled("b", "refused")],
    report: fail("workflow-failed", null, false),
    expected: { status: "failed", errorCode: "commit-outcome-unknown" },
  },
  {
    name: "a failed attempt explains a failure classified from events",
    attempts: [started("a"), settled("a", "failed")],
    report: fail("authentication-failed", null, false),
    expected: { status: "failed", errorCode: "canonical-commit-failed" },
  },
  {
    name: "a code the worker proved outranks a failed attempt",
    attempts: [started("a"), settled("a", "failed")],
    report: fail("source-validation-failed"),
    expected: { status: "failed", errorCode: "source-validation-failed" },
  },
  {
    name: "a failed attempt does not fail a completed workflow",
    attempts: [started("a"), settled("a", "failed")],
    report: ok(complete),
    expected: { status: "completed", errorCode: null },
  },
  {
    name: "a classified failure with no attempt keeps its code",
    report: fail("authentication-failed", null, false),
    expected: { status: "failed", errorCode: "authentication-failed" },
  },
];

const STOP_EXPECTATIONS: Readonly<Record<TaskRunStop, Scenario["expected"]>> = {
  forced: { status: "cancelled", errorCode: "cancelled", forced: true },
  cancelled: { status: "cancelled", errorCode: "cancelled" },
  shutdown: { status: "interrupted", errorCode: "cancelled" },
};

for (const stop of ["forced", "cancelled", "shutdown"] as const) {
  for (const report of [ok(complete), fail("source-unavailable", incomplete), fail("workflow-failed"), fail("cancelled")]) {
    scenarios.push({
      name: `a ${stop} stop outranks a ${report.failure?.code ?? "success"} report`,
      report,
      stops: [stop],
      expected: STOP_EXPECTATIONS[stop],
    });
  }
  scenarios.push({
    name: `a ${stop} stop outranks a refused attempt`,
    attempts: [started("a"), settled("a", "refused")],
    report: fail("workflow-failed"),
    stops: [stop],
    expected: STOP_EXPECTATIONS[stop],
  });
  for (const summary of [null, incomplete]) {
    scenarios.push({
      name: `an unsettled attempt outranks a ${stop} stop, ${summary ? "with" : "without"} earlier receipts`,
      attempts: [started("a")],
      report: fail("workflow-failed", summary, false),
      stops: [stop],
      expected: { status: "failed", errorCode: "commit-outcome-unknown" },
    });
  }
}

for (const scenario of scenarios) {
  test(`outcome: ${scenario.name}`, async () => {
    const { run, taskRunId } = await open();
    assert.equal(await run.transition("running"), true);
    for (const attempt of scenario.attempts ?? []) await run.recordCommitAttempt(attempt);
    for (const stop of scenario.stops ?? []) await run.requestStop(stop);
    const expected = { forced: false, ...scenario.expected };
    if (!scenario.stops?.length) {
      const assessed = run.assess(scenario.report);
      assert.deepEqual(
        { status: assessed.status, errorCode: assessed.errorCode, forced: assessed.forced },
        expected,
        "without a stop, assess answers what finish persists",
      );
    }
    const finished = await run.finish(scenario.report);
    assert.deepEqual(
      { status: finished.status, errorCode: finished.appWorkflowOutcome?.errorCode ?? null, forced: finished.terminationMode === "forced" },
      expected,
    );
    assert.equal((await persistence.taskRunById(taskRunId))?.status, expected.status);
  });
}

test("assess leaves the stop to the caller", async () => {
  const { run } = await open();
  await run.recordCommitAttempt(started("a"));
  await run.recordCommitAttempt(settled("a", "completed", 1));
  await run.requestStop("cancelled");
  assert.equal(run.assess(fail("captcha-provider-rejected")).errorCode, "captcha-provider-rejected");
  assert.equal(run.assess(ok(complete)).status, "completed");
  assert.equal((await run.finish(ok(complete))).status, "cancelled");
});

test("the outcome keeps the reported summary", async () => {
  const { run } = await open();
  await run.requestStop("cancelled");
  assert.deepEqual((await run.finish(ok(partial))).appWorkflowOutcome?.summary, partial);
});

test("cancellation state survives later progress writes in the published snapshot", async () => {
  const { run, published } = await open({ forceQuitAvailableAfterMs: 20 });
  assert.equal(await run.transition("running"), true);
  await run.requestStop("cancelled");
  const requestedAt = published()?.cancellationRequestedAt;
  assert.ok(requestedAt);
  assert.equal(published()?.forceTerminateAvailable, false);

  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  assert.equal(published()?.forceTerminateAvailable, true, "force-quit is offered once cleanup had its time");
  await run.update({ progress: { phaseCode: "sync", completed: 1, total: 3, percent: 33, attempt: 1 } });
  assert.equal(published()?.status, "cancelling");
  assert.equal(published()?.cancellationRequestedAt, requestedAt);
  assert.equal(published()?.forceTerminateAvailable, true, "a progress write keeps the force-quit control");
  assert.equal(published()?.progress.percent, 33);
  await run.finish(ok());
});

test("a cancelling run refuses every move except its end", async () => {
  const { run, taskRunId } = await open();
  assert.equal(await run.transition("running"), true);
  await run.requestStop("cancelled");
  for (const status of ["running", "waiting_for_human", "queued", "preparing"] as const) {
    assert.equal(await run.transition(status), false, `cancelling moved to ${status}`);
  }
  assert.equal((await persistence.taskRunById(taskRunId))?.status, "cancelling");
  assert.equal((await run.finish(ok())).status, "cancelled");
});

test("finish persists once and ignores later writes", async () => {
  const { run, published, taskRunId } = await open();
  assert.equal(await run.transition("running"), true);
  const [first, second] = await Promise.all([run.finish(ok()), run.finish(fail("workflow-failed"))]);
  assert.equal(first.status, "completed");
  assert.equal(second, first);
  assert.equal(await run.transition("running"), false);
  await run.update({ attempt: 2 });
  await run.requestStop("cancelled");
  const saved = await persistence.taskRunById(taskRunId);
  assert.equal(saved?.status, "completed");
  assert.equal(saved?.attempt, 1);
  assert.equal(published()?.status, "completed");
  assert.equal(run.signal.aborted, false);
});

for (const { stops, status, forced } of [
  { stops: ["cancelled", "shutdown"], status: "cancelled", forced: false },
  { stops: ["shutdown", "cancelled"], status: "cancelled", forced: false },
  { stops: ["cancelled", "forced"], status: "cancelled", forced: true },
  { stops: ["shutdown"], status: "interrupted", forced: false },
] satisfies Array<{ stops: TaskRunStop[]; status: string; forced: boolean }>) {
  test(`stops ${stops.join(" then ")} end the run ${forced ? "force-quit" : status}`, async () => {
    const { run } = await open();
    assert.equal(await run.transition("running"), true);
    for (const stop of stops) await run.requestStop(stop);
    assert.equal(run.signal.aborted, true);
    assert.equal(run.forceSignal.aborted, forced);
    const finished = await run.finish(ok());
    assert.equal(finished.status, status);
    assert.equal(finished.terminationMode === "forced", forced);
  });
}

test("finish waits for a Commit attempt that is still being recorded", async () => {
  const { run } = await open();
  const recording = run.recordCommitAttempt(started("in-flight"));
  const finished = run.finish(ok(complete));
  await recording;
  assert.equal((await finished).appWorkflowOutcome?.errorCode, "commit-outcome-unknown");
});

test("a settlement the store failed to record still counts and marks data stale", async () => {
  const invalidations = createDataVersionStore();
  const { run, taskRunId } = await open({ taskId: "post-statements", dataVersionStore: invalidations });
  await run.recordCommitAttempt(started("a"));
  const record = persistence.recordCommitAttempt.bind(persistence);
  persistence.recordCommitAttempt = async () => { throw new Error("operational RPC unavailable"); };
  try {
    await assert.rejects(run.recordCommitAttempt(settled("a", "completed", 1)));
  } finally {
    persistence.recordCommitAttempt = record;
  }
  const saved = await run.finish(fail("workflow-failed", null, false));
  assert.equal(saved.appWorkflowOutcome?.errorCode, "workflow-failed", "the settlement was known to the owner");
  assert.equal(invalidations.snapshot().version, 1, "the settled commit may have changed data");
  assert.deepEqual((await persistence.commitAttempts(taskRunId)).map((attempt) => attempt.outcome), [null]);
});

test("a start the store failed to record is not an attempt, so nothing was committed", async () => {
  const invalidations = createDataVersionStore();
  const { run } = await open({ taskId: "post-statements", dataVersionStore: invalidations });
  const record = persistence.recordCommitAttempt.bind(persistence);
  persistence.recordCommitAttempt = async () => { throw new Error("operational RPC unavailable"); };
  try {
    await assert.rejects(run.recordCommitAttempt(started("a")));
  } finally {
    persistence.recordCommitAttempt = record;
  }
  const saved = await run.finish(fail("workflow-failed", null, false));
  assert.equal(saved.appWorkflowOutcome?.errorCode, "workflow-failed");
  assert.equal(invalidations.snapshot().version, 0);
});

test("a partial outcome invalidates data once without retaining log output", async () => {
  const invalidations = createDataVersionStore();
  const { run } = await open({ taskId: "fubon-all-statements", status: "running", dataVersionStore: invalidations });
  const summary = {
    status: "partial" as const,
    counts: { itemCount: 1, committedCount: 1 },
    products: [
      { typeId: "deposit" as const, status: "success" as const, itemCount: 1, committedCount: 1 },
      { typeId: "loan" as const, status: "failed" as const, itemCount: 0, committedCount: 0, errorCode: "source-collection-failed" as const },
    ],
  };
  const saved = await run.finish(ok(summary));
  assert.equal(saved.status, "partial");
  assert.deepEqual(saved.appWorkflowOutcome, { errorCode: null, summary });
  assert.equal(invalidations.snapshot().version, 1);
});

test("a forced cancellation retains product receipts, records force and invalidates data", async () => {
  const invalidations = createDataVersionStore();
  const { run } = await open({ taskId: "fubon-all-statements", status: "running", dataVersionStore: invalidations });
  const summary = {
    status: "completed" as const,
    counts: { itemCount: 1, committedCount: 1 },
    products: [{ typeId: "deposit" as const, status: "success" as const, itemCount: 1, committedCount: 1 }],
  } as const;
  await run.requestStop("forced");
  const saved = await run.finish(fail("cancelled", summary));
  assert.equal(saved.status, "cancelled");
  assert.equal(saved.terminationMode, "forced");
  assert.deepEqual(saved.appWorkflowOutcome, { errorCode: "cancelled", summary });
  assert.equal(invalidations.snapshot().version, 1, "a verified earlier product commit makes data stale after forced stop");
});

test("a settled Commit attempt invalidates data when a later worker crash has no summary", async () => {
  const invalidations = createDataVersionStore();
  const { run } = await open({ taskId: "yuanta-all-statements", status: "running", dataVersionStore: invalidations });
  await run.recordCommitAttempt(started("deposit-attempt"));
  await run.recordCommitAttempt(settled("deposit-attempt", "completed", 1));
  const saved = await run.finish(fail("workflow-failed", null, false));
  assert.equal(saved.status, "failed");
  assert.equal(invalidations.snapshot().version, 1, "only a durable Commit attempt proves earlier progress");
});

test("an unsettled Commit attempt invalidates data because the write may have landed", async () => {
  const invalidations = createDataVersionStore();
  const { run } = await open({ taskId: "yuanta-all-statements", status: "running", dataVersionStore: invalidations });
  await run.recordCommitAttempt(started("deposit-attempt"));
  await run.finish(fail("workflow-failed", null, false));
  assert.equal(invalidations.snapshot().version, 1);
});

test("a failure without receipts leaves fresh data alone", async () => {
  const invalidations = createDataVersionStore();
  const { run } = await open({ taskId: "yuanta-all-statements", status: "running", dataVersionStore: invalidations });
  await run.finish(fail("workflow-failed"));
  assert.equal(invalidations.snapshot().version, 0);
});

test("a typed App outcome is retained in run metadata", async () => {
  const { run } = await open({ taskId: "ctbc-statements", status: "running" });
  const summary = { status: "financial-admitted" as const, counts: { accountCount: 2, rowCount: 18, itemCount: 12 } };
  const saved = await run.finish(ok(summary));
  assert.equal(saved.status, "completed");
  assert.deepEqual(saved.appWorkflowOutcome, { errorCode: null, summary });
  assert.ok(saved.recordJson.includes('"appWorkflowOutcome"'));
});

test("a typed cancellation code ends the run cancelled without force", async () => {
  const { run } = await open({ taskId: "ctbc-statements", status: "running" });
  const saved = await run.finish(fail("cancelled"));
  assert.equal(saved.status, "cancelled");
  assert.equal(saved.appWorkflowOutcome?.errorCode, "cancelled");
  assert.equal(saved.terminationMode, undefined);
});

test("a completed run can leave the human-assistance waiting state", async () => {
  const { run } = await open({ taskId: "ctbc-statements", status: "waiting_for_human" });
  const saved = await run.finish(ok({ status: "financial-admitted", counts: { itemCount: 2 } }));
  assert.equal(saved.status, "completed");
});

test("two owners of one row persist one outcome and apply freshness and notices once", async () => {
  const resolveNotices = persistence.resolveTaskPrerequisiteNotices.bind(persistence);
  let noticesResolved = 0;
  persistence.resolveTaskPrerequisiteNotices = async (...args) => {
    noticesResolved += 1;
    return resolveNotices(...args);
  };
  try {
    const summary = { status: "completed", counts: { committedCount: 1, itemCount: 1 } } as const;
    const taskRunId = await createRun("yuanta-trade-statements", "running");
    const invalidations = createDataVersionStore();
    const row = await persistence.taskRunById(taskRunId);
    const owners = [0, 1].map(() => openActiveTaskRun({
      run: row!, persistence, runtime: createAutomationRuntimeState(), dataVersionStore: invalidations,
    }));
    const winners = await Promise.all(owners.map((owner) => owner.finish(ok(summary))));
    assert.deepEqual(winners.map((run) => run.status), ["completed", "completed"]);
    const late = openActiveTaskRun({
      run: row!, persistence, runtime: createAutomationRuntimeState(), dataVersionStore: invalidations,
    });
    assert.equal((await late.finish(fail("source-unavailable"))).status, "completed", "a later owner keeps the first outcome");
    assert.equal(invalidations.snapshot().version, 1);
    assert.equal(noticesResolved, 1);
  } finally {
    persistence.resolveTaskPrerequisiteNotices = resolveNotices;
  }
});

test("orphaned runs are interrupted before the runtime hydrates", async () => {
  const taskRunId = await createRun("exchange-rates", "queued");
  await finalizeOrphanedRuns(provider);
  const saved = await persistence.taskRunById(taskRunId);
  assert.equal(saved?.status, "interrupted");
  assert.ok(saved?.finishedAt);
  assert.deepEqual(await persistence.activeTaskRuns(), []);
  const runtime = await hydrateAutomationRuntimeState(provider, createAutomationRuntimeState());
  assert.equal(runtime.tasks.find((task) => task.taskId === "exchange-rates")?.status, "interrupted");
});

test("an orphaned run with an unsettled Commit attempt is commit outcome unknown", async () => {
  const taskRunId = await createRun("post-statements", "running");
  await persistence.recordCommitAttempt(taskRunId, started("post-attempt"));
  await finalizeOrphanedRuns(provider);
  const saved = await persistence.taskRunById(taskRunId);
  assert.equal(saved?.status, "failed", "an uncertain financial write outranks the interruption");
  assert.deepEqual(saved?.appWorkflowOutcome, { errorCode: "commit-outcome-unknown", summary: null });
});

test("an orphaned run whose attempts all settled is interrupted and still marks data stale", async () => {
  const taskRunId = await createRun("post-statements", "running");
  await persistence.recordCommitAttempt(taskRunId, started("post-attempt"));
  await persistence.recordCommitAttempt(taskRunId, settled("post-attempt", "completed", 1));
  const invalidations = createDataVersionStore();
  await finalizeOrphanedRuns(provider, { dataVersionStore: invalidations });
  const saved = await persistence.taskRunById(taskRunId);
  assert.equal(saved?.status, "interrupted");
  assert.deepEqual(saved?.appWorkflowOutcome, { errorCode: "cancelled", summary: null });
  assert.equal(invalidations.snapshot().version, 1);
});

test("an orphaned run with no Commit attempt is interrupted and leaves data fresh", async () => {
  const taskRunId = await createRun("post-statements", "running");
  const invalidations = createDataVersionStore();
  await finalizeOrphanedRuns(provider, { dataVersionStore: invalidations });
  const saved = await persistence.taskRunById(taskRunId);
  assert.equal(saved?.status, "interrupted");
  assert.equal(saved?.appWorkflowOutcome?.errorCode, "cancelled");
  assert.equal(invalidations.snapshot().version, 0);
});

test("an orphaned run keeps its typed summary under the quit's error code", async () => {
  const taskRunId = await createRun("exchange-rates", "running");
  await persistence.updateTaskRun(taskRunId, {
    appWorkflowOutcome: { errorCode: null, summary: { status: "completed", counts: { itemCount: 4 } } },
  });
  await finalizeOrphanedRuns(provider);
  const saved = await persistence.taskRunById(taskRunId);
  assert.equal(saved?.status, "interrupted");
  assert.deepEqual(saved?.appWorkflowOutcome, {
    errorCode: "cancelled",
    summary: { status: "completed", counts: { itemCount: 4 } },
  });
});
