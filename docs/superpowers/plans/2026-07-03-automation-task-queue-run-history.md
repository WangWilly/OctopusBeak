# Automation Task Queue Run History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update the Automation task queue so it shows whether each task ran today, keeps CSV import unlocked after each dependency has run once today, supports canceling active tasks, and exposes a RUN HISTORY modal with the latest 100 runs.

**Architecture:** Keep the current SQLite-backed automation model as the source of truth. Add small store queries for today's task ids and recent history, pass them through `loadAutomationDesktopModel`, and keep the UI as one Svelte screen with a modal. Add a dedicated cancel path in the runner because the existing force-quit path only closes waiting-for-human Libretto sessions.

**Tech Stack:** Svelte, Electron IPC/preload API, Node child processes, SQLite through `LedgerDatabase`, assert-based `.check.ts` files.

---

## File Map

- Modify: `src/lib/automation/server/store.ts` for `todayTaskRunIds()`, `recentTaskRuns()`, and the new import gate semantics.
- Modify: `src/lib/automation/server/store.check.ts` to lock/unlock on "ran today" and verify 100-row history ordering.
- Modify: `src/lib/automation/types.ts` to add `ranToday`, `AutomationTaskHistoryRow`, `runHistory`, and `Cancel`.
- Modify: `src/lib/automation/server/page-model.ts` to pass `ranToday`, expose history rows, compute locked tooltip data, and return `Cancel` for active running rows.
- Modify: `src/lib/automation/server/page-model.check.ts` for active cancel action, ran-today display data, and history pass-through.
- Modify: `src/lib/automation/server/desktop-api.ts` to load today's run ids/history and expose `automationCancel()`.
- Modify: `src/lib/automation/server/desktop-api.check.ts` for the new model fields and lock message.
- Modify: `src/lib/automation/server/runner.ts` for process-backed cancellation.
- Modify: `src/lib/automation/server/runner.check.ts` for cancel helper behavior where possible without spawning a real workflow.
- Modify: `src/lib/desktop/api.ts`, `electron/ipc.ts`, and `electron/preload.ts` for `automation.cancel`.
- Modify: `src/lib/desktop/api.check.ts` and `electron/preload.check.ts` for the new channel.
- Modify: `src/lib/automation/AutomationDashboard.svelte` for the table layout, locked tooltip, CANCEL action, and RUN HISTORY modal.
- Modify: `src/lib/i18n/i18n.ts` for labels in English and Traditional Chinese.

---

### Task 1: Store Queries And Import Gate

**Files:**
- Modify: `src/lib/automation/server/store.ts`
- Modify: `src/lib/automation/server/store.check.ts`

- [ ] **Step 1: Write the failing store checks**

Add these imports and assertions to `src/lib/automation/server/store.check.ts`.

```ts
import {
  createTaskRun,
  importGateStatus,
  latestTaskRuns,
  recentTaskRuns,
  taskRunById,
  todayTaskRunIds,
  updateTaskRun,
} from "./store.ts";
```

After the first Fubon run is completed, verify the new ran-today query:

```ts
const todayRunIds = todayTaskRunIds(db, {
  startUtc: new Date("2026-06-30T00:00:00.000Z"),
  endUtc: new Date("2026-07-01T00:00:00.000Z"),
});
assert.deepEqual(todayRunIds, ["fubon-all-statements"]);
```

Replace the current `unlockedGate` section with this behavior: ESun ran today but failed/latest status no longer matters for import unlock.

```ts
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
assert.equal(taskRunById(db, esunRun.taskRunId)?.status, "failed");
```

Add a small history check before `db.close()`:

```ts
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
```

- [ ] **Step 2: Run the failing check**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/store.check.ts
```

Expected: FAIL because `recentTaskRuns` and `todayTaskRunIds` do not exist, and `importGateStatus` still requires `completed`.

- [ ] **Step 3: Implement minimal store changes**

In `src/lib/automation/server/store.ts`, add the history row type after `AutomationTaskRun`:

```ts
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
```

Add these functions after `latestTaskRuns()`:

```ts
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

export function recentTaskRuns(db: LedgerDatabase, limit = 100): AutomationTaskHistoryRow[] {
  const rows = db.prepare(`
    SELECT *
    FROM automation_task_runs
    ORDER BY started_at DESC
    LIMIT ?
  `).all(limit) as Record<string, unknown>[];
  return rows.map((row) => {
    const run = rowToTaskRun(row);
    return {
      taskRunId: run.taskRunId,
      taskId: run.taskId,
      script: run.script,
      kind: run.kind,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      exitCode: run.exitCode,
      signal: run.signal,
      errorMessage: run.errorMessage,
      logPath: run.logPath,
    };
  });
}
```

Change `importGateStatus()` so it locks only when no run exists for the business day:

```ts
const missingTaskIds = input.dependencyIds.filter((taskId) => {
  const row = db.prepare(`
    SELECT 1 AS ran
    FROM automation_task_runs
    WHERE task_id = ?
      AND started_at >= ?
      AND started_at < ?
    LIMIT 1
  `).get(taskId, input.startUtc.toISOString(), input.endUtc.toISOString()) as
    | { ran?: number }
    | undefined;
  return !row;
});
```

- [ ] **Step 4: Run the store check**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/store.check.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/automation/server/store.ts src/lib/automation/server/store.check.ts
git commit -m "fix: unlock csv import after dependency runs"
```

---

### Task 2: Automation Model Fields

**Files:**
- Modify: `src/lib/automation/types.ts`
- Modify: `src/lib/automation/server/page-model.ts`
- Modify: `src/lib/automation/server/page-model.check.ts`
- Modify: `src/lib/automation/server/desktop-api.ts`
- Modify: `src/lib/automation/server/desktop-api.check.ts`

- [ ] **Step 1: Write failing page-model checks**

In `src/lib/automation/server/page-model.check.ts`, update every `buildAutomationPageModel()` call with:

```ts
  todayRunTaskIds: ["fubon-all-statements"],
  runHistory: [],
```

For `activeModel`, use:

```ts
  todayRunTaskIds: ["fubon-all-statements", "esun-credit-card-statements"],
  runHistory: [{
    taskRunId: "run-3",
    taskId: "fubon-all-statements",
    script: "run:fubon-all-statements",
    kind: "crawler",
    status: "running",
    startedAt: "2026-06-30T01:00:00.000Z",
    finishedAt: null,
    exitCode: null,
    signal: null,
    errorMessage: null,
    logPath: "data/automation/logs/run-3.log",
  }],
```

Add assertions near the active row checks:

```ts
assert.equal(activeFubonRow?.primaryAction, "Cancel");
assert.equal(activeFubonRow?.canRun, true);
assert.equal(activeFubonRow?.ranToday, true);
assert.equal(activeEsunRow?.ranToday, true);
assert.equal(activeModel.runHistory.length, 1);
assert.equal(activeModel.runHistory[0]?.taskId, "fubon-all-statements");
```

- [ ] **Step 2: Run the failing page-model check**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/page-model.check.ts
```

Expected: FAIL because `todayRunTaskIds`, `runHistory`, `ranToday`, and `Cancel` do not exist.

- [ ] **Step 3: Extend shared types**

In `src/lib/automation/types.ts`, add:

```ts
export type AutomationTaskHistoryRow = {
  taskRunId: string;
  taskId: string;
  script: string;
  kind: AutomationTaskKind;
  status: AutomationTaskStatus;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  errorMessage: string | null;
  logPath: string;
};
```

Change `AutomationTaskRow`:

```ts
  ranToday: boolean;
  primaryAction: "Run" | "Run again" | "Resume" | "Locked" | "Cancel";
  canRun: boolean;
```

Change `AutomationPageModel`:

```ts
  runHistory: AutomationTaskHistoryRow[];
```

- [ ] **Step 4: Update page model**

In `src/lib/automation/server/page-model.ts`, change the input type:

```ts
  todayRunTaskIds?: readonly string[];
  runHistory?: AutomationPageModel["runHistory"];
```

Change `primaryAction()`:

```ts
function primaryAction(status: AutomationTaskStatus, isActive: boolean) {
  if (isActive) return "Cancel";
  if (status === "locked") return "Locked";
  if (status === "failed") return "Run again";
  if (status === "waiting_for_human") return "Resume";
  return "Run";
}
```

Inside `buildAutomationPageModel()`:

```ts
const activeTaskIds = new Set(input.activeTaskIds ?? []);
const todayRunTaskIds = new Set(input.todayRunTaskIds ?? []);
return {
  businessDate: input.businessDate,
  active: input.active || activeTaskIds.size > 0,
  activeTaskCount: activeTaskIds.size,
  credentials: input.credentials,
  importGate: input.importGate,
  runHistory: input.runHistory ?? [],
  tasks: input.tasks.map((task) => {
    const run = input.latestRuns[task.id];
    const isActive = activeTaskIds.has(task.id);
    const status = rowStatus(task, run, input.importGate, isActive);
    const action = primaryAction(status, isActive);
```

Add to each row:

```ts
        ranToday: todayRunTaskIds.has(task.id),
        isActive,
        primaryAction: action,
        canRun: action === "Cancel" || (!isActive && action !== "Locked"),
```

- [ ] **Step 5: Update desktop model load**

In `src/lib/automation/server/desktop-api.ts`, import the new store functions:

```ts
import {
  importGateStatus,
  latestTaskRuns,
  recentTaskRuns,
  todayTaskRunIds,
} from "./store.ts";
```

Pass the new fields into `buildAutomationPageModel()`:

```ts
        latestRuns: latestTaskRuns(db),
        todayRunTaskIds: todayTaskRunIds(db, {
          startUtc: range.startUtc,
          endUtc: range.endUtc,
        }),
        runHistory: recentTaskRuns(db, 100),
```

- [ ] **Step 6: Update desktop-api check**

In `src/lib/automation/server/desktop-api.check.ts`, after loading the model:

```ts
  assert.ok(Array.isArray(model.automation.runHistory));
  assert.equal(model.automation.tasks.every((task) => typeof task.ranToday === "boolean"), true);
```

- [ ] **Step 7: Run checks**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/page-model.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/desktop-api.check.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/automation/types.ts src/lib/automation/server/page-model.ts src/lib/automation/server/page-model.check.ts src/lib/automation/server/desktop-api.ts src/lib/automation/server/desktop-api.check.ts
git commit -m "feat: expose automation run history model"
```

---

### Task 3: Cancel Running Tasks

**Files:**
- Modify: `src/lib/automation/server/runner.ts`
- Modify: `src/lib/automation/server/runner.check.ts`
- Modify: `src/lib/automation/server/desktop-api.ts`
- Modify: `src/lib/desktop/api.ts`
- Modify: `src/lib/desktop/api.check.ts`
- Modify: `electron/ipc.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/preload.check.ts`

- [ ] **Step 1: Add failing API/channel checks**

In `src/lib/desktop/api.check.ts`, add `"automation:cancel"` immediately after `"automation:resume"` in the expected channel list.

In `electron/preload.check.ts`, add:

```ts
assert.equal(octopusBeakApiChannels.includes("automation:cancel"), true);
```

- [ ] **Step 2: Run failing checks**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/desktop/api.check.ts
node --no-warnings --experimental-strip-types electron/preload.check.ts
```

Expected: FAIL because the channel is missing.

- [ ] **Step 3: Implement runner cancellation**

In `src/lib/automation/server/runner.ts`, change the child process import:

```ts
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
```

Add a child map below `activeTaskRunIds`:

```ts
const activeTaskChildren = new Map<string, ChildProcessWithoutNullStreams>();
```

Add this exported function before `runAutomationTask()`:

```ts
export function cancelAutomationTask(taskId: string) {
  const runId = activeTaskRunIds.get(taskId);
  if (!runId) throw new Error(`Automation task is not running: ${taskId}`);
  const child = activeTaskChildren.get(taskId);
  if (!child) throw new Error(`Automation task has not started a process yet: ${taskId}`);
  child.kill("SIGTERM");
  return { cancelled: taskId };
}
```

Inside the `spawn(command.command, ...)` block in `runAutomationTask()`, register and clean up the child:

```ts
activeTaskChildren.set(task.id, child);
child.on("close", (exitCode, signal) => {
  activeTaskChildren.delete(task.id);
  resolve({ exitCode, signal, error: null });
});
```

Keep the existing `finally` cleanup and add:

```ts
activeTaskChildren.delete(taskId);
```

The existing final `updateTaskRun()` already records non-zero/null exit as failed; killing with `SIGTERM` should surface as a failed run with `signal`.

- [ ] **Step 4: Wire desktop API**

In `src/lib/automation/server/desktop-api.ts`, import `cancelAutomationTask`:

```ts
import {
  activeAutomationTaskIds,
  cancelAutomationTask,
  hasActiveAutomationTask,
  resumeSessionFromLog,
  startAutomationResume,
  startAutomationTask,
} from "./runner.ts";
```

Add:

```ts
export function automationCancel(taskId: string) {
  return cancelAutomationTask(taskId);
}
```

In `src/lib/desktop/api.ts`, add to `AutomationActionResult`:

```ts
  | { cancelled: string }
```

Add to `OctopusBeakApi.automation`:

```ts
    cancel(taskId: string): Promise<{ cancelled: string }>;
```

Add the channel:

```ts
  "automation:cancel",
```

In `electron/preload.ts`, add:

```ts
    cancel: (taskId) => ipcRenderer.invoke("automation:cancel", taskId),
```

In `electron/ipc.ts`, import `automationCancel` and add:

```ts
  ipcMain.handle("automation:cancel", (_event, taskId: string) => automationCancel(taskId));
```

- [ ] **Step 5: Run API checks**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/desktop/api.check.ts
node --no-warnings --experimental-strip-types electron/preload.check.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/automation/server/runner.ts src/lib/automation/server/runner.check.ts src/lib/automation/server/desktop-api.ts src/lib/desktop/api.ts src/lib/desktop/api.check.ts electron/ipc.ts electron/preload.ts electron/preload.check.ts
git commit -m "feat: cancel active automation tasks"
```

---

### Task 4: Task Queue UI And History Modal

**Files:**
- Modify: `src/lib/automation/AutomationDashboard.svelte`
- Modify: `src/lib/i18n/i18n.ts`

- [ ] **Step 1: Add i18n strings**

In both English and Traditional Chinese `automation` dictionaries in `src/lib/i18n/i18n.ts`, add:

```ts
    ranToday: "Ran today",
    ran: "Ran",
    notRun: "Not run",
    runHistory: "Run history",
    closeRunHistory: "Close run history",
    historyStartedUtc: "Started UTC",
    historyFinishedUtc: "Finished UTC",
    historyError: "Error",
    importLockedBy: (tasks: string) => `Blocked by: ${tasks}`,
```

Traditional Chinese values:

```ts
    ranToday: "今日執行",
    ran: "已執行",
    notRun: "未執行",
    runHistory: "執行歷史",
    closeRunHistory: "關閉執行歷史",
    historyStartedUtc: "開始 UTC",
    historyFinishedUtc: "完成 UTC",
    historyError: "錯誤",
    importLockedBy: (tasks) => `阻擋任務：${tasks}`,
```

Change action labels:

```ts
      Cancel: "Cancel",
```

Traditional Chinese:

```ts
      Cancel: "取消",
```

- [ ] **Step 2: Add Svelte state/helpers**

In `src/lib/automation/AutomationDashboard.svelte`, add state:

```ts
  let historyOpen = false;
```

Remove `formatTime()` only if it becomes unused; otherwise keep it for history.

Add helper functions:

```ts
  function importLockTitle(task: AutomationTaskRow, dictionary: Translation) {
    if (task.id !== "import-downloads-csv" || task.status !== "locked") return undefined;
    const missing = automation.importGate.missingTaskIds
      .map((taskId) => (dictionary.automation.taskLabels as Record<string, string>)[taskId] ?? taskId);
    return missing.length > 0 ? dictionary.automation.importLockedBy(missing.join(", ")) : dictionary.automation.progressLocked;
  }

  async function primaryTaskAction(task: AutomationTaskRow) {
    if (task.primaryAction === "Cancel") {
      await window.octopusBeak.automation.cancel(task.id);
      await reload();
      return;
    }
    await runTask(task);
  }
```

- [ ] **Step 3: Update table header and rows**

In the panel header, add the RUN HISTORY button:

```svelte
      <div class="panel-title automation-title">
        <div>
          <h2>{$t.automation.taskQueue}</h2>
          <p>{$t.automation.taskQueueDescription}</p>
        </div>
        <button class="button secondary fixed-action history-action" type="button" onclick={() => (historyOpen = true)}>
          {$t.automation.runHistory}
        </button>
      </div>
```

Replace the `latestUtc` header:

```svelte
              <th>{$t.automation.ranToday}</th>
```

Replace the latest UTC cell:

```svelte
                <td>
                  <span class={`chip ${task.ranToday ? "good" : ""}`}>
                    {task.ranToday ? $t.automation.ran : $t.automation.notRun}
                  </span>
                </td>
```

Update the status chip:

```svelte
                <td>
                  <span class={`chip ${statusClass(task.status)}`} title={importLockTitle(task, $t)}>
                    {$t.automation.statusLabels[task.status]}
                  </span>
                </td>
```

Update the primary button handler:

```svelte
                      disabled={!task.canRun}
                      aria-busy={task.isActive}
                      title={importLockTitle(task, $t)}
                      onclick={() => void primaryTaskAction(task)}
```

Keep the spinner next to the label for active rows.

- [ ] **Step 4: Add RUN HISTORY modal**

Add this modal near the existing logs modal:

```svelte
{#if historyOpen}
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="history-title">
    <button class="modal-backdrop" type="button" aria-label={$t.automation.closeRunHistory} onclick={() => (historyOpen = false)}></button>
    <div class="modal-panel history-modal">
      <div class="modal-head">
        <div>
          <h2 id="history-title">{$t.automation.runHistory}</h2>
          <p>{automation.runHistory.length} / 100</p>
        </div>
        <button class="modal-close" type="button" aria-label={$t.common.close} onclick={() => (historyOpen = false)}>x</button>
      </div>
      <div class="modal-body history-body">
        <table class="table history-table">
          <thead>
            <tr>
              <th>{$t.automation.task}</th>
              <th>{$t.automation.status}</th>
              <th>{$t.automation.historyStartedUtc}</th>
              <th>{$t.automation.historyFinishedUtc}</th>
              <th>{$t.automation.historyError}</th>
            </tr>
          </thead>
          <tbody>
            {#each automation.runHistory as run}
              <tr>
                <td>
                  <div class="task-name">
                    <strong>{( $t.automation.taskLabels as Record<string, string>)[run.taskId] ?? run.taskId}</strong>
                    <span>{run.script}</span>
                  </div>
                </td>
                <td><span class={`chip ${statusClass(run.status)}`}>{$t.automation.statusLabels[run.status]}</span></td>
                <td class="mono">{formatTime(run.startedAt)}</td>
                <td class="mono">{formatTime(run.finishedAt)}</td>
                <td class="history-error">{run.errorMessage ?? "--"}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  </div>
{/if}
```

- [ ] **Step 5: Add compact CSS**

Add:

```css
  .automation-title {
    align-items: flex-start;
  }

  .history-action {
    margin-left: auto;
  }

  .history-modal {
    width: min(1040px, 100%);
  }

  .history-body {
    max-height: min(68vh, 720px);
    overflow: auto;
    padding: 0;
  }

  .history-table td {
    vertical-align: middle;
  }

  .history-error {
    max-width: 320px;
    color: var(--muted);
    font-size: 12px;
  }
```

- [ ] **Step 6: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/automation/AutomationDashboard.svelte src/lib/i18n/i18n.ts
git commit -m "feat: update automation task queue UI"
```

---

### Task 5: Electron Visual Verification

**Files:**
- No code files unless verification finds a bug.

- [ ] **Step 1: Build and start Electron**

Run:

```bash
npm run desktop:dev
```

Expected: Electron starts and exposes CDP on `127.0.0.1:9222`.

- [ ] **Step 2: Verify with CDP**

Use CDP against `http://127.0.0.1:9222/json/list` and inspect `#/automation`.

Expected visible behavior:

- The task table has no `Latest UTC` column.
- The table has a `Ran today` column.
- Import downloads CSV locked status/button has a hover title naming missing dependency tasks.
- Running task primary button says `Cancel` and still shows the spinner.
- The `RUN HISTORY` button opens a modal.
- The modal lists up to 100 recent runs in descending `startedAt` order.

- [ ] **Step 3: Final verification commands**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/store.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/page-model.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/desktop-api.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/runner.check.ts
node --no-warnings --experimental-strip-types src/lib/desktop/api.check.ts
node --no-warnings --experimental-strip-types electron/preload.check.ts
npm run typecheck
```

Expected: all pass.

- [ ] **Step 4: Commit verification fixes if needed**

Only if Step 2 or Step 3 required fixes:

```bash
git add <fixed-files>
git commit -m "fix: polish automation queue behavior"
```

---

## Self-Review

- Spec coverage: latest UTC removal, ran-today display, locked tooltip, import unlock-once-per-day, CANCEL action, and RUN HISTORY modal are all covered.
- Placeholder scan: no `TBD`, `TODO`, or unspecified implementation steps remain.
- Type consistency: `AutomationTaskHistoryRow`, `ranToday`, `runHistory`, and `Cancel` are introduced in shared types before UI usage.
- Ponytail check: skipped a separate history IPC because the current model load can cheaply carry 100 rows; add a separate endpoint only if history grows or pagination becomes necessary.
