# Automation Session Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every App-owned Libretto session is closed on terminal task outcomes or App shutdown, while retaining `waiting_for_human` sessions for at most 20 minutes.

**Architecture:** The runner assigns an explicit session ID before spawning Libretto and records it in the existing task log. A focused lifecycle module owns session IDs, daemon PIDs, close escalation, idempotence, and waiting timers; the runner owns task-run status changes. Electron calls runner recovery during startup and bounded cleanup during normal shutdown.

**Tech Stack:** TypeScript, Node.js child processes and timers, existing SQLite ledger store, Electron lifecycle events, Node built-in test runner.

## Global Constraints

- Only `waiting_for_human` may retain an App-owned browser session.
- The deadline is exactly 20 minutes from entering `waiting_for_human`.
- Completed, failed, cancelled, timed-out, Assist force-quit, App-shutdown, and startup-recovered runs close their sessions.
- Normal App close or restart cleans immediately; abnormal exit is reconciled on the next launch.
- Do not add a database table or column, dependency, watchdog service, broad `pkill`, or Libretto package patch.
- Preserve the workflow error and append cleanup errors as secondary context.
- Verify the exact recorded PID still belongs to the expected session before sending signals.

## File Map

- Modify `src/lib/automation/server/desktop-command.ts`: pass explicit session IDs to Libretto run commands.
- Modify `src/lib/automation/server/libretto-session.ts`: expose the daemon PID already present in session state.
- Create `src/lib/automation/server/session-lifecycle.ts`: session ownership, timers, idempotent close, and exact process escalation.
- Modify `src/lib/automation/server/runner.ts`: enforce terminal cleanup, timeout, startup recovery, and shutdown.
- Modify `src/lib/automation/server/human-session.ts`: reuse shared finalization for Assist force quit.
- Modify `src/lib/automation/server/store.ts`: query unfinished task runs without schema changes.
- Create `electron/automation-shutdown.ts`: bounded, testable Electron before-quit handling.
- Modify `electron/main.ts`: invoke startup recovery and graceful shutdown.
- Extend matching `.check.ts` files; create checks only for the two new modules.

---

### Task 1: Give Every Libretto Run an Explicit Session Identity

**Files:**
- Modify: `src/lib/automation/server/desktop-command.ts:89-121`
- Modify: `src/lib/automation/server/desktop-command.check.ts:24-75`
- Modify: `src/lib/automation/server/libretto-session.ts:4-55`
- Modify: `src/lib/automation/server/libretto-session.check.ts:17-38`
- Modify: `src/lib/automation/server/runner.ts:1-41`
- Modify: `src/lib/automation/server/runner.check.ts:1-65`

**Interfaces:**
- Produces: `createAutomationSessionId(uuid?: () => string): string`
- Produces: `automationSessionFromLog(output: string): string | null`
- Changes: `resolveTaskCommand(task, options: { resumeSession?: string; session?: string }, env)`
- Changes: `LibrettoSessionState.pid` to `number | undefined`

- [ ] **Step 1: Write failing command, parser, and PID checks**

Add to the existing command and runner checks:

~~~ts
assert.deepEqual(
  resolveTaskCommand(fubon, { session: "ses-octopus-123" }, env).args.slice(-2),
  ["--session", "ses-octopus-123"],
);
assert.deepEqual(
  resolveTaskCommand(fubon, { session: "ses-octopus-123" }, { PATH: "/usr/bin" }).args,
  ["run", "run:fubon-all-statements", "--", "--session", "ses-octopus-123"],
);
assert.equal(createAutomationSessionId(() => "fixed-uuid"), "ses-octopus-fixed-uuid");
assert.equal(
  automationSessionFromLog("automation-session: ses-octopus-fixed-uuid\n"),
  "ses-octopus-fixed-uuid",
);
assert.equal(automationSessionFromLog("no session"), null);
~~~

Update the state expectation to include `pid: 123` and add:

~~~ts
assert.throws(() => parseLibrettoSessionState(JSON.stringify({
  session: "ses-1p4q",
  port: 48321,
  pid: -1,
})), /Invalid Libretto session pid/);
~~~

- [ ] **Step 2: Run focused checks and verify failure**

~~~bash
node --no-warnings --experimental-strip-types --test \
  src/lib/automation/server/desktop-command.check.ts \
  src/lib/automation/server/libretto-session.check.ts \
  src/lib/automation/server/runner.check.ts
~~~

Expected: FAIL because the new option, PID, and helpers do not exist.

- [ ] **Step 3: Implement explicit session arguments**

Extend the command options and append the session only for Libretto tasks:

~~~ts
options: { resumeSession?: string; session?: string } = {},
~~~

~~~ts
const sessionArgs = options.session ? ["--session", options.session] : [];

if (!isDesktopRuntime(env)) {
  return {
    display: task.script,
    command: "npm",
    args: task.command[0] === "libretto" && sessionArgs.length > 0
      ? ["run", task.script, "--", ...sessionArgs]
      : ["run", task.script],
    env,
  };
}

if (runtime === "libretto") {
  return {
    ...resolveLibrettoCommand([...args, ...sessionArgs], env),
    display: task.script,
  };
}
~~~

In `runner.ts`:

~~~ts
import { randomUUID } from "node:crypto";
import { validateLibrettoSessionName } from "./libretto-session.ts";

export function createAutomationSessionId(uuid = randomUUID) {
  return validateLibrettoSessionName("ses-octopus-" + uuid());
}

export function automationSessionFromLog(output: string) {
  return output.match(/automation-session:\s+([A-Za-z0-9._-]+)/i)?.[1] ?? null;
}
~~~

In `libretto-session.ts`, add `pid?: number` to the state type and validate it:

~~~ts
const pid = raw.pid === undefined ? undefined : Number(raw.pid);
if (pid !== undefined && (!Number.isInteger(pid) || pid <= 0)) {
  throw new Error("Invalid Libretto session pid: " + String(raw.pid));
}
~~~

Return `pid` with the existing session fields.

- [ ] **Step 4: Run checks and typecheck**

Run Step 2 again, then:

~~~bash
npm run typecheck
~~~

Expected: all focused checks PASS and typecheck exits 0.

- [ ] **Step 5: Commit**

~~~bash
git add src/lib/automation/server/desktop-command.ts \
  src/lib/automation/server/desktop-command.check.ts \
  src/lib/automation/server/libretto-session.ts \
  src/lib/automation/server/libretto-session.check.ts \
  src/lib/automation/server/runner.ts \
  src/lib/automation/server/runner.check.ts
git commit -m "feat: assign automation session identities"
~~~

---

### Task 2: Add Exact, Idempotent Session Finalization

**Files:**
- Create: `src/lib/automation/server/session-lifecycle.ts`
- Create: `src/lib/automation/server/session-lifecycle.check.ts`
- Modify: `src/lib/automation/server/runner.ts:161-184` to move `closeLibrettoSession`

**Interfaces:**
- Produces: `WAITING_SESSION_TIMEOUT_MS = 1_200_000`
- Produces: `ownAutomationSession(input: OwnedAutomationSession): void`
- Produces: `ownedAutomationSession(taskId: string): OwnedAutomationSession | null`
- Produces: `armAutomationSessionTimeout(taskId, onTimeout, timerDeps?): void`
- Produces: `disarmAutomationSessionTimeout(taskId): void`
- Produces: `finalizeOwnedAutomationSession(taskId, deps?): Promise<void>`
- Produces: `finalizeAllOwnedAutomationSessions(deps?): Promise<void>`
- Produces: `closeLibrettoSession(session: string): Promise<void>`

- [ ] **Step 1: Write failing lifecycle checks**

Create `session-lifecycle.check.ts` with Node test cases covering the timer, one escalation, full escalation, and concurrent idempotence:

~~~ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  WAITING_SESSION_TIMEOUT_MS,
  armAutomationSessionTimeout,
  finalizeOwnedAutomationSession,
  ownAutomationSession,
  ownedAutomationSession,
} from "./session-lifecycle.ts";

test("waiting timeout is exactly twenty minutes", () => {
  let delay = 0;
  armAutomationSessionTimeout("task-1", async () => {}, {
    setTimer(_callback, ms) { delay = ms; return 1; },
    clearTimer() {},
  });
  assert.equal(delay, WAITING_SESSION_TIMEOUT_MS);
  assert.equal(delay, 20 * 60 * 1_000);
});

test("graceful close escalates only the owned daemon", async () => {
  const signals: NodeJS.Signals[] = [];
  let checks = 0;
  ownAutomationSession({ taskId: "task-1", taskRunId: "run-1", session: "ses-1", pid: 42 });
  await finalizeOwnedAutomationSession("task-1", {
    async closeSession() {},
    isExpectedDaemon(pid, session) {
      assert.equal(pid, 42);
      assert.equal(session, "ses-1");
      checks += 1;
      return checks < 2;
    },
    signalProcessGroup(pid, signal) { assert.equal(pid, 42); signals.push(signal); },
    async wait() {},
  });
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(ownedAutomationSession("task-1"), null);
});
~~~

Add the full escalation and idempotence cases:

```ts
test("hung daemon escalates through SIGKILL", async () => {
  const signals: NodeJS.Signals[] = [];
  ownAutomationSession({ taskId: "task-2", taskRunId: "run-2", session: "ses-2", pid: 84 });
  await finalizeOwnedAutomationSession("task-2", {
    async closeSession() { throw new Error("IPC timeout"); },
    isExpectedDaemon() { return signals.length < 2; },
    signalProcessGroup(_pid, signal) { signals.push(signal); },
    async wait() {},
  });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("concurrent finalization closes once", async () => {
  let closeCalls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  ownAutomationSession({ taskId: "task-3", taskRunId: "run-3", session: "ses-3", pid: null });
  const deps = {
    async closeSession() { closeCalls += 1; await blocked; },
    isExpectedDaemon() { return false; },
    signalProcessGroup() {},
    async wait() {},
  };
  const first = finalizeOwnedAutomationSession("task-3", deps);
  const second = finalizeOwnedAutomationSession("task-3", deps);
  release();
  await Promise.all([first, second]);
  assert.equal(closeCalls, 1);
});
```

- [ ] **Step 2: Run the new check and verify failure**

~~~bash
node --no-warnings --experimental-strip-types --test \
  src/lib/automation/server/session-lifecycle.check.ts
~~~

Expected: FAIL because the lifecycle module does not exist.

- [ ] **Step 3: Implement the registry and timer**

Create these public types and state:

~~~ts
export const WAITING_SESSION_TIMEOUT_MS = 20 * 60 * 1_000;
const TERM_GRACE_MS = 1_500;
const KILL_GRACE_MS = 300;

export type OwnedAutomationSession = {
  taskId: string;
  taskRunId: string;
  session: string;
  pid: number | null;
};

export type FinalizeSessionDeps = {
  closeSession(session: string): Promise<void>;
  isExpectedDaemon(pid: number, session: string): boolean;
  signalProcessGroup(pid: number, signal: NodeJS.Signals): void;
  wait(ms: number): Promise<void>;
};

export type TimerDeps = {
  setTimer(callback: () => void, ms: number): NodeJS.Timeout | number;
  clearTimer(timer: NodeJS.Timeout | number): void;
};

const ownedByTask = new Map<string, OwnedAutomationSession>();
const closingBySession = new Map<string, Promise<void>>();
const timeoutByTask = new Map<string, NodeJS.Timeout | number>();
~~~

`ownAutomationSession` replaces the task handle but preserves a known PID if a refresh supplies `null`. Arming first disarms the prior timer and invokes `void onTimeout()`. Finalization stores one promise per session, disarms the timer, and removes ownership in `finally`.

If the handle still has `pid: null`, finalization reads the current Libretto state before graceful close. `finalizeAllOwnedAutomationSessions` starts closes in parallel, waits with `Promise.allSettled`, and reports an `AggregateError` only after every owned session has had a cleanup attempt.

- [ ] **Step 4: Implement exact-PID escalation**

Move the existing `closeLibrettoSession` from `runner.ts` into this module. Use only Node and current helpers:

~~~ts
function processCommand(pid: number) {
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

function isExpectedDaemon(pid: number, session: string) {
  const command = processCommand(pid);
  return command.includes("libretto/dist/cli/core/daemon/daemon.js")
    && command.includes('\"session\":\"' + session + '\"');
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    process.kill(pid, signal);
  }
}
~~~

Finalization order is: graceful close; verify; `SIGTERM`; wait 1,500 ms; verify; `SIGKILL`; wait 300 ms; final verify. If no PID is known and graceful close fails, or the exact daemon remains after `SIGKILL`, throw a cleanup error. A graceful “no browser running” result is success.

- [ ] **Step 5: Run lifecycle, runner, and type checks**

~~~bash
node --no-warnings --experimental-strip-types --test \
  src/lib/automation/server/session-lifecycle.check.ts \
  src/lib/automation/server/runner.check.ts
npm run typecheck
~~~

Expected: all checks PASS and typecheck exits 0.

- [ ] **Step 6: Commit**

~~~bash
git add src/lib/automation/server/session-lifecycle.ts \
  src/lib/automation/server/session-lifecycle.check.ts \
  src/lib/automation/server/runner.ts
git commit -m "fix: finalize owned libretto sessions"
~~~

---

### Task 3: Enforce Terminal Cleanup, Timeout, Force Quit, and Recovery

**Files:**
- Modify: `src/lib/automation/server/store.ts:148-218`
- Modify: `src/lib/automation/server/store.check.ts:1-158`
- Modify: `src/lib/automation/server/runner.ts:186-372`
- Modify: `src/lib/automation/server/runner.check.ts:1-197`
- Modify: `src/lib/automation/server/human-session.ts:34-60`

**Interfaces:**
- Produces: `activeTaskRuns(db: LedgerDatabase): AutomationTaskRun[]`
- Produces: `recoverAbandonedAutomationSessions(ledgerDir?: string): Promise<void>`
- Produces: `shutdownAutomationSessions(ledgerDir?: string): Promise<void>`
- Consumes Task 1 identity and Task 2 lifecycle APIs.

- [ ] **Step 1: Write failing store and policy checks**

Create one `running`, one `waiting_for_human`, and one `completed` task run in `store.check.ts`:

~~~ts
assert.deepEqual(
  activeTaskRuns(db).map((item) => item.status).sort(),
  ["running", "waiting_for_human"],
);
~~~

Add pure runner policy assertions:

~~~ts
assert.equal(shouldRetainAutomationSession("waiting_for_human"), true);
assert.equal(shouldRetainAutomationSession("completed"), false);
assert.equal(shouldRetainAutomationSession("failed"), false);
assert.equal(
  appendCleanupError("workflow failed", "IPC timeout"),
  "workflow failed\nSession cleanup failed: IPC timeout",
);
assert.equal(appendCleanupError(null, "IPC timeout"), "Session cleanup failed: IPC timeout");
~~~

- [ ] **Step 2: Run checks and verify failure**

~~~bash
node --no-warnings --experimental-strip-types --test \
  src/lib/automation/server/store.check.ts \
  src/lib/automation/server/runner.check.ts
~~~

Expected: FAIL because the query and policies are missing.

- [ ] **Step 3: Add the unfinished-run query**

~~~ts
export function activeTaskRuns(db: LedgerDatabase): AutomationTaskRun[] {
  const rows = db.prepare(`
    SELECT *
    FROM automation_task_runs
    WHERE status IN ('running', 'waiting_for_human')
    ORDER BY started_at ASC
  `).all() as Record<string, unknown>[];
  return rows.map(rowToTaskRun);
}
~~~

Replace the ` characters around the SQL with a TypeScript template literal during implementation. Reuse the existing table and `rowToTaskRun`; do not add a migration.

- [ ] **Step 4: Assign and register before spawn**

Inside `runAutomationTask`:

~~~ts
const isLibrettoTask = task.command[0] === "libretto";
const session = isLibrettoTask
  ? options.resumeSession ?? createAutomationSessionId()
  : null;
const command = resolveTaskCommand(task, {
  resumeSession: options.resumeSession,
  session: options.resumeSession ? undefined : session ?? undefined,
}, env);
~~~

After creating the task run:

~~~ts
if (session) {
  appendLog(logPath, "automation-session: " + session + "\n");
  ownAutomationSession({
    taskId: task.id,
    taskRunId: run.taskRunId,
    session,
    pid: readLibrettoSessionState(session)?.pid ?? null,
  });
}
~~~

Refresh the same handle after output chunks so the daemon PID is retained as soon as state appears.

- [ ] **Step 5: Apply one terminal policy and timeout**

Implement:

~~~ts
export function shouldRetainAutomationSession(status: AutomationTaskStatus) {
  return status === "waiting_for_human";
}

export function appendCleanupError(message: string | null, cleanup: string) {
  const suffix = "Session cleanup failed: " + cleanup;
  return message ? message + "\n" + suffix : suffix;
}
~~~

When the status is `waiting_for_human`, arm the timer. Its callback reopens the ledger DB, confirms the same run still waits, finalizes the session, and writes:

~~~ts
{
  status: "failed",
  finishedAt: new Date().toISOString(),
  exitCode: null,
  signal: null,
  errorMessage: "等待人工操作超過 20 分鐘",
}
~~~

Every other Libretto result awaits shared finalization before the final task-run update. A confirmed cleanup failure changes a would-be completed run to `failed`. Existing workflow failures stay failed and append the cleanup error.

Make `cancelAutomationTask` async: signal the direct child, then await shared finalization. A second finalization from the runner is harmless.

- [ ] **Step 6: Route Assist force quit through the owner**

Replace the direct close in `human-session.ts`:

~~~ts
const state = readLibrettoSessionState(session);
ownAutomationSession({
  taskId,
  taskRunId: run.taskRunId,
  session,
  pid: state?.pid ?? null,
});
await finalizeOwnedAutomationSession(taskId);
~~~

Keep the existing failed status and `Browser session force quit.` message. Finalization cancels the timer.

- [ ] **Step 7: Implement recovery and shutdown**

Add a private `sessionFromRun` that reads `run.logPath`, falls back to `run.logTail`, and parses `automation-session:` before the old resume syntax. Add a shared operation that registers the recovered session/PID, finalizes it, and updates the unfinished run.

Export:

~~~ts
export async function recoverAbandonedAutomationSessions(
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
) {
  await finalizePersistedActiveRuns(ledgerDir, "App 前次異常結束");
}

export async function shutdownAutomationSessions(
  ledgerDir = process.env.LEDGER_DIR ?? "data/ledger",
) {
  for (const child of activeTaskChildren.values()) child.kill("SIGTERM");
  await finalizeAllOwnedAutomationSessions();
  await finalizePersistedActiveRuns(ledgerDir, "App 關閉，人工操作未完成");
}
~~~

Catch an aggregate error from `finalizeAllOwnedAutomationSessions`, continue through `finalizePersistedActiveRuns`, then rethrow after every unfinished run has been updated. Process persisted runs independently so one cleanup error does not skip later sessions. Update all unfinished runs to `failed` and log session, PID, and cleanup error.

- [ ] **Step 8: Run focused checks and typecheck**

~~~bash
node --no-warnings --experimental-strip-types --test \
  src/lib/automation/server/desktop-command.check.ts \
  src/lib/automation/server/libretto-session.check.ts \
  src/lib/automation/server/session-lifecycle.check.ts \
  src/lib/automation/server/store.check.ts \
  src/lib/automation/server/runner.check.ts \
  src/lib/automation/server/human-session.check.ts
npm run typecheck
~~~

Expected: all checks PASS and typecheck exits 0.

- [ ] **Step 9: Commit**

~~~bash
git add src/lib/automation/server/store.ts \
  src/lib/automation/server/store.check.ts \
  src/lib/automation/server/runner.ts \
  src/lib/automation/server/runner.check.ts \
  src/lib/automation/server/human-session.ts
git commit -m "fix: enforce automation session lifecycle"
~~~

---

### Task 4: Reconcile Electron Startup and Shutdown

**Files:**
- Create: `electron/automation-shutdown.ts`
- Create: `electron/automation-shutdown.check.ts`
- Modify: `electron/main.ts:1-160`

**Interfaces:**
- Produces: `createBeforeQuitHandler(options, timerDeps?): (event: { preventDefault(): void }) => void`
- Consumes runner recovery and shutdown operations from Task 3.

- [ ] **Step 1: Write the failing bounded-shutdown checks**

Create `electron/automation-shutdown.check.ts`:

~~~ts
import assert from "node:assert/strict";
import test from "node:test";
import { createBeforeQuitHandler } from "./automation-shutdown.ts";

test("before quit waits for cleanup and retries quit once", async () => {
  let prevented = 0;
  let quitCalls = 0;
  let release!: () => void;
  const cleanup = new Promise<void>((resolve) => { release = resolve; });
  const handler = createBeforeQuitHandler({
    cleanup: () => cleanup,
    quit: () => { quitCalls += 1; },
    timeoutMs: 5_000,
  });

  handler({ preventDefault() { prevented += 1; } });
  handler({ preventDefault() { prevented += 1; } });
  assert.equal(prevented, 2);
  assert.equal(quitCalls, 0);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(quitCalls, 1);

  handler({ preventDefault() { prevented += 1; } });
  assert.equal(prevented, 2);
});

test("before quit stops waiting at the deadline", async () => {
  let fireDeadline!: () => void;
  let quitCalls = 0;
  const handler = createBeforeQuitHandler({
    cleanup: () => new Promise<void>(() => {}),
    quit: () => { quitCalls += 1; },
    timeoutMs: 5_000,
  }, {
    setTimer(callback, ms) {
      assert.equal(ms, 5_000);
      fireDeadline = callback;
      return 1;
    },
    clearTimer() {},
  });

  handler({ preventDefault() {} });
  fireDeadline();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(quitCalls, 1);
});
~~~

- [ ] **Step 2: Run the check and verify failure**

~~~bash
node --no-warnings --experimental-strip-types --test \
  electron/automation-shutdown.check.ts
~~~

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement one before-quit gate**

~~~ts
export function createBeforeQuitHandler(options: {
  cleanup(): Promise<void>;
  quit(): void;
  timeoutMs: number;
}, timerDeps = {
  setTimer: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimer: (timer: NodeJS.Timeout | number) => clearTimeout(timer as NodeJS.Timeout),
}) {
  let quittingAllowed = false;
  let cleanupStarted = false;

  return (event: { preventDefault(): void }) => {
    if (quittingAllowed) return;
    event.preventDefault();
    if (cleanupStarted) return;
    cleanupStarted = true;

    let timer: NodeJS.Timeout | number | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = timerDeps.setTimer(resolve, options.timeoutMs);
    });
    void Promise.race([options.cleanup(), deadline]).finally(() => {
      if (timer !== undefined) timerDeps.clearTimer(timer);
      quittingAllowed = true;
      options.quit();
    });
  };
}
~~~

Keep this two-method timer seam local to the before-quit helper; do not create a general scheduler abstraction.

- [ ] **Step 4: Wire recovery and shutdown in Electron**

After environment setup, `process.chdir`, and migration—but before IPC and window creation:

~~~ts
await recoverAbandonedAutomationSessions().catch((error) => {
  console.warn("automation-session-startup-recovery-failed", error);
});
~~~

Register one handler:

~~~ts
const handleBeforeQuit = createBeforeQuitHandler({
  cleanup: () => shutdownAutomationSessions(),
  quit: () => app.quit(),
  timeoutMs: 5_000,
});
app.on("before-quit", handleBeforeQuit);
~~~

macOS Force Quit and `SIGKILL` remain unrecoverable in-process; startup recovery is the fallback.

- [ ] **Step 5: Run Electron checks, typecheck, and build**

~~~bash
node --no-warnings --experimental-strip-types --test \
  electron/automation-shutdown.check.ts
npm run typecheck
npm run build:electron
~~~

Expected: check PASS, typecheck exits 0, and Electron build completes.

- [ ] **Step 6: Commit**

~~~bash
git add electron/automation-shutdown.ts \
  electron/automation-shutdown.check.ts \
  electron/main.ts
git commit -m "fix: clean automation sessions on app lifecycle"
~~~

---

### Task 5: Full Regression and Desktop Process Smoke Test

**Files:**
- Verify only; create no source file.

**Interfaces:**
- Consumes all earlier tasks.
- Produces evidence that no App-owned daemon tree survives terminal paths.

- [ ] **Step 1: Run the complete suite**

~~~bash
npm test
npm run typecheck
npm run build
~~~

Expected: all tests pass, typecheck exits 0, renderer and Electron builds complete.

- [ ] **Step 2: Start the desktop App and pause one safe workflow**

~~~bash
npm run desktop:dev
~~~

Use the automation UI to reach `waiting_for_human` and record its `ses-octopus-*` ID from the task log. If no safe paused path is available without production credentials, report the limitation instead of claiming live verification.

- [ ] **Step 3: Verify Assist force quit**

Before and after force quit:

~~~bash
ps ax -o pid=,ppid=,command= | rg 'ses-octopus-|libretto/dist/cli/core/daemon/daemon.js|headless_shell|esbuild --service'
~~~

Expected after force quit: no daemon, Chromium, or esbuild process belonging to the recorded session remains. Separately launched developer sessions remain alive.

- [ ] **Step 4: Verify normal App quit**

Create another paused session and quit OctopusBeak normally. Expected: its process tree is gone and its run reports `App 關閉，人工操作未完成`.

- [ ] **Step 5: Verify abnormal-exit recovery**

Create a paused session, force-terminate only the App process, then relaunch. Expected: startup recovery closes the detached session and records `App 前次異常結束`.

- [ ] **Step 6: Verify the timeout without weakening production**

Automated checks must prove the production constant is 1,200,000 ms. Do not commit a shorter timeout. If waiting 20 minutes is impractical, rely on the fake-timer check and explicitly report that the live timeout was not manually elapsed.

- [ ] **Step 7: Review the final worktree**

~~~bash
git diff --check
git status --short
git log --oneline -5
~~~

Expected: no whitespace errors, no unintended generated files, and the four implementation commits are visible.
