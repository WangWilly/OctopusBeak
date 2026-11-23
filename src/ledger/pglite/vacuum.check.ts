import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { PGliteStore } from "./transaction.ts";
import { pgliteTablesToVacuum, startPgliteVacuums, vacuumPgliteDeadTuples } from "./vacuum.ts";

async function storeWithTables(): Promise<PGliteStore> {
  const store = new PGliteStore(await PGlite.create());
  await store.exec(`
    CREATE TABLE rewritten (id int PRIMARY KEY, pad text);
    CREATE TABLE quiet (id int PRIMARY KEY, pad text);
    INSERT INTO rewritten SELECT g, repeat(md5(g::text), 8) FROM generate_series(1, 2000) g;
    INSERT INTO quiet SELECT g, repeat(md5(g::text), 8) FROM generate_series(1, 2000) g;
  `);
  return store;
}

/** What the projection did on every re-sync before ADR 0153: rewrite every row with the same values. */
const rewriteAll = (store: PGliteStore) => store.exec("UPDATE rewritten SET pad = pad");
const pages = async (store: PGliteStore, table: string) =>
  Number((await store.query<{ pages: number | string }>(
    `SELECT pg_relation_size('${table}') / current_setting('block_size')::int AS pages`,
  )).rows[0]!.pages);
const dead = async (store: PGliteStore, table: string) => {
  await store.query("SELECT pg_stat_force_next_flush()");
  return Number((await store.query<{ dead: number | string }>(
    "SELECT n_dead_tup AS dead FROM pg_stat_user_tables WHERE relname = $1", [table],
  )).rows[0]!.dead);
};

test("only a table whose dead tuples passed the threshold is vacuumed", async () => {
  const store = await storeWithTables();
  try {
    await rewriteAll(store);
    await store.exec("UPDATE quiet SET pad = pad WHERE id <= 100");
    assert.equal(await dead(store, "rewritten"), 2000, "PGlite counts dead tuples");
    assert.deepEqual(await pgliteTablesToVacuum(store), ["public.rewritten"]);
    assert.deepEqual(await vacuumPgliteDeadTuples(store), ["public.rewritten"]);
    assert.equal(await dead(store, "rewritten"), 0);
    assert.equal(await dead(store, "quiet"), 100);
  } finally {
    await store.close();
  }
});

test("vacuuming between rewrites keeps a table at its working size", async () => {
  const unvacuumed = await storeWithTables();
  const vacuumed = await storeWithTables();
  try {
    const initial = await pages(vacuumed, "rewritten");
    for (let round = 0; round < 20; round += 1) {
      await rewriteAll(unvacuumed);
      await rewriteAll(vacuumed);
      await vacuumPgliteDeadTuples(vacuumed);
    }
    // The freed space is reused, so the table settles at about twice its rows.
    assert.ok(await pages(vacuumed, "rewritten") <= initial * 2 + 2, "the vacuumed table stays bounded");
    assert.ok(await pages(unvacuumed, "rewritten") >= initial * 15, "without a vacuum every rewrite adds a copy");
  } finally {
    await unvacuumed.close();
    await vacuumed.close();
  }
});

test("periodic vacuums run on the queue they are given and stop cleanly", async () => {
  const store = await storeWithTables();
  const lane: string[] = [];
  const vacuums = startPgliteVacuums(store, {
    intervalMs: 10,
    run: async (task) => { lane.push("background"); return task(); },
  });
  try {
    await rewriteAll(store);
    const deadline = Date.now() + 5_000;
    while (await dead(store, "rewritten") > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await dead(store, "rewritten"), 0);
    assert.ok(lane.length > 0);
  } finally {
    await vacuums.stop();
    await store.close();
  }
});
