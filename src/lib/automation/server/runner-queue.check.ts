import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { beforeEach, afterEach } from "node:test";
import {
  startAutomationTask, cancelAutomationTask, forceTerminateAutomationTask,
  shutdownAppAutomationWorkflows, hasActiveAutomationTask,
} from "./runner.ts";
import type { AutomationPersistenceProvider, AutomationTaskRun } from "./store.ts";
import type { runAutomationTaskExecution } from "./task-run-execution.ts";
import { PGLITE_WORKFLOW_REQUIRED_ENV } from "../../../ledger/pglite/workflow-client.ts";
import { writeAutomationSettingsFile } from "./config-files.ts";

let previousDirectory: string;
let settingsDirectory: string;
beforeEach(async () => {
  previousDirectory = process.cwd();
  settingsDirectory = await mkdtemp(join(tmpdir(), "automation-queue-settings-"));
  process.chdir(settingsDirectory);
  writeAutomationSettingsFile("settings.json", {
    LIBRETTO_CLOUD_FUBON_STATEMENT_TYPES: "deposit",
    LIBRETTO_CLOUD_ESUN_STATEMENT_TYPES: "credit_card",
    LIBRETTO_CLOUD_CTBC_STATEMENT_TYPES: "deposit",
    LIBRETTO_CLOUD_LINEBANK_STATEMENT_TYPES: "accounts",
  });
});
afterEach(async () => {
  process.chdir(previousDirectory);
  await rm(settingsDirectory, { recursive: true, force: true });
});

function harness() {
  const runs = new Map<string, AutomationTaskRun>();
  const entered: string[] = [];
  const releases = new Map<string, () => void>();
  let active = 0;
  let peak = 0;
  const provider = {
    pgliteWorkflow: { required: true, env: {
      [PGLITE_WORKFLOW_REQUIRED_ENV]: "1",
      OCTOPUSBEAK_PGLITE_CHILD_RPC_ENDPOINT: "http://127.0.0.1:43121/rpc",
      OCTOPUSBEAK_PGLITE_CHILD_RPC_TOKEN: "test-token",
    } },
    automation: {
      async createTaskRun(input: Record<string, unknown>) {
        const taskRunId = `queue-${input.taskId}`;
        runs.set(taskRunId, { ...input, taskRunId } as AutomationTaskRun);
        return { taskRunId };
      },
      async taskRunById(id: string) { return runs.get(id) ?? null; },
      async transitionTaskRunToActive(id: string, patch: Partial<AutomationTaskRun>) {
        Object.assign(runs.get(id)!, patch); return { applied: true };
      },
      async transitionTaskRunToTerminal(id: string, patch: Partial<AutomationTaskRun>) {
        Object.assign(runs.get(id)!, patch); return { applied: true };
      },
    },
  } as unknown as AutomationPersistenceProvider;
  const execute: typeof runAutomationTaskExecution = async (task, _port, options, created) => {
    entered.push(task.id);
    active += 1;
    peak = Math.max(peak, active);
    await created(options.taskRunId!);
    // A waiting verification continues to own its execution slot.
    runs.get(options.taskRunId!)!.status = "waiting_for_human";
    try {
      await new Promise<void>((resolve) => releases.set(task.id, resolve));
      throw new Error("Synthetic source failure releases the workflow slot.");
    } finally { active -= 1; }
  };
  return {
    runs, entered, releases, provider, execute,
    get peak() { return peak; },
    start: (id: string) => startAutomationTask(id, provider, { runExecution: execute }),
  };
}
async function tick() { await new Promise<void>((resolve) => setImmediate(resolve)); }
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i += 1) { if (predicate()) return; await tick(); }
  assert.ok(predicate(), "Workflow queue did not settle.");
}

test("all App start paths share three slots, retain FIFO order and cancel queued runs before execution", async () => {
  const h = harness();
  try {
    await h.start("exchange-rates"); await h.start("linebank-statements"); await h.start("ctbc-statements");
    await until(() => h.entered.length === 3);
    await h.start("fubon-all-statements"); await h.start("sync-maicoin");
    assert.equal(h.peak, 3);
    assert.deepEqual(h.entered, ["exchange-rates", "linebank-statements", "ctbc-statements"]);
    assert.equal(h.runs.get("queue-fubon-all-statements")?.status, "queued");
    assert.equal(h.runs.get("queue-sync-maicoin")?.status, "queued");
    await cancelAutomationTask("sync-maicoin", h.provider);
    await until(() => h.runs.get("queue-sync-maicoin")?.status === "cancelled");
    await h.start("esun-credit-card-statements");
    await forceTerminateAutomationTask("esun-credit-card-statements", h.provider);
    assert.equal(h.runs.get("queue-esun-credit-card-statements")?.status, "cancelled");
    h.releases.get("exchange-rates")!();
    await until(() => h.entered.includes("fubon-all-statements"));
    assert.equal(h.peak, 3);
    assert.equal(h.entered.at(-1), "fubon-all-statements");
    assert.ok(!h.entered.includes("sync-maicoin"));
    assert.ok(!h.entered.includes("esun-credit-card-statements"));
  } finally {
    // Also release any unexpectedly admitted run when asserting the old implementation.
    for (const release of h.releases.values()) release();
    await until(() => !hasActiveAutomationTask());
  }
});

test("App shutdown interrupts queued work without starting it or waiting for a free slot", async () => {
  const h = harness();
  await h.start("exchange-rates"); await h.start("linebank-statements"); await h.start("ctbc-statements");
  await until(() => h.entered.length === 3);
  await h.start("fubon-all-statements");
  for (const release of h.releases.values()) release();
  await shutdownAppAutomationWorkflows(h.provider, { finalizePersistedRuns: async () => undefined });
  assert.ok(!h.entered.includes("fubon-all-statements"));
  assert.equal(h.runs.get("queue-fubon-all-statements")?.status, "interrupted");
  assert.equal(hasActiveAutomationTask(), false);
});
