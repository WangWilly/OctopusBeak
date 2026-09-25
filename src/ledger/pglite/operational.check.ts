import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import {
  applyPgliteOperationalBaseline,
  assertPgliteOperationalBaseline,
  createPgliteOperationalStore,
  PGLITE_OPERATIONAL_BASELINE_MANIFEST,
} from "./operational.ts";
import { PGliteStore } from "./transaction.ts";

const database = await PGlite.create();
const store = new PGliteStore(database);
try {
  await applyPgliteOperationalBaseline(store);
  const firstMetadata = await store.query<{ applied_at: string }>(
    "SELECT applied_at::text AS applied_at FROM pglite_operational_baseline_metadata WHERE singleton_id = 1",
  );
  await applyPgliteOperationalBaseline(store);
  await assertPgliteOperationalBaseline(store);
  const secondMetadata = await store.query<{ applied_at: string }>(
    "SELECT applied_at::text AS applied_at FROM pglite_operational_baseline_metadata WHERE singleton_id = 1",
  );
  assert.equal(secondMetadata.rows[0]?.applied_at, firstMetadata.rows[0]?.applied_at);

  const metadata = await store.query<{
    table_count: string;
    index_count: string;
    trigger_count: string;
  }>(
    "SELECT table_count, index_count, trigger_count FROM pglite_operational_baseline_metadata WHERE singleton_id = 1",
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(metadata.rows[0] ?? {}).map(([key, value]) => [key, Number(value)]),
    ),
    {
      table_count: PGLITE_OPERATIONAL_BASELINE_MANIFEST.tableCount,
      index_count: PGLITE_OPERATIONAL_BASELINE_MANIFEST.indexCount,
      trigger_count: PGLITE_OPERATIONAL_BASELINE_MANIFEST.triggerCount,
    },
  );

  const operational = createPgliteOperationalStore(store);
  const created = await operational.createTaskRun({
    taskId: "exchange-rates",
    script: "run:exchange-rates",
    kind: "sync",
    status: "running",
    attempt: 1,
    maxAttempts: 2,
    startedAt: "2026-09-22T00:00:00.000Z",
    errorMessage: "token=raw-error",
    logPath: "data/automation/logs/exchange-rates.log",
    logTail: "authorization=raw-token\nstarted",
  });
  assert.match(created.taskRunId, /^[0-9a-f-]{36}$/);
  const storedSensitive = await store.query<{
    error_message: string;
    log_tail: string;
    record_json: string;
  }>(
    "SELECT error_message, log_tail, record_json FROM automation_task_runs WHERE task_run_id = $1",
    [created.taskRunId],
  );
  assert.equal(storedSensitive.rows[0]?.error_message, "token=[REDACTED]");
  assert.equal(storedSensitive.rows[0]?.log_tail, "authorization=[REDACTED]\nstarted");
  assert.doesNotMatch(storedSensitive.rows[0]?.record_json ?? "", /raw-(?:error|token)/u);
  assert.match(storedSensitive.rows[0]?.record_json ?? "", /\[REDACTED\]/u);
  assert.equal((await operational.activeTaskRuns()).length, 1);
  assert.equal((await operational.taskRunById(created.taskRunId))?.status, "running");
  assert.equal((await operational.taskRunById(created.taskRunId))?.appWorkflowOutcome ?? null, null);

  await operational.updateTaskRun(created.taskRunId, {
    appWorkflowOutcome: {
      errorCode: "source-validation-failed",
      summary: {
        status: "partial",
        counts: {
          accountCount: 2,
          rowCount: 18,
          itemCount: 12,
          accountNumber: "sensitive-account-number",
        },
        rawResponse: "credential=must-not-persist",
      },
    } as never,
  });
  const safeOutcome = await operational.taskRunById(created.taskRunId);
  assert.deepEqual(safeOutcome?.appWorkflowOutcome, {
    errorCode: "source-validation-failed",
    summary: {
      status: "partial",
      counts: { accountCount: 2, rowCount: 18, itemCount: 12 },
    },
  });
  assert.doesNotMatch(safeOutcome?.recordJson ?? "", /sensitive-account-number|must-not-persist/u);
  await operational.appendRunEvent({
    runId: created.taskRunId,
    stage: "validation",
    code: "source-validation-rejected",
    occurredAt: "2026-09-22T00:00:00.000Z",
  });
  assert.equal(await operational.pruneRunEvents("2026-09-23T00:00:00.000Z"), 1);
  assert.deepEqual((await operational.taskRunById(created.taskRunId))?.appWorkflowOutcome, {
    errorCode: "source-validation-failed",
    summary: {
      status: "partial",
      counts: { accountCount: 2, rowCount: 18, itemCount: 12 },
    },
  });

  await operational.updateTaskRun(created.taskRunId, {
    logTail: "progress",
    progress: {
      phaseCode: "fetch",
      completed: 1,
      total: 2,
      percent: 50,
      attempt: 1,
    },
  });
  assert.equal((await operational.taskRunById(created.taskRunId))?.progress?.percent, 50);

  const occurrence = "2026-09-22T00:10:00.000Z";
  const scheduled = await operational.createTaskRun({
    taskId: "exchange-rates",
    script: `run:exchange-rates --scheduled-at-utc ${occurrence}`,
    kind: "sync",
    status: "failed",
    attempt: 1,
    maxAttempts: 1,
    startedAt: "2026-09-21T00:11:00.000Z",
    scheduledAtUtc: occurrence,
    logPath: "",
  });
  assert.equal((await operational.taskRunById(scheduled.taskRunId))?.scheduledAtUtc, occurrence);
  assert.equal(await operational.hasOccurrenceBeenAttempted("exchange-rates", occurrence), true);
  assert.equal(await operational.hasOccurrenceBeenAttempted("exchange-rates", "2026-09-22T00:12:00.000Z"), false);

  const legacyOccurrence = "2026-09-22T00:20:00.000Z";
  const legacyScheduled = await operational.createTaskRun({
    taskId: "exchange-rates",
    script: `run:exchange-rates --scheduled-at-utc ${legacyOccurrence}`,
    kind: "sync",
    status: "interrupted",
    attempt: 1,
    maxAttempts: 1,
    startedAt: "2026-09-21T00:13:00.000Z",
    logPath: "",
  });
  assert.ok(legacyScheduled.taskRunId);
  assert.equal(await operational.hasOccurrenceBeenAttempted("exchange-rates", legacyOccurrence), true);

  const contractInput = {
    stageId: "otp",
    title: "Enter OTP",
    targets: [{ id: "otp", label: "OTP", semanticId: "otp", modes: ["type"] as const }],
    contextRegions: [],
    completion: { mode: "inline" as const, targetIds: ["otp"] },
    focus: { targetId: "otp", contextRegionIds: [] },
  };
  const contract = await operational.updateHumanAssistanceContract(
    created.taskRunId,
    contractInput,
  );
  assert.equal(contract.version, 1);
  assert.equal((await operational.taskRunById(created.taskRunId))?.humanAssistanceContract?.stageId, "otp");
  const completedContract = await operational.updateHumanAssistanceCompletion(
    created.taskRunId,
    "entered",
  );
  assert.equal(completedContract.version, 2);
  assert.equal(completedContract.completion.status, "entered");

  const completed = await operational.transitionTaskRunToTerminal(created.taskRunId, {
    status: "completed",
    finishedAt: "2026-09-22T00:01:00.000Z",
    exitCode: 0,
  });
  assert.deepEqual(completed, { status: "completed", applied: true });
  const staleFinalizer = await operational.transitionTaskRunToTerminal(created.taskRunId, {
    status: "failed",
    finishedAt: "2026-09-22T00:02:00.000Z",
    errorMessage: "stale",
  });
  assert.deepEqual(staleFinalizer, { status: "completed", applied: false });
  await assert.rejects(
    operational.updateTaskRun(created.taskRunId, { logTail: "mutated" }),
    /Terminal automation task run is immutable/u,
  );
  await assert.rejects(
    store.query(
      "UPDATE automation_task_runs SET log_tail = $1 WHERE task_run_id = $2",
      ["direct mutation", created.taskRunId],
    ),
    /Terminal automation task run is immutable/u,
  );

  const later = await operational.createTaskRun({
    taskId: "exchange-rates",
    script: "run:exchange-rates",
    kind: "sync",
    status: "failed",
    attempt: 1,
    maxAttempts: 1,
    startedAt: "2026-09-22T00:03:00.000Z",
    finishedAt: "2026-09-22T00:04:00.000Z",
    exitCode: 1,
    errorMessage: "network",
    logPath: "data/automation/logs/exchange-rates-2.log",
  });
  assert.equal((await operational.latestTaskRuns())["exchange-rates"]?.taskRunId, later.taskRunId);
  assert.deepEqual(
    await operational.todayTaskRunIds({
      startUtc: new Date("2026-09-22T00:00:00.000Z"),
      endUtc: new Date("2026-09-23T00:00:00.000Z"),
    }),
    ["exchange-rates"],
  );
  assert.equal(
    await operational.hasSuccessfulTaskRunSince(
      "exchange-rates",
      "2026-09-22T00:01:30.000Z",
    ),
    false,
  );
  assert.equal(
    await operational.hasSuccessfulTaskRunSince(
      "exchange-rates",
      "2026-09-22T00:00:30.000Z",
    ),
    true,
  );
  assert.equal((await operational.recentTaskRuns(1))[0]?.taskRunId, later.taskRunId);

  await operational.upsertTaskPrerequisiteNotice({
    taskId: "exchange-rates",
    prerequisiteId: "api-key",
    taskRunId: created.taskRunId,
    detectedAt: "2026-09-22T00:05:00.000Z",
    errorMessage: "missing",
  });
  await operational.upsertTaskPrerequisiteNotice({
    taskId: "exchange-rates",
    prerequisiteId: "api-key",
    taskRunId: later.taskRunId,
    detectedAt: "2026-09-22T00:06:00.000Z",
    errorMessage: "still missing",
  });
  assert.equal((await operational.activeTaskPrerequisiteNotices())[0]?.latestTaskRunId, later.taskRunId);
  await operational.resolveTaskPrerequisiteNotices(
    "exchange-rates",
    created.taskRunId,
    "2026-09-22T00:07:00.000Z",
  );
  const resolvedNotice = (await operational.allTaskPrerequisiteNotices())[0];
  assert.equal(resolvedNotice?.resolvedByTaskRunId, created.taskRunId);
  assert.equal((await operational.activeTaskPrerequisiteNotices()).length, 0);

  await operational.upsertExchangeRates([
    {
      rateDate: "2026-09-22",
      currency: "USD",
      twdPerUnit: 32.1,
      source: "test",
      fetchedAt: "2026-09-22T00:00:00.000Z",
    },
    {
      rateDate: "2026-09-22",
      currency: "JPY",
      twdPerUnit: 0.21,
      source: "test",
      fetchedAt: "2026-09-22T00:00:00.000Z",
    },
  ]);
  assert.deepEqual(
    await operational.readExchangeRates(["USD"]),
    [{
      rateDate: "2026-09-22",
      currency: "USD",
      twdPerUnit: 32.1,
      source: "test",
      fetchedAt: "2026-09-22T00:00:00.000Z",
    }],
  );
  await operational.upsertExchangeRates([{
    rateDate: "2026-09-22",
    currency: "USD",
    twdPerUnit: 32.2,
    source: "refreshed",
    fetchedAt: "2026-09-22T01:00:00.000Z",
  }]);
  assert.equal((await operational.readExchangeRates(["USD"]))[0]?.twdPerUnit, 32.2);
  await assert.rejects(
    operational.upsertExchangeRates([
      {
        rateDate: "2026-09-23",
        currency: "USD",
        twdPerUnit: 33,
        source: "test",
        fetchedAt: "2026-09-22T00:00:00.000Z",
      },
      {
        rateDate: "2026-09-23",
        currency: "JPY",
        twdPerUnit: -1,
        source: "test",
        fetchedAt: "2026-09-22T00:00:00.000Z",
      },
    ]),
    /violates check constraint/u,
  );
  assert.deepEqual(await operational.readExchangeRates(["USD"]), [{
    rateDate: "2026-09-22",
    currency: "USD",
    twdPerUnit: 32.2,
    source: "refreshed",
    fetchedAt: "2026-09-22T01:00:00.000Z",
  }]);
} finally {
  await store.close();
}
