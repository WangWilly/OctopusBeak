/**
 * Compacting a store written before ADR 0152 (ADR 0154) removes exactly what
 * the dry run counts, its domain rows, record copies and count rows, keeps
 * every reader's answer, and leaves the store as later syncs would find an
 * uncompacted one. A selection that would change an answer, or remove a
 * copy phase B must keep, rolls back.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  COMPACTION_READERS,
  compactLedger,
  compactLedgerChunk,
  LedgerCompactionError,
  readCompactionReaders,
  type LedgerCompactionFailure,
  type CompactedTable,
  type CompactionReader,
  type LedgerCompactionResult,
} from "./compaction.ts";
import { planLedgerCompactionJob, runLedgerCompaction } from "./compaction-job.ts";
import { COUNTS, PHASE_A, planLedgerCompaction, type CompactionPlan } from "./compaction-plan.ts";
import { addCaptureChain, captureOf, copyOf as copyIn, keyOf, legacyStore, MODES, ROWS, snapshot, SYNCS, writeDirectly } from "./compaction-fixtures.ts";
import { canonicalState } from "./canonical-state-fixture.ts";
import { captureSourceRecordIdsSql, captureSourceRecordsSql } from "./capture-manifest.ts";
import { commitResync } from "./resync-fixtures.ts";
import { PGliteStore } from "./transaction.ts";

const RECORD_TABLES = ["source_record_scopes", "source_record_provenance", "assertion_provenance", "source_records"] as const;
const COMPACTED_TABLES: readonly CompactedTable[] = [...(Object.keys(PHASE_A) as CompactedTable[]), COUNTS, ...RECORD_TABLES];
const MARKER = "pglite_operational_migrations";
const MANIFESTS = "capture_source_record_manifests" as const;
const MARKERS = ["ledger-compaction-domain-counts-v1", "ledger-compaction-records-v1"];

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
    ...Object.fromEntries(plan.phaseB.tables.map(({ table, removable }) => [table, removable])),
    [COUNTS]: plan.phaseC.removable,
  } as Record<CompactedTable, number>;
}

async function rowCounts(store: PGliteStore): Promise<Record<CompactedTable | typeof MANIFESTS, number>> {
  const { rows } = await store.query<{ table_name: CompactedTable; rows: number }>(
    [...COMPACTED_TABLES, MANIFESTS].map((table) => `SELECT '${table}' AS table_name, count(*)::int AS rows FROM ${table}`).join("\nUNION ALL\n"),
  );
  return Object.fromEntries(rows.map((row) => [row.table_name, row.rows])) as Record<CompactedTable | typeof MANIFESTS, number>;
}

/** Each record copy's capture, both as hex. */
async function copiesByCapture(store: PGliteStore): Promise<Map<string, string>> {
  const { rows } = await store.query<{ copy: string; capture: string }>(
    "SELECT encode(source_record_id, 'hex') AS copy, encode(capture_id, 'hex') AS capture FROM source_records");
  return new Map(rows.map(({ copy, capture }) => [copy, capture]));
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
    // Every table the old writers repeated has rows to remove, the counts and the record copies included.
    for (const table of COMPACTED_TABLES) assert.ok(expected[table]! > 0, `${table} has repeats (${repeated[table] ?? "copies"})`);
    const before = await snapshot(store);
    const counts = await rowCounts(store);
    const readers = await readCompactionReaders(store);

    const copiesBefore = await copiesByCapture(store);

    const result = compacted(await compactLedger(store));
    assert.deepEqual(result.removed, expected);
    // One manifest for each capture that lost a copy, none of which had one.
    const copiesAfter = await copiesByCapture(store);
    const capturesWithCopies = [...copiesBefore].filter(([copy]) => !copiesAfter.has(copy)).map(([, capture]) => capture);
    assert.equal(capturesWithCopies.length, expected.source_records);
    assert.equal(result.manifests, new Set(capturesWithCopies).size);
    assert.equal(result.verification.passed, true);
    assert.deepEqual(result.verification.readers, readers);
    assert.deepEqual(Object.keys(readers).sort(), Object.keys(COMPACTION_READERS).sort());
    assert.deepEqual(await readCompactionReaders(store), readers);
    assert.ok(result.durationMs >= 0);

    // Only the compacted tables lost rows, exactly the ones removed, and the marker is written.
    const after = await snapshot(store);
    const changed = [...after.keys()].filter((table) => after.get(table) !== before.get(table)).sort();
    assert.deepEqual(changed, [...COMPACTED_TABLES.map((table) => `public.${table}`), `public.${MARKER}`, `public.${MANIFESTS}`].sort());
    const remaining = await rowCounts(store);
    for (const table of COMPACTED_TABLES) assert.equal(remaining[table], counts[table] - expected[table], `${table} lost its repeats only`);
    assert.deepEqual(await markers(store), MARKERS);
    // Each new manifest lists, for each copy its capture lost, an earlier copy of the same record.
    const { rows: [listed] } = await store.query<{ listed: number; earlier: number }>(
      `SELECT count(*)::int AS listed,
              (count(*) FILTER (WHERE kept_commit.commit_sequence < capture_commit.commit_sequence))::int AS earlier
         FROM ${MANIFESTS} manifest
         JOIN canonical_commits capture_commit ON capture_commit.commit_id = manifest.commit_id
        CROSS JOIN generate_series(0, manifest.record_count - 1) AS slot
         JOIN source_records kept ON kept.source_record_id = substring(manifest.source_record_ids FROM slot * 16 + 1 FOR 16)
         JOIN canonical_commits kept_commit ON kept_commit.commit_id = kept.commit_id
        WHERE encode(manifest.capture_id, 'hex') = ANY($1::text[])`,
      [[...new Set(capturesWithCopies)]],
    );
    assert.deepEqual(listed, { listed: expected.source_records, earlier: expected.source_records });

    // The dry run now finds nothing more in any phase.
    const replanned = planned(await planLedgerCompaction(store));
    assert.deepEqual(Object.values(plannedRemovals(replanned)), COMPACTED_TABLES.map(() => 0));
  } finally {
    await store.close();
  }
});

/** The sync number of each mode's `round`th sync after the old-shaped store's; deposit already synced once more. */
const nextSync = (mode: (typeof MODES)[number], round: number) => (mode === "deposit" ? SYNCS + 1 : SYNCS) + round;

test("later syncs leave a compacted store as they leave an uncompacted copy", async () => {
  const database = await PGlite.create();
  const { store } = await legacyStore(database);
  const uncompacted = await copyOf(database);
  try {
    compacted(await compactLedger(store));
    const grown: Record<CompactedTable | typeof MANIFESTS, number>[] = [];
    const states: Record<string, readonly string[]>[] = [];
    for (const target of [uncompacted, store]) {
      const before = await rowCounts(target);
      // Two rounds: the first reuses the copies compaction kept, the second the ones the first stored or reused.
      for (const round of [1, 2])
        for (const mode of MODES) await commitResync(target, mode, nextSync(mode, round), { rowCount: ROWS });
      // Every mode committed, the investment sync too, whose name writer compares with the kept name rows.
      const { rows: [committed] } = await target.query<{ captures: number }>(
        `SELECT count(*)::int AS captures FROM source_captures WHERE capture_key = ANY($1::text[])`,
        [[1, 2].flatMap((round) => MODES.map((mode) => `${mode}-capture-${nextSync(mode, round)}`))],
      );
      assert.equal(committed!.captures, 2 * MODES.length);
      const after = await rowCounts(target);
      grown.push(Object.fromEntries(([...COMPACTED_TABLES, MANIFESTS] as const).map((table) => [table, after[table] - before[table]])) as
        Record<CompactedTable | typeof MANIFESTS, number>);
      states.push(await canonicalState(target, Object.fromEntries(Object.entries(COMPACTION_READERS).map(([reader, sql]) =>
        [`reader ${reader}`, `SELECT to_jsonb(answer) AS row FROM (${sql}) answer`]))));
    }
    // Both stores' writers wrote the same rows. Nothing changed, so neither
    // wrote a domain or count row: on the compacted store each found the
    // latest row it compares with, and an equal one. The record copies they
    // stored or reused are the same too, by content.
    assert.deepEqual(grown[0], grown[1]);
    for (const table of COMPACTED_TABLES.filter((table) => !(RECORD_TABLES as readonly string[]).includes(table)))
      assert.equal(grown[0]![table], 0, `${table} gained no row`);
    assert.ok(grown[0]![MANIFESTS] > 0);
    const [compactedState, uncompactedState] = states;
    for (const key of [...COMPACTED_TABLES, MARKER]) {
      delete compactedState![key];
      delete uncompactedState![key];
    }
    assert.deepEqual(Object.keys(compactedState!), Object.keys(uncompactedState!));
    // The record copies, their membership, sightings and expected occurrences, as `canonicalState` derives them.
    for (const key of ["distinct source records", "capture members", "capture sightings", "assertion sources", "expected occurrences"])
      assert.ok(compactedState![key]!.length > 0, `${key} is compared`);
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
    compacted(await compactLedger(store));
    const before = await snapshot(store);
    const again = await compactLedger(store);
    assert.equal(again.status, "already-compacted");
    assert.deepEqual(Object.values(again.removed), COMPACTED_TABLES.map(() => 0));
    assert.deepEqual(await snapshot(store), before);

    // Without the markers the selections themselves find nothing, and write no manifest.
    await store.query(`DELETE FROM ${MARKER} WHERE migration_key = ANY($1::text[])`, [MARKERS]);
    const rerun = compacted(await compactLedger(store));
    assert.deepEqual(Object.values(rerun.removed), COMPACTED_TABLES.map(() => 0));
    assert.equal(rerun.manifests, 0);
    assert.deepEqual(await markers(store), MARKERS);
  } finally {
    await store.close();
  }
});

test("a store compacted before phase B existed has its record copies compacted only", async () => {
  const database = await PGlite.create();
  const { store } = await legacyStore(database);
  const whole = await copyOf(database);
  try {
    await store.query(`INSERT INTO ${MARKER}(migration_key, schema_signature) VALUES ($1, 'phase A and C only')`, [MARKERS[0]]);
    const counts = await rowCounts(store);
    const result = compacted(await compactLedger(store));
    // Phases A and C are skipped, so their repeats still pin the copies they cite, and fewer copies go.
    const wholeResult = compacted(await compactLedger(whole));
    for (const table of COMPACTED_TABLES.filter((table) => !(RECORD_TABLES as readonly string[]).includes(table)))
      assert.equal(result.removed[table], 0, `${table} is not compacted again`);
    assert.ok(result.removed.source_records > 0);
    assert.ok(result.removed.source_records < wholeResult.removed.source_records);
    assert.equal((await rowCounts(store)).source_records, counts.source_records - result.removed.source_records);
    assert.deepEqual(await markers(store), MARKERS);
  } finally {
    await store.close();
    await whole.close();
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
        compactLedger(store, { selections: { ...mutation.also, [mutation.table]: mutation.selection } }),
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
    compacted(await compactLedger(store));
  } finally {
    await store.close();
  }
});

/** A phase B selection: each removed copy with the copy its capture's manifest lists instead. */
const removing = (...copies: readonly (readonly [removed: string, kept: string])[]) =>
  `SELECT * FROM (VALUES ${copies.map(([removed, kept]) => `(${removed}, ${kept})`).join(", ")}) AS copy(source_record_id, kept_id)`;
const invoice = (n: number) => keyOf("einvoice-capture-3", n);
/** The `n`th invoice's copy in the `sync`th e-invoice capture. */
const invoiceCopy = (sync: number, n: number) => copyIn(`einvoice-capture-${sync}`, invoice(n));
/** The `n`th record both captures hold: its copy in `later`, and in `earlier`. */
function laterAndEarlier(earlier: string, later: string, n = 0): readonly [string, string] {
  const key = `(SELECT occurrence_key FROM source_records WHERE capture_id = ${captureOf(later)}
      AND occurrence_key IN (SELECT occurrence_key FROM source_records WHERE capture_id = ${captureOf(earlier)})
    ORDER BY occurrence_key OFFSET ${n} LIMIT 1)`;
  return [copyIn(later, key), copyIn(earlier, key)];
}
/** The deposit copy of the third sync that an assertion row naming a run pins. */
const depositCopyNamingARun = `(SELECT source_record_id FROM assertion_provenance WHERE enrichment_run_id IS NOT NULL
   AND source_record_id IN (SELECT source_record_id FROM source_records WHERE capture_id = ${captureOf(`deposit-capture-${SYNCS}`)}))`;
const sameRecordIn = (captureKey: string, copy: string) =>
  copyIn(captureKey, `(SELECT occurrence_key FROM source_records WHERE source_record_id = ${copy})`);

/**
 * Phase B selections that each remove a copy the real selection keeps, or
 * list the wrong kept copy, with the failure that must stop each. The first
 * five break one of the conditions a removed copy must meet and are refused
 * before any delete; the rest pass those checks and change what a reader
 * answers.
 */
const RECORD_MUTATIONS: readonly Readonly<{ name: string; selection: string; failure: LedgerCompactionFailure }>[] = [
  {
    name: "a copy a revision, its observation and its event cite",
    selection: removing([invoiceCopy(3, 1), invoiceCopy(2, 1)]),
    failure: {
      reason: "removed-copy-cited",
      tables: ["einvoice_invoice_revisions", "einvoice_revision_events", "einvoice_revision_observations"],
    },
  },
  {
    name: "a copy a later capture's manifest lists",
    selection: removing(laterAndEarlier("deposit-capture-2", "deposit-capture-3")),
    failure: { reason: "removed-copy-cited", tables: ["capture_source_record_manifests"] },
  },
  {
    name: "a copy an assertion row naming a run cites",
    selection: removing([depositCopyNamingARun, sameRecordIn("deposit-capture-2", depositCopyNamingARun)]),
    failure: { reason: "removed-copy-cited", tables: ["assertion_provenance (non-source)"] },
  },
  {
    name: "a copy of a capture that already has a manifest",
    selection: removing(laterAndEarlier("card-command-capture-2", `card-command-capture-${SYNCS}`, 5)),
    failure: { reason: "removed-copy-in-manifest-capture", copies: 1 },
  },
  {
    name: "a copy whose payload differs from the copy before it",
    selection: removing([invoiceCopy(2, 0), invoiceCopy(1, 0)]),
    failure: { reason: "removed-copy-differs", copies: 1 },
  },
  {
    // Its capture's coverage has a bucket inventory, the earlier one's none.
    name: "the latest copy of an investment record, whose coverage shape differs",
    selection: removing(laterAndEarlier("investment-capture-2", `investment-capture-${SYNCS}`, 3)),
    failure: { reason: "reader-changed", readers: ["recordExpectedOccurrences", "recordLatestCopy", "recordLatestCopyHistory"] },
  },
  {
    // The latest copy backs the assertion again, so only the history and the membership see it.
    name: "a loan counterpart copy that backs no assertion, listing one that does",
    selection: removing(laterAndEarlier("loan-counterpart-capture-1-0", "loan-counterpart-capture-2-0")),
    failure: { reason: "reader-changed", readers: ["recordLatestCopyHistory", "captureMembership"] },
  },
  {
    name: "the latest loan counterpart copy, listing one that backs no assertion",
    selection: removing(laterAndEarlier("loan-counterpart-capture-2-0", "loan-counterpart-capture-3-0")),
    failure: { reason: "reader-changed", readers: ["recordLatestCopy", "recordLatestCopyHistory", "captureMembership"] },
  },
  {
    name: "a copy whose scope row names another account",
    selection: removing([invoiceCopy(2, 4), invoiceCopy(1, 4)]),
    failure: { reason: "reader-changed", readers: ["captureMembership"] },
  },
  {
    // The capture would list a copy its own commit did not know yet.
    name: "a copy listing the equal copy after it",
    selection: removing([invoiceCopy(2, 3), invoiceCopy(3, 3)]),
    failure: { reason: "reader-changed", readers: ["captureMembership"] },
  },
  {
    // The third capture would list a copy that is gone.
    name: "two copies in a row, the second listing the first",
    selection: removing([invoiceCopy(2, 3), invoiceCopy(1, 3)], [invoiceCopy(3, 3), invoiceCopy(2, 3)]),
    failure: { reason: "reader-changed", readers: ["captureMembership"] },
  },
];

test("a phase B selection that removes a copy it must keep rolls back and changes nothing", async () => {
  const { store } = await legacyStore();
  try {
    // The scope row of one second-sync invoice copy names an account, so it differs from its first-sync copy only there.
    assert.equal(await writeDirectly(store, `UPDATE source_record_scopes
        SET account_id = (SELECT account_id FROM financial_accounts ORDER BY account_id LIMIT 1)
      WHERE source_record_id = ${invoiceCopy(2, 4)}`), 1);
    const before = await snapshot(store);
    const caught = new Set<string>();
    for (const mutation of RECORD_MUTATIONS) {
      await assert.rejects(compactLedger(store, { selections: { source_records: mutation.selection } }), (error: unknown) => {
        assert.ok(error instanceof LedgerCompactionError, String(error));
        assert.deepEqual(error.failure, mutation.failure, mutation.name);
        return true;
      }, mutation.name);
      assert.deepEqual(await snapshot(store), before, `${mutation.name} changed nothing`);
      caught.add(mutation.failure.reason);
      if (mutation.failure.reason === "reader-changed") for (const reader of mutation.failure.readers) caught.add(reader);
    }
    // Each condition and each record reader stops at least one of them.
    for (const check of ["removed-copy-cited", "removed-copy-in-manifest-capture", "removed-copy-differs",
      "recordExpectedOccurrences", "recordLatestCopy", "recordLatestCopyHistory", "captureMembership"])
      assert.ok(caught.has(check), `${check} stops a mutation`);
    assert.deepEqual(await markers(store), []);
    compacted(await compactLedger(store));
  } finally {
    await store.close();
  }
});

test("a chunk refuses each of those phase B selections as the whole compaction does", async () => {
  const { store } = await legacyStore();
  try {
    assert.equal(await writeDirectly(store, `UPDATE source_record_scopes
        SET account_id = (SELECT account_id FROM financial_accounts ORDER BY account_id LIMIT 1)
      WHERE source_record_id = ${invoiceCopy(2, 4)}`), 1);
    // Phase A first, as the job runs it: the domain rows it keeps decide which copies stay cited.
    const { chunks } = await planLedgerCompactionJob(store);
    for (const chunk of chunks) if (chunk.kind === "domain") await compactLedgerChunk(store, chunk);
    const before = await snapshot(store);
    for (const mutation of RECORD_MUTATIONS) {
      const { rows: chains } = await store.query<{ subject: string; record_kind: string }>(
        `SELECT DISTINCT encode(record.source_subject_id, 'hex') AS subject, record.record_kind
           FROM (${mutation.selection}) selection JOIN source_records record ON record.source_record_id = selection.source_record_id`);
      assert.equal(chains.length, 1, mutation.name);
      const chunk = chunks.find((candidate) => candidate.kind === "chains"
        && candidate.chains.some(({ subject, recordKind }) => subject === chains[0]!.subject && recordKind === chains[0]!.record_kind));
      assert.ok(chunk, mutation.name);
      // The chunk reads only the records and captures of the copies it selected, and still sees each defect.
      await assert.rejects(compactLedgerChunk(store, chunk, { selections: { source_records: mutation.selection } }), (error: unknown) => {
        assert.ok(error instanceof LedgerCompactionError, String(error));
        assert.deepEqual(error.failure, mutation.failure, mutation.name);
        return true;
      }, mutation.name);
      assert.deepEqual(await snapshot(store), before, `${mutation.name} changed nothing`);
    }
  } finally {
    await store.close();
  }
});

const COPIES = "ledger_compaction_copies";
const MANIFEST_INSERT = `INSERT INTO ${MANIFESTS}(capture_id, source_record_ids, record_count, commit_id)
  SELECT copy.capture_id, string_agg(copy.kept_id, ''::bytea ORDER BY copy.kept_id), count(*)::int, capture.commit_id
    FROM ${COPIES} copy JOIN source_captures capture ON capture.capture_id = copy.capture_id
   GROUP BY copy.capture_id, capture.commit_id`;

/**
 * Phase B statements that write or delete more than the selected copies'
 * rows, beyond what a chunk's readers read: they read only the removed
 * copies' records and the captures that own one. Only the count guards stop
 * them.
 */
const STATEMENT_MUTATIONS: readonly Readonly<{
  name: string;
  statements: Readonly<Partial<Record<(typeof RECORD_TABLES)[number] | typeof MANIFESTS, string>>>;
  failure: Pick<LedgerCompactionFailure, "reason"> & { table?: CompactedTable };
}>[] = [
  {
    // Its membership shrinks to the one copy, yet it owns no removed copy, so no chunk reader reads it.
    name: "a second manifest, on a kept copy's capture, listing only that copy",
    statements: {
      [MANIFESTS]: `WITH extra AS (
        INSERT INTO ${MANIFESTS}(capture_id, source_record_ids, record_count, commit_id)
        SELECT DISTINCT ON (kept.capture_id) kept.capture_id, kept.source_record_id, 1, capture.commit_id
          FROM ${COPIES} copy JOIN source_records kept ON kept.source_record_id = copy.kept_id
          JOIN source_captures capture ON capture.capture_id = kept.capture_id
         WHERE kept.capture_id NOT IN (SELECT capture_id FROM ${COPIES})
           AND NOT EXISTS (SELECT 1 FROM ${MANIFESTS} manifest WHERE manifest.capture_id = kept.capture_id)
         ORDER BY kept.capture_id, kept.source_record_id
        RETURNING 1)
      ${MANIFEST_INSERT}`,
    },
    failure: { reason: "manifest-mismatch" },
  },
  {
    // One row per capture, as many as expected, only one column wrong.
    name: "a manifest insert that writes another commit on one capture's manifest",
    statements: {
      [MANIFESTS]: `INSERT INTO ${MANIFESTS}(capture_id, source_record_ids, record_count, commit_id)
        SELECT copy.capture_id, string_agg(copy.kept_id, ''::bytea ORDER BY copy.kept_id), count(*)::int,
               CASE WHEN copy.capture_id = (SELECT min(capture_id) FROM ${COPIES})
                    THEN (SELECT commit_id FROM canonical_commits WHERE commit_id <> capture.commit_id ORDER BY commit_sequence LIMIT 1)
                    ELSE capture.commit_id END
          FROM ${COPIES} copy JOIN source_captures capture ON capture.capture_id = copy.capture_id
         GROUP BY copy.capture_id, capture.commit_id`,
    },
    failure: { reason: "manifest-mismatch" },
  },
  {
    // The append-only guard is off while the copies go, and the row it changes is the chunk's own.
    name: "a record delete that also changes the commit of a manifest the chunk wrote",
    statements: {
      source_records: `WITH changed AS (
          UPDATE ${MANIFESTS} SET commit_id = (SELECT commit_id FROM canonical_commits
              WHERE commit_id <> ${MANIFESTS}.commit_id ORDER BY commit_sequence LIMIT 1)
           WHERE capture_id = (SELECT capture_id FROM ${COPIES} ORDER BY capture_id LIMIT 1) RETURNING 1)
        DELETE FROM source_records WHERE source_record_id IN (SELECT source_record_id FROM ${COPIES})`,
    },
    failure: { reason: "manifest-mismatch" },
  },
  {
    name: "a scope delete that also takes the scope rows of the kept copies' captures' other records",
    statements: {
      source_record_scopes: `DELETE FROM source_record_scopes
        WHERE source_record_id IN (SELECT source_record_id FROM ${COPIES})
           OR source_record_id IN (SELECT record.source_record_id FROM source_records record
               WHERE record.capture_id IN (SELECT kept.capture_id FROM source_records kept JOIN ${COPIES} copy ON kept.source_record_id = copy.kept_id)
                 AND record.capture_id NOT IN (SELECT capture_id FROM ${COPIES})
                 AND record.source_record_id NOT IN (SELECT kept_id FROM ${COPIES}))`,
    },
    failure: { reason: "removed-count-mismatch", table: "source_record_scopes" },
  },
  {
    // No reader reads the record provenance.
    name: "a provenance delete that takes every record of the chunk's chains",
    statements: {
      source_record_provenance: `DELETE FROM source_record_provenance
        WHERE source_record_id IN (SELECT source_record_id FROM ledger_compaction_scope_records)`,
    },
    failure: { reason: "removed-count-mismatch", table: "source_record_provenance" },
  },
  {
    // As many rows as name a removed copy, but one of them traded for another record's row.
    name: "a scope delete that keeps one removed copy's row and takes another record's instead",
    statements: {
      source_record_scopes: `DELETE FROM source_record_scopes WHERE ctid IN (
          (SELECT ctid FROM source_record_scopes WHERE source_record_id IN (SELECT source_record_id FROM ${COPIES}) ORDER BY ctid OFFSET 1)
          UNION ALL
          (SELECT ctid FROM source_record_scopes WHERE source_record_id NOT IN (SELECT source_record_id FROM ${COPIES})
             AND source_record_id NOT IN (SELECT kept_id FROM ${COPIES}) ORDER BY ctid LIMIT 1))`,
    },
    failure: { reason: "removed-count-mismatch", table: "source_record_scopes" },
  },
  {
    name: "an assertion provenance delete that trades one removed copy's row for another record's",
    statements: {
      assertion_provenance: `DELETE FROM assertion_provenance WHERE ctid IN (
          (SELECT ctid FROM assertion_provenance WHERE source_record_id IN (SELECT source_record_id FROM ${COPIES}) ORDER BY ctid OFFSET 1)
          UNION ALL
          (SELECT ctid FROM assertion_provenance WHERE source_record_id NOT IN (SELECT source_record_id FROM ${COPIES})
             AND source_record_id NOT IN (SELECT kept_id FROM ${COPIES}) ORDER BY ctid LIMIT 1))`,
    },
    failure: { reason: "removed-count-mismatch", table: "assertion_provenance" },
  },
  {
    // The row count matches, and every row stays.
    name: "an update in place of the scope delete",
    statements: {
      source_record_scopes: `UPDATE source_record_scopes SET account_id = account_id
        WHERE source_record_id IN (SELECT source_record_id FROM ${COPIES})`,
    },
    failure: { reason: "removed-count-mismatch", table: "source_record_scopes" },
  },
  {
    // The append-only guard is off while the copies go.
    name: "a scope delete that also deletes a manifest the chunk did not write",
    statements: {
      source_record_scopes: `WITH gone AS (
          DELETE FROM ${MANIFESTS} WHERE capture_id = (SELECT capture_id FROM ${MANIFESTS}
            WHERE capture_id NOT IN (SELECT capture_id FROM ${COPIES}) ORDER BY capture_id LIMIT 1) RETURNING 1)
        DELETE FROM source_record_scopes WHERE source_record_id IN (SELECT source_record_id FROM ${COPIES})`,
    },
    failure: { reason: "manifest-mismatch" },
  },
  {
    // The writes below reach rows of records the chunk's readers do not read.
    name: "a scope delete that also updates another record's scope",
    statements: {
      source_record_scopes: `WITH changed AS (
          UPDATE source_record_scopes SET account_id = NULL WHERE source_record_id = (SELECT source_record_id FROM source_records WHERE source_record_id NOT IN (SELECT source_record_id FROM ${COPIES}) AND source_record_id NOT IN (SELECT kept_id FROM ${COPIES}) ORDER BY source_record_id LIMIT 1) RETURNING 1)
        DELETE FROM source_record_scopes WHERE source_record_id IN (SELECT source_record_id FROM ${COPIES})`,
    },
    failure: { reason: "removed-count-mismatch", table: "source_record_scopes" },
  },
  {
    name: "a scope delete that also replaces another record's scope with a changed copy, keeping the count",
    statements: {
      source_record_scopes: `WITH gone AS (
          DELETE FROM source_record_scopes WHERE ctid = (SELECT ctid FROM source_record_scopes WHERE source_record_id = (SELECT source_record_id FROM source_records WHERE source_record_id NOT IN (SELECT source_record_id FROM ${COPIES}) AND source_record_id NOT IN (SELECT kept_id FROM ${COPIES}) ORDER BY source_record_id LIMIT 1) LIMIT 1)
          RETURNING *), back AS (
          INSERT INTO source_record_scopes SELECT * FROM gone RETURNING 1)
        DELETE FROM source_record_scopes WHERE source_record_id IN (SELECT source_record_id FROM ${COPIES})`,
    },
    failure: { reason: "removed-count-mismatch", table: "source_record_scopes" },
  },
  {
    name: "a scope delete that also changes another record's payload",
    statements: {
      source_record_scopes: `WITH changed AS (
          UPDATE source_records SET payload_json = payload_json || ' ' WHERE source_record_id = (SELECT source_record_id FROM source_records WHERE source_record_id NOT IN (SELECT source_record_id FROM ${COPIES}) AND source_record_id NOT IN (SELECT kept_id FROM ${COPIES}) ORDER BY source_record_id LIMIT 1) RETURNING 1)
        DELETE FROM source_record_scopes WHERE source_record_id IN (SELECT source_record_id FROM ${COPIES})`,
    },
    failure: { reason: "removed-count-mismatch", table: "source_records" },
  },
  {
    name: "a scope delete that also deletes another record's assertion provenance",
    statements: {
      source_record_scopes: `WITH gone AS (
          DELETE FROM assertion_provenance WHERE ctid = (SELECT ctid FROM assertion_provenance
            WHERE source_record_id NOT IN (SELECT source_record_id FROM ${COPIES}) ORDER BY ctid LIMIT 1) RETURNING 1)
        DELETE FROM source_record_scopes WHERE source_record_id IN (SELECT source_record_id FROM ${COPIES})`,
    },
    failure: { reason: "removed-count-mismatch", table: "assertion_provenance" },
  },
  {
    name: "a scope delete that swaps a manifest it did not write for a made-up one",
    statements: {
      source_record_scopes: `WITH gone AS (
          DELETE FROM ${MANIFESTS} WHERE capture_id = (SELECT capture_id FROM ${MANIFESTS}
            WHERE capture_id NOT IN (SELECT capture_id FROM ${COPIES}) ORDER BY capture_id LIMIT 1) RETURNING *), made AS (
          INSERT INTO ${MANIFESTS}(capture_id, source_record_ids, record_count, commit_id)
          SELECT capture.capture_id, gone.source_record_ids, gone.record_count, capture.commit_id FROM gone
            CROSS JOIN LATERAL (SELECT capture_id, commit_id FROM source_captures
              WHERE capture_id NOT IN (SELECT capture_id FROM ${MANIFESTS}) AND capture_id NOT IN (SELECT capture_id FROM ${COPIES})
              ORDER BY capture_id LIMIT 1) capture RETURNING 1)
        DELETE FROM source_record_scopes WHERE source_record_id IN (SELECT source_record_id FROM ${COPIES})`,
    },
    failure: { reason: "manifest-mismatch" },
  },
  {
    // It hides its own tracks from the checks after it.
    name: "a scope delete that also deletes an earlier manifest and its row in the checks' snapshot",
    statements: {
      source_record_scopes: `WITH victim AS (
          SELECT capture_id FROM ${MANIFESTS} WHERE capture_id NOT IN (SELECT capture_id FROM ${COPIES}) ORDER BY capture_id LIMIT 1
        ), gone AS (DELETE FROM ${MANIFESTS} WHERE capture_id IN (SELECT capture_id FROM victim) RETURNING 1),
        hidden AS (DELETE FROM ledger_compaction_manifests_before WHERE capture_id IN (SELECT capture_id FROM victim) RETURNING 1)
        DELETE FROM source_record_scopes WHERE source_record_id IN (SELECT source_record_id FROM ${COPIES})`,
    },
    failure: { reason: "selection-changed" },
  },
  {
    // The delete still sees the selection as it was; only the checks after it would read the renamed one.
    name: "a record delete that also renames a selected copy in the selection",
    statements: {
      source_records: `WITH renamed AS (
          UPDATE ${COPIES} SET source_record_id = decode(md5('renamed'), 'hex')
           WHERE source_record_id = (SELECT source_record_id FROM ${COPIES} ORDER BY source_record_id LIMIT 1) RETURNING 1)
        DELETE FROM source_records WHERE source_record_id IN (SELECT source_record_id FROM ${COPIES})`,
    },
    failure: { reason: "selection-changed" },
  },
];

const refusedAs = (failure: (typeof STATEMENT_MUTATIONS)[number]["failure"], name: string) => (error: unknown) => {
  assert.ok(error instanceof LedgerCompactionError, String(error));
  assert.equal(error.failure.reason, failure.reason, name);
  if (failure.table) assert.equal((error.failure as { table?: string }).table, failure.table, name);
  return true;
};

test("a phase B statement that writes or deletes more than its copies' rows rolls back, whole or in a chunk", async () => {
  for (const mutation of STATEMENT_MUTATIONS) {
    const { store } = await legacyStore();
    try {
      const before = await snapshot(store);
      await assert.rejects(compactLedger(store, { statements: mutation.statements }), refusedAs(mutation.failure, mutation.name), mutation.name);
      assert.deepEqual(await snapshot(store), before, `${mutation.name} changed nothing`);
      assert.deepEqual(await markers(store), []);

      // Each chunk the statement changes more than its copies in is refused; the rest commit as they would anyway.
      const { chunks } = await planLedgerCompactionJob(store);
      let refused = 0;
      for (const chunk of chunks) {
        if (chunk.kind === "chains") {
          const unchanged = await snapshot(store);
          try {
            await compactLedgerChunk(store, chunk, { statements: mutation.statements });
          } catch (error) {
            refusedAs(mutation.failure, mutation.name)(error);
            assert.deepEqual(await snapshot(store), unchanged, `${mutation.name} changed nothing in a chunk`);
            refused += 1;
          }
        }
        await compactLedgerChunk(store, chunk);
      }
      assert.ok(refused > 0, `a chunk refuses ${mutation.name}`);
    } finally {
      await store.close();
    }
  }
});

test("a chunk reads the records it removes a copy of and the captures that own one, not its whole chain", async () => {
  const { store } = await legacyStore();
  try {
    // Twelve captures of one chain, each with five records only it saw; the first four also hold a copy of one record.
    const kind = await addCaptureChain(store, { name: "holdings", captures: 12, fresh: 5, steady: 1, steadyCaptures: 4 });
    const { rows: [chain] } = await store.query<{ subject: string; copies: number }>(
      "SELECT encode(min(source_subject_id), 'hex') AS subject, count(*)::int AS copies FROM source_records WHERE record_kind = $1", [kind]);
    assert.equal(chain!.copies, 12 * 5 + 4);
    const chunk = { kind: "chains", chains: [{ subject: chain!.subject, recordKind: kind }], namespaces: [], records: true, counts: false } as const;

    // A copy without an occurrence key is in no record reader's scope, so a chunk refuses to remove one.
    await writeDirectly(store, `
      INSERT INTO source_records(source_record_id, capture_id, source_subject_id, commit_id, record_kind, sequence_lexeme, occurrence_key, payload_json)
      SELECT decode(md5('keyless-' || n), 'hex'), capture_id, source_subject_id, commit_id, record_kind, 'keyless', NULL, '{}'
        FROM source_records CROSS JOIN generate_series(1, 2) n
       WHERE capture_id = ${captureOf("holdings-capture-1")} AND occurrence_key = 'steady-1'`);
    const keyless = "SELECT decode(md5('keyless-2'), 'hex') AS source_record_id, decode(md5('keyless-1'), 'hex') AS kept_id";
    await assert.rejects(compactLedgerChunk(store, chunk, { selections: { source_records: keyless } }), (error: unknown) => {
      assert.ok(error instanceof LedgerCompactionError, String(error));
      assert.deepEqual(error.failure, { reason: "outside-chunk", table: "source_records", rows: 1 });
      return true;
    });

    const result = await compactLedgerChunk(store, chunk);
    assert.equal(result.removed.source_records, 3);
    assert.equal(result.manifests, 3);
    // Three captures each owned a removed copy: their six members each, the kept copy now through the manifest.
    assert.equal(result.digests.captureMembership?.rows, 3 * 6);
    assert.equal(result.digests.recordLatestCopy?.rows, 1);
    assert.equal(result.digests.recordLatestCopyHistory?.rows, 1);
  } finally {
    await store.close();
  }
});

/** Every capture's members as the manifests store them: the records it owns, then each id its manifest packs, cut from the stored column. */
const MEMBERS_AS_STORED = `
  SELECT owned.capture_id, owned.source_record_id FROM source_records owned
  UNION ALL
  SELECT manifest.capture_id, substring(manifest.source_record_ids FROM slot * 16 + 1 FOR 16)
    FROM ${MANIFESTS} manifest CROSS JOIN generate_series(0, manifest.record_count - 1) AS slot`;

/** The capture membership reader's answer for the captures matching `where`, with each member looked up by its id. */
const membershipLookedUpById = (where: string) => `
  SELECT capture.capture_key, record.source_subject_id, record.record_kind, record.occurrence_key,
         record.sequence_lexeme, record.provider_key, record.content_hash, record.collision_key, record.description,
         encode(sha256(convert_to(record.payload_json, 'UTF8')), 'hex'),
         record.occurrence_group_scope_key, record.occurrence_group_fingerprint, record.occurrence_group_partition_date,
         record.occurrence_group_ordinal, record.occurrence_group_bucket_key,
         record_commit.commit_sequence <= capture_commit.commit_sequence,
         scope.account_id, scope.source_subject_id,
         (SELECT string_agg(encode(provenance.assertion_id, 'hex'), ',' ORDER BY provenance.assertion_id)
            FROM assertion_provenance provenance WHERE provenance.source_record_id = member.source_record_id)
    FROM source_captures capture
    JOIN canonical_commits capture_commit ON capture_commit.commit_id = capture.commit_id
    JOIN (${MEMBERS_AS_STORED}) member ON member.capture_id = capture.capture_id
    LEFT JOIN source_records record ON record.source_record_id = member.source_record_id
    LEFT JOIN canonical_commits record_commit ON record_commit.commit_id = record.commit_id
    LEFT JOIN source_record_scopes scope ON scope.source_record_id = member.source_record_id
   WHERE ${where}`;

test("a capture's members read with their rows are its members looked up by id, in every capture and in a chunk's", async () => {
  const { store } = await legacyStore();
  try {
    compacted(await compactLedger(store));
    // A manifest long enough to be stored out of line, on a capture that had none: 300 records of other captures,
    // one of them twice, and one id that names no record.
    const planted = "loan-capture-1";
    assert.equal((await store.query(`SELECT 1 FROM ${MANIFESTS} WHERE capture_id = ${captureOf(planted)}`)).rows.length, 0);
    await writeDirectly(store, `
      INSERT INTO source_records(source_record_id, capture_id, source_subject_id, commit_id, record_kind, sequence_lexeme, occurrence_key, payload_json)
      SELECT decode(md5('listed-' || n), 'hex'), capture_id, source_subject_id, commit_id, record_kind, 'listed-' || n, 'listed-' || n, '{}'
        FROM source_records CROSS JOIN generate_series(1, 298) n
       WHERE source_record_id = (SELECT min(source_record_id) FROM source_records WHERE capture_id = ${captureOf("deposit-capture-1")})`);
    await writeDirectly(store, `
      INSERT INTO ${MANIFESTS}(capture_id, source_record_ids, record_count, commit_id)
      SELECT capture_id, (SELECT string_agg(decode(md5('listed-' || LEAST(n, 298)), 'hex'), ''::bytea ORDER BY n) FROM generate_series(0, 299) n), 300, commit_id
        FROM source_captures WHERE capture_key = '${planted}'`);
    const { rows: [stored] } = await store.query<{ bytes: number; stored: number }>(
      `SELECT length(source_record_ids) AS bytes, pg_column_size(source_record_ids) AS stored FROM ${MANIFESTS} WHERE capture_id = ${captureOf(planted)}`);
    assert.equal(stored!.bytes, 300 * 16);
    assert.ok(stored!.stored > 2000, "the planted manifest is longer than a row holds in line");

    const differing = async (left: string, right: string) => (await store.query<{ rows: number }>(
      `SELECT count(*)::int AS rows FROM ((${left} EXCEPT ALL ${right}) UNION ALL (${right} EXCEPT ALL ${left})) differing`)).rows[0]!.rows;
    const everyCapture = (members: string) => `(SELECT capture.capture_id, member.* FROM source_captures capture JOIN LATERAL (${members}) member ON TRUE)`;
    assert.equal(await differing(everyCapture(captureSourceRecordIdsSql("capture.capture_id")), `(${MEMBERS_AS_STORED})`), 0);
    assert.equal(await differing(
      everyCapture(`SELECT member_id, source_record_id FROM (${captureSourceRecordsSql("capture.capture_id")}) rows`),
      `(SELECT member.capture_id, member.source_record_id AS member_id, record.source_record_id
          FROM (${MEMBERS_AS_STORED}) member LEFT JOIN source_records record ON record.source_record_id = member.source_record_id)`), 0);
    // With an occurrence key, the members holding it: every key of every capture.
    assert.equal(await differing(
      `(SELECT capture.capture_id, key.occurrence_key, member.source_record_id
          FROM source_captures capture
         CROSS JOIN (SELECT DISTINCT occurrence_key FROM source_records WHERE occurrence_key IS NOT NULL) key
          JOIN LATERAL (${captureSourceRecordIdsSql("capture.capture_id", "key.occurrence_key")}) member ON TRUE)`,
      `(SELECT member.capture_id, record.occurrence_key, member.source_record_id
          FROM (${MEMBERS_AS_STORED}) member JOIN source_records record ON record.source_record_id = member.source_record_id
         WHERE record.occurrence_key IS NOT NULL)`), 0);

    const digestOf = async (sql: string) => (await store.query<{ rows: number; sha256: string }>(
      `SELECT count(*)::int AS rows,
              encode(sha256(convert_to(COALESCE(string_agg(answer::text, E'\\n' ORDER BY answer::text), ''), 'UTF8')), 'hex') AS sha256
         FROM (${sql}) answer`)).rows[0]!;
    const readers = ["captureMembership"] as const;
    const whole = (await readCompactionReaders(store, undefined, { readers })).captureMembership;
    assert.deepEqual(whole, await digestOf(membershipLookedUpById("TRUE")));
    // A chunk reads the captures that own a copy it removes; here, the captures with a manifest.
    const withManifest = (column: string) => `${column} IN (SELECT capture_id FROM ${MANIFESTS})`;
    const inChunk = (await readCompactionReaders(store, undefined, {
      scope: { chain: () => "TRUE", record: () => "TRUE", capture: withManifest }, readers,
    })).captureMembership;
    assert.deepEqual(inChunk, await digestOf(membershipLookedUpById(withManifest("capture.capture_id"))));
    // The planted manifest's 300 members are among them, the missing one without content; other captures are left out.
    assert.ok(inChunk.rows > 300 && inChunk.rows < whole.rows, `${inChunk.rows} of ${whole.rows} members`);
  } finally {
    await store.close();
  }
});

test("the job analyzes the tables its chunks changed once they are all done", async () => {
  const { store } = await legacyStore();
  try {
    const estimated = async (table: string) =>
      (await store.query<{ rows: number }>("SELECT reltuples::int AS rows FROM pg_class WHERE oid = $1::regclass", [table])).rows[0]!.rows;
    assert.equal(await estimated("source_records"), -1, "never analyzed before the run");
    const result = await runLedgerCompaction(store);
    assert.equal(result.status, "compacted", JSON.stringify(result));
    // No table was rewritten, so the row counts the planner holds come from the job's own ANALYZE.
    assert.equal(result.status === "compacted" && result.reclaim.status, "nothing-to-reclaim");
    const counts = await rowCounts(store);
    for (const table of ["source_records", "assertion_provenance", "source_occurrence_group_counts", MANIFESTS] as const)
      assert.equal(await estimated(table), counts[table], table);
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
      compactLedger(store, {
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
      compactLedger(store, {
        signal: controller.signal,
        onRemoved: () => controller.abort(new Error("Settings closed.")),
      }),
      /Settings closed\./,
    );
    assert.deepEqual(await snapshot(store), before);
    assert.deepEqual(await markers(store), []);

    assert.deepEqual(compacted(await compactLedger(store)).removed, expected);
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
    await assert.rejects(compactLedger(store), (error: unknown) => {
      assert.ok(error instanceof LedgerCompactionError);
      assert.deepEqual(error.failure, { reason: "unexpected-reference", tables: ["probe_citations"] });
      return true;
    });
    await store.exec("DROP TABLE probe_citations; ALTER TABLE source_occurrence_group_counts ENABLE ALWAYS TRIGGER source_occurrence_group_counts_no_delete");
    await assert.rejects(compactLedger(store), (error: unknown) => {
      assert.ok(error instanceof LedgerCompactionError);
      assert.deepEqual(error.failure, {
        reason: "unexpected-trigger",
        triggers: ["source_occurrence_group_counts.source_occurrence_group_counts_no_delete"],
      });
      return true;
    });
    // A record citation phase B does not know fails closed, as the dry run does.
    await store.exec(`ALTER TABLE source_occurrence_group_counts ENABLE TRIGGER source_occurrence_group_counts_no_delete;
      CREATE TABLE probe_record_citations(source_record_id BYTEA REFERENCES source_records(source_record_id))`);
    await assert.rejects(compactLedger(store), (error: unknown) => {
      assert.ok(error instanceof LedgerCompactionError);
      assert.deepEqual(error.failure, {
        reason: "unrecognised-citations",
        problems: [{ table: "probe_record_citations", columns: ["source_record_id"], problem: "unknown-foreign-key" }],
      });
      return true;
    });
    // So does a table that cites a satellite of the copies.
    await store.exec(`DROP TABLE probe_record_citations;
      CREATE TABLE probe_scope_citations(source_record_id BYTEA REFERENCES source_record_scopes(source_record_id))`);
    await assert.rejects(compactLedger(store), (error: unknown) => {
      assert.ok(error instanceof LedgerCompactionError);
      assert.deepEqual(error.failure, { reason: "unexpected-reference", tables: ["probe_scope_citations"] });
      return true;
    });
    await store.exec("DROP TABLE probe_scope_citations");
    before.delete("public.probe_citations");
    assert.deepEqual(await snapshot(store), before);
    compacted(await compactLedger(store));
  } finally {
    await store.close();
  }
});

test("a copy named only by a record id kept as text is kept", async () => {
  const database = await PGlite.create();
  const { store } = await legacyStore(database);
  try {
    // Which copies a compaction removes, learned on a twin.
    const twin = await copyOf(database);
    let removed: string[];
    try {
      const before = await copiesByCapture(twin);
      compacted(await compactLedger(twin));
      const after = await copiesByCapture(twin);
      removed = [...before.keys()].filter((copy) => !after.has(copy)).sort();
    } finally {
      await twin.close();
    }
    assert.ok(removed.length > 0);
    // An enrichment output's provenance names one of them, and nothing else does.
    const named = removed[0]!;
    const uuid = named.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/u, "$1-$2-$3-$4-$5");
    assert.equal(await writeDirectly(store, `UPDATE enrichment_run_outputs
        SET provenance_json = jsonb_set(provenance_json::jsonb, '{sourceRecordId}', to_jsonb('${uuid}'::text))::text
      WHERE output_id = (SELECT output_id FROM enrichment_run_outputs ORDER BY output_id LIMIT 1)`), 1);
    const plan = planned(await planLedgerCompaction(store));
    assert.equal(plan.phaseB.pinnedBy["enrichment_run_outputs.provenance_json"], 1);
    compacted(await compactLedger(store));
    assert.ok((await copiesByCapture(store)).has(named), "the copy named in provenance_json is kept");
  } finally {
    await store.close();
  }
});
