import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedgerDatabase, type LedgerDatabase } from "../../../ledger/db/client.ts";
import {
  activeTaskRuns,
  createTaskRun,
  hasSuccessfulTaskRunSince,
  importGateStatus,
  latestTaskRuns,
  recentTaskRuns,
  taskRunById,
  todayTaskRunIds,
  updateTaskRun,
} from "./store.ts";

let recentTaskRunsSql = "";
const fakeDb = {
  prepare(sql: string) {
    recentTaskRunsSql = sql;
    return {
      all(limit: number) {
        assert.equal(limit, 100);
        return [{
          task_run_id: "history-1",
          task_id: "fubon-all-statements",
          script: "run:fubon-all-statements",
          kind: "crawler",
          status: "completed",
          started_at: "2026-06-30T01:00:00.000Z",
          finished_at: "2026-06-30T01:01:00.000Z",
          exit_code: 0,
          signal: null,
          error_message: null,
          log_path: "data/automation/logs/fubon.log",
        }];
      },
    };
  },
} as unknown as LedgerDatabase;

assert.equal(recentTaskRuns(fakeDb, 100)[0]?.taskRunId, "history-1");
assert.doesNotMatch(recentTaskRunsSql, /SELECT\s+\*/i);
assert.doesNotMatch(recentTaskRunsSql, /\blog_tail\b|\brecord_json\b/i);

const ledgerDir = mkdtempSync(join(tmpdir(), "automation-store-"));

try {
  const db = openLedgerDatabase(ledgerDir);
  const indexes = db.prepare("PRAGMA index_list('automation_task_runs')").all() as { name: string }[];
  assert.equal(indexes.some((index) => index.name === "idx_automation_task_runs_started_at"), true);
  const startedAt = "2026-06-30T01:00:00.000Z";
  const finishedAt = "2026-06-30T01:02:00.000Z";

  const run = createTaskRun(db, {
    taskId: "fubon-all-statements",
    script: "run:fubon-all-statements",
    kind: "crawler",
    status: "running",
    attempt: 1,
    maxAttempts: 2,
    startedAt,
    logPath: "data/automation/logs/fubon.log",
  });

  updateTaskRun(db, run.taskRunId, {
    status: "completed",
    finishedAt,
    exitCode: 0,
    logTail: "ok",
  });

  const latest = latestTaskRuns(db);
  assert.equal(latest["fubon-all-statements"]?.status, "completed");
  assert.equal(latest["fubon-all-statements"]?.finishedAt, finishedAt);
  const completedRun = taskRunById(db, run.taskRunId);
  assert.equal(completedRun?.status, "completed");
  assert.equal(JSON.parse(completedRun?.recordJson ?? "{}").recordJson, undefined);
  assert.equal(taskRunById(db, "missing"), null);

  const recordJsonBytes = completedRun?.recordJson.length ?? 0;
  updateTaskRun(db, run.taskRunId, { logTail: "ok\nagain" });
  const updatedRun = taskRunById(db, run.taskRunId);
  assert.equal(JSON.parse(updatedRun?.recordJson ?? "{}").recordJson, undefined);
  assert.ok((updatedRun?.recordJson.length ?? 0) < recordJsonBytes + 100);

  const todayRunIds = todayTaskRunIds(db, {
    startUtc: new Date("2026-06-30T00:00:00.000Z"),
    endUtc: new Date("2026-07-01T00:00:00.000Z"),
  });
  assert.deepEqual(todayRunIds, ["fubon-all-statements"]);

  const lockedGate = importGateStatus(db, {
    dependencyIds: [
      "fubon-all-statements",
      "esun-credit-card-statements",
    ],
    startUtc: new Date("2026-06-30T00:00:00.000Z"),
    endUtc: new Date("2026-07-01T00:00:00.000Z"),
  });
  assert.equal(lockedGate.locked, true);
  assert.deepEqual(lockedGate.missingTaskIds, ["esun-credit-card-statements"]);

  const esunRun = createTaskRun(db, {
    taskId: "esun-credit-card-statements",
    script: "run:esun-credit-card-statements",
    kind: "crawler",
    status: "failed",
    attempt: 1,
    maxAttempts: 2,
    startedAt: "2026-06-30T03:00:00.000Z",
    finishedAt: "2026-06-30T03:20:00.000Z",
    exitCode: 1,
    errorMessage: "Task exited with code 1",
    logPath: "data/automation/logs/esun.log",
    logTail: "failed",
  });

  const failedGate = importGateStatus(db, {
    dependencyIds: [
      "fubon-all-statements",
      "esun-credit-card-statements",
    ],
    startUtc: new Date("2026-06-30T00:00:00.000Z"),
    endUtc: new Date("2026-07-01T00:00:00.000Z"),
  });
  assert.equal(failedGate.locked, true);
  assert.deepEqual(failedGate.missingTaskIds, ["esun-credit-card-statements"]);

  updateTaskRun(db, esunRun.taskRunId, {
    status: "completed",
    finishedAt: "2026-06-30T03:21:00.000Z",
    exitCode: 0,
    errorMessage: null,
  });

  const unlockedGate = importGateStatus(db, {
    dependencyIds: [
      "fubon-all-statements",
      "esun-credit-card-statements",
    ],
    startUtc: new Date("2026-06-30T00:00:00.000Z"),
    endUtc: new Date("2026-07-01T00:00:00.000Z"),
  });
  assert.equal(unlockedGate.locked, false);
  assert.deepEqual(unlockedGate.missingTaskIds, []);
  assert.equal(taskRunById(db, esunRun.taskRunId)?.status, "completed");

  for (let index = 0; index < 101; index += 1) {
    const startedAt = new Date(Date.UTC(2026, 5, 30, 4, 0, index)).toISOString();
    const finishedAt = new Date(Date.UTC(2026, 5, 30, 4, 0, index + 1)).toISOString();
    createTaskRun(db, {
      taskId: "hncb-statements",
      script: "run:hncb-statements",
      kind: "crawler",
      status: "completed",
      attempt: 1,
      maxAttempts: 1,
      startedAt,
      finishedAt,
      exitCode: 0,
      logPath: `data/automation/logs/hncb-${index}.log`,
      logTail: "ok",
    });
  }

  const history = recentTaskRuns(db, 100);
  assert.equal(history.length, 100);
  assert.equal(history[0]?.taskId, "hncb-statements");
  assert.equal(history[0]?.startedAt, "2026-06-30T04:01:40.000Z");
  assert.equal(history.at(-1)?.startedAt, "2026-06-30T04:00:01.000Z");

  createTaskRun(db, {
    taskId: "running-task",
    script: "run:running-task",
    kind: "crawler",
    status: "running",
    attempt: 1,
    maxAttempts: 1,
    startedAt: "2026-06-30T05:00:00.000Z",
    logPath: "data/automation/logs/running.log",
  });
  createTaskRun(db, {
    taskId: "waiting-task",
    script: "run:waiting-task",
    kind: "crawler",
    status: "waiting_for_human",
    attempt: 1,
    maxAttempts: 1,
    startedAt: "2026-06-30T05:01:00.000Z",
    logPath: "data/automation/logs/waiting.log",
  });
  assert.deepEqual(
    activeTaskRuns(db).map((item) => item.status).sort(),
    ["running", "waiting_for_human"],
  );

  const occurrence = "2026-07-14T22:00:00.000Z";
  assert.equal(hasSuccessfulTaskRunSince(db, "exchange-rates", occurrence), false);
  for (const [status, finishedAt] of [
    ["running", null],
    ["failed", "2026-07-14T22:01:00.000Z"],
    ["completed", "2026-07-14T21:59:59.999Z"],
  ] as const) {
    createTaskRun(db, {
      taskId: "exchange-rates",
      script: "run:exchange-rates",
      kind: "sync",
      status,
      attempt: 1,
      maxAttempts: 1,
      startedAt: "2026-07-14T21:00:00.000Z",
      finishedAt,
      logPath: `data/automation/logs/exchange-rates-${status}.log`,
    });
  }
  const cancelled = createTaskRun(db, {
    taskId: "exchange-rates",
    script: "run:exchange-rates",
    kind: "sync",
    status: "running",
    attempt: 1,
    maxAttempts: 1,
    startedAt: "2026-07-14T21:00:00.000Z",
    logPath: "data/automation/logs/exchange-rates-cancelled.log",
  });
  db.prepare(`
    UPDATE automation_task_runs
    SET status = 'cancelled', finished_at = ?
    WHERE task_run_id = ?
  `).run("2026-07-14T22:02:00.000Z", cancelled.taskRunId);
  assert.equal(hasSuccessfulTaskRunSince(db, "exchange-rates", occurrence), false);
  createTaskRun(db, {
    taskId: "exchange-rates",
    script: "run:exchange-rates",
    kind: "sync",
    status: "completed",
    attempt: 1,
    maxAttempts: 1,
    startedAt: occurrence,
    finishedAt: occurrence,
    exitCode: 0,
    logPath: "data/automation/logs/exchange-rates-completed.log",
  });
  assert.equal(hasSuccessfulTaskRunSince(db, "exchange-rates", occurrence), true);

  db.close();
} finally {
  rmSync(ledgerDir, { recursive: true, force: true });
}
