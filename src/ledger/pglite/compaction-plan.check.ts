/**
 * The compaction dry run must count what a compaction of a store written
 * before ADR 0152 would remove, and change nothing. The store is built
 * through the reuse check's "any" arm, which stores every record again on
 * each sync. The commands now write their own rows only on change, so the
 * rows their older writers wrote on every sync, and the per-sync count rows,
 * are added here as those writers stored them.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { planLedgerCompaction, type CompactionPlan, type CompactionPlanResult } from "./compaction-plan.ts";
import { captureSourceRecordIdsSql } from "./capture-manifest.ts";
import { commitResync, type ResyncMode } from "./resync-fixtures.ts";
import { installFinancialStore } from "./store-layout.ts";
import type { PGliteStore } from "./transaction.ts";
import { PGLITE_FINANCIAL_CONTRACTS } from "../../lib/pglite-rpc/pglite-financial-contracts.ts";
import { createPGliteWorkScheduler } from "../../../electron/pglite-financial-rpc-server.ts";

/** Card-route shares the card command's subject, which would merge their chains; it adds nothing here. */
const MODES: readonly ResyncMode[] = ["deposit", "card-command", "einvoice", "investment", "loan"];
const ROWS = 20;
const SYNCS = 3;

/** Writes `sql` with triggers and foreign-key checks off, as the older writers' rows are inserted directly. */
async function writeDirectly(store: PGliteStore, sql: string): Promise<number> {
  return store.transaction(async (transaction) => {
    await transaction.query("SET LOCAL session_replication_role = replica");
    return (await transaction.query(sql)).affectedRows ?? 0;
  });
}

/**
 * Before ADR 0152 a command wrote its rows on every sync, each citing that
 * sync's copy of its record. Copy each stored row onto every later copy of
 * the record it cites, with the later copy's capture and commit and fresh ids.
 */
async function repeatOnLaterCopies(
  store: PGliteStore,
  table: string,
  recordColumn: string,
  overrides: Readonly<Record<string, string>> = {},
): Promise<number> {
  const { rows: columns } = await store.query<{ name: string }>(
    `SELECT column_name AS name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  const freshId = (column: string) => `decode(md5(encode(src.${column}, 'hex') || encode(later.source_record_id, 'hex')), 'hex')`;
  const value = ({ name }: { name: string }) => {
    if (name in overrides) return overrides[name]!;
    if (name === recordColumn) return "later.source_record_id";
    if (name === "capture_id") return "later.capture_id";
    if (name === "commit_id") return "later.commit_id";
    if (["lifecycle_event_id", "event_id", "observation_id"].includes(name)) return freshId(name);
    return `src.${name}`;
  };
  return writeDirectly(store, `
    INSERT INTO ${table}(${columns.map(({ name }) => name).join(", ")})
    SELECT ${columns.map(value).join(", ")}
      FROM ${table} src
      JOIN source_records cited ON cited.source_record_id = src.${recordColumn}
      JOIN canonical_commits cited_commit ON cited_commit.commit_id = cited.commit_id
      JOIN source_records later ON later.source_subject_id = cited.source_subject_id
       AND later.record_kind = cited.record_kind AND later.occurrence_key = cited.occurrence_key
      JOIN canonical_commits later_commit ON later_commit.commit_id = later.commit_id
       AND later_commit.commit_sequence > cited_commit.commit_sequence`);
}

/** Every count row again under each later coverage of its partition whose window holds its date. */
async function repeatCountRows(store: PGliteStore): Promise<number> {
  return writeDirectly(store, `
    INSERT INTO source_occurrence_group_counts(observation_id, coverage_id, partition_date, fingerprint, bucket_key, occurrence_count)
    SELECT decode(md5(encode(count_row.observation_id, 'hex') || encode(later.coverage_id, 'hex')), 'hex'),
           later.coverage_id, count_row.partition_date, count_row.fingerprint, count_row.bucket_key, count_row.occurrence_count
      FROM source_occurrence_group_counts count_row
      JOIN source_occurrence_group_coverages coverage ON coverage.coverage_id = count_row.coverage_id
      JOIN canonical_commits written ON written.commit_id = coverage.commit_id
      JOIN source_occurrence_group_coverages later ON later.source_subject_id = coverage.source_subject_id
       AND later.record_kind = coverage.record_kind AND later.scope_key = coverage.scope_key
       AND later.contract_version = coverage.contract_version
       AND count_row.partition_date BETWEEN later.scope_start AND later.scope_end
      JOIN canonical_commits later_written ON later_written.commit_id = later.commit_id
       AND later_written.commit_sequence > written.commit_sequence`);
}

/**
 * The Fubon and Yuanta loan adapters used to number records by position, so
 * a record that aged out renumbered every record after it (ADR 0152).
 */
async function numberLoanRecordsByPosition(store: PGliteStore): Promise<void> {
  const positions = `SELECT source_record_id, 'position-' || lpad(ROW_NUMBER() OVER (
      PARTITION BY capture_id ORDER BY occurrence_group_partition_date, occurrence_group_ordinal, occurrence_key)::text, 4, '0') AS lexeme
    FROM source_records WHERE record_kind = 'fubon-loan-transaction'`;
  await writeDirectly(store, `UPDATE source_records record SET sequence_lexeme = position.lexeme
    FROM (${positions}) position WHERE position.source_record_id = record.source_record_id`);
  await writeDirectly(store, `UPDATE source_record_scopes scope SET sequence_lexeme = record.sequence_lexeme
    FROM source_records record WHERE record.source_record_id = scope.source_record_id AND record.record_kind = 'fubon-loan-transaction'`);
}

/**
 * A capture written after ADR 0152 that stored its records again and reused
 * one: the card command's last capture, reusing the first copy of a
 * purchase that has left its window.
 */
async function giveLastCardCaptureAManifest(store: PGliteStore): Promise<void> {
  await writeDirectly(store, `
    INSERT INTO capture_source_record_manifests(capture_id, source_record_ids, record_count, commit_id)
    SELECT last.capture_id, aged.source_record_id, 1, last.commit_id
      FROM source_captures last
      JOIN source_records aged ON aged.capture_id = (SELECT capture_id FROM source_captures WHERE capture_key = 'card-command-capture-1')
     WHERE last.capture_key = 'card-command-capture-${SYNCS}'
       AND aged.occurrence_key NOT IN (SELECT occurrence_key FROM source_records WHERE capture_id = last.capture_id)
     ORDER BY aged.source_record_id
     LIMIT 1`);
}

const captureOf = (captureKey: string) => `(SELECT capture_id FROM source_captures WHERE capture_key = '${captureKey}')`;
/** The `n`th occurrence key of a capture's records. */
const keyOf = (captureKey: string, n: number) =>
  `(SELECT occurrence_key FROM source_records WHERE capture_id = ${captureOf(captureKey)} ORDER BY occurrence_key OFFSET ${n} LIMIT 1)`;
const copyOf = (captureKey: string, key: string) =>
  `(SELECT source_record_id FROM source_records WHERE capture_id = ${captureOf(captureKey)} AND occurrence_key = ${key})`;

/**
 * An assertion row on `copy` that also names an enrichment run, for an
 * assertion its source rows do not back, so the run row must neither count
 * as a backed assertion nor leave the copy removable.
 */
const mixedProvenance = (copy: string) => `
  INSERT INTO assertion_provenance(assertion_id, source_record_id, run_id, enrichment_run_id, coordinate_id, commit_id)
  SELECT (SELECT other.assertion_id FROM assertions other
           WHERE other.assertion_id NOT IN (SELECT backed.assertion_id FROM assertion_provenance backed WHERE backed.source_record_id = source.source_record_id)
           ORDER BY other.assertion_id LIMIT 1),
         source_record_id, NULL, decode(md5('mixed' || encode(source_record_id, 'hex')), 'hex'), NULL, commit_id
    FROM assertion_provenance source WHERE source_record_id = ${copy} AND run_id IS NULL AND enrichment_run_id IS NULL AND coordinate_id IS NULL
   LIMIT 1`;

/**
 * Copies that differ, or are kept, for each reason the planner compares, one
 * reason per copy, so each comparison decides a count:
 * - an invoice whose second-sync payload differs, so it and the copy after it changed;
 * - an invoice whose third sync also created a revision, which keeps that sync's observation;
 * - an invoice whose second sync wrote a revocation, which keeps that sync's observation;
 * - the third investment sync's coverage, now with a bucket inventory;
 * - a second-sync loan counterpart that backs no assertion;
 * - an assertion row naming a run on a deposit copy, and on a card copy whose capture has a manifest;
 * - a second-sync statement record stored under another record kind, with the occurrence key of its kind's copies.
 */
async function addEdgeCases(store: PGliteStore): Promise<Readonly<Record<string, number>>> {
  const invoice = (n: number) => keyOf("einvoice-capture-3", n);
  const { rows: revisionColumns } = await store.query<{ name: string }>(
    `SELECT column_name AS name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'einvoice_invoice_revisions' ORDER BY ordinal_position`,
  );
  const revised: Readonly<Record<string, string>> = {
    revision_id: "decode(md5('revised'), 'hex')",
    source_record_id: copyOf("einvoice-capture-3", invoice(1)),
    capture_id: captureOf("einvoice-capture-3"),
    commit_id: `(SELECT commit_id FROM source_captures WHERE capture_key = 'einvoice-capture-3')`,
    source_revision_key: "src.source_revision_key || '-revised'",
    revision_number: "src.revision_number + 1",
    revision_kind: "'revised'",
    fact_fingerprint: "src.fact_fingerprint || '-revised'",
  };
  return {
    payload: await writeDirectly(store, `UPDATE source_records SET payload_json = payload_json || ' '
      WHERE source_record_id = ${copyOf("einvoice-capture-2", invoice(0))}`),
    revision: await writeDirectly(store, `
      INSERT INTO einvoice_invoice_revisions(${revisionColumns.map(({ name }) => name).join(", ")})
      SELECT ${revisionColumns.map(({ name }) => revised[name] ?? `src.${name}`).join(", ")}
        FROM einvoice_invoice_revisions src WHERE src.source_record_id = ${copyOf("einvoice-capture-1", invoice(1))}`),
    revocation: await writeDirectly(store, `UPDATE einvoice_revision_events SET event_kind = 'revoked'
      WHERE source_record_id = ${copyOf("einvoice-capture-2", invoice(2))}`),
    shape: await writeDirectly(store, `UPDATE source_occurrence_group_coverages SET bucket_inventory_json = '[]'
      WHERE capture_id = ${captureOf(`investment-capture-${SYNCS}`)}`),
    backing: await writeDirectly(store, `DELETE FROM assertion_provenance
      WHERE source_record_id IN (SELECT source_record_id FROM source_records WHERE capture_id = ${captureOf("loan-counterpart-capture-2-0")})`),
    depositMixed: await writeDirectly(store, mixedProvenance(`(
      SELECT source_record_id FROM source_records WHERE capture_id = ${captureOf(`deposit-capture-${SYNCS}`)}
         AND source_record_id NOT IN (${captureSourceRecordIdsSql(captureOf(`deposit-capture-${SYNCS + 1}`))}))`)),
    cardMixed: await writeDirectly(store, mixedProvenance(`(
      SELECT source_record_id FROM assertion_provenance
       WHERE source_record_id IN (SELECT source_record_id FROM source_records WHERE capture_id = ${captureOf(`card-command-capture-${SYNCS}`)})
       ORDER BY source_record_id LIMIT 1)`)),
    kind: await writeDirectly(store, `UPDATE source_records SET record_kind = 'fubon-credit-card-statement'
      WHERE source_record_id = (SELECT evidence_source_record_id FROM canonical_credit_card_statement_summary_evidence
                                 WHERE capture_id = ${captureOf("card-command-capture-2")})`),
  };
}

type Legacy = Readonly<{ store: PGliteStore; repeated: Readonly<Record<string, number>>; edgeCases: Readonly<Record<string, number>> }>;

/** An old-shaped store, one deposit sync through the current writer, which reuses the last copies, and the edge cases. */
async function legacyStore(): Promise<Legacy> {
  const store = await installFinancialStore(await PGlite.create());
  for (const mode of MODES)
    for (let sync = 1; sync <= SYNCS; sync += 1) await commitResync(store, mode, sync, { rowCount: ROWS, reuseSourceRecords: false });
  const repeated: Record<string, number> = {
    canonical_credit_card_transaction_details: await repeatOnLaterCopies(store, "canonical_credit_card_transaction_details", "source_record_id"),
    canonical_credit_card_transaction_lifecycle: await repeatOnLaterCopies(store, "canonical_credit_card_transaction_lifecycle", "source_record_id"),
    canonical_credit_card_instrument_evidence: await repeatOnLaterCopies(store, "canonical_credit_card_instrument_evidence", "source_record_id"),
    canonical_credit_card_statement_summary_evidence:
      await repeatOnLaterCopies(store, "canonical_credit_card_statement_summary_evidence", "evidence_source_record_id"),
    investment_security_name_observations: await repeatOnLaterCopies(store, "investment_security_name_observations", "source_record_id"),
    transaction_relation_provenance: await repeatOnLaterCopies(store, "transaction_relation_provenance", "source_record_id"),
    einvoice_revision_observations: await repeatOnLaterCopies(store, "einvoice_revision_observations", "source_record_id"),
    einvoice_revision_events: await repeatOnLaterCopies(store, "einvoice_revision_events", "source_record_id", { event_kind: "'observed'" }),
    source_occurrence_group_counts: await repeatCountRows(store),
  };
  // One repeated count row that saw one more member raises its partition's maximum.
  await writeDirectly(store, `
    UPDATE source_occurrence_group_counts SET occurrence_count = occurrence_count + 1
     WHERE observation_id = (
       SELECT count_row.observation_id FROM source_occurrence_group_counts count_row
         JOIN source_occurrence_group_coverages coverage ON coverage.coverage_id = count_row.coverage_id
         JOIN source_captures capture ON capture.capture_id = coverage.capture_id AND capture.capture_key = 'investment-capture-${SYNCS}'
        ORDER BY count_row.observation_id LIMIT 1)`);
  await numberLoanRecordsByPosition(store);
  await giveLastCardCaptureAManifest(store);
  await commitResync(store, "deposit", SYNCS + 1, { rowCount: ROWS });
  return { store, repeated, edgeCases: await addEdgeCases(store) };
}

function planned(result: CompactionPlanResult): CompactionPlan {
  assert.equal(result.status, "planned", JSON.stringify(result));
  return result as CompactionPlan;
}

/** Every row of every table, as a row count and a digest of the rows. */
async function snapshot(store: PGliteStore): Promise<Map<string, string>> {
  const { rows: tables } = await store.query<{ name: string }>(
    `SELECT format('%I.%I', table_schema, table_name) AS name FROM information_schema.tables
      WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1`,
  );
  const digests = new Map<string, string>();
  for (const { name } of tables) {
    const { rows: [row] } = await store.query<{ digest: string }>(
      `SELECT count(*) || ':' || COALESCE(md5(string_agg(md5(t::text), ',' ORDER BY md5(t::text))), '') AS digest FROM ${name} t`,
    );
    digests.set(name, row!.digest);
  }
  return digests;
}

test("the dry run counts what compaction would remove from an old-shaped store", async () => {
  const { store, repeated, edgeCases } = await legacyStore();
  try {
    const plan = planned(await planLedgerCompaction(store));
    // Each edge case touched what it names; the loan counterpart backed one assertion.
    assert.deepEqual(edgeCases, { payload: 1, revision: 1, revocation: 1, shape: 1, backing: 1, depositMixed: 1, cardMixed: 1, kind: 1 });

    // Phase A: every row the older writers repeated, and no row they wrote first.
    assert.deepEqual(repeated, {
      // Purchases seen again: 19 on the second sync and 18 on the third.
      canonical_credit_card_transaction_details: 37,
      canonical_credit_card_transaction_lifecycle: 37,
      canonical_credit_card_instrument_evidence: 2,
      // The second statement only; the first leaves the window on the second sync.
      canonical_credit_card_statement_summary_evidence: 2,
      investment_security_name_observations: 10,
      transaction_relation_provenance: 6,
      einvoice_revision_observations: 37,
      einvoice_revision_events: 37,
      source_occurrence_group_counts: repeated.source_occurrence_group_counts!,
    });
    assert.ok(repeated.source_occurrence_group_counts! > 0);
    assert.deepEqual(
      Object.fromEntries(plan.phaseA.map(({ table, removable }) => [table, removable])),
      {
        ...Object.fromEntries(Object.entries(repeated).filter(([table]) => table !== "source_occurrence_group_counts")),
        financial_account_identifier_observations: 0,
        // The invoice whose third sync created a revision, and the one whose second sync revoked, keep that observation and event.
        einvoice_revision_observations: 35,
        einvoice_revision_events: 35,
      },
    );

    // Phase B: copies cited only by phase A repeats are removable, the
    // copies the new sync reused are pinned by its manifest, the loan copies
    // differ only by position, the copies of a capture with a manifest wait,
    // and each edge case moves the copies it touched.
    const groups = Object.fromEntries(plan.phaseB.groups.map((group) => [`${group.integrationNamespace}/${group.recordKind}`, group]));
    const counts = (copies: number, first: number, rest: Partial<Record<"changed" | "manifestCapture" | "pinned" | "lexemeOnly" | "removable", number>>) =>
      ({ copies, unchained: 0, first, changed: 0, manifestCapture: 0, pinned: 0, lexemeOnly: 0, removable: 0, ...rest });
    assert.deepEqual(Object.keys(groups).sort(), [
      "einvoice/personal-invoice",
      "fubon/fubon-credit-card-statement",
      "fubon/fubon-credit-card-transaction",
      "fubon/fubon-domestic-deposit",
      "fubon/fubon-loan-counterpart-deposit",
      "fubon/fubon-loan-transaction",
      "yuanta-fund/investment-source-record",
    ]);
    // 20 + 19 + 18 copies; the fourth sync reused the third sync's 17 still in
    // its window, and the one it did not reuse names a run.
    assert.deepEqual(groups["fubon/fubon-domestic-deposit"]!.counts, counts(57, 20, { pinned: 18, removable: 19 }));
    assert.deepEqual(groups["fubon/fubon-domestic-deposit"]!.pinnedBy, {
      capture_source_record_manifests: 17,
      "assertion_provenance (non-source)": 1,
    });
    // Purchases, the instrument and the statements: 23, 21 and 20 copies, less
    // the second-sync statement stored under its own kind. The third sync's
    // copies wait for their manifest capture, the one naming a run too.
    assert.deepEqual(groups["fubon/fubon-credit-card-transaction"]!.counts, counts(63, 23, { manifestCapture: 20, removable: 20 }));
    assert.deepEqual(groups["fubon/fubon-credit-card-statement"]!.counts, counts(1, 1, {}));
    // The changed payload changes its copy and the one after it; the created
    // revision and the revocation keep a copy each.
    assert.deepEqual(groups["einvoice/personal-invoice"]!.counts, counts(57, 20, { changed: 2, pinned: 2, removable: 33 }));
    assert.deepEqual(groups["einvoice/personal-invoice"]!.pinnedBy, {
      einvoice_invoice_revisions: 1,
      einvoice_revision_events: 2,
      einvoice_revision_observations: 2,
    });
    // Two holdings a sync, each new; the third sync's 18 transactions have another coverage shape.
    assert.deepEqual(groups["yuanta-fund/investment-source-record"]!.counts, counts(63, 26, { changed: 18, removable: 19 }));
    assert.deepEqual(groups["fubon/fubon-loan-transaction"]!.counts, counts(57, 20, { lexemeOnly: 37 }));
    // The counterpart that backs nothing, and the copy after it.
    assert.deepEqual(groups["fubon/fubon-loan-counterpart-deposit"]!.counts, counts(9, 3, { changed: 2, removable: 4 }));
    assert.deepEqual(plan.phaseB.pinnedBy, {
      capture_source_record_manifests: 17,
      "assertion_provenance (non-source)": 1,
      einvoice_invoice_revisions: 1,
      einvoice_revision_events: 2,
      einvoice_revision_observations: 2,
    });

    const removedCopies = 19 + 20 + 33 + 19 + 4;
    const tables = Object.fromEntries(plan.phaseB.tables.map(({ table, removable }) => [table, removable]));
    assert.equal(tables.source_records, removedCopies);
    assert.equal(tables.source_record_scopes, removedCopies);
    assert.equal(tables.source_record_provenance, removedCopies);
    const { rows: [backing] } = await store.query<{ rows: number }>(
      `SELECT count(*)::int AS rows FROM assertion_provenance WHERE source_record_id IN (SELECT source_record_id FROM source_records)`,
    );
    assert.ok(tables.assertion_provenance! > 0 && tables.assertion_provenance! < backing!.rows);

    // Phase C: every repeated count row, but not the one that raised its maximum.
    assert.equal(plan.phaseC.removable, repeated.source_occurrence_group_counts! - 1);

    for (const table of [...plan.phaseA, ...plan.phaseB.tables, plan.phaseC])
      assert.equal(table.estimatedBytes > 0, table.removable > 0, `${table.table} estimates bytes only for rows it removes`);
    assert.equal(
      plan.estimatedBytes,
      [...plan.phaseA, ...plan.phaseB.tables, plan.phaseC].reduce((sum, table) => sum + table.estimatedBytes, 0),
    );
    assert.ok(plan.estimatedBytes < plan.databaseBytes);
    assert.ok(plan.citingColumns.includes("transaction_revisions.source_record_id"));
  } finally {
    await store.close();
  }
});

test("the dry run changes no row", async () => {
  const { store } = await legacyStore();
  try {
    const before = await snapshot(store);
    planned(await planLedgerCompaction(store));
    assert.deepEqual(await snapshot(store), before);
    // The store still takes writes once the read-only transaction is gone.
    await commitResync(store, "deposit", SYNCS + 2, { rowCount: ROWS });
  } finally {
    await store.close();
  }
});

test("the dry run is a host-only financial operation", () => {
  const contract = PGLITE_FINANCIAL_CONTRACTS["financial.canonical.compactionPlan"];
  assert.equal("renderer" in contract, false);
  assert.equal(contract.workflow, undefined);
  assert.equal(contract.lane, "background-steps");
});

test("the dry run runs in steps that other queued work runs between, and stops when aborted", async () => {
  const { store } = await legacyStore();
  try {
    const whole = planned(await planLedgerCompaction(store));
    const scheduler = createPGliteWorkScheduler();
    const order: string[] = [];
    let steps = 0;
    const stepped = planLedgerCompaction(store, {
      runStep: (step) => scheduler.schedule("background", async () => {
        steps += 1;
        order.push(`step ${steps}`);
        if (steps === 1) void scheduler.schedule("interactive", async () => order.push("click"));
        return step();
      }),
    });
    assert.deepEqual(await stepped, whole);
    // Nine phase A tables, six subjects, the citation check, the subject list and the sizes.
    assert.equal(steps, 1 + 9 + 1 + 6 + 1);
    assert.deepEqual(order.slice(0, 3), ["step 1", "click", "step 2"]);

    const controller = new AbortController();
    let started = 0;
    await assert.rejects(
      planLedgerCompaction(store, {
        signal: controller.signal,
        runStep: (step) => {
          started += 1;
          if (started === 3) controller.abort(new Error("Settings closed."));
          return step();
        },
      }),
      /Settings closed\./,
    );
    assert.equal(started, 3);
  } finally {
    await store.close();
  }
});

test("the dry run refuses a store with a record citation it does not know", async () => {
  const store = await installFinancialStore(await PGlite.create());
  try {
    await commitResync(store, "deposit", 1, { rowCount: ROWS, reuseSourceRecords: false });
    await store.exec(`CREATE SCHEMA probe;
      CREATE TABLE probe.citations(citation_id BYTEA PRIMARY KEY, source_record_id BYTEA REFERENCES source_records(source_record_id));
      CREATE TABLE probe.loose_citations(statement_source_record_id BYTEA)`);
    assert.deepEqual(await planLedgerCompaction(store), {
      status: "unrecognised-citations",
      problems: [
        { table: "probe.citations", columns: ["source_record_id"], problem: "unknown-foreign-key" },
        { table: "probe.loose_citations", columns: ["statement_source_record_id"], problem: "no-foreign-key" },
      ],
    });
  } finally {
    await store.close();
  }
});
