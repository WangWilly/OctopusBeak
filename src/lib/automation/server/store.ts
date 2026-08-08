import { randomUUID } from "node:crypto";
import type { LedgerDatabase } from "../../../ledger/db/client.ts";
import { parseStatementRunSummary } from "../statement-run-summary.ts";
import type { AutomationTaskKind, AutomationTaskStatus } from "../types.ts";
import {
  createHumanAssistanceContract,
  parseHumanAssistanceContract,
  type HumanAssistanceContract,
  type HumanAssistanceContractInput,
} from "../human-assistance.ts";

export type { AutomationTaskKind, AutomationTaskStatus } from "../types.ts";

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
  humanAssistanceContract: HumanAssistanceContract | null;
};

export type AutomationTaskHistoryRow = Pick<
  AutomationTaskRun,
  | "taskRunId"
  | "taskId"
  | "script"
  | "kind"
  | "status"
  | "startedAt"
  | "finishedAt"
  | "exitCode"
  | "signal"
  | "errorMessage"
  | "logPath"
>;

export type AutomationTaskPrerequisiteNoticeRecord = {
  noticeId: string;
  taskId: string;
  prerequisiteId: string;
  latestTaskRunId: string;
  firstDetectedAt: string;
  lastDetectedAt: string;
  latestErrorMessage: string | null;
  resolvedAt: string | null;
  resolvedByTaskRunId: string | null;
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
  humanAssistanceContract?: HumanAssistanceContract | null;
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
    humanAssistanceContract: parseHumanAssistanceContract(String(row.record_json)),
  };
}

function taskRunRecordJson(run: AutomationTaskRun) {
  const { recordJson: _recordJson, ...record } = run;
  return JSON.stringify(record);
}

function rowToTaskPrerequisiteNotice(row: Record<string, unknown>): AutomationTaskPrerequisiteNoticeRecord {
  return {
    noticeId: String(row.notice_id),
    taskId: String(row.task_id),
    prerequisiteId: String(row.prerequisite_id),
    latestTaskRunId: String(row.latest_task_run_id),
    firstDetectedAt: String(row.first_detected_at),
    lastDetectedAt: String(row.last_detected_at),
    latestErrorMessage: nullableString(row.latest_error_message),
    resolvedAt: nullableString(row.resolved_at),
    resolvedByTaskRunId: nullableString(row.resolved_by_task_run_id),
    recordJson: String(row.record_json),
  };
}

type PrerequisiteNoticeHistory = {
  detections: Array<{ taskRunId: string; detectedAt: string }>;
  resolutions: Array<{ taskRunId: string; resolvedAt: string }>;
};

function noticeHistory(recordJson: string): PrerequisiteNoticeHistory {
  try {
    const value = JSON.parse(recordJson) as Partial<PrerequisiteNoticeHistory>;
    return {
      detections: Array.isArray(value.detections) ? value.detections : [],
      resolutions: Array.isArray(value.resolutions) ? value.resolutions : [],
    };
  } catch {
    return { detections: [], resolutions: [] };
  }
}

function noticeRecordJson(
  input: { taskId: string; prerequisiteId: string },
  history: PrerequisiteNoticeHistory,
) {
  return JSON.stringify({ ...input, ...history });
}

export function upsertTaskPrerequisiteNotice(
  db: LedgerDatabase,
  input: {
    taskId: string;
    prerequisiteId: string;
    taskRunId: string;
    detectedAt: string;
    errorMessage?: string | null;
  },
) {
  const existing = db.prepare(`
    SELECT record_json
    FROM automation_task_prerequisite_notices
    WHERE task_id = ? AND prerequisite_id = ?
  `).get(input.taskId, input.prerequisiteId) as { record_json: string } | undefined;
  const history = noticeHistory(existing?.record_json ?? "{}");
  const lastDetection = history.detections.at(-1);
  if (lastDetection?.taskRunId !== input.taskRunId) {
    history.detections.push({ taskRunId: input.taskRunId, detectedAt: input.detectedAt });
  }
  const noticeId = `automation-prerequisite:${input.taskId}:${input.prerequisiteId}`;
  db.prepare(`
    INSERT INTO automation_task_prerequisite_notices (
      notice_id, task_id, prerequisite_id, latest_task_run_id,
      first_detected_at, last_detected_at, latest_error_message,
      resolved_at, resolved_by_task_run_id, record_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
    ON CONFLICT(task_id, prerequisite_id) DO UPDATE SET
      latest_task_run_id = excluded.latest_task_run_id,
      last_detected_at = excluded.last_detected_at,
      latest_error_message = excluded.latest_error_message,
      resolved_at = NULL,
      resolved_by_task_run_id = NULL,
      record_json = excluded.record_json
  `).run(
    noticeId,
    input.taskId,
    input.prerequisiteId,
    input.taskRunId,
    history.detections[0]?.detectedAt ?? input.detectedAt,
    input.detectedAt,
    input.errorMessage ?? null,
    noticeRecordJson({ taskId: input.taskId, prerequisiteId: input.prerequisiteId }, history),
  );
}

export function activeTaskPrerequisiteNotices(db: LedgerDatabase): AutomationTaskPrerequisiteNoticeRecord[] {
  const rows = db.prepare(`
    SELECT *
    FROM automation_task_prerequisite_notices
    WHERE resolved_at IS NULL
    ORDER BY last_detected_at DESC
  `).all() as Record<string, unknown>[];
  return rows.map(rowToTaskPrerequisiteNotice);
}

export function allTaskPrerequisiteNotices(db: LedgerDatabase): AutomationTaskPrerequisiteNoticeRecord[] {
  const rows = db.prepare(`
    SELECT *
    FROM automation_task_prerequisite_notices
    ORDER BY last_detected_at DESC
  `).all() as Record<string, unknown>[];
  return rows.map(rowToTaskPrerequisiteNotice);
}

export function resolveTaskPrerequisiteNotices(
  db: LedgerDatabase,
  taskId: string,
  resolvedByTaskRunId: string,
  resolvedAt: string,
) {
  const rows = db.prepare(`
    SELECT *
    FROM automation_task_prerequisite_notices
    WHERE task_id = ? AND resolved_at IS NULL
  `).all(taskId) as Record<string, unknown>[];
  const update = db.prepare(`
    UPDATE automation_task_prerequisite_notices
    SET resolved_at = ?, resolved_by_task_run_id = ?, record_json = ?
    WHERE notice_id = ?
  `);
  for (const row of rows) {
    const notice = rowToTaskPrerequisiteNotice(row);
    const history = noticeHistory(notice.recordJson);
    history.resolutions.push({ taskRunId: resolvedByTaskRunId, resolvedAt });
    update.run(
      resolvedAt,
      resolvedByTaskRunId,
      noticeRecordJson({ taskId: notice.taskId, prerequisiteId: notice.prerequisiteId }, history),
      notice.noticeId,
    );
  }
}

export function createTaskRun(db: LedgerDatabase, input: CreateTaskRunInput) {
  const taskRunId = randomUUID();
  const record = { taskRunId, ...input, humanAssistanceContract: input.humanAssistanceContract ?? null };
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
  update: Partial<Pick<AutomationTaskRun, "status" | "finishedAt" | "exitCode" | "signal" | "errorMessage" | "logTail" | "humanAssistanceContract">>,
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

export function updateHumanAssistanceContract(
  db: LedgerDatabase,
  taskRunId: string,
  input: HumanAssistanceContractInput,
) {
  const run = taskRunById(db, taskRunId);
  if (!run) throw new Error(`Missing automation task run: ${taskRunId}`);
  if (run.status !== "running" && run.status !== "waiting_for_human") {
    throw new Error(`Automation task run is not active: ${taskRunId}`);
  }
  const version = (run.humanAssistanceContract?.version ?? 0) + 1;
  const contract = createHumanAssistanceContract(input, version);
  updateTaskRun(db, taskRunId, { humanAssistanceContract: contract });
  return contract;
}

export function taskRunById(db: LedgerDatabase, taskRunId: string) {
  const row = db.prepare("SELECT * FROM automation_task_runs WHERE task_run_id = ?").get(taskRunId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToTaskRun(row) : null;
}

export function activeTaskRuns(db: LedgerDatabase): AutomationTaskRun[] {
  const rows = db.prepare(`
    SELECT *
    FROM automation_task_runs
    WHERE status IN ('running', 'waiting_for_human')
    ORDER BY started_at ASC
  `).all() as Record<string, unknown>[];
  return rows.map(rowToTaskRun);
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

export function todayTaskRunIds(
  db: LedgerDatabase,
  input: { startUtc: Date; endUtc: Date },
) {
  const rows = db.prepare(`
    SELECT DISTINCT task_id
    FROM automation_task_runs
    WHERE started_at >= ?
      AND started_at < ?
    ORDER BY task_id
  `).all(input.startUtc.toISOString(), input.endUtc.toISOString()) as { task_id: string }[];
  return rows.map((row) => row.task_id);
}

export function hasSuccessfulTaskRunSince(
  db: LedgerDatabase,
  taskId: string,
  occurrence: string,
) {
  return Boolean(db.prepare(`
    SELECT 1
    FROM automation_task_runs
    WHERE task_id = ?
      AND status = 'completed'
      AND finished_at >= ?
    LIMIT 1
  `).get(taskId, occurrence));
}

export function recentTaskRuns(db: LedgerDatabase, limit = 100): AutomationTaskHistoryRow[] {
  const rows = db.prepare(`
    SELECT
      task_run_id,
      task_id,
      script,
      kind,
      status,
      started_at,
      finished_at,
      exit_code,
      signal,
      error_message,
      log_path
    FROM automation_task_runs
    ORDER BY started_at DESC
    LIMIT ?
  `).all(limit) as Record<string, unknown>[];
  return rows.map((row) => ({
    taskRunId: String(row.task_run_id),
    taskId: String(row.task_id),
    script: String(row.script),
    kind: row.kind as AutomationTaskKind,
    status: row.status as AutomationTaskStatus,
    startedAt: String(row.started_at),
    finishedAt: nullableString(row.finished_at),
    exitCode: nullableNumber(row.exit_code),
    signal: nullableString(row.signal),
    errorMessage: nullableString(row.error_message),
    logPath: String(row.log_path),
  }));
}

export function importGateStatus(
  db: LedgerDatabase,
  input: { dependencyIds: readonly string[]; startUtc: Date; endUtc: Date },
) {
  const warnings: { taskId: string; failedTypeIds: readonly string[] }[] = [];
  const missingTaskIds = input.dependencyIds.filter((taskId) => {
    const row = db.prepare(`
      SELECT status, log_tail
      FROM automation_task_runs
      WHERE task_id = ?
        AND status IN ('completed', 'partial')
        AND started_at >= ?
        AND started_at < ?
      ORDER BY started_at DESC
      LIMIT 1
    `).get(taskId, input.startUtc.toISOString(), input.endUtc.toISOString()) as
      | { status: "completed" | "partial"; log_tail: string }
      | undefined;
    if (!row) return true;
    if (row.status === "partial") {
      const summary = parseStatementRunSummary(row.log_tail);
      warnings.push({
        taskId,
        failedTypeIds: summary?.results
          .filter((result) => result.status === "failed")
          .map((result) => result.typeId) ?? [],
      });
    }
    return false;
  });
  return {
    locked: missingTaskIds.length > 0,
    missingTaskIds,
    warnings,
  };
}
