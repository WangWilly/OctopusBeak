import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { latestCardDetailsByRevisionSql } from "./card-details-sql.ts";
import { captureSourceRecordIdsSql } from "./capture-manifest.ts";
import {
  citedCopiesSql,
  COUNTS,
  MANIFEST,
  PHASE_A,
  phaseCMarkedSql,
  readCitingColumns,
  recordCitationsSql,
  SATELLITES,
  stagedRecordCopiesSql,
  type CompactionCitingColumnProblem,
  type PhaseATable,
} from "./compaction-plan.ts";
import type { PGliteStore, PGliteTransaction } from "./transaction.ts";

/**
 * Compacts a store written before ADR 0152 (ADR 0154): the three phases the
 * dry run plans.
 *
 * - A: in each table a command now writes only on change, a row that repeats
 *   the row before it, in its reader's order, is removed; the first of each
 *   run is kept.
 * - B: a record copy that nothing cites once A is done, whose capture has no
 *   manifest yet, and that equals the copy before it is removed with its
 *   satellite rows; its capture gets a manifest that lists the nearest
 *   earlier kept copy instead, as the ADR 0152 writer would have reused it.
 * - C: a count row that does not raise the maximum stored before it in its
 *   partition is removed.
 *
 * The rows are the ones the dry run marks: both run the same queries
 * (`PHASE_A`, `phaseCMarkedSql`, and the classification of `recordCopiesSql`,
 * here through `stagedRecordCopiesSql`). Everything happens in
 * one transaction. Before deleting, each answer in `COMPACTION_READERS` is
 * read as a digest, latest and at every knowledge point; after deleting, it
 * is read again, and any difference throws, which rolls the transaction
 * back. Before phase B deletes, each copy it would remove is checked again on
 * its own: nothing cites it, its capture has no manifest, and its stored
 * columns equal its kept copy's exactly. Markers in
 * `pglite_operational_migrations`, written in the same transaction, make a
 * second run a no-op: one for phases A and C, one for phase B.
 *
 * `compactLedger` is the whole compaction in one transaction, which holds
 * the ledger for as long as it runs; the checks compare the worker job with
 * it. The worker runs the job in `compaction-job.ts` instead: one
 * `compactLedgerChunk` per step, each its own verified transaction over one
 * chunk of the store, which reads only the answers that chunk's deletes can
 * change. Neither runs on the open path.
 */

/** Phases A and C. A store compacted before phase B existed keeps this marker, and phase B still runs. */
export const DOMAIN_COUNTS_MARKER = "ledger-compaction-domain-counts-v1";
export const RECORDS_MARKER = "ledger-compaction-records-v1";

const RECORDS = "source_records";
/** Phase B's tables: the satellites first, so each delete leaves no row naming a removed copy. */
export const RECORD_TABLES = [...SATELLITES, RECORDS] as const;
export type RecordTable = (typeof RECORD_TABLES)[number];
export type DomainCountsTable = PhaseATable | typeof COUNTS;
export type CompactedTable = DomainCountsTable | RecordTable;

const DOMAIN_COUNTS_TABLES: readonly DomainCountsTable[] = [...(Object.keys(PHASE_A) as PhaseATable[]), COUNTS];
export const COMPACTED_TABLES: readonly CompactedTable[] = [...DOMAIN_COUNTS_TABLES, ...RECORD_TABLES];

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
 * Every stored column of a record copy a reader can compare, ids aside:
 * phase B replaces a copy's id with its kept copy's, so record readers name
 * a copy by what it holds.
 */
const RECORD_CONTENT = {
  sequence_lexeme: "record.sequence_lexeme", provider_key: "record.provider_key", content_hash: "record.content_hash",
  collision_key: "record.collision_key", description: "record.description",
  payload_sha256: "encode(sha256(convert_to(record.payload_json, 'UTF8')), 'hex')",
  scope_key: "record.occurrence_group_scope_key", fingerprint: "record.occurrence_group_fingerprint",
  partition_date: "record.occurrence_group_partition_date", ordinal: "record.occurrence_group_ordinal",
  bucket_key: "record.occurrence_group_bucket_key",
} as const;
const recordContent = Object.entries(RECORD_CONTENT).map(([name, expression]) => `${expression} AS ${name}`).join(", ");

/** A copy's owner capture's coverage shape for its scope key, which the reuse writer compares (ADR 0152). */
const OWNER_SHAPE = `
  LEFT JOIN LATERAL (
    SELECT string_agg(DISTINCT coverage.contract_version || CASE WHEN coverage.bucket_inventory_json IS NULL THEN '/n' ELSE '/i' END, ',') AS shape
      FROM source_occurrence_group_coverages coverage
     WHERE coverage.capture_id = record.capture_id AND coverage.scope_key = record.occurrence_group_scope_key
  ) owner ON TRUE`;
/** The source transaction assertions a copy backs, which the reuse writer compares. */
const BACKED_REVISIONS = `
  LEFT JOIN LATERAL (
    SELECT string_agg(encode(provenance.assertion_id, 'hex'), ',' ORDER BY provenance.assertion_id) AS assertions
      FROM assertion_provenance provenance
      JOIN assertions assertion ON assertion.assertion_id = provenance.assertion_id
     WHERE provenance.source_record_id = record.source_record_id
       AND assertion.origin = 'source' AND assertion.field_name = 'transaction_revision'
  ) backed ON TRUE`;

/**
 * The rows one compaction transaction covers. `WHOLE_STORE` is every row.
 * `IN_CHUNK` is one chunk of the worker job, as temporary tables the chunk
 * fills: its chains, each a source subject and record kind, and, once it has
 * selected its copies, the records those are copies of and the captures that
 * own them. Each returns a condition on the columns it is given.
 */
export type CompactionScope = Readonly<{
  chain(subject: string, kind: string): string;
  /** A record: every copy of one occurrence key in one chain. */
  record(subject: string, kind: string, occurrenceKey: string): string;
  capture(column: string): string;
}>;

export const WHOLE_STORE: CompactionScope = Object.freeze({ chain: () => "TRUE", record: () => "TRUE", capture: () => "TRUE" });
const CHUNK_CHAINS = "ledger_compaction_chains";
const COPIES = "ledger_compaction_copies";
const IN_CHUNK: CompactionScope = Object.freeze({
  chain: (subject: string, kind: string) =>
    `(${subject}, ${kind}) IN (SELECT source_subject_id, record_kind FROM ${CHUNK_CHAINS})`,
  record: (subject: string, kind: string, occurrenceKey: string) =>
    `(${subject}, ${kind}, ${occurrenceKey}) IN (SELECT source_subject_id, record_kind, occurrence_key FROM ${COPIES})`,
  capture: (column: string) => `${column} IN (SELECT capture_id FROM ${COPIES})`,
});

/**
 * The answers the removed rows feed, each as the rows its reader can tell
 * apart. Each mirrors its reader's selection and keeps every column a reader
 * returns or compares; generated ids are kept as stored, so a reader that
 * would now pick a row with other values differs. Record ids are the
 * exception: a record reader names a copy by its content, since phase B
 * points each capture at an equal earlier copy. The history readers hold
 * each table's answer at every knowledge point, which keeping the first row
 * of a run preserves and keeping the last would not.
 *
 * The count and record readers take a scope. A count reader is keyed by a
 * chain, a record reader by a record (a chain and an occurrence key), and
 * the capture reader by capture. A chunk reads the count rows of its chains,
 * the records it removes a copy of and the captures that own a removed copy.
 * Those are the rows its deletes can change: no other record has a copy
 * removed, and no other capture owns a removed copy or, as the cited guard
 * has checked, lists one in a manifest, so the rest of each answer reads no
 * row the chunk changes. The other readers are always read whole.
 */
function compactionReaders(scope: CompactionScope) {
  return {
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
       WHERE ${scope.chain("coverage.source_subject_id", "coverage.record_kind")}
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
    /**
     * The observations without an `observed` event at their commit, and the
     * `observed` events without an observation. A removed commit loses its
     * observations and their events together, so neither set changes; an
     * event or observation removed alone shows up here.
     */
    einvoiceUnpairedObservations: `
      SELECT 'observation' AS side, observation.revision_id, observation.commit_id
        FROM einvoice_revision_observations observation
       WHERE NOT EXISTS (SELECT 1 FROM einvoice_revision_events event
                          WHERE event.revision_id = observation.revision_id AND event.commit_id = observation.commit_id
                            AND event.event_kind = 'observed')
      UNION ALL
      SELECT 'event' AS side, event.revision_id, event.commit_id
        FROM einvoice_revision_events event
       WHERE event.event_kind = 'observed'
         AND NOT EXISTS (SELECT 1 FROM einvoice_revision_observations observation
                          WHERE observation.revision_id = event.revision_id AND observation.commit_id = event.commit_id)`,
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
         WHERE ${scope.chain("coverage.source_subject_id", "coverage.record_kind")}
      ) running WHERE raises`,
    /**
     * `listPGliteExpectedOccurrences` for every subject, kind, scope key and
     * inventoried contract version, all buckets at once: the latest copy of
     * each occurrence found through its owner capture's coverage.
     */
    recordExpectedOccurrences: `
      SELECT DISTINCT ON (record.source_subject_id, record.record_kind, record.occurrence_group_scope_key, coverage.contract_version,
                          record.occurrence_key)
             record.source_subject_id, record.record_kind, record.occurrence_group_scope_key, coverage.contract_version,
             record.occurrence_key, assertion.transaction_id, record.occurrence_group_partition_date,
             record.occurrence_group_fingerprint, record.occurrence_group_bucket_key
        FROM source_records record
        JOIN source_occurrence_group_coverages coverage
          ON coverage.capture_id = record.capture_id AND coverage.scope_key = record.occurrence_group_scope_key
        JOIN canonical_commits written ON written.commit_id = record.commit_id
        LEFT JOIN assertion_provenance provenance ON provenance.source_record_id = record.source_record_id
        LEFT JOIN assertions assertion ON assertion.assertion_id = provenance.assertion_id
         AND assertion.origin = 'source' AND assertion.field_name = 'transaction_revision'
       WHERE coverage.bucket_inventory_json IS NOT NULL
         AND ${scope.record("record.source_subject_id", "record.record_kind", "record.occurrence_key")}
       ORDER BY record.source_subject_id, record.record_kind, record.occurrence_group_scope_key, coverage.contract_version,
                record.occurrence_key, written.commit_sequence DESC, (assertion.transaction_id IS NULL), assertion.transaction_id,
                record.source_record_id DESC`,
    /**
     * The reuse writer's latest copy of each record (`planSourceRecordReuse`), with what it compares. The latest
     * copy is picked by id first, so only it is read in full, not every copy of a long chain.
     */
    recordLatestCopy: `
      SELECT record.source_subject_id, record.record_kind, record.occurrence_key, ${recordContent}, owner.shape, backed.assertions
        FROM (
          SELECT DISTINCT ON (copy.source_subject_id, copy.record_kind, copy.occurrence_key) copy.source_record_id
            FROM source_records copy
            JOIN canonical_commits written ON written.commit_id = copy.commit_id
           WHERE copy.occurrence_key IS NOT NULL
             AND ${scope.record("copy.source_subject_id", "copy.record_kind", "copy.occurrence_key")}
           ORDER BY copy.source_subject_id, copy.record_kind, copy.occurrence_key, written.commit_sequence DESC, copy.source_record_id DESC
        ) latest
        JOIN source_records record ON record.source_record_id = latest.source_record_id
        ${OWNER_SHAPE}
        ${BACKED_REVISIONS}`,
    /** The latest copy of each record at every knowledge point. */
    recordLatestCopyHistory: historySql(
      { source_subject_id: "record.source_subject_id", record_kind: "record.record_kind", occurrence_key: "record.occurrence_key" },
      {
        ...Object.fromEntries(Object.keys(RECORD_CONTENT).map((name) => [name, `record.${name}`])),
        shape: "record.shape", assertions: "record.assertions",
      },
      `FROM (SELECT record.source_record_id, record.source_subject_id, record.record_kind, record.occurrence_key, ${recordContent},
                    owner.shape, backed.assertions, written.commit_sequence
               FROM source_records record
               JOIN canonical_commits written ON written.commit_id = record.commit_id
               ${OWNER_SHAPE}
               ${BACKED_REVISIONS}
              WHERE record.occurrence_key IS NOT NULL
                AND ${scope.record("record.source_subject_id", "record.record_kind", "record.occurrence_key")}) record`,
      "record.source_record_id DESC",
    ),
    /**
     * What each capture saw, through `captureSourceRecordIdsSql` as
     * withdrawal by omission and counterparty evidence read it: each member
     * by occurrence key, with its content, its scope row's account and
     * subject, every assertion it backs, and whether it was known by the
     * capture's commit. Not distinct, so a member listed twice shows, and a
     * member whose copy is gone keeps a row with no content.
     */
    captureMembership: `
      SELECT capture.capture_key, record.source_subject_id, record.record_kind, record.occurrence_key, ${recordContent},
             record_commit.commit_sequence <= capture_commit.commit_sequence AS known_at_capture,
             scope.account_id, scope.source_subject_id AS scope_subject_id,
             (SELECT string_agg(encode(provenance.assertion_id, 'hex'), ',' ORDER BY provenance.assertion_id)
                FROM assertion_provenance provenance WHERE provenance.source_record_id = member.source_record_id) AS assertions
        FROM source_captures capture
        JOIN canonical_commits capture_commit ON capture_commit.commit_id = capture.commit_id
        JOIN LATERAL (${captureSourceRecordIdsSql("capture.capture_id")}) member ON TRUE
        LEFT JOIN source_records record ON record.source_record_id = member.source_record_id
        LEFT JOIN canonical_commits record_commit ON record_commit.commit_id = record.commit_id
        LEFT JOIN source_record_scopes scope ON scope.source_record_id = member.source_record_id
       WHERE ${scope.capture("capture.capture_id")}`,
  } as const;
}

export const COMPACTION_READERS = compactionReaders(WHOLE_STORE);
export type CompactionReader = keyof typeof COMPACTION_READERS;

/**
 * The readers whose SQL names one of `tables`. A query's answer depends only
 * on the tables it reads, so these are the only answers a change to those
 * tables can move.
 */
export function readersOf(tables: readonly string[]): CompactionReader[] {
  return (Object.entries(COMPACTION_READERS) as [CompactionReader, string][])
    .filter(([, sql]) => tables.some((table) => new RegExp(`\\b${table}\\b`, "u").test(sql)))
    .map(([reader]) => reader);
}

/** A reader's answer: its row count and the SHA-256 of its rows as text, sorted. */
export type ReaderDigest = Readonly<{ rows: number; sha256: string }>;

export type LedgerCompactionResult =
  | Readonly<{
    status: "compacted";
    /** Zero for each table of a phase whose marker was already written. */
    removed: Readonly<Record<CompactedTable, number>>;
    /** The captures phase B gave a manifest, one each. */
    manifests: number;
    /** Each answer in `COMPACTION_READERS` read the same before and after; a difference would have thrown. */
    verification: Readonly<{ passed: true; readers: Readonly<Record<CompactionReader, ReaderDigest>> }>;
    durationMs: number;
  }>
  | Readonly<{
    /** Both markers were already written; nothing was read or removed. */
    status: "already-compacted";
    removed: Readonly<Record<CompactedTable, number>>;
    manifests: 0;
    durationMs: number;
  }>;

export type LedgerCompactionFailure =
  /** A table cites a compacted table other than `source_records`, so a removed row could be named. */
  | Readonly<{ reason: "unexpected-reference"; tables: readonly string[] }>
  /** A trigger on a compacted table is not in the default mode that replication mode turns off. */
  | Readonly<{ reason: "unexpected-trigger"; triggers: readonly string[] }>
  /** A column cites `source_records` in a way phase B does not know, so it cannot tell which copies are cited. */
  | Readonly<{ reason: "unrecognised-citations"; problems: readonly CompactionCitingColumnProblem[] }>
  /** A copy phase B would remove is cited, by these tables. */
  | Readonly<{ reason: "removed-copy-cited"; tables: readonly string[] }>
  /** A copy phase B would remove belongs to a capture that already has a manifest. */
  | Readonly<{ reason: "removed-copy-in-manifest-capture"; copies: number }>
  /** A copy phase B would remove differs from its kept copy in a stored column, or its kept copy is missing. */
  | Readonly<{ reason: "removed-copy-differs"; copies: number }>
  /** A chunk selected rows outside its chains, which its scoped readers would not see. */
  | Readonly<{ reason: "outside-chunk"; table: CompactedTable; rows: number }>
  /** A delete removed another number of rows than were selected, or than a satellite table holds for the removed copies. */
  | Readonly<{ reason: "removed-count-mismatch"; table: CompactedTable; selected: number; removed: number }>
  /**
   * Phase B's manifests are not one new manifest for each capture owning a
   * removed copy: the insert wrote `inserted` rows, the table grew by
   * `grown`, and `outside` of its new rows belong to another capture.
   */
  | Readonly<{ reason: "manifest-mismatch"; captures: number; inserted: number; grown: number; outside: number }>
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

/** A selection a check may replace: a phase A or C table's, or phase B's copies. */
export type CompactionSelection = DomainCountsTable | typeof RECORDS;

export type LedgerCompactionOptions = Readonly<{
  /** Checked between steps; an abort throws its reason and rolls back. */
  signal?: AbortSignal;
  /** Called inside the transaction once a table's rows are deleted; a throw rolls back. */
  onRemoved?: (table: CompactedTable, removed: number) => void | Promise<void>;
  /**
   * Replaces a selection. Only checks use it, to prove the guards and the
   * verifier refuse a wrong one. A phase A or C table's returns `row_ctid`
   * and `repeats` for each row; phase B's returns `source_record_id` and
   * `kept_id` for each copy to remove.
   */
  selections?: Readonly<Partial<Record<CompactionSelection, string>>>;
  /**
   * Replaces one of phase B's statements: the manifest insert, or a table's
   * delete. Only checks use it, to prove the count guards refuse one that
   * writes or deletes more than the selected copies'.
   */
  statements?: Readonly<Partial<Record<RecordTable | typeof MANIFEST, string>>>;
}>;

export const zeroRemoved = (): Record<CompactedTable, number> =>
  Object.fromEntries(COMPACTED_TABLES.map((table) => [table, 0])) as Record<CompactedTable, number>;

/**
 * Compact `store` in one transaction: phases A and C unless their marker is
 * written, then phase B unless its marker is. Throws a
 * `LedgerCompactionError`, and keeps every row, when anything is unexpected
 * or a reader would answer differently.
 */
export async function compactLedger(
  store: PGliteStore,
  options: LedgerCompactionOptions = {},
): Promise<LedgerCompactionResult> {
  const started = performance.now();
  const step = () => options.signal?.throwIfAborted();
  step();
  return store.transaction(async (transaction) => {
    const done = await readMarkers(transaction);
    const domainAndCounts = !done.has(DOMAIN_COUNTS_MARKER);
    const records = !done.has(RECORDS_MARKER);
    if (!domainAndCounts && !records)
      return { status: "already-compacted", removed: zeroRemoved(), manifests: 0, durationMs: elapsed(started) };

    const columns = await refuseUnexpectedStore(transaction);
    step();
    const before = await readCompactionReaders(transaction, step);

    const removed = zeroRemoved();
    if (domainAndCounts) {
      // Every selection is made before any delete: the e-invoice selections of
      // both tables read the observations, which the first delete changes.
      const selected = await selectRows(transaction, DOMAIN_COUNTS_TABLES, WHOLE_STORE, options, step);
      await deleteRows(transaction, DOMAIN_COUNTS_TABLES, selected, options, removed, step);
    }
    // After phase A, whose kept rows are the domain rows that still cite a copy.
    let manifests = 0;
    if (records) {
      const copies = await selectCopies(transaction, columns, WHOLE_STORE, options, step);
      if (copies > 0) {
        await checkCopies(transaction, columns, step);
        manifests = await deleteCopies(transaction, options, removed, step);
      }
    }

    const after = await readCompactionReaders(transaction, step);
    refuseChanged(before, after);
    await analyzeTouched(transaction, removed, manifests);
    for (const marker of [...(domainAndCounts ? [DOMAIN_COUNTS_MARKER] : []), ...(records ? [RECORDS_MARKER] : [])])
      await transaction.query(
        `INSERT INTO pglite_operational_migrations(migration_key, schema_signature) VALUES ($1, $2)`,
        [marker, markerSignature(marker)],
      );
    return {
      status: "compacted",
      removed,
      manifests,
      verification: { passed: true, readers: after },
      durationMs: elapsed(started),
    };
  });
}

/** A source subject, as hex, and a record kind: the copies of one chain key's prefix. */
export type CompactionChain = Readonly<{ subject: string; recordKind: string }>;

/**
 * One step of the worker job, in its own transaction:
 *
 * - `domain`: phase A of one table, or of tables that must be compacted
 *   together, store-wide;
 * - `chains`: phase B or C, or both, of a set of chains. The set holds every
 *   chain a capture holding one of its copies also holds copies of, when the
 *   job planned it, so a capture's manifest is written once.
 */
export type CompactionChunk =
  | Readonly<{ kind: "domain"; tables: readonly PhaseATable[] }>
  | Readonly<{
    kind: "chains";
    chains: readonly CompactionChain[];
    /** The chains' integration namespaces, for progress. */
    namespaces: readonly string[];
    records: boolean;
    counts: boolean;
  }>;

export type CompactionChunkResult = Readonly<{
  removed: Readonly<Record<CompactedTable, number>>;
  manifests: number;
  /** The readers read before and after; empty when the chunk selected nothing. */
  readers: readonly CompactionReader[];
  /** Each of those readers' answer, which the deletes left as it was: the rows of its scope in this chunk. */
  digests: Readonly<Partial<Record<CompactionReader, ReaderDigest>>>;
}>;

/**
 * Compact one chunk in one transaction, with the safety of `compactLedger`:
 * the same selections narrowed to the chunk, the same guards on each removed
 * copy, replication mode and the purge guard for the deletes, and every
 * reader that names a table the chunk changes read before and after, the
 * count and record readers narrowed to the chunk's chains, the records it
 * removes a copy of and the captures that own one. Any difference throws a
 * `LedgerCompactionError` and rolls the chunk back; chunks committed before
 * it stay. A chunk that selects nothing reads no reader and changes nothing.
 * Writes no marker and analyzes no table: the job does both once every chunk
 * is done (`analyzeCompactedTables`).
 */
export async function compactLedgerChunk(
  store: PGliteStore,
  chunk: CompactionChunk,
  options: LedgerCompactionOptions = {},
): Promise<CompactionChunkResult> {
  const step = () => options.signal?.throwIfAborted();
  step();
  return store.transaction(async (transaction) => {
    const columns = await refuseUnexpectedStore(transaction);
    const scope = chunk.kind === "domain" ? WHOLE_STORE : await enterChunk(transaction, chunk.chains);
    const tables: readonly DomainCountsTable[] = chunk.kind === "domain" ? chunk.tables : chunk.counts ? [COUNTS] : [];
    const selected = await selectRows(transaction, tables, scope, options, step);
    const copies = chunk.kind === "chains" && chunk.records ? await selectCopies(transaction, columns, scope, options, step) : 0;
    const removed = zeroRemoved();
    const changing = [...tables.filter((table) => selected[table] > 0), ...(copies > 0 ? [...RECORD_TABLES, MANIFEST] : [])];
    if (changing.length === 0) return { removed, manifests: 0, readers: [], digests: {} };

    if (scope !== WHOLE_STORE) await refuseOutsideChunk(transaction, scope, selected[COUNTS], copies);
    if (copies > 0) await checkCopies(transaction, columns, step);
    const readers = readersOf(changing);
    const before = await readCompactionReaders(transaction, step, { scope, readers });
    await deleteRows(transaction, tables, selected, options, removed, step);
    const manifests = copies > 0 ? await deleteCopies(transaction, options, removed, step) : 0;
    const digests = await readCompactionReaders(transaction, step, { scope, readers });
    refuseChanged(before, digests);
    return { removed, manifests, readers, digests };
  });
}

const elapsed = (started: number) => Math.round(performance.now() - started);

export const markerSignature = (marker: string) => createHash("sha256").update(marker).digest("hex");

async function readMarkers(transaction: PGliteTransaction): Promise<Set<string>> {
  const { rows } = await transaction.query<{ migration_key: string }>(
    "SELECT migration_key FROM pglite_operational_migrations WHERE migration_key = ANY($1::text[])",
    [[DOMAIN_COUNTS_MARKER, RECORDS_MARKER]],
  );
  return new Set(rows.map(({ migration_key }) => migration_key));
}

/** The dependents and citations checks; returns the citing columns phase B reads. */
async function refuseUnexpectedStore(transaction: PGliteTransaction): Promise<Awaited<ReturnType<typeof readCitingColumns>>["columns"]> {
  await refuseUnexpectedDependents(transaction);
  const citing = await readCitingColumns(transaction);
  if (citing.problems.length > 0) throw new LedgerCompactionError({ reason: "unrecognised-citations", problems: citing.problems });
  return citing.columns;
}

function refuseChanged(before: Record<CompactionReader, ReaderDigest>, after: Record<CompactionReader, ReaderDigest>): void {
  const changed = (Object.keys(before) as CompactionReader[])
    .filter((reader) => before[reader].sha256 !== after[reader]?.sha256 || before[reader].rows !== after[reader]?.rows);
  if (changed.length > 0) throw new LedgerCompactionError({ reason: "reader-changed", readers: changed });
}

async function analyzeTouched(transaction: PGliteTransaction, removed: Record<CompactedTable, number>, manifests: number): Promise<void> {
  const touched = [...COMPACTED_TABLES.filter((table) => removed[table] > 0), ...(manifests > 0 ? [MANIFEST] : [])];
  if (touched.length > 0) await transaction.query(`ANALYZE ${touched.join(", ")}`);
}

/**
 * Fresh planner statistics for every table the job's chunks change, one
 * table per step. The chunks analyze nothing: each plans its statements from
 * the rows it stages, and a table's row estimate follows its size on disk,
 * which a delete leaves as it was.
 */
export async function analyzeCompactedTables(
  store: PGliteStore,
  runStep: <T>(step: () => Promise<T>) => Promise<T> = (step) => step(),
): Promise<void> {
  for (const table of [...COMPACTED_TABLES, MANIFEST]) await runStep(() => store.query(`ANALYZE ${table}`));
}

/** Fills the chunk's chains table. */
async function enterChunk(transaction: PGliteTransaction, chains: readonly CompactionChain[]): Promise<CompactionScope> {
  for (const { subject } of chains) if (!/^[0-9a-f]{32}$/u.test(subject)) throw new Error("A chunk's source subject must be 16 bytes of hex.");
  await transaction.query(`CREATE TEMP TABLE ${CHUNK_CHAINS}(
      source_subject_id BYTEA NOT NULL, record_kind TEXT NOT NULL, PRIMARY KEY (source_subject_id, record_kind)) ON COMMIT DROP`);
  await transaction.query(
    `INSERT INTO ${CHUNK_CHAINS} SELECT decode(subject, 'hex'), kind FROM unnest($1::text[], $2::text[]) AS chain(subject, kind)`,
    [chains.map(({ subject }) => subject), chains.map(({ recordKind }) => recordKind)],
  );
  await transaction.query(`ANALYZE ${CHUNK_CHAINS}`);
  return IN_CHUNK;
}

/**
 * A selected count row or copy whose chain is outside the chunk, or a copy
 * without an occurrence key, which no record reader's scope holds; `WHERE`
 * alone would let a NULL through.
 */
async function refuseOutsideChunk(transaction: PGliteTransaction, scope: CompactionScope, counts: number, copies: number): Promise<void> {
  if (counts > 0) {
    const { rows: [outside] } = await transaction.query<{ rows: number }>(
      `SELECT count(*)::int AS rows FROM ledger_compaction_removed removed
         JOIN ${COUNTS} count_row ON count_row.ctid = removed.row_ctid
         JOIN source_occurrence_group_coverages coverage ON coverage.coverage_id = count_row.coverage_id
        WHERE removed.table_name = $1 AND (${scope.chain("coverage.source_subject_id", "coverage.record_kind")}) IS NOT TRUE`,
      [COUNTS],
    );
    if (outside!.rows > 0) throw new LedgerCompactionError({ reason: "outside-chunk", table: COUNTS, rows: outside!.rows });
  }
  if (copies > 0) {
    const { rows: [outside] } = await transaction.query<{ rows: number }>(
      `SELECT count(*)::int AS rows FROM ${COPIES} copy
        WHERE (${scope.chain("copy.source_subject_id", "copy.record_kind")} AND copy.occurrence_key IS NOT NULL) IS NOT TRUE`,
    );
    if (outside!.rows > 0) throw new LedgerCompactionError({ reason: "outside-chunk", table: RECORDS, rows: outside!.rows });
  }
}

/**
 * As ADR 0144: no per-row foreign-key checks or triggers, which the
 * dependents check makes safe; the purge guard also lets the append-only
 * guards pass should one fire anyway.
 */
async function deleting<T>(transaction: PGliteTransaction, body: () => Promise<T>): Promise<T> {
  await transaction.query("SET LOCAL session_replication_role = replica");
  await transaction.query("SELECT set_config('pglite.canonical_purge_delete_allowed', '1', true)");
  const result = await body();
  await transaction.query("SELECT set_config('pglite.canonical_purge_delete_allowed', '0', true)");
  await transaction.query("SET LOCAL session_replication_role = origin");
  return result;
}

/** Phases A and C: records each table's selected rows; returns how many each has. Phase C is narrowed to `scope`. */
async function selectRows(
  transaction: PGliteTransaction,
  tables: readonly DomainCountsTable[],
  scope: CompactionScope,
  options: LedgerCompactionOptions,
  step: () => void,
): Promise<Record<CompactedTable, number>> {
  const selected = zeroRemoved();
  if (tables.length > 0)
    await transaction.query("CREATE TEMP TABLE ledger_compaction_removed(table_name TEXT NOT NULL, row_ctid TID NOT NULL) ON COMMIT DROP");
  for (const table of tables) {
    step();
    const selection = options.selections?.[table]
      ?? (table === COUNTS ? phaseCMarkedSql(scope.chain("coverage.source_subject_id", "coverage.record_kind")) : PHASE_A[table].marked);
    selected[table] = (await transaction.query(
      `INSERT INTO ledger_compaction_removed(table_name, row_ctid)
       SELECT $1, selection.row_ctid FROM (${selection}) selection WHERE selection.repeats`,
      [table],
    )).affectedRows ?? 0;
  }
  return selected;
}

async function deleteRows(
  transaction: PGliteTransaction,
  tables: readonly DomainCountsTable[],
  selected: Record<CompactedTable, number>,
  options: LedgerCompactionOptions,
  removed: Record<CompactedTable, number>,
  step: () => void,
): Promise<void> {
  if (tables.every((table) => selected[table] === 0)) return;
  await deleting(transaction, async () => {
    for (const table of tables) {
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
  });
}

type CitingColumns = Awaited<ReturnType<typeof readCitingColumns>>["columns"];

/** Every copy in the transaction's scope, and the ones something cites, for `stagedRecordCopiesSql`. */
const SCOPE_RECORDS = "ledger_compaction_scope_records";
const SCOPE_CITED = "ledger_compaction_scope_cited";

/**
 * Phase B's selection, narrowed to `scope`: the removable copies with their
 * kept copies, each with its capture and its record's chain and occurrence
 * key. Returns how many. The scope's copies, then their citations, are
 * stored in tables of their own before the copies are classified, so each
 * query is planned for the rows the one before it found: a table's size and
 * its unique key tell the planner how many there are.
 */
async function selectCopies(
  transaction: PGliteTransaction,
  columns: CitingColumns,
  scope: CompactionScope,
  options: LedgerCompactionOptions,
  step: () => void,
): Promise<number> {
  step();
  let selection = options.selections?.[RECORDS];
  if (selection === undefined) {
    await transaction.query(`CREATE TEMP TABLE ${SCOPE_RECORDS}(source_record_id BYTEA PRIMARY KEY, capture_id BYTEA NOT NULL) ON COMMIT DROP`);
    await transaction.query(`INSERT INTO ${SCOPE_RECORDS}(source_record_id, capture_id)
      SELECT record.source_record_id, record.capture_id FROM source_records record
       WHERE ${scope.chain("record.source_subject_id", "record.record_kind")}`);
    step();
    const inScope = (column: string) => `${column} IN (SELECT source_record_id FROM ${SCOPE_RECORDS})`;
    await transaction.query(`CREATE TEMP TABLE ${SCOPE_CITED}(cited_id BYTEA PRIMARY KEY, pinned_by TEXT[] NOT NULL) ON COMMIT DROP`);
    await transaction.query(`INSERT INTO ${SCOPE_CITED}(cited_id, pinned_by) ${citedCopiesSql(columns, inScope, false)}`);
    step();
    selection = `SELECT source_record_id, kept_id FROM (${stagedRecordCopiesSql(SCOPE_RECORDS, SCOPE_CITED)}) copy
                  WHERE copy.category = 'removable'`;
  }
  await transaction.query(`CREATE TEMP TABLE ${COPIES}(
      source_record_id BYTEA PRIMARY KEY, capture_id BYTEA NOT NULL, kept_id BYTEA NOT NULL,
      source_subject_id BYTEA, record_kind TEXT NOT NULL, occurrence_key TEXT) ON COMMIT DROP`);
  const selected = (await transaction.query(
    `INSERT INTO ${COPIES}(source_record_id, capture_id, kept_id, source_subject_id, record_kind, occurrence_key)
     SELECT selection.source_record_id, record.capture_id, selection.kept_id, record.source_subject_id, record.record_kind, record.occurrence_key
       FROM (${selection}) selection JOIN source_records record ON record.source_record_id = selection.source_record_id`,
  )).affectedRows ?? 0;
  // The readers' scope and the guards join on these copies; analyzed, a few copies are looked up by index, not by scanning the records.
  if (selected > 0) await transaction.query(`ANALYZE ${COPIES}`);
  return selected;
}

/** Each selected copy checked again on its own, apart from the selection. */
async function checkCopies(transaction: PGliteTransaction, columns: CitingColumns, step: () => void): Promise<void> {
  // 1. Nothing cites a removed copy: no citing column, manifest or assertion row naming a run.
  step();
  const removedCopy = (column: string) => `${column} IN (SELECT source_record_id FROM ${COPIES})`;
  const { rows: citing } = await transaction.query<{ citing_table: string }>(
    `SELECT DISTINCT citing_table FROM (${recordCitationsSql(columns, removedCopy, false)}) citation ORDER BY 1`,
  );
  if (citing.length > 0)
    throw new LedgerCompactionError({ reason: "removed-copy-cited", tables: citing.map(({ citing_table }) => citing_table) });
  // 2. Its capture has no manifest yet.
  const { rows: [manifested] } = await transaction.query<{ copies: number }>(
    `SELECT count(*)::int AS copies FROM ${COPIES} copy
      WHERE EXISTS (SELECT 1 FROM ${MANIFEST} manifest WHERE manifest.capture_id = copy.capture_id)`,
  );
  if (manifested!.copies > 0) throw new LedgerCompactionError({ reason: "removed-copy-in-manifest-capture", copies: manifested!.copies });
  // 3. Every stored column but the ids equals its kept copy's, compared exactly, not by hash.
  step();
  const { rows: stored } = await transaction.query<{ name: string }>(
    `SELECT column_name AS name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1
        AND column_name NOT IN ('source_record_id', 'capture_id', 'commit_id') ORDER BY ordinal_position`,
    [RECORDS],
  );
  const compared = stored.map(({ name }) => `record.${name}`).join(", ");
  const { rows: [differing] } = await transaction.query<{ copies: number }>(
    `SELECT count(*)::int AS copies FROM (
       SELECT copy.source_record_id, ${compared} FROM ${COPIES} copy
         JOIN source_records record ON record.source_record_id = copy.source_record_id
       EXCEPT
       SELECT copy.source_record_id, ${compared} FROM ${COPIES} copy
         JOIN source_records record ON record.source_record_id = copy.kept_id
     ) differing`,
  );
  if (differing!.copies > 0) throw new LedgerCompactionError({ reason: "removed-copy-differs", copies: differing!.copies });
}

const MANIFESTS_BEFORE = "ledger_compaction_manifests_before";

/**
 * Gives each selected copy's capture a manifest listing its kept copy, then
 * deletes the copies with their satellite rows. The readers a chunk reads see
 * only the removed copies' records and captures, so every statement is
 * counted against them: each table must lose exactly its rows naming a
 * removed copy, and the manifests must gain exactly one row for each capture
 * owning one.
 */
async function deleteCopies(
  transaction: PGliteTransaction,
  options: LedgerCompactionOptions,
  removed: Record<CompactedTable, number>,
  step: () => void,
): Promise<number> {
  step();
  const manifests = await writeManifests(transaction, options);
  await deleting(transaction, async () => {
    for (const table of RECORD_TABLES) {
      step();
      const naming = `${table} WHERE source_record_id IN (SELECT source_record_id FROM ${COPIES})`;
      const counted = `SELECT (SELECT count(*)::int FROM ${naming}) AS naming, (SELECT count(*)::int FROM ${table}) AS total`;
      const { rows: [before] } = await transaction.query<{ naming: number; total: number }>(counted);
      removed[table] = (await transaction.query(options.statements?.[table] ?? `DELETE FROM ${naming}`)).affectedRows ?? 0;
      const { rows: [after] } = await transaction.query<{ naming: number; total: number }>(counted);
      // Exactly the rows naming a removed copy went: as many as named one, none of them left, and the table that much smaller.
      if (removed[table] !== before!.naming || after!.naming !== 0 || before!.total - after!.total !== before!.naming)
        throw new LedgerCompactionError({ reason: "removed-count-mismatch", table, selected: before!.naming, removed: removed[table] });
      await options.onRemoved?.(table, removed[table]);
    }
  });
  // A delete can reach the manifests too while the append-only guard is off; they must stand as written.
  const { rows: [kept] } = await transaction.query<{ missing: number }>(
    `SELECT (SELECT count(*)::int FROM ${MANIFESTS_BEFORE} WHERE capture_id NOT IN (SELECT capture_id FROM ${MANIFEST}))
          + (SELECT count(DISTINCT capture_id)::int FROM ${COPIES})
          - (SELECT count(*)::int FROM ${MANIFEST} WHERE capture_id NOT IN (SELECT capture_id FROM ${MANIFESTS_BEFORE})) AS missing`,
  );
  if (kept!.missing !== 0) throw new LedgerCompactionError({ reason: "manifest-mismatch", captures: manifests, inserted: manifests, grown: manifests - kept!.missing, outside: 0 });
  return manifests;
}

/** The manifests, checked against the manifest table before and after: one new row for each capture owning a removed copy, and no other change. */
async function writeManifests(transaction: PGliteTransaction, options: LedgerCompactionOptions): Promise<number> {
  await transaction.query(`CREATE TEMP TABLE ${MANIFESTS_BEFORE}(capture_id BYTEA PRIMARY KEY) ON COMMIT DROP`);
  await transaction.query(`INSERT INTO ${MANIFESTS_BEFORE} SELECT capture_id FROM ${MANIFEST}`);
  // A capture's removed copies have distinct occurrence keys, so their kept copies are distinct too.
  const inserted = (await transaction.query(options.statements?.[MANIFEST] ??
    `INSERT INTO ${MANIFEST}(capture_id, source_record_ids, record_count, commit_id)
     SELECT copy.capture_id, string_agg(copy.kept_id, ''::bytea ORDER BY copy.kept_id), count(*)::int, capture.commit_id
       FROM ${COPIES} copy JOIN source_captures capture ON capture.capture_id = copy.capture_id
      GROUP BY copy.capture_id, capture.commit_id`,
  )).affectedRows ?? 0;
  const { rows: [counts] } = await transaction.query<{ captures: number; grown: number; outside: number }>(
    `SELECT (SELECT count(DISTINCT capture_id)::int FROM ${COPIES}) AS captures,
            (SELECT count(*)::int FROM ${MANIFEST}) - (SELECT count(*)::int FROM ${MANIFESTS_BEFORE}) AS grown,
            (SELECT count(*)::int FROM ${MANIFEST} manifest
              WHERE manifest.capture_id NOT IN (SELECT capture_id FROM ${MANIFESTS_BEFORE})
                AND manifest.capture_id NOT IN (SELECT capture_id FROM ${COPIES})) AS outside`,
  );
  const { captures, grown, outside } = counts!;
  // The selected captures had no manifest (`checkCopies`). With every new row theirs and the table grown by their number, each got one and no other row came or went.
  if (inserted !== captures || grown !== captures || outside !== 0)
    throw new LedgerCompactionError({ reason: "manifest-mismatch", captures, inserted, grown, outside });
  return inserted;
}

/**
 * Nothing may cite a compacted table, `source_records` aside, whose citing
 * columns phase B reads; and every trigger on one must be in the default
 * mode, which replication mode turns off. A disabled, replica or always
 * trigger is refused too: skipping the checks is only known safe for the
 * triggers the schema installs.
 */
async function refuseUnexpectedDependents(transaction: PGliteTransaction): Promise<void> {
  const { rows: references } = await transaction.query<{ table_name: string }>(
    `SELECT DISTINCT conrelid::regclass::text AS table_name FROM pg_constraint
      WHERE contype = 'f' AND confrelid = ANY($1::regclass[]) ORDER BY 1`,
    [COMPACTED_TABLES.filter((table) => table !== RECORDS)],
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

/**
 * Each reader's answer as a digest: every reader, read whole, unless
 * `readers` names some and `scope` narrows the count and record readers.
 */
export async function readCompactionReaders(
  reader: Pick<PGliteTransaction, "query">,
  step: () => void = () => {},
  { scope = WHOLE_STORE, readers }: Readonly<{ scope?: CompactionScope; readers?: readonly CompactionReader[] }> = {},
): Promise<Record<CompactionReader, ReaderDigest>> {
  const queries = scope === WHOLE_STORE ? COMPACTION_READERS : compactionReaders(scope);
  const digests = {} as Record<CompactionReader, ReaderDigest>;
  for (const name of readers ?? (Object.keys(queries) as CompactionReader[])) {
    step();
    const { rows: [row] } = await reader.query<{ rows: number; sha256: string }>(
      `SELECT count(*)::int AS rows,
              encode(sha256(convert_to(COALESCE(string_agg(answer::text, E'\\n' ORDER BY answer::text), ''), 'UTF8')), 'hex') AS sha256
         FROM (${queries[name]}) answer`,
    );
    digests[name] = { rows: row!.rows, sha256: row!.sha256 };
  }
  return digests;
}
