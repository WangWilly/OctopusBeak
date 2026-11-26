import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { amcheck } from "@electric-sql/pglite/contrib/amcheck";
import { live, type PGliteWithLive } from "@electric-sql/pglite/live";
import { createPGliteWorkScheduler } from "../../../electron/pglite-financial-rpc-server.ts";
import { repairCorruptIndexes } from "./catalog-repair.ts";
import { directoryBytes, fsyncDirectory } from "./data-dir-files.ts";
import {
  estimateLedgerReclaim,
  LEDGER_RECLAIM_COPIES_NEEDED,
  LEDGER_RECLAIM_HEADROOM_BYTES,
  reclaimLedgerSpace,
} from "./reclaim.ts";
import { PGliteStore } from "./transaction.ts";
import { vacuumPgliteTable } from "./vacuum.ts";

const MiB = 1024 * 1024;

/** Records every statement `exec` runs, and anything else the test logs beside them. */
class RecordingStore extends PGliteStore {
  readonly log: string[] = [];
  override async exec(query: string) {
    this.log.push(query);
    return super.exec(query);
  }
}

async function openStore(dataDir?: string): Promise<{ db: PGliteWithLive; store: RecordingStore }> {
  const db = await PGlite.create(dataDir, { extensions: { live, amcheck } }) as unknown as PGliteWithLive;
  return { db, store: new RecordingStore(db as unknown as PGlite) };
}

/** Resolves once `ready` holds, polling, or fails after two seconds. */
async function eventually(ready: () => boolean, message: string): Promise<void> {
  for (let waited = 0; !ready(); waited += 10) {
    if (waited > 2000) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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
    const estimate = await estimateLedgerReclaim(store);
    const largestCopy = Math.max(...estimate.tables.map(({ bytes, reclaimableBytes }) => bytes - reclaimableBytes));
    // The new copy beside the old files, and about two copies of WAL under full_page_writes.
    assert.equal(LEDGER_RECLAIM_COPIES_NEEDED, 3);
    assert.deepEqual(result, {
      status: "not-enough-space",
      requiredFreeBytes: 3 * largestCopy + LEDGER_RECLAIM_HEADROOM_BYTES,
      freeBytes: MiB,
      reclaimableBytes: estimate.reclaimableBytes,
    });
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
    let interactive: Promise<unknown> | undefined;
    store.log.length = 0;
    const result = await reclaimLedgerSpace(store, {
      runStep: (step) => scheduler.scheduleStep(async () => {
        const value = await step();
        // A click arriving while the first table's rewrite still holds the queue.
        if (!interactive && store.log.at(-1)?.startsWith("VACUUM")) {
          interactive = scheduler.schedule("interactive", async () => { store.log.push("interactive"); });
        }
        return value;
      }),
      onProgress: () => {},
    });
    await interactive;
    assert.equal(result.status, "reclaimed");
    const rewrites = store.log.filter((entry) => entry.startsWith("VACUUM") || entry === "interactive");
    assert.equal(rewrites.length, 3);
    assert.equal(rewrites[1], "interactive", "the click ran before the second table's rewrite");
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

test("each rewrite is checkpointed, and the folder is flushed after each catalog and at the end", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "octopus-beak-reclaim-check-"));
  try {
    const { db, store } = await openStore(dataDir);
    try {
      await bloat(store);
      for (let cycle = 0; cycle < 50; cycle += 1) {
        const query = await db.live.query("SELECT id FROM compact LIMIT 1", [], () => {});
        await query.unsubscribe();
      }
      store.log.length = 0;
      const result = await reclaimLedgerSpace(store, {
        minBytes: 0,
        minShare: 0,
        folderBytes: () => directoryBytes(dataDir),
        syncToDisk: async () => {
          store.log.push("sync");
          await fsyncDirectory(dataDir);
        },
      });
      assert.equal(result.status, "reclaimed");
      if (result.status !== "reclaimed") return;
      const steps = store.log.map((entry) => entry === "sync" ? "sync" : entry.split(" ").slice(0, entry.startsWith("VACUUM (") ? 3 : 2).join(" "));
      for (const [at, entry] of steps.entries()) {
        if (!entry.startsWith("VACUUM")) continue;
        assert.equal(steps[at + 1], "CHECKPOINT", `${store.log[at]} is checkpointed before the next table`);
        if (entry.startsWith("VACUUM FULL pg_catalog.")) assert.equal(steps[at + 2], "sync", `${store.log[at]} is flushed to the disk`);
      }
      assert.equal(steps.at(-1), "sync", "the last checkpoint is flushed too");
      assert.ok(result.folderBytesBefore !== null && result.folderBytesBefore > 0);
      assert.ok(result.folderBytesAfter !== null && result.folderBytesAfter > 0);
    } finally {
      await store.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a live query subscribed across the catalog rewrites hears commits during and after the reclaim", async () => {
  const { db, store } = await openStore();
  try {
    await bloat(store);
    const counts: number[] = [];
    const query = await db.live.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM compact",
      [],
      (results) => { counts.push(results.rows[0]!.count); },
    );
    let next = 5001;
    const commitAndHear = async (when: string) => {
      const id = next++;
      await store.exec(`INSERT INTO compact VALUES (${id}, 'new')`);
      await eventually(() => counts.at(-1) === id, `the live query republished ${when}`);
    };
    let rewritten = 0;
    const result = await reclaimLedgerSpace(store, {
      minBytes: 0,
      minShare: 0,
      runStep: async (step) => {
        const value = await step();
        // Between two tables, once pg_class, pg_attribute and pg_depend have new files.
        const log = store.log.join("\n");
        if (rewritten < 3 && store.log.at(-1) === "CHECKPOINT"
          && ["pg_class", "pg_attribute", "pg_depend"].every((catalog) => log.includes(`VACUUM FULL pg_catalog.${catalog}`))) {
          rewritten += 1;
          await commitAndHear("between two tables");
        }
        return value;
      },
    });
    assert.equal(result.status, "reclaimed");
    assert.ok(rewritten > 0, "a commit ran after the main catalogs were rewritten");
    await commitAndHear("after the reclaim");
    await query.unsubscribe();
  } finally {
    await store.close();
  }
});

test("a flush or checkpoint that fails ends the run as failed with what it reclaimed", async () => {
  {
    const { store } = await openStore();
    try {
      await bloat(store);
      const result = await reclaimLedgerSpace(store, { syncToDisk: async () => { throw new Error("EIO"); } });
      assert.equal(result.status, "failed", "the last flush failed");
      if (result.status !== "failed") return;
      assert.equal(result.tables.length, 2, "both tables were rewritten before it");
      assert.ok(result.bytesBefore > result.bytesAfter);
    } finally {
      await store.close();
    }
  }
  {
    const { store } = await openStore();
    try {
      await bloat(store);
      const exec = store.exec.bind(store);
      store.exec = async (query: string) => {
        if (query === "CHECKPOINT") throw new Error("could not write to file");
        return exec(query);
      };
      const result = await reclaimLedgerSpace(store);
      assert.equal(result.status, "failed");
      if (result.status !== "failed") return;
      assert.equal(result.tables.length, 1, "the first table was rewritten; its checkpoint failed and the next did not start");
      assert.ok(result.bytesBefore > result.bytesAfter);
    } finally {
      await store.close();
    }
  }
});
