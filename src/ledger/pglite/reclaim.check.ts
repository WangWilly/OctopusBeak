import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { amcheck } from "@electric-sql/pglite/contrib/amcheck";
import { live, type PGliteWithLive } from "@electric-sql/pglite/live";
import { createPGliteWorkScheduler } from "../../../electron/pglite-financial-rpc-server.ts";
import {
  PGLITE_FINANCIAL_CONTRACTS,
  RENDERER_FINANCIAL_OPERATIONS,
  WORKFLOW_FINANCIAL_OPERATIONS,
} from "../../lib/pglite-rpc/pglite-financial-contracts.ts";
import { repairCorruptIndexes } from "./catalog-repair.ts";
import { createLedgerReclaimer, estimateLedgerReclaim, reclaimLedgerSpace } from "./reclaim.ts";
import { PGliteStore } from "./transaction.ts";
import { vacuumPgliteTable } from "./vacuum.ts";

const MiB = 1024 * 1024;

async function openStore(dataDir?: string): Promise<{ db: PGliteWithLive; store: PGliteStore }> {
  const db = await PGlite.create(dataDir, { extensions: { live, amcheck } }) as unknown as PGliteWithLive;
  return { db, store: new PGliteStore(db as unknown as PGlite) };
}

/**
 * Three tables of about 1.5 MB of live rows each. `rewritten` had every row
 * rewritten unchanged, as the projection did before ADR 0153; `runs` had its
 * large record rewritten, as a sync run's record is on each stage event, so
 * its waste is in TOAST. Then the plain VACUUM the worker runs: no dead
 * tuples are left, but the space stays in each table.
 */
async function bloat(store: PGliteStore): Promise<void> {
  await store.exec(`
    CREATE TABLE rewritten (id int PRIMARY KEY, pad text);
    CREATE TABLE compact (id int PRIMARY KEY, pad text);
    CREATE TABLE runs (id int PRIMARY KEY, record text);
    ALTER TABLE runs ALTER COLUMN record SET STORAGE EXTERNAL;
    INSERT INTO rewritten SELECT g, repeat(md5(g::text), 8) FROM generate_series(1, 5000) g;
    INSERT INTO compact SELECT g, repeat(md5(g::text), 8) FROM generate_series(1, 5000) g;
    INSERT INTO runs SELECT g, repeat(md5(g::text), 1000) FROM generate_series(1, 40) g;
  `);
  for (let round = 0; round < 6; round += 1) await store.exec("UPDATE rewritten SET pad = pad");
  for (let round = 0; round < 8; round += 1) await store.exec("UPDATE runs SET record = record || ''");
  for (const table of ["public.rewritten", "public.compact", "public.runs"]) await vacuumPgliteTable(store, table);
}

/** Row count and digest of every row of a table. */
async function digest(store: PGliteStore, table: string): Promise<string> {
  const { rows } = await store.query<{ count: number; digest: string }>(
    `SELECT count(*)::int AS count, md5(string_agg(t::text, ',' ORDER BY t::text)) AS digest FROM ${table} t`,
  );
  return `${rows[0]!.count}:${rows[0]!.digest}`;
}

const STORE_TABLES = ["public.compact", "public.rewritten", "public.runs"] as const;

test("the estimate picks the tables whose rewrite frees space, TOAST included, and leaves compact ones alone", async () => {
  const { store } = await openStore();
  try {
    await bloat(store);
    // A live subscription creates and drops a temporary view and its triggers in the catalog.
    for (let cycle = 0; cycle < 4000; cycle += 1) {
      await store.exec("CREATE TEMP VIEW churn AS SELECT a.id, a.pad, b.pad AS other FROM compact a JOIN rewritten b USING (id); DROP VIEW churn;");
    }
    await vacuumPgliteTable(store, "pg_catalog.pg_depend");
    const estimate = await estimateLedgerReclaim(store, { freeBytes: async () => 10 * 1024 * MiB });
    const picked = estimate.tables.map(({ table }) => table);
    assert.ok(picked.includes("public.rewritten"), "a table of rewritten rows is picked");
    assert.ok(picked.includes("public.runs"), "a table whose waste is in TOAST is picked");
    assert.ok(picked.includes("pg_catalog.pg_depend"), "a churned catalog, whose waste is in its indexes, is picked");
    assert.ok(!picked.includes("public.compact"), "a compact table is left alone");
    const bytes = estimate.tables.map(({ bytes }) => bytes);
    assert.deepEqual(bytes, [...bytes].sort((a, b) => a - b), "smallest first");
    assert.equal(estimate.freeBytes, 10 * 1024 * MiB);
    assert.ok(estimate.requiredFreeBytes > Math.max(...estimate.tables.map((table) => table.bytes - table.reclaimableBytes)));
  } finally {
    await store.close();
  }
});

test("a reclaim shrinks the picked tables and leaves every row as it was", async () => {
  const { store } = await openStore();
  try {
    await bloat(store);
    const before = await Promise.all(STORE_TABLES.map((table) => digest(store, table)));
    const progress: string[] = [];
    const result = await reclaimLedgerSpace(store, {
      onProgress: ({ index, count, table }) => progress.push(`${index}/${count} ${table}`),
    });
    assert.equal(result.status, "reclaimed");
    if (result.status !== "reclaimed") return;
    assert.deepEqual(result.tables.map(({ table }) => table).sort(), ["public.rewritten", "public.runs"]);
    for (const { table, bytesBefore, bytesAfter } of result.tables) {
      assert.ok(bytesAfter < bytesBefore / 2, `${table} shrank from ${bytesBefore} to ${bytesAfter}`);
    }
    assert.equal(progress.length, 2);
    assert.match(progress[0]!, /^1\/2 /u);
    assert.deepEqual(await Promise.all(STORE_TABLES.map((table) => digest(store, table))), before);
    assert.deepEqual(await reclaimLedgerSpace(store), { status: "nothing-to-reclaim" }, "a second reclaim finds nothing");
  } finally {
    await store.close();
  }
});

test("a reclaim refuses before it starts when the disk cannot hold the largest new copy", async () => {
  const { store } = await openStore();
  try {
    await bloat(store);
    const before = await digest(store, "public.rewritten");
    const result = await reclaimLedgerSpace(store, { freeBytes: async () => MiB });
    assert.equal(result.status, "not-enough-space");
    if (result.status === "not-enough-space") assert.ok(result.requiredFreeBytes > result.freeBytes);
    assert.equal((await estimateLedgerReclaim(store)).tables.length, 2, "nothing was rewritten");
    assert.equal(await digest(store, "public.rewritten"), before);
  } finally {
    await store.close();
  }
});

test("an abort stops the reclaim between two tables", async () => {
  const { store } = await openStore();
  try {
    await bloat(store);
    const controller = new AbortController();
    const result = await reclaimLedgerSpace(store, {
      signal: controller.signal,
      onProgress: ({ index }) => { if (index === 1) queueMicrotask(() => controller.abort()); },
    });
    assert.equal(result.status, "stopped");
    if (result.status === "stopped") assert.equal(result.tables.length, 1, "the table being rewritten finishes; the next does not start");
    assert.equal((await estimateLedgerReclaim(store)).tables.length, 1);
  } finally {
    await store.close();
  }
});

test("queued interactive work runs between two tables of a reclaim on the worker's scheduler", async () => {
  const { store } = await openStore();
  try {
    await bloat(store);
    const scheduler = createPGliteWorkScheduler();
    const order: string[] = [];
    let interactive: Promise<unknown> | undefined;
    const result = await reclaimLedgerSpace(store, {
      runStep: (step) => scheduler.scheduleStep(step),
      onProgress: ({ index, table }) => {
        order.push(`rewrite ${index} ${table}`);
        // A click arriving while the first table is rewritten.
        interactive ??= scheduler.schedule("interactive", async () => {
          order.push("interactive");
          return store.query("SELECT count(*) FROM compact");
        });
      },
    });
    await interactive;
    assert.equal(result.status, "reclaimed");
    assert.equal(order.length, 3);
    assert.equal(order[1], "interactive", "the click ran before the second table's rewrite");
  } finally {
    await store.close();
  }
});

test("after a reclaim of churned catalogs the store reopens, every index checks clean, and live queries work", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "octopus-beak-reclaim-check-"));
  try {
    let { db, store } = await openStore(dataDir);
    await bloat(store);
    for (let cycle = 0; cycle < 400; cycle += 1) {
      const query = await db.live.query("SELECT id FROM compact ORDER BY id LIMIT 5", [], () => {});
      await query.unsubscribe();
    }
    // No floors: every table, every catalog included, is rewritten.
    const result = await reclaimLedgerSpace(store, { minBytes: 0, minShare: 0 });
    assert.equal(result.status, "reclaimed");
    if (result.status === "reclaimed") {
      for (const catalog of ["pg_catalog.pg_class", "pg_catalog.pg_attribute", "pg_catalog.pg_depend", "pg_catalog.pg_type", "pg_catalog.pg_rewrite"]) {
        assert.ok(result.tables.some(({ table }) => table === catalog), `${catalog} was rewritten: ${result.tables.map(({ table }) => table).join(", ")}`);
      }
    }
    const before = await Promise.all(STORE_TABLES.map((table) => digest(store, table)));
    await store.close();

    ({ db, store } = await openStore(dataDir));
    assert.deepEqual(await repairCorruptIndexes(db as unknown as PGlite), { status: "intact" });
    assert.deepEqual(await Promise.all(STORE_TABLES.map((table) => digest(store, table))), before);
    let notified = 0;
    const query = await db.live.query<{ count: number }>("SELECT count(*)::int AS count FROM compact", [], () => { notified += 1; });
    assert.equal(query.initialResults.rows[0]!.count, 5000);
    await store.exec("INSERT INTO compact VALUES (5001, 'new')");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await query.unsubscribe();
    assert.ok(notified > 0, "a live query hears a write after the catalogs were rewritten");
    await store.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the worker runs one reclaim at a time, and its progress and stop reach the running one", async () => {
  const { store } = await openStore();
  try {
    await bloat(store);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const reclaimer = createLedgerReclaimer(store, {
      // Holds the first rewrite, which starts once progress is reported, until the test has looked at it.
      runStep: async (step) => {
        if (reclaimer.progress() !== null) await held;
        return step();
      },
    });
    assert.equal(reclaimer.progress(), null);
    assert.equal(reclaimer.stop(), false, "nothing to stop");
    const running = reclaimer.reclaim();
    while (reclaimer.progress() === null) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual({ ...reclaimer.progress(), table: undefined }, { index: 1, count: 2, table: undefined, bytesBefore: 0, bytesAfter: 0 });
    assert.deepEqual(await reclaimer.reclaim(), { status: "already-running" });
    assert.equal(reclaimer.stop(), true);
    release();
    const result = await running;
    assert.equal(result.status, "stopped");
    assert.equal(reclaimer.progress(), null);
  } finally {
    await store.close();
  }
});

test("the reclaim operations are host-only, and the reclaim itself queues its own steps", () => {
  const operations = ["financial.ledger.reclaimEstimate", "financial.ledger.reclaim", "financial.ledger.reclaimProgress", "financial.ledger.reclaimStop"] as const;
  for (const operation of operations) {
    assert.equal((RENDERER_FINANCIAL_OPERATIONS as readonly string[]).includes(operation), false, `${operation} has no renderer route`);
    assert.equal(WORKFLOW_FINANCIAL_OPERATIONS.has(operation), false, `${operation} is closed to workflows`);
  }
  assert.equal(PGLITE_FINANCIAL_CONTRACTS["financial.ledger.reclaim"].lane, "background-steps");
  assert.equal(PGLITE_FINANCIAL_CONTRACTS["financial.ledger.reclaimEstimate"].lane, "background-steps");
});
