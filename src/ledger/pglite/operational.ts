import { randomUUID } from "node:crypto";
import {
  createHumanAssistanceContract,
  parseHumanAssistanceContract,
  type HumanAssistanceContract,
  type HumanAssistanceCompletionStatus,
  type HumanAssistanceContractInput,
} from "../../lib/automation/human-assistance.ts";
import {
  ACTIVE_TASK_RUN_STATUSES,
  isTerminalTaskRunStatus,
  type AutomationPersistencePort,
  type AutomationTaskHistoryRow,
  type AutomationTaskPrerequisiteNoticeRecord,
  type AutomationTaskRun,
  type AutomationTaskRunActiveUpdate,
  type AutomationTaskRunTerminalUpdate,
  type AutomationTaskRunUpdate,
  type AutomationTaskStatus,
  type CreateTaskRunInput,
  type AutomationPersistenceProvider,
} from "../../lib/automation/server/store.ts";
import type { AutomationTaskKind, AutomationTaskProgress } from "../../lib/automation/types.ts";
import type { WorkflowRunEvent } from "../../lib/automation/workflow-executor.ts";
import { sanitizeAutomationLogTail } from "../../lib/automation/server/log-sanitizer.ts";
import { sanitizeTypedWorkflowOutcome } from "../../lib/automation/server/typed-workflow-outcome.ts";
import type {
  ExchangeRatePersistencePort,
  ExchangeRateRecord,
} from "../exchange-rates.ts";
import {
  PGliteStore,
  type PGliteTransaction,
} from "./transaction.ts";
import { PGLITE_OPERATIONAL_BASELINE_SQL } from "./operational-sql.ts";
import {
  createPGliteMaicoinPersistence,
  type PGliteMaicoinPersistencePort,
} from "./maicoin-operational.ts";

export const PGLITE_OPERATIONAL_BASELINE_VERSION = 1;

const OPERATIONAL_TABLES = [
  "automation_task_runs",
  "automation_task_prerequisite_notices",
  "exchange_rates",
] as const;

const OPERATIONAL_INDEXES = [
  "idx_automation_task_runs_latest",
  "idx_automation_task_runs_status",
  "idx_automation_task_runs_started_at",
  "idx_automation_prerequisite_notices_active",
  "idx_exchange_rates_currency_date",
] as const;

const OPERATIONAL_TRIGGERS = [
  "automation_task_runs_terminal_immutable",
] as const;

export type PGliteOperationalBaselineManifest = {
  readonly baselineVersion: number;
  readonly tableCount: number;
  readonly indexCount: number;
  readonly triggerCount: number;
};

export const PGLITE_OPERATIONAL_BASELINE_MANIFEST: PGliteOperationalBaselineManifest =
  Object.freeze({
    baselineVersion: PGLITE_OPERATIONAL_BASELINE_VERSION,
    tableCount: OPERATIONAL_TABLES.length,
    indexCount: OPERATIONAL_INDEXES.length,
    triggerCount: OPERATIONAL_TRIGGERS.length,
  });

export { PGLITE_OPERATIONAL_BASELINE_SQL } from "./operational-sql.ts";

type QueryDatabase = Pick<PGliteStore, "query"> | Pick<PGliteTransaction, "query">;
type Row = Record<string, unknown>;

function numeric(value: unknown): number {
  return Number(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function isCanonicalUtcInstant(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function recordScheduledAtUtc(recordJson: string): string | undefined {
  try {
    const value = JSON.parse(recordJson) as { scheduledAtUtc?: unknown };
    return typeof value.scheduledAtUtc === "string" && isCanonicalUtcInstant(value.scheduledAtUtc)
      ? value.scheduledAtUtc
      : undefined;
  } catch {
    return undefined;
  }
}

function recordAppWorkflowOutcome(recordJson: string) {
  try {
    const value = JSON.parse(recordJson) as { appWorkflowOutcome?: unknown };
    return sanitizeTypedWorkflowOutcome(value.appWorkflowOutcome);
  } catch {
    return null;
  }
}

function recordProgress(recordJson: string): AutomationTaskProgress | undefined {
  try {
    const value = JSON.parse(recordJson) as { progress?: unknown };
    if (!value.progress || typeof value.progress !== "object") return undefined;
    const candidate = value.progress as Record<string, unknown>;
    const phaseCode = candidate.phaseCode;
    const completed = candidate.completed;
    const total = candidate.total;
    const percent = candidate.percent;
    const attempt = candidate.attempt;
    if (
      (phaseCode !== null && typeof phaseCode !== "string")
      || (completed !== null && typeof completed !== "number")
      || (total !== null && typeof total !== "number")
      || (percent !== null && typeof percent !== "number")
      || typeof attempt !== "number"
    ) return undefined;
    return {
      phaseCode: phaseCode as string | null,
      completed: completed as number | null,
      total: total as number | null,
      percent: percent as number | null,
      attempt,
      ...(candidate.params && typeof candidate.params === "object"
        ? { params: candidate.params as Readonly<Record<string, string | number | boolean>> }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function recordTerminationMode(recordJson: string): "forced" | undefined {
  try {
    return JSON.parse(recordJson).terminationMode === "forced" ? "forced" : undefined;
  } catch {
    return undefined;
  }
}

const MAX_RUN_EVENTS = 200;
const RUN_EVENT_STAGES = new Set([
  "preparation", "authentication", "collection", "decoding",
  "validation", "commit", "finalization",
]);

function recordEvents(recordJson: string): readonly WorkflowRunEvent[] {
  try {
    const value = JSON.parse(recordJson) as { events?: unknown };
    return Array.isArray(value.events) ? value.events as WorkflowRunEvent[] : [];
  } catch {
    return [];
  }
}

function assertRunEvent(event: WorkflowRunEvent): void {
  if (
    !event || typeof event.runId !== "string" || event.runId.length === 0
    || !RUN_EVENT_STAGES.has(event.stage)
    || typeof event.code !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(event.code)
    || typeof event.occurredAt !== "string"
    || Number.isNaN(Date.parse(event.occurredAt))
    || (event.completed !== undefined && (!Number.isSafeInteger(event.completed) || event.completed < 0))
    || (event.total !== undefined && (!Number.isSafeInteger(event.total) || event.total < 0))
  ) throw new Error("Invalid automation run event.");
}

function rowToTaskRun(row: Row): AutomationTaskRun {
  const recordJson = String(row.record_json);
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
    logTail: sanitizeAutomationLogTail(String(row.log_tail)),
    events: recordEvents(recordJson),
    recordJson,
    appWorkflowOutcome: recordAppWorkflowOutcome(recordJson),
    scheduledAtUtc: recordScheduledAtUtc(recordJson),
    progress: recordProgress(recordJson),
    terminationMode: recordTerminationMode(recordJson),
    humanAssistanceContract: parseHumanAssistanceContract(recordJson),
  };
}

function taskRunRecordJson(run: AutomationTaskRun): string {
  const { recordJson: _recordJson, ...record } = run;
  return JSON.stringify(record);
}

function rowToTaskPrerequisiteNotice(row: Row): AutomationTaskPrerequisiteNoticeRecord {
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
): string {
  return JSON.stringify({ ...input, ...history });
}

function sanitizeRun(run: AutomationTaskRun): AutomationTaskRun {
  return {
    ...run,
    logTail: sanitizeAutomationLogTail(run.logTail),
    errorMessage: run.errorMessage === null
      ? null
      : sanitizeAutomationLogTail(run.errorMessage),
    ...(run.appWorkflowOutcome === undefined
      ? {}
      : { appWorkflowOutcome: sanitizeTypedWorkflowOutcome(run.appWorkflowOutcome) }),
  };
}

function statusPlaceholders(start: number, statuses: readonly string[]) {
  return statuses.map((_, index) => `$${start + index}`).join(", ");
}

async function taskRunByIdFrom(
  database: QueryDatabase,
  taskRunId: string,
): Promise<AutomationTaskRun | null> {
  const result = await database.query<Row>(
    "SELECT * FROM automation_task_runs WHERE task_run_id = $1",
    [taskRunId],
  );
  const row = result.rows[0];
  return row ? rowToTaskRun(row) : null;
}

async function writeTaskRun(
  transaction: PGliteTransaction,
  taskRunId: string,
  next: AutomationTaskRun,
): Promise<void> {
  const run = sanitizeRun(next);
  await transaction.query(
    `
    UPDATE automation_task_runs
    SET status = $1, attempt = $2, max_attempts = $3, finished_at = $4,
        exit_code = $5, signal = $6, error_message = $7, log_tail = $8,
        record_json = $9
    WHERE task_run_id = $10
  `,
    [
      run.status,
      run.attempt,
      run.maxAttempts,
      run.finishedAt,
      run.exitCode,
      run.signal,
      run.errorMessage,
      run.logTail,
      taskRunRecordJson(run),
      taskRunId,
    ],
  );
}

export async function applyPgliteOperationalBaseline(
  database: PGliteStore,
): Promise<void> {
  const installed = await database.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'pglite_operational_baseline_metadata') AS exists",
  );
  if (installed.rows[0]?.exists) {
    await assertPgliteOperationalBaseline(database);
    return;
  }
  await database.transaction(async (transaction) => {
    await transaction.exec(PGLITE_OPERATIONAL_BASELINE_SQL);
  });
  await assertPgliteOperationalBaseline(database);
}

export async function assertPgliteOperationalBaseline(
  database: QueryDatabase,
): Promise<void> {
  const metadata = await database.query<{
    baseline_version: number | string;
    table_count: number | string;
    index_count: number | string;
    trigger_count: number | string;
  }>(
    "SELECT baseline_version, table_count, index_count, trigger_count FROM pglite_operational_baseline_metadata WHERE singleton_id = 1",
  );
  const row = metadata.rows[0];
  if (!row) throw new Error("PGlite operational baseline metadata is missing.");
  if (
    numeric(row.baseline_version) !== PGLITE_OPERATIONAL_BASELINE_VERSION
    || numeric(row.table_count) !== PGLITE_OPERATIONAL_BASELINE_MANIFEST.tableCount
    || numeric(row.index_count) !== PGLITE_OPERATIONAL_BASELINE_MANIFEST.indexCount
    || numeric(row.trigger_count) !== PGLITE_OPERATIONAL_BASELINE_MANIFEST.triggerCount
  ) {
    throw new Error("PGlite operational baseline metadata does not match its known manifest.");
  }
  const [tables, indexes, triggers] = await Promise.all([
    database.query<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name IN (${OPERATIONAL_TABLES.map((name) => `'${name}'`).join(", ")})`,
    ),
    database.query<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM pg_class
       WHERE relkind = 'i' AND relnamespace = current_schema()::regnamespace
         AND relname IN (${OPERATIONAL_INDEXES.map((name) => `'${name}'`).join(", ")})`,
    ),
    database.query<{ count: number | string }>(
      `SELECT COUNT(*) AS count FROM pg_trigger
       WHERE NOT tgisinternal AND tgrelid IN (
         SELECT oid FROM pg_class WHERE relnamespace = current_schema()::regnamespace
       ) AND tgname IN (${OPERATIONAL_TRIGGERS.map((name) => `'${name}'`).join(", ")})`,
    ),
  ]);
  if (
    numeric(tables.rows[0]?.count ?? -1) !== PGLITE_OPERATIONAL_BASELINE_MANIFEST.tableCount
    || numeric(indexes.rows[0]?.count ?? -1) !== PGLITE_OPERATIONAL_BASELINE_MANIFEST.indexCount
    || numeric(triggers.rows[0]?.count ?? -1) !== PGLITE_OPERATIONAL_BASELINE_MANIFEST.triggerCount
  ) {
    throw new Error("PGlite operational baseline object inventory is incomplete.");
  }
}

/**
 * Domain persistence over a worker-owned PGliteStore.
 *
 * Constructing this class never creates or opens a database.  The owner is
 * responsible for opening one PGliteStore, installing both baselines, and
 * injecting it here.  Every command uses the store's asynchronous transaction
 * API so callers cannot accidentally depend on synchronous SQL compatibility.
 */
export class PGliteOperationalStore
  implements AutomationPersistencePort, ExchangeRatePersistencePort
{
  readonly #database: PGliteStore;

  constructor(database: PGliteStore) {
    this.#database = database;
  }

  async createTaskRun(input: CreateTaskRunInput): Promise<{ taskRunId: string }> {
    if (input.scheduledAtUtc !== undefined && !isCanonicalUtcInstant(input.scheduledAtUtc)) {
      throw new Error("Invalid scheduled occurrence UTC.");
    }
    const taskRunId = randomUUID();
    const errorMessage = input.errorMessage === undefined || input.errorMessage === null
      ? input.errorMessage ?? null
      : sanitizeAutomationLogTail(input.errorMessage);
    const logTail = sanitizeAutomationLogTail(input.logTail ?? "");
    const record = {
      taskRunId,
      ...input,
      errorMessage,
      logTail,
      events: [],
      humanAssistanceContract: input.humanAssistanceContract ?? null,
    };
    await this.#database.transaction(async (transaction) => {
      await transaction.query(
        `
        INSERT INTO automation_task_runs (
          task_run_id, task_id, script, kind, status, attempt, max_attempts,
          started_at, finished_at, exit_code, signal, error_message, log_path,
          log_tail, record_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      `,
        [
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
          errorMessage,
          input.logPath,
          logTail,
          JSON.stringify(record),
        ],
      );
    });
    return { taskRunId };
  }

  async updateTaskRun(taskRunId: string, update: AutomationTaskRunUpdate): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      const current = await taskRunByIdFrom(transaction, taskRunId);
      if (!current) throw new Error(`Missing automation task run: ${taskRunId}`);
      if (
        isTerminalTaskRunStatus(current.status)
        && Object.keys(update).some((key) => key !== "attempt" && key !== "maxAttempts")
      ) {
        throw new Error(`Terminal automation task run is immutable: ${taskRunId}`);
      }
      await writeTaskRun(transaction, taskRunId, { ...current, ...update });
    });
  }

  async appendRunEvent(event: WorkflowRunEvent): Promise<void> {
    assertRunEvent(event);
    await this.#database.transaction(async (transaction) => {
      const run = await taskRunByIdFrom(transaction, event.runId);
      if (!run) throw new Error(`Missing automation task run: ${event.runId}`);
      const cutoff = Date.parse(event.occurredAt) - 30 * 24 * 60 * 60 * 1_000;
      const events = [...run.events.filter((previous) =>
        Date.parse(previous.occurredAt) >= cutoff), event].slice(-MAX_RUN_EVENTS);
      await transaction.query(
        "UPDATE automation_task_runs SET record_json = $1 WHERE task_run_id = $2",
        [taskRunRecordJson({ ...run, events }), run.taskRunId],
      );
    });
  }

  async pruneRunEvents(cutoffUtc: string): Promise<number> {
    const cutoff = Date.parse(cutoffUtc);
    if (!Number.isFinite(cutoff)) throw new Error("Invalid automation event cutoff.");
    return this.#database.transaction(async (transaction) => {
      const result = await transaction.query<Row>(
        "SELECT * FROM automation_task_runs WHERE record_json LIKE '%\"events\"%'",
      );
      let removed = 0;
      for (const row of result.rows) {
        const run = rowToTaskRun(row);
        const events = run.events.filter((event) => Date.parse(event.occurredAt) >= cutoff);
        if (events.length === run.events.length) continue;
        removed += run.events.length - events.length;
        await transaction.query(
          "UPDATE automation_task_runs SET record_json = $1 WHERE task_run_id = $2",
          [taskRunRecordJson({ ...run, events }), run.taskRunId],
        );
      }
      return removed;
    });
  }

  private async transitionTaskRunConditionally(
    taskRunId: string,
    update: AutomationTaskRunUpdate & { status: AutomationTaskStatus },
    allowedStatuses: readonly AutomationTaskStatus[],
  ): Promise<{ status: AutomationTaskStatus; applied: boolean }> {
    return this.#database.transaction(async (transaction) => {
      const current = await taskRunByIdFrom(transaction, taskRunId);
      if (!current) throw new Error(`Missing automation task run: ${taskRunId}`);
      if (!allowedStatuses.includes(current.status)) {
        return { status: current.status, applied: false };
      }
      const next = sanitizeRun({ ...current, ...update });
      const firstStatus = 11;
      const changed = await transaction.query<{ task_run_id: string }>(
        `
        UPDATE automation_task_runs
        SET status = $1, attempt = $2, max_attempts = $3, finished_at = $4,
            exit_code = $5, signal = $6, error_message = $7, log_tail = $8,
            record_json = $9
        WHERE task_run_id = $10 AND status IN (${statusPlaceholders(firstStatus, allowedStatuses)})
        RETURNING task_run_id
      `,
        [
          next.status,
          next.attempt,
          next.maxAttempts,
          next.finishedAt,
          next.exitCode,
          next.signal,
          next.errorMessage,
          next.logTail,
          taskRunRecordJson(next),
          taskRunId,
          ...allowedStatuses,
        ],
      );
      if (changed.rows.length > 0) return { status: next.status, applied: true };
      const latest = await taskRunByIdFrom(transaction, taskRunId);
      if (!latest) throw new Error(`Missing automation task run: ${taskRunId}`);
      return { status: latest.status, applied: false };
    });
  }

  transitionTaskRunToActive(
    taskRunId: string,
    update: AutomationTaskRunActiveUpdate,
  ): Promise<{ status: AutomationTaskStatus; applied: boolean }> {
    return this.transitionTaskRunConditionally(taskRunId, update, ACTIVE_TASK_RUN_STATUSES);
  }

  transitionTaskRunToTerminal(
    taskRunId: string,
    update: AutomationTaskRunTerminalUpdate,
  ): Promise<{ status: AutomationTaskStatus; applied: boolean }> {
    return this.transitionTaskRunConditionally(taskRunId, update, ACTIVE_TASK_RUN_STATUSES);
  }

  async updateHumanAssistanceContract(
    taskRunId: string,
    input: HumanAssistanceContractInput,
  ): Promise<HumanAssistanceContract> {
    return this.#database.transaction(async (transaction) => {
      const run = await taskRunByIdFrom(transaction, taskRunId);
      if (!run) throw new Error(`Missing automation task run: ${taskRunId}`);
      if (run.status !== "running" && run.status !== "waiting_for_human") {
        throw new Error(`Automation task run is not active: ${taskRunId}`);
      }
      const version = (run.humanAssistanceContract?.version ?? 0) + 1;
      const contract = createHumanAssistanceContract(input, version);
      await writeTaskRun(transaction, taskRunId, {
        ...run,
        humanAssistanceContract: contract,
      });
      return contract;
    });
  }

  async updateHumanAssistanceCompletion(
    taskRunId: string,
    status: HumanAssistanceCompletionStatus,
  ): Promise<HumanAssistanceContract> {
    return this.#database.transaction(async (transaction) => {
      const run = await taskRunByIdFrom(transaction, taskRunId);
      if (!run?.humanAssistanceContract) {
        throw new Error(`Missing human assistance contract: ${taskRunId}`);
      }
      const contract = createHumanAssistanceContract(
        {
          ...run.humanAssistanceContract,
          completion: {
            ...run.humanAssistanceContract.completion,
            status,
          },
        },
        run.humanAssistanceContract.version + 1,
      );
      await writeTaskRun(transaction, taskRunId, {
        ...run,
        humanAssistanceContract: contract,
      });
      return contract;
    });
  }

  taskRunById(taskRunId: string): Promise<AutomationTaskRun | null> {
    return taskRunByIdFrom(this.#database, taskRunId);
  }

  async activeTaskRuns(): Promise<AutomationTaskRun[]> {
    const result = await this.#database.query<Row>(
      `
      SELECT * FROM automation_task_runs
      WHERE status IN (${ACTIVE_TASK_RUN_STATUSES.map((_, index) => `$${index + 1}`).join(", ")})
      ORDER BY started_at ASC
    `,
      ACTIVE_TASK_RUN_STATUSES,
    );
    return result.rows.map(rowToTaskRun);
  }

  async latestTaskRuns(): Promise<Record<string, AutomationTaskRun>> {
    const result = await this.#database.query<Row>(
      `
      SELECT DISTINCT ON (task_id) *
      FROM automation_task_runs
      ORDER BY task_id, started_at DESC, task_run_id DESC
    `,
    );
    return Object.fromEntries(result.rows.map((row) => {
      const run = rowToTaskRun(row);
      return [run.taskId, run];
    }));
  }

  async todayTaskRunIds(input: { startUtc: Date; endUtc: Date }): Promise<string[]> {
    const result = await this.#database.query<{ task_id: string }>(
      `
      SELECT DISTINCT task_id
      FROM automation_task_runs
      WHERE started_at >= $1 AND started_at < $2
      ORDER BY task_id
    `,
      [input.startUtc.toISOString(), input.endUtc.toISOString()],
    );
    return result.rows.map((row) => row.task_id);
  }

  async hasSuccessfulTaskRunSince(taskId: string, occurrence: string): Promise<boolean> {
    const result = await this.#database.query<{ exists: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1 FROM automation_task_runs
        WHERE task_id = $1 AND status = 'completed' AND finished_at >= $2
      ) AS exists
    `,
      [taskId, occurrence],
    );
    return Boolean(result.rows[0]?.exists);
  }

  async hasOccurrenceBeenAttempted(taskId: string, occurrenceUtc: string): Promise<boolean> {
    if (!isCanonicalUtcInstant(occurrenceUtc)) {
      throw new Error("Invalid scheduled occurrence UTC.");
    }
    const result = await this.#database.query<{ exists: boolean }>(
      `
      SELECT EXISTS (
        SELECT 1 FROM automation_task_runs
        WHERE task_id = $1 AND (
          record_json::jsonb ->> 'scheduledAtUtc' = $2
          OR right(script, char_length(' --scheduled-at-utc ' || $2)) = ' --scheduled-at-utc ' || $2
        )
      ) AS exists
    `,
      [taskId, occurrenceUtc],
    );
    return Boolean(result.rows[0]?.exists);
  }

  async recentTaskRuns(limit = 100): Promise<AutomationTaskHistoryRow[]> {
    const result = await this.#database.query<Row>(
      `
      SELECT task_run_id, task_id, script, kind, status, started_at,
             finished_at, exit_code, signal, error_message, log_path
      FROM automation_task_runs
      ORDER BY started_at DESC, task_run_id DESC
      LIMIT $1
    `,
      [limit],
    );
    return result.rows.map((row) => ({
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

  async upsertTaskPrerequisiteNotice(input: {
    taskId: string;
    prerequisiteId: string;
    taskRunId: string;
    detectedAt: string;
    errorMessage?: string | null;
  }): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      const existing = await transaction.query<{ record_json: string }>(
        `
        SELECT record_json FROM automation_task_prerequisite_notices
        WHERE task_id = $1 AND prerequisite_id = $2
      `,
        [input.taskId, input.prerequisiteId],
      );
      const history = noticeHistory(existing.rows[0]?.record_json ?? "{}");
      if (history.detections.at(-1)?.taskRunId !== input.taskRunId) {
        history.detections.push({ taskRunId: input.taskRunId, detectedAt: input.detectedAt });
      }
      const noticeId = `automation-prerequisite:${input.taskId}:${input.prerequisiteId}`;
      await transaction.query(
        `
        INSERT INTO automation_task_prerequisite_notices (
          notice_id, task_id, prerequisite_id, latest_task_run_id,
          first_detected_at, last_detected_at, latest_error_message,
          resolved_at, resolved_by_task_run_id, record_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, $8)
        ON CONFLICT (task_id, prerequisite_id) DO UPDATE SET
          latest_task_run_id = EXCLUDED.latest_task_run_id,
          last_detected_at = EXCLUDED.last_detected_at,
          latest_error_message = EXCLUDED.latest_error_message,
          resolved_at = NULL,
          resolved_by_task_run_id = NULL,
          record_json = EXCLUDED.record_json
      `,
        [
          noticeId,
          input.taskId,
          input.prerequisiteId,
          input.taskRunId,
          history.detections[0]?.detectedAt ?? input.detectedAt,
          input.detectedAt,
          input.errorMessage ?? null,
          noticeRecordJson(
            { taskId: input.taskId, prerequisiteId: input.prerequisiteId },
            history,
          ),
        ],
      );
    });
  }

  async activeTaskPrerequisiteNotices(): Promise<AutomationTaskPrerequisiteNoticeRecord[]> {
    const result = await this.#database.query<Row>(
      `
      SELECT * FROM automation_task_prerequisite_notices
      WHERE resolved_at IS NULL
      ORDER BY last_detected_at DESC
    `,
    );
    return result.rows.map(rowToTaskPrerequisiteNotice);
  }

  async allTaskPrerequisiteNotices(): Promise<AutomationTaskPrerequisiteNoticeRecord[]> {
    const result = await this.#database.query<Row>(
      "SELECT * FROM automation_task_prerequisite_notices ORDER BY last_detected_at DESC",
    );
    return result.rows.map(rowToTaskPrerequisiteNotice);
  }

  async resolveTaskPrerequisiteNotices(
    taskId: string,
    resolvedByTaskRunId: string,
    resolvedAt: string,
  ): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      const rows = await transaction.query<Row>(
        `
        SELECT * FROM automation_task_prerequisite_notices
        WHERE task_id = $1 AND resolved_at IS NULL
      `,
        [taskId],
      );
      for (const row of rows.rows) {
        const notice = rowToTaskPrerequisiteNotice(row);
        const history = noticeHistory(notice.recordJson);
        history.resolutions.push({ taskRunId: resolvedByTaskRunId, resolvedAt });
        await transaction.query(
          `
          UPDATE automation_task_prerequisite_notices
          SET resolved_at = $1, resolved_by_task_run_id = $2, record_json = $3
          WHERE notice_id = $4
        `,
          [
            resolvedAt,
            resolvedByTaskRunId,
            noticeRecordJson(
              { taskId: notice.taskId, prerequisiteId: notice.prerequisiteId },
              history,
            ),
            notice.noticeId,
          ],
        );
      }
    });
  }

  async readExchangeRates(currencies?: string[]): Promise<ExchangeRateRecord[]> {
    if (currencies?.length === 0) return [];
    const params: readonly unknown[] = currencies ?? [];
    const where = currencies
      ? `WHERE currency IN (${currencies.map((_, index) => `$${index + 1}`).join(", ")})`
      : "";
    const result = await this.#database.query<ExchangeRateRecord>(
      `
      SELECT rate_date AS "rateDate", currency,
             twd_per_unit AS "twdPerUnit", source,
             fetched_at AS "fetchedAt"
      FROM exchange_rates
      ${where}
      ORDER BY currency, rate_date
    `,
      params,
    );
    return result.rows.map((row) => ({ ...row }));
  }

  async upsertExchangeRates(rows: readonly ExchangeRateRecord[]): Promise<void> {
    if (rows.length === 0) return;
    await this.#database.transaction(async (transaction) => {
      for (const row of rows) {
        await transaction.query(
          `
          INSERT INTO exchange_rates
            (rate_date, currency, twd_per_unit, source, fetched_at)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (rate_date, currency) DO UPDATE SET
            twd_per_unit = EXCLUDED.twd_per_unit,
            source = EXCLUDED.source,
            fetched_at = EXCLUDED.fetched_at
        `,
          [row.rateDate, row.currency, row.twdPerUnit, row.source, row.fetchedAt],
        );
      }
    });
  }
}

export function createPgliteOperationalStore(
  database: PGliteStore,
): PGliteOperationalStore {
  return new PGliteOperationalStore(database);
}

/** One injected provider carrying every operational domain over one database. */
export type PGliteOperationalProvider = Readonly<{
  automation: AutomationPersistencePort;
  exchangeRates: ExchangeRatePersistencePort;
  maicoin: PGliteMaicoinPersistencePort;
}>;

export function createPgliteOperationalProvider(
  database: PGliteStore,
): PGliteOperationalProvider & AutomationPersistenceProvider {
  const operational = createPgliteOperationalStore(database);
  return Object.freeze({
    automation: operational,
    exchangeRates: operational,
    maicoin: createPGliteMaicoinPersistence(database),
  });
}
