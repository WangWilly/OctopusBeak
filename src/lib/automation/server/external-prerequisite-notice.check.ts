import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import { createDataVersionStore } from "../../shared-shell/data-version.ts";
import { ExternalPrerequisiteUnavailableError } from "../external-prerequisite.ts";
import { userActionForFailure, workflowFailureExplanation } from "../workflow-failures.ts";
import { openActiveTaskRun, type TaskRunReport } from "./active-task-run.ts";
import { createAutomationRuntimeState } from "./runtime-state.ts";
import { YUANTA_SERVISIGN_PREREQUISITE } from "./sources/yuanta-trade.ts";
import { classifyFailure } from "../failure-classification.ts";
import { createTestPGlite } from "../../../ledger/pglite/baseline-test-template.ts";

const database = await createTestPGlite("operational");
const store = new PGliteStore(database);
after(() => database.close());
const { automation } = createPgliteOperationalProvider(store);

const missingComponent = [
  { runId: "r", stage: "authentication", outcome: "started", code: "login-started", occurredAt: "2026-10-20T00:00:00.000Z" },
  { runId: "r", stage: "authentication", outcome: "failed", code: "servisign-unavailable", occurredAt: "2026-10-20T00:00:01.000Z" },
] as const;

async function runYuantaTrade(report: TaskRunReport, unavailable: boolean) {
  const { taskRunId } = await automation.createTaskRun({
    taskId: "yuanta-trade-statements",
    kind: "crawler",
    status: "running",
    attempt: 1,
    maxAttempts: 1,
    startedAt: new Date().toISOString(),
  });
  if (unavailable) {
    await automation.appendRunEvent({
      runId: taskRunId,
      stage: "authentication",
      outcome: "failed", code: "servisign-unavailable",
      occurredAt: new Date().toISOString(),
    });
  }
  const run = await automation.taskRunById(taskRunId);
  await openActiveTaskRun({
    run: run!,
    persistence: automation,
    runtime: createAutomationRuntimeState(),
    dataVersionStore: createDataVersionStore(),
  }).finish(report);
  return taskRunId;
}

test("a missing external component is its own failure, not a sign-in failure", () => {
  const code = classifyFailure({
    error: new ExternalPrerequisiteUnavailableError("yuanta-servisign"),
    events: missingComponent,
    stopped: false,
  });
  assert.equal(code, "external-prerequisite-unavailable");
  assert.equal(userActionForFailure(code), null, "the in-app notice, not an OS notification, guides the repair");
  assert.match(workflowFailureExplanation(code, "zh-TW") ?? "", /元件/u);
});

test("the prerequisite names the run event its workflow records", () => {
  assert.equal(YUANTA_SERVISIGN_PREREQUISITE.unavailableEventCode, "servisign-unavailable");
});

test("a missing component raises one notice that a later successful run resolves", async () => {
  const unavailable = { summary: null, failure: { code: "external-prerequisite-unavailable", proven: true } } as const;
  const first = await runYuantaTrade(unavailable, true);
  let notices = await automation.activeTaskPrerequisiteNotices();
  assert.deepEqual(notices.map((notice) => [notice.taskId, notice.prerequisiteId, notice.latestTaskRunId]), [
    ["yuanta-trade-statements", "yuanta-servisign", first],
  ]);

  const second = await runYuantaTrade(unavailable, true);
  notices = await automation.activeTaskPrerequisiteNotices();
  assert.equal(notices.length, 1, "a repeated failure keeps one notice");
  assert.equal(notices[0]?.latestTaskRunId, second);

  await runYuantaTrade({ summary: null, failure: { code: "authentication-failed", proven: true } }, false);
  assert.equal((await automation.activeTaskPrerequisiteNotices()).length, 1, "an unrelated failure leaves the notice");

  const repaired = await runYuantaTrade({ summary: null, failure: null }, false);
  assert.deepEqual(await automation.activeTaskPrerequisiteNotices(), []);
  const [resolved] = await automation.allTaskPrerequisiteNotices();
  assert.equal(resolved?.resolvedByTaskRunId, repaired);
});

test("a prerequisite failure without the prerequisite's event raises no notice", async () => {
  await runYuantaTrade({ summary: null, failure: { code: "external-prerequisite-unavailable", proven: true } }, false);
  assert.deepEqual(await automation.activeTaskPrerequisiteNotices(), []);
});
