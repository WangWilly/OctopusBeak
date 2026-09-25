import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createPGliteChildRpcServer } from "../../../../electron/pglite-child-rpc.ts";
import { createPGliteFinancialRegistry } from "../../../../electron/pglite-financial-registry.ts";
import { applyPgliteBaseline } from "../../../ledger/pglite/baseline.ts";
import { applyPgliteMaicoinOperationalSchema } from "../../../ledger/pglite/maicoin-operational.ts";
import { applyPgliteOperationalBaseline, createPgliteOperationalProvider } from "../../../ledger/pglite/operational.ts";
import { PGliteStore } from "../../../ledger/pglite/transaction.ts";
import { runAutomationTaskExecution } from "./task-run-execution.ts";
import { taskById } from "./tasks.ts";

function maxResponse(body: unknown, date?: string) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: date ? { Date: date } : {},
  });
}

test("App task execution runs MaiCoin in process without writing run artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "maicoin-app-execution-"));
  const previousDirectory = process.cwd();
  const database = await PGlite.create(join(root, "pglite"));
  const store = new PGliteStore(database);
  await applyPgliteBaseline(database);
  await applyPgliteOperationalBaseline(store);
  await applyPgliteMaicoinOperationalSchema(store);
  const operational = createPgliteOperationalProvider(store);
  const server = createPGliteChildRpcServer({
    provider: { operational, financial: createPGliteFinancialRegistry(store, operational.exchangeRates) },
  });
  const previousFetch = globalThis.fetch;
  try {
    await server.ready;
    globalThis.fetch = (async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/api/v3/info")
        return maxResponse({ email: "owner@example.test", m_wallet_enabled: true });
      if (/^\/api\/v3\/wallet\/(spot|m)\/accounts$/u.test(url.pathname))
        return maxResponse([], "Wed, 02 Sep 2026 04:05:06 GMT");
      if (url.pathname === "/api/v3/markets") return maxResponse([]);
      if (url.pathname.endsWith("/trades")
        || url.pathname.startsWith("/api/v3/fund_transactions/")
        || url.pathname === "/api/v3/rewards"
        || url.pathname === "/api/v3/converts") return maxResponse([]);
      throw new Error(`Unexpected MAX endpoint: ${url.pathname}`);
    }) as typeof fetch;

    const task = taskById("sync-maicoin");
    assert.ok(task);
    assert.equal(Object.hasOwn(task, "command"), false);
    await assert.rejects(() => runAutomationTaskExecution(
      task,
      operational.automation,
      { launchEnv: {} },
      async () => undefined,
    ), /PGlite workflow transport is unavailable/u);
    assert.equal((await operational.automation.latestTaskRuns())[task.id], undefined);
    const result = await runAutomationTaskExecution(
      task,
      operational.automation,
      {
        launchEnv: {
          ...server.env,
          ["MAX" + "_ACCESS_KEY"]: "test-access",
          ["MAX" + "_SECRET_KEY"]: "test-secret",
          MAX_SUB_ACCOUNT: "main",
        },
      },
      async () => undefined,
    );
    assert.equal(result.status, "completed");
    const run = (await operational.automation.latestTaskRuns())["sync-maicoin"];
    assert.ok(run);
    assert.deepEqual(run.events.map((event) => event.code).slice(-1), ["run-completed"]);
    assert.equal(Object.hasOwn(run, "logPath"), false);
    assert.equal(Object.hasOwn(run, "logTail"), false);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM financial_accounts")).rows[0]?.count, 2);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM maicoin_sync_runs")).rows[0]?.count, 1);
    assert.deepEqual(await readdir(root), ["pglite"], "only the test database remains under its temp root");
  } finally {
    process.chdir(previousDirectory);
    globalThis.fetch = previousFetch;
    await server.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
