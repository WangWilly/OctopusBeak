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

test("automation setup links remain stable without loading the ledger", () => {
  assert.equal(
    automationSetupGuideLink("maicoin", "api-guide", "en")?.url,
    "https://campaign.maicoin.com/en/api",
  );
  assert.equal(automationSetupGuideLink("maicoin", "missing", "en"), null);
});
