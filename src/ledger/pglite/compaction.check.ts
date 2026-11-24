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
import { legacyStore, MODES, ROWS, snapshot, SYNCS, writeDirectly } from "./compaction-fixtures.ts";
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
      for (const mode of MODES) await commitResync(target, mode, mode === "deposit" ? SYNCS + 2 : SYNCS + 1, { rowCount: ROWS });
      // Every mode committed, the investment sync too, whose name writer compares with the kept name rows.
      const { rows: [committed] } = await target.query<{ captures: number }>(
        `SELECT count(*)::int AS captures FROM source_captures WHERE capture_key = ANY($1::text[])`,
        [MODES.map((mode) => `${mode}-capture-${mode === "deposit" ? SYNCS + 2 : SYNCS + 1}`)],
      );
      assert.equal(committed!.captures, MODES.length);
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
const seqByCommit = (alias: string) => `JOIN canonical_commits ${alias}_commit ON ${alias}_commit.commit_id = ${alias}.commit_id`;

/**
 * Marks the first row of each run that has a later row, a row the real
 * selection keeps: the latest row stays, so only an earlier knowledge point
 * sees the difference.
 */
const firstOfRun = (table: string, join: string, partition: string, order: string) => `
  SELECT domain.ctid AS row_ctid,
         ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY ${order}) = 1 AND count(*) OVER (PARTITION BY ${partition}) > 1 AS repeats
    FROM ${table} domain ${join}`;

/** Marks every row but the latest of each key: the last of each run is kept instead of the first. */
const allButLatest = (table: string, join: string, partition: string, latestFirst: string) => `
  SELECT domain.ctid AS row_ctid, ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY ${latestFirst}) > 1 AS repeats
    FROM ${table} domain ${join}`;

const commitOf = (captureKey: string) => `(SELECT commit_id FROM source_captures WHERE capture_key = '${captureKey}')`;

/** The invoice whose second sync this check makes observe one revision fewer than its first and third. */
const ABA_INVOICE = `(SELECT invoice_id FROM einvoice_invoice_revisions WHERE revision_id = decode(md5('revised'), 'hex'))`;

/**
 * Selections that each remove a row the real selection keeps, with the
 * readers that must see it. Each returns `row_ctid` and `repeats` as a
 * table's selection does.
 */
const MUTATIONS: readonly Readonly<{
  name: string;
  table: CompactedTable;
  selection: string;
  /** Selections of other tables made in the same run. */
  also?: Readonly<Partial<Record<CompactedTable, string>>>;
  readers: readonly CompactionReader[];
}>[] = [
  {
    name: "the first security name of a run instead of its repeats",
    table: "investment_security_name_observations",
    selection: firstOfRun("investment_security_name_observations", seqByCommit("domain"), "domain.security_id",
      "domain_commit.commit_sequence, domain.capture_id"),
    readers: ["securityNamesAtEveryKnowledgePoint"],
  },
  {
    // A purchase seen on one sync only has no row left.
    name: "the latest lifecycle row of every purchase",
    table: "canonical_credit_card_transaction_lifecycle",
    selection: `SELECT domain.ctid AS row_ctid,
        ROW_NUMBER() OVER (PARTITION BY domain.transaction_id ORDER BY domain_commit.commit_sequence DESC, domain.lifecycle_event_id DESC) = 1 AS repeats
      FROM canonical_credit_card_transaction_lifecycle domain ${seqByCapture("domain")}`,
    readers: ["cardLifecycleLatest", "cardLifecycleLatestByAccount", "cardLifecycleHistory"],
  },
  {
    name: "the last lifecycle row of each run instead of the first",
    table: "canonical_credit_card_transaction_lifecycle",
    selection: allButLatest("canonical_credit_card_transaction_lifecycle", seqByCapture("domain"), "domain.transaction_id",
      "domain_commit.commit_sequence DESC, domain.lifecycle_event_id DESC"),
    readers: ["cardLifecycleHistory"],
  },
  {
    name: "every details row of one purchase",
    table: "canonical_credit_card_transaction_details",
    selection: `SELECT ctid AS row_ctid,
        transaction_id = (SELECT min(transaction_id) FROM canonical_credit_card_transaction_details) AS repeats
      FROM canonical_credit_card_transaction_details`,
    readers: ["cardDetailsLatestByRevision", "cardDetailsLatestByTransaction", "cardDetailsDateMatch", "cardDetailsHistory"],
  },
  {
    name: "the last details row of each run instead of the first",
    table: "canonical_credit_card_transaction_details",
    selection: allButLatest("canonical_credit_card_transaction_details", seqByCapture("domain"), "domain.transaction_id",
      "domain_commit.commit_sequence DESC, domain.source_record_id DESC"),
    readers: ["cardDetailsHistory"],
  },
  {
    name: "the last statement summary of each run instead of the first",
    table: "canonical_credit_card_statement_summary_evidence",
    selection: allButLatest("canonical_credit_card_statement_summary_evidence", seqByCapture("domain"), "domain.statement_revision_id",
      "domain_commit.commit_sequence DESC, domain.evidence_source_record_id DESC"),
    readers: ["cardStatementSummaryHistory"],
  },
  {
    name: "the first evidence of an instrument instead of its repeats",
    table: "canonical_credit_card_instrument_evidence",
    selection: firstOfRun("canonical_credit_card_instrument_evidence", seqByCapture("domain"), "domain.instrument_id",
      "domain_commit.commit_sequence, domain.source_record_id"),
    readers: ["cardInstrumentEvidenceHistory"],
  },
  {
    name: "the first evidence of one relation instead of its repeats",
    table: "transaction_relation_provenance",
    selection: `SELECT marked.row_ctid, marked.repeats AND marked.relation_id = (SELECT min(relation_id) FROM transaction_relation_provenance) AS repeats
      FROM (${firstOfRun("transaction_relation_provenance", seqByCommit("domain"), "domain.relation_id",
        "domain_commit.commit_sequence, domain.source_record_id").replace("SELECT domain.ctid AS row_ctid,", "SELECT domain.ctid AS row_ctid, domain.relation_id,")}) marked`,
    readers: ["relationEvidenceHistory"],
  },
  {
    name: "the first sighting of one account identifier instead of its repeats",
    table: "financial_account_identifier_observations",
    selection: `SELECT marked.row_ctid, marked.repeats AND marked.account_id = (SELECT min(account_id) FROM financial_account_identifier_observations) AS repeats
      FROM (${firstOfRun("financial_account_identifier_observations", seqByCommit("domain"), "domain.account_id",
        "domain_commit.commit_sequence, domain.observation_id").replace("SELECT domain.ctid AS row_ctid,", "SELECT domain.ctid AS row_ctid, domain.account_id,")}) marked`,
    readers: ["accountIdentifierFirstSightings"],
  },
  {
    name: "the count row that raised its partition's maximum",
    table: COUNTS,
    selection: `SELECT count_row.ctid AS row_ctid,
        count_row.occurrence_count > MIN(count_row.occurrence_count) OVER (PARTITION BY coverage.source_subject_id, coverage.record_kind,
          coverage.scope_key, coverage.contract_version, count_row.partition_date, count_row.fingerprint) AS repeats
      FROM source_occurrence_group_counts count_row
      JOIN source_occurrence_group_coverages coverage ON coverage.coverage_id = count_row.coverage_id`,
    readers: ["occurrenceCountMaxima", "occurrenceCountHistory"],
  },
  {
    name: "every observation of one revision",
    table: "einvoice_revision_observations",
    selection: `SELECT ctid AS row_ctid, revision_id = (SELECT min(revision_id) FROM einvoice_revision_observations) AS repeats
      FROM einvoice_revision_observations`,
    readers: ["einvoiceLatestObserved", "einvoiceObservedRevisions", "einvoiceObservedHistory", "einvoiceUnpairedObservations"],
  },
  {
    // Observed sets A, B, A: removing B, its events with it, keeps the latest set and every observed revision.
    name: "the observing commit between two equal ones, whose set differs",
    table: "einvoice_revision_observations",
    selection: `SELECT observation.ctid AS row_ctid,
        revision.invoice_id = ${ABA_INVOICE} AND observation.commit_id = ${commitOf("einvoice-capture-2")} AS repeats
      FROM einvoice_revision_observations observation
      JOIN einvoice_invoice_revisions revision ON revision.revision_id = observation.revision_id`,
    also: {
      einvoice_revision_events: `SELECT ctid AS row_ctid,
          invoice_id = ${ABA_INVOICE} AND commit_id = ${commitOf("einvoice-capture-2")} AS repeats
        FROM einvoice_revision_events`,
    },
    readers: ["einvoiceObservedHistory"],
  },
  {
    // The observations stay, so only the pairing of observations with their events sees it.
    name: "every observed event",
    table: "einvoice_revision_events",
    selection: `SELECT ctid AS row_ctid, event_kind = 'observed' AS repeats FROM einvoice_revision_events`,
    readers: ["einvoiceUnpairedObservations"],
  },
  {
    // With the real repeats, so the observations removed with them keep their pairing.
    name: "the issued and revoked events",
    table: "einvoice_revision_events",
    selection: `SELECT marked.row_ctid, marked.repeats OR event.event_kind <> 'observed' AS repeats
      FROM (${PHASE_A.einvoice_revision_events.marked}) marked
      JOIN einvoice_revision_events event ON event.ctid = marked.row_ctid`,
    readers: ["einvoiceNonObservedEvents"],
  },
];

/**
 * The revised invoice's first and third syncs also observe its new revision,
 * so its observed sets are A, B and A over the three syncs.
 */
async function observeRevisedInvoiceAroundItsSecondSync(store: PGliteStore): Promise<number> {
  return writeDirectly(store, `
    INSERT INTO einvoice_revision_observations(revision_id, source_record_id, capture_id, commit_id)
    SELECT decode(md5('revised'), 'hex'), observation.source_record_id, observation.capture_id, observation.commit_id
      FROM einvoice_revision_observations observation
      JOIN einvoice_invoice_revisions revision ON revision.revision_id = observation.revision_id
     WHERE revision.invoice_id = ${ABA_INVOICE} AND revision.revision_id <> decode(md5('revised'), 'hex')
       AND observation.commit_id IN (${commitOf("einvoice-capture-1")}, ${commitOf("einvoice-capture-3")})`);
}

test("a selection that would change a reader's answer rolls back and changes nothing", async () => {
  const { store } = await legacyStore();
  try {
    assert.equal(await observeRevisedInvoiceAroundItsSecondSync(store), 2);
    const before = await snapshot(store);
    for (const mutation of MUTATIONS) {
      await assert.rejects(
        compactLedgerDomainAndCounts(store, { selections: { ...mutation.also, [mutation.table]: mutation.selection } }),
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
