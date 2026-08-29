import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import { createTaskRun, taskRunById } from "./store.ts";
import {
  runCaptchaRetryCampaign,
} from "./captcha-retry-coordinator.ts";

test("CAPTCHA coordinator serially consumes at most ten retry rounds", async () => {
  const root = mkdtempSync(join(tmpdir(), "captcha-retry-coordinator-"));
  const ledgerDir = join(root, "ledger");
  const logPath = join(root, "automation.log");
  mkdirSync(ledgerDir, { recursive: true });
  const db = openLedgerDatabase(ledgerDir);
  const run = createTaskRun(db, {
    taskId: "coordinator-test",
    script: "coordinator-test",
    kind: "crawler",
    status: "waiting_for_human",
    attempt: 1,
    maxAttempts: 10,
    startedAt: new Date().toISOString(),
    logPath,
  });
  let executions = 0;
  let routes = 0;
  try {
    const result = await runCaptchaRetryCampaign({
      taskId: "coordinator-test",
      taskDb: db,
      ledgerDir,
      launchVerificationSettings: {},
      initialExecutionOptions: {},
      execute: async () => {
        executions += 1;
        return {
          status: "waiting_for_human" as const,
          taskRunId: run.taskRunId,
          executionId: `execution-${executions}`,
          session: null,
          owner: null,
          result: {
            exitCode: 0,
            signal: null,
            error: null,
            logTail: "",
            resumeFailure: null,
            statementSummary: null,
            outputPersistenceWarnings: [],
            externalPrerequisiteIds: [],
          },
        };
      },
      isCancellationRequested: () => false,
      routeWaitingRunVerification: async (input) => {
        routes += 1;
        await input.onChallengeCaptured?.();
        return { kind: "retryable" as const, reason: "solver-exhausted" as const };
      },
    });

    assert.deepEqual(result, { status: "failed" });
    assert.equal(executions, 10);
    assert.equal(routes, 10);
    const persisted = taskRunById(db, run.taskRunId);
    assert.equal(persisted?.status, "failed");
    assert.equal(persisted?.attempt, 10);
    assert.equal(persisted?.maxAttempts, 10);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("CAPTCHA coordinator fails closed before a second execution can submit", async () => {
  const root = mkdtempSync(join(tmpdir(), "captcha-retry-coordinator-second-capture-"));
  const ledgerDir = join(root, "ledger");
  const logPath = join(root, "automation.log");
  mkdirSync(ledgerDir, { recursive: true });
  const db = openLedgerDatabase(ledgerDir);
  const run = createTaskRun(db, {
    taskId: "coordinator-second-capture-test",
    script: "coordinator-second-capture-test",
    kind: "crawler",
    status: "waiting_for_human",
    attempt: 1,
    maxAttempts: 10,
    startedAt: new Date().toISOString(),
    logPath,
  });
  let executions = 0;
  let routes = 0;
  let submissions = 0;
  try {
    const result = await runCaptchaRetryCampaign({
      taskId: "coordinator-second-capture-test",
      taskDb: db,
      ledgerDir,
      launchVerificationSettings: {},
      initialExecutionOptions: {},
      execute: async () => {
        executions += 1;
        return {
          status: "waiting_for_human" as const,
          taskRunId: run.taskRunId,
          executionId: `execution-${executions}`,
          session: null,
          owner: null,
          result: {
            exitCode: 0,
            signal: null,
            error: null,
            logTail: "",
            resumeFailure: null,
            statementSummary: null,
            outputPersistenceWarnings: [],
            externalPrerequisiteIds: [],
          },
        };
      },
      isCancellationRequested: () => false,
      routeWaitingRunVerification: async (input) => {
        routes += 1;
        await input.onChallengeCaptured?.();
        submissions += 1;
        if (routes === 1) await input.scheduleResume("same-session");
        return { kind: "resumed" as const };
      },
    });

    assert.deepEqual(result, { status: "failed" });
    assert.equal(executions, 2);
    assert.equal(routes, 2);
    assert.equal(submissions, 1);
    assert.equal(taskRunById(db, run.taskRunId)?.status, "failed");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
