import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  createSpendingLatencyFixtureController,
  FIXTURE_MODE,
} from "./spending-financial-latency-fixture.mjs";
import { createSqliteContentionController } from "./spending-financial-latency-electron.mjs";
import { removeDesktopCdpFixture, seedDesktopCdpFixture } from "./seed-desktop-cdp-fixture.ts";

test("spending latency fixture is unavailable for non-disposable roots", async () => {
  await assert.rejects(
    () => createSpendingLatencyFixtureController({ userData: process.cwd() }),
    /temporary directory|completed disposable canonical reset/u,
  );
});

test("spending latency fixture controls deterministic scale and scenario reset", async () => {
  const root = await mkdtemp(join(tmpdir(), "octopusbeak-spending-latency-fixture-"));
  try {
    seedDesktopCdpFixture(root, new Date("2026-09-18T00:00:00.000Z"));
    const fixture = await createSpendingLatencyFixtureController({
      userData: root,
      baseCardinalities: { invoices: 8, transactions: 8, candidates: 8 },
    });
    try {
      const prepared = await fixture.setScale("1x");
      assert.deepEqual(Object.keys(prepared).sort(), ["cardinalities", "knowledgePoint", "mode", "multiplier", "ready", "scale"]);
      assert.equal(prepared.mode, FIXTURE_MODE);
      assert.deepEqual(prepared.cardinalities, { invoices: 8, transactions: 8, candidates: 8 });
      const reset = await fixture.resetScenario("1x");
      assert.deepEqual(reset, { mode: FIXTURE_MODE, ready: true, scale: "1x", cardinalities: { invoices: 8, transactions: 8, candidates: 8 } });
      assert.equal(Number.isSafeInteger(await fixture.latestKnowledgePoint()), true);
      const stress = await fixture.setScale("2x");
      assert.deepEqual(stress.cardinalities, { invoices: 16, transactions: 16, candidates: 16 });
      const stressReset = await fixture.resetScenario("2x");
      assert.deepEqual(stressReset, { mode: FIXTURE_MODE, ready: true, scale: "2x", cardinalities: { invoices: 16, transactions: 16, candidates: 16 } });
      const contender = new DatabaseSync(fixture.databasePath);
      contender.exec("PRAGMA busy_timeout = 1");
      const contention = await createSqliteContentionController(fixture.databasePath, 25);
      try {
        await contention.hold();
        assert.throws(() => contender.exec("BEGIN IMMEDIATE"), /busy|locked/u);
        await contention.release();
      } finally {
        contention.close();
        contender.close();
      }
    } finally {
      await fixture.close();
    }
  } finally {
    removeDesktopCdpFixture(root);
  }
});
