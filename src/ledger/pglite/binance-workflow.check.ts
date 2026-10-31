import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPGliteChildRpcServer, requirePGliteChildRpcClientFromEnv } from "../../../electron/pglite-child-rpc.ts";
import {
  createPGliteFinancialLocalPort,
  createPGliteFinancialRegistry,
} from "../../../electron/pglite-financial-registry.ts";
import { createBinanceWorkflow } from "../../lib/automation/binance-workflow.ts";
import { createWorkflowFinancialCommitPort } from "../../lib/automation/workflow-financial-commit.ts";
import { strictSourceText } from "../../lib/automation/source-text.ts";
import { createWorkflowExecutor } from "../../lib/automation/workflow-executor.ts";
import { FailureCodeError } from "../../lib/automation/workflow-failures.ts";
import { createTestPGlite } from "./baseline-test-template.ts";
import { createPgliteOperationalProvider } from "./operational.ts";
import { PGliteStore } from "./transaction.ts";

const taipei = (date: string) => Date.parse(`${date}T10:00:00+08:00`);
const HTTP_DATE = "Sat, 31 Oct 2026 07:00:00 GMT";

function binanceFetch(accountStatus = 200): typeof fetch {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { Date: HTTP_DATE } });
  const routes: Readonly<Record<string, (params: URLSearchParams) => Response>> = {
    "/api/v3/time": () => json({ serverTime: Date.parse("2026-10-31T07:00:00.000Z") }),
    "/api/v3/exchangeInfo": () => json({ symbols: [
      { symbol: "BTCUSDT", baseAsset: "BTC", quoteAsset: "USDT" },
      { symbol: "ETHFDUSD", baseAsset: "ETH", quoteAsset: "FDUSD" },
    ] }),
    "/api/v3/account": () => accountStatus === 200
      ? json({ uid: 123456789, balances: [{ asset: "BTC", free: "0.2", locked: "0" }, { asset: "ETH", free: "1", locked: "0" }] })
      : json({ code: -2015, msg: "Invalid API-key, IP, or permissions for action." }, accountStatus),
    "/sapi/v1/asset/get-funding-asset": () => json([{ asset: "USDT", free: "95", locked: "0", freeze: "0", withdrawing: "0" }]),
    "/sapi/v1/capital/deposit/hisrec": (params) => json(params.get("startTime") === String(Date.parse("2026-08-03T00:00:00+08:00"))
      ? [{ id: "d1", coin: "USDT", amount: "100", status: 1, walletType: 1, insertTime: taipei("2026-09-01") }]
      : []),
    "/sapi/v1/capital/withdraw/history": () => json([]),
    "/sapi/v1/asset/transfer": (params) => json(params.get("type") === "FUNDING_MAIN" && params.get("current") === "1"
      && params.get("startTime") === String(Date.parse("2026-10-02T00:00:00+08:00"))
      ? { total: 1, rows: [{ asset: "USDT", amount: "5", type: "FUNDING_MAIN", status: "CONFIRMED", tranId: 77, timestamp: taipei("2026-10-10") }] }
      : { total: 0 }),
    "/api/v3/myTrades": (params) => json({
      BTCUSDT: [{ symbol: "BTCUSDT", id: 9, qty: "0.2", quoteQty: "12000", isBuyer: true, time: taipei("2026-10-11") }],
      ETHFDUSD: [{ symbol: "ETHFDUSD", id: 3, qty: "1", quoteQty: "3000", isBuyer: false, time: taipei("2026-10-12") }],
    }[params.get("symbol") ?? ""] ?? []),
    "/api/v3/ticker/price": () => json([{ symbol: "BTCUSDT", price: "60000" }]),
    "/api/v3/ticker": () => json({ market: "usdttwd", last: "32" }),
  };
  return (async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    const route = routes[url.pathname];
    if (!route) throw new Error(`Unexpected Binance endpoint: ${url.pathname}`);
    return route(url.searchParams);
  }) as typeof fetch;
}

test("Binance workflow commits both wallets and their bounded history through the canonical worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "binance-pglite-workflow-"));
  const database = await createTestPGlite("ledger+operational", { dataDir: join(root, "pglite") });
  const store = new PGliteStore(database);
  const server = createPGliteChildRpcServer({
    provider: { operational: createPgliteOperationalProvider(store), financial: createPGliteFinancialLocalPort(createPGliteFinancialRegistry(store)) },
  });
  const previous = { ...process.env };
  const originalFetch = globalThis.fetch;
  let child: ReturnType<typeof requirePGliteChildRpcClientFromEnv> | undefined;
  const count = async (sql: string) => (await store.query<{ count: number }>(sql)).rows[0]?.count;
  try {
    await server.ready;
    Object.assign(process.env, server.env);
    child = requirePGliteChildRpcClientFromEnv();
    await child.ready;
    const executor = createWorkflowExecutor([createBinanceWorkflow()], {
      browser: { withPage: async () => { throw new Error("Binance does not use a browser."); } },
      text: strictSourceText,
      humanAssistance: { request: async () => { throw new Error("Binance does not request assistance."); } },
      financialCommit: createWorkflowFinancialCommitPort(child.workflow),
      commitAttempts: { record: async () => undefined },
      events: { append: async () => undefined },
      now: () => "2026-10-31T07:00:00.000Z",
    });
    const input = { credentials: { binance_api_key: "test-key", binance_api_secret: "test-secret" } };
    globalThis.fetch = binanceFetch();
    const result = await executor.run("sync-binance", "synthetic-binance-run", input, new AbortController().signal) as {
      counts: Record<string, number>;
    };
    assert.deepEqual(result.counts, { canonicalCaptureCount: 2, accountCount: 2, statementRowCount: 4 });
    assert.deepEqual((await store.query<{ account_subtype: string }>(
      "SELECT account_subtype FROM investment_accounts WHERE source_id = 'binance' ORDER BY account_subtype",
    )).rows.map(({ account_subtype }) => account_subtype), ["crypto_exchange", "crypto_exchange"]);
    assert.equal(await count(
      "SELECT COUNT(*)::int AS count FROM capture_scopes scope JOIN source_captures capture ON capture.capture_id = scope.capture_id WHERE capture.record_kind = 'investment-source-record' AND scope.scope_kind = 'point-in-time'",
    ), 2, "neither capture claims a complete history range");
    assert.equal(await count("SELECT COUNT(*)::int AS count FROM investment_holding_snapshots"), 2);
    assert.equal(await count("SELECT COUNT(*)::int AS count FROM investment_holding_observations WHERE is_current = 1"), 3);
    assert.equal(await count("SELECT COUNT(*)::int AS count FROM investment_holding_observations WHERE valuation_currency = 'TWD'"), 2,
      "BTC and USDT have a USDT route; ETH has none and stays unvalued");
    assert.deepEqual((await store.query<{ action: string; cash_currency: string }>(
      "SELECT action, cash_currency FROM investment_transactions ORDER BY effective_on, action",
    )).rows.map(({ action, cash_currency }) => `${action}:${cash_currency}`), [
      "corporate_action_in:TWD",
      "corporate_action_in:TWD",
      "corporate_action_out:TWD",
      "buy:USDT",
      "sell:FDUSD",
    ]);

    await executor.run("sync-binance", "synthetic-binance-rerun", input, new AbortController().signal);
    assert.equal(await count("SELECT COUNT(*)::int AS count FROM investment_transactions"), 5, "a recapture adds no transaction");

    globalThis.fetch = binanceFetch(401);
    await assert.rejects(
      executor.run("sync-binance", "synthetic-binance-refused", input, new AbortController().signal),
      (error: unknown) => error instanceof FailureCodeError && error.errorCode === "authentication-failed",
    );
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
