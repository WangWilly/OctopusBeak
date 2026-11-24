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
 * Before deleting, every reader the removed rows feed is read as a digest;
 * after deleting, it is read again, and any difference throws, which rolls
 * the transaction back. A marker in `pglite_operational_migrations`, written
 * in the same transaction, makes a second run a no-op.
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
 * The answers the removed rows feed, each as the rows its reader can tell
 * apart. Each mirrors its reader's selection and keeps every column a reader
 * returns or compares; generated ids are kept as stored, so a reader that
 * would now pick a row with other values differs.
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
  /**
   * The overview's and the investment command's name of a security at every
   * knowledge point: the latest name of each commit that names it, kept
   * where it differs from the commit before.
   */
  securityNamesAtEveryKnowledgePoint: `
    SELECT security_id, commit_sequence, name, contract_version FROM (
      SELECT at_commit.*,
             ROW_NUMBER() OVER history = 1
               OR ROW(name, contract_version) IS DISTINCT FROM LAG(ROW(name, contract_version)) OVER history AS changes
        FROM (
          SELECT DISTINCT ON (observation.security_id, observation_commit.commit_sequence)
                 observation.security_id, observation_commit.commit_sequence, observation.name, observation.contract_version
            FROM investment_security_name_observations observation ${commitOf("observation")}
           ORDER BY observation.security_id, observation_commit.commit_sequence, observation.capture_id DESC
        ) at_commit
      WINDOW history AS (PARTITION BY security_id ORDER BY commit_sequence)
    ) step WHERE changes`,
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
} as const;

export type CompactionReader = keyof typeof COMPACTION_READERS;

/** A reader's answer: its row count and the SHA-256 of its rows as text, sorted. */
export type ReaderDigest = Readonly<{ rows: number; sha256: string }>;

export type LedgerCompactionResult =
  | Readonly<{
    status: "compacted";
    removed: Readonly<Record<CompactedTable, number>>;
    /** Every reader read the same before and after; a difference would have thrown. */
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
  /** A trigger on a compacted table would still fire with replication off. */
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
 * Nothing may cite a compacted table, and every trigger on one must be one
 * that replication mode turns off; the checks the delete skips are only safe
 * then.
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
