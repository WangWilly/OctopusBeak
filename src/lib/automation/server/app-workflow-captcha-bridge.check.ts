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
import { MAX_CAPTCHA_RETRY_ROUNDS } from "./captcha-retry-campaign.ts";
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

const yuantaTradeAudioContract: HumanAssistanceContractInput = {
  stageId: "yuanta-trade-audio-verification",
  title: "YuanTa Trade audio CAPTCHA",
  challengeKind: "audio-captcha",
  challengeAudioSource: {
    id: "audio-challenge",
    label: "Audio challenge",
    semanticId: "yuanta-trade.login.audio-challenge",
  },
  charset: "digits",
  expectedAnswerLength: 6,
  targets: [{
    id: "audio-code-input",
    label: "Audio answer",
    semanticId: "yuanta-trade.login.audio-code-input",
    modes: ["type"],
    rect: { x: 1, y: 1, width: 10, height: 10 },
  }],
  contextRegions: [],
  completion: { mode: "inline", targetIds: ["audio-code-input"] },
  focus: { targetId: "audio-code-input", contextRegionIds: [] },
};

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Timed out waiting for App workflow test state.");
}

for (const providerId of ["sinopac", "post", "einvoice", "yuanta-bank"] as const) {
  const taskId = providerId === "einvoice" ? "einvoice-personal-invoices"
    : providerId === "yuanta-bank" ? "yuanta-all-statements" : `${providerId}-statements`;
  const answer = providerId === "post" ? "1234" : providerId === "einvoice" ? "12345" : "123456";
  const providerContract = {
    ...sinopacContract,
    stageId: providerId === "post" ? "ipost-login-captcha" : `${providerId}-login-captcha`,
    expectedAnswerLength: answer.length,
    targets: sinopacContract.targets.map(target => ({ ...target, semanticId: `${providerId}.login.captcha-input` })),
    challengeImageRegion: { ...sinopacContract.challengeImageRegion!, semanticId: `${providerId}.login.captcha-image` },
  };
  test(`App ${providerId} retries typed rejection after execution cleanup aborts assistance and without retained events`, async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), `${providerId}-app-captcha-`));
    const originalCwd = process.cwd();
    const store = new PGliteStore(await PGlite.create());
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
      const settings: AutomationSettingsFile = {
        VERIFICATION_TEXT_CAPTCHA_CONFIDENCE_THRESHOLD: "0.9",
      };
      process.chdir(artifactRoot);
      const captureSessions: string[] = [];
      const injectedAnswers: string[] = [];
      const executeAttempts: number[] = [];
      let solverCalls = 0;

      const campaign = runCaptchaRetryCampaign({
        taskId,
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
                answer,
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
            await assistance.request(providerContract, controller.signal);
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
          // Worker cleanup aborts the request before the host joins execution.
          // Progress events are deliberately absent: they must not drive retries.
          controller.abort(new Error("Worker finished"));
          const processResult = {
            exitCode: rejected ? 1 : 0,
            signal: null,
            error: rejected ? new Error("App workflow failed (workflow-failed).") : null,
            resumeFailure: null,
            appWorkflowOutcome: { errorCode: rejected ? "captcha-provider-rejected" as const : null, summary: null },
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
      assert.deepEqual(injectedAnswers, [answer, answer]);
      const finalRun = await provider.automation.taskRunById(created.taskRunId);
      assert.equal(finalRun?.status, "completed");
      assert.equal(finalRun?.attempt, 3);
      assert.equal(Object.hasOwn(finalRun ?? {}, "logPath"), false);
      assert.equal(Object.hasOwn(finalRun ?? {}, "logTail"), false);
      assert.equal(finalRun?.events.some((event) => event.code === "captcha-rejected"), false);
      assert.deepEqual(await readdir(artifactRoot), [], "typed retry writes no CLI log, assistance JSONL, source, or output files");
    } finally {
      process.chdir(originalCwd);
      await store.close();
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });
}

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
    const controller = new AbortController();
    let cancelled = false;
    const campaign = runCaptchaRetryCampaign({
      taskId: "sinopac-statements",
      appWorkflow: true,
      provider,
      launchVerificationSettings: {},
      // A route still solving when the App closes.
      routeWaitingRunVerification: () => new Promise((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      }),
      initialExecutionOptions: { taskRunId: created.taskRunId },
      isCancellationRequested: () => cancelled,
      async execute(options: AutomationTaskExecutionOptions) {
        const assistance = createAppWorkflowHumanAssistancePort({
          taskRunId: created.taskRunId,
          persistence: provider.automation,
        });
        try {
          await assistance.request(sinopacContract, controller.signal);
          throw new Error("Cancellation did not interrupt verification assistance.");
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
        captchaRetryCooldownMs: () => undefined,
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

test("exhausted App solver retries finalize with a typed verification failure and safe reason", async () => {
  const store = new PGliteStore(await PGlite.create());
  const controller = new AbortController();
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const taskId = "fubon-all-statements";
    const created = await provider.automation.createTaskRun({
      taskId,
      kind: "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
    });
    const attempts: number[] = [];
    const result = await runCaptchaRetryCampaign({
      taskId,
      appWorkflow: true,
      provider,
      launchVerificationSettings: {},
      initialExecutionOptions: { taskRunId: created.taskRunId },
      isCancellationRequested: () => false,
      captchaRetryCooldownMs: () => undefined,
      routeWaitingRunVerification: async (input) => {
        await input.onChallengeCaptured?.();
        return { kind: "retryable", reason: "solver-exhausted" };
      },
      async execute(options) {
        attempts.push(options.attempt ?? 1);
        const assistance = createAppWorkflowHumanAssistancePort({
          taskRunId: created.taskRunId,
          persistence: provider.automation,
        });
        try {
          await assistance.request(sinopacContract, controller.signal);
        } catch {
          // Reject the current challenge so the campaign can admit its next round.
        }
        return {
          status: "failed" as const,
          taskRunId: created.taskRunId,
          executionId: options.executionId!,
          result: {
            exitCode: 1,
            signal: null,
            error: new Error("untrusted solver diagnostics"),
            statementSummary: null,
            outputPersistenceWarnings: [],
            externalPrerequisiteIds: [],
          },
        };
      },
    });
    assert.deepEqual(result, { status: "failed" });
    assert.equal(attempts.length, MAX_CAPTCHA_RETRY_ROUNDS);
    const finalRun = await provider.automation.taskRunById(created.taskRunId);
    assert.equal(finalRun?.status, "failed");
    assert.equal(finalRun?.appWorkflowOutcome?.errorCode, "verification-failed");
    assert.ok(finalRun?.events.some((event) => event.code === "verification-solver-exhausted"));
    assert.doesNotMatch(JSON.stringify(finalRun), /untrusted solver diagnostics/u);
  } finally {
    controller.abort();
    await store.close();
  }
});

test("Yuanta Trade audio solver exhaustion restarts through the App campaign", async () => {
  const store = new PGliteStore(await PGlite.create());
  const controller = new AbortController();
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const created = await provider.automation.createTaskRun({
      taskId: "yuanta-trade-statements",
      kind: "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
    });
    const attempts: number[] = [];
    let routeCalls = 0;
    const campaign = runCaptchaRetryCampaign({
      taskId: "yuanta-trade-statements",
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
        assert.equal(options.verificationRouteOwnedByCampaign, true);
        if ((options.attempt ?? 1) === 1) {
          const assistance = createAppWorkflowHumanAssistancePort({
            taskRunId: created.taskRunId,
            persistence: provider.automation,
          });
          try {
            await assistance.request(yuantaTradeAudioContract, controller.signal);
          } catch {
            // The campaign requests a fresh challenge after the worker exits.
          }
        }
        return {
          status: (options.attempt ?? 1) === 1 ? "failed" as const : "completed" as const,
          taskRunId: created.taskRunId,
          executionId: options.executionId!,
          result: {
            exitCode: (options.attempt ?? 1) === 1 ? 1 : 0,
            signal: null,
            error: (options.attempt ?? 1) === 1 ? new Error("Solver exhausted") : null,
            statementSummary: null,
            outputPersistenceWarnings: [],
            externalPrerequisiteIds: [],
          },
        };
      },
    });
    assert.deepEqual(await campaign, { status: "completed" });
    assert.deepEqual(attempts, [1, 2]);
    assert.equal(routeCalls, 1);
  } finally {
    controller.abort();
    await store.close();
  }
});
