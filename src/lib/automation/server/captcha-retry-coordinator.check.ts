import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import {
  createTaskRun,
  taskRunById,
  updateHumanAssistanceContract,
} from "./store.ts";
import {
  runCaptchaRetryCampaign,
} from "./captcha-retry-coordinator.ts";
import {
  routeWaitingRunVerification,
  type VerificationRoutingOutcome,
} from "./verification-routing.ts";
import { createProviderVerificationHost } from "./provider-verification.ts";
import type { HumanAssistanceContract } from "../human-assistance.ts";
import {
  SINOPAC_DIALOG_OWNER_ENV,
  sinopacHostDialogOwner,
} from "../sinopac-captcha.ts";
import {
  YUANTA_DIALOG_OWNER_ENV,
  yuantaHostDialogOwner,
} from "../yuanta-captcha.ts";

function yuantaBankCaptchaContract(): HumanAssistanceContract {
  return {
    schemaVersion: 1,
    version: 1,
    stageId: "yuanta-bank-login-captcha",
    title: "Enter the YuanTa Bank CAPTCHA",
    targets: [{
      id: "captcha-input",
      label: "CAPTCHA input",
      semanticId: "yuanta-bank.login.captcha-input",
      modes: ["click", "type"],
      rect: { x: 10, y: 20, width: 100, height: 24 },
    }],
    contextRegions: [],
    challengeKind: "text-captcha",
    charset: "digits",
    expectedAnswerLength: 6,
    challengeImageRegion: {
      id: "captcha-image",
      label: "CAPTCHA image",
      semanticId: "yuanta-bank.login.captcha-image",
      rect: { x: 0, y: 0, width: 100, height: 40 },
    },
    completion: {
      mode: "inline",
      targetIds: ["captcha-input"],
      status: "pending",
    },
    focus: { targetId: "captcha-input", contextRegionIds: [] },
  };
}

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
  const routedSessions: Array<string | null> = [];
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
          session: `ses-round-${executions}`,
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
        routedSessions.push(input.session ?? null);
        await input.onChallengeCaptured?.();
        return { kind: "retryable" as const, reason: "solver-exhausted" as const };
      },
    });

    assert.deepEqual(result, { status: "failed" });
    assert.equal(executions, 10);
    assert.equal(routes, 10);
    assert.deepEqual(routedSessions, [
      "ses-round-1",
      "ses-round-2",
      "ses-round-3",
      "ses-round-4",
      "ses-round-5",
      "ses-round-6",
      "ses-round-7",
      "ses-round-8",
      "ses-round-9",
      "ses-round-10",
    ]);
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

test("CAPTCHA coordinator restarts after a provider-proven rejection", async () => {
  const root = mkdtempSync(join(tmpdir(), "captcha-retry-coordinator-provider-rejection-"));
  const ledgerDir = join(root, "ledger");
  const logPath = join(root, "automation.log");
  mkdirSync(ledgerDir, { recursive: true });
  const db = openLedgerDatabase(ledgerDir);
  const run = createTaskRun(db, {
    taskId: "coordinator-provider-rejection-test",
    script: "coordinator-provider-rejection-test",
    kind: "crawler",
    status: "waiting_for_human",
    attempt: 1,
    maxAttempts: 10,
    startedAt: new Date().toISOString(),
    logPath,
  });
  let executions = 0;
  try {
    const result = await runCaptchaRetryCampaign({
      taskId: "coordinator-provider-rejection-test",
      taskDb: db,
      ledgerDir,
      launchVerificationSettings: {},
      initialExecutionOptions: {},
      execute: async () => {
        executions += 1;
        return {
          status: "waiting_for_human" as const,
          taskRunId: run.taskRunId,
          executionId: `execution-provider-rejection-${executions}`,
          session: `ses-provider-rejection-${executions}`,
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
        await input.onChallengeCaptured?.();
        if (executions === 1) {
          return { kind: "retryable" as const, reason: "provider-rejected" as const };
        }
        return { kind: "resumed" as const };
      },
    });
    assert.deepEqual(result, { status: "waiting_for_human" });
    assert.equal(executions, 2);
    assert.equal(taskRunById(db, run.taskRunId)?.attempt, 2);
    assert.equal(taskRunById(db, run.taskRunId)?.maxAttempts, 10);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("CAPTCHA coordinator cleans and joins a blocked resume before a fresh round", async () => {
  const root = mkdtempSync(join(tmpdir(), "captcha-retry-coordinator-join-resume-"));
  const ledgerDir = join(root, "ledger");
  const logPath = join(root, "automation.log");
  mkdirSync(ledgerDir, { recursive: true });
  const db = openLedgerDatabase(ledgerDir);
  const run = createTaskRun(db, {
    taskId: "coordinator-join-resume-test",
    script: "coordinator-join-resume-test",
    kind: "crawler",
    status: "waiting_for_human",
    attempt: 1,
    maxAttempts: 10,
    startedAt: new Date().toISOString(),
    logPath,
  });
  const events: string[] = [];
  let executions = 0;
  let releaseResume!: () => void;
  try {
    const result = await runCaptchaRetryCampaign({
      taskId: "coordinator-join-resume-test",
      taskDb: db,
      ledgerDir,
      launchVerificationSettings: {},
      initialExecutionOptions: {},
      execute: async (options) => {
        executions += 1;
        if (options.resumeSession) {
          assert.equal(
            options.launchEnv?.[SINOPAC_DIALOG_OWNER_ENV],
            sinopacHostDialogOwner(options.resumeSession),
          );
          assert.equal(
            options.launchEnv?.[YUANTA_DIALOG_OWNER_ENV],
            yuantaHostDialogOwner(options.resumeSession),
          );
          events.push("resume-started");
          await new Promise<void>((resolve) => {
            releaseResume = resolve;
          });
          events.push("resume-settled");
          return { status: "failed" as const };
        }
        if (executions > 2) events.push("fresh-round-started");
        return {
          status: "waiting_for_human" as const,
          taskRunId: run.taskRunId,
          executionId: `execution-join-${executions}`,
          session: `ses-join-${executions}`,
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
      finalizeSessionForRun: async () => {
        events.push("session-cleaned");
        releaseResume();
        return {
          session: "ses-join-1",
          pid: null,
          errorMessage: null,
          cleanupFailed: false,
        };
      },
      isCancellationRequested: () => false,
      routeWaitingRunVerification: async (input) => {
        await input.onChallengeCaptured?.();
        if (executions === 1) {
          void input.scheduleResume("ses-join-1");
          return { kind: "retryable" as const, reason: "provider-rejected" as const };
        }
        return { kind: "resumed" as const };
      },
    });
    assert.deepEqual(result, { status: "waiting_for_human" });
    assert.deepEqual(events, [
      "resume-started",
      "session-cleaned",
      "resume-settled",
      "fresh-round-started",
    ]);
    assert.equal(executions, 3);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Yuanta observed CAPTCHA alert travels through provider probe, routing, and the next campaign round", async () => {
  const root = mkdtempSync(join(tmpdir(), "captcha-retry-coordinator-yuanta-provider-alert-"));
  const ledgerDir = join(root, "ledger");
  const logPath = join(root, "automation.log");
  mkdirSync(ledgerDir, { recursive: true });
  const db = openLedgerDatabase(ledgerDir);
  const run = createTaskRun(db, {
    taskId: "yuanta-all-statements",
    script: "run:yuanta-all-statements",
    kind: "crawler",
    status: "waiting_for_human",
    attempt: 1,
    maxAttempts: 10,
    startedAt: new Date().toISOString(),
    logPath,
  });
  updateHumanAssistanceContract(db, run.taskRunId, yuantaBankCaptchaContract());

  const dialogs = new EventEmitter();
  const events: string[] = [];
  const host = (await import("./provider-verification.ts")).createProviderVerificationHost({
    withPage: async (_session, action) => action({
      onDialog: (handler: (dialog: { type: () => string; message: () => string; dismiss: () => Promise<void> }) => void) => {
        dialogs.on("dialog", handler);
      },
      offDialog: (handler: (dialog: { type: () => string; message: () => string; dismiss: () => Promise<void> }) => void) => {
        dialogs.off("dialog", handler);
      },
    } as never),
    sleep: async () => {},
  });
  const providerVerification = {
    handlesChallengeImage: () => true,
    captureChallengeImage: async () => Buffer.from("yuanta-captcha"),
    isChallengeImageCurrent: async () => true,
  };
  let executions = 0;
  let routeCalls = 0;
  let releaseResume!: () => void;
  let firstOutcome: VerificationRoutingOutcome | null = null;
  try {
    const result = await runCaptchaRetryCampaign({
      taskId: "yuanta-all-statements",
      taskDb: db,
      ledgerDir,
      launchVerificationSettings: {},
      initialExecutionOptions: {},
      execute: async (options) => {
        executions += 1;
        if (options.resumeSession) {
          events.push("resume-started");
          const resumeBlocked = new Promise<void>((resolve) => {
            releaseResume = resolve;
          });
          dialogs.emit("dialog", {
            type: () => "alert",
            message: () => "驗證碼不正確，請重新輸入",
            dismiss: async () => { events.push("dismissed"); },
          });
          await resumeBlocked;
          events.push("resume-settled");
          return { status: "failed" as const };
        }
        events.push(executions === 1 ? "initial-round" : "fresh-round");
        return {
          status: "waiting_for_human" as const,
          taskRunId: run.taskRunId,
          executionId: `execution-yuanta-${executions}`,
          session: `ses-yuanta-${executions}`,
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
      finalizeSessionForRun: async () => {
        events.push("cleanup");
        releaseResume();
        return {
          session: "ses-yuanta-1",
          pid: null,
          errorMessage: null,
          cleanupFailed: false,
        };
      },
      routeWaitingRunVerification: async (input) => {
        routeCalls += 1;
        if (routeCalls > 1) {
          await input.onChallengeCaptured?.();
          events.push("fresh-round-routed");
          return { kind: "resumed" as const };
        }
        const outcome = await routeWaitingRunVerification({
          ...input,
          solver: {
            async solve() {
              return { answer: "123456", confidence: 0.99 };
            },
          },
          providerVerification,
          providerInjectAnswer: async (_session, _contract, answer) => {
            events.push(`answer-injected:${answer}`);
          },
          providerProbePostSubmit: host.probePostSubmit,
          settings: { LIBRETTO_CLOUD_YUANTA_VERIFICATION_ACTOR: "solver" },
        });
        firstOutcome = outcome;
        return outcome;
      },
    });
    assert.deepEqual(firstOutcome, { kind: "retryable", reason: "provider-rejected" });
    assert.deepEqual(result, { status: "waiting_for_human" });
    assert.equal(executions, 3);
    assert.equal(routeCalls, 2);
    assert.deepEqual(events, [
      "initial-round",
      "answer-injected:123456",
      "resume-started",
      "dismissed",
      "cleanup",
      "resume-settled",
      "fresh-round",
      "fresh-round-routed",
    ]);
    assert.equal(taskRunById(db, run.taskRunId)?.attempt, 2);
    assert.equal(taskRunById(db, run.taskRunId)?.maxAttempts, 10);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
