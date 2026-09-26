import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import test from "node:test";
import type { HumanAssistanceContractInput } from "../human-assistance.ts";
import {
  applyPgliteOperationalBaseline,
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import { createAppWorkflowHumanAssistancePort } from "./app-workflow-human-assistance.ts";
import { runCaptchaRetryCampaign } from "./captcha-retry-coordinator.ts";
import { routeWaitingRunVerification } from "./verification-routing.ts";
import type { AutomationSettingsFile } from "./config-files.ts";
import type { AutomationTaskExecutionOptions } from "./task-run-execution.ts";

const sinopacContract: HumanAssistanceContractInput = {
  stageId: "sinopac-login-captcha",
  title: "Enter the SinoPac CAPTCHA",
  targets: [{
    id: "captcha-input",
    label: "CAPTCHA input",
    semanticId: "sinopac.login.captcha-input",
    modes: ["click", "type"],
    rect: { x: 1, y: 1, width: 10, height: 10 },
  }],
  contextRegions: [],
  challengeKind: "text-captcha",
  charset: "digits",
  expectedAnswerLength: 6,
  challengeImageRegion: {
    id: "captcha-image",
    label: "CAPTCHA image",
    semanticId: "sinopac.login.captcha-image",
    rect: { x: 1, y: 1, width: 10, height: 10 },
  },
  completion: { mode: "inline", targetIds: ["captcha-input"] },
  focus: { targetId: "captcha-input", contextRegionIds: [] },
};

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Timed out waiting for App workflow test state.");
}

test("App SinoPac CAPTCHA route keeps one run and retries solver exhaustion and rejection", async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), "sinopac-app-captcha-"));
  const originalCwd = process.cwd();
  const store = new PGliteStore(await PGlite.create());
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const created = await provider.automation.createTaskRun({
      taskId: "sinopac-statements",
      kind: "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
    });
    const settings: AutomationSettingsFile = {
      LIBRETTO_CLOUD_SINOPAC_VERIFICATION_ACTOR: "solver",
      VERIFICATION_TEXT_CAPTCHA_CONFIDENCE_THRESHOLD: "0.9",
    };
    process.chdir(artifactRoot);
    const captureSessions: string[] = [];
    const injectedAnswers: string[] = [];
    const executeAttempts: number[] = [];
    let solverCalls = 0;

    const campaign = runCaptchaRetryCampaign({
      taskId: "sinopac-statements",
      appWorkflow: true,
      provider,
      launchVerificationSettings: settings,
      initialExecutionOptions: { taskRunId: created.taskRunId },
      isCancellationRequested: () => false,
      routeWaitingRunVerification: (input) => routeWaitingRunVerification({
        ...input,
        solver: {
          async solve() {
            solverCalls += 1;
            return {
              answer: "123456",
              confidence: solverCalls <= 3 ? 0.1 : 0.99,
            };
          },
        },
        providerVerification: {
          handlesChallengeImage: () => true,
          async captureChallengeImage(session) {
            captureSessions.push(session);
            return Buffer.from("mock captcha image");
          },
          async isChallengeImageCurrent() { return true; },
        },
        injectAnswer: async (session, _contract, answer) => {
          assert.equal(session, created.taskRunId);
          injectedAnswers.push(answer);
        },
      }),
      async execute(options: AutomationTaskExecutionOptions) {
        const attempt = options.attempt ?? 1;
        executeAttempts.push(attempt);
        const controller = new AbortController();
        const assistance = createAppWorkflowHumanAssistancePort({
          taskRunId: created.taskRunId,
          persistence: provider.automation,
        });
        try {
          await assistance.request(sinopacContract, controller.signal);
        } catch {
          assert.equal(attempt, 1, "only solver exhaustion rejects the pending stage");
          return {
            status: "failed" as const,
            taskRunId: created.taskRunId,
            executionId: options.executionId!,
            session: null,
            owner: null,
            result: {
              exitCode: 1,
              signal: null,
              error: new Error("Solver exhausted"),
              resumeFailure: null,
              statementSummary: null,
              outputPersistenceWarnings: [],
              externalPrerequisiteIds: [],
            },
          };
        }
        const rejected = attempt === 2;
        await provider.automation.appendRunEvent({
          runId: created.taskRunId,
          stage: "authentication",
          code: rejected ? "captcha-rejected" : "authentication-completed",
          occurredAt: new Date().toISOString(),
        });
        const processResult = {
          exitCode: rejected ? 1 : 0,
          signal: null,
          error: rejected ? new Error("App workflow failed (workflow-failed).") : null,
          resumeFailure: null,
          statementSummary: null,
          outputPersistenceWarnings: [],
          externalPrerequisiteIds: [],
        };
        return {
          status: rejected ? "failed" as const : "completed" as const,
          taskRunId: created.taskRunId,
          executionId: options.executionId!,
          session: null,
          owner: null,
          result: processResult,
        };
      },
    });

    assert.deepEqual(await campaign, { status: "completed" });
    assert.deepEqual(executeAttempts, [1, 2, 3]);
    assert.equal(captureSessions.length, 5);
    assert.deepEqual(captureSessions, Array.from({ length: 5 }, () => created.taskRunId));
    assert.deepEqual(injectedAnswers, ["123456", "123456"]);
    const finalRun = await provider.automation.taskRunById(created.taskRunId);
    assert.equal(finalRun?.status, "completed");
    assert.equal(finalRun?.attempt, 3);
    assert.equal(Object.hasOwn(finalRun ?? {}, "logPath"), false);
    assert.equal(Object.hasOwn(finalRun ?? {}, "logTail"), false);
    assert.ok(finalRun?.events.some((event) => event.code === "captcha-rejected"));
    assert.ok(finalRun?.events.some((event) => event.code === "authentication-completed"));
    assert.deepEqual(await readdir(artifactRoot), [], "typed retry writes no CLI log, assistance JSONL, source, or output files");
  } finally {
    process.chdir(originalCwd);
    await store.close();
    await rm(artifactRoot, { recursive: true, force: true });
  }
});

test("App SinoPac CAPTCHA assistance aborts its route when the live run is cancelled", async () => {
  const store = new PGliteStore(await PGlite.create());
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const created = await provider.automation.createTaskRun({
      taskId: "sinopac-statements",
      kind: "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
    });
    const settings: AutomationSettingsFile = {
      LIBRETTO_CLOUD_SINOPAC_VERIFICATION_ACTOR: "human",
    };
    const controller = new AbortController();
    let cancelled = false;
    const campaign = runCaptchaRetryCampaign({
      taskId: "sinopac-statements",
      appWorkflow: true,
      provider,
      launchVerificationSettings: settings,
      initialExecutionOptions: { taskRunId: created.taskRunId },
      isCancellationRequested: () => cancelled,
      async execute(options: AutomationTaskExecutionOptions) {
        const assistance = createAppWorkflowHumanAssistancePort({
          taskRunId: created.taskRunId,
          persistence: provider.automation,
        });
        try {
          await assistance.request(sinopacContract, controller.signal);
          throw new Error("Cancellation did not interrupt human assistance.");
        } catch {
          return {
            status: "cancelled" as const,
            taskRunId: created.taskRunId,
            executionId: options.executionId!,
            session: null,
            owner: null,
            result: {
              exitCode: null,
              signal: "SIGTERM",
              error: new Error("Automation task cancelled."),
              resumeFailure: null,
              statementSummary: null,
              outputPersistenceWarnings: [],
              externalPrerequisiteIds: [],
            },
          };
        }
      },
    });

    await waitFor(async () => (await provider.automation.taskRunById(created.taskRunId))?.status === "waiting_for_human");
    cancelled = true;
    controller.abort(new Error("App closed"));
    assert.deepEqual(await campaign, { status: "failed" });
    const finalRun = await provider.automation.taskRunById(created.taskRunId);
    assert.equal(finalRun?.status, "cancelled");
    assert.equal(Object.hasOwn(finalRun ?? {}, "logPath"), false);
    assert.equal(Object.hasOwn(finalRun ?? {}, "logTail"), false);
  } finally {
    await store.close();
  }
});

test("every text CAPTCHA workflow routes solver exhaustion into one bounded App retry", async () => {
  const taskIds = [
    "fubon-all-statements",
    "yuanta-all-statements",
    "hncb-statements",
    "post-statements",
    "einvoice-personal-invoices",
  ];
  for (const taskId of taskIds) {
    const store = new PGliteStore(await PGlite.create());
    const controller = new AbortController();
    try {
      await applyPgliteOperationalBaseline(store);
      const provider = createPgliteOperationalProvider(store);
      const created = await provider.automation.createTaskRun({
        taskId,
        kind: "crawler",
        status: "running",
        attempt: 1,
        maxAttempts: 1,
        startedAt: new Date().toISOString(),
      });
      const attempts: number[] = [];
      let routeCalls = 0;
      const campaign = runCaptchaRetryCampaign({
        taskId,
        appWorkflow: true,
        provider,
        launchVerificationSettings: {},
        initialExecutionOptions: { taskRunId: created.taskRunId },
        isCancellationRequested: () => false,
        routeWaitingRunVerification: async (input) => {
          routeCalls += 1;
          await input.onChallengeCaptured?.();
          return { kind: "retryable", reason: "solver-exhausted" };
        },
        async execute(options) {
          attempts.push(options.attempt ?? 1);
          if ((options.attempt ?? 1) === 1) {
            const assistance = createAppWorkflowHumanAssistancePort({
              taskRunId: created.taskRunId,
              persistence: provider.automation,
            });
            try {
              await assistance.request(sinopacContract, controller.signal);
            } catch {
              // The App route rejects the active worker stage to restart it.
            }
          }
          return {
            status: (options.attempt ?? 1) === 1 ? "failed" as const : "completed" as const,
            taskRunId: created.taskRunId,
            executionId: options.executionId!,
            result: {
              exitCode: (options.attempt ?? 1) === 1 ? 1 : 0,
              signal: null,
              error: (options.attempt ?? 1) === 1 ? new Error("Challenge rejected") : null,
              statementSummary: null,
              outputPersistenceWarnings: [],
              externalPrerequisiteIds: [],
            },
          };
        },
      });
      const result = await Promise.race([
        campaign,
        new Promise<never>((_resolve, reject) => setTimeout(
          () => reject(new Error(`${taskId} did not route its CAPTCHA`)),
          2_000,
        )),
      ]);
      assert.deepEqual(result, { status: "completed" }, taskId);
      assert.deepEqual(attempts, [1, 2], taskId);
      assert.equal(routeCalls, 1, taskId);
    } finally {
      controller.abort();
      await store.close();
    }
  }
});
