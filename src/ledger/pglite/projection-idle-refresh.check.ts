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

test("planner statistics follow a table that grows, and are left alone when nothing is appended", async () => {
  const fixture = await createSpendingCategoryFixture();
  try {
    const tables = ["assertions", "assertion_transitions", "enrichment_run_outputs"];
    const statistics = async () =>
      (
        await fixture.store.query<{ table_name: string; pages: number; analyzed_pages: number; written_by: string }>(
          `SELECT relname AS table_name,
                  (pg_relation_size(oid) / current_setting('block_size')::int)::int AS pages,
                  relpages AS analyzed_pages,
                  (SELECT string_agg(statistic.xmin::text, ',' ORDER BY statistic.staattnum)
                     FROM pg_statistic statistic WHERE statistic.starelid = pg_class.oid) AS written_by
             FROM pg_class WHERE oid = ANY($1::regclass[]) ORDER BY relname`,
          [tables],
        )
      ).rows;
    for (let index = 0; index < 60; index += 1) await fixture.addTransaction({ amount: String(200 + index), date: "2026-09-10" });
    const grown = await statistics();
    for (const row of grown) {
      assert.ok(row.pages > 1, `${row.table_name} spans more than one page`);
      assert.ok(row.pages <= row.analyzed_pages * 1.1, `${row.table_name} statistics cover its size`);
    }
    await fixture.store.transaction(async (transaction) => {
      const commit = await insertPGliteCanonicalCommit(transaction, { kind: "user_assertion", authorityRoute: "user/local", time: { kind: "wall-clock" } });
      await refreshPGliteCurrentProjectionInTransaction(transaction, { commitId: commit.id, cutoffSequence: commit.sequence, transactionIds: [] });
    });
    assert.deepEqual(await statistics(), grown);
  } finally {
    await fixture.close();
  }
});
