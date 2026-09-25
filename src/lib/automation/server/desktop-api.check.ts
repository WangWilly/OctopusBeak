import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import test from "node:test";
import {
  applyPgliteOperationalBaseline,
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import {
  automationRunHistory,
  automationResumeHumanAssistance,
  automationSetupGuideLink,
  loadAutomationDesktopModel,
} from "./desktop-api.ts";

test("desktop automation model and history are read from the provider", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    await provider.automation.createTaskRun({
      taskId: "exchange-rates",
      script: "run:exchange-rates",
      kind: "sync",
      status: "completed",
      attempt: 1,
      maxAttempts: 1,
      startedAt: "2026-09-22T00:00:00.000Z",
      finishedAt: "2026-09-22T00:01:00.000Z",
      exitCode: 0,
      logPath: "data/automation/logs/exchange-rates.log",
    });
    const model = await loadAutomationDesktopModel(provider);
    assert.ok(model.credentialGroups.length > 0);
    assert.equal(model.automation.credentials !== undefined, true);
    const history = await automationRunHistory(provider);
    assert.equal(history[0]?.taskId, "exchange-rates");
    assert.equal(history[0]?.status, "completed");
  } finally {
    await store.close();
  }
});

test("desktop model refreshes ordered workflow events and honors retention pruning", async () => {
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
      startedAt: "2026-09-22T00:00:00.000Z",
      logPath: "",
      logTail: "",
    });
    await provider.automation.updateTaskRun(created.taskRunId, {
      appWorkflowOutcome: {
        errorCode: null,
        summary: { status: "partial", counts: { itemCount: 4, skippedProductCount: 1 } },
      },
    });
    const beforeEvents = await loadAutomationDesktopModel(provider);
    assert.deepEqual(
      beforeEvents.automation.tasks.find((task) => task.id === "exchange-rates")?.events,
      [],
    );
    await provider.automation.appendRunEvent({
      runId: created.taskRunId,
      stage: "authentication",
      code: "authentication-completed",
      occurredAt: "2026-09-22T00:00:01.000Z",
    });
    await provider.automation.appendRunEvent({
      runId: created.taskRunId,
      stage: "collection",
      code: "source-collected",
      occurredAt: "2026-09-22T00:00:02.000Z",
      completed: 2,
      total: 2,
    });

    const current = await loadAutomationDesktopModel(provider);
    const currentTask = current.automation.tasks.find(
      (task) => task.id === "exchange-rates",
    );
    assert.deepEqual(currentTask?.events.map((event) => event.code), [
      "authentication-completed",
      "source-collected",
    ]);
    assert.equal(currentTask?.events[1]?.completed, 2);
    assert.equal(currentTask?.events[1]?.total, 2);
    assert.deepEqual(currentTask?.appWorkflowOutcome, {
      errorCode: null,
      summary: { status: "partial", counts: { itemCount: 4, skippedProductCount: 1 } },
    });
    assert.equal(Object.hasOwn(currentTask ?? {}, "logPath"), false);
    assert.equal(Object.hasOwn(currentTask ?? {}, "logTail"), false);
    assert.equal(Object.hasOwn(currentTask ?? {}, "errorMessage"), false);
    assert.equal(Object.hasOwn(currentTask ?? {}, "statementFailures"), false);

    assert.equal(
      await provider.automation.pruneRunEvents("2026-09-26T00:00:00.000Z"),
      2,
    );
    const expired = await loadAutomationDesktopModel(provider);
    const expiredTask = expired.automation.tasks.find(
      (task) => task.id === "exchange-rates",
    );
    assert.deepEqual(expiredTask?.events, []);
    assert.deepEqual(expiredTask?.appWorkflowOutcome, {
      errorCode: null,
      summary: { status: "partial", counts: { itemCount: 4, skippedProductCount: 1 } },
    });
  } finally {
    await store.close();
  }
});

test("automation setup links remain stable without loading the ledger", () => {
  assert.equal(
    automationSetupGuideLink("maicoin", "api-guide", "en")?.url,
    "https://campaign.maicoin.com/en/api",
  );
  assert.equal(automationSetupGuideLink("maicoin", "missing", "en"), null);
});

test("legacy workflow sessions cannot be resumed from a saved Libretto log", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    await provider.automation.createTaskRun({
      taskId: "exchange-rates",
      script: "run:exchange-rates",
      kind: "sync",
      status: "waiting_for_human",
      attempt: 1,
      maxAttempts: 1,
      startedAt: "2026-09-26T00:00:00.000Z",
      logPath: "data/automation/logs/legacy-run.log",
      logTail: 'Resume requested for session "ses-legacy".',
    });
    await assert.rejects(
      automationResumeHumanAssistance("exchange-rates", provider),
      /Start a new run from the source/u,
    );
  } finally {
    await store.close();
  }
});
