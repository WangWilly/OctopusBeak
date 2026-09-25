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
  const removedColumns = await store.query<{ column_name: string }>(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'automation_task_runs'
      AND column_name IN ('script', 'error_message', 'log_path', 'log_tail')
  `);
  assert.deepEqual(removedColumns.rows, []);
  const created = await operational.createTaskRun({
    taskId: "exchange-rates",
    kind: "sync",
    status: "running",
    attempt: 1,
    maxAttempts: 2,
    startedAt: "2026-09-22T00:00:00.000Z",
  });
  assert.match(created.taskRunId, /^[0-9a-f-]{36}$/);
  const storedRun = await store.query<{ record_json: string }>(
    "SELECT record_json FROM automation_task_runs WHERE task_run_id = $1",
    [created.taskRunId],
  );
  assert.doesNotMatch(storedRun.rows[0]?.record_json ?? "", /script|logPath|logTail|errorMessage/u);
  await assert.rejects(
    operational.createTaskRun({
      taskId: "exchange-rates",
      kind: "sync",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: "2026-09-22T00:00:01.000Z",
      script: "workflow:legacy",
      logPath: "data/automation/logs/legacy.log",
      logTail: "secret=legacy",
      errorMessage: "legacy raw error",
    } as never),
    /Invalid automation task run input/u,
  );
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
    kind: "sync",
    status: "failed",
    attempt: 1,
    maxAttempts: 1,
    startedAt: "2026-09-21T00:11:00.000Z",
    scheduledAtUtc: occurrence,
  });
  assert.equal((await operational.taskRunById(scheduled.taskRunId))?.scheduledAtUtc, occurrence);
  assert.equal(await operational.hasOccurrenceBeenAttempted("exchange-rates", occurrence), true);
  assert.equal(await operational.hasOccurrenceBeenAttempted("exchange-rates", "2026-09-22T00:12:00.000Z"), false);

  const legacyOccurrence = "2026-09-22T00:20:00.000Z";
  await assert.rejects(operational.createTaskRun({
    taskId: "exchange-rates",
    kind: "sync",
    status: "interrupted",
    attempt: 1,
    maxAttempts: 1,
    startedAt: "2026-09-21T00:13:00.000Z",
    script: `run:exchange-rates --scheduled-at-utc ${legacyOccurrence}`,
  } as never), /Invalid automation task run input/u);
  assert.equal(await operational.hasOccurrenceBeenAttempted("exchange-rates", legacyOccurrence), false);

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
  });
  assert.deepEqual(staleFinalizer, { status: "completed", applied: false });
  await assert.rejects(
    operational.updateTaskRun(created.taskRunId, { logTail: "mutated" } as never),
    /Invalid automation task run update/u,
  );
  await assert.rejects(
    store.query("UPDATE automation_task_runs SET log_tail = $1 WHERE task_run_id = $2", [
      "direct mutation",
      created.taskRunId,
    ]),
    /column .*log_tail.* does not exist/u,
  );

  const later = await operational.createTaskRun({
    taskId: "exchange-rates",
    kind: "sync",
    status: "failed",
    attempt: 1,
    maxAttempts: 1,
    startedAt: "2026-09-22T00:03:00.000Z",
    finishedAt: "2026-09-22T00:04:00.000Z",
    exitCode: 1,
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
  assert.deepEqual(
    (await operational.recentTaskRuns(5)).find((run) => run.taskRunId === created.taskRunId)
      ?.appWorkflowOutcome,
    safeOutcome?.appWorkflowOutcome,
  );

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

const legacyDatabase = await PGlite.create();
const legacyStore = new PGliteStore(legacyDatabase);
try {
  await legacyStore.transaction(async (transaction) => {
    await transaction.exec(`
      CREATE TABLE pglite_operational_baseline_metadata (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        baseline_version INTEGER NOT NULL,
        table_count INTEGER NOT NULL,
        index_count INTEGER NOT NULL,
        trigger_count INTEGER NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO pglite_operational_baseline_metadata(
        singleton_id, baseline_version, table_count, index_count, trigger_count
      ) VALUES (1, 1, 3, 5, 1);
      CREATE TABLE automation_task_runs (
        task_run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        script TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        exit_code INTEGER,
        signal TEXT,
        error_message TEXT,
        log_path TEXT NOT NULL,
        log_tail TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      INSERT INTO automation_task_runs (
        task_run_id, task_id, script, kind, status, attempt, max_attempts,
        started_at, error_message, log_path, log_tail, record_json
      ) VALUES (
        'legacy-run', 'exchange-rates', 'run:exchange-rates', 'sync', 'failed', 1, 1,
        '2026-09-22T00:00:00.000Z', 'raw error', 'data/automation/logs/old.log',
        'password=old-secret', '{"logTail":"password=old-secret"}'
      );
      CREATE TABLE automation_task_prerequisite_notices (
        notice_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        prerequisite_id TEXT NOT NULL,
        latest_task_run_id TEXT NOT NULL,
        first_detected_at TEXT NOT NULL,
        last_detected_at TEXT NOT NULL,
        latest_error_message TEXT,
        resolved_at TEXT,
        resolved_by_task_run_id TEXT,
        record_json TEXT NOT NULL,
        UNIQUE (task_id, prerequisite_id)
      );
      INSERT INTO automation_task_prerequisite_notices (
        notice_id, task_id, prerequisite_id, latest_task_run_id,
        first_detected_at, last_detected_at, latest_error_message, record_json
      ) VALUES (
        'notice-1', 'exchange-rates', 'api-key', 'legacy-run',
        '2026-09-21T00:00:00.000Z', '2026-09-22T00:00:00.000Z',
        'missing API key', '{}'
      );
      CREATE TABLE exchange_rates (
        rate_date TEXT NOT NULL,
        currency TEXT NOT NULL,
        twd_per_unit DOUBLE PRECISION NOT NULL,
        source TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (rate_date, currency)
      );
      INSERT INTO exchange_rates(rate_date, currency, twd_per_unit, source, fetched_at)
      VALUES ('2026-09-21', 'USD', 31.5, 'legacy', '2026-09-21T00:00:00.000Z');
    `);
  });
  await assert.rejects(
    applyPgliteOperationalBaseline(legacyStore),
    /PGlite operational baseline reset required: found version 1, expected 2/u,
  );
  const oldRunCount = await legacyStore.query<{ count: number | string }>(
    "SELECT COUNT(*) AS count FROM automation_task_runs WHERE task_run_id = 'legacy-run'",
  );
  assert.equal(Number(oldRunCount.rows[0]?.count), 1);
  const oldColumns = await legacyStore.query<{ column_name: string }>(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'automation_task_runs'
      AND column_name IN ('script', 'error_message', 'log_path', 'log_tail')
  `);
  assert.deepEqual(
    new Set(oldColumns.rows.map(({ column_name }) => column_name)),
    new Set(["script", "error_message", "log_path", "log_tail"]),
  );
  const unchangedMetadata = await legacyStore.query<{ baseline_version: number | string }>(
    "SELECT baseline_version FROM pglite_operational_baseline_metadata WHERE singleton_id = 1",
  );
  assert.equal(Number(unchangedMetadata.rows[0]?.baseline_version), 1);
  const retainedRawLegacyRow = await legacyStore.query<{ log_tail: string }>(
    "SELECT log_tail FROM automation_task_runs WHERE task_run_id = 'legacy-run'",
  );
  assert.equal(retainedRawLegacyRow.rows[0]?.log_tail, "password=old-secret");
  const retainedRate = await legacyStore.query<{ count: number | string }>(
    "SELECT COUNT(*) AS count FROM exchange_rates WHERE currency = 'USD'",
  );
  assert.equal(Number(retainedRate.rows[0]?.count), 1);
  const retainedNotice = await legacyStore.query<{ count: number | string }>(
    "SELECT COUNT(*) AS count FROM automation_task_prerequisite_notices WHERE notice_id = 'notice-1'",
  );
  assert.equal(Number(retainedNotice.rows[0]?.count), 1);
} finally {
  await legacyStore.close();
}
