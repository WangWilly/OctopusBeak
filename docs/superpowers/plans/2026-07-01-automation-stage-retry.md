# Automation Stage Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the misleading outer automation retry UI/runner behavior and add a workflow-level stage retry helper that retries a stage once before handing control to a human.

**Architecture:** The automation dashboard will expose manual reruns as `Run again`, not `Retry`, and will stop showing task attempt counts. The server runner will record a single process attempt per run; retry behavior moves into workflow code through a small `retryableStage()` helper. The first integration wraps Cathay combined statement sections because they already have clear domestic/foreign stage boundaries.

**Tech Stack:** SvelteKit/Svelte 5, Libretto workflows, Node assert-based `*.check.ts` checks, TypeScript.

---

## File Structure

- Modify `src/lib/automation/server/page-model.ts`: rename failed primary action to `Run again` and stop surfacing retrying as an active action.
- Modify `src/lib/automation/server/page-model.check.ts`: update failed-row expectations.
- Modify `src/lib/automation/AutomationDashboard.svelte`: remove the Attempt column and route failed reruns through `?/run`.
- Modify `src/routes/automation/+page.server.ts`: remove the duplicate `retry` action.
- Modify `src/lib/automation/server/tasks.ts`: set crawler `maxAttempts` to `1`; task-level retry is no longer the retry mechanism.
- Modify `src/lib/automation/server/runner.ts`: stop producing `retrying`; a non-zero process exit becomes `failed`.
- Modify `src/lib/automation/server/runner.check.ts`: update `nextAttemptStatus()` checks.
- Create `src/workflows/retryable-stage.ts`: workflow-local stage retry helper.
- Create `src/workflows/retryable-stage.check.ts`: assert-based checks for retry-once and pause-after-second-failure behavior.
- Modify `src/workflows/cathay-all-statements.ts`: wrap domestic and foreign download sections with `retryableStage()`.

Keep `retrying` in the stored status type for old database rows. Do not produce new `retrying` rows.

---

### Task 1: Clean Up Dashboard Retry Semantics

**Files:**
- Modify: `src/lib/automation/server/page-model.check.ts`
- Modify: `src/lib/automation/server/page-model.ts`
- Modify: `src/lib/automation/AutomationDashboard.svelte`
- Modify: `src/routes/automation/+page.server.ts`

- [ ] **Step 1: Update the failing page-model expectations**

In `src/lib/automation/server/page-model.check.ts`, replace the three failed-action expectations:

```ts
assert.equal(failedRow?.primaryAction, "Run again");
assert.equal(failedRow?.canRun, true);
```

```ts
assert.equal(staleRunningRow?.status, "failed");
assert.equal(staleRunningRow?.primaryAction, "Run again");
```

```ts
assert.equal(failedResumeRow?.status, "failed");
assert.equal(failedResumeRow?.primaryAction, "Run again");
assert.equal(failedResumeRow?.progressText, "Failed");
```

- [ ] **Step 2: Run the page-model check and verify RED**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/page-model.check.ts
```

Expected: FAIL because `primaryAction()` still returns `Retry` for failed rows.

- [ ] **Step 3: Rename the failed action in the page model**

In `src/lib/automation/server/page-model.ts`, change `primaryAction()` to:

```ts
function primaryAction(status: AutomationTaskStatus) {
  if (status === "locked") return "Locked";
  if (status === "running") return "Running";
  if (status === "failed") return "Run again";
  if (status === "waiting_for_human") return "Resume";
  return "Run";
}
```

Leave `rowStatus()` as-is for stale historical `retrying` rows:

```ts
if (
  run &&
  !isActive &&
  (run.status === "running" || run.status === "retrying")
) {
  return "failed";
}
```

- [ ] **Step 4: Remove the Attempt column and retry action routing**

In `src/lib/automation/AutomationDashboard.svelte`, replace `actionName()` with:

```ts
function actionName(task: AutomationTaskRow) {
  if (task.primaryAction === "Resume") return "resume";
  return "run";
}
```

In the task table header, remove:

```svelte
<th>Attempt</th>
```

In the task table body, remove:

```svelte
<td class="mono">{task.attempt}/{task.maxAttempts}</td>
```

In `statusClass()`, remove `retrying` from the active warning list:

```ts
function statusClass(status: string) {
  if (status === "completed") return "good";
  if (status === "failed" || status === "locked") return "bad";
  if (status === "running" || status === "waiting_for_human") return "warn";
  return "";
}
```

- [ ] **Step 5: Remove the duplicate server retry action**

In `src/routes/automation/+page.server.ts`, remove this action from `actions`:

```ts
retry: async ({ request }) => {
  const formData = await request.formData();
  return startTask(formTaskId(formData));
},
```

Keep `run` and `resume`.

- [ ] **Step 6: Verify the dashboard cleanup**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/page-model.check.ts
npm run typecheck
```

Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/lib/automation/server/page-model.ts src/lib/automation/server/page-model.check.ts src/lib/automation/AutomationDashboard.svelte src/routes/automation/+page.server.ts
git commit -m "fix: clarify automation rerun controls"
```

---

### Task 2: Disable Outer Runner Retry

**Files:**
- Modify: `src/lib/automation/server/tasks.ts`
- Modify: `src/lib/automation/server/runner.check.ts`
- Modify: `src/lib/automation/server/runner.ts`

- [ ] **Step 1: Update runner checks for no task-level retry**

In `src/lib/automation/server/runner.check.ts`, replace this assertion:

```ts
assert.equal(
  nextAttemptStatus({ kind: "crawler", attempt: 1, maxAttempts: 2, exitCode: 1 }),
  "retrying",
);
```

with:

```ts
assert.equal(
  nextAttemptStatus({ kind: "crawler", attempt: 1, maxAttempts: 2, exitCode: 1 }),
  "failed",
);
```

Keep the existing success and waiting-for-human assertions.

- [ ] **Step 2: Run the runner check and verify RED**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/runner.check.ts
```

Expected: FAIL because `nextAttemptStatus()` still returns `retrying`.

- [ ] **Step 3: Set crawler task max attempts to one**

In `src/lib/automation/server/tasks.ts`, change every crawler task from:

```ts
maxAttempts: 2,
```

to:

```ts
maxAttempts: 1,
```

The affected task ids are:

```ts
"fubon-all-statements"
"esun-credit-card-statements"
"yuanta-all-statements"
"yuanta-trade-statements"
"cathay-all-statements"
"hncb-statements"
```

Do not change `sync-maicoin` or `import-downloads-csv`; they already use `maxAttempts: 1`.

- [ ] **Step 4: Make non-zero process exits fail immediately**

In `src/lib/automation/server/runner.ts`, replace `nextAttemptStatus()` with:

```ts
export function nextAttemptStatus(input: {
  kind: AutomationTaskKind;
  attempt: number;
  maxAttempts: number;
  exitCode: number | null;
  waitingForHuman?: boolean;
}): AutomationTaskStatus {
  if (input.exitCode === 0 && input.waitingForHuman) return "waiting_for_human";
  if (input.exitCode === 0) return "completed";
  return "failed";
}
```

- [ ] **Step 5: Stop creating new retrying rows**

In `runAutomationTask()` in `src/lib/automation/server/runner.ts`, change:

```ts
const maxAttempts = options.resumeSession ? 1 : task.maxAttempts;
```

to:

```ts
const maxAttempts = 1;
```

Then change the `createTaskRun()` status value from:

```ts
status: attempt > 1 ? "retrying" : "running",
```

to:

```ts
status: "running",
```

Finally replace this block:

```ts
if (status !== "retrying") {
  if (status !== "completed") return { status };
  const range = businessDayUtcRange();
  const enabledGroups = automationGroupEnabledStatus(readAutomationEnvText());
  const gate = importGateStatus(taskDb, {
    dependencyIds: enabledCsvImportDependencyIds(enabledGroups),
    startUtc: range.startUtc,
    endUtc: range.endUtc,
  });
  if (shouldAutoRunImport({
    kind: task.kind,
    status,
    importLocked: gate.locked,
  }) && !activeTaskRunIds.has("import-downloads-csv")) {
    await runAutomationTask("import-downloads-csv", ledgerDir);
  }
  return { status };
}
```

with:

```ts
if (status !== "completed") return { status };
const range = businessDayUtcRange();
const enabledGroups = automationGroupEnabledStatus(readAutomationEnvText());
const gate = importGateStatus(taskDb, {
  dependencyIds: enabledCsvImportDependencyIds(enabledGroups),
  startUtc: range.startUtc,
  endUtc: range.endUtc,
});
if (shouldAutoRunImport({
  kind: task.kind,
  status,
  importLocked: gate.locked,
}) && !activeTaskRunIds.has("import-downloads-csv")) {
  await runAutomationTask("import-downloads-csv", ledgerDir);
}
return { status };
```

- [ ] **Step 6: Verify runner behavior**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/runner.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/automation-core.check.ts
npm run typecheck
```

Expected: all exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/lib/automation/server/tasks.ts src/lib/automation/server/runner.ts src/lib/automation/server/runner.check.ts
git commit -m "fix: remove task-level automation retry"
```

---

### Task 3: Add Workflow-Level Stage Retry Helper

**Files:**
- Create: `src/workflows/retryable-stage.check.ts`
- Create: `src/workflows/retryable-stage.ts`

- [ ] **Step 1: Write the failing stage helper checks**

Create `src/workflows/retryable-stage.check.ts`:

```ts
import assert from "node:assert/strict";
import { retryableStage } from "./retryable-stage.ts";

const retryCalls: string[] = [];
let retryRuns = 0;
const retryResult = await retryableStage({
  name: "domestic",
  session: "ses-test",
  run: async () => {
    retryCalls.push("run");
    retryRuns += 1;
    if (retryRuns === 1) throw new Error("transient");
    return "ok";
  },
  reset: async () => {
    retryCalls.push("reset");
  },
  pauseForHuman: async () => {
    retryCalls.push("pause");
  },
});

assert.equal(retryResult, "ok");
assert.deepEqual(retryCalls, ["run", "reset", "run"]);

const humanCalls: string[] = [];
let humanRuns = 0;
const humanResult = await retryableStage({
  name: "foreign",
  session: "ses-human",
  run: async () => {
    humanCalls.push("run");
    humanRuns += 1;
    if (humanRuns <= 2) throw new Error(`broken-${humanRuns}`);
    return "fixed";
  },
  reset: async () => {
    humanCalls.push("reset");
  },
  pauseForHuman: async () => {
    humanCalls.push("pause");
  },
});

assert.equal(humanResult, "fixed");
assert.deepEqual(humanCalls, ["run", "reset", "run", "pause", "run"]);
```

- [ ] **Step 2: Run the stage helper check and verify RED**

Run:

```bash
node --no-warnings --experimental-strip-types src/workflows/retryable-stage.check.ts
```

Expected: FAIL because `src/workflows/retryable-stage.ts` does not exist.

- [ ] **Step 3: Implement the minimal helper**

Create `src/workflows/retryable-stage.ts`:

```ts
import { pause } from "libretto";

type RetryableStageInput<T> = {
  name: string;
  session: string;
  run: () => Promise<T>;
  reset?: () => Promise<void>;
  pauseForHuman?: () => Promise<void>;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function retryableStage<T>(input: RetryableStageInput<T>): Promise<T> {
  try {
    return await input.run();
  } catch (error) {
    console.warn("workflow-stage-retry", {
      stage: input.name,
      message: errorMessage(error),
    });
    await input.reset?.();
  }

  try {
    return await input.run();
  } catch (error) {
    console.error("workflow-stage-human-required", {
      stage: input.name,
      message: errorMessage(error),
    });
    console.log(
      `manual-repair-required: fix ${input.name}, then run \`npx libretto resume --session ${input.session}\`.`,
    );
    await (input.pauseForHuman ?? (() => pause(input.session)))();
  }

  return await input.run();
}
```

- [ ] **Step 4: Verify the helper**

Run:

```bash
node --no-warnings --experimental-strip-types src/workflows/retryable-stage.check.ts
npm run typecheck
```

Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/workflows/retryable-stage.ts src/workflows/retryable-stage.check.ts
git commit -m "feat: add workflow stage retry helper"
```

---

### Task 4: Wrap Cathay Combined Statement Stages

**Files:**
- Modify: `src/workflows/cathay-all-statements.ts`

- [ ] **Step 1: Import the stage helper**

In `src/workflows/cathay-all-statements.ts`, add:

```ts
import { retryableStage } from "./retryable-stage.js";
```

- [ ] **Step 2: Make the Cathay API session refreshable**

Change:

```ts
const cathaySession = await createCathaySession(page);
```

to:

```ts
let cathaySession = await createCathaySession(page);
```

- [ ] **Step 3: Wrap the domestic statement section**

Replace:

```ts
const domesticDownloads = await downloadCathayStatements(
  page,
  input.dateRange,
  input.domesticAccountFilters ?? input.accountFilters,
  cathaySession,
);
```

with:

```ts
const domesticDownloads = await retryableStage({
  name: "cathay-domestic-statements",
  session: ctx.session,
  reset: async () => {
    cathaySession = await createCathaySession(page);
  },
  run: async () =>
    downloadCathayStatements(
      page,
      input.dateRange,
      input.domesticAccountFilters ?? input.accountFilters,
      cathaySession,
    ),
});
```

- [ ] **Step 4: Wrap the foreign statement section**

Replace:

```ts
const foreignDownloads = await downloadCathayForeignStatements(
  page,
  input.dateRange,
  input.foreignAccountFilters ?? input.accountFilters,
  input.currencyFilters,
  cathaySession,
);
```

with:

```ts
const foreignDownloads = await retryableStage({
  name: "cathay-foreign-statements",
  session: ctx.session,
  reset: async () => {
    cathaySession = await createCathaySession(page);
  },
  run: async () =>
    downloadCathayForeignStatements(
      page,
      input.dateRange,
      input.foreignAccountFilters ?? input.accountFilters,
      input.currencyFilters,
      cathaySession,
    ),
});
```

- [ ] **Step 5: Verify Cathay integration**

Run:

```bash
node --no-warnings --experimental-strip-types src/workflows/retryable-stage.check.ts
npm run typecheck
```

Expected: both exit 0.

Manual smoke test when credentials are available:

```bash
npm run run:cathay-all-statements
```

Expected: the task still reaches `automation-progress: 100` on success. If a domestic or foreign stage fails once, logs include `workflow-stage-retry`. If it fails twice, logs include `manual-repair-required` and the automation dashboard shows the task as waiting for human input.

- [ ] **Step 6: Commit**

```bash
git add src/workflows/cathay-all-statements.ts
git commit -m "feat: retry Cathay statement stages"
```

---

### Task 5: Final Verification

**Files:**
- Modify only if verification exposes a concrete defect.

- [ ] **Step 1: Run focused checks**

Run:

```bash
node --no-warnings --experimental-strip-types src/lib/automation/server/page-model.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/runner.check.ts
node --no-warnings --experimental-strip-types src/lib/automation/server/automation-core.check.ts
node --no-warnings --experimental-strip-types src/workflows/retryable-stage.check.ts
```

Expected: all exit 0.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 3: Verify the dashboard shape**

Start the dev server if it is not already running:

```bash
npm run dev
```

Open:

```text
http://localhost:5173/automation
```

Expected:

- The table headers are `Task`, `Status`, `Progress`, `Latest UTC`, `Controls`.
- There is no `Attempt` column.
- Failed tasks show `Run again`, not `Retry`.
- `Run again` posts to `?/run`; there is no dashboard path that posts to `?/retry`.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git diff --stat HEAD
git diff -- src/lib/automation/server/page-model.ts src/lib/automation/AutomationDashboard.svelte src/routes/automation/+page.server.ts src/lib/automation/server/runner.ts src/lib/automation/server/tasks.ts src/workflows/retryable-stage.ts src/workflows/cathay-all-statements.ts
```

Expected: only the files named in this plan changed, plus their check files. The diff should not add a generic workflow engine, new database tables, or broad checkpoint storage.
