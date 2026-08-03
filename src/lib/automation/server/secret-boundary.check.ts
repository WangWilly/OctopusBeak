import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import {
  appendLog,
  automationCleanupFailureDetails,
} from "./automation-session-disposition.ts";
import { accumulateAutomationOutput } from "./task-run-execution.ts";
import { finalFailureMessage } from "./task-run-finalization.ts";
import {
  createAutomationSecretBoundaryGate,
  createSecretBoundaryGate,
} from "./secret-boundary.ts";
import {
  createTaskRun,
  latestTaskRuns,
  recentTaskRuns,
  updateTaskRun,
} from "./store.ts";
import {
  logLibrettoRunCdpPatchOutput,
  runAutomationTask,
} from "./runner.ts";
import { AUTOMATION_SECRET_KEYS } from "./tasks.ts";

test("secret gate redacts a runtime canary and reports only its surface and reason", () => {
  const canary = `runtime-canary-${randomUUID()}`;
  const reports: unknown[] = [];
  const gate = createSecretBoundaryGate({
    secretValues: [canary],
    report: (failure) => reports.push(failure),
  });

  const protectedText = gate.protectText(
    "stdout",
    `provider failed with ${canary}`,
  );

  assert.equal(protectedText.value.includes(canary), false);
  assert.deepEqual(protectedText.failure, {
    surface: "stdout",
    reason: "authentication-secret-detected",
  });
  assert.deepEqual(reports, [protectedText.failure]);
  assert.equal(JSON.stringify({ protectedText, reports }).includes(canary), false);
});

test("text protection fails closed when redaction or assertion is unavailable", () => {
  const canary = `runtime-canary-${randomUUID()}`;
  for (const [dependency, reason] of [
    ["redactionPolicy", "redaction-policy-unavailable"],
    ["assertionGate", "assertion-gate-unavailable"],
  ] as const) {
    const gate = createSecretBoundaryGate({
      secretValues: [canary],
      dependencies: { [dependency]: null },
    });

    assert.throws(
      () => gate.protectText("stderr", `provider failed with ${canary}`),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(canary), false);
        assert.equal(
          error.message,
          `SECRET_BOUNDARY_GATE_UNAVAILABLE surface=stderr reason=${reason}`,
        );
        return true;
      },
    );
  }
});

test("record protection enforces its schema allowlist before returning persistence data", () => {
  const canary = `runtime-canary-${randomUUID()}`;
  const gate = createSecretBoundaryGate({
    secretValues: [canary],
    dependencies: {
      schemaAllowlist: {
        "test-task-run": ["taskRunId", "logTail"],
      },
    },
  });

  const protectedRecord = gate.protectRecord(
    "sqlite-persistence",
    "test-task-run",
    { taskRunId: "run-1", logTail: `failed with ${canary}` },
  );
  assert.equal(JSON.stringify(protectedRecord).includes(canary), false);
  assert.deepEqual(protectedRecord.failure, {
    surface: "sqlite-persistence",
    reason: "authentication-secret-detected",
  });

  assert.throws(
    () => gate.protectRecord(
      "sqlite-persistence",
      "test-task-run",
      { taskRunId: "run-1", logTail: "failed", [canary]: "value" },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(canary), false);
      assert.equal(
        error.message,
        "SECRET_BOUNDARY_SCHEMA_REJECTED surface=sqlite-persistence reason=field-not-allowlisted",
      );
      return true;
    },
  );

  const unavailableGate = createSecretBoundaryGate({
    secretValues: [canary],
    dependencies: { schemaAllowlist: null },
  });
  assert.throws(
    () => unavailableGate.protectRecord(
      "diagnostic-export",
      "test-task-run",
      { taskRunId: "run-1" },
    ),
    /SECRET_BOUNDARY_GATE_UNAVAILABLE surface=diagnostic-export reason=schema-allowlist-unavailable/,
  );
});

test("stdout accumulation protects chunks and tails before projecting a boundary failure", () => {
  const canary = `runtime-canary-${randomUUID()}`;
  const gate = createSecretBoundaryGate({ secretValues: [canary] });

  const output = accumulateAutomationOutput(
    { logTail: "", resumeFailure: null },
    `provider failed with ${canary}\n`,
    gate,
    "stdout",
  );

  assert.equal(JSON.stringify(output).includes(canary), false);
  assert.deepEqual(output.secretBoundaryFailure, {
    surface: "stdout",
    reason: "authentication-secret-detected",
  });
});

test("stdout accumulation holds a possible secret prefix across chunks", () => {
  const canary = `runtime-canary-${randomUUID()}`;
  const splitAt = Math.floor(canary.length / 2);
  const gate = createSecretBoundaryGate({ secretValues: [canary] });

  const first = accumulateAutomationOutput(
    { logTail: "", resumeFailure: null },
    `provider failed with ${canary.slice(0, splitAt)}`,
    gate,
    "stdout",
  );
  const second = accumulateAutomationOutput(
    { logTail: first.logTail, resumeFailure: first.resumeFailure },
    `${canary.slice(splitAt)}\n`,
    gate,
    "stdout",
  );

  assert.equal(JSON.stringify({ first, second }).includes(canary), false);
  assert.deepEqual(second.secretBoundaryFailure, {
    surface: "stdout",
    reason: "authentication-secret-detected",
  });
});

test("final failure and cleanup diagnostics share the secret gate contract", () => {
  const canary = `runtime-canary-${randomUUID()}`;
  const reports: unknown[] = [];
  const gate = createSecretBoundaryGate({
    secretValues: [canary],
    report: (failure) => reports.push(failure),
  });

  const finalFailure = finalFailureMessage(
    `provider failed with ${canary}`,
    1,
    gate,
  );
  const cleanupFailure = automationCleanupFailureDetails(
    {
      taskId: "audit-task",
      taskRunId: "audit-run",
      session: "audit-session",
      pid: 123,
    },
    new Error(`cleanup failed with ${canary}`),
    gate,
  );

  assert.equal(JSON.stringify({ finalFailure, cleanupFailure }).includes(canary), false);
  assert.deepEqual(reports, [
    {
      surface: "final-failure",
      reason: "authentication-secret-detected",
    },
    {
      surface: "cleanup-error",
      reason: "authentication-secret-detected",
    },
  ]);
});

test("filesystem, SQLite, and diagnostic export persistence share one fail-closed gate", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-secret-persistence-"));
  const logPath = join(root, "automation.log");
  const canary = `runtime-canary-${randomUUID()}`;
  const gate = createAutomationSecretBoundaryGate({
    secretValues: [canary],
  });
  try {
    assert.throws(
      () => appendLog(logPath, `provider failed with ${canary}\n`, gate),
      /SECRET_BOUNDARY_VIOLATION surface=filesystem-log reason=authentication-secret-detected$/,
    );
    assert.equal(existsSync(logPath), false);

    const db = openLedgerDatabase(join(root, "ledger"));
    const run = createTaskRun(db, {
      taskId: "audit-task",
      script: "run:audit-task",
      kind: "sync",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: "2026-08-03T00:00:00.000Z",
      logPath,
      logTail: "safe log tail",
    }, gate);
    assert.throws(
      () => updateTaskRun(db, run.taskRunId, {
        status: "failed",
        finishedAt: "2026-08-03T00:00:01.000Z",
        errorMessage: `failure projected ${canary}`,
      }, gate),
      /SECRET_BOUNDARY_VIOLATION surface=sqlite-persistence reason=authentication-secret-detected$/,
    );

    const rawRow = db.prepare(
      "SELECT error_message, log_tail, record_json FROM automation_task_runs WHERE task_run_id = ?",
    ).get(run.taskRunId);
    assert.equal(JSON.stringify(rawRow).includes(canary), false);
    assert.equal(JSON.stringify(recentTaskRuns(db, 1, gate)).includes(canary), false);
    db.prepare(`
      UPDATE automation_task_runs
      SET error_message = ?, log_tail = ?, record_json = ?
      WHERE task_run_id = ?
    `).run(canary, canary, JSON.stringify({ errorMessage: canary }), run.taskRunId);
    assert.throws(
      () => recentTaskRuns(db, 1, gate),
      /SECRET_BOUNDARY_VIOLATION surface=diagnostic-export reason=authentication-secret-detected$/,
    );
    assert.throws(
      () => latestTaskRuns(db, gate),
      /SECRET_BOUNDARY_VIOLATION surface=diagnostic-export reason=authentication-secret-detected$/,
    );
    db.close();

    const unavailableGate = createAutomationSecretBoundaryGate({
      secretValues: [canary],
      dependencies: { schemaAllowlist: null },
    });
    const unavailableDb = openLedgerDatabase(join(root, "unavailable-ledger"));
    assert.throws(
      () => createTaskRun(unavailableDb, {
        taskId: "rejected-task",
        script: "run:rejected-task",
        kind: "sync",
        status: "running",
        attempt: 1,
        maxAttempts: 1,
        startedAt: "2026-08-03T00:00:00.000Z",
        logPath: join(root, "rejected.log"),
      }, unavailableGate),
      /SECRET_BOUNDARY_GATE_UNAVAILABLE surface=sqlite-persistence reason=schema-allowlist-unavailable/,
    );
    assert.equal(
      (unavailableDb.prepare("SELECT count(*) count FROM automation_task_runs").get() as {
        count: number;
      }).count,
      0,
    );
    assert.throws(
      () => recentTaskRuns(unavailableDb, 1, unavailableGate),
      /SECRET_BOUNDARY_GATE_UNAVAILABLE surface=diagnostic-export reason=schema-allowlist-unavailable/,
    );
    assert.throws(
      () => latestTaskRuns(unavailableDb, unavailableGate),
      /SECRET_BOUNDARY_GATE_UNAVAILABLE surface=diagnostic-export reason=schema-allowlist-unavailable/,
    );
    unavailableDb.close();
    assert.equal(existsSync(join(root, "rejected.log")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("record protection redacts secrets before JSON escaping", () => {
  const canary = `runtime-"${randomUUID()}\\line\nbreak`;
  const gate = createAutomationSecretBoundaryGate({
    secretValues: [canary],
  });

  const protectedRecord = gate.protectRecord(
    "sqlite-persistence",
    "automation-task-run",
    {
      taskRunId: "escaped-run",
      taskId: "escaped-task",
      script: "run:escaped-task",
      kind: "sync",
      status: "failed",
      attempt: 1,
      maxAttempts: 1,
      startedAt: "2026-08-03T00:00:00.000Z",
      logPath: "escaped.log",
      logTail: canary,
    },
  );

  assert.equal(JSON.stringify(protectedRecord).includes(canary), false);
  assert.deepEqual(protectedRecord.failure, {
    surface: "sqlite-persistence",
    reason: "authentication-secret-detected",
  });
});

test("patch stdout and stderr diagnostics are redacted before deterministic failure", () => {
  const canary = `runtime-canary-${randomUUID()}`;
  const gate = createAutomationSecretBoundaryGate({
    secretValues: [canary],
  });
  const diagnostics: string[] = [];

  assert.throws(
    () => logLibrettoRunCdpPatchOutput(
      { stdout: `patch stdout ${canary}`, stderr: `patch stderr ${canary}` },
      gate,
      {
        info: (value) => diagnostics.push(String(value)),
        warn: (value) => diagnostics.push(String(value)),
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(canary), false);
      assert.equal(
        error.message,
        "SECRET_BOUNDARY_VIOLATION surface=patch-stdout reason=authentication-secret-detected",
      );
      return true;
    },
  );
  assert.equal(JSON.stringify(diagnostics).includes(canary), false);
});

test("patch diagnostics include environment-only Authentication secrets in the default gate", () => {
  const canary = `runtime-canary-${randomUUID()}`;
  const secretKey = AUTOMATION_SECRET_KEYS[0];
  const previousSecret = process.env[secretKey];
  const diagnostics: string[] = [];
  try {
    process.env[secretKey] = canary;
    assert.throws(
      () => logLibrettoRunCdpPatchOutput(
        { stdout: `patch stdout ${canary}` },
        undefined,
        {
          info: (value) => diagnostics.push(String(value)),
          warn: (value) => diagnostics.push(String(value)),
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(canary), false);
        assert.equal(
          error.message,
          "SECRET_BOUNDARY_VIOLATION surface=patch-stdout reason=authentication-secret-detected",
        );
        return true;
      },
    );
    assert.equal(JSON.stringify(diagnostics).includes(canary), false);
  } finally {
    if (previousSecret === undefined) delete process.env[secretKey];
    else process.env[secretKey] = previousSecret;
  }
});

test("runtime canary stdout fails safely without reaching logs, SQLite, or error projection", async () => {
  const root = mkdtempSync(join(tmpdir(), "automation-runtime-canary-"));
  const ledgerDir = join(root, "ledger");
  const binDir = join(root, "bin");
  const canary = `runtime-canary-${randomUUID()}`;
  const previousCwd = process.cwd();
  const previousPath = process.env.PATH;
  const messages: unknown[][] = [];
  const previousConsoleError = console.error;
  const credentialKey = "MAX_SECRET_KEY";
  assert.ok(AUTOMATION_SECRET_KEYS.includes(credentialKey));
  try {
    mkdirSync(binDir);
    writeFileSync(
      join(root, "credentials.json"),
      JSON.stringify({ [credentialKey]: canary }),
      { mode: 0o600 },
    );
    const npmPath = join(binDir, "npm");
    writeFileSync(
      npmPath,
      "#!/bin/sh\nprintf 'provider failed with %s\\n' \"$MAX_SECRET_KEY\"\n",
    );
    chmodSync(npmPath, 0o755);
    process.chdir(root);
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    console.error = (...args: unknown[]) => { messages.push(args); };

    assert.deepEqual(
      await runAutomationTask("sync-maicoin", ledgerDir),
      { status: "failed" },
    );

    const db = openLedgerDatabase(ledgerDir, { readOnly: true });
    const rawRow = db.prepare(
      "SELECT error_message, log_path, log_tail, record_json FROM automation_task_runs",
    ).get() as {
      error_message: string;
      log_path: string;
      log_tail: string;
      record_json: string;
    };
    const log = readFileSync(join(root, rawRow.log_path), "utf8");
    assert.equal(
      rawRow.error_message ===
        "SECRET_BOUNDARY_VIOLATION surface=stdout reason=authentication-secret-detected",
      true,
    );
    assert.equal(
      JSON.stringify({ rawRow, log, messages }).includes(canary),
      false,
    );
    db.close();
  } finally {
    console.error = previousConsoleError;
    process.chdir(previousCwd);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  }
});
