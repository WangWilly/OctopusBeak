import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  automationSaveCredentials,
  automationSetupGuideLink,
  loadAutomationDesktopModel,
} from "./desktop-api.ts";
import { readAutomationSettings } from "./settings.ts";

test("desktop automation model and history are read from the provider", async () => {
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
      startedAt: "2026-09-22T00:00:00.000Z",
    });
    await provider.automation.updateTaskRun(created.taskRunId, {
      status: "completed",
      finishedAt: "2026-09-22T00:01:00.000Z",
      exitCode: 0,
      appWorkflowOutcome: {
        errorCode: null,
        summary: { status: "completed", counts: { count: 2 } },
      },
    });
    const model = await loadAutomationDesktopModel(provider);
    assert.ok(model.credentialGroups.length > 0);
    assert.equal(model.automation.credentials !== undefined, true);
    const history = await automationRunHistory(provider);
    assert.equal(history[0]?.taskId, "exchange-rates");
    assert.equal(history[0]?.status, "completed");
    assert.deepEqual(history[0]?.appWorkflowOutcome, {
      errorCode: null,
      summary: { status: "completed", counts: { count: 2 } },
    });
    assert.equal(Object.hasOwn(history[0] ?? {}, "script"), false);
    assert.equal(Object.hasOwn(history[0] ?? {}, "errorMessage"), false);
    assert.equal(Object.hasOwn(history[0] ?? {}, "logPath"), false);
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
      kind: "sync",
      status: "running",
      attempt: 1,
      maxAttempts: 1,
      startedAt: "2026-09-22T00:00:00.000Z",
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

test("Fubon statement subset round-trips through settings and desktop model", async () => {
  const root = await mkdtemp(join(tmpdir(), "automation-statement-selection-"));
  const previousDirectory = process.cwd();
  const store = new PGliteStore(await PGlite.create());
  try {
    process.chdir(root);
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    const saved = automationSaveCredentials({
      LIBRETTO_CLOUD_FUBON_ENABLED: "true",
      LIBRETTO_CLOUD_FUBON_STATEMENT_TYPES: "loan,deposit,loan",
    });
    assert.equal(saved.saved, true);
    assert.equal(
      readAutomationSettings().LIBRETTO_CLOUD_FUBON_STATEMENT_TYPES,
      "deposit,loan",
    );

    const model = await loadAutomationDesktopModel(provider);
    const fubon = model.credentialGroups.find((group) => group.id === "fubon");
    assert.deepEqual(fubon?.selectedStatementTypeIds, ["deposit", "loan"]);
    assert.equal(fubon?.statementSetupRequired, false);

    assert.throws(
      () => automationSaveCredentials({
        LIBRETTO_CLOUD_FUBON_ENABLED: "true",
        LIBRETTO_CLOUD_FUBON_STATEMENT_TYPES: "deposit,unknown",
      }),
      /Unknown Fubon statement type: unknown/u,
    );
    assert.equal(
      readAutomationSettings().LIBRETTO_CLOUD_FUBON_STATEMENT_TYPES,
      "deposit,loan",
      "rejected selection leaves the persisted choice unchanged",
    );
  } finally {
    process.chdir(previousDirectory);
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("non-typed task runs cannot be resumed as App workflow assistance", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteOperationalBaseline(store);
    const provider = createPgliteOperationalProvider(store);
    await provider.automation.createTaskRun({
      taskId: "exchange-rates",
      kind: "sync",
      status: "waiting_for_human",
      attempt: 1,
      maxAttempts: 1,
      startedAt: "2026-09-26T00:00:00.000Z",
    });
    await assert.rejects(
      automationResumeHumanAssistance("exchange-rates", provider),
      /does not use an App browser workflow/u,
    );
  } finally {
    await store.close();
  }
});
