import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import test from "node:test";
import {
  applyPgliteOperationalBaseline,
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import { readAutomationSettings } from "./settings.ts";
import { runCaptchaRetryCampaign } from "./captcha-retry-coordinator.ts";
import type { AutomationTaskExecutionOptions } from "./task-run-execution.ts";

test("non-browser workflow fails closed on a legacy human-pause result without routing or retrying", async () => {
  const store = new PGliteStore(await PGlite.create());
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const created = await provider.automation.createTaskRun({
      taskId: "exchange-rates",
      script: "workflow:exchange-rates",
      kind: "sync",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
      logPath: "",
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
        return { kind: "human" };
      },
      async execute() {
        executions += 1;
        return {
          status: "waiting_for_human" as const,
          taskRunId: created.taskRunId,
          executionId: "legacy-pause-result",
          session: "legacy-session-key",
          owner: null,
          result: {
            exitCode: null,
            signal: null,
            error: null,
            logTail: "Workflow paused. libretto resume --session legacy-session-key",
            resumeFailure: null,
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
    assert.equal(finalRun?.logTail, "");
    assert.match(finalRun?.errorMessage ?? "", /^Workflow failed \(workflow-failed\)\.$/u);
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
      script: "run:exchange-rates",
      kind: "sync",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: new Date().toISOString(),
      logPath: "/tmp/captcha-coordinator.log",
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
          session: null,
          owner: null,
          result: {
            exitCode: 0,
            signal: null,
            error: null,
            logTail: "exchange sync complete",
            resumeFailure: null,
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
