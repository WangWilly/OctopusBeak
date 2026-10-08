import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import test from "node:test";
import {
  applyPgliteOperationalBaseline,
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import { readAutomationSettings } from "./settings.ts";
import {
  captchaRetryCooldownMs,
  runCaptchaRetryCampaign,
  waitForCaptchaRetryCooldown,
} from "./captcha-retry-coordinator.ts";
import type { AutomationTaskExecutionOptions } from "./task-run-execution.ts";

test("non-browser workflow fails closed on a legacy waiting_for_human result without routing or retrying", async () => {
  const store = new PGliteStore(await PGlite.create());
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const created = await provider.automation.createTaskRun({
      taskId: "exchange-rates",
      kind: "sync",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
    });
    let executions = 0;
    let verificationRoutes = 0;
    const result = await runCaptchaRetryCampaign({
      taskId: "exchange-rates",
      appWorkflow: false,
      provider,
      launchVerificationSettings: readAutomationSettings(),
      initialExecutionOptions: { taskRunId: created.taskRunId },
      isCancellationRequested: () => false,
      routeWaitingRunVerification: async () => {
        verificationRoutes += 1;
        return { kind: "resumed" };
      },
      async execute() {
        executions += 1;
        return {
          status: "waiting_for_human" as const,
          taskRunId: created.taskRunId,
          executionId: "legacy-pause-result",
          result: {
            exitCode: null,
            signal: null,
            error: null,
            statementSummary: null,
            outputPersistenceWarnings: [],
            externalPrerequisiteIds: [],
          },
        };
      },
    });

    assert.deepEqual(result, { status: "failed" });
    assert.equal(executions, 1);
    assert.equal(verificationRoutes, 0);
    const finalRun = await provider.automation.taskRunById(created.taskRunId);
    assert.equal(finalRun?.status, "failed");
    assert.equal(finalRun?.appWorkflowOutcome?.errorCode, "workflow-failed");
  } finally {
    await store.close();
  }
});

test("CAPTCHA campaign finalizes its provider-owned run exactly once", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const created = await provider.automation.createTaskRun({
      taskId: "exchange-rates",
      kind: "sync",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
    });
    let executions = 0;
    const result = await runCaptchaRetryCampaign({
      taskId: "exchange-rates",
      appWorkflow: false,
      provider,
      launchVerificationSettings: readAutomationSettings(),
      initialExecutionOptions: {},
      isCancellationRequested: () => false,
      async execute(_options: AutomationTaskExecutionOptions) {
        executions += 1;
        return {
          status: "completed" as const,
          taskRunId: created.taskRunId,
          executionId: "campaign-check-execution",
          result: {
            exitCode: 0,
            signal: null,
            error: null,
            statementSummary: null,
            outputPersistenceWarnings: [],
            externalPrerequisiteIds: [],
          },
        };
      },
    });
    assert.deepEqual(result, { status: "completed" });
    assert.equal(executions, 1);
    assert.equal((await provider.automation.taskRunById(created.taskRunId))?.status, "completed");
  } finally {
    await store.close();
  }
});

test("SinoPac cancellation preserves an ambiguous commit and does not retry", async () => {
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
    let executions = 0;
    const result = await runCaptchaRetryCampaign({
      taskId: "sinopac-statements",
      appWorkflow: true,
      provider,
      launchVerificationSettings: readAutomationSettings(),
      initialExecutionOptions: { taskRunId: created.taskRunId },
      isCancellationRequested: () => true,
      async execute() {
        executions += 1;
        return {
          status: "failed" as const,
          taskRunId: created.taskRunId,
          executionId: "ambiguous-financial-commit",
          result: {
            exitCode: 1,
            signal: null,
            error: new Error("App workflow failed (commit-outcome-unknown)."),
            statementSummary: null,
            appWorkflowOutcome: { errorCode: "commit-outcome-unknown" as const, summary: null },
            outputPersistenceWarnings: [],
            externalPrerequisiteIds: [],
          },
        };
      },
    });

    assert.deepEqual(result, { status: "failed" });
    assert.equal(executions, 1);
    const finalRun = await provider.automation.taskRunById(created.taskRunId);
    assert.equal(finalRun?.status, "failed");
    assert.equal(finalRun?.appWorkflowOutcome?.errorCode, "commit-outcome-unknown");
  } finally {
    await store.close();
  }
});

test("Fubon waits out its login cooldown before the next CAPTCHA round", async () => {
  assert.ok((captchaRetryCooldownMs("fubon-all-statements") ?? 0) >= 20_000);
  assert.equal(captchaRetryCooldownMs("sinopac-statements"), undefined);
  const started = Date.now();
  assert.equal(await waitForCaptchaRetryCooldown(60, () => false), true);
  assert.ok(Date.now() - started >= 55);
});

test("cancellation ends the CAPTCHA retry cooldown early", async () => {
  let checks = 0;
  const started = Date.now();
  assert.equal(await waitForCaptchaRetryCooldown(10_000, () => ++checks > 1), false);
  assert.ok(Date.now() - started < 2_000);
});
