/**
 * The worker's chunked compaction (ADR 0154) leaves a store written before
 * ADR 0152 as one `compactLedger` transaction leaves it, resumes after a
 * stop or crash between chunks, rolls back a failing chunk alone, lets
 * queued work run between chunks, and finds nothing the second time.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createPGliteWorkScheduler } from "../../../electron/pglite-financial-rpc-server.ts";
import {
  COMPACTED_TABLES,
  COMPACTION_READERS,
  compactLedger,
  readCompactionReaders,
  readersOf,
  type CompactedTable,
  type LedgerCompactionResult,
} from "./compaction.ts";
import {
  createLedgerCompactor,
  domainChunks,
  FAILURE_RECORD,
  planLedgerCompactionJob,
  runLedgerCompaction,
  SPACE_MARKER,
  type LedgerCompactionJobOptions,
  type LedgerCompactionJobResult,
} from "./compaction-job.ts";
import { MANIFEST, PHASE_A, phaseCMarkedSql, type PhaseATable } from "./compaction-plan.ts";
import { legacyStore, snapshot } from "./compaction-fixtures.ts";
import { canonicalState } from "./canonical-state-fixture.ts";
import { PGliteStore } from "./transaction.ts";
import { backUpLedger } from "./data-dir-backup.ts";
import {
  PGLITE_FINANCIAL_CONTRACTS,
  RENDERER_FINANCIAL_OPERATIONS,
  WORKFLOW_FINANCIAL_OPERATIONS,
} from "../../lib/pglite-rpc/pglite-financial-contracts.ts";

const MARKERS = "pglite_operational_migrations";
const COMPACTION_MARKERS = ["ledger-compaction-domain-counts-v1", "ledger-compaction-records-v1"];
/** Every table may be rewritten, so the reclaim runs on a fixture this small. */
const REWRITE_ALL = { minBytes: 0, minShare: 0 } as const;

async function copyOf(database: PGlite): Promise<PGliteStore> {
  return new PGliteStore(await PGlite.create({ loadDataDir: await database.dumpDataDir("none") }));
}

/** An old-shaped store, and a copy of it compacted by `compactLedger` in one transaction. */
async function legacyAndCompactedTwin(): Promise<Readonly<{ store: PGliteStore; twin: PGliteStore; single: LedgerCompactionResult }>> {
  const database = await PGlite.create();
  const { store } = await legacyStore(database);
  const twin = await copyOf(database);
  const single = await compactLedger(twin);
  assert.equal(single.status, "compacted");
  return { store, twin, single };
}

function finished(result: LedgerCompactionJobResult): Extract<LedgerCompactionJobResult, { status: "compacted" }> {
  assert.equal(result.status, "compacted", JSON.stringify(result));
  return result as Extract<LedgerCompactionJobResult, { status: "compacted" }>;
}

async function markers(store: PGliteStore): Promise<string[]> {
  const { rows } = await store.query<{ migration_key: string }>(
    `SELECT migration_key FROM ${MARKERS} WHERE migration_key LIKE 'ledger-compaction%' ORDER BY 1`);
  return rows.map(({ migration_key }) => migration_key);
}

async function rowCounts(store: PGliteStore): Promise<Record<string, number>> {
  const { rows } = await store.query<{ table_name: string; rows: number }>(
    [...COMPACTED_TABLES, MANIFEST].map((table) => `SELECT '${table}' AS table_name, count(*)::int AS rows FROM ${table}`).join("\nUNION ALL\n"),
  );
  return Object.fromEntries(rows.map((row) => [row.table_name, row.rows]));
}

/** Every table's rows but the markers', which hold when each was written. */
async function rows(store: PGliteStore): Promise<Map<string, string>> {
  const tables = await snapshot(store);
  tables.delete(`public.${MARKERS}`);
  return tables;
}

/** The store's canonical state with each reader's answer, the markers left out. */
async function state(store: PGliteStore): Promise<Record<string, readonly string[]>> {
  const compared = await canonicalState(store, Object.fromEntries(Object.entries(COMPACTION_READERS).map(([reader, sql]) =>
    [`reader ${reader}`, `SELECT to_jsonb(answer) AS row FROM (${sql}) answer`])));
  delete compared[MARKERS];
  return compared;
}

/** The job's store and the one-transaction twin hold the same rows, counts and state. */
async function assertSameAsTwin(store: PGliteStore, twin: PGliteStore): Promise<void> {
  assert.deepEqual(await rowCounts(store), await rowCounts(twin));
  assert.deepEqual(await rows(store), await rows(twin));
  assert.deepEqual(await state(store), await state(twin));
}

const sum = (removed: Readonly<Record<CompactedTable, number>>) => Object.values(removed).reduce((total, count) => total + count, 0);

test("no reader or phase A selection reads through a view, so naming a table finds every reader of it", async () => {
  // A view hides the tables it reads: `\bassertion_provenance\b` does not match `derived_assertion_provenance`.
  const { store } = await legacyStore();
  try {
    const { rows } = await store.query<{ name: string }>(
      `SELECT relname AS name FROM pg_class
        WHERE relkind IN ('v', 'm') AND relnamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)`);
    const views = new Set(rows.map(({ name }) => name));
    assert.ok(views.has("derived_assertion_provenance"), "the store's views are listed");
    const sqls: Record<string, string> = {
      ...COMPACTION_READERS,
      ...Object.fromEntries(Object.entries(PHASE_A).map(([table, { marked }]) => [`phase A ${table}`, marked])),
    };
    const named = Object.entries(sqls).flatMap(([name, sql]) =>
      [...new Set(sql.toLowerCase().match(/[a-z_][a-z0-9_]*/gu))].filter((word) => views.has(word)).map((view) => `${name}: ${view}`));
    assert.deepEqual(named, []);
  } finally {
    await store.close();
  }
});

test("the chunk plan keeps tables that share a selection or reader together, and chains that share a capture", async () => {
  // Every reader reads a compacted table, so a chunk's readers are found by name.
  assert.deepEqual(readersOf([...COMPACTED_TABLES, MANIFEST]).sort(), Object.keys(COMPACTION_READERS).sort());
  const tables = domainChunks();
  assert.deepEqual(tables.flat().sort(), (Object.keys(PHASE_A) as PhaseATable[]).sort(), "every phase A table once");
  assert.deepEqual(tables.filter((chunk) => chunk.length > 1), [["einvoice_revision_observations", "einvoice_revision_events"]]);

  const { store } = await legacyStore();
  try {
    const plan = await planLedgerCompactionJob(store);
    const chains = plan.chunks.filter((chunk) => chunk.kind === "chains");
    assert.ok(chains.length >= 5, `one chunk or more per synced source (${chains.length})`);
    // The card command's second capture stores a statement record under another kind: both kinds are one chunk.
    const card = chains.find((chunk) => chunk.chains.some(({ recordKind }) => recordKind === "fubon-credit-card-statement"));
    assert.ok(card && card.chains.length > 1, JSON.stringify(card));
    const keys = chains.flatMap((chunk) => chunk.chains.map(({ subject, recordKind }) => `${subject}/${recordKind}`));
    assert.equal(new Set(keys).size, keys.length, "no chain is in two chunks");
    // No capture holds copies of two chunks.
    const chunkOf = new Map<string, number>(chains.flatMap((chunk, at) => chunk.chains.map(({ subject, recordKind }) => [`${subject}/${recordKind}`, at] as const)));
    const { rows: held } = await store.query<{ capture: string; chain: string }>(
      `SELECT DISTINCT encode(capture_id, 'hex') AS capture, encode(source_subject_id, 'hex') || '/' || record_kind AS chain
         FROM source_records WHERE source_subject_id IS NOT NULL AND occurrence_key IS NOT NULL`);
    const chunksOfCapture = new Map<string, Set<number>>();
    for (const { capture, chain } of held) chunksOfCapture.set(capture, (chunksOfCapture.get(capture) ?? new Set()).add(chunkOf.get(chain)!));
    assert.deepEqual([...chunksOfCapture.values()].filter((chunks) => chunks.size > 1), []);
  } finally {
    await store.close();
  }
});

test("the chunked job leaves the store as one compactLedger transaction does, and returns the space", async () => {
  const { store, twin, single } = await legacyAndCompactedTwin();
  try {
    assert.equal(single.status, "compacted");
    let steps = 0;
    const result = finished(await runLedgerCompaction(store, {
      runStep: (step) => { steps += 1; return step(); },
      reclaim: REWRITE_ALL,
    }));
    assert.deepEqual(result.removed, single.removed);
    assert.equal(result.manifests, single.manifests);
    assert.equal(result.chunks.done, result.chunks.count);
    assert.ok(result.chunks.count > domainChunks().length, "phases B and C ran in several chunks");
    // The plan, each chunk, the markers, then the reclaim's own steps.
    assert.ok(steps > 1 + result.chunks.count + 1);
    await assertSameAsTwin(store, twin);
    assert.deepEqual(await markers(store), [...COMPACTION_MARKERS, SPACE_MARKER].sort());

    assert.equal(result.reclaim.status, "reclaimed");
    if (result.reclaim.status !== "reclaimed") return;
    const compacted = new Set([...COMPACTED_TABLES, MANIFEST].map((table) => `public.${table}`));
    assert.ok(result.reclaim.tables.length > 0);
    for (const { table } of result.reclaim.tables) assert.ok(compacted.has(table), `${table} is a compacted table`);
  } finally {
    await store.close();
    await twin.close();
  }
});

test("a run stopped or crashed between chunks resumes to the same store", async () => {
  const { store, twin, single } = await legacyAndCompactedTwin();
  try {
    assert.equal(single.status, "compacted");
    const before = await rowCounts(store);
    const runs: LedgerCompactionJobResult[] = [];

    // The app quits before the third chunk's step runs.
    let steps = 0;
    runs.push(await runLedgerCompaction(store, {
      runStep: (step) => (steps += 1) === 4 ? Promise.reject(new Error("The app quit.")) : step(),
    }));
    assert.equal(runs[0]!.status, "failed");
    assert.deepEqual(runs[0]!.status === "failed" && runs[0]!.failure, { reason: "error", message: "The app quit." });
    assert.deepEqual(runs[0]!.status === "failed" && runs[0]!.chunks.done, 2);

    // Settings stops it before its fifth chunk, and then inside its sixth.
    const controller = new AbortController();
    runs.push(await runLedgerCompaction(store, {
      signal: controller.signal,
      onProgress: (progress) => { if (progress.phase === "compacting" && progress.index === 5) controller.abort(); },
    }));
    assert.equal(runs[1]!.status, "stopped");
    const inside = new AbortController();
    steps = 0;
    runs.push(await runLedgerCompaction(store, {
      signal: inside.signal,
      runStep: (step) => {
        if ((steps += 1) === 7) inside.abort(new Error("Settings closed."));
        return step();
      },
    }));
    assert.equal(runs[2]!.status, "stopped");
    assert.deepEqual(runs[2]!.status === "stopped" && runs[2]!.chunks.done, 5);
    assert.deepEqual(await markers(store), [], "no marker before every chunk is done");
    const partway = await rowCounts(store);
    assert.ok(partway.canonical_credit_card_transaction_details! < before.canonical_credit_card_transaction_details!, "committed chunks stay");

    runs.push(finished(await runLedgerCompaction(store)));
    // Each row was removed once, by whichever run committed its chunk.
    const removed = Object.fromEntries(COMPACTED_TABLES.map((table) =>
      [table, runs.reduce((total, run) => total + ("removed" in run ? run.removed[table] : 0), 0)]));
    assert.deepEqual(removed, single.removed);
    await assertSameAsTwin(store, twin);
  } finally {
    await store.close();
    await twin.close();
  }
});

const seqByCapture = (alias: string) =>
  `JOIN source_captures ${alias}_capture ON ${alias}_capture.capture_id = ${alias}.capture_id
   JOIN canonical_commits ${alias}_commit ON ${alias}_commit.commit_id = ${alias}_capture.commit_id`;

/** Removes the latest lifecycle row of every purchase, which three readers see. */
const LATEST_LIFECYCLE = `SELECT domain.ctid AS row_ctid,
    ROW_NUMBER() OVER (PARTITION BY domain.transaction_id ORDER BY domain_commit.commit_sequence DESC, domain.lifecycle_event_id DESC) = 1 AS repeats
  FROM canonical_credit_card_transaction_lifecycle domain ${seqByCapture("domain")}`;

/** Removes, within the running chunk only, each count row that raised its partition's maximum. */
const RAISING_COUNTS_IN_CHUNK = `SELECT count_row.ctid AS row_ctid,
    count_row.occurrence_count > MIN(count_row.occurrence_count) OVER (PARTITION BY coverage.source_subject_id, coverage.record_kind,
      coverage.scope_key, coverage.contract_version, count_row.partition_date, count_row.fingerprint) AS repeats
  FROM source_occurrence_group_counts count_row
  JOIN source_occurrence_group_coverages coverage ON coverage.coverage_id = count_row.coverage_id
 WHERE (coverage.source_subject_id, coverage.record_kind) IN (SELECT source_subject_id, record_kind FROM ledger_compaction_chains)`;

test("a defect planted in one chunk rolls back that chunk alone and is recorded", async () => {
  const { store, twin } = await legacyAndCompactedTwin();
  try {
    const readers = await readCompactionReaders(store);
    const before = await rowCounts(store);
    const failed = await runLedgerCompaction(store, { selections: { canonical_credit_card_transaction_lifecycle: LATEST_LIFECYCLE } });
    assert.equal(failed.status, "failed", JSON.stringify(failed));
    if (failed.status !== "failed") return;
    assert.deepEqual(failed.chunk, { kind: "domain", tables: ["canonical_credit_card_transaction_lifecycle"] });
    assert.deepEqual(failed.failure, { reason: "reader-changed", readers: ["cardLifecycleLatest", "cardLifecycleLatestByAccount", "cardLifecycleHistory"] });
    // The details chunk before it committed; the lifecycle chunk and every later one changed nothing.
    assert.equal(failed.chunks.done, 1);
    const after = await rowCounts(store);
    assert.equal(after.canonical_credit_card_transaction_details, before.canonical_credit_card_transaction_details! - failed.removed.canonical_credit_card_transaction_details);
    assert.ok(failed.removed.canonical_credit_card_transaction_details > 0);
    for (const table of [...COMPACTED_TABLES.filter((name) => name !== "canonical_credit_card_transaction_details"), MANIFEST])
      assert.equal(after[table], before[table], `${table} is unchanged`);
    assert.deepEqual(await readCompactionReaders(store), readers, "the committed chunk kept every answer");
    assert.deepEqual(await markers(store), []);

    // A count defect inside one chains chunk: only the chunk-scoped count readers can see it.
    const counted = await runLedgerCompaction(store, { selections: { source_occurrence_group_counts: RAISING_COUNTS_IN_CHUNK } });
    assert.equal(counted.status, "failed", JSON.stringify(counted));
    if (counted.status !== "failed") return;
    assert.equal(counted.chunk?.kind, "chains");
    assert.deepEqual(counted.failure, { reason: "reader-changed", readers: ["occurrenceCountMaxima", "occurrenceCountHistory"] });
    // Chains chunks run in subject id order, so the failing one may be the first of them.
    assert.ok(counted.chunks.done >= domainChunks().length, "the domain chunks committed");
    assert.deepEqual(await readCompactionReaders(store), readers);

    // A selection that reaches past its chunk is refused before it deletes: the chunk's readers would not see those rows.
    const wide = await runLedgerCompaction(store, { selections: { source_occurrence_group_counts: phaseCMarkedSql() } });
    assert.equal(wide.status, "failed", JSON.stringify(wide));
    assert.equal(wide.status === "failed" && wide.failure.reason, "outside-chunk");
    assert.deepEqual(await readCompactionReaders(store), readers);

    finished(await runLedgerCompaction(store));
    await assertSameAsTwin(store, twin);
  } finally {
    await store.close();
    await twin.close();
  }
});

test("queued work runs between two chunks", async () => {
  const { store } = await legacyStore();
  try {
    const scheduler = createPGliteWorkScheduler();
    const order: string[] = [];
    let steps = 0;
    const runStep: LedgerCompactionJobOptions["runStep"] = (step) => scheduler.scheduleStep(async () => {
      steps += 1;
      order.push(`step ${steps}`);
      // Queued while the first chunk holds the ledger, as a page read would be.
      if (steps === 2) {
        void scheduler.schedule("background", async () => {
          await store.query("SELECT count(*) FROM source_records");
          order.push("page read");
        });
      }
      return step();
    });
    finished(await runLedgerCompaction(store, { runStep }));
    assert.deepEqual(order.slice(0, 4), ["step 1", "step 2", "page read", "step 3"]);
  } finally {
    await store.close();
  }
});

test("a finished run finds nothing the second time, even without its markers", async () => {
  const { store } = await legacyStore();
  try {
    finished(await runLedgerCompaction(store));
    const compacted = await rows(store);
    assert.deepEqual(await runLedgerCompaction(store), { status: "already-compacted" });

    await store.query(`DELETE FROM ${MARKERS} WHERE migration_key LIKE 'ledger-compaction%'`);
    const again = finished(await runLedgerCompaction(store));
    assert.equal(sum(again.removed), 0);
    assert.equal(again.manifests, 0);
    assert.deepEqual(await rows(store), compacted);
    assert.deepEqual(await markers(store), [...COMPACTION_MARKERS, SPACE_MARKER].sort());

    // A store compacted in one transaction only has its space returned.
    await store.query(`DELETE FROM ${MARKERS} WHERE migration_key = $1`, [SPACE_MARKER]);
    const reclaimOnly = finished(await runLedgerCompaction(store));
    assert.deepEqual(reclaimOnly.chunks, { done: 0, count: 0 });
    assert.deepEqual(await markers(store), [...COMPACTION_MARKERS, SPACE_MARKER].sort());
  } finally {
    await store.close();
  }
});

test("the compactor runs one compaction at a time, and reports, stops and remembers it", async () => {
  const { store } = await legacyStore();
  try {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let steps = 0;
    const compactor = createLedgerCompactor(store, {
      runStep: async (step) => {
        // Step 1 clears a recorded failure and step 2 plans; step 3 is the first chunk.
        if ((steps += 1) === 3) await held;
        return step();
      },
    });
    assert.deepEqual(await compactor.status(), { running: false, last: null });
    assert.equal(compactor.stop(), false, "nothing to stop");
    const running = compactor.compact();
    const progress = async () => {
      const status = await compactor.status();
      return status.running ? status.progress : null;
    };
    while (await progress() === null) await new Promise((resolve) => setTimeout(resolve, 5));
    const first = (await progress())!;
    assert.deepEqual(first.phase === "compacting" && [first.index, first.removedRows], [1, 0]);
    assert.deepEqual(await compactor.compact(), { status: "already-running" });
    assert.equal(compactor.stop(), true);
    release();
    const result = await running;
    assert.equal(result.status, "stopped", JSON.stringify(result));
    assert.deepEqual(await compactor.status(), { running: false, last: result }, "how it ended stays for a page opened later");
  } finally {
    await store.close();
  }
});

test("a stop while the space returns reports the run stopped, not compacted", async () => {
  const { store } = await legacyStore();
  try {
    const controller = new AbortController();
    const result = await runLedgerCompaction(store, {
      signal: controller.signal,
      reclaim: REWRITE_ALL,
      onProgress: (progress) => { if (progress.phase === "reclaiming") controller.abort(); },
    });
    assert.equal(result.status, "stopped", JSON.stringify(result));
    assert.ok(result.status === "stopped" && sum(result.removed) > 0, "the chunks committed before the stop");
    assert.deepEqual(await markers(store), COMPACTION_MARKERS, "the space marker waits for a reclaim that ends");
    const resumed = finished(await runLedgerCompaction(store, { reclaim: REWRITE_ALL }));
    assert.deepEqual(resumed.chunks, { done: 0, count: 0 }, "the next run only returns the space");
  } finally {
    await store.close();
  }
});

test("a chunk that fails its own verification fails, even when a stop came meanwhile", async () => {
  const { store } = await legacyStore();
  try {
    const controller = new AbortController();
    const result = await runLedgerCompaction(store, {
      signal: controller.signal,
      selections: { canonical_credit_card_transaction_lifecycle: LATEST_LIFECYCLE },
      // Stop is pressed while the lifecycle chunk runs, after its own last abort check.
      runStep: async (step) => {
        const value = await step();
        controller.abort();
        return value;
      },
    });
    assert.equal(result.status, "stopped", "an abort before the chunk throws is a stop");
    const late = new AbortController();
    const failed = await runLedgerCompaction(store, {
      signal: late.signal,
      selections: { canonical_credit_card_transaction_lifecycle: LATEST_LIFECYCLE },
      runStep: async (step) => {
        try {
          return await step();
        } catch (error) {
          late.abort();
          throw error;
        }
      },
    });
    assert.equal(failed.status, "failed", JSON.stringify(failed));
    assert.equal(failed.status === "failed" && failed.failure.reason, "reader-changed");
  } finally {
    await store.close();
  }
});

/** A store in a folder of its own, as the worker's is, with its folder. */
async function legacyStoreInFolder(): Promise<Readonly<{ store: PGliteStore; dataDir: string; root: string }>> {
  const root = await mkdtemp(join(tmpdir(), "octopus-beak-compaction-job-check-"));
  const dataDir = join(root, "ledger");
  const { store } = await legacyStore(await PGlite.create(dataDir));
  return { store, dataDir, root };
}

test("a backup asked for is a consistent copy, taken as one step before the first chunk", async () => {
  const { store, dataDir, root } = await legacyStoreInFolder();
  try {
    const before = await rowCounts(store);
    const order: string[] = [];
    let backupPath: string | undefined;
    const compactor = createLedgerCompactor(store, {
      runStep: (step) => step(),
      reclaim: REWRITE_ALL,
      backup: async (context) => {
        order.push("backup");
        backupPath = await backUpLedger(store, dataDir, { freeBytes: async () => Number.MAX_SAFE_INTEGER, exists: existsSync, ...context });
      },
    });
    const result = await compactor.compact(undefined, { backup: true });
    assert.equal(result.status, "compacted", JSON.stringify(result));
    order.push("done");
    assert.deepEqual(order, ["backup", "done"]);
    assert.ok(backupPath?.startsWith(`${dataDir}.before-compaction-`), "the copy sits beside the folder");
    assert.deepEqual((await readdir(root)).sort(), ["ledger", backupPath!.slice(root.length + 1)].sort());

    const copy = new PGliteStore(await PGlite.create(backupPath!));
    try {
      assert.deepEqual(await rowCounts(copy), before, "the copy holds every row as it was before the first chunk");
      assert.deepEqual(await markers(copy), []);
    } finally {
      await copy.close();
    }
    assert.notDeepEqual(await rowCounts(store), before, "the ledger itself was compacted");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the backup step comes after the plan and before every chunk, and its failure stops the run there", async () => {
  const { store } = await legacyStore();
  try {
    const before = await rowCounts(store);
    const seen: string[] = [];
    const result = await runLedgerCompaction(store, {
      onProgress: (progress) => seen.push(progress.phase),
      backup: async () => {
        assert.deepEqual(await rowCounts(store), before, "no chunk ran before the backup");
        throw new Error("The disk is full.");
      },
    });
    assert.equal(result.status, "failed", JSON.stringify(result));
    assert.deepEqual(result.status === "failed" && result.failure, { reason: "backup", backup: "copy-failed" });
    assert.deepEqual(seen, ["backing-up"]);
    assert.deepEqual(await rowCounts(store), before, "nothing was compacted");

    const compactor = createLedgerCompactor(store);
    const unavailable = await compactor.compact(undefined, { backup: true });
    assert.deepEqual(unavailable.status === "failed" && unavailable.failure, { reason: "backup", backup: "unavailable" },
      "a worker without a folder of its own cannot back up, so it does not compact either");
    assert.deepEqual(await rowCounts(store), before);
  } finally {
    await store.close();
  }
});

test("a stop during the backup, as when the app quits, ends the run as stopped before any chunk", async () => {
  const { store } = await legacyStore();
  try {
    const before = await rowCounts(store);
    const controller = new AbortController();
    const result = await runLedgerCompaction(store, {
      signal: controller.signal,
      backup: async ({ signal }) => {
        controller.abort();
        signal?.throwIfAborted();
      },
    });
    assert.equal(result.status, "stopped", JSON.stringify(result));
    assert.deepEqual(await rowCounts(store), before, "nothing was compacted");
  } finally {
    await store.close();
  }
});

test("a failed run is recorded in the ledger and shown after a restart, until the owner starts again", async () => {
  const root = await mkdtemp(join(tmpdir(), "octopus-beak-compaction-job-check-"));
  const dataDir = join(root, "ledger");
  try {
    const { store } = await legacyStore(await PGlite.create(dataDir));
    let steps = 0;
    const failing = createLedgerCompactor(store, {
      // The app's worker fails the second chunk's step.
      runStep: (step) => (steps += 1) === 4 ? Promise.reject(new Error("The worker stopped.")) : step(),
    });
    const failed = await failing.compact();
    assert.equal(failed.status, "failed", JSON.stringify(failed));
    await store.close();

    // A restart: a new worker opens the same folder, with a compactor that has run nothing.
    const reopened = new PGliteStore(await PGlite.create(dataDir));
    try {
      const compactor = createLedgerCompactor(reopened, { reclaim: REWRITE_ALL });
      const status = await compactor.status();
      assert.equal(status.running, false);
      const last = !status.running ? status.last : null;
      assert.equal(last?.status, "failed-earlier");
      assert.deepEqual(last?.status === "failed-earlier" && [last.removedRows > 0, last.chunks.done, last.backup], [true, 1, false]);
      const { rows: [row] } = await reopened.query<{ schema_signature: string }>(
        `SELECT schema_signature FROM ${MARKERS} WHERE migration_key = $1`, [FAILURE_RECORD]);
      assert.doesNotMatch(row!.schema_signature, /canonical_|source_|worker stopped/u, "the record keeps counts, no table names or messages");
      // Clear, plan, two chunks, then the record of the failure; nothing retried it.
      assert.equal(steps, 5);

      finished(await compactor.compact());
      assert.equal((await reopened.query(`SELECT 1 FROM ${MARKERS} WHERE migration_key = $1`, [FAILURE_RECORD])).rows.length, 0,
        "starting again cleared it");
      const after = await compactor.status();
      assert.equal(!after.running && after.last?.status, "compacted");
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the compaction operations are host-only, and the compaction queues its own steps", () => {
  const operations = [
    "financial.canonical.compact",
    "financial.canonical.compactionStatus",
    "financial.canonical.compactionStop",
    "financial.canonical.compactionBackupRoom",
    "financial.canonical.compactionPlan",
  ] as const;
  for (const operation of operations) {
    assert.equal((RENDERER_FINANCIAL_OPERATIONS as readonly string[]).includes(operation), false, `${operation} has no renderer route`);
    assert.equal(WORKFLOW_FINANCIAL_OPERATIONS.has(operation), false, `${operation} is closed to workflows`);
  }
  assert.equal(PGLITE_FINANCIAL_CONTRACTS["financial.canonical.compact"].lane, "background-steps");
  const compact = PGLITE_FINANCIAL_CONTRACTS["financial.canonical.compact"].accepts;
  assert.equal(compact([]), true);
  assert.equal(compact([{ backup: true }]), true);
  assert.equal(compact([{ backup: "yes" }]), false);
  assert.equal(compact([{ backup: true, path: "/elsewhere" }]), false, "the renderer cannot name where a backup goes");
  assert.equal("financial.canonical.compactLedger" in PGLITE_FINANCIAL_CONTRACTS, false, "the one-transaction compaction is not an operation");
});
