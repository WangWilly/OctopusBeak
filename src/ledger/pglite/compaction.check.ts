/**
 * Compacting the domain rows and count rows of a store written before ADR
 * 0152 (ADR 0154) removes exactly what the dry run counts, keeps every
 * reader's answer, and leaves the store as later syncs would find an
 * uncompacted one. A selection that would change an answer rolls back.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  COMPACTION_READERS,
  compactLedgerDomainAndCounts,
  LedgerCompactionError,
  readCompactionReaders,
  type CompactedTable,
  type CompactionReader,
  type LedgerCompactionResult,
} from "./compaction.ts";
import { COUNTS, PHASE_A, planLedgerCompaction, type CompactionPlan } from "./compaction-plan.ts";
import { legacyStore, MODES, ROWS, snapshot, SYNCS } from "./compaction-fixtures.ts";
import { canonicalState } from "./canonical-state-fixture.ts";
import { commitResync } from "./resync-fixtures.ts";
import { PGliteStore } from "./transaction.ts";
import { PGLITE_FINANCIAL_CONTRACTS } from "../../lib/pglite-rpc/pglite-financial-contracts.ts";

const COMPACTED_TABLES: readonly CompactedTable[] = [...(Object.keys(PHASE_A) as CompactedTable[]), COUNTS];
const MARKER = "pglite_operational_migrations";

function planned(plan: Awaited<ReturnType<typeof planLedgerCompaction>>): CompactionPlan {
  assert.equal(plan.status, "planned", JSON.stringify(plan));
  return plan as CompactionPlan;
}

function compacted(result: LedgerCompactionResult): Extract<LedgerCompactionResult, { status: "compacted" }> {
  assert.equal(result.status, "compacted", JSON.stringify(result));
  return result as Extract<LedgerCompactionResult, { status: "compacted" }>;
}

/** What the dry run would remove from each table. */
function plannedRemovals(plan: CompactionPlan): Record<CompactedTable, number> {
  return {
    ...Object.fromEntries(plan.phaseA.map(({ table, removable }) => [table, removable])),
    [COUNTS]: plan.phaseC.removable,
  } as Record<CompactedTable, number>;
}

async function rowCounts(store: PGliteStore): Promise<Record<CompactedTable, number>> {
  const { rows } = await store.query<{ table_name: CompactedTable; rows: number }>(
    COMPACTED_TABLES.map((table) => `SELECT '${table}' AS table_name, count(*)::int AS rows FROM ${table}`).join("\nUNION ALL\n"),
  );
  return Object.fromEntries(rows.map((row) => [row.table_name, row.rows])) as Record<CompactedTable, number>;
}

async function markers(store: PGliteStore): Promise<string[]> {
  const { rows } = await store.query<{ migration_key: string }>(
    `SELECT migration_key FROM ${MARKER} WHERE migration_key LIKE 'ledger-compaction%' ORDER BY 1`,
  );
  return rows.map(({ migration_key }) => migration_key);
}

/** A copy of a store, through a dump of its data folder. */
async function copyOf(database: PGlite): Promise<PGliteStore> {
  return new PGliteStore(await PGlite.create({ loadDataDir: await database.dumpDataDir("none") }));
}

test("compaction removes what the dry run counts and keeps every reader's answer", async () => {
  const database = await PGlite.create();
  const { store, repeated } = await legacyStore(database);
  try {
    const plan = planned(await planLedgerCompaction(store));
    const expected = plannedRemovals(plan);
    // Every table the old writers repeated has rows to remove, the counts included.
    for (const table of COMPACTED_TABLES) assert.ok(expected[table]! > 0, `${table} has repeats (${repeated[table]})`);
    const before = await snapshot(store);
    const counts = await rowCounts(store);
    const readers = await readCompactionReaders(store);

    const result = compacted(await compactLedgerDomainAndCounts(store));
    assert.deepEqual(result.removed, expected);
    assert.equal(result.verification.passed, true);
    assert.deepEqual(result.verification.readers, readers);
    assert.deepEqual(Object.keys(readers).sort(), Object.keys(COMPACTION_READERS).sort());
    assert.deepEqual(await readCompactionReaders(store), readers);
    assert.ok(result.durationMs >= 0);

    // Only the compacted tables lost rows, exactly the ones removed, and the marker is written.
    const after = await snapshot(store);
    const changed = [...after.keys()].filter((table) => after.get(table) !== before.get(table)).sort();
    assert.deepEqual(changed, [...COMPACTED_TABLES.map((table) => `public.${table}`), `public.${MARKER}`].sort());
    const remaining = await rowCounts(store);
    for (const table of COMPACTED_TABLES) assert.equal(remaining[table], counts[table] - expected[table], `${table} lost its repeats only`);
    assert.deepEqual(await markers(store), ["ledger-compaction-domain-counts-v1"]);

    // The dry run now finds nothing more in phases A and C.
    const replanned = planned(await planLedgerCompaction(store));
    assert.deepEqual(Object.values(plannedRemovals(replanned)), COMPACTED_TABLES.map(() => 0));
  } finally {
    await store.close();
  }
});

test("later syncs leave a compacted store as they leave an uncompacted copy", async () => {
  const database = await PGlite.create();
  const { store } = await legacyStore(database);
  const uncompacted = await copyOf(database);
  try {
    compacted(await compactLedgerDomainAndCounts(store));
    const grown: Record<CompactedTable, number>[] = [];
    const states: Record<string, readonly string[]>[] = [];
    for (const target of [uncompacted, store]) {
      const before = await rowCounts(target);
      for (const mode of MODES) {
        const sync = commitResync(target, mode, mode === "deposit" ? SYNCS + 2 : SYNCS + 1, { rowCount: ROWS });
        // The count row the fixture raised by one member is kept, so both
        // stores' member-loss guards refuse the next investment sync alike.
        if (mode === "investment") await assert.rejects(sync, /cannot lose members/u);
        else await sync;
      }
      const after = await rowCounts(target);
      grown.push(Object.fromEntries(COMPACTED_TABLES.map((table) => [table, after[table] - before[table]])) as Record<CompactedTable, number>);
      states.push(await canonicalState(target, Object.fromEntries(Object.entries(COMPACTION_READERS).map(([reader, sql]) =>
        [`reader ${reader}`, `SELECT to_jsonb(answer) AS row FROM (${sql}) answer`]))));
    }
    // Nothing changed, so neither store's writers wrote a row to a compacted
    // table: on the compacted store each found the latest row it compares
    // with, and an equal one.
    assert.deepEqual(grown[0], grown[1]);
    assert.deepEqual(Object.values(grown[0]!), COMPACTED_TABLES.map(() => 0));
    const [compactedState, uncompactedState] = states;
    for (const key of [...COMPACTED_TABLES, MARKER]) {
      delete compactedState![key];
      delete uncompactedState![key];
    }
    assert.deepEqual(Object.keys(compactedState!), Object.keys(uncompactedState!));
    for (const key of Object.keys(uncompactedState!))
      assert.deepEqual(compactedState![key], uncompactedState![key], `${key} is the same on both stores`);
  } finally {
    await store.close();
    await uncompacted.close();
  }
});

test("a second compaction removes nothing", async () => {
  const { store } = await legacyStore();
  try {
    compacted(await compactLedgerDomainAndCounts(store));
    const before = await snapshot(store);
    const again = await compactLedgerDomainAndCounts(store);
    assert.equal(again.status, "already-compacted");
    assert.deepEqual(Object.values(again.removed), COMPACTED_TABLES.map(() => 0));
    assert.deepEqual(await snapshot(store), before);

    // Without the marker the selection itself finds nothing.
    await store.query(`DELETE FROM ${MARKER} WHERE migration_key = 'ledger-compaction-domain-counts-v1'`);
    const rerun = compacted(await compactLedgerDomainAndCounts(store));
    assert.deepEqual(Object.values(rerun.removed), COMPACTED_TABLES.map(() => 0));
  } finally {
    await store.close();
  }
});

const seqByCapture = (alias: string) =>
  `JOIN source_captures ${alias}_capture ON ${alias}_capture.capture_id = ${alias}.capture_id
   JOIN canonical_commits ${alias}_commit ON ${alias}_commit.commit_id = ${alias}_capture.commit_id`;

/**
 * Selections that each remove a row the readers need, with the readers that
 * must see it. Each returns `row_ctid` and `repeats` as a table's selection does.
 */
const MUTATIONS: readonly Readonly<{
  name: string;
  table: CompactedTable;
  selection: string;
  readers: readonly CompactionReader[];
}>[] = [
  {
    // The latest answer stays: only the name at the knowledge points between the first row and its repeat changes.
    name: "the first security name of a run instead of its repeats",
    table: "investment_security_name_observations",
    selection: `SELECT domain.ctid AS row_ctid,
        ROW_NUMBER() OVER history = 1 AND count(*) OVER (PARTITION BY domain.security_id) > 1 AS repeats
      FROM investment_security_name_observations domain JOIN canonical_commits domain_commit ON domain_commit.commit_id = domain.commit_id
    WINDOW history AS (PARTITION BY domain.security_id ORDER BY domain_commit.commit_sequence, domain.capture_id)`,
    readers: ["securityNamesAtEveryKnowledgePoint"],
  },
  {
    // A purchase seen on one sync only has no row left.
    name: "the latest lifecycle row of every purchase",
    table: "canonical_credit_card_transaction_lifecycle",
    selection: `SELECT domain.ctid AS row_ctid,
        ROW_NUMBER() OVER (PARTITION BY domain.transaction_id ORDER BY domain_commit.commit_sequence DESC, domain.lifecycle_event_id DESC) = 1 AS repeats
      FROM canonical_credit_card_transaction_lifecycle domain ${seqByCapture("domain")}`,
    readers: ["cardLifecycleLatest", "cardLifecycleLatestByAccount"],
  },
  {
    name: "every details row of one purchase",
    table: "canonical_credit_card_transaction_details",
    selection: `SELECT ctid AS row_ctid,
        transaction_id = (SELECT min(transaction_id) FROM canonical_credit_card_transaction_details) AS repeats
      FROM canonical_credit_card_transaction_details`,
    readers: ["cardDetailsLatestByRevision", "cardDetailsLatestByTransaction", "cardDetailsDateMatch"],
  },
  {
    name: "the count row that raised its partition's maximum",
    table: COUNTS,
    selection: `SELECT count_row.ctid AS row_ctid,
        count_row.occurrence_count > MIN(count_row.occurrence_count) OVER (PARTITION BY coverage.source_subject_id, coverage.record_kind,
          coverage.scope_key, coverage.contract_version, count_row.partition_date, count_row.fingerprint) AS repeats
      FROM source_occurrence_group_counts count_row
      JOIN source_occurrence_group_coverages coverage ON coverage.coverage_id = count_row.coverage_id`,
    readers: ["occurrenceCountMaxima"],
  },
  {
    name: "every observation of one revision",
    table: "einvoice_revision_observations",
    selection: `SELECT ctid AS row_ctid, revision_id = (SELECT min(revision_id) FROM einvoice_revision_observations) AS repeats
      FROM einvoice_revision_observations`,
    readers: ["einvoiceLatestObserved", "einvoiceObservedRevisions"],
  },
  {
    name: "every sighting of an account identifier",
    table: "financial_account_identifier_observations",
    selection: `SELECT ctid AS row_ctid, true AS repeats FROM financial_account_identifier_observations`,
    readers: ["accountIdentifiers"],
  },
  {
    name: "the evidence of an instrument",
    table: "canonical_credit_card_instrument_evidence",
    selection: `SELECT ctid AS row_ctid, true AS repeats FROM canonical_credit_card_instrument_evidence`,
    readers: ["cardInstrumentEvidenceLatest"],
  },
  {
    name: "the latest summary of a statement",
    table: "canonical_credit_card_statement_summary_evidence",
    selection: `SELECT domain.ctid AS row_ctid,
        ROW_NUMBER() OVER (PARTITION BY domain.statement_revision_id ORDER BY domain_commit.commit_sequence DESC) = 1 AS repeats
      FROM canonical_credit_card_statement_summary_evidence domain ${seqByCapture("domain")}`,
    readers: ["cardStatementSummaryLatest"],
  },
  {
    name: "the evidence of a relation",
    table: "transaction_relation_provenance",
    selection: `SELECT ctid AS row_ctid, true AS repeats FROM transaction_relation_provenance`,
    readers: ["relationEvidenceLatest"],
  },
];

test("a selection that would change a reader's answer rolls back and changes nothing", async () => {
  const { store } = await legacyStore();
  try {
    const before = await snapshot(store);
    for (const mutation of MUTATIONS) {
      await assert.rejects(
        compactLedgerDomainAndCounts(store, { selections: { [mutation.table]: mutation.selection } }),
        (error: unknown) => {
          assert.ok(error instanceof LedgerCompactionError, String(error));
          assert.deepEqual(error.failure, { reason: "reader-changed", readers: mutation.readers }, mutation.name);
          return true;
        },
        mutation.name,
      );
      assert.deepEqual(await snapshot(store), before, `${mutation.name} changed nothing`);
    }
    assert.deepEqual(await markers(store), []);
    // The real selection still compacts the same store.
    compacted(await compactLedgerDomainAndCounts(store));
  } finally {
    await store.close();
  }
});

test("a compaction that stops part way changes nothing, and the next one completes", async () => {
  const { store } = await legacyStore();
  try {
    const expected = plannedRemovals(planned(await planLedgerCompaction(store)));
    const before = await snapshot(store);
    const deleted: string[] = [];
    await assert.rejects(
      compactLedgerDomainAndCounts(store, {
        onRemoved: (table) => {
          deleted.push(table);
          if (deleted.length === 3) throw new Error("The worker stopped.");
        },
      }),
      /The worker stopped\./,
    );
    assert.equal(deleted.length, 3);
    assert.deepEqual(await snapshot(store), before);

    const controller = new AbortController();
    await assert.rejects(
      compactLedgerDomainAndCounts(store, {
        signal: controller.signal,
        onRemoved: () => controller.abort(new Error("Settings closed.")),
      }),
      /Settings closed\./,
    );
    assert.deepEqual(await snapshot(store), before);
    assert.deepEqual(await markers(store), []);

    assert.deepEqual(compacted(await compactLedgerDomainAndCounts(store)).removed, expected);
  } finally {
    await store.close();
  }
});

test("a store something else cites a compacted table in is refused", async () => {
  const { store } = await legacyStore();
  try {
    await store.exec(`CREATE TABLE probe_citations(lifecycle_event_id BYTEA PRIMARY KEY
      REFERENCES canonical_credit_card_transaction_lifecycle(lifecycle_event_id))`);
    const before = await snapshot(store);
    await assert.rejects(compactLedgerDomainAndCounts(store), (error: unknown) => {
      assert.ok(error instanceof LedgerCompactionError);
      assert.deepEqual(error.failure, { reason: "unexpected-reference", tables: ["probe_citations"] });
      return true;
    });
    await store.exec("DROP TABLE probe_citations; ALTER TABLE source_occurrence_group_counts ENABLE ALWAYS TRIGGER source_occurrence_group_counts_no_delete");
    await assert.rejects(compactLedgerDomainAndCounts(store), (error: unknown) => {
      assert.ok(error instanceof LedgerCompactionError);
      assert.deepEqual(error.failure, {
        reason: "unexpected-trigger",
        triggers: ["source_occurrence_group_counts.source_occurrence_group_counts_no_delete"],
      });
      return true;
    });
    before.delete("public.probe_citations");
    assert.deepEqual(await snapshot(store), before);
  } finally {
    await store.close();
  }
});

test("compaction is a host-only financial operation", () => {
  const contract = PGLITE_FINANCIAL_CONTRACTS["financial.canonical.compactDomainAndCounts"];
  assert.equal("renderer" in contract, false);
  assert.equal(contract.workflow, undefined);
  assert.equal(contract.lane, "background");
});
