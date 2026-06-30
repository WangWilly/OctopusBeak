# Automation Control Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local `/automation` control panel that saves `.env` credentials, runs existing npm tasks one at a time, records task history, and gates CSV import by today's crawler success history.

**Architecture:** Add a small automation server module under `src/lib/automation/server/` for registry, env file edits, business-day time windows, SQLite task history, and process execution. Add one SvelteKit route at `src/routes/automation/` that renders a dashboard-style task table and calls server actions. Keep crawler workflows unchanged.

**Tech Stack:** SvelteKit, Svelte 5, Node `child_process.spawn`, Node `fs`, `node:sqlite`, existing ledger migrations, assert-based `*.check.ts` tests.

---

### Task 1: Automation Registry, Business Day, And Env File Helpers

**Files:**
- Create: `src/lib/automation/server/tasks.ts`
- Create: `src/lib/automation/server/business-day.ts`
- Create: `src/lib/automation/server/env-file.ts`
- Create: `src/lib/automation/server/automation-core.check.ts`

- [ ] **Step 1: Write the failing core checks**

Create `src/lib/automation/server/automation-core.check.ts`:

```ts
import assert from "node:assert/strict";
import {
  CSV_IMPORT_DEPENDENCY_IDS,
  AUTOMATION_TASKS,
  taskById,
} from "./tasks.ts";
import { businessDayUtcRange } from "./business-day.ts";
import {
  credentialStatus,
  updateEnvText,
} from "./env-file.ts";

const fubonUserKey = "LIBRETTO_CLOUD_FUBON" + "_USER_ID";

assert.deepEqual(
  CSV_IMPORT_DEPENDENCY_IDS,
  [
    "fubon-all-statements",
    "esun-credit-card-statements",
    "yuanta-all-statements",
    "yuanta-trade-statements",
    "cathay-all-statements",
    "hncb-statements",
  ],
);

assert.equal(taskById("sync-maicoin")?.kind, "sync");
assert.equal(taskById("import-downloads-csv")?.kind, "import");
assert.deepEqual(
  taskById("import-downloads-csv")?.dependencies,
  CSV_IMPORT_DEPENDENCY_IDS,
);
assert.equal(AUTOMATION_TASKS.every((task) => task.maxAttempts >= 1), true);

const taipeiRange = businessDayUtcRange(
  new Date("2026-06-30T16:30:00.000Z"),
  "Asia/Taipei",
);
assert.equal(taipeiRange.businessDate, "2026-07-01");
assert.equal(taipeiRange.startUtc.toISOString(), "2026-06-30T16:00:00.000Z");
assert.equal(taipeiRange.endUtc.toISOString(), "2026-07-01T16:00:00.000Z");

const updatedEnv = updateEnvText(
  `# keep me\n${fubonUserKey}=old\nOTHER=value\n`,
  {
    [fubonUserKey]: "new-user",
    MAX_SUB_ACCOUNT: "main",
  },
);
assert.equal(
  updatedEnv,
  `# keep me\n${fubonUserKey}=new-user\nOTHER=value\nMAX_SUB_ACCOUNT=main\n`,
);

assert.deepEqual(
  credentialStatus(`${fubonUserKey}=abc\nMAX_SECRET_KEY=\n`),
  {
    [fubonUserKey]: true,
    MAX_SECRET_KEY: false,
  },
);
```

- [ ] **Step 2: Run the core checks and verify RED**

Run: `node --no-warnings --experimental-strip-types src/lib/automation/server/automation-core.check.ts`

Expected: FAIL with module-not-found errors for the new helper modules.

- [ ] **Step 3: Implement the minimal helpers**

Create `src/lib/automation/server/tasks.ts`:

```ts
export type AutomationTaskKind = "crawler" | "sync" | "import";

export type AutomationTask = {
  id: string;
  label: string;
  script: string;
  kind: AutomationTaskKind;
  credentialKeys: readonly string[];
  dependencies: readonly string[];
  maxAttempts: number;
};

export const CSV_IMPORT_DEPENDENCY_IDS = [
  "fubon-all-statements",
  "esun-credit-card-statements",
  "yuanta-all-statements",
  "yuanta-trade-statements",
  "cathay-all-statements",
  "hncb-statements",
] as const;

export const AUTOMATION_TASKS: readonly AutomationTask[] = [
  {
    id: "fubon-all-statements",
    label: "Fubon all statements",
    script: "run:fubon-all-statements",
    kind: "crawler",
    credentialKeys: [
      "LIBRETTO_CLOUD_FUBON_USER_ID",
      "LIBRETTO_CLOUD_FUBON_ACCOUNT",
      "LIBRETTO_CLOUD_FUBON_PASSWORD",
    ],
    dependencies: [],
    maxAttempts: 2,
  },
  {
    id: "esun-credit-card-statements",
    label: "ESun credit card statements",
    script: "run:esun-credit-card-statements",
    kind: "crawler",
    credentialKeys: [
      "LIBRETTO_CLOUD_ESUN_USER_ID",
      "LIBRETTO_CLOUD_ESUN_ACCOUNT",
      "LIBRETTO_CLOUD_ESUN_PASSWORD",
    ],
    dependencies: [],
    maxAttempts: 2,
  },
  {
    id: "yuanta-all-statements",
    label: "Yuanta all statements",
    script: "run:yuanta-all-statements",
    kind: "crawler",
    credentialKeys: [
      "LIBRETTO_CLOUD_YUANTA_USER_ID",
      "LIBRETTO_CLOUD_YUANTA_ACCOUNT",
      "LIBRETTO_CLOUD_YUANTA_PASSWORD",
    ],
    dependencies: [],
    maxAttempts: 2,
  },
  {
    id: "yuanta-trade-statements",
    label: "Yuanta trade statements",
    script: "run:yuanta-trade-statements",
    kind: "crawler",
    credentialKeys: [
      "LIBRETTO_CLOUD_YUANTA_TRADE_USER_ID",
      "LIBRETTO_CLOUD_YUANTA_TRADE_PASSWORD",
      "LIBRETTO_CLOUD_YUANTA_TRADE_CA_PATH",
      "LIBRETTO_CLOUD_YUANTA_TRADE_CA_PASSWORD",
    ],
    dependencies: [],
    maxAttempts: 2,
  },
  {
    id: "cathay-all-statements",
    label: "Cathay all statements",
    script: "run:cathay-all-statements",
    kind: "crawler",
    credentialKeys: [
      "LIBRETTO_CLOUD_CATHAY_USER_ID",
      "LIBRETTO_CLOUD_CATHAY_ACCOUNT",
      "LIBRETTO_CLOUD_CATHAY_PASSWORD",
    ],
    dependencies: [],
    maxAttempts: 2,
  },
  {
    id: "hncb-statements",
    label: "HNCB statements",
    script: "run:hncb-statements",
    kind: "crawler",
    credentialKeys: [
      "LIBRETTO_CLOUD_HNCB_USER_ID",
      "LIBRETTO_CLOUD_HNCB_ACCOUNT",
      "LIBRETTO_CLOUD_HNCB_PASSWORD",
    ],
    dependencies: [],
    maxAttempts: 2,
  },
  {
    id: "sync-maicoin",
    label: "MaiCoin sync",
    script: "run:sync-maicoin",
    kind: "sync",
    credentialKeys: ["MAX_ACCESS_KEY", "MAX_SECRET_KEY", "MAX_SUB_ACCOUNT"],
    dependencies: [],
    maxAttempts: 1,
  },
  {
    id: "import-downloads-csv",
    label: "Import downloads CSV",
    script: "run:import-downloads-csv",
    kind: "import",
    credentialKeys: [],
    dependencies: CSV_IMPORT_DEPENDENCY_IDS,
    maxAttempts: 1,
  },
];

export function taskById(taskId: string) {
  return AUTOMATION_TASKS.find((task) => task.id === taskId) ?? null;
}
```

Create `src/lib/automation/server/business-day.ts`:

```ts
type DateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function partsInTimeZone(date: Date, timeZone: string): DateParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function offsetMs(date: Date, timeZone: string) {
  const parts = partsInTimeZone(date, timeZone);
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return localAsUtc - date.getTime();
}

function zonedMidnightUtc(year: number, month: number, day: number, timeZone: string) {
  let utc = Date.UTC(year, month - 1, day);
  for (let index = 0; index < 3; index += 1) {
    utc = Date.UTC(year, month - 1, day) - offsetMs(new Date(utc), timeZone);
  }
  return new Date(utc);
}

export function businessDayUtcRange(now = new Date(), timeZone = process.env.AUTOMATION_BUSINESS_TIMEZONE ?? "Asia/Taipei") {
  const parts = partsInTimeZone(now, timeZone);
  const startUtc = zonedMidnightUtc(parts.year, parts.month, parts.day, timeZone);
  const endLocal = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  const endUtc = zonedMidnightUtc(
    endLocal.getUTCFullYear(),
    endLocal.getUTCMonth() + 1,
    endLocal.getUTCDate(),
    timeZone,
  );
  return {
    businessDate: `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`,
    startUtc,
    endUtc,
  };
}
```

Create `src/lib/automation/server/env-file.ts`:

```ts
const envLinePattern = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

export function parseEnvText(text: string) {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = envLinePattern.exec(line);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

export function credentialStatus(text: string, keys?: readonly string[]) {
  const env = parseEnvText(text);
  const selectedKeys = keys ?? Object.keys(env);
  return Object.fromEntries(
    selectedKeys.map((key) => [key, Boolean(env[key]?.trim())]),
  );
}

export function updateEnvText(text: string, updates: Record<string, string>) {
  const remaining = new Set(Object.keys(updates));
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();

  const nextLines = lines.map((line) => {
    const match = envLinePattern.exec(line);
    if (!match) return line;
    const key = match[1];
    if (!remaining.has(key)) return line;
    remaining.delete(key);
    return `${key}=${updates[key]}`;
  });

  for (const key of remaining) nextLines.push(`${key}=${updates[key]}`);
  return `${nextLines.join("\n")}\n`;
}
```

- [ ] **Step 4: Run the core checks and verify GREEN**

Run: `node --no-warnings --experimental-strip-types src/lib/automation/server/automation-core.check.ts`

Expected: exit 0.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/lib/automation/server/tasks.ts src/lib/automation/server/business-day.ts src/lib/automation/server/env-file.ts src/lib/automation/server/automation-core.check.ts
git commit -m "feat: add automation core helpers"
```

### Task 2: SQLite Automation Task History

**Files:**
- Modify: `src/ledger/db/migrations.ts`
- Modify: `src/ledger/db/schema.ts`
- Create: `src/lib/automation/server/store.ts`
- Create: `src/lib/automation/server/store.check.ts`

- [ ] **Step 1: Write the failing store checks**

Create `src/lib/automation/server/store.check.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import {
  createTaskRun,
  importGateStatus,
  latestTaskRuns,
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
```

- [ ] **Step 2: Run the store checks and verify RED**

Run: `node --no-warnings --experimental-strip-types src/lib/automation/server/store.check.ts`

Expected: FAIL because `store.ts` does not exist.

- [ ] **Step 3: Add the migration and schema**

In `src/ledger/db/schema.ts`, add:

```ts
export const automationTaskRuns = sqliteTable("automation_task_runs", {
  taskRunId: text("task_run_id").primaryKey(),
  taskId: text("task_id").notNull(),
  script: text("script").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  attempt: integer("attempt").notNull(),
  maxAttempts: integer("max_attempts").notNull(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  exitCode: integer("exit_code"),
  signal: text("signal"),
  errorMessage: text("error_message"),
  logPath: text("log_path").notNull(),
  logTail: text("log_tail").notNull(),
  recordJson: text("record_json").notNull(),
});
```

In `src/ledger/db/migrations.ts`, add:

```ts
function createAutomationTaskRuns(db: LedgerDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_task_runs (
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
    CREATE INDEX IF NOT EXISTS idx_automation_task_runs_latest
    ON automation_task_runs(task_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_automation_task_runs_status
    ON automation_task_runs(status, started_at);
  `);
}
```

Append migration:

```ts
{
  version: 7,
  name: "automation_task_runs",
  up: createAutomationTaskRuns,
},
```

- [ ] **Step 4: Implement the store**

Create `src/lib/automation/server/store.ts`:

```ts
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
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    signal: row.signal === null ? null : String(row.signal),
    errorMessage: row.error_message === null ? null : String(row.error_message),
    logPath: String(row.log_path),
    logTail: String(row.log_tail),
    recordJson: String(row.record_json),
  };
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
  const row = db.prepare("SELECT * FROM automation_task_runs WHERE task_run_id = ?").get(taskRunId) as Record<string, unknown> | undefined;
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
    JSON.stringify(next),
    taskRunId,
  );
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
    `).get(taskId, input.startUtc.toISOString(), input.endUtc.toISOString()) as { status?: string } | undefined;
    return row?.status !== "completed";
  });
  return {
    locked: missingTaskIds.length > 0,
    missingTaskIds,
  };
}
```

- [ ] **Step 5: Run the store checks and verify GREEN**

Run: `node --no-warnings --experimental-strip-types src/lib/automation/server/store.check.ts`

Expected: exit 0.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/ledger/db/migrations.ts src/ledger/db/schema.ts src/lib/automation/server/store.ts src/lib/automation/server/store.check.ts
git commit -m "feat: record automation task history"
```

### Task 3: Task Runner

**Files:**
- Create: `src/lib/automation/server/runner.ts`
- Create: `src/lib/automation/server/runner.check.ts`

- [ ] **Step 1: Write the failing runner checks**

Create `src/lib/automation/server/runner.check.ts`:

```ts
import assert from "node:assert/strict";
import { shouldMarkWaitingForHuman, nextAttemptStatus } from "./runner.ts";

assert.equal(shouldMarkWaitingForHuman("libretto paused. resume --session abc"), true);
assert.equal(shouldMarkWaitingForHuman("Please enter OTP in browser"), true);
assert.equal(shouldMarkWaitingForHuman("download completed"), false);

assert.equal(
  nextAttemptStatus({ kind: "crawler", attempt: 1, maxAttempts: 2, exitCode: 1 }),
  "retrying",
);
assert.equal(
  nextAttemptStatus({ kind: "crawler", attempt: 2, maxAttempts: 2, exitCode: 1 }),
  "failed",
);
assert.equal(
  nextAttemptStatus({ kind: "sync", attempt: 1, maxAttempts: 1, exitCode: 1 }),
  "failed",
);
assert.equal(
  nextAttemptStatus({ kind: "crawler", attempt: 1, maxAttempts: 2, exitCode: 0 }),
  "completed",
);
```

- [ ] **Step 2: Run the runner checks and verify RED**

Run: `node --no-warnings --experimental-strip-types src/lib/automation/server/runner.check.ts`

Expected: FAIL because `runner.ts` does not exist.

- [ ] **Step 3: Implement minimal runner helpers and process runner**

Create `src/lib/automation/server/runner.ts` with:

```ts
import { spawn } from "node:child_process";
import { mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import { createTaskRun, updateTaskRun, type AutomationTaskStatus } from "./store.ts";
import { taskById, type AutomationTaskKind } from "./tasks.ts";

let activeTaskRunId: string | null = null;

export function shouldMarkWaitingForHuman(output: string) {
  return /resume --session|paused|captcha|otp|verification|certificate/i.test(output);
}

export function nextAttemptStatus(input: {
  kind: AutomationTaskKind;
  attempt: number;
  maxAttempts: number;
  exitCode: number | null;
}): AutomationTaskStatus {
  if (input.exitCode === 0) return "completed";
  if (input.kind === "crawler" && input.attempt < input.maxAttempts) return "retrying";
  return "failed";
}

function appendLog(logPath: string, chunk: string) {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, chunk);
}

function tail(value: string) {
  return value.slice(-4000);
}

export function hasActiveAutomationTask() {
  return activeTaskRunId !== null;
}

export async function runAutomationTask(taskId: string, ledgerDir = process.env.LEDGER_DIR ?? "data/ledger") {
  const task = taskById(taskId);
  if (!task) throw new Error(`Unknown automation task: ${taskId}`);
  if (activeTaskRunId) throw new Error("Another automation task is already running.");

  const db = openLedgerDatabase(ledgerDir);
  try {
    for (let attempt = 1; attempt <= task.maxAttempts; attempt += 1) {
      const startedAt = new Date().toISOString();
      const logPath = join("data", "automation", "logs", `${task.id}-${Date.now()}-${attempt}.log`);
      const run = createTaskRun(db, {
        taskId: task.id,
        script: task.script,
        kind: task.kind,
        status: attempt > 1 ? "retrying" : "running",
        attempt,
        maxAttempts: task.maxAttempts,
        startedAt,
        logPath,
      });
      activeTaskRunId = run.taskRunId;
      let logTail = "";

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const child = spawn("npm", ["run", task.script], {
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        });
        child.stdout.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          appendLog(logPath, text);
          logTail = tail(logTail + text);
          if (shouldMarkWaitingForHuman(logTail)) {
            updateTaskRun(db, run.taskRunId, { status: "waiting_for_human", logTail });
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          appendLog(logPath, text);
          logTail = tail(logTail + text);
          if (shouldMarkWaitingForHuman(logTail)) {
            updateTaskRun(db, run.taskRunId, { status: "waiting_for_human", logTail });
          }
        });
        child.on("error", reject);
        child.on("close", (code) => resolve(code));
      });

      const status = nextAttemptStatus({
        kind: task.kind,
        attempt,
        maxAttempts: task.maxAttempts,
        exitCode,
      });
      updateTaskRun(db, run.taskRunId, {
        status,
        finishedAt: new Date().toISOString(),
        exitCode,
        logTail,
        errorMessage: status === "failed" ? `Task exited with code ${exitCode}` : null,
      });
      activeTaskRunId = null;
      if (status === "completed") return { status };
    }
    return { status: "failed" as const };
  } finally {
    activeTaskRunId = null;
    db.close();
  }
}
```

- [ ] **Step 4: Run the runner checks and verify GREEN**

Run: `node --no-warnings --experimental-strip-types src/lib/automation/server/runner.check.ts`

Expected: exit 0.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/lib/automation/server/runner.ts src/lib/automation/server/runner.check.ts
git commit -m "feat: add automation task runner"
```

### Task 4: Automation Route And UI

**Files:**
- Modify: `src/lib/shared-shell/components/DashboardShell.svelte`
- Create: `src/lib/automation/AutomationDashboard.svelte`
- Create: `src/routes/automation/+page.server.ts`
- Create: `src/routes/automation/+page.svelte`

- [ ] **Step 1: Add the route load/action skeleton**

Create `src/routes/automation/+page.server.ts` with load data from `AUTOMATION_TASKS`, `latestTaskRuns`, `importGateStatus`, `businessDayUtcRange`, and `credentialStatus`. Add actions `saveCredentials`, `run`, and `retry` that call `updateEnvText` or `runAutomationTask`.

- [ ] **Step 2: Add the Svelte page wrapper**

Create `src/routes/automation/+page.svelte`:

```svelte
<script lang="ts">
  import AutomationDashboard from "$lib/automation/AutomationDashboard.svelte";
  import type { PageData } from "./$types";

  export let data: PageData;
</script>

<svelte:head>
  <title>OctopusBeak Automation</title>
</svelte:head>

<AutomationDashboard automation={data.automation} />
```

- [ ] **Step 3: Add the Automation nav item**

Modify `src/lib/shared-shell/components/DashboardShell.svelte`:

```ts
export let active: "overview" | "assets" | "liabilities" | "automation" = "overview";
```

Add a nav item:

```ts
{
  id: "automation",
  label: "Automation",
  href: "/automation",
  path: "M5 4h14v2H5V4Zm2 4h10v2H7V8Zm-2 4h14v8H5v-8Zm2 2v4h10v-4H7Z",
},
```

- [ ] **Step 4: Implement the dashboard component**

Create `src/lib/automation/AutomationDashboard.svelte` using `DashboardShell`, a topbar credentials button, one credentials modal, and one task table. Keep control buttons fixed-size with a local `.task-control` class. Use existing `.card`, `.panel-title`, `.table`, `.chip`, and `.button` classes.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit Task 4**

```bash
git add src/lib/shared-shell/components/DashboardShell.svelte src/lib/automation/AutomationDashboard.svelte src/routes/automation/+page.server.ts src/routes/automation/+page.svelte
git commit -m "feat: add automation dashboard"
```

### Task 5: Full Verification

**Files:**
- Modify only if verification finds a concrete defect.

- [ ] **Step 1: Run all automation checks**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/automation-core.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/store.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/runner.check.ts
```

Expected: all exit 0.

- [ ] **Step 2: Run existing checks**

Run:

```bash
node --no-warnings --experimental-strip-types src/ledger/content-hash.check.ts
node --no-warnings --experimental-strip-types src/ledger/source-csv-parsers.check.ts
node --no-warnings --experimental-strip-types src/lib/shared-ledger/server/accounts.check.ts
```

Expected: all exit 0.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 4: Inspect final diff**

Run: `git diff --stat HEAD`

Expected: only automation, route, shell nav, and migration/schema files changed since the previous task commit.
