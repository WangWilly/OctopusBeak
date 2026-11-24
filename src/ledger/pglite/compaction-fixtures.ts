/**
 * An old-shaped store for the compaction checks: a store written before ADR
 * 0152. It is built through the reuse check's "any" arm, which stores every
 * record again on each sync. The commands now write their own rows only on
 * change, so the rows their older writers wrote on every sync, and the
 * per-sync count rows, are added here as those writers stored them.
 */
import { PGlite } from "@electric-sql/pglite";
import { captureSourceRecordIdsSql } from "./capture-manifest.ts";
import { commitResync, type ResyncMode } from "./resync-fixtures.ts";
import { installFinancialStore } from "./store-layout.ts";
import type { PGliteStore } from "./transaction.ts";

/** Card-route shares the card command's subject, which would merge their chains; it adds nothing here. */
export const MODES: readonly ResyncMode[] = ["deposit", "card-command", "einvoice", "investment", "loan"];
export const ROWS = 20;
export const SYNCS = 3;

/** Writes `sql` with triggers and foreign-key checks off, as the older writers' rows are inserted directly. */
export async function writeDirectly(store: PGliteStore, sql: string): Promise<number> {
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

export const captureOf = (captureKey: string) => `(SELECT capture_id FROM source_captures WHERE capture_key = '${captureKey}')`;
/** The `n`th occurrence key of a capture's records. */
export const keyOf = (captureKey: string, n: number) =>
  `(SELECT occurrence_key FROM source_records WHERE capture_id = ${captureOf(captureKey)} ORDER BY occurrence_key OFFSET ${n} LIMIT 1)`;
export const copyOf = (captureKey: string, key: string) =>
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
    // The first copy by occurrence key, not by its random id, so the checks that plant defects on later copies never meet it.
    cardMixed: await writeDirectly(store, mixedProvenance(`(
      SELECT record.source_record_id FROM source_records record
       WHERE record.capture_id = ${captureOf(`card-command-capture-${SYNCS}`)}
         AND EXISTS (SELECT 1 FROM assertion_provenance backed WHERE backed.source_record_id = record.source_record_id)
       ORDER BY record.occurrence_key LIMIT 1)`)),
    kind: await writeDirectly(store, `UPDATE source_records SET record_kind = 'fubon-credit-card-statement'
      WHERE source_record_id = (SELECT evidence_source_record_id FROM canonical_credit_card_statement_summary_evidence
                                 WHERE capture_id = ${captureOf("card-command-capture-2")}
                                 ORDER BY evidence_source_record_id LIMIT 1)`),
  };
}

/**
 * Before ADR 0152 a deposit capture wrote its accounts' identifiers again on
 * every sync. Returns the rows after each identifier's first.
 */
async function repeatAccountIdentifiers(store: PGliteStore): Promise<number> {
  const inserted = await writeDirectly(store, `
    INSERT INTO financial_account_identifier_observations(
      observation_id, account_id, capture_id, source_record_id, commit_id,
      identifier_kind, identifier_value, evidence_version, source_field, observed_at)
    SELECT decode(md5(encode(capture.capture_id, 'hex') || encode(account.account_id, 'hex')), 'hex'), account.account_id, capture.capture_id, NULL,
           capture.commit_id, 'depository-account', 'synthetic-account-1', 'v1', 'accountNumber', '2026-01-01'
      FROM source_captures capture
      JOIN financial_accounts account ON account.source_connection_id = capture.source_connection_id
     WHERE capture.capture_key LIKE 'deposit-capture-%'`);
  const { rows: [identifiers] } = await store.query<{ count: number }>(
    "SELECT count(DISTINCT account_id)::int AS count FROM financial_account_identifier_observations");
  return inserted - identifiers!.count;
}

export type Legacy = Readonly<{ store: PGliteStore; repeated: Readonly<Record<string, number>>; edgeCases: Readonly<Record<string, number>> }>;

/** An old-shaped store, one deposit sync through the current writer, which reuses the last copies, and the edge cases. */
export async function legacyStore(database?: PGlite): Promise<Legacy> {
  const store = await installFinancialStore(database ?? await PGlite.create());
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
    financial_account_identifier_observations: await repeatAccountIdentifiers(store),
    source_occurrence_group_counts: await repeatCountRows(store),
  };
  // One repeated count row that saw one more member raises its partition's maximum. It is the
  // window's first day, which the next investment sync no longer covers, so that sync still commits.
  await writeDirectly(store, `
    UPDATE source_occurrence_group_counts SET occurrence_count = occurrence_count + 1
     WHERE observation_id = (
       SELECT count_row.observation_id FROM source_occurrence_group_counts count_row
         JOIN source_occurrence_group_coverages coverage ON coverage.coverage_id = count_row.coverage_id
         JOIN source_captures capture ON capture.capture_id = coverage.capture_id AND capture.capture_key = 'investment-capture-${SYNCS}'
        ORDER BY count_row.partition_date, count_row.observation_id LIMIT 1)`);
  await numberLoanRecordsByPosition(store);
  await giveLastCardCaptureAManifest(store);
  await commitResync(store, "deposit", SYNCS + 1, { rowCount: ROWS });
  return { store, repeated, edgeCases: await addEdgeCases(store) };
}

/**
 * Adds one chain of `copies` records to a `legacyStore`, each seen once and
 * each cited by an assertion row that names a run, so compaction keeps them
 * all. `others` more records, without an occurrence key and spread over many
 * subjects and record kinds, make the store's average chain a single copy,
 * as it is on a store with many sources. Returns the chain's record kind.
 */
export async function addCitedChain(store: PGliteStore, { copies, others }: Readonly<{ copies: number; others: number }>): Promise<string> {
  const kind = "cited-chain-record";
  const subject = "decode(md5('cited-chain-subject'), 'hex')";
  const captures = (keys: string) => `(SELECT capture_id, commit_id, ROW_NUMBER() OVER (ORDER BY capture_id) AS position, count(*) OVER () AS total
                                        FROM source_captures WHERE capture_key LIKE '${keys}-capture-%') capture`;
  await writeDirectly(store, `
    INSERT INTO source_subjects(source_subject_id, source_connection_id, identity_epoch_id, stream, record_kind, subject_digest, created_commit_id)
    SELECT ${subject}, source_connection_id, identity_epoch_id, stream, '${kind}', 'cited-chain-digest', created_commit_id
      FROM source_subjects WHERE record_kind = 'investment-source-record' LIMIT 1`);
  await writeDirectly(store, `
    INSERT INTO source_records(source_record_id, capture_id, source_subject_id, commit_id, record_kind, sequence_lexeme, occurrence_key, payload_json)
    SELECT decode(md5('cited-chain-' || n), 'hex'), capture.capture_id, ${subject}, capture.commit_id, '${kind}', 'cited-' || n, 'cited-' || n, '{}'
      FROM generate_series(1, ${copies}) n JOIN ${captures("investment")} ON capture.position = 1 + n % capture.total`);
  await writeDirectly(store, `
    INSERT INTO assertion_provenance(assertion_id, source_record_id, run_id, enrichment_run_id, coordinate_id, commit_id)
    SELECT (SELECT assertion_id FROM assertions ORDER BY assertion_id LIMIT 1), source_record_id, decode(md5('cited-chain-run'), 'hex'), NULL, NULL, commit_id
      FROM source_records WHERE record_kind = '${kind}'`);
  await writeDirectly(store, `
    INSERT INTO source_records(source_record_id, capture_id, source_subject_id, commit_id, record_kind, sequence_lexeme, occurrence_key, payload_json)
    SELECT decode(md5('other-' || n), 'hex'), capture.capture_id, decode(md5('other-subject-' || (n % 4001)), 'hex'), capture.commit_id,
           'other-kind-' || (n % 97), 'other-' || n, NULL, '{}'
      FROM generate_series(1, ${others}) n JOIN ${captures("deposit")} ON capture.position = 1 + n % capture.total`);
  await store.exec("ANALYZE");
  return kind;
}

/**
 * Adds one chain to a `legacyStore`, held by `captures` new captures, each
 * with its own commit. Every capture holds `fresh` records only it saw, as a
 * holding or balance is new on every sync, and the first `steadyCaptures` of
 * them each hold a copy of the same `steady` records, so compaction removes
 * `steady * (steadyCaptures - 1)` copies. Returns the chain's record kind.
 */
export async function addCaptureChain(
  store: PGliteStore,
  { name, captures, fresh, steady, steadyCaptures }: Readonly<{ name: string; captures: number; fresh: number; steady: number; steadyCaptures: number }>,
): Promise<string> {
  const kind = `${name}-record`;
  const subject = `decode(md5('${name}-subject'), 'hex')`;
  const id = (part: string) => `decode(md5('${name}-${part}-' || n), 'hex')`;
  await writeDirectly(store, `
    INSERT INTO source_subjects(source_subject_id, source_connection_id, identity_epoch_id, stream, record_kind, subject_digest, created_commit_id)
    SELECT ${subject}, source_connection_id, identity_epoch_id, stream, '${kind}', '${name}-digest', created_commit_id
      FROM source_subjects WHERE record_kind = 'investment-source-record' LIMIT 1`);
  await writeDirectly(store, `
    INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind)
    SELECT ${id("commit")}, latest.commit_sequence + n, latest.recorded_at_utc_us + n, latest.authority_route, latest.commit_kind
      FROM generate_series(1, ${captures}) n
     CROSS JOIN (SELECT * FROM canonical_commits ORDER BY commit_sequence DESC LIMIT 1) latest`);
  const { rows: columns } = await store.query<{ name: string }>(
    `SELECT column_name AS name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'source_captures' ORDER BY ordinal_position`,
  );
  const capture: Readonly<Record<string, string>> = {
    capture_id: id("capture"), capture_key: `'${name}-capture-' || n`, source_subject_id: subject, record_kind: `'${kind}'`, commit_id: id("commit"),
  };
  await writeDirectly(store, `
    INSERT INTO source_captures(${columns.map(({ name: column }) => column).join(", ")})
    SELECT ${columns.map(({ name: column }) => capture[column] ?? `src.${column}`).join(", ")}
      FROM generate_series(1, ${captures}) n
     CROSS JOIN (SELECT * FROM source_captures WHERE capture_key = 'investment-capture-1') src`);
  await writeDirectly(store, `
    INSERT INTO source_records(source_record_id, capture_id, source_subject_id, commit_id, record_kind, sequence_lexeme, occurrence_key, payload_json)
    SELECT decode(md5('${name}-record-' || n || '-' || held.key), 'hex'), ${id("capture")}, ${subject}, ${id("commit")}, '${kind}', held.key, held.key,
           '{"key":"' || held.key || '"}'
      FROM generate_series(1, ${captures}) n
     CROSS JOIN LATERAL (
       SELECT 'fresh-' || n || '-' || member AS key FROM generate_series(1, ${fresh}) member
       UNION ALL
       SELECT 'steady-' || member FROM generate_series(1, ${steady}) member WHERE n <= ${steadyCaptures}
     ) held`);
  await store.exec("ANALYZE");
  return kind;
}

/** Every row of every table, as a row count and a digest of the rows. */
export async function snapshot(store: PGliteStore): Promise<Map<string, string>> {
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
