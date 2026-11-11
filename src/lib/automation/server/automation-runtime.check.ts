import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTestPGlite } from "../../../ledger/pglite/baseline-test-template.ts";
import { createPgliteOperationalProvider } from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import { createAutomationRuntime, type SettledAutomationStart } from "./automation-runtime.ts";
import { writeAutomationSettingsFile } from "./config-files.ts";
import { CHECK_PGLITE_RPC, runnerHostForCheck } from "./task-run-check-support.ts";
import type { TaskRunExecution } from "./task-run-execution.ts";

type RuntimeOptions = { directory?: string; runExecution?: TaskRunExecution };

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

const settles = () => new Promise<void>((resolve) => setImmediate(resolve));

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
    const settledBy: Array<[string, string, string]> = [];
    const start = (caller: string) => runtime.start(["exchange-rates"], {
      onSettled: (results) => {
        for (const result of results) {
          settledBy.push([caller, result.status, result.status === "started" ? result.run?.status ?? "unfinalized" : "-"]);
        }
      },
    });
    const [first, second] = await Promise.all([start("first"), start("second")]);
    const results = [...first!, ...second!];
    const started = results.filter((result) => result.status === "started");
    const running = results.filter((result) => result.status === "already_running");
    assert.equal(started.length, 1, "exactly one start claims the task");
    assert.equal(running.length, 1, "the other start reports the task already running");
    assert.equal(running[0]!.runId, started[0]!.runId, "both name the one run");
    const [claimer, other] = first![0]!.status === "started" ? ["first", "second"] : ["second", "first"];
    await settles();
    assert.deepEqual(settledBy, [[other, "already_running", "-"]], "a start that started nothing settles at once");

    release.resolve();
    while (runtime.hasActive()) await settles();
    await settles();
    assert.deepEqual(settledBy, [[other, "already_running", "-"], [claimer, "started", "completed"]]);
  }, {
    runExecution: async (_plan, run) => {
      await run.transition("running");
      await release.promise;
      return { summary: null, failure: null };
    },
  });
});

test("a batch settles once, after every task it started ended, with the tasks it could not start", async () => {
  const release = deferred();
  await withRuntime(async (runtime) => {
    const batches: Array<{ batch: string; results: readonly SettledAutomationStart[] }> = [];
    const first = await runtime.start(["exchange-rates", "not-a-task"], {
      onSettled: (results) => batches.push({ batch: "first", results }),
    });
    assert.deepEqual(first.map(({ taskId, status }) => [taskId, status]), [["exchange-rates", "started"], ["not-a-task", "error"]]);
    const second = await runtime.start(["exchange-rates"], {
      onSettled: (results) => batches.push({ batch: "second", results }),
    });
    await settles();
    assert.deepEqual(batches.map(({ batch }) => batch), ["second"], "the first batch waits for its started run");
    assert.deepEqual(second.map(({ status }) => status), ["already_running"]);

    release.resolve();
    while (runtime.hasActive()) await settles();
    await settles();
    assert.deepEqual(batches.map(({ batch }) => batch), ["second", "first"], "each batch settles exactly once");
    assert.deepEqual(
      batches[1]!.results.map((result) => [result.taskId, result.status, result.status === "started" ? result.run?.status : null]),
      [["exchange-rates", "started", "completed"], ["not-a-task", "error", null]],
    );
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
