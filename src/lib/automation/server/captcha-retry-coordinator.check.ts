import assert from "node:assert/strict";
import test from "node:test";
import {
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import { readAutomationSettings } from "./settings.ts";
import {
  captchaRetryCooldownMs,
  runCaptchaRetryCampaign,
  waitForCaptchaRetryCooldown,
} from "./captcha-retry-coordinator.ts";
import type { AutomationPersistenceProvider } from "./store.ts";
import { openTaskRunForCheck } from "./task-run-check-support.ts";
import { createTestPGlite } from "../../../ledger/pglite/baseline-test-template.ts";

async function withRun(
  taskId: string,
  check: (provider: AutomationPersistenceProvider, taskRunId: string) => Promise<void>,
) {
  const store = new PGliteStore(await createTestPGlite("operational"));
  try {
    const provider = createPgliteOperationalProvider(store);
    const { taskRunId } = await provider.automation.createTaskRun({
      taskId,
      kind: taskId === "exchange-rates" ? "sync" : "crawler",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
    });
    await check(provider, taskRunId);
  } finally {
    await store.close();
  }
}

test("a nonbrowser campaign executes once, routes nothing and leaves finalization to the run", () =>
  withRun("exchange-rates", async (provider, taskRunId) => {
    const run = await openTaskRunForCheck(provider.automation, taskRunId);
    let executions = 0;
    let verificationRoutes = 0;
    const report = await runCaptchaRetryCampaign({
      taskId: "exchange-rates",
      appWorkflow: false,
      provider,
      run,
      launchVerificationSettings: readAutomationSettings(),
      initialExecutionOptions: {},
      routeWaitingRunVerification: async () => {
        verificationRoutes += 1;
        return { kind: "resumed" };
      },
      async execute() {
        executions += 1;
        return { errorCode: null, summary: null };
      },
    });
    assert.deepEqual(report, { errorCode: null, summary: null });
    assert.equal(executions, 1);
    assert.equal(verificationRoutes, 0);
    assert.equal((await provider.automation.taskRunById(taskRunId))?.status, "running");
    assert.equal((await run.finish(report)).status, "completed");
  }));

test("SinoPac cancellation preserves an ambiguous commit and does not retry", () =>
  withRun("sinopac-statements", async (provider, taskRunId) => {
    const run = await openTaskRunForCheck(provider.automation, taskRunId);
    await run.requestStop("cancelled");
    let executions = 0;
    const report = await runCaptchaRetryCampaign({
      taskId: "sinopac-statements",
      appWorkflow: true,
      provider,
      run,
      launchVerificationSettings: readAutomationSettings(),
      initialExecutionOptions: {},
      async execute() {
        executions += 1;
        return { errorCode: "commit-outcome-unknown", summary: null };
      },
    });
    assert.equal(executions, 1);
    const finalRun = await run.finish(report);
    assert.equal(finalRun.status, "failed");
    assert.equal(finalRun.appWorkflowOutcome?.errorCode, "commit-outcome-unknown");
  }));

test("Fubon waits out its login cooldown before the next CAPTCHA round", async () => {
  assert.ok((captchaRetryCooldownMs("fubon-all-statements") ?? 0) >= 20_000);
  assert.equal(captchaRetryCooldownMs("sinopac-statements"), undefined);
  const started = Date.now();
  assert.equal(await waitForCaptchaRetryCooldown(60, new AbortController().signal), true);
  assert.ok(Date.now() - started >= 55);
});

for (const stop of ["cancelled", "forced", "shutdown"] as const) {
  test(`a ${stop} stop ends the CAPTCHA retry cooldown at once`, () =>
    withRun("fubon-all-statements", async (provider, taskRunId) => {
      const run = await openTaskRunForCheck(provider.automation, taskRunId);
      const started = Date.now();
      const cooldown = waitForCaptchaRetryCooldown(10_000, run.signal);
      const stopping = new Promise<void>((resolve) => {
        setTimeout(() => resolve(run.requestStop(stop)), 20);
      });
      assert.equal(await cooldown, false);
      assert.ok(Date.now() - started < 1_000);
      await stopping;
    }));
}
