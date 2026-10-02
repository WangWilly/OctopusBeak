import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  buildMaicoinInvestmentCapture,
  parseMaicoinProviderDate,
  type MaicoinStatementBatch,
} from "../canonical/maicoin-crypto-adapters.ts";
import { createPGliteChildRpcServer, requirePGliteChildRpcClientFromEnv } from "../../../electron/pglite-child-rpc.ts";
import { createPGliteFinancialRegistry } from "../../../electron/pglite-financial-registry.ts";
import { createMaicoinWorkflow } from "../../lib/automation/maicoin-workflow.ts";
import { createWorkflowFinancialCommitPort } from "../../lib/automation/workflow-financial-commit.ts";
import { strictSourceText } from "../../lib/automation/source-text.ts";
import { createWorkflowExecutor, type WorkflowRunEvent } from "../../lib/automation/workflow-executor.ts";
import { applyPgliteBaseline } from "./baseline.ts";
import { applyPgliteMaicoinOperationalSchema } from "./maicoin-operational.ts";
import { commitPGliteCanonicalInvestmentCapture } from "./investment.ts";
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
        || url.pathname === "/api/v3/converts") return new Response("[]", {
          status: 200,
          headers: { Date: "Wed, 02 Sep 2026 04:05:06 GMT" },
        });
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
    assert.equal((await store.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM source_captures WHERE record_kind = 'investment-source-record' AND scope_start = '2017-12-11' AND scope_end = '2026-09-02'",
    )).rows[0]?.count, 2);
    assert.equal((await store.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM source_occurrence_group_coverages WHERE capture_id IN (SELECT capture_id FROM source_captures WHERE record_kind = 'investment-source-record')",
    )).rows[0]?.count, 0);
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

test("MaiCoin complete history proof persists empty/native-ID bounded scope and blocks conflicting ID payloads atomically", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  const providerDate = parseMaicoinProviderDate("Wed, 02 Sep 2026 04:05:06 GMT");
  const history = {
    startDate: "2017-12-11",
    endDate: "2026-09-01",
    complete: true as const,
  };
  const makeStatementBatches = (amount: string): MaicoinStatementBatch[] => {
    const shared = [
      { endpoint: "/api/v3/fund_transactions/deposits", rowType: "deposit" as const, rows: [{
        sn: "max-deposit-001",
        created_at: "2026-06-01T10:00:00.000Z",
        currency: "BTC",
        amount,
        state: "done",
      }] },
      { endpoint: "/api/v3/fund_transactions/withdrawals", rowType: "withdrawal" as const, rows: [] },
      { endpoint: "/api/v3/fund_transactions/transfers", rowType: "transfer" as const, rows: [] },
      { endpoint: "/api/v3/rewards", rowType: "reward" as const, rows: [] },
      { endpoint: "/api/v3/converts", rowType: "convert" as const, rows: [] },
    ];
    return [
      {
        endpoint: "/api/v3/wallet/spot/trades",
        walletType: "spot",
        rowType: "trade",
        rows: [],
        history,
      },
      ...shared.map((batch) => ({ ...batch, walletType: null, history })),
    ];
  };
  const makeCapture = (captureId: string, amount: string) => buildMaicoinInvestmentCapture({
    captureId,
    providerEmail: "owner@example.test",
    subAccount: "main",
    accountBatches: [{
      walletType: "spot",
      providerDate,
      accounts: [{ currency: "BTC", balance: "2", locked: "0" }],
    }],
    statementBatches: makeStatementBatches(amount),
  });

  try {
    await applyPgliteBaseline(database);
    const first = makeCapture("maicoin-native-id-first", "1.25");
    assert.equal(first.scope.effectiveOn, "2026-09-02");
    assert.deepEqual(first.scope.transactionHistory, history);
    assert.equal(first.transactions[0]?.occurrenceGroup, undefined);
    await commitPGliteCanonicalInvestmentCapture(store, { capture: first });
    assert.deepEqual((await store.query<{
      scope_start: string;
      scope_end: string;
    }>(
      "SELECT scope_start, scope_end FROM source_captures WHERE capture_key = 'maicoin-native-id-first:maicoin:spot:0'",
    )).rows[0], {
      scope_start: history.startDate,
      scope_end: history.endDate,
    });
    await commitPGliteCanonicalInvestmentCapture(store, {
      capture: makeCapture("maicoin-native-id-recapture", "1.25"),
    });
    assert.equal((await store.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM investment_transactions",
    )).rows[0]?.count, 1);

    await assert.rejects(() => commitPGliteCanonicalInvestmentCapture(store, {
      capture: makeCapture("maicoin-native-id-conflict", "2.50"),
    }));
    assert.equal((await store.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM investment_transactions",
    )).rows[0]?.count, 1);
  } finally {
    await store.close();
  }
});
