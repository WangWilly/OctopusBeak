# Import Idempotency and SQLite Lock Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make repeated CSV imports harmless, trigger exactly one import attempt after each「同步全部」batch, and keep temporary SQLite write contention from crashing Electron.

**Architecture:** Keep the existing importer, automation runner, and SQLite schema. Treat either typed-row unique key as the same duplicate outcome, move automatic import ownership from each crawler into the existing「同步全部」batch boundary, then use SQLite's native busy timeout plus the existing output buffer's error path to survive transient writer contention.

**Tech Stack:** TypeScript, Node.js `node:sqlite`, Electron main process, Node test runner.

## Global Constraints

- Do not modify, delete, or re-import the production ledger during tests.
- Do not add a queue, mutex library, migration, or dependency.
- Preserve source import history and `source_row_lineage` for repeated imports.
- Every「同步全部」invocation may attempt one import, including multiple invocations on the same day.
- Running one crawler by itself does not automatically import; manual import remains available.
- All new examples and fixtures must be de-identified.

---

## File Map

- Modify `src/ledger/import-downloads-csv.ts`: classify both typed-row unique constraints as duplicates and resolve the retained canonical row.
- Modify `src/ledger/import-downloads-csv.check.ts`: reproduce a primary-key-first collision and verify lineage remains complete.
- Modify `src/lib/automation/server/store.ts`: require completed dependency runs before unlocking automatic import.
- Modify `src/lib/automation/server/store.check.ts`: cover failed, completed, and missing dependency states.
- Modify `src/lib/automation/server/runner.ts`: run one import after each「同步全部」batch and contain buffered persistence errors.
- Modify `src/lib/automation/server/runner.check.ts`: cover batch-scoped import attempts and buffered write failure.
- Modify `src/ledger/db/client.ts`: increase the native SQLite busy timeout.
- Modify `src/ledger/db/client.check.ts`: pin the new busy-timeout value for read/write and read-only connections.

### Task 1: Make typed statement insertion idempotent for both unique keys

**Files:**
- Modify: `src/ledger/import-downloads-csv.ts:278-296,601-607`
- Test: `src/ledger/import-downloads-csv.check.ts:399-457`

**Interfaces:**
- Consumes: `insertRecord(db, table, record): "inserted" | "duplicate"`
- Produces: repeated rows resolve to an existing `statement_row_id` whether SQLite reports `content_hash` or `statement_row_id` first.

- [ ] **Step 1: Add a failing primary-key-first regression check**

Add a de-identified fixture that imports one account row, changes only its stored `content_hash`, and imports the unchanged CSV again. This forces the second insert to collide on `statement_row_id` without colliding on `content_hash`:

```ts
const primaryKeyRootDir = await mkdtemp(join(tmpdir(), "statement-row-id-import-"));
const primaryKeyDownloadsDir = join(primaryKeyRootDir, "downloads");
const primaryKeyOutputDir = join(primaryKeyRootDir, "ledger");
const primaryKeySourceDir = join(primaryKeyDownloadsDir, "ctbc-statements");
await mkdir(primaryKeySourceDir, { recursive: true });
await writeFile(
  join(primaryKeySourceDir, "account.csv"),
  accountCsv([accountRow]),
  "utf8",
);
const primaryKeyInput = {
  downloadsDir: primaryKeyDownloadsDir,
  outputDir: primaryKeyOutputDir,
  bankFilters: ["ctbc"],
  productFilters: ["statements"],
};
await importDownloadsCsv(primaryKeyInput);
let primaryKeyDb = openLedgerDatabase(primaryKeyOutputDir);
primaryKeyDb.prepare(
  "UPDATE account_transactions SET content_hash = 'legacy-content-hash'",
).run();
primaryKeyDb.close();

const primaryKeyResult = await importDownloadsCsv(primaryKeyInput);
primaryKeyDb = openLedgerDatabase(primaryKeyOutputDir, { readOnly: true });
assert.equal(primaryKeyResult.importedRows, 0);
assert.equal(primaryKeyResult.skippedDuplicateRows, 1);
assert.equal((primaryKeyDb.prepare(
  "SELECT COUNT(*) AS count FROM account_transactions",
).get() as { count: number }).count, 1);
assert.equal((primaryKeyDb.prepare(
  "SELECT COUNT(*) AS count FROM source_row_lineage",
).get() as { count: number }).count, 2);
primaryKeyDb.close();
```

- [ ] **Step 2: Run the focused check and verify it fails**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/ledger/import-downloads-csv.check.ts
```

Expected: FAIL with `UNIQUE constraint failed: account_transactions.statement_row_id`.

- [ ] **Step 3: Recognize either typed-row unique constraint as a duplicate**

Change the existing catch in `insertRecord`; do not use `INSERT OR IGNORE`, because it would also hide `NOT NULL` and unrelated constraint failures:

```ts
if (
  error instanceof Error
  && (
    error.message.includes(`UNIQUE constraint failed: ${table}.content_hash`)
    || error.message.includes(`UNIQUE constraint failed: ${table}.statement_row_id`)
  )
) return "duplicate";
```

- [ ] **Step 4: Resolve the existing canonical row by content hash or row ID**

Replace the duplicate-only lookup in `insertTypedStatementRow` with:

```ts
const statementRowId = outcome === "inserted"
  ? String(commonFields.statement_row_id)
  : String((db.prepare(`
      SELECT statement_row_id
      FROM ${parser.table}
      WHERE content_hash = ? OR statement_row_id = ?
      ORDER BY CASE WHEN content_hash = ? THEN 0 ELSE 1 END
      LIMIT 1
    `).get(
      commonFields.content_hash,
      commonFields.statement_row_id,
      commonFields.content_hash,
    ) as { statement_row_id: string }).statement_row_id);
```

This retains the content-canonical row when it exists and falls back to the deterministic source-row identity for legacy or schema-order differences.

- [ ] **Step 5: Run the importer check**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/ledger/import-downloads-csv.check.ts
```

Expected: PASS, including the new assertions `importedRows === 0`, `skippedDuplicateRows === 1`, one typed row, and two lineage rows.

- [ ] **Step 6: Commit the importer repair**

```bash
git add src/ledger/import-downloads-csv.ts src/ledger/import-downloads-csv.check.ts
git commit -m "fix: make repeated ledger imports idempotent"
```

### Task 2: Make「同步全部」the single owner of its import attempt

**Files:**
- Modify: `src/lib/automation/server/store.ts:245-265`
- Modify: `src/lib/automation/server/runner.ts:181-187,347-369,738-753`
- Test: `src/lib/automation/server/store.check.ts:94-130`
- Test: `src/lib/automation/server/runner.check.ts:144-188,360-375`

**Interfaces:**
- Consumes: `runWithConcurrency(items, 2, run)` and `taskById(taskId)`.
- Produces: `runAutomationBatch(taskIds, execute): Promise<void>`, which calls `execute("import-downloads-csv")` once after the selected tasks settle when the batch contains a crawler.

- [ ] **Step 1: Change the gate check so a failed dependency remains locked**

Update the existing `store.check.ts` expectation immediately after creating the failed dependency run:

```ts
const failedGate = importGateStatus(db, {
  dependencyIds: ["fubon-all-statements", "esun-credit-card-statements"],
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
```

Keep the existing unlocked assertions after this update.

- [ ] **Step 2: Run the store check and verify it fails**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/lib/automation/server/store.check.ts
```

Expected: FAIL because the failed run currently satisfies the gate.

- [ ] **Step 3: Require a completed dependency run**

Add one predicate to the existing query in `importGateStatus`:

```sql
AND status = 'completed'
```

Do not create a new gate table or batch identifier.

- [ ] **Step 4: Add failing checks for one import per「同步全部」invocation**

Import `runAutomationBatch` in `runner.check.ts` and add:

```ts
test("each sync-all batch attempts one import after its tasks settle", async () => {
  const executed: string[] = [];
  const execute = async (taskId: string) => { executed.push(taskId); };

  await runAutomationBatch(
    ["fubon-all-statements", "exchange-rates"],
    execute,
  );
  assert.equal(executed.at(-1), "import-downloads-csv");
  await runAutomationBatch(
    ["fubon-all-statements", "exchange-rates"],
    execute,
  );

  assert.equal(executed.filter((taskId) => taskId === "import-downloads-csv").length, 2);
  assert.equal(executed.at(-1), "import-downloads-csv");
});

test("a batch without crawlers does not auto-import", async () => {
  const executed: string[] = [];
  await runAutomationBatch(
    ["exchange-rates", "sync-maicoin"],
    async (taskId) => { executed.push(taskId); },
  );
  assert.equal(executed.includes("import-downloads-csv"), false);
});
```

- [ ] **Step 5: Run the runner check and verify it fails to import the missing helper**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/lib/automation/server/runner.check.ts
```

Expected: FAIL because `runAutomationBatch` does not exist.

- [ ] **Step 6: Add the batch-scoped orchestrator**

Add this beside `runWithConcurrency`; it uses the existing task registry and concurrency helper:

```ts
export async function runAutomationBatch(
  taskIds: readonly string[],
  execute: (taskId: string) => Promise<void>,
) {
  const selectedTaskIds = taskIds.filter((taskId) => taskId !== "import-downloads-csv");
  await runWithConcurrency(selectedTaskIds, 2, execute);
  if (selectedTaskIds.some((taskId) => taskById(taskId)?.kind === "crawler")) {
    await execute("import-downloads-csv");
  }
}
```

Replace the `runWithConcurrency` call inside `startAutomationTasks` with `runAutomationBatch`. Keep the existing queued-task handling for selected tasks, and handle the final import through the same task runner:

```ts
void runAutomationBatch(uniqueTaskIds, async (taskId) => {
  if (taskId === "import-downloads-csv") {
    await runAutomationTask(taskId, ledgerDir).catch((error) => {
      console.error("automation-import-run-failed", error);
    });
    return;
  }
  if (activeTaskRunIds.get(taskId) !== "queued") return;
  activeTaskRunIds.set(taskId, "pending");
  await runAutomationTask(taskId, ledgerDir, { claimed: true }).catch((error) => {
    console.error("automation-task-run-failed", error);
  });
}).catch((error) => {
  console.error("automation-batch-run-failed", error);
});
```

Delete `shouldAutoRunImport` and the per-crawler auto-import block at the end of `runAutomationTask`. Remove imports that become unused. This ensures single-task runs and resumed tasks cannot create a second batch import. If another import is already active, this batch still makes exactly one start attempt; the existing `claimTask` guard rejects the competing writer and records the failure through `automation-import-run-failed`.

- [ ] **Step 7: Run both automation checks**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/lib/automation/server/store.check.ts src/lib/automation/server/runner.check.ts
```

Expected: PASS; failed dependencies stay locked for manual import, completed dependencies unlock it, two same-day「同步全部」calls produce two import attempts, and non-crawler batches produce none.

- [ ] **Step 8: Commit the trigger repair**

```bash
git add src/lib/automation/server/store.ts src/lib/automation/server/store.check.ts src/lib/automation/server/runner.ts src/lib/automation/server/runner.check.ts
git commit -m "fix: import once per sync-all batch"
```

### Task 3: Survive transient SQLite writer contention without crashing Electron

**Files:**
- Modify: `src/ledger/db/client.ts:8-35`
- Test: `src/ledger/db/client.check.ts:9-18`
- Modify: `src/lib/automation/server/runner.ts:209-229,631-636`
- Test: `src/lib/automation/server/runner.check.ts:126-142`

**Interfaces:**
- Consumes: SQLite `PRAGMA busy_timeout` and `createAutomationOutputBuffer(write, delayMs, onError)`.
- Produces: a 30-second native wait for the single SQLite writer and a contained/logged live-output persistence failure.

- [ ] **Step 1: Pin the intended busy timeout in the existing client check**

Replace both `>= 5000` assertions with exact assertions:

```ts
assert.equal(busyTimeout.timeout, 30_000);
assert.equal(readOnlyBusyTimeout.timeout, 30_000);
```

- [ ] **Step 2: Run the client check and verify it fails**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/ledger/db/client.check.ts
```

Expected: FAIL with actual timeout `5000`.

- [ ] **Step 3: Use SQLite's native 30-second busy wait**

Change only the existing constant:

```ts
const SQLITE_BUSY_TIMEOUT_MS = 30_000;
```

This is deliberately bounded; revisit transaction size only if measured write locks exceed 30 seconds after the duplicate-import loop is removed.

- [ ] **Step 4: Add a failing output-buffer error containment check**

Add beside the existing batching test:

```ts
test("automation output persistence errors are contained", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const errors: unknown[] = [];
  const buffer = createAutomationOutputBuffer(
    () => { throw new Error("database is locked"); },
    500,
    (error) => errors.push(error),
  );

  buffer.push("progress\n");
  assert.doesNotThrow(() => context.mock.timers.tick(500));
  assert.equal((errors[0] as Error).message, "database is locked");
});
```

- [ ] **Step 5: Run the runner check and verify it fails**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/lib/automation/server/runner.check.ts
```

Expected: FAIL because the timer callback currently lets `write()` throw.

- [ ] **Step 6: Contain buffered persistence failures in the existing helper**

Add an error callback and wrap only the external write:

```ts
export function createAutomationOutputBuffer(
  write: (chunk: string) => void,
  delayMs = 500,
  onError: (error: unknown) => void = (error) => {
    console.error("automation-output-write-failed", error);
  },
) {
  // existing pending/timer state
  const flush = () => {
    // existing timer cleanup and chunk extraction
    try {
      write(chunk);
    } catch (error) {
      onError(error);
    }
  };
  // existing return value
}
```

At the production call site, preserve the failure in the task's eventual `logTail` so it is visible in the existing operation history UI:

```ts
const outputBuffer = createAutomationOutputBuffer(
  (logChunk) => {
    appendLog(logPath, logChunk);
    if (!isForceQuitRun(taskRunById(taskDb, run.taskRunId))) {
      updateTaskRun(taskDb, run.taskRunId, liveTaskRunUpdate(logTail));
    }
  },
  500,
  (error) => {
    const line = `automation-output-write-failed: ${errorMessage(error)}`;
    console.error(line);
    logTail = tail(`${logTail}\n${line}\n`);
  },
);
```

The terminal `updateTaskRun` remains authoritative and will persist the accumulated error after the importer releases the writer lock.

- [ ] **Step 7: Run the focused lock-resilience checks**

Run:

```bash
node --no-warnings --experimental-strip-types --test src/ledger/db/client.check.ts src/lib/automation/server/runner.check.ts
```

Expected: PASS with a 30,000 ms busy timeout and no exception escaping the mocked timer.

- [ ] **Step 8: Commit the lock-resilience repair**

```bash
git add src/ledger/db/client.ts src/ledger/db/client.check.ts src/lib/automation/server/runner.ts src/lib/automation/server/runner.check.ts
git commit -m "fix: tolerate ledger writer contention"
```

### Task 4: Verify the complete repair

**Files:**
- Verify only; no production ledger writes.

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: a build and test result suitable for desktop validation.

- [ ] **Step 1: Run all repository checks**

Run:

```bash
npm test
```

Expected: all checks pass with zero failures.

- [ ] **Step 2: Run static validation**

Run:

```bash
npm run typecheck
```

Expected: `svelte-check` reports zero errors and `tsc --noEmit` exits 0.

- [ ] **Step 3: Build the Electron application**

Run:

```bash
npm run build
```

Expected: renderer and Electron builds both exit 0.

- [ ] **Step 4: Review the final diff for scope**

Run:

```bash
git diff HEAD~3 --stat
git diff HEAD~3 -- src/ledger/import-downloads-csv.ts src/lib/automation/server/store.ts src/lib/automation/server/runner.ts src/ledger/db/client.ts
```

Expected: only the eight mapped implementation/check files change; no schema migration, dependency, or UI change appears. The importer regression check already exercises two complete imports against an isolated temporary ledger.
