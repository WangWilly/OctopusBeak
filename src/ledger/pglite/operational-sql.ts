const TERMINAL_TASK_RUN_GUARD_SQL = String.raw`
CREATE OR REPLACE FUNCTION pglite_guard_terminal_automation_task_run()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $guard$
BEGIN
  IF OLD.status IN ('completed', 'partial', 'failed', 'cancelled', 'interrupted') THEN
    IF NEW.task_run_id IS DISTINCT FROM OLD.task_run_id
      OR NEW.task_id IS DISTINCT FROM OLD.task_id
      OR NEW.kind IS DISTINCT FROM OLD.kind
      OR NEW.status IS DISTINCT FROM OLD.status
      OR NEW.started_at IS DISTINCT FROM OLD.started_at
      OR NEW.finished_at IS DISTINCT FROM OLD.finished_at
    THEN
      RAISE EXCEPTION 'Terminal automation task run is immutable: %', OLD.task_run_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$guard$;
`;

const COMMIT_ATTEMPTS_TABLE_SQL = String.raw`
CREATE TABLE IF NOT EXISTS automation_task_run_commit_attempts (
  task_run_id TEXT NOT NULL REFERENCES automation_task_runs(task_run_id),
  attempt_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('started', 'settled')),
  product TEXT,
  total INTEGER CHECK (total >= 0),
  outcome TEXT CHECK (outcome IN ('completed', 'failed', 'cancelled', 'refused')),
  committed_count INTEGER CHECK (committed_count >= 0),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (task_run_id, attempt_id, phase),
  CHECK (
    (phase = 'started' AND total IS NOT NULL AND outcome IS NULL AND committed_count IS NULL)
    OR (phase = 'settled' AND product IS NULL AND total IS NULL
      AND outcome IS NOT NULL AND committed_count IS NOT NULL)
  )
);
`;

/**
 * Fresh operational persistence for automation lifecycle state and exchange
 * rates.  This schema is deliberately separate from the generated canonical
 * baseline: both are installed in the same worker-owned PGlite database, but
 * operational records have a different lifecycle and are rebuildable.
 *
 * Keep this SQL static and reviewable.  Runtime code must never inspect or
 * open the legacy SQLite schema to install these tables.
 */
export const PGLITE_OPERATIONAL_BASELINE_SQL: string = String.raw`
CREATE TABLE IF NOT EXISTS pglite_operational_baseline_metadata (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  baseline_version INTEGER NOT NULL,
  table_count INTEGER NOT NULL,
  index_count INTEGER NOT NULL,
  trigger_count INTEGER NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS automation_task_runs (
  task_run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('crawler', 'sync')),
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'preparing', 'running', 'waiting_for_human',
    'retrying', 'cancelling', 'completed', 'partial', 'cancelled',
    'interrupted', 'failed', 'locked', 'needs_setup'
  )),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  max_attempts INTEGER NOT NULL CHECK (max_attempts >= 1),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  record_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_automation_task_runs_latest
  ON automation_task_runs(task_id, started_at);
CREATE INDEX IF NOT EXISTS idx_automation_task_runs_status
  ON automation_task_runs(status, started_at);
CREATE INDEX IF NOT EXISTS idx_automation_task_runs_started_at
  ON automation_task_runs(started_at DESC);
${COMMIT_ATTEMPTS_TABLE_SQL}
CREATE TABLE IF NOT EXISTS automation_task_prerequisite_notices (
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

CREATE INDEX IF NOT EXISTS idx_automation_prerequisite_notices_active
  ON automation_task_prerequisite_notices(task_id, resolved_at, last_detected_at);

CREATE TABLE IF NOT EXISTS exchange_rates (
  rate_date TEXT NOT NULL,
  currency TEXT NOT NULL,
  twd_per_unit DOUBLE PRECISION NOT NULL
    CHECK (twd_per_unit > 0 AND twd_per_unit < 'Infinity'::DOUBLE PRECISION),
  source TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (rate_date, currency)
);

CREATE INDEX IF NOT EXISTS idx_exchange_rates_currency_date
  ON exchange_rates(currency, rate_date);

${TERMINAL_TASK_RUN_GUARD_SQL}
DROP TRIGGER IF EXISTS automation_task_runs_terminal_immutable
  ON automation_task_runs;
CREATE TRIGGER automation_task_runs_terminal_immutable
BEFORE UPDATE ON automation_task_runs
FOR EACH ROW
EXECUTE FUNCTION pglite_guard_terminal_automation_task_run();

INSERT INTO pglite_operational_baseline_metadata(
  singleton_id, baseline_version, table_count, index_count, trigger_count
)
VALUES (1, 5, 4, 5, 1)
ON CONFLICT (singleton_id) DO NOTHING;
`;

/**
 * Forward step for an existing baseline-2 database: drop the subprocess-era
 * `exit_code` and `signal` run columns (ADR 0052) and refresh the terminal
 * guard that compared them.  Run inside one transaction by the baseline owner.
 */
export const PGLITE_OPERATIONAL_BASELINE_V2_TO_V3_SQL: string = String.raw`
ALTER TABLE automation_task_runs DROP COLUMN exit_code, DROP COLUMN signal;

${TERMINAL_TASK_RUN_GUARD_SQL}
UPDATE pglite_operational_baseline_metadata
SET baseline_version = 3
WHERE singleton_id = 1 AND baseline_version = 2;
`;

/**
 * Forward step for an existing baseline-3 database: add the append-only
 * Commit attempt record that decides a run's commit outcome (ADR 0056).
 */
export const PGLITE_OPERATIONAL_BASELINE_V3_TO_V4_SQL: string = String.raw`
${COMMIT_ATTEMPTS_TABLE_SQL}
UPDATE pglite_operational_baseline_metadata
SET baseline_version = 4, table_count = 4
WHERE singleton_id = 1 AND baseline_version = 3;
`;

/**
 * Forward step for an existing baseline-4 database: a Commit attempt refused
 * before admission settles as `refused` (ADR 0057).
 */
export const PGLITE_OPERATIONAL_BASELINE_V4_TO_V5_SQL: string = String.raw`
ALTER TABLE automation_task_run_commit_attempts
  DROP CONSTRAINT automation_task_run_commit_attempts_outcome_check,
  ADD CONSTRAINT automation_task_run_commit_attempts_outcome_check
    CHECK (outcome IN ('completed', 'failed', 'cancelled', 'refused'));
UPDATE pglite_operational_baseline_metadata
SET baseline_version = 5
WHERE singleton_id = 1 AND baseline_version = 4;
`;
