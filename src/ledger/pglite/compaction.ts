import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { latestCardDetailsByRevisionSql } from "./card-details-sql.ts";
import { COUNTS, PHASE_A, phaseCMarkedSql, type PhaseATable } from "./compaction-plan.ts";
import type { PGliteStore, PGliteTransaction } from "./transaction.ts";

/**
 * Compacts the domain rows and count rows of a store written before ADR 0152
 * (ADR 0154): phases A and C of the compaction the dry run plans. Record
 * copies, phase B, are not touched.
 *
 * - A: in each table a command now writes only on change, a row that repeats
 *   the row before it, in its reader's order, is removed; the first of each
 *   run is kept.
 * - C: a count row that does not raise the maximum stored before it in its
 *   partition is removed.
 *
 * The rows are the ones the dry run marks: both run the same queries
 * (`PHASE_A` and `phaseCMarkedSql`). Everything happens in one transaction.
 * Before deleting, each answer in `COMPACTION_READERS` is read as a digest,
 * latest and at every knowledge point; after deleting, it is read again,
 * and any difference throws, which rolls the transaction back. A marker in
 * `pglite_operational_migrations`, written in the same transaction, makes a
 * second run a no-op.
 *
 * Not for the open path, and not yet for the UI: the whole compaction is one
 * transaction that holds the ledger for as long as it runs. Wire it to
 * Settings only through the chunked worker job, which also rewrites the
 * tables to return their space (VACUUM FULL); until then it is a host-only
 * financial operation.
 */

const COMPACTED = "ledger-compaction-domain-counts-v1";

export type CompactedTable = PhaseATable | typeof COUNTS;

const COMPACTED_TABLES: readonly CompactedTable[] = [...(Object.keys(PHASE_A) as PhaseATable[]), COUNTS];

const commitOfCapture = (alias: string) =>
  `JOIN source_captures ${alias}_capture ON ${alias}_capture.capture_id = ${alias}.capture_id
   JOIN canonical_commits ${alias}_commit ON ${alias}_commit.commit_id = ${alias}_capture.commit_id`;
const commitOf = (alias: string) => `JOIN canonical_commits ${alias}_commit ON ${alias}_commit.commit_id = ${alias}.commit_id`;

/**
 * A value's history at every knowledge point: for each key and each commit
 * that wrote a row for it, the value a reader as of that commit sees (the
 * row `latestFirst` orders first), kept where it differs from the commit
 * before. Two tables with equal histories answer "the latest value as of
 * commit N" alike for every N. `key` and `value` map output names to
 * expressions over `from`, which yields `commit_sequence`.
 */
function historySql(
  key: Readonly<Record<string, string>>,
  value: Readonly<Record<string, string>>,
  from: string,
  latestFirst: string,
): string {
  const keys = Object.keys(key).join(", ");
  const values = Object.keys(value).join(", ");
  const keyExpressions = Object.values(key).join(", ");
  const columns = (named: Readonly<Record<string, string>>) =>
    Object.entries(named).map(([name, expression]) => `${expression} AS ${name}`).join(", ");
  return `
    SELECT ${keys}, commit_sequence, ${values} FROM (
      SELECT at_commit.*,
             ROW_NUMBER() OVER history = 1 OR ROW(${values}) IS DISTINCT FROM LAG(ROW(${values})) OVER history AS changes
        FROM (
          SELECT DISTINCT ON (${keyExpressions}, commit_sequence) ${columns(key)}, commit_sequence, ${columns(value)}
            ${from}
           ORDER BY ${keyExpressions}, commit_sequence, ${latestFirst}
        ) at_commit
      WINDOW history AS (PARTITION BY ${keys} ORDER BY commit_sequence)
    ) step WHERE changes`;
}

/** Each invoice's set of observed revisions, as one text value per observing commit. */
const OBSERVED_SETS = `
  SELECT revision.invoice_id, observation_commit.commit_sequence,
         string_agg(encode(observation.revision_id, 'hex'), ',' ORDER BY observation.revision_id) AS observed
    FROM einvoice_revision_observations observation
    JOIN einvoice_invoice_revisions revision ON revision.revision_id = observation.revision_id
    JOIN canonical_commits observation_commit ON observation_commit.commit_id = observation.commit_id
   GROUP BY revision.invoice_id, observation_commit.commit_sequence`;

/**
 * The answers the removed rows feed, each as the rows its reader can tell
 * apart. Each mirrors its reader's selection and keeps every column a reader
 * returns or compares; generated ids are kept as stored, so a reader that
 * would now pick a row with other values differs. The history readers hold
 * each table's answer at every knowledge point, which keeping the first row
 * of a run preserves and keeping the last would not.
 */
export const COMPACTION_READERS = {
  /** `latestCardDetailsByRevisionSql`: the spending facts, the purchase report and the pairing projection. */
  cardDetailsLatestByRevision: latestCardDetailsByRevisionSql(
    `detail.revision_id, detail.transaction_id, detail.instrument_id, detail.billing_status,
     detail.consume_date, detail.posting_date, detail.effective_date_basis, detail.statement_key`,
  ),
  /** The card command's stored details of a transaction, which it compares a new capture with. */
  cardDetailsLatestByTransaction: `
    SELECT DISTINCT ON (revision.transaction_id) revision.transaction_id, detail.revision_id, detail.instrument_id,
           detail.billing_status, detail.consume_date, detail.posting_date, detail.effective_date_basis, detail.statement_key
      FROM transaction_revisions revision
      JOIN canonical_credit_card_transaction_details detail ON detail.revision_id = revision.revision_id
      ${commitOfCapture("detail")}
     ORDER BY revision.transaction_id, detail_commit.commit_sequence DESC, detail.source_record_id DESC`,
  /** The spending facts' date match, which any details row of a revision can satisfy. */
  cardDetailsDateMatch: `SELECT DISTINCT revision_id, consume_date FROM canonical_credit_card_transaction_details`,
  /** `listLatestLifecycle`: a statement member's billing status, by transaction. */
  cardLifecycleLatest: `
    SELECT DISTINCT ON (lifecycle.transaction_id) lifecycle.transaction_id, lifecycle.revision_id, lifecycle.instrument_id,
           lifecycle.billing_status, lifecycle.statement_key
      FROM canonical_credit_card_transaction_lifecycle lifecycle ${commitOfCapture("lifecycle")}
     ORDER BY lifecycle.transaction_id, lifecycle_commit.commit_sequence DESC, lifecycle.lifecycle_event_id DESC`,
  /** The card command's stored lifecycle of a transaction, by namespace and account. */
  cardLifecycleLatestByAccount: `
    SELECT DISTINCT ON (lifecycle.integration_namespace, lifecycle.account_id, lifecycle.transaction_id)
           lifecycle.integration_namespace, lifecycle.account_id, lifecycle.transaction_id, lifecycle.revision_id,
           lifecycle.instrument_id, lifecycle.billing_status, lifecycle.statement_key
      FROM canonical_credit_card_transaction_lifecycle lifecycle ${commitOfCapture("lifecycle")}
     ORDER BY lifecycle.integration_namespace, lifecycle.account_id, lifecycle.transaction_id,
              lifecycle_commit.commit_sequence DESC, lifecycle.lifecycle_event_id DESC`,
  /** The card command's stored evidence of an instrument. */
  cardInstrumentEvidenceLatest: `
    SELECT DISTINCT ON (evidence.instrument_id) evidence.instrument_id, record.occurrence_key
      FROM canonical_credit_card_instrument_evidence evidence
      JOIN source_records record ON record.source_record_id = evidence.source_record_id
      ${commitOfCapture("evidence")}
     ORDER BY evidence.instrument_id, evidence_commit.commit_sequence DESC, evidence.source_record_id DESC`,
  /** The card command's stored summary of a statement. */
  cardStatementSummaryLatest: `
    SELECT DISTINCT ON (revision.statement_id) revision.statement_id, evidence.statement_revision_id, evidence.evidence_key
      FROM canonical_credit_card_statement_summary_evidence evidence
      JOIN canonical_credit_card_statement_revisions revision ON revision.statement_revision_id = evidence.statement_revision_id
      ${commitOfCapture("evidence")}
     ORDER BY revision.statement_id, evidence_commit.commit_sequence DESC, evidence.evidence_source_record_id DESC`,
  /** The overview's and the investment command's name of a security at every knowledge point. */
  securityNamesAtEveryKnowledgePoint: historySql(
    { security_id: "observation.security_id" },
    { name: "observation.name", contract_version: "observation.contract_version" },
    `FROM (SELECT observation.*, observation_commit.commit_sequence
             FROM investment_security_name_observations observation ${commitOf("observation")}) observation`,
    "observation.capture_id DESC",
  ),
  /** The loan command's stored evidence of a relation. */
  relationEvidenceLatest: `
    SELECT DISTINCT ON (entry.relation_id) entry.relation_id, entry.evidence_source_record_key, entry.evidence_relation_id,
           entry.evidence_contract_version
      FROM transaction_relation_provenance entry ${commitOf("entry")}
     ORDER BY entry.relation_id, entry_commit.commit_sequence DESC, entry.source_record_id DESC`,
  /** Account identity continuity (ADR 0049), and the writer's first-sighting check: whether an identifier was seen. */
  accountIdentifiers: `
    SELECT DISTINCT account_id, identifier_kind, identifier_value, evidence_version, source_field
      FROM financial_account_identifier_observations`,
  /** The e-invoice command's latest observed revisions of an invoice. */
  einvoiceLatestObserved: `
    SELECT DISTINCT invoice_id, revision_id FROM (
      SELECT revision.invoice_id, observation.revision_id, observation_commit.commit_sequence,
             MAX(observation_commit.commit_sequence) OVER (PARTITION BY revision.invoice_id) AS latest_sequence
        FROM einvoice_invoice_revisions revision
        JOIN einvoice_revision_observations observation ON observation.revision_id = revision.revision_id
        ${commitOf("observation")}
    ) observed WHERE commit_sequence = latest_sequence`,
  /** The invoice view's `provenanceComplete`: which revisions have an observation. */
  einvoiceObservedRevisions: `SELECT DISTINCT revision_id FROM einvoice_revision_observations`,
  /** The member-loss guard and the count writer: the highest count of each partition. */
  occurrenceCountMaxima: `
    SELECT coverage.source_subject_id, coverage.record_kind, coverage.scope_key, coverage.contract_version,
           count_row.partition_date, count_row.fingerprint, MAX(count_row.occurrence_count) AS occurrence_count
      FROM source_occurrence_group_counts count_row
      JOIN source_occurrence_group_coverages coverage ON coverage.coverage_id = count_row.coverage_id
     GROUP BY 1, 2, 3, 4, 5, 6`,
  cardDetailsHistory: historySql(
    { transaction_id: "detail.transaction_id" },
    {
      revision_id: "detail.revision_id", instrument_id: "detail.instrument_id", billing_status: "detail.billing_status",
      consume_date: "detail.consume_date", posting_date: "detail.posting_date",
      effective_date_basis: "detail.effective_date_basis", statement_key: "detail.statement_key",
    },
    `FROM (SELECT detail.*, detail_commit.commit_sequence
             FROM canonical_credit_card_transaction_details detail ${commitOfCapture("detail")}) detail`,
    "detail.source_record_id DESC",
  ),
  cardLifecycleHistory: historySql(
    { integration_namespace: "lifecycle.integration_namespace", account_id: "lifecycle.account_id", transaction_id: "lifecycle.transaction_id" },
    {
      revision_id: "lifecycle.revision_id", instrument_id: "lifecycle.instrument_id",
      billing_status: "lifecycle.billing_status", statement_key: "lifecycle.statement_key",
    },
    `FROM (SELECT lifecycle.*, lifecycle_commit.commit_sequence
             FROM canonical_credit_card_transaction_lifecycle lifecycle ${commitOfCapture("lifecycle")}) lifecycle`,
    "lifecycle.lifecycle_event_id DESC",
  ),
  cardInstrumentEvidenceHistory: historySql(
    { instrument_id: "evidence.instrument_id" },
    { occurrence_key: "evidence.occurrence_key" },
    `FROM (SELECT evidence.*, record.occurrence_key, evidence_commit.commit_sequence
             FROM canonical_credit_card_instrument_evidence evidence
             JOIN source_records record ON record.source_record_id = evidence.source_record_id
             ${commitOfCapture("evidence")}) evidence`,
    "evidence.source_record_id DESC",
  ),
  cardStatementSummaryHistory: historySql(
    { statement_id: "evidence.statement_id" },
    { statement_revision_id: "evidence.statement_revision_id", evidence_key: "evidence.evidence_key" },
    `FROM (SELECT evidence.*, revision.statement_id, evidence_commit.commit_sequence
             FROM canonical_credit_card_statement_summary_evidence evidence
             JOIN canonical_credit_card_statement_revisions revision ON revision.statement_revision_id = evidence.statement_revision_id
             ${commitOfCapture("evidence")}) evidence`,
    "evidence.evidence_source_record_id DESC",
  ),
  relationEvidenceHistory: historySql(
    { relation_id: "entry.relation_id" },
    {
      evidence_source_record_key: "entry.evidence_source_record_key", evidence_relation_id: "entry.evidence_relation_id",
      evidence_contract_version: "entry.evidence_contract_version",
    },
    `FROM (SELECT entry.*, entry_commit.commit_sequence FROM transaction_relation_provenance entry ${commitOf("entry")}) entry`,
    "entry.source_record_id DESC",
  ),
  /** When each identifier was first seen, so continuity as of any commit answers alike. */
  accountIdentifierFirstSightings: `
    SELECT observation.account_id, observation.identifier_kind, observation.identifier_value, observation.evidence_version,
           observation.source_field, MIN(observation_commit.commit_sequence) AS commit_sequence
      FROM financial_account_identifier_observations observation ${commitOf("observation")}
     GROUP BY 1, 2, 3, 4, 5`,
  /** Each invoice's observed revisions at every knowledge point. */
  einvoiceObservedHistory: historySql(
    { invoice_id: "observed.invoice_id" },
    { observed: "observed.observed" },
    `FROM (${OBSERVED_SETS}) observed`,
    "observed.observed",
  ),
  /** The lineage view's events other than `observed` ones, which compaction never removes: every column. */
  einvoiceNonObservedEvents: `SELECT * FROM einvoice_revision_events WHERE event_kind <> 'observed'`,
  /** Each count partition's maximum at every knowledge point: the rows that raised it. */
  occurrenceCountHistory: `
    SELECT * FROM (
      SELECT coverage.source_subject_id, coverage.record_kind, coverage.scope_key, coverage.contract_version,
             count_row.partition_date, count_row.fingerprint, written.commit_sequence, count_row.occurrence_count,
             count_row.occurrence_count > COALESCE(MAX(count_row.occurrence_count) OVER (
               PARTITION BY coverage.source_subject_id, coverage.record_kind, coverage.scope_key, coverage.contract_version,
                            count_row.partition_date, count_row.fingerprint
               ORDER BY written.commit_sequence, count_row.observation_id
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), -1) AS raises
        FROM source_occurrence_group_counts count_row
        JOIN source_occurrence_group_coverages coverage ON coverage.coverage_id = count_row.coverage_id
        JOIN canonical_commits written ON written.commit_id = coverage.commit_id
    ) running WHERE raises`,
} as const;

export type CompactionReader = keyof typeof COMPACTION_READERS;

/** A reader's answer: its row count and the SHA-256 of its rows as text, sorted. */
export type ReaderDigest = Readonly<{ rows: number; sha256: string }>;

export type LedgerCompactionResult =
  | Readonly<{
    status: "compacted";
    removed: Readonly<Record<CompactedTable, number>>;
    /** Each answer in `COMPACTION_READERS` read the same before and after; a difference would have thrown. */
    verification: Readonly<{ passed: true; readers: Readonly<Record<CompactionReader, ReaderDigest>> }>;
    durationMs: number;
  }>
  | Readonly<{
    /** The marker was already written; nothing was read or removed. */
    status: "already-compacted";
    removed: Readonly<Record<CompactedTable, number>>;
    durationMs: number;
  }>;

export type LedgerCompactionFailure =
  /** A table cites a compacted table, so a removed row could be named. */
  | Readonly<{ reason: "unexpected-reference"; tables: readonly string[] }>
  /** A trigger on a compacted table is not in the default mode that replication mode turns off. */
  | Readonly<{ reason: "unexpected-trigger"; triggers: readonly string[] }>
  /** A delete removed another number of rows than were selected. */
  | Readonly<{ reason: "removed-count-mismatch"; table: CompactedTable; selected: number; removed: number }>
  /** A reader answered differently after the delete. */
  | Readonly<{ reason: "reader-changed"; readers: readonly CompactionReader[] }>;

/** The compaction refused or rolled back; the store holds every row it held before. */
export class LedgerCompactionError extends Error {
  readonly failure: LedgerCompactionFailure;

  constructor(failure: LedgerCompactionFailure) {
    super(`Ledger compaction rolled back: ${JSON.stringify(failure)}`);
    this.name = "LedgerCompactionError";
    this.failure = failure;
  }
}

export type LedgerCompactionOptions = Readonly<{
  /** Checked between steps; an abort throws its reason and rolls back. */
  signal?: AbortSignal;
  /** Called inside the transaction once a table's rows are deleted; a throw rolls back. */
  onRemoved?: (table: CompactedTable, removed: number) => void | Promise<void>;
  /**
   * Replaces a table's selection, a query that returns `row_ctid` and
   * `repeats` for each row. Only checks use it, to prove the verifier
   * refuses a wrong selection.
   */
  selections?: Readonly<Partial<Record<CompactedTable, string>>>;
}>;

const zeroRemoved = (): Record<CompactedTable, number> =>
  Object.fromEntries(COMPACTED_TABLES.map((table) => [table, 0])) as Record<CompactedTable, number>;

/**
 * Remove the phase A and phase C repeats of `store` in one transaction, or
 * nothing when a previous run wrote the marker. Throws a
 * `LedgerCompactionError`, and keeps every row, when anything is unexpected
 * or a reader would answer differently.
 */
export async function compactLedgerDomainAndCounts(
  store: PGliteStore,
  options: LedgerCompactionOptions = {},
): Promise<LedgerCompactionResult> {
  const started = performance.now();
  const step = () => options.signal?.throwIfAborted();
  step();
  return store.transaction(async (transaction) => {
    const { rows: marked } = await transaction.query(
      "SELECT 1 FROM pglite_operational_migrations WHERE migration_key = $1",
      [COMPACTED],
    );
    if (marked.length > 0) return { status: "already-compacted", removed: zeroRemoved(), durationMs: elapsed(started) };

    await refuseUnexpectedDependents(transaction);
    step();
    const before = await readCompactionReaders(transaction, step);

    // Every selection is made before any delete: the e-invoice selections of
    // both tables read the observations, which the first delete changes.
    await transaction.query("CREATE TEMP TABLE ledger_compaction_removed(table_name TEXT NOT NULL, row_ctid TID NOT NULL) ON COMMIT DROP");
    const selected = zeroRemoved();
    for (const table of COMPACTED_TABLES) {
      step();
      const selection = options.selections?.[table] ?? (table === COUNTS ? phaseCMarkedSql() : PHASE_A[table].marked);
      selected[table] = (await transaction.query(
        `INSERT INTO ledger_compaction_removed(table_name, row_ctid)
         SELECT $1, selection.row_ctid FROM (${selection}) selection WHERE selection.repeats`,
        [table],
      )).affectedRows ?? 0;
    }

    // As ADR 0144: no per-row foreign-key checks or triggers, which the
    // dependents check above makes safe; the purge guard also lets the
    // append-only guards pass should one fire anyway.
    await transaction.query("SET LOCAL session_replication_role = replica");
    await transaction.query("SELECT set_config('pglite.canonical_purge_delete_allowed', '1', true)");
    const removed = zeroRemoved();
    for (const table of COMPACTED_TABLES) {
      step();
      if (selected[table] === 0) continue;
      removed[table] = (await transaction.query(
        `DELETE FROM ${table} WHERE ctid = ANY(ARRAY(SELECT row_ctid FROM ledger_compaction_removed WHERE table_name = $1))`,
        [table],
      )).affectedRows ?? 0;
      if (removed[table] !== selected[table])
        throw new LedgerCompactionError({ reason: "removed-count-mismatch", table, selected: selected[table], removed: removed[table] });
      await options.onRemoved?.(table, removed[table]);
    }
    await transaction.query("SELECT set_config('pglite.canonical_purge_delete_allowed', '0', true)");
    await transaction.query("SET LOCAL session_replication_role = origin");

    const after = await readCompactionReaders(transaction, step);
    const changed = (Object.keys(before) as CompactionReader[])
      .filter((reader) => before[reader].sha256 !== after[reader].sha256 || before[reader].rows !== after[reader].rows);
    if (changed.length > 0) throw new LedgerCompactionError({ reason: "reader-changed", readers: changed });

    const touched = COMPACTED_TABLES.filter((table) => removed[table] > 0);
    if (touched.length > 0) await transaction.query(`ANALYZE ${touched.join(", ")}`);
    await transaction.query(
      `INSERT INTO pglite_operational_migrations(migration_key, schema_signature) VALUES ($1, $2)`,
      [COMPACTED, createHash("sha256").update(COMPACTED).digest("hex")],
    );
    return {
      status: "compacted",
      removed,
      verification: { passed: true, readers: after },
      durationMs: elapsed(started),
    };
  });
}

const elapsed = (started: number) => Math.round(performance.now() - started);

/**
 * Nothing may cite a compacted table, and every trigger on one must be in
 * the default mode, which replication mode turns off. A disabled, replica
 * or always trigger is refused too: skipping the checks is only known safe
 * for the triggers the schema installs.
 */
async function refuseUnexpectedDependents(transaction: PGliteTransaction): Promise<void> {
  const { rows: references } = await transaction.query<{ table_name: string }>(
    `SELECT DISTINCT conrelid::regclass::text AS table_name FROM pg_constraint
      WHERE contype = 'f' AND confrelid = ANY($1::regclass[]) ORDER BY 1`,
    [COMPACTED_TABLES],
  );
  if (references.length > 0)
    throw new LedgerCompactionError({ reason: "unexpected-reference", tables: references.map(({ table_name }) => table_name) });
  const { rows: triggers } = await transaction.query<{ name: string }>(
    `SELECT tgrelid::regclass::text || '.' || tgname AS name FROM pg_trigger
      WHERE NOT tgisinternal AND tgrelid = ANY($1::regclass[]) AND tgenabled <> 'O' ORDER BY 1`,
    [COMPACTED_TABLES],
  );
  if (triggers.length > 0) throw new LedgerCompactionError({ reason: "unexpected-trigger", triggers: triggers.map(({ name }) => name) });
}

/** Every reader's answer as a digest. */
export async function readCompactionReaders(
  reader: Pick<PGliteTransaction, "query">,
  step: () => void = () => {},
): Promise<Record<CompactionReader, ReaderDigest>> {
  const digests = {} as Record<CompactionReader, ReaderDigest>;
  for (const [name, sql] of Object.entries(COMPACTION_READERS) as [CompactionReader, string][]) {
    step();
    const { rows: [row] } = await reader.query<{ rows: number; sha256: string }>(
      `SELECT count(*)::int AS rows,
              encode(sha256(convert_to(COALESCE(string_agg(answer::text, E'\\n' ORDER BY answer::text), ''), 'UTF8')), 'hex') AS sha256
         FROM (${sql}) answer`,
    );
    digests[name] = { rows: row!.rows, sha256: row!.sha256 };
  }
  return digests;
}
