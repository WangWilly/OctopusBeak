import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createPGliteChildRpcServer, requirePGliteChildRpcClientFromEnv } from "../../../electron/pglite-child-rpc.ts";
import { createPGliteFinancialRegistry } from "../../../electron/pglite-financial-registry.ts";
import { createMaicoinWorkflow } from "../../lib/automation/maicoin-workflow.ts";
import { createWorkflowFinancialCommitPort } from "../../lib/automation/workflow-financial-commit.ts";
import { strictSourceText } from "../../lib/automation/source-text.ts";
import { createWorkflowExecutor, type WorkflowRunEvent } from "../../lib/automation/workflow-executor.ts";
import { applyPgliteBaseline } from "./baseline.ts";
import { applyPgliteMaicoinOperationalSchema } from "./maicoin-operational.ts";
import { applyPgliteOperationalBaseline, createPgliteOperationalProvider } from "./operational.ts";
import { PGliteStore } from "./transaction.ts";

test("MaiCoin workflow commits through the injected canonical worker and operational ports", async () => {
  const root = await mkdtemp(join(tmpdir(), "maicoin-pglite-workflow-"));
  const database = await PGlite.create(join(root, "pglite"));
  const store = new PGliteStore(database);
  await applyPgliteBaseline(database);
  await applyPgliteOperationalBaseline(store);
  await applyPgliteMaicoinOperationalSchema(store);
  const operational = createPgliteOperationalProvider(store);
  const server = createPGliteChildRpcServer({
    provider: { operational, financial: createPGliteFinancialRegistry(store, operational.exchangeRates) },
  });
  const previous = { ...process.env };
  const originalFetch = globalThis.fetch;
  let child: ReturnType<typeof requirePGliteChildRpcClientFromEnv> | undefined;
  try {
    await server.ready;
    Object.assign(process.env, server.env);
    child = requirePGliteChildRpcClientFromEnv();
    await child.ready;
    globalThis.fetch = (async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/api/v3/info") {
        return new Response(JSON.stringify({ email: "owner@example.test", m_wallet_enabled: true }), { status: 200 });
      }
      if (/^\/api\/v3\/wallet\/(spot|m)\/accounts$/u.test(url.pathname)) {
        return new Response("[]", { status: 200, headers: { Date: "Wed, 02 Sep 2026 04:05:06 GMT" } });
      }
      if (url.pathname === "/api/v3/markets") return new Response("[]", { status: 200 });
      if (url.pathname.endsWith("/trades")
        || url.pathname.startsWith("/api/v3/fund_transactions/")
        || url.pathname === "/api/v3/rewards"
        || url.pathname === "/api/v3/converts") return new Response("[]", { status: 200 });
      throw new Error(`Unexpected MAX endpoint: ${url.pathname}`);
    }) as typeof fetch;

    const events: WorkflowRunEvent[] = [];
    const executor = createWorkflowExecutor([createMaicoinWorkflow()], {
      browser: { withPage: async () => { throw new Error("MaiCoin does not use a browser."); } },
      text: strictSourceText,
      humanAssistance: { request: async () => { throw new Error("MaiCoin does not request assistance."); } },
      financialCommit: createWorkflowFinancialCommitPort(child.workflow),
      maicoinPersistence: child.operationalProvider.maicoin,
      events: { append: async (event) => { events.push(event); } },
      now: () => "2026-09-25T00:00:00.000Z",
    });
    const result = await executor.run("sync-maicoin", "synthetic-maicoin-run", {
      credentials: { accessKey: "test-access", secretKey: "test-secret", subAccount: "main" },
    }, new AbortController().signal) as { canonicalInvestmentCaptures: number };
    assert.equal(result.canonicalInvestmentCaptures, 2);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM financial_accounts")).rows[0]?.count, 2);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM maicoin_sync_runs")).rows[0]?.count, 1);
    assert.deepEqual(events.map((event) => event.code).slice(-1), ["run-completed"]);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(server.env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    child?.close();
    await server.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
