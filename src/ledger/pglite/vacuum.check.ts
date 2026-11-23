import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGliteStore } from "./transaction.ts";
import { pgliteTablesBySize, pgliteTablesToVacuum, startPgliteVacuums, vacuumPgliteDeadTuples } from "./vacuum.ts";

async function storeWithTables(dataDir?: string): Promise<PGliteStore> {
  const store = new PGliteStore(await PGlite.create(dataDir));
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

/** Starts the vacuums and resolves once their pass over every table, one queue task per table, is done. */
async function runStartupPass(store: PGliteStore): Promise<void> {
  const tasks = (await pgliteTablesBySize(store)).length + 1;
  let done = 0;
  let finished!: () => void;
  const pass = new Promise<void>((resolve) => { finished = resolve; });
  const vacuums = startPgliteVacuums(store, {
    startupDelayMs: 0,
    run: async (task) => {
      try {
        return await task();
      } finally {
        if (++done === tasks) finished();
      }
    },
  });
  await pass;
  await vacuums.stop();
}

test("only a table whose dead tuples passed the threshold is vacuumed", async () => {
  const store = await storeWithTables();
  try {
    await rewriteAll(store);
    await store.exec("UPDATE quiet SET pad = pad WHERE id <= 100");
    assert.equal(await dead(store, "rewritten"), 2000, "PGlite counts dead tuples");
    assert.deepEqual(await pgliteTablesToVacuum(store), ["public.rewritten"]);
    assert.deepEqual(await vacuumPgliteDeadTuples(store), { vacuumed: ["public.rewritten"], failed: [] });
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

test("a failing table is reported and the rest are still vacuumed", async () => {
  const store = await storeWithTables();
  try {
    await rewriteAll(store);
    await store.exec("UPDATE quiet SET pad = pad");
    // A table dropped between reading the counts and vacuuming it.
    const exec = store.exec.bind(store);
    store.exec = async (sql: string) => {
      if (sql.includes("public.rewritten")) throw new Error("gone");
      return exec(sql);
    };
    const pass = await vacuumPgliteDeadTuples(store);
    assert.deepEqual(pass.vacuumed, ["public.quiet"]);
    assert.deepEqual(pass.failed.map(({ table }) => table), ["public.rewritten"]);
  } finally {
    await store.close();
  }
});

test("system catalogs a temporary view churns are vacuumed", async () => {
  const store = await storeWithTables();
  try {
    // What each live-view subscription does.
    for (let index = 0; index < 20; index += 1) await store.exec("CREATE TEMP VIEW live_view AS SELECT 1 AS one; DROP VIEW live_view;");
    const tables = await pgliteTablesToVacuum(store, { thresholdTuples: 10, scaleFactor: 0 });
    assert.ok(tables.includes("pg_catalog.pg_depend"), `pg_depend is counted: ${tables.join(", ")}`);
    const pass = await vacuumPgliteDeadTuples(store, { thresholdTuples: 10, scaleFactor: 0 });
    assert.deepEqual(pass.failed, []);
    await store.query("SELECT pg_stat_force_next_flush()");
    const left = (await store.query<{ dead: number | string }>(
      "SELECT n_dead_tup AS dead FROM pg_stat_all_tables WHERE schemaname = 'pg_catalog' AND relname = 'pg_depend'",
    )).rows[0]!;
    assert.equal(Number(left.dead), 0);
  } finally {
    await store.close();
  }
});

test("a reopened store counts no dead tuples, and the startup pass still reclaims them", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pglite-vacuum-"));
  try {
    const before = await storeWithTables(dataDir);
    await rewriteAll(before);
    const grown = await pages(before, "rewritten");
    await before.close();

    const store = new PGliteStore(await PGlite.create(dataDir));
    // PGlite writes no statistics file when it closes, so the threshold sees nothing.
    assert.equal(await dead(store, "rewritten"), 0);
    assert.deepEqual(await pgliteTablesToVacuum(store), []);
    await runStartupPass(store);
    // The freed copies take the next rewrite, so the table does not grow.
    await rewriteAll(store);
    assert.equal(await pages(store, "rewritten"), grown);
    await store.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a table that grew past its statistics is analyzed by the pass after open", async () => {
  // refreshPlannerStatistics analyzes a table once it outgrows, by a tenth, the
  // page count its statistics describe. A plain VACUUM would record the grown
  // page count and keep the old statistics, so the projection would never
  // analyze the table again.
  const store = new PGliteStore(await PGlite.create());
  try {
    await store.exec(`
      CREATE TABLE appended (id int PRIMARY KEY, pad text);
      INSERT INTO appended SELECT g, repeat('x', 200) FROM generate_series(1, 300) g;
      ANALYZE appended;
      INSERT INTO appended SELECT g, repeat('x', 200) FROM generate_series(301, 3600) g;
    `);
    const statistics = async () => (await store.query<{ pages: number | string; analyzed_pages: number; highest: string }>(
      `SELECT pg_relation_size('appended') / current_setting('block_size')::int AS pages,
              (SELECT relpages FROM pg_class WHERE relname = 'appended') AS analyzed_pages,
              (SELECT histogram_bounds::text FROM pg_stats WHERE tablename = 'appended' AND attname = 'id') AS highest`,
    )).rows[0]!;
    const before = await statistics();
    assert.ok(Number(before.pages) > before.analyzed_pages * 10, "the table grew tenfold past its statistics");
    await runStartupPass(store);
    const after = await statistics();
    assert.equal(after.analyzed_pages, Number(after.pages));
    assert.notEqual(after.highest, before.highest, "the statistics describe the grown table");
    assert.ok(after.highest.includes("3600"), `the histogram reaches the new rows: ${after.highest}`);
  } finally {
    await store.close();
  }
});

test("periodic vacuums run on the queue they are given and stop cleanly", async () => {
  const store = await storeWithTables();
  const lane: string[] = [];
  const vacuums = startPgliteVacuums(store, {
    intervalMs: 10,
    startupDelayMs: 10,
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
