import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import {
  createTaskRun,
  importGateStatus,
  latestTaskRuns,
  taskRunById,
  updateTaskRun,
} from "./store.ts";

const ledgerDir = mkdtempSync(join(tmpdir(), "automation-store-"));

try {
  const db = openLedgerDatabase(ledgerDir);
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

  createTaskRun(db, {
    taskId: "esun-credit-card-statements",
    script: "run:esun-credit-card-statements",
    kind: "crawler",
    status: "completed",
    attempt: 1,
    maxAttempts: 2,
    startedAt: "2026-06-29T23:00:00.000Z",
    finishedAt: "2026-06-29T23:20:00.000Z",
    exitCode: 0,
    logPath: "data/automation/logs/esun.log",
    logTail: "ok",
  });

  const unlockedGate = importGateStatus(db, {
    dependencyIds: [
      "fubon-all-statements",
      "esun-credit-card-statements",
    ],
    startUtc: new Date("2026-06-29T16:00:00.000Z"),
    endUtc: new Date("2026-06-30T16:00:00.000Z"),
  });
  assert.equal(unlockedGate.locked, false);
  assert.deepEqual(unlockedGate.missingTaskIds, []);

  db.close();
} finally {
  rmSync(ledgerDir, { recursive: true, force: true });
}
