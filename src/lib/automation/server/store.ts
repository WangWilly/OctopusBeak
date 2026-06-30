import { randomUUID } from "node:crypto";
import type { LedgerDatabase } from "../../../ledger/db/client.ts";
import type { AutomationTaskKind } from "./tasks.ts";

export type AutomationTaskStatus =
  | "queued"
  | "running"
  | "waiting_for_human"
  | "retrying"
  | "completed"
  | "failed"
  | "locked";

export type AutomationTaskRun = {
  taskRunId: string;
  taskId: string;
  script: string;
  kind: AutomationTaskKind;
  status: AutomationTaskStatus;
  attempt: number;
  maxAttempts: number;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  errorMessage: string | null;
  logPath: string;
  logTail: string;
  recordJson: string;
};

type CreateTaskRunInput = {
  taskId: string;
  script: string;
  kind: AutomationTaskKind;
  status: AutomationTaskStatus;
  attempt: number;
  maxAttempts: number;
  startedAt: string;
  finishedAt?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  errorMessage?: string | null;
  logPath: string;
  logTail?: string;
};

function nullableString(value: unknown) {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown) {
  return value === null || value === undefined ? null : Number(value);
}

function rowToTaskRun(row: Record<string, unknown>): AutomationTaskRun {
  return {
    taskRunId: String(row.task_run_id),
    taskId: String(row.task_id),
    script: String(row.script),
    kind: row.kind as AutomationTaskKind,
    status: row.status as AutomationTaskStatus,
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    startedAt: String(row.started_at),
    finishedAt: nullableString(row.finished_at),
    exitCode: nullableNumber(row.exit_code),
    signal: nullableString(row.signal),
    errorMessage: nullableString(row.error_message),
    logPath: String(row.log_path),
    logTail: String(row.log_tail),
    recordJson: String(row.record_json),
  };
}

function taskRunRecordJson(run: AutomationTaskRun) {
  const { recordJson: _recordJson, ...record } = run;
  return JSON.stringify(record);
}

export function createTaskRun(db: LedgerDatabase, input: CreateTaskRunInput) {
  const taskRunId = randomUUID();
  const record = { taskRunId, ...input };
  db.prepare(`
    INSERT INTO automation_task_runs (
      task_run_id, task_id, script, kind, status, attempt, max_attempts,
      started_at, finished_at, exit_code, signal, error_message, log_path,
      log_tail, record_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    taskRunId,
    input.taskId,
    input.script,
    input.kind,
    input.status,
    input.attempt,
    input.maxAttempts,
    input.startedAt,
    input.finishedAt ?? null,
    input.exitCode ?? null,
    input.signal ?? null,
    input.errorMessage ?? null,
    input.logPath,
    input.logTail ?? "",
    JSON.stringify(record),
  );
  return { taskRunId };
}

export function updateTaskRun(
  db: LedgerDatabase,
  taskRunId: string,
  update: Partial<Pick<AutomationTaskRun, "status" | "finishedAt" | "exitCode" | "signal" | "errorMessage" | "logTail">>,
) {
  const row = db.prepare("SELECT * FROM automation_task_runs WHERE task_run_id = ?").get(taskRunId) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new Error(`Missing automation task run: ${taskRunId}`);
  const next = {
    ...rowToTaskRun(row),
    ...update,
  };
  db.prepare(`
    UPDATE automation_task_runs
    SET status = ?, finished_at = ?, exit_code = ?, signal = ?, error_message = ?, log_tail = ?, record_json = ?
    WHERE task_run_id = ?
  `).run(
    next.status,
    next.finishedAt,
    next.exitCode,
    next.signal,
    next.errorMessage,
    next.logTail,
    taskRunRecordJson(next),
    taskRunId,
  );
}

export function taskRunById(db: LedgerDatabase, taskRunId: string) {
  const row = db.prepare("SELECT * FROM automation_task_runs WHERE task_run_id = ?").get(taskRunId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToTaskRun(row) : null;
}

export function latestTaskRuns(db: LedgerDatabase) {
  const rows = db.prepare(`
    SELECT run.*
    FROM automation_task_runs run
    JOIN (
      SELECT task_id, max(started_at) AS started_at
      FROM automation_task_runs
      GROUP BY task_id
    ) latest
    ON latest.task_id = run.task_id AND latest.started_at = run.started_at
  `).all() as Record<string, unknown>[];

  return Object.fromEntries(rows.map((row) => {
    const taskRun = rowToTaskRun(row);
    return [taskRun.taskId, taskRun];
  }));
}

export function importGateStatus(
  db: LedgerDatabase,
  input: { dependencyIds: readonly string[]; startUtc: Date; endUtc: Date },
) {
  const missingTaskIds = input.dependencyIds.filter((taskId) => {
    const row = db.prepare(`
      SELECT status
      FROM automation_task_runs
      WHERE task_id = ?
        AND started_at >= ?
        AND started_at < ?
      ORDER BY started_at DESC
      LIMIT 1
    `).get(taskId, input.startUtc.toISOString(), input.endUtc.toISOString()) as
      | { status?: string }
      | undefined;
    return row?.status !== "completed";
  });
  return {
    locked: missingTaskIds.length > 0,
    missingTaskIds,
  };
}
