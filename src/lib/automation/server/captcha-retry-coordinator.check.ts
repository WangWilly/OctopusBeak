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
