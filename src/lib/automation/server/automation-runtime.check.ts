import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestPGlite } from "../../../ledger/pglite/baseline-test-template.ts";
import { createPgliteOperationalProvider } from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import { createAutomationRuntime } from "./automation-runtime.ts";
import { writeAutomationSettingsFile } from "./config-files.ts";
import type { AutomationTaskRun } from "./store.ts";
import { CHECK_PGLITE_RPC, runnerHostForCheck } from "./task-run-check-support.ts";
import type { runAutomationTaskExecution } from "./task-run-execution.ts";

type RuntimeOptions = { directory?: string; runExecution?: typeof runAutomationTaskExecution };

async function withRuntime(
  check: (runtime: ReturnType<typeof createAutomationRuntime>) => Promise<void>,
  options: RuntimeOptions = {},
) {
  const store = new PGliteStore(await createTestPGlite("operational"));
  try {
    const provider = { ...createPgliteOperationalProvider(store), pgliteWorkflow: CHECK_PGLITE_RPC };
    await check(createAutomationRuntime(provider, { ...runnerHostForCheck(options.directory), runExecution: options.runExecution }));
  } finally {
    await store.close();
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("recovery finishes a previous process's runs and publishes them in the runtime snapshot", () => withRuntime(async (runtime) => {
  const { taskRunId } = await runtime.provider.automation.createTaskRun({
    taskId: "exchange-rates", kind: "sync", status: "running", attempt: 1, maxAttempts: 1, startedAt: new Date().toISOString(),
  });
  await runtime.recover();
  assert.equal((await runtime.provider.automation.taskRunById(taskRunId))?.status, "interrupted");
  assert.equal(runtime.snapshot().tasks.find((task) => task.taskId === "exchange-rates")?.status, "interrupted");
  assert.deepEqual(runtime.activeTaskIds(), []);
}));

test("a start refuses a task the admission check does not know", () => withRuntime(async (runtime) => {
  const [result] = await runtime.start(["not-a-task"]);
  assert.equal(result?.status, "error");
  assert.match(result?.status === "error" ? result.error.message : "", /Unknown automation task/u);
  assert.equal(runtime.hasActive(), false, "nothing started");
}));

test("two concurrent starts of one task start it once, and only the start that claimed it settles it", async () => {
  const release = deferred();
  await withRuntime(async (runtime) => {
    const settledBy: Array<[string, string, AutomationTaskRun["status"] | null]> = [];
    const start = (caller: string) => runtime.start(["exchange-rates"], {
      onSettled: (taskId, run) => settledBy.push([caller, taskId, run?.status ?? null]),
    });
    const [first, second] = await Promise.all([start("first"), start("second")]);
    const results = [...first!, ...second!];
    const started = results.filter((result) => result.status === "started");
    const running = results.filter((result) => result.status === "already_running");
    assert.equal(started.length, 1, "exactly one start claims the task");
    assert.equal(running.length, 1, "the other start reports the task already running");
    assert.equal(running[0]!.runId, started[0]!.runId, "both name the one run");
    const claimer = first![0]!.status === "started" ? "first" : "second";

    release.resolve();
    while (runtime.hasActive()) await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(settledBy, [[claimer, "exchange-rates", "completed"]]);
  }, {
    runExecution: async (_plan, run) => {
      await run.transition("running");
      await release.promise;
      return { summary: null, failure: null };
    },
  });
});

test("a statement source starts only with a known statement selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "automation-runtime-selection-"));
  try {
    await withRuntime(async (runtime) => {
      const refusal = async () => {
        const [result] = await runtime.start(["fubon-all-statements"]);
        return result?.status === "error" ? result.error.message : result?.status;
      };
      writeAutomationSettingsFile(join(root, "settings.json"), { LIBRETTO_CLOUD_FUBON_ENABLED: true });
      assert.match(await refusal() ?? "", /Select at least one Fubon statement type/u);
      writeAutomationSettingsFile(join(root, "settings.json"), {
        LIBRETTO_CLOUD_FUBON_ENABLED: true,
        LIBRETTO_CLOUD_FUBON_STATEMENT_TYPES: "deposit,unknown",
      });
      assert.match(await refusal() ?? "", /Unknown Fubon statement type: unknown/u);
      assert.equal(runtime.hasActive(), false);
    }, { directory: root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
