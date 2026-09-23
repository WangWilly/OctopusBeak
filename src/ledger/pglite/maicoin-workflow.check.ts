import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createPGliteChildRpcServer, requirePGliteChildRpcClientFromEnv } from "../../../electron/pglite-child-rpc.ts";
import { createPGliteFinancialRegistry } from "../../../electron/pglite-financial-registry.ts";
import { buildMaicoinInvestmentCaptures, parseMaicoinProviderDate } from "../canonical/maicoin-crypto-adapters.ts";
import { commitMaicoinCanonicalInvestmentCaptures } from "../sync-maicoin.ts";
import { applyPgliteBaseline } from "./baseline.ts";
import { applyPgliteMaicoinOperationalSchema } from "./maicoin-operational.ts";
import { applyPgliteOperationalBaseline, createPgliteOperationalProvider } from "./operational.ts";
import { PGliteStore } from "./transaction.ts";

test("MAX canonical sync uses authenticated PGlite child commands", async () => {
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
  try {
    await server.ready;
    Object.assign(process.env, server.env);
    const providerDate = parseMaicoinProviderDate("Wed, 02 Sep 2026 04:05:06 GMT");
    const input = {
      captureId: "synthetic-maicoin-run",
      providerEmail: "owner@example.test",
      subAccount: "main",
      accountBatches: [
        { walletType: "spot" as const, providerDate, accounts: [] },
        { walletType: "m" as const, providerDate, accounts: [] },
      ],
    };
    assert.equal(buildMaicoinInvestmentCaptures(input).length, 2);
    const results = await commitMaicoinCanonicalInvestmentCaptures(root, input);
    assert.equal(results.length, 2);
    const child = requirePGliteChildRpcClientFromEnv();
    try {
      await child.ready;
      await child.operationalProvider.maicoin.startRun({
        syncRunId: "synthetic-maicoin-operational", startedAt: "2026-09-23T00:00:00.000Z",
        subAccount: "main", walletTypes: ["spot"], statementLimit: 1000,
        record: { status: "started" },
      });
      await child.operationalProvider.maicoin.finishRun({
        syncRunId: "synthetic-maicoin-operational",
        finishedAt: "2026-09-23T00:01:00.000Z",
        record: { status: "completed" },
      });
    } finally {
      child.close();
    }
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM financial_accounts")).rows[0]?.count, 2);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM maicoin_sync_runs")).rows[0]?.count, 1);
    assert.equal((await readdir(root)).includes("canonical.sqlite"), false);
    assert.equal((await readdir(root)).includes("ledger.sqlite"), false);
  } finally {
    for (const key of Object.keys(server.env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await server.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
