import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import { statementRunSummaryLine } from "../statement-run-summary.ts";
import { activeTaskRuns, createTaskRun, latestTaskRuns, recentTaskRuns, taskRunById } from "./store.ts";
import {
  armAutomationSessionTimeout,
  finalizeExactOwnedAutomationSession,
  ownAutomationSession,
  ownedAutomationSession,
} from "./session-lifecycle.ts";
import {
  accumulateAutomationOutput,
  activeAutomationTaskIds,
  appendCleanupError,
  automationCleanupFailureDetails,
  automationSessionFromLog,
  automationProcessEnv,
  createAutomationSessionId,
  createAutomationOutputBuffer,
  finalFailureMessage,
  finalizeTerminalAutomationSession,
  hasActiveAutomationTask,
  isForceQuitRun,
  librettoRunCdpPatchCommand,
  liveTaskRunUpdate,
  nextAttemptStatus,
  parseAutomationProgress,
  prepareLibrettoRunCdpPatch,
  claimRunAutomationSession,
  cancelAutomationTask,
  resumeFailureMessage,
  resumeSessionFromLog,
  recoverAbandonedAutomationSessions,
  runAutomationBatch,
  runAutomationTask,
  runWithConcurrency,
  shutdownAutomationSessions,
  shouldCloseResumeSession,
  shouldMarkWaitingForHuman,
  shouldRetainAutomationSession,
  startAutomationResume,
  startAutomationTask,
  startAutomationTasks,
} from "./runner.ts";
import { assertTaskStatementSelection, taskById } from "./tasks.ts";

test("fresh statement tasks require a saved selection", () => {
  const task = taskById("fubon-all-statements");
  assert.ok(task);
  assert.throws(
    () => assertTaskStatementSelection(task, { LIBRETTO_CLOUD_FUBON_ENABLED: true }),
    /Select at least one Fubon/,
  );
  assert.doesNotThrow(() => assertTaskStatementSelection(task, {
    LIBRETTO_CLOUD_FUBON_ENABLED: true,
    LIBRETTO_CLOUD_FUBON_STATEMENT_TYPES: "deposit",
  }));
});

test("manual and scheduled fresh starts require a saved selection", () => {
  const dir = mkdtempSync(join(tmpdir(), "automation-start-selection-"));
  const originalCwd = process.cwd();
  try {
    process.chdir(dir);
    writeFileSync("settings.json", JSON.stringify({ LIBRETTO_CLOUD_FUBON_ENABLED: true }));
    assert.throws(() => startAutomationTask("fubon-all-statements", dir), /Select at least one Fubon/);
    assert.throws(
      () => startAutomationTask("fubon-all-statements", dir, { scheduledAtUtc: "2026-07-14T22:00:00.000Z" }),
      /Select at least one Fubon/,
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("batch starts reject missing selections before claiming any task", () => {
  const dir = mkdtempSync(join(tmpdir(), "automation-batch-selection-"));
  const originalCwd = process.cwd();
  try {
    process.chdir(dir);
    writeFileSync("settings.json", JSON.stringify({ LIBRETTO_CLOUD_FUBON_ENABLED: true }));
    assert.throws(
      () => startAutomationTasks(["exchange-rates", "fubon-all-statements"], dir),
      /Select at least one Fubon/,
    );
    assert.deepEqual(activeAutomationTaskIds(), []);
  } finally {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume bypasses fresh statement-selection validation", async () => {
  const root = mkdtempSync(join(tmpdir(), "automation-resume-selection-"));
  const binDir = join(root, "bin");
  const ledgerDir = join(root, "ledger");
  const originalCwd = process.cwd();
  const originalPath = process.env.PATH;
  try {
    mkdirSync(binDir);
    writeFileSync(join(binDir, "libretto"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(binDir, "libretto"), 0o755);
    writeFileSync(join(root, "settings.json"), JSON.stringify({ LIBRETTO_CLOUD_FUBON_ENABLED: true }));
    process.chdir(root);
    process.env.PATH = `${binDir}:${originalPath ?? ""}`;
    assert.doesNotThrow(() => startAutomationResume("fubon-all-statements", "ses-existing", ledgerDir));
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!hasActiveAutomationTask()) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(hasActiveAutomationTask(), false);
    const db = openLedgerDatabase(ledgerDir);
    assert.equal(latestTaskRuns(db)["fubon-all-statements"]?.taskId, "fubon-all-statements");
    db.close();
  } finally {
    process.chdir(originalCwd);
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  }
});

assert.equal(createAutomationSessionId(() => "fixed-uuid"), "ses-octopus-fixed-uuid");
assert.equal(
  automationSessionFromLog("automation-session: ses-octopus-fixed-uuid\n"),
  "ses-octopus-fixed-uuid",
);
assert.equal(automationSessionFromLog("no session"), null);
assert.equal(shouldRetainAutomationSession("waiting_for_human"), true);
assert.equal(shouldRetainAutomationSession("completed"), false);
assert.equal(shouldRetainAutomationSession("failed"), false);
assert.equal(
  appendCleanupError("workflow failed", "IPC timeout"),
  "workflow failed\nSession cleanup failed: IPC timeout",
);
assert.equal(appendCleanupError(null, "IPC timeout"), "Session cleanup failed: IPC timeout");
assert.deepEqual(
  automationCleanupFailureDetails({
    taskId: "task-log",
    taskRunId: "run-log",
    session: "ses-log",
    pid: 777,
  }, new Error("IPC timeout")),
  {
    taskRunId: "run-log",
    sessionId: "ses-log",
    retainedPid: 777,
    error: "IPC timeout",
  },
);

test("persisted session recovery uses a bounded log read", () => {
  const source = readFileSync(new URL("./runner.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /readFileSync\(run\.logPath/);
  assert.match(source, /readSync\([^;]+SESSION_LOG_PREFIX_BYTES/s);
});

test("terminal cleanup catch logs owner and appends the workflow error", async () => {
  const messages: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { messages.push(args); };
  try {
    const result = await finalizeTerminalAutomationSession({
      taskId: "task-terminal-log",
      taskRunId: "run-terminal-log",
      session: "ses-terminal-log",
      pid: 888,
    }, "workflow failed", async () => {
      throw new Error("close timeout");
    });
    assert.deepEqual(result, {
      errorMessage: "workflow failed\nSession cleanup failed: close timeout",
      cleanupFailed: true,
    });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(messages, [[
    "automation-session-cleanup-failed",
    {
      taskRunId: "run-terminal-log",
      sessionId: "ses-terminal-log",
      retainedPid: 888,
      error: "close timeout",
    },
  ]]);
});

assert.equal(automationProcessEnv({ NODE_ENV: "production" }).NODE_ENV, "development");
assert.equal(automationProcessEnv({ NODE_ENV: "test" }).NODE_ENV, "test");

test("Libretto CDP patch is prepared once per app process", () => {
  let calls = 0;
  const runPatch = () => { calls += 1; };

  prepareLibrettoRunCdpPatch(runPatch);
  prepareLibrettoRunCdpPatch(runPatch);

  assert.equal(calls, 1);
});

test("automation output is flushed in batches", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const flushed: string[] = [];
  const buffer = createAutomationOutputBuffer((chunk) => flushed.push(chunk));

  buffer.push("first\n");
  buffer.push("second\n");
  context.mock.timers.tick(499);
  assert.deepEqual(flushed, []);
  context.mock.timers.tick(1);
  assert.deepEqual(flushed, ["first\nsecond\n"]);

  buffer.push("final\n");
  buffer.flush();
  context.mock.timers.tick(500);
  assert.deepEqual(flushed, ["first\nsecond\n", "final\n"]);
});

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

test("automation output retries a failed timer flush", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const flushed: string[] = [];
  let attempts = 0;
  const buffer = createAutomationOutputBuffer(
    (chunk) => {
      attempts += 1;
      if (attempts === 1) throw new Error("database is locked");
      flushed.push(chunk);
    },
    500,
    () => {},
  );

  buffer.push("progress\n");
  context.mock.timers.tick(500);
  assert.deepEqual(flushed, []);
  context.mock.timers.tick(499);
  assert.deepEqual(flushed, []);
  context.mock.timers.tick(1);
  assert.deepEqual(flushed, ["progress\n"]);
});

test("automation output does not retry a failed manual flush", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  const buffer = createAutomationOutputBuffer(
    () => {
      attempts += 1;
      throw new Error("database is closed");
    },
    500,
    () => {},
  );

  buffer.push("final\n");
  buffer.flush();
  context.mock.timers.tick(500);

  assert.equal(attempts, 1);
});

test("automation output caps retained failed chunks", () => {
  let attempts = 0;
  let flushed = "";
  const buffer = createAutomationOutputBuffer(
    (chunk) => {
      attempts += 1;
      if (attempts < 3) throw new Error("database is locked");
      flushed = chunk;
    },
    60_000,
    () => {},
  );

  buffer.push("a".repeat(3_000));
  buffer.flush();
  buffer.push("b".repeat(3_000));
  buffer.flush();
  buffer.flush();

  assert.equal(flushed, `${"a".repeat(1_000)}${"b".repeat(3_000)}`);
});

test("automation output contains error handler failures for timer and manual flushes", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const messages: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { messages.push(args); };
  try {
    const buffer = createAutomationOutputBuffer(
      () => { throw new Error("database is locked"); },
      500,
      () => { throw new Error("handler failed"); },
    );

    buffer.push("progress\n");
    assert.doesNotThrow(() => context.mock.timers.tick(500));
    assert.doesNotThrow(() => buffer.flush());
  } finally {
    console.error = originalError;
  }
  assert.equal(messages.length, 2);
});

test("output persistence warnings remain visible in terminal history without hiding failure", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "automation-output-history-"));
  const ledgerDir = join(rootDir, "ledger");
  const workDir = join(rootDir, "work");
  const binDir = join(rootDir, "bin");
  const previousCwd = process.cwd();
  const previousPath = process.env.PATH;
  const originalError = console.error;
  try {
    mkdirSync(join(workDir, "data", "automation"), { recursive: true });
    writeFileSync(join(workDir, "data", "automation", "logs"), "blocks log directory");
    mkdirSync(binDir, { recursive: true });
    const npmPath = join(binDir, "npm");
    writeFileSync(npmPath, "#!/bin/sh\nprintf 'first\\n'\nsleep 0.05\nprintf 'second\\n'\n", "utf8");
    chmodSync(npmPath, 0o755);
    process.chdir(workDir);
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    console.error = () => {};

    assert.deepEqual(await runAutomationTask("exchange-rates", ledgerDir), { status: "completed" });

    const db = openLedgerDatabase(ledgerDir, { readOnly: true });
    const terminal = latestTaskRuns(db)["exchange-rates"];
    assert.equal(terminal?.status, "completed");
    assert.match(terminal?.errorMessage ?? "", /automation-output-write-failed:/);
    assert.equal(terminal?.errorMessage?.match(/automation-output-write-failed:/g)?.length, 2);
    const history = recentTaskRuns(db, 1);
    assert.equal(history[0]?.status, "completed");
    assert.equal(history[0]?.errorMessage, terminal?.errorMessage);
    db.close();

    writeFileSync(npmPath, "#!/bin/sh\nprintf 'real terminal failure\\n'\nexit 1\n", "utf8");
    assert.deepEqual(await runAutomationTask("exchange-rates", ledgerDir), { status: "failed" });
    const failedDb = openLedgerDatabase(ledgerDir, { readOnly: true });
    const failed = recentTaskRuns(failedDb, 1)[0];
    assert.equal(failed?.status, "failed");
    assert.match(failed?.errorMessage ?? "", /^real terminal failure/);
    assert.match(failed?.errorMessage ?? "", /automation-output-write-failed:/);
    failedDb.close();
  } finally {
    console.error = originalError;
    process.chdir(previousCwd);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("clean exits persist statement summary status and preserve missing or malformed fallback", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "automation-statement-summary-"));
  const ledgerDir = join(rootDir, "ledger");
  const workDir = join(rootDir, "work");
  const binDir = join(rootDir, "bin");
  const npmPath = join(binDir, "npm");
  const previousCwd = process.cwd();
  const previousPath = process.env.PATH;
  const runWithOutput = async (line: string) => {
    writeFileSync(npmPath, `#!/bin/sh\nprintf '%s\\n' '${line}'\n`, "utf8");
    chmodSync(npmPath, 0o755);
    return runAutomationTask("exchange-rates", ledgerDir);
  };

  try {
    mkdirSync(workDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    process.chdir(workDir);
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;

    assert.deepEqual(await runWithOutput(statementRunSummaryLine([
      { typeId: "deposit", status: "success" },
      { typeId: "loan", status: "failed", error: "no account" },
    ])), { status: "partial" });
    assert.deepEqual(await runWithOutput(statementRunSummaryLine([
      { typeId: "deposit", status: "failed", error: "broken" },
      { typeId: "loan", status: "failed", error: "denied" },
    ])), { status: "failed" });
    assert.deepEqual(
      await runWithOutput("automation-statement-summary: not-json"),
      { status: "completed" },
    );
    assert.deepEqual(await runWithOutput("ordinary workflow output"), { status: "completed" });

    const db = openLedgerDatabase(ledgerDir, { readOnly: true });
    const rows = db.prepare(`
      SELECT status, error_message
      FROM automation_task_runs
      WHERE task_id = 'exchange-rates'
      ORDER BY rowid DESC
    `).all() as { status: string; error_message: string | null }[];
    assert.deepEqual(rows.map((row) => row.status), ["completed", "completed", "failed", "partial"]);
    assert.equal(rows[2]?.error_message, "deposit: broken\nloan: denied");
    db.close();
  } finally {
    process.chdir(previousCwd);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("batch task startup uses two concurrent slots", () => {
  const source = readFileSync(new URL("./runner.ts", import.meta.url), "utf8");
  assert.match(source, /runWithConcurrency\(selectedTaskIds, 2,/);
});

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

test("a selected task failure still permits one final import attempt", async () => {
  const executed: string[] = [];
  const failure = new Error("crawler failed");

  await assert.rejects(
    runAutomationBatch(
      ["fubon-all-statements", "exchange-rates"],
      async (taskId) => {
        executed.push(taskId);
        if (taskId === "fubon-all-statements") throw failure;
      },
    ),
    (error) => error === failure,
  );

  assert.equal(executed.filter((taskId) => taskId === "import-downloads-csv").length, 1);
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

test("batch execution limits concurrency and starts the next task after a slot opens", async () => {
  const started: number[] = [];
  const releases = new Map<number, () => void>();
  let active = 0;
  let peak = 0;
  const batch = runWithConcurrency([1, 2, 3, 4, 5], 4, async (item) => {
    started.push(item);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => releases.set(item, resolve));
    active -= 1;
  });

  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(started, [1, 2, 3, 4]);
  assert.equal(peak, 4);

  releases.get(1)?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [1, 2, 3, 4, 5]);

  for (const release of releases.values()) release();
  await batch;
  assert.equal(active, 0);
});

test("batch execution rejects invalid concurrency limits", async () => {
  await assert.rejects(runWithConcurrency([1], 0, async () => {}), RangeError);
});

test("batch execution captures synchronous callback failures", async () => {
  await assert.rejects(
    runWithConcurrency([1], 1, () => { throw new Error("sync failure"); }),
    /sync failure/,
  );
});

test("batch startup validates every task before claiming any", async () => {
  assert.throws(
    () => startAutomationTasks(["exchange-rates", "unknown-task"]),
    /Unknown automation task/,
  );
  const leaked = activeAutomationTaskIds();
  if (leaked.includes("exchange-rates")) await cancelAutomationTask("exchange-rates");
  assert.deepEqual(leaked, []);
});

test("a queued batch task can be cancelled before its process starts", async () => {
  startAutomationTasks(["exchange-rates"]);
  assert.deepEqual(activeAutomationTaskIds(), ["exchange-rates"]);
  assert.deepEqual(await cancelAutomationTask("exchange-rates"), { cancelled: "exchange-rates" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(activeAutomationTaskIds(), []);
});

test("an import-only batch runs once and releases its claim", async () => {
  const root = mkdtempSync(join(tmpdir(), "automation-import-only-"));
  const ledgerDir = join(root, "ledger");
  const capturePath = join(root, "capture.txt");
  const oldEnv = {
    OCTOPUSBEAK_DESKTOP: process.env.OCTOPUSBEAK_DESKTOP,
    OCTOPUSBEAK_APP_ROOT: process.env.OCTOPUSBEAK_APP_ROOT,
    OCTOPUSBEAK_NODE_PATH: process.env.OCTOPUSBEAK_NODE_PATH,
    CAPTURE_PATH: process.env.CAPTURE_PATH,
  };
  mkdirSync(join(root, "src", "ledger"), { recursive: true });
  writeFileSync(
    join(root, "src", "ledger", "import-downloads-csv.ts"),
    'import { appendFileSync } from "node:fs";\nappendFileSync(process.env.CAPTURE_PATH, "import\\n");\n',
  );
  process.env.OCTOPUSBEAK_DESKTOP = "1";
  process.env.OCTOPUSBEAK_APP_ROOT = root;
  process.env.OCTOPUSBEAK_NODE_PATH = process.execPath;
  process.env.CAPTURE_PATH = capturePath;

  try {
    startAutomationTasks(["import-downloads-csv"], ledgerDir);
    assert.deepEqual(activeAutomationTaskIds(), ["import-downloads-csv"]);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!activeAutomationTaskIds().includes("import-downloads-csv")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.deepEqual(activeAutomationTaskIds(), []);
    assert.equal(readFileSync(capturePath, "utf8"), "import\n");
    const db = openLedgerDatabase(ledgerDir);
    const count = db.prepare(`
      SELECT count(*) AS count
      FROM automation_task_runs
      WHERE task_id = 'import-downloads-csv'
    `).get() as { count: number };
    assert.equal(count.count, 1);
    db.close();
  } finally {
    if (activeAutomationTaskIds().includes("import-downloads-csv")) {
      await cancelAutomationTask("import-downloads-csv");
    }
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

assert.equal(shouldMarkWaitingForHuman("libretto paused. resume --session abc"), true);
assert.equal(shouldMarkWaitingForHuman("Please enter OTP in browser"), true);
assert.equal(
  shouldMarkWaitingForHuman("manual-auth-required: enter the iPost CAPTCHA in the browser, then run `npx libretto resume --session ses-post`."),
  true,
);
assert.equal(
  shouldMarkWaitingForHuman(
    "hncb-login-account-refilled-after-captcha\nautomation-progress: 100\nIntegration completed.",
  ),
  false,
);
assert.equal(shouldMarkWaitingForHuman("download completed"), false);
assert.deepEqual(librettoRunCdpPatchCommand({ resumeSession: undefined }), [
  "node",
  "scripts/patch-libretto-run-cdp.mjs",
]);
const originalDesktop = process.env.OCTOPUSBEAK_DESKTOP;
const originalAppRoot = process.env.OCTOPUSBEAK_APP_ROOT;
const originalNodePath = process.env.OCTOPUSBEAK_NODE_PATH;
process.env.OCTOPUSBEAK_DESKTOP = "1";
process.env.OCTOPUSBEAK_APP_ROOT = "/AppRoot";
process.env.OCTOPUSBEAK_NODE_PATH = "/AppRoot/OctopusBeak";
assert.deepEqual(librettoRunCdpPatchCommand({ resumeSession: undefined }), [
  "/AppRoot/OctopusBeak",
  "/AppRoot/scripts/patch-libretto-run-cdp.mjs",
]);
if (originalDesktop === undefined) delete process.env.OCTOPUSBEAK_DESKTOP;
else process.env.OCTOPUSBEAK_DESKTOP = originalDesktop;
if (originalAppRoot === undefined) delete process.env.OCTOPUSBEAK_APP_ROOT;
else process.env.OCTOPUSBEAK_APP_ROOT = originalAppRoot;
if (originalNodePath === undefined) delete process.env.OCTOPUSBEAK_NODE_PATH;
else process.env.OCTOPUSBEAK_NODE_PATH = originalNodePath;
assert.equal(librettoRunCdpPatchCommand({ resumeSession: "ses-1p4q" }), null);
assert.equal(
  resumeSessionFromLog(
    "Workflow paused. run `npx libretto resume --session ses-1p4q`.",
  ),
  "ses-1p4q",
);
assert.equal(
  resumeSessionFromLog(
    "manual-auth-required: enter the iPost CAPTCHA in the browser, then run `npx libretto resume --session ses-post`.",
  ),
  "ses-post",
);
assert.equal(resumeSessionFromLog("download completed"), null);
assert.equal(parseAutomationProgress("automation-progress: 35"), 35);
assert.equal(parseAutomationProgress("automation-progress: 20\nautomation-progress: 67"), 67);
assert.equal(parseAutomationProgress("automation-progress: 105"), 100);
assert.equal(parseAutomationProgress("download completed"), null);
assert.deepEqual(liveTaskRunUpdate("download in progress"), {
  logTail: "download in progress",
});
assert.deepEqual(liveTaskRunUpdate("Workflow paused. resume --session ses-1p4q"), {
  status: "waiting_for_human",
  logTail: "Workflow paused. resume --session ses-1p4q",
});
const failedResumeLog =
  'Workflow failed after resume: Could not find selector "input[name=\\"qry_option\\"]".';
const failedResumeMessage = 'Could not find selector "input[name=\\"qry_option\\"]".';
assert.equal(
  resumeFailureMessage(failedResumeLog),
  failedResumeMessage,
);
assert.deepEqual(
  liveTaskRunUpdate(failedResumeLog),
  {
    status: "failed",
    errorMessage: failedResumeMessage,
    logTail: failedResumeLog,
  },
);
const longResumeFailureLog = [
  "Workflow failed after resume: locator.click: Timeout 30000ms exceeded.",
  ...Array.from(
    { length: 220 },
    () => "\u001b[2m    - waiting 500ms\u001b[22m",
  ),
].join("\n");
const accumulatedFailure = accumulateAutomationOutput(
  { logTail: "", resumeFailure: null },
  longResumeFailureLog,
);
assert.equal(
  accumulatedFailure.resumeFailure,
  "locator.click: Timeout 30000ms exceeded.",
);
assert.ok(accumulatedFailure.logTail.length <= 4_000);
assert.doesNotMatch(accumulatedFailure.logChunk, /\u001b/);
assert.doesNotMatch(accumulatedFailure.logTail, /\u001b/);
assert.equal(
  accumulateAutomationOutput(
    accumulatedFailure,
    "\u001b[2m    - retrying click action\u001b[22m",
  ).resumeFailure,
  "locator.click: Timeout 30000ms exceeded.",
);
assert.equal(
  finalFailureMessage(
    [
      "libretto run CDP patch already applied.",
      "Running workflow \"fubonAllStatements\" from /path/fubon-all-statements.ts (headless)...",
      "automation-progress: 0",
      "Fubon credentials look like placeholder values. Update the Fubon credentials in Settings before running Fubon statements.",
      "Browser is still open. You can use `exec` to inspect it. Call `run` to re-run the workflow.",
      "",
    ].join("\n"),
    1,
  ),
  "Fubon credentials look like placeholder values. Update the Fubon credentials in Settings before running Fubon statements.",
);
assert.equal(finalFailureMessage("", 1), "Task exited with code 1");
assert.equal(isForceQuitRun({ status: "failed", errorMessage: "Browser session force quit." }), true);
assert.equal(isForceQuitRun({ status: "failed", errorMessage: "Task exited with code 1" }), false);
assert.equal(isForceQuitRun({ status: "waiting_for_human", errorMessage: null }), false);

assert.equal(
  nextAttemptStatus({
    kind: "crawler",
    attempt: 1,
    maxAttempts: 2,
    exitCode: 0,
    waitingForHuman: true,
  }),
  "waiting_for_human",
);
assert.equal(
  nextAttemptStatus({ kind: "crawler", attempt: 1, maxAttempts: 2, exitCode: 1 }),
  "failed",
);
assert.equal(
  nextAttemptStatus({
    kind: "crawler",
    attempt: 1,
    maxAttempts: 1,
    exitCode: 1,
    waitingForHuman: true,
  }),
  "failed",
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

assert.equal(shouldCloseResumeSession({ status: "failed", resumeSession: "ses-1p4q" }), true);
assert.equal(
  shouldCloseResumeSession({ status: "waiting_for_human", resumeSession: "ses-1p4q" }),
  false,
);
assert.equal(shouldCloseResumeSession({ status: "failed" }), false);

test("persisted recovery continues after one cleanup failure", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "automation-recovery-"));
  const visited: string[] = [];
  try {
    const db = openLedgerDatabase(ledgerDir);
    for (const taskId of ["run-1", "run-2"]) {
      createTaskRun(db, {
        taskId,
        script: taskId,
        kind: "crawler",
        status: "running",
        attempt: 1,
        maxAttempts: 1,
        startedAt: new Date().toISOString(),
        logPath: join(ledgerDir, taskId + ".log"),
      });
    }
    db.close();
    await assert.rejects(
      recoverAbandonedAutomationSessions(ledgerDir, {
        async finalizeRun(_db, run) {
          visited.push(run.taskId);
          if (run.taskId === "run-1") throw new Error("first cleanup failed");
        },
      }),
      AggregateError,
    );
    assert.deepEqual(visited, ["run-1", "run-2"]);
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("failed initial session claim persists failure before spawn", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "automation-in-flight-"));
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const oldOwner = {
    taskId: "fubon-all-statements",
    taskRunId: "run-old",
    session: "ses-in-flight-runner",
  };
  ownAutomationSession({ ...oldOwner, pid: null });
  const closing = finalizeExactOwnedAutomationSession(oldOwner, {
    async closeSession() { await blocked; },
    isExpectedDaemon() { return false; },
    signalProcessGroup() {},
    wait: () => new Promise<void>(() => {}),
  });
  try {
    const db = openLedgerDatabase(ledgerDir);
    const run = createTaskRun(db, {
      taskId: oldOwner.taskId,
      script: "libretto resume",
      kind: "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
      logPath: join(ledgerDir, "in-flight.log"),
    });
    let spawnCalls = 0;
    if (claimRunAutomationSession(db, run.taskRunId, {
      ...oldOwner,
      taskRunId: run.taskRunId,
      pid: null,
    })) spawnCalls += 1;

    assert.equal(spawnCalls, 0);
    assert.equal(taskRunById(db, run.taskRunId)?.status, "failed");
    assert.match(taskRunById(db, run.taskRunId)?.errorMessage ?? "", /session.*closing/i);
    assert.equal(ownedAutomationSession(oldOwner.taskId)?.taskRunId, oldOwner.taskRunId);
    db.close();
  } finally {
    release();
    await closing;
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("resume handoff terminals the matching waiting run after ownership claim", () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "automation-resume-handoff-"));
  try {
    const db = openLedgerDatabase(ledgerDir);
    const waiting = createTaskRun(db, {
      taskId: "resume-handoff-task",
      script: "libretto run",
      kind: "crawler",
      status: "waiting_for_human",
      attempt: 1,
      maxAttempts: 1,
      startedAt: "2026-07-14T01:00:00.000Z",
      logPath: join(ledgerDir, "waiting.log"),
      logTail: "Workflow paused. run `npx libretto resume --session ses-resume-handoff`.",
    });
    const resumed = createTaskRun(db, {
      taskId: "resume-handoff-task",
      script: "libretto resume",
      kind: "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: "2026-07-14T01:01:00.000Z",
      logPath: join(ledgerDir, "resumed.log"),
    });
    const previous = taskRunById(db, waiting.taskRunId)!;
    let cleared = 0;
    ownAutomationSession({
      taskId: previous.taskId,
      taskRunId: previous.taskRunId,
      session: "ses-resume-handoff",
      pid: 321,
    });
    armAutomationSessionTimeout(previous.taskId, async () => {}, {
      setTimer() { return 91; },
      clearTimer() { cleared += 1; },
    });

    assert.equal(claimRunAutomationSession(db, resumed.taskRunId, {
      taskId: previous.taskId,
      taskRunId: resumed.taskRunId,
      session: "ses-resume-handoff",
      pid: 321,
    }, { resumeSession: "ses-resume-handoff", resumeFrom: previous }), true);
    assert.equal(cleared, 1);
    assert.equal(taskRunById(db, waiting.taskRunId)?.status, "failed");
    assert.equal(
      taskRunById(db, waiting.taskRunId)?.errorMessage,
      `Superseded by resume handoff: ${resumed.taskRunId}`,
    );
    assert.match(taskRunById(db, waiting.taskRunId)?.logTail ?? "", new RegExp(resumed.taskRunId));
    assert.deepEqual(activeTaskRuns(db).map((run) => run.taskRunId), [resumed.taskRunId]);
    db.close();
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("ordinary run cannot replace a waiting owner or cancel its timer", () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "automation-owner-race-"));
  try {
    const db = openLedgerDatabase(ledgerDir);
    const run = createTaskRun(db, {
      taskId: "owner-race-task",
      script: "libretto run",
      kind: "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
      logPath: join(ledgerDir, "new.log"),
    });
    ownAutomationSession({
      taskId: "owner-race-task",
      taskRunId: "waiting-run",
      session: "ses-waiting-owner",
      pid: 654,
    });
    let cleared = 0;
    armAutomationSessionTimeout("owner-race-task", async () => {}, {
      setTimer() { return 92; },
      clearTimer() { cleared += 1; },
    });

    assert.equal(claimRunAutomationSession(db, run.taskRunId, {
      taskId: "owner-race-task",
      taskRunId: run.taskRunId,
      session: "ses-new-owner",
      pid: null,
    }), false);
    assert.equal(cleared, 0);
    assert.equal(ownedAutomationSession("owner-race-task")?.taskRunId, "waiting-run");
    db.close();
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("resume DB failure preserves the waiting owner and timer", () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "automation-resume-db-failure-"));
  try {
    const db = openLedgerDatabase(ledgerDir);
    const waiting = createTaskRun(db, {
      taskId: "resume-db-failure-task",
      script: "libretto run",
      kind: "crawler",
      status: "waiting_for_human",
      attempt: 1,
      maxAttempts: 1,
      startedAt: "2026-07-14T02:00:00.000Z",
      logPath: join(ledgerDir, "waiting.log"),
      logTail: "Workflow paused. run `npx libretto resume --session ses-resume-db-failure`.",
    });
    const resumed = createTaskRun(db, {
      taskId: "resume-db-failure-task",
      script: "libretto resume",
      kind: "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: "2026-07-14T02:01:00.000Z",
      logPath: join(ledgerDir, "resumed.log"),
    });
    const previous = taskRunById(db, waiting.taskRunId)!;
    ownAutomationSession({
      taskId: previous.taskId,
      taskRunId: previous.taskRunId,
      session: "ses-resume-db-failure",
      pid: 432,
    });
    let cleared = 0;
    armAutomationSessionTimeout(previous.taskId, async () => {}, {
      setTimer() { return 93; },
      clearTimer() { cleared += 1; },
    });
    const failingDb = {
      prepare() { throw new Error("DB update failed"); },
    } as unknown as typeof db;
    assert.throws(() => claimRunAutomationSession(failingDb, resumed.taskRunId, {
      taskId: previous.taskId,
      taskRunId: resumed.taskRunId,
      session: "ses-resume-db-failure",
      pid: 432,
    }, { resumeSession: "ses-resume-db-failure", resumeFrom: previous }));
    assert.equal(cleared, 0);
    assert.equal(ownedAutomationSession(previous.taskId)?.taskRunId, previous.taskRunId);
    assert.equal(taskRunById(db, waiting.taskRunId)?.status, "waiting_for_human");
    db.close();
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("closing session rolls back resume handoff in one transaction", async () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "automation-resume-closing-"));
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  try {
    const db = openLedgerDatabase(ledgerDir);
    const waiting = createTaskRun(db, {
      taskId: "resume-closing-task",
      script: "libretto run",
      kind: "crawler",
      status: "waiting_for_human",
      attempt: 1,
      maxAttempts: 1,
      startedAt: "2026-07-14T03:00:00.000Z",
      logPath: join(ledgerDir, "waiting.log"),
      logTail: "Workflow paused. run `npx libretto resume --session ses-resume-closing`.",
    });
    const resumed = createTaskRun(db, {
      taskId: "resume-closing-task",
      script: "libretto resume",
      kind: "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: "2026-07-14T03:01:00.000Z",
      logPath: join(ledgerDir, "resumed.log"),
    });
    const previous = taskRunById(db, waiting.taskRunId)!;
    const previousOwner = {
      taskId: previous.taskId,
      taskRunId: previous.taskRunId,
      session: "ses-resume-closing",
      pid: 543,
    };
    ownAutomationSession(previousOwner);
    const closing = finalizeExactOwnedAutomationSession(previousOwner, {
      async closeSession() { await blocked; },
      isExpectedDaemon() { return false; },
      signalProcessGroup() {},
      async wait() {},
      timerDeps: {
        setTimer() { return 94; },
        clearTimer() {},
      },
    });
    let cleared = 0;
    armAutomationSessionTimeout(previous.taskId, async () => {}, {
      setTimer() { return 95; },
      clearTimer() { cleared += 1; },
    });
    const transactionSql: string[] = [];
    const transactionDb = new Proxy(db, {
      get(target, property) {
        if (property === "exec") {
          return (sql: string) => {
            transactionSql.push(sql);
            return target.exec(sql);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    assert.equal(claimRunAutomationSession(transactionDb, resumed.taskRunId, {
      taskId: previous.taskId,
      taskRunId: resumed.taskRunId,
      session: "ses-resume-closing",
      pid: 543,
    }, { resumeSession: "ses-resume-closing", resumeFrom: previous }), false);
    assert.deepEqual(transactionSql, ["BEGIN", "ROLLBACK"]);
    assert.equal(taskRunById(db, waiting.taskRunId)?.status, "waiting_for_human");
    assert.equal(taskRunById(db, resumed.taskRunId)?.status, "failed");
    assert.equal(ownedAutomationSession(previous.taskId)?.taskRunId, previous.taskRunId);
    assert.equal(cleared, 0);
    db.close();
    release();
    await closing;
  } finally {
    release?.();
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("resume commit failure restores the exact owner without clearing its timer", () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "automation-resume-commit-failure-"));
  try {
    const db = openLedgerDatabase(ledgerDir);
    const waiting = createTaskRun(db, {
      taskId: "resume-commit-failure-task",
      script: "libretto run",
      kind: "crawler",
      status: "waiting_for_human",
      attempt: 1,
      maxAttempts: 1,
      startedAt: "2026-07-14T04:00:00.000Z",
      logPath: join(ledgerDir, "waiting.log"),
      logTail: "Workflow paused. run `npx libretto resume --session ses-resume-commit-failure`.",
    });
    const resumed = createTaskRun(db, {
      taskId: "resume-commit-failure-task",
      script: "libretto resume",
      kind: "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: "2026-07-14T04:01:00.000Z",
      logPath: join(ledgerDir, "resumed.log"),
    });
    const previous = taskRunById(db, waiting.taskRunId)!;
    const previousOwner = {
      taskId: previous.taskId,
      taskRunId: previous.taskRunId,
      session: "ses-resume-commit-failure",
      pid: 654,
    };
    ownAutomationSession(previousOwner);
    let cleared = 0;
    armAutomationSessionTimeout(previous.taskId, async () => {}, {
      setTimer() { return 96; },
      clearTimer() { cleared += 1; },
    });
    const transactionSql: string[] = [];
    const transactionDb = new Proxy(db, {
      get(target, property) {
        if (property === "exec") {
          return (sql: string) => {
            transactionSql.push(sql);
            if (sql === "COMMIT") throw new Error("commit failed");
            return target.exec(sql);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    assert.equal(claimRunAutomationSession(transactionDb, resumed.taskRunId, {
      taskId: previous.taskId,
      taskRunId: resumed.taskRunId,
      session: "ses-resume-commit-failure",
      pid: 654,
    }, { resumeSession: "ses-resume-commit-failure", resumeFrom: previous }), false);
    assert.deepEqual(transactionSql, ["BEGIN", "COMMIT", "ROLLBACK"]);
    assert.equal(taskRunById(db, waiting.taskRunId)?.status, "waiting_for_human");
    assert.equal(taskRunById(db, resumed.taskRunId)?.status, "failed");
    assert.equal(ownedAutomationSession(previous.taskId)?.taskRunId, previous.taskRunId);
    assert.equal(cleared, 0);
    db.close();
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("shutdown continues persisted recovery after in-memory cleanup failure", async () => {
  const calls: string[] = [];
  await assert.rejects(
    shutdownAutomationSessions("unused", {
      async finalizeOwnedSessions() {
        calls.push("memory");
        throw new AggregateError([], "memory failed");
      },
      async finalizePersistedRuns() { calls.push("persisted"); },
    }),
    AggregateError,
  );
  assert.deepEqual(calls, ["memory", "persisted"]);
});

test("scheduled exchange-rate starts append schedule context only to that task", async () => {
  const root = mkdtempSync(join(tmpdir(), "automation-scheduled-run-"));
  const ledgerDir = join(root, "ledger");
  const capturePath = join(root, "capture.json");
  const script = `import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.CAPTURE_PATH, JSON.stringify(process.argv.slice(2)));\n`;
  const oldEnv = {
    OCTOPUSBEAK_DESKTOP: process.env.OCTOPUSBEAK_DESKTOP,
    OCTOPUSBEAK_APP_ROOT: process.env.OCTOPUSBEAK_APP_ROOT,
    OCTOPUSBEAK_NODE_PATH: process.env.OCTOPUSBEAK_NODE_PATH,
    CAPTURE_PATH: process.env.CAPTURE_PATH,
    PATH: process.env.PATH,
  };
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "src", "ledger"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "src", "ledger", "sync-exchange-rates.ts"), script);
  writeFileSync(join(root, "src", "ledger", "import-downloads-csv.ts"), script);
  writeFileSync(join(root, "scripts", "patch-libretto-run-cdp.mjs"), "");
  const fakeNpm = join(root, "bin", "npm");
  writeFileSync(fakeNpm, `#!/usr/bin/env node\n${script}`);
  chmodSync(fakeNpm, 0o755);
  process.env.OCTOPUSBEAK_DESKTOP = "1";
  process.env.OCTOPUSBEAK_APP_ROOT = root;
  process.env.OCTOPUSBEAK_NODE_PATH = process.execPath;
  process.env.CAPTURE_PATH = capturePath;

  const waitForCapture = async () => {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      try {
        return JSON.parse(readFileSync(capturePath, "utf8"));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    throw new Error("Timed out waiting for automation command capture");
  };
  const waitForIdle = async (taskId: string) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!hasActiveAutomationTask()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${taskId} to finish`);
  };
  try {
    startAutomationTask("exchange-rates", ledgerDir, {
      scheduledAtUtc: "2026-07-14T22:00:00.000Z",
    });
    assert.deepEqual(await waitForCapture(), [
      "--scheduled-at-utc",
      "2026-07-14T22:00:00.000Z",
    ]);
    await waitForIdle("exchange-rates");
    const db = openLedgerDatabase(ledgerDir);
    assert.equal(
      latestTaskRuns(db)["exchange-rates"]?.script,
      "run:exchange-rates --scheduled-at-utc 2026-07-14T22:00:00.000Z",
    );
    db.close();

    rmSync(capturePath);
    delete process.env.OCTOPUSBEAK_DESKTOP;
    process.env.PATH = `${join(root, "bin")}:${oldEnv.PATH ?? ""}`;
    startAutomationTask("exchange-rates", ledgerDir, {
      scheduledAtUtc: "2026-07-14T22:00:00.000Z",
    });
    assert.deepEqual(await waitForCapture(), [
      "run",
      "run:exchange-rates",
      "--",
      "--scheduled-at-utc",
      "2026-07-14T22:00:00.000Z",
    ]);
    await waitForIdle("exchange-rates");

    rmSync(capturePath);
    process.env.OCTOPUSBEAK_DESKTOP = "1";
    process.env.PATH = oldEnv.PATH;
    startAutomationTask("exchange-rates", ledgerDir);
    assert.deepEqual(await waitForCapture(), []);
    await waitForIdle("exchange-rates");

    rmSync(capturePath);
    startAutomationTask("import-downloads-csv", ledgerDir, {
      scheduledAtUtc: "2026-07-14T22:00:00.000Z",
    });
    assert.deepEqual(await waitForCapture(), []);
    await waitForIdle("import-downloads-csv");
    assert.throws(
      () => startAutomationTask("exchange-rates", ledgerDir, { scheduledAtUtc: "tomorrow" }),
      /Invalid scheduledAtUtc/,
    );
  } finally {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
