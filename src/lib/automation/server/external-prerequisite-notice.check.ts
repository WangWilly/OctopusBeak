import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  createPgliteOperationalProvider,
} from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import { createDataVersionStore } from "../../shared-shell/data-version.ts";
import { ExternalPrerequisiteUnavailableError } from "../external-prerequisite.ts";
import { userActionForFailure, workflowFailureExplanation } from "../workflow-failures.ts";
import {
  decideAutomationTaskRunOutcome,
  finalizeAutomationTaskRun,
} from "./task-run-finalization.ts";
import { YUANTA_SERVISIGN_PREREQUISITE } from "./sources/yuanta-trade.ts";
import { classifyTypedWorkflowFailure, type TypedWorkflowOutcome } from "./typed-workflow-outcome.ts";
import { createTestPGlite } from "../../../ledger/pglite/baseline-test-template.ts";

const database = await createTestPGlite("operational");
const store = new PGliteStore(database);
after(() => database.close());
const { automation } = createPgliteOperationalProvider(store);

const missingComponent = [
  { runId: "r", stage: "authentication", code: "login-started", occurredAt: "2026-10-20T00:00:00.000Z" },
  { runId: "r", stage: "authentication", code: "servisign-unavailable", occurredAt: "2026-10-20T00:00:01.000Z" },
] as const;

async function runYuantaTrade(report: TypedWorkflowOutcome, unavailable: boolean) {
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
      code: "servisign-unavailable",
      occurredAt: new Date().toISOString(),
    });
  }
  await finalizeAutomationTaskRun(
    automation,
    taskRunId,
    decideAutomationTaskRunOutcome(report, null),
    { dataVersionStore: createDataVersionStore() },
  );
  return taskRunId;
}

test("a missing external component is its own failure, not a sign-in failure", () => {
  const code = classifyTypedWorkflowFailure(
    new ExternalPrerequisiteUnavailableError("yuanta-servisign"),
    missingComponent,
  );
  assert.equal(code, "external-prerequisite-unavailable");
  assert.equal(userActionForFailure(code), null, "the in-app notice, not an OS notification, guides the repair");
  assert.match(workflowFailureExplanation(code, "zh-TW") ?? "", /元件/u);
});

test("the prerequisite names the run event its workflow records", () => {
  assert.equal(YUANTA_SERVISIGN_PREREQUISITE.unavailableEventCode, "servisign-unavailable");
});

test("a missing component raises one notice that a later successful run resolves", async () => {
  const unavailable = { errorCode: "external-prerequisite-unavailable", summary: null } as const;
  const first = await runYuantaTrade(unavailable, true);
  let notices = await automation.activeTaskPrerequisiteNotices();
  assert.deepEqual(notices.map((notice) => [notice.taskId, notice.prerequisiteId, notice.latestTaskRunId]), [
    ["yuanta-trade-statements", "yuanta-servisign", first],
  ]);

  const second = await runYuantaTrade(unavailable, true);
  notices = await automation.activeTaskPrerequisiteNotices();
  assert.equal(notices.length, 1, "a repeated failure keeps one notice");
  assert.equal(notices[0]?.latestTaskRunId, second);

  await runYuantaTrade({ errorCode: "authentication-failed", summary: null }, false);
  assert.equal((await automation.activeTaskPrerequisiteNotices()).length, 1, "an unrelated failure leaves the notice");

  const repaired = await runYuantaTrade({ errorCode: null, summary: null }, false);
  assert.deepEqual(await automation.activeTaskPrerequisiteNotices(), []);
  const [resolved] = await automation.allTaskPrerequisiteNotices();
  assert.equal(resolved?.resolvedByTaskRunId, repaired);
});

test("a prerequisite failure without the prerequisite's event raises no notice", async () => {
  await runYuantaTrade({ errorCode: "external-prerequisite-unavailable", summary: null }, false);
  assert.deepEqual(await automation.activeTaskPrerequisiteNotices(), []);
});
