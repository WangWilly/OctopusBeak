import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  createPGliteOperationalRpcClient,
  createPGliteOperationalRpcServer,
} from "../../../electron/pglite-operational-rpc.ts";
import { applyPgliteMaicoinOperationalSchema } from "./maicoin-operational.ts";
import { createPgliteOperationalProvider } from "./operational.ts";
import { PGliteStore } from "./transaction.ts";

test("MaiCoin sync snapshots and history use the worker owned PGlite port", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  const channel = new MessageChannel();
  const server = createPGliteOperationalRpcServer(
    channel.port1,
    createPgliteOperationalProvider(store),
  );
  const client = createPGliteOperationalRpcClient(channel.port2);
  try {
    await applyPgliteMaicoinOperationalSchema(store);
    await client.provider.maicoin.startRun({
      syncRunId: "synthetic-run", startedAt: "2026-09-23T00:00:00.000Z",
      subAccount: "main", walletTypes: ["spot"], statementLimit: 1000,
      record: { status: "started" },
    });
    await client.provider.maicoin.appendSnapshots([{
      snapshotId: "synthetic-snapshot", syncRunId: "synthetic-run",
      capturedAt: "2026-09-23T00:01:00.000Z", subAccount: "main",
      walletType: "spot", currency: "btc", balance: 1, locked: 0,
      staked: null, principal: null, interest: null, totalQuantity: 1,
      priceMarket: "btctwd", priceCurrency: "TWD", price: 100,
      valueTwd: 100, priceAt: "2026-09-23T00:00:00.000Z",
      rawAccountJson: '{"currency":"btc"}', rawPriceJson: null,
    }]);
    const statement = {
      statementId: "synthetic-statement", syncRunId: "synthetic-run",
      capturedAt: "2026-09-23T00:01:00.000Z", endpoint: "/api/v3/trades",
      walletType: "spot", rowType: "trade", externalId: "trade-1",
      occurredAt: "2026-09-23T00:00:00.000Z", currency: "BTC",
      amount: 1, fee: 0, feeCurrency: "BTC", market: "btctwd",
      side: "buy", price: 100, valueTwd: 100,
      rawPayloadJson: '{"id":"trade-1"}',
    };
    await client.provider.maicoin.appendStatementRows([statement]);
    await client.provider.maicoin.appendStatementRows([{ ...statement, valueTwd: 120 }]);
    await client.provider.maicoin.finishRun({
      syncRunId: "synthetic-run", finishedAt: "2026-09-23T00:02:00.000Z",
      record: { status: "completed" },
    });
    const run = await store.query<{ record_json: string }>(
      "SELECT record_json FROM maicoin_sync_runs WHERE sync_run_id=$1", ["synthetic-run"],
    );
    assert.deepEqual(JSON.parse(run.rows[0]!.record_json), { status: "completed" });
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM maicoin_account_snapshots")).rows[0]?.count, 1);
    assert.equal((await store.query<{ value_twd: number }>("SELECT value_twd FROM maicoin_statement_rows WHERE statement_id=$1", ["synthetic-statement"])).rows[0]?.value_twd, 120);
  } finally {
    client.close();
    await server.close();
    channel.port1.close();
    channel.port2.close();
    await store.close();
  }
});
