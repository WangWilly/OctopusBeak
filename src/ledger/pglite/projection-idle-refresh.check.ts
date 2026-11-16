import assert from "node:assert/strict";
import test from "node:test";
import { insertPGliteCanonicalCommit } from "./canonical-commit.ts";
import { refreshPGliteCurrentProjectionInTransaction } from "./projection.ts";
import { createSpendingCategoryFixture } from "./spending-test-fixture.ts";

test("a refresh for a commit that touches no transaction writes no Kind and no commit", async () => {
  const fixture = await createSpendingCategoryFixture();
  try {
    for (const amount of ["101", "102", "103"]) await fixture.addTransaction({ amount, date: "2026-09-10" });
    const counts = async () => {
      const count = async (sql: string) => Number((await fixture.store.query<{ n: number | string }>(sql)).rows[0]!.n);
      return {
        outputs: await count("SELECT count(*) AS n FROM enrichment_run_outputs"),
        assertions: await count("SELECT count(*) AS n FROM assertions"),
        commits: await count("SELECT count(*) AS n FROM canonical_commits"),
      };
    };
    const before = await counts();
    // What a balance-only capture leaves behind: a commit with no transaction in it.
    await fixture.store.transaction(async (transaction) => {
      const commit = await insertPGliteCanonicalCommit(transaction, { kind: "user_assertion", authorityRoute: "user/local", time: { kind: "wall-clock" } });
      await refreshPGliteCurrentProjectionInTransaction(transaction, { commitId: commit.id, cutoffSequence: commit.sequence, transactionIds: [] });
    });
    assert.deepEqual(await counts(), { ...before, commits: before.commits + 1 });
  } finally {
    await fixture.close();
  }
});
