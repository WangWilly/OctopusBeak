import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import { buildAutomationPageModel } from "./page-model.ts";
import { AUTOMATION_TASKS } from "./tasks.ts";
import {
  createTaskRun,
  taskRunById,
  updateHumanAssistanceCompletion,
  updateHumanAssistanceContract,
} from "./store.ts";
import {
  humanAssistanceContractSignal,
  parseHumanAssistanceContractSignals,
  type HumanAssistanceContractInput,
} from "../human-assistance.ts";

const contract: HumanAssistanceContractInput = {
  stageId: "yuanta-bank-captcha",
  title: "Complete the CAPTCHA",
  targets: [{
    id: "captcha-input",
    label: "CAPTCHA input",
    semanticId: "yuanta-bank.login.captcha-input",
    modes: ["type"],
  }],
  contextRegions: [{
    id: "captcha-challenge",
    label: "CAPTCHA challenge",
    semanticId: "yuanta-bank.login.captcha-challenge",
  }],
  completion: { mode: "inline", targetIds: ["captcha-input"] },
  focus: { targetId: "captcha-input", contextRegionIds: ["captcha-challenge"] },
};

test("human assistance contract persists with a task run and is exposed to Assist", () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "human-assistance-contract-"));
  try {
    const db = openLedgerDatabase(ledgerDir);
    const run = createTaskRun(db, {
      taskId: "yuanta-all-statements",
      script: "run:yuanta-all-statements",
      kind: "crawler",
      status: "waiting_for_human",
      attempt: 1,
      maxAttempts: 1,
      startedAt: "2026-08-08T08:00:00.000Z",
      logPath: join(ledgerDir, "yuanta.log"),
      logTail: "Workflow paused.",
    });

    const first = updateHumanAssistanceContract(db, run.taskRunId, contract);
    const persisted = taskRunById(db, run.taskRunId);
    db.close();

    assert.equal(first.version, 1);
    assert.equal(first.completion.status, "pending");
    assert.deepEqual(persisted?.humanAssistanceContract, first);

    const pageModel = buildAutomationPageModel({
      tasks: AUTOMATION_TASKS,
      latestRuns: { "yuanta-all-statements": persisted! },
      activeTaskIds: [],
      todayRunTaskIds: [],
      credentials: {},
      importGate: { locked: false, missingTaskIds: [], warnings: [] },
      active: true,
      businessDate: "2026-08-08",
    });
    assert.deepEqual(
      pageModel.tasks.find((task) => task.id === "yuanta-all-statements")?.humanAssistanceContract,
      first,
    );
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});

test("workflow contract signals are structured and never carry verification text", () => {
  const signal = humanAssistanceContractSignal({
    ...contract,
    completion: { ...contract.completion, status: "entered" },
  });
  assert.match(signal, /^human-assistance-contract:/);
  assert.equal(signal.includes("captcha-answer"), false);
  assert.deepEqual(parseHumanAssistanceContractSignals(`${signal}\n`), [{
    ...contract,
    completion: { ...contract.completion, status: "entered" },
  }]);
});

test("updating a waiting contract increments its version without storing verification text", () => {
  const ledgerDir = mkdtempSync(join(tmpdir(), "human-assistance-contract-update-"));
  try {
    const db = openLedgerDatabase(ledgerDir);
    const run = createTaskRun(db, {
      taskId: "yuanta-all-statements",
      script: "run:yuanta-all-statements",
      kind: "crawler",
      status: "waiting_for_human",
      attempt: 1,
      maxAttempts: 1,
      startedAt: "2026-08-08T08:00:00.000Z",
      logPath: join(ledgerDir, "yuanta.log"),
      logTail: "Workflow paused.",
    });

    const first = updateHumanAssistanceContract(db, run.taskRunId, contract);
    const second = updateHumanAssistanceContract(db, run.taskRunId, {
      ...contract,
      stageId: "yuanta-bank-captcha-retry",
      title: "Complete the refreshed CAPTCHA",
      targets: [{
        ...contract.targets[0]!,
        semanticId: "yuanta-bank.login.refreshed-captcha-input",
      }],
    });
    const persisted = taskRunById(db, run.taskRunId);
    assert.equal(first.version, 1);
    assert.equal(second.version, 2);
    assert.equal(persisted?.humanAssistanceContract?.stageId, "yuanta-bank-captcha-retry");
    assert.equal(JSON.stringify(persisted).includes("captcha-answer"), false);

    const verified = updateHumanAssistanceCompletion(db, run.taskRunId, "verified");
    assert.equal(verified.version, 3);
    assert.equal(verified.completion.status, "verified");
    db.close();
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});
