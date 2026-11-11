import assert from "node:assert/strict";
import test from "node:test";

// The task and workflow catalogs read these when they load, as in a packaged fixture launch.
process.env.OCTOPUSBEAK_PACKAGED_WORKFLOW_FIXTURE = "1";
process.env.OCTOPUSBEAK_PACKAGED_WORKFLOW_FIXTURE_URL = "http://127.0.0.1:9/";

const { createTestPGlite } = await import("../src/ledger/pglite/baseline-test-template.ts");
const { createPgliteOperationalProvider } = await import("../src/ledger/pglite/operational.ts");
const { PGliteStore } = await import("../src/ledger/pglite/transaction.ts");
const { createAutomationRuntime } = await import("../src/lib/automation/server/automation-runtime.ts");
const { PACKAGED_BROWSER_FIXTURE_TASKS } = await import("../src/lib/automation/server/packaged-browser-fixture.ts");
const { CHECK_PGLITE_RPC, runnerHostForCheck } = await import("../src/lib/automation/server/task-run-check-support.ts");

test("the packaged fixture's synthetic tasks pass the same admission as every other start", async () => {
  const store = new PGliteStore(await createTestPGlite("operational"));
  try {
    const runtime = createAutomationRuntime(
      { ...createPgliteOperationalProvider(store), pgliteWorkflow: CHECK_PGLITE_RPC },
      { ...runnerHostForCheck(), runExecution: async () => ({ summary: null, failure: null }) },
    );
    const results = await runtime.start(PACKAGED_BROWSER_FIXTURE_TASKS.map(({ taskId }) => taskId));
    assert.deepEqual(
      results.map((result) => [result.taskId, result.status]),
      PACKAGED_BROWSER_FIXTURE_TASKS.map(({ taskId }) => [taskId, "started"]),
    );
    while (runtime.hasActive()) await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    await store.close();
  }
});
