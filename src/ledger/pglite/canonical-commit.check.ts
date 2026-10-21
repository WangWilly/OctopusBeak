import assert from "node:assert/strict";
import test from "node:test";
import { createTestPGlite } from "./baseline-test-template.ts";
import { insertPGliteCanonicalCommit } from "./canonical-commit.ts";
import { PGliteStore } from "./transaction.ts";

test("canonical commits take the next sequence and the time their kind of authority calls for", async () => {
  const store = new PGliteStore(await createTestPGlite("ledger"));
  try {
    await store.transaction(async (transaction) => {
      const insert = (time: Parameters<typeof insertPGliteCanonicalCommit>[1]["time"]) =>
        insertPGliteCanonicalCommit(transaction, { kind: "source_capture", authorityRoute: "test/route", time });

      const first = await insert({ kind: "requested", recordedAtUtcUs: 5_000 });
      assert.deepEqual([first.sequence, first.recordedAtUtcUs], [1, 5_000], "the first commit keeps its requested time");

      const behind = await insert({ kind: "requested", clock: () => 1_000 });
      assert.deepEqual([behind.sequence, behind.recordedAtUtcUs], [2, 5_001], "a requested time never precedes the latest commit");

      const derived = await insert({ kind: "after-latest" });
      assert.deepEqual([derived.sequence, derived.recordedAtUtcUs], [3, 5_002], "derived data lands right after the latest commit");

      const before = Date.now() * 1000;
      const decided = await insert({ kind: "wall-clock" });
      assert.equal(decided.sequence, 4);
      assert.ok(decided.recordedAtUtcUs >= before && decided.recordedAtUtcUs <= Date.now() * 1000, "a person's decision keeps the wall-clock time");

      await assert.rejects(insert({ kind: "requested", clock: () => -1 }), /invalid timestamp/u);
    });
  } finally {
    await store.close();
  }
});
