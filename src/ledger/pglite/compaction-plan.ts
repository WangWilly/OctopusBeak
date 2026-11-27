import { manifestRecordIdsSql } from "./capture-manifest.ts";
import type { PGliteStore, PGliteTransaction } from "./transaction.ts";

/**
 * A dry run of the ledger compaction: what it would remove from a store
 * written before ADR 0152, without changing anything. ADR 0152 left the
 * copies stored before it in place, and ADR 0154 compacts them; this report
 * lets the owner measure a store first. `compaction.ts` removes the rows it
 * marks. Compaction is planned in three phases, and this
 * reports each one:
 *
 * - A, domain rows: in each table a command now writes only on change, a row
 *   that repeats the row before it for the same key, in the order its reader
 *   uses, is removable. The first of each run is kept.
 * - B, record copies: copies of one record (subject, kind and occurrence key)
 *   in commit order. A copy is removable when its stored columns, its owner
 *   capture's coverage shape, its scope row and the assertions it backs equal
 *   the copy before it, nothing cites it once phase A is done, no manifest
 *   lists it, and its capture has no manifest yet. Copies that differ only in
 *   their sequence lexeme are counted apart; a later pass may remove them.
 * - C, occurrence-group count rows: a row that does not raise the stored
 *   maximum of its partition is removable.
 *
 * The tables that cite a record are read from `pg_constraint`. A citing
 * column the planner does not know, or a record-id column without a foreign
 * key, makes the plan refuse rather than count a cited copy as removable.
 *
 * The plan runs as short steps, each in its own read-only transaction that
 * is rolled back: the citation check, one step per phase A table, one per
 * source subject for phases B and C, and the sizes. On the worker each step
 * is queued on the background lane, so pages, clicks and commits run between
 * them. Phase A runs once; the rows it keeps that cite a record are carried
 * into that record's subject step. Steps read different moments of a live
 * store, so a commit between them can make a count slightly stale; the plan
 * is an estimate, and the compaction itself plans again inside its own
 * transaction. Byte estimates use each table's average size per row,
 * indexes and TOAST included, and are only freed once the tables are
 * rewritten.
 */

/** How a table that cites `source_records` takes part in the plan. */
type CitingColumn =
  /** Removed with the copy it belongs to. */
  | Readonly<{ role: "satellite" }>
  /** Its rows pin the copies they cite. */
  | Readonly<{ role: "cites" }>
  /** Phase A removes some of its rows; only the rows it keeps pin a copy. */
  | Readonly<{ role: "compacted"; marked: string }>;

const seqByCapture = (alias: string) =>
  `JOIN source_captures ${alias}_capture ON ${alias}_capture.capture_id = ${alias}.capture_id
   JOIN canonical_commits ${alias}_commit ON ${alias}_commit.commit_id = ${alias}_capture.commit_id`;
const seqByCommit = (alias: string) =>
  `JOIN canonical_commits ${alias}_commit ON ${alias}_commit.commit_id = ${alias}.commit_id`;

/**
 * An observing commit of an invoice that saw the same revisions as the
 * observing commit before it, created none of them and wrote only `observed`
 * events for it.
 */
const EINVOICE_REPEATS = `
  SELECT marked.invoice_id, marked.commit_id FROM (
    -- LAG is NULL on an invoice's first observing commit, so it never repeats.
    SELECT per_commit.invoice_id, per_commit.commit_id,
           per_commit.observed = LAG(per_commit.observed) OVER history AS repeats
      FROM (
        SELECT revision.invoice_id, observation.commit_id, observed_commit.commit_sequence,
               string_agg(encode(observation.revision_id, 'hex'), ',' ORDER BY observation.revision_id) AS observed
          FROM einvoice_revision_observations observation
          JOIN einvoice_invoice_revisions revision ON revision.revision_id = observation.revision_id
          JOIN canonical_commits observed_commit ON observed_commit.commit_id = observation.commit_id
         GROUP BY revision.invoice_id, observation.commit_id, observed_commit.commit_sequence
      ) per_commit
    WINDOW history AS (PARTITION BY per_commit.invoice_id ORDER BY per_commit.commit_sequence)
  ) marked
  WHERE marked.repeats
    AND NOT EXISTS (SELECT 1 FROM einvoice_revision_events event
                     WHERE event.invoice_id = marked.invoice_id AND event.commit_id = marked.commit_id
                       AND event.event_kind <> 'observed')
    AND NOT EXISTS (SELECT 1 FROM einvoice_invoice_revisions created
                     WHERE created.invoice_id = marked.invoice_id AND created.commit_id = marked.commit_id)`;

/**
 * Phase A, one query per table: every row, as `row_ctid`, the record it
 * cites as `cited_id`, and whether it repeats the row before it (`repeats`).
 * Each compares the columns its ADR 0152 writer compares, in its reader's
 * order. The compaction deletes the rows these mark, so the dry run and the
 * compaction select the same rows.
 */
export const PHASE_A = {
  canonical_credit_card_transaction_details: {
    column: "source_record_id",
    marked: `SELECT domain.ctid AS row_ctid, domain.source_record_id AS cited_id,
        ROW_NUMBER() OVER history > 1
          AND ROW(domain.revision_id, domain.instrument_id, domain.billing_status, domain.consume_date, domain.posting_date, domain.effective_date_basis, domain.statement_key)
              IS NOT DISTINCT FROM LAG(ROW(domain.revision_id, domain.instrument_id, domain.billing_status, domain.consume_date, domain.posting_date, domain.effective_date_basis, domain.statement_key)) OVER history
          AS repeats
      FROM canonical_credit_card_transaction_details domain ${seqByCapture("domain")}
    WINDOW history AS (PARTITION BY domain.transaction_id ORDER BY domain_commit.commit_sequence, domain.source_record_id)`,
  },
  canonical_credit_card_transaction_lifecycle: {
    column: "source_record_id",
    marked: `SELECT domain.ctid AS row_ctid, domain.source_record_id AS cited_id,
        ROW_NUMBER() OVER history > 1
          AND ROW(domain.revision_id, domain.instrument_id, domain.billing_status, domain.statement_key)
              IS NOT DISTINCT FROM LAG(ROW(domain.revision_id, domain.instrument_id, domain.billing_status, domain.statement_key)) OVER history
          AS repeats
      FROM canonical_credit_card_transaction_lifecycle domain ${seqByCapture("domain")}
    WINDOW history AS (PARTITION BY domain.integration_namespace, domain.account_id, domain.transaction_id
                       ORDER BY domain_commit.commit_sequence, domain.lifecycle_event_id)`,
  },
  canonical_credit_card_instrument_evidence: {
    column: "source_record_id",
    marked: `SELECT domain.ctid AS row_ctid, domain.source_record_id AS cited_id,
        ROW_NUMBER() OVER history > 1
          AND evidence.occurrence_key IS NOT DISTINCT FROM LAG(evidence.occurrence_key) OVER history AS repeats
      FROM canonical_credit_card_instrument_evidence domain ${seqByCapture("domain")}
      JOIN source_records evidence ON evidence.source_record_id = domain.source_record_id
    WINDOW history AS (PARTITION BY domain.instrument_id ORDER BY domain_commit.commit_sequence, domain.source_record_id)`,
  },
  canonical_credit_card_statement_summary_evidence: {
    column: "evidence_source_record_id",
    marked: `SELECT domain.ctid AS row_ctid, domain.evidence_source_record_id AS cited_id,
        ROW_NUMBER() OVER history > 1
          AND ROW(domain.statement_revision_id, domain.evidence_key)
              IS NOT DISTINCT FROM LAG(ROW(domain.statement_revision_id, domain.evidence_key)) OVER history AS repeats
      FROM canonical_credit_card_statement_summary_evidence domain ${seqByCapture("domain")}
      JOIN canonical_credit_card_statement_revisions revision ON revision.statement_revision_id = domain.statement_revision_id
    WINDOW history AS (PARTITION BY revision.statement_id ORDER BY domain_commit.commit_sequence, domain.evidence_source_record_id)`,
  },
  investment_security_name_observations: {
    column: "source_record_id",
    marked: `SELECT domain.ctid AS row_ctid, domain.source_record_id AS cited_id,
        ROW_NUMBER() OVER history > 1
          AND ROW(domain.name, domain.contract_version) IS NOT DISTINCT FROM LAG(ROW(domain.name, domain.contract_version)) OVER history AS repeats
      FROM investment_security_name_observations domain ${seqByCommit("domain")}
    WINDOW history AS (PARTITION BY domain.security_id ORDER BY domain_commit.commit_sequence, domain.capture_id)`,
  },
  transaction_relation_provenance: {
    column: "source_record_id",
    marked: `SELECT domain.ctid AS row_ctid, domain.source_record_id AS cited_id,
        ROW_NUMBER() OVER history > 1
          AND ROW(domain.evidence_source_record_key, domain.evidence_relation_id, domain.evidence_contract_version)
              IS NOT DISTINCT FROM LAG(ROW(domain.evidence_source_record_key, domain.evidence_relation_id, domain.evidence_contract_version)) OVER history
          AS repeats
      FROM transaction_relation_provenance domain ${seqByCommit("domain")}
    WINDOW history AS (PARTITION BY domain.relation_id ORDER BY domain_commit.commit_sequence, domain.source_record_id)`,
  },
  financial_account_identifier_observations: {
    column: "source_record_id",
    marked: `SELECT domain.ctid AS row_ctid, domain.source_record_id AS cited_id,
        ROW_NUMBER() OVER (
          PARTITION BY domain.account_id, domain.identifier_kind, domain.identifier_value, domain.evidence_version, domain.source_field
          ORDER BY domain_commit.commit_sequence, domain.observation_id
        ) > 1 AS repeats
      FROM financial_account_identifier_observations domain ${seqByCommit("domain")}`,
  },
  einvoice_revision_observations: {
    column: "source_record_id",
    marked: `SELECT domain.ctid AS row_ctid, domain.source_record_id AS cited_id, repeated.invoice_id IS NOT NULL AS repeats
      FROM einvoice_revision_observations domain
      JOIN einvoice_invoice_revisions revision ON revision.revision_id = domain.revision_id
      LEFT JOIN (${EINVOICE_REPEATS}) repeated ON repeated.invoice_id = revision.invoice_id AND repeated.commit_id = domain.commit_id`,
  },
  einvoice_revision_events: {
    column: "source_record_id",
    marked: `SELECT domain.ctid AS row_ctid, domain.source_record_id AS cited_id, repeated.invoice_id IS NOT NULL AS repeats
      FROM einvoice_revision_events domain
      LEFT JOIN (${EINVOICE_REPEATS}) repeated ON repeated.invoice_id = domain.invoice_id AND repeated.commit_id = domain.commit_id`,
  },
} as const satisfies Readonly<Record<string, Readonly<{ column: string; marked: string }>>>;

export type PhaseATable = keyof typeof PHASE_A;

export const SATELLITES = ["source_record_scopes", "source_record_provenance", "assertion_provenance"] as const;

/** Every column known to cite `source_records`, as `table.column`. */
const CITING_COLUMNS: ReadonlyMap<string, CitingColumn> = new Map<string, CitingColumn>([
  ...SATELLITES.map((table) => [`${table}.source_record_id`, { role: "satellite" }] as const),
  ...Object.entries(PHASE_A).map(([table, { column, marked }]) => [`${table}.${column}`, { role: "compacted", marked }] as const),
  ...[
    "balance_observation_revisions.source_record_id",
    "canonical_credit_card_relations.evidence_source_record_id",
    "canonical_credit_card_statement_memberships.source_record_id",
    "counterparty_account_evidence_support.source_record_id",
    "counterparty_participation_taxonomy_values.source_record_id",
    "einvoice_invoice_revisions.source_record_id",
    "enrichment_run_outputs.source_record_id",
    "enrichment_taxonomy_assertion_values.source_record_id",
    "institution_repayment_note_evidence.source_record_id",
    "institution_repayment_note_evidence_support.source_record_id",
    "investment_funding_relation_members.investment_source_record_id",
    "investment_funding_relations.funding_source_record_id",
    "investment_holding_observations.source_record_id",
    "investment_margin_balance_observations.source_record_id",
    "investment_passbook_movements.source_record_id",
    "investment_transaction_twd_valuations.source_record_id",
    "investment_transactions.source_record_id",
    "loan_repayment_settlement_group_members.source_record_id",
    "loan_transaction_facts.source_record_id",
    "transaction_conversion_evidence.source_record_id",
    "transaction_counterparty_account_evidence.source_record_id",
    "transaction_revisions.source_record_id",
    "transaction_time_observations.source_record_id",
  ].map((column) => [column, { role: "cites" }] as const),
]);

/** Pins a copy without a foreign key: a manifest lists it as reused. */
export const MANIFEST = "capture_source_record_manifests";
/** Pins a copy through a satellite: an assertion row that also names a run or coordinate. */
const MIXED_PROVENANCE = "assertion_provenance (non-source)";

export type CompactionCitingColumnProblem = Readonly<{
  table: string;
  columns: readonly string[];
  problem: "unknown-foreign-key" | "no-foreign-key" | "not-the-record-id";
}>;

export type CompactionTablePlan = Readonly<{
  table: string;
  rows: number;
  removable: number;
  /** `removable` times the table's average bytes per row, indexes and TOAST included. */
  estimatedBytes: number;
}>;

/**
 * Every copy in one of these categories, in this order of precedence. Only
 * a copy with an occurrence key and a subject has a chain of copies; the
 * first of each chain is always kept.
 */
export type CompactionCopyCounts = Readonly<{
  copies: number;
  /** No occurrence key or no subject: never compacted. */
  unchained: number;
  first: number;
  /** Differs from the copy before it in more than its sequence lexeme. */
  changed: number;
  /** Its capture already has a manifest; deferred. */
  manifestCapture: number;
  /** Something still cites it after phase A. */
  pinned: number;
  /** Differs from the copy before it only in its sequence lexeme; deferred. */
  lexemeOnly: number;
  removable: number;
}>;

export type CompactionRecordGroupPlan = Readonly<{
  integrationNamespace: string;
  recordKind: string;
  counts: CompactionCopyCounts;
  /** Pinned copies by each citing table; a copy cited by two tables counts under both. */
  pinnedBy: Readonly<Record<string, number>>;
}>;

export type CompactionPlan = Readonly<{
  status: "planned";
  /** `pg_database_size`; the data folder also holds WAL and free pages. */
  databaseBytes: number;
  phaseA: readonly CompactionTablePlan[];
  phaseB: Readonly<{
    groups: readonly CompactionRecordGroupPlan[];
    totals: CompactionCopyCounts;
    pinnedBy: Readonly<Record<string, number>>;
    /** `source_records` and the satellite rows removed with each copy. */
    tables: readonly CompactionTablePlan[];
  }>;
  phaseC: CompactionTablePlan;
  /** The citing columns found in `pg_constraint`, as `table.column`. */
  citingColumns: readonly string[];
  estimatedBytes: number;
}>;

/** The store holds a citation the planner cannot count; nothing is planned. */
export type CompactionPlanRefusal = Readonly<{
  status: "unrecognised-citations";
  problems: readonly CompactionCitingColumnProblem[];
}>;

export type CompactionPlanResult = CompactionPlan | CompactionPlanRefusal;

export type CompactionPlanOptions = Readonly<{
  /**
   * Runs one step of the plan. The worker queues each step on its background
   * lane, so other work runs between steps; by default a step runs at once.
   */
  runStep?: <T>(step: () => Promise<T>) => Promise<T>;
  /** Checked before each step; an aborted plan stops with the signal's reason. */
  signal?: AbortSignal;
}>;

type Removable = Omit<CompactionTablePlan, "estimatedBytes">;

/** A row phase A keeps that cites a record, carried to that record's subject step. */
type KeptCitation = Readonly<{ cited: string; table: string }>;

/** A source subject as hex, or `null` for the records that have none. */
type Subject = string | null;

/**
 * Plan the compaction of `store` without changing it.
 *
 * One source subject is one step, and on a real store one large subject
 * dominates, so a step can hold the ledger for seconds, and for tens of
 * seconds on a store of several GB. The live worker runs it only when the
 * owner asks Settings for a compaction's estimate (ADR 0154), and the copy
 * there says it may take a while. Splitting a subject's step further, for
 * example by record kind or occurrence-key range, would shorten that pause.
 * The npm script plans on a copy and is unaffected.
 */
export async function planLedgerCompaction(store: PGliteStore, options: CompactionPlanOptions = {}): Promise<CompactionPlanResult> {
  const runStep = options.runStep ?? (<T>(step: () => Promise<T>) => step());
  const read = <T>(body: (transaction: PGliteTransaction) => Promise<T>): Promise<T> =>
    runStep(() => {
      options.signal?.throwIfAborted();
      return store.transaction(async (transaction) => {
        await transaction.query("SET TRANSACTION READ ONLY");
        try {
          return await body(transaction);
        } finally {
          await transaction.rollback();
        }
      });
    });

  const citing = await read(readCitingColumns);
  if (citing.problems.length > 0) return { status: "unrecognised-citations", problems: citing.problems };

  const phaseA: Removable[] = [];
  const kept = new Map<Subject, KeptCitation[]>();
  for (const table of Object.keys(PHASE_A) as PhaseATable[]) {
    const planned = await read((transaction) => planDomainTable(transaction, table));
    phaseA.push(planned.table);
    for (const { subject, cited } of planned.kept) kept.set(subject, [...(kept.get(subject) ?? []), { cited, table }]);
  }

  const copies = new CopyTally();
  let counts: Removable = { table: COUNTS, rows: 0, removable: 0 };
  for (const subject of await read(listSubjects)) {
    const step = await read(async (transaction) => ({
      copies: await planSubjectCopies(transaction, subject, citing.columns, kept.get(subject) ?? []),
      counts: await planSubjectCounts(transaction, subject),
    }));
    copies.add(step.copies);
    counts = { table: COUNTS, rows: counts.rows + step.counts.rows, removable: counts.removable + step.counts.removable };
  }

  return read(async (transaction) => {
    const phaseB = copies.result(await countRows(transaction, Object.keys(copies.removed)));
    const sized = await sizeTables(transaction, [...phaseA, ...phaseB.tables, counts].map(({ table }) => table));
    const estimate = (table: Removable): CompactionTablePlan => {
      const bytes = sized.get(table.table) ?? 0;
      return { ...table, estimatedBytes: table.rows === 0 ? 0 : Math.round((bytes / table.rows) * table.removable) };
    };
    const estimatedA = phaseA.map(estimate);
    const estimatedB = phaseB.tables.map(estimate);
    const estimatedC = estimate(counts);
    const { rows: [size] } = await transaction.query<{ bytes: string }>("SELECT pg_database_size(current_database())::text AS bytes");
    return {
      status: "planned",
      databaseBytes: Number(size!.bytes),
      phaseA: estimatedA,
      phaseB: { ...phaseB, tables: estimatedB },
      phaseC: estimatedC,
      citingColumns: [...citing.columns.keys()].sort(),
      estimatedBytes: [...estimatedA, ...estimatedB, estimatedC].reduce((sum, table) => sum + table.estimatedBytes, 0),
    } satisfies CompactionPlan;
  });
}

export type FoundColumns = ReadonlyMap<string, Readonly<{ table: string; column: string; citing: CitingColumn }>>;

export async function readCitingColumns(transaction: PGliteTransaction): Promise<Readonly<{
  columns: FoundColumns;
  problems: readonly CompactionCitingColumnProblem[];
}>> {
  const { rows: constraints } = await transaction.query<{ table_name: string; columns: string[]; referenced: string[] }>(
    `SELECT constraint_row.conrelid::regclass::text AS table_name,
            array_agg(referencing.attname::text ORDER BY key.position) AS columns,
            array_agg(referenced.attname::text ORDER BY key.position) AS referenced
       FROM pg_constraint constraint_row
       CROSS JOIN LATERAL unnest(constraint_row.conkey, constraint_row.confkey) WITH ORDINALITY AS key(local, foreign_key, position)
       JOIN pg_attribute referencing ON referencing.attrelid = constraint_row.conrelid AND referencing.attnum = key.local
       JOIN pg_attribute referenced ON referenced.attrelid = constraint_row.confrelid AND referenced.attnum = key.foreign_key
      WHERE constraint_row.contype = 'f' AND constraint_row.confrelid = 'source_records'::regclass
      GROUP BY constraint_row.oid, constraint_row.conrelid
      ORDER BY 1, 2`,
  );
  const columns = new Map<string, Readonly<{ table: string; column: string; citing: CitingColumn }>>();
  const problems: CompactionCitingColumnProblem[] = [];
  for (const { table_name: table, columns: local, referenced } of constraints) {
    const recordColumn = local[referenced.indexOf("source_record_id")];
    // A scope row also names its record's capture, which the record id fixes.
    const shapeKnown = referenced.length === 1 || (table === "source_record_scopes" && referenced.join() === "source_record_id,capture_id");
    if (recordColumn === undefined || !shapeKnown) {
      problems.push({ table, columns: local, problem: "not-the-record-id" });
      continue;
    }
    const citing = CITING_COLUMNS.get(`${table}.${recordColumn}`);
    if (citing === undefined) problems.push({ table, columns: local, problem: "unknown-foreign-key" });
    else columns.set(`${table}.${recordColumn}`, { table, column: recordColumn, citing });
  }
  // A record id kept without a foreign key would cite a copy the plan cannot see.
  const { rows: unconstrained } = await transaction.query<{ table_name: string; column_name: string }>(
    `SELECT column_row.attrelid::regclass::text AS table_name, column_row.attname::text AS column_name
       FROM pg_attribute column_row
       JOIN pg_class table_row ON table_row.oid = column_row.attrelid
       JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
      WHERE table_row.relkind IN ('r', 'p')
        AND namespace.nspname NOT IN ('pg_catalog', 'information_schema') AND namespace.nspname NOT LIKE 'pg_temp%'
        AND column_row.attnum > 0 AND NOT column_row.attisdropped
        AND column_row.atttypid = 'bytea'::regtype
        AND (column_row.attname = 'source_record_id' OR column_row.attname LIKE '%\\_source\\_record\\_id')
        AND column_row.attrelid <> 'source_records'::regclass
      ORDER BY 1, 2`,
  );
  for (const { table_name: table, column_name: column } of unconstrained)
    if (!columns.has(`${table}.${column}`) && !problems.some((problem) => problem.table === table && problem.columns.includes(column)))
      problems.push({ table, columns: [column], problem: "no-foreign-key" });
  return { columns, problems };
}


export const COUNTS = "source_occurrence_group_counts";

/** `column` belongs to `subject`. A subject is hex the store encoded, so it is safe to inline. */
function subjectIs(column: string, subject: Subject): string {
  if (subject === null) return `${column} IS NULL`;
  if (!/^[0-9a-f]+$/u.test(subject)) throw new Error("A source subject id must be hex.");
  return `${column} = decode('${subject}', 'hex')`;
}

async function listSubjects(transaction: PGliteTransaction): Promise<Subject[]> {
  const { rows } = await transaction.query<{ subject: string }>(
    "SELECT encode(source_subject_id, 'hex') AS subject FROM source_subjects ORDER BY 1",
  );
  const { rows: [unowned] } = await transaction.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM source_records WHERE source_subject_id IS NULL)
         OR EXISTS (SELECT 1 FROM source_occurrence_group_coverages WHERE source_subject_id IS NULL) AS exists`,
  );
  return [...rows.map(({ subject }) => subject), ...(unowned!.exists ? [null] : [])];
}

/** One phase A table: its removable rows, and the records its kept rows cite, by subject. */
async function planDomainTable(transaction: PGliteTransaction, table: PhaseATable): Promise<Readonly<{
  table: Removable;
  kept: readonly Readonly<{ subject: Subject; cited: string }>[];
}>> {
  const { rows: [row] } = await transaction.query<{ rows: number; removable: number; kept: { subject: Subject; cited: string }[] }>(`
    WITH marked AS MATERIALIZED (${PHASE_A[table].marked})
    SELECT (SELECT count(*)::int FROM marked) AS rows,
           (SELECT (count(*) FILTER (WHERE repeats))::int FROM marked) AS removable,
           (SELECT COALESCE(json_agg(json_build_object('subject', encode(record.source_subject_id, 'hex'), 'cited', encode(kept.cited_id, 'hex'))), '[]')
              FROM (SELECT DISTINCT cited_id FROM marked WHERE NOT repeats AND cited_id IS NOT NULL) kept
              JOIN source_records record ON record.source_record_id = kept.cited_id) AS kept`);
  return { table: { table, rows: row!.rows, removable: row!.removable }, kept: row!.kept };
}

const CATEGORIES = ["unchained", "first", "changed", "manifestCapture", "pinned", "lexemeOnly", "removable"] as const;
type Category = (typeof CATEGORIES)[number];

type CopyRow = Readonly<{
  integration_namespace: string;
  record_kind: string;
  category: Category;
  pinned_by: string[] | null;
  copies: number;
  scopes: number;
  provenance: number;
  assertions: number;
}>;

/**
 * Record ids kept as text, which no foreign key or bytea column scan sees.
 * Today each also sits in a cited column of a row that pins the same copy,
 * but a copy named only here must still be kept.
 */
const TEXT_CITATIONS: readonly Readonly<{ table: string; column: string; id: string }>[] = [
  { table: "enrichment_run_outputs", column: "provenance_json", id: "replace((provenance_json::jsonb)->>'sourceRecordId', '-', '')" },
  { table: "enrichment_taxonomy_assertion_values", column: "provenance_json", id: "replace((provenance_json::jsonb)->>'sourceRecordId', '-', '')" },
  { table: "investment_funding_relations", column: "source_linkage_key", id: "source_linkage_key" },
];

/**
 * Every row that cites a copy `within` admits, as `cited_id` and the citing
 * table: the citing columns found in `pg_constraint`, the manifests, the
 * assertion rows that also name a run or coordinate, and the record ids kept
 * as text. With `carried`, the
 * phase A tables are left out and the rows phase A keeps come in as the
 * parameters `$1` (record ids as hex) and `$2` (their tables); without it,
 * phase A has already run, so those tables are read as they stand.
 */
export function recordCitationsSql(columns: FoundColumns, within: (column: string) => string, carried: boolean): string {
  const citations = [...columns.values()].flatMap(({ table, column, citing }) =>
    citing.role === "cites" || (citing.role === "compacted" && !carried)
      ? [`SELECT ${column} AS cited_id, '${table}' AS citing_table FROM ${table} WHERE ${within(column)}`]
      : []);
  if (carried)
    citations.push(`SELECT decode(kept.cited, 'hex') AS cited_id, kept.citing_table FROM unnest($1::text[], $2::text[]) AS kept(cited, citing_table)`);
  citations.push(
    `SELECT member.cited_id, '${MANIFEST}' AS citing_table FROM (
       SELECT listed.source_record_id AS cited_id FROM (${manifestRecordIdsSql("TRUE")}) listed
     ) member WHERE ${within("member.cited_id")}`,
    `SELECT source_record_id AS cited_id, '${MIXED_PROVENANCE}' AS citing_table FROM assertion_provenance
      WHERE ${within("source_record_id")} AND (run_id IS NOT NULL OR enrichment_run_id IS NOT NULL OR coordinate_id IS NOT NULL)`,
    ...TEXT_CITATIONS.map(({ table, column, id }) =>
      `SELECT cited_id, '${table}.${column}' AS citing_table FROM (
         SELECT CASE WHEN text_id ~* '^[0-9a-f]{32}$' THEN decode(text_id, 'hex') END AS cited_id
           FROM (SELECT ${id} AS text_id FROM ${table}) text_ids
       ) text_citation WHERE ${within("cited_id")}`),
  );
  return citations.join("\nUNION ALL\n");
}

/**
 * Phase B, one row per copy whose `source_records` row (`record`) matches
 * `where`: its category, the tables that pin it, its satellite rows, and for
 * a removable copy `kept_id`, the nearest earlier copy of its chain that is
 * kept. A removable copy equals the copy before it in every compared value
 * and its sequence lexeme, so it equals that kept copy too. The dry run
 * counts these rows; the compaction removes the removable ones, through
 * `stagedRecordCopiesSql`.
 */
export function recordCopiesSql(where: string, columns: FoundColumns, carried: boolean): string {
  const ofSubject = (column: string) => `${column} IN (SELECT source_record_id FROM subject_records)`;
  return `
    WITH subject_records AS MATERIALIZED (
      SELECT record.source_record_id, record.capture_id FROM source_records record WHERE ${where}
    ),
    cited AS (${citedCopiesSql(columns, ofSubject, carried)}),
    ${classifiedCopiesSql({ from: "source_records record", where }, "subject_records", "cited")}`;
}

/** The copies `within` admits that something cites, each once, with the tables that cite it. */
export function citedCopiesSql(columns: FoundColumns, within: (column: string) => string, carried: boolean): string {
  return `SELECT cited_id, array_agg(DISTINCT citing_table ORDER BY citing_table) AS pinned_by
            FROM (${recordCitationsSql(columns, within, carried)}) citation
           GROUP BY cited_id`;
}

/**
 * `recordCopiesSql` over two tables the caller has filled: `records`, the
 * `source_record_id` and `capture_id` of every copy to classify, and
 * `cited`, `citedCopiesSql` of those copies, each with a unique key. The
 * planner then knows how many copies and citations there are from the
 * tables' sizes. Inside one query it
 * estimates a chain's copies from the store's average, which can be one row
 * for a chain of tens of thousands, and then scans every citation again for
 * each copy.
 */
export function stagedRecordCopiesSql(records: string, cited: string): string {
  const listed = `${records} listed JOIN source_records record ON record.source_record_id = listed.source_record_id`;
  return `WITH ${classifiedCopiesSql({ from: listed, where: "TRUE" }, records, cited)}`;
}

/**
 * The CTEs after `WITH` that classify the copies `records` lists and `cited`
 * pins. `copies` is where their `source_records` rows (`record`) come from:
 * a `FROM` item and a condition. Starting from the listed copies reads only
 * those. A condition on `source_records` alone is applied last, since the
 * query joins more tables than the planner reorders (`join_collapse_limit`):
 * every record of the store is first joined to its capture, commit and
 * satellite rows.
 */
function classifiedCopiesSql(copies: Readonly<{ from: string; where: string }>, records: string, cited: string): string {
  const ofSubject = (column: string) => `${column} IN (SELECT source_record_id FROM ${records})`;
  return `
    shape AS (
      SELECT capture_id, scope_key,
             string_agg(DISTINCT contract_version || CASE WHEN bucket_inventory_json IS NULL THEN '/n' ELSE '/i' END, ',') AS shape
        FROM source_occurrence_group_coverages
       WHERE capture_id IN (SELECT capture_id FROM ${records})
       GROUP BY capture_id, scope_key
    ),
    -- The source assertions a copy backs, as a set; a row naming a run or coordinate pins the copy instead.
    backed AS (
      SELECT source_record_id,
             string_agg(DISTINCT encode(assertion_id, 'hex'), ',' ORDER BY encode(assertion_id, 'hex'))
               FILTER (WHERE run_id IS NULL AND enrichment_run_id IS NULL AND coordinate_id IS NULL) AS assertions,
             count(*)::int AS rows
        FROM assertion_provenance WHERE ${ofSubject("source_record_id")} GROUP BY source_record_id
    ),
    provenance AS (
      SELECT source_record_id, count(*)::int AS rows FROM source_record_provenance
       WHERE ${ofSubject("source_record_id")} GROUP BY source_record_id
    ),
    copy AS (
      SELECT record.source_record_id, record.capture_id, connection.integration_namespace, record.record_kind,
             record.source_subject_id, record.occurrence_key, written.commit_sequence, record.sequence_lexeme,
             record.occurrence_key IS NOT NULL AND record.source_subject_id IS NOT NULL AS chained,
             md5(ROW(record.provider_key, record.content_hash, record.collision_key, record.description, record.payload_json,
                     record.occurrence_group_scope_key, record.occurrence_group_fingerprint, record.occurrence_group_partition_date,
                     record.occurrence_group_ordinal, record.occurrence_group_bucket_key,
                     shape.shape, scope.source_record_id IS NULL, scope.account_id, scope.source_subject_id, backed.assertions)::text) AS content,
             EXISTS (SELECT 1 FROM ${MANIFEST} manifest WHERE manifest.capture_id = record.capture_id) AS manifest_capture,
             cited.pinned_by,
             (scope.source_record_id IS NOT NULL)::int AS scopes, COALESCE(provenance.rows, 0) AS provenance, COALESCE(backed.rows, 0) AS assertions
        FROM ${copies.from}
        JOIN source_captures capture ON capture.capture_id = record.capture_id
        JOIN source_connections connection ON connection.source_connection_id = capture.source_connection_id
        JOIN canonical_commits written ON written.commit_id = record.commit_id
        LEFT JOIN shape ON shape.capture_id = record.capture_id AND shape.scope_key = record.occurrence_group_scope_key
        LEFT JOIN source_record_scopes scope ON scope.source_record_id = record.source_record_id
        LEFT JOIN provenance ON provenance.source_record_id = record.source_record_id
        LEFT JOIN backed ON backed.source_record_id = record.source_record_id
        LEFT JOIN ${cited} cited ON cited.cited_id = record.source_record_id
       WHERE ${copies.where}
    ),
    chained AS (
      SELECT copy.*, ROW_NUMBER() OVER chain AS position,
             LAG(copy.content) OVER chain AS previous_content, LAG(copy.sequence_lexeme) OVER chain AS previous_lexeme
        FROM copy WHERE copy.chained
      WINDOW chain AS (PARTITION BY copy.source_subject_id, copy.record_kind, copy.occurrence_key
                       ORDER BY copy.commit_sequence, copy.source_record_id)
    ),
    classified AS (
      SELECT chained.*,
             CASE WHEN position = 1 THEN 'first'
                  WHEN content IS DISTINCT FROM previous_content THEN 'changed'
                  WHEN manifest_capture THEN 'manifestCapture'
                  WHEN pinned_by IS NOT NULL THEN 'pinned'
                  WHEN sequence_lexeme IS DISTINCT FROM previous_lexeme THEN 'lexemeOnly'
                  ELSE 'removable' END AS category
        FROM chained
    ),
    -- Each kept copy starts a run; the removable copies after it are its repeats.
    runs AS (
      SELECT classified.*, count(*) FILTER (WHERE category <> 'removable') OVER chain AS run
        FROM classified
      WINDOW chain AS (PARTITION BY source_subject_id, record_kind, occurrence_key ORDER BY commit_sequence, source_record_id)
    )
    SELECT source_record_id, capture_id, integration_namespace, record_kind, category, pinned_by, scopes, provenance, assertions,
           CASE WHEN category = 'removable' THEN FIRST_VALUE(source_record_id) OVER (
             PARTITION BY source_subject_id, record_kind, occurrence_key, run ORDER BY commit_sequence, source_record_id) END AS kept_id
      FROM runs
    UNION ALL
    SELECT source_record_id, capture_id, integration_namespace, record_kind, 'unchained' AS category, pinned_by, scopes, provenance, assertions,
           NULL AS kept_id
      FROM copy WHERE NOT copy.chained`;
}

/** Phase B for one subject's copies, each classified once, grouped by namespace, kind and category. */
async function planSubjectCopies(
  transaction: PGliteTransaction,
  subject: Subject,
  columns: FoundColumns,
  kept: readonly KeptCitation[],
): Promise<readonly CopyRow[]> {
  const { rows } = await transaction.query<CopyRow>(`
    SELECT integration_namespace, record_kind, category,
           CASE WHEN category = 'pinned' THEN pinned_by END AS pinned_by,
           count(*)::int AS copies, sum(scopes)::int AS scopes, sum(provenance)::int AS provenance, sum(assertions)::int AS assertions
      FROM (${recordCopiesSql(subjectIs("record.source_subject_id", subject), columns, true)}) classified
     GROUP BY 1, 2, 3, 4`, [kept.map(({ cited }) => cited), kept.map(({ table }) => table)]);
  return rows;
}

type Counts = Record<keyof CompactionCopyCounts, number>;
const emptyCounts = (): Counts =>
  ({ copies: 0, ...Object.fromEntries(CATEGORIES.map((category) => [category, 0])) }) as Counts;

/** Phase B's totals, added up over the subject steps. */
class CopyTally {
  readonly #groups = new Map<string, { integrationNamespace: string; recordKind: string; counts: Counts; pinnedBy: Record<string, number> }>();
  readonly #totals = emptyCounts();
  readonly #pinnedBy: Record<string, number> = {};
  readonly removed = { source_records: 0, source_record_scopes: 0, source_record_provenance: 0, assertion_provenance: 0 };

  add(rows: readonly CopyRow[]): void {
    for (const row of rows) {
      const key = `${row.integration_namespace}\u0000${row.record_kind}`;
      const group = this.#groups.get(key)
        ?? { integrationNamespace: row.integration_namespace, recordKind: row.record_kind, counts: emptyCounts(), pinnedBy: {} };
      this.#groups.set(key, group);
      for (const counts of [group.counts, this.#totals]) {
        counts.copies += row.copies;
        counts[row.category] += row.copies;
      }
      for (const table of row.pinned_by ?? []) {
        group.pinnedBy[table] = (group.pinnedBy[table] ?? 0) + row.copies;
        this.#pinnedBy[table] = (this.#pinnedBy[table] ?? 0) + row.copies;
      }
      if (row.category === "removable") {
        this.removed.source_records += row.copies;
        this.removed.source_record_scopes += row.scopes;
        this.removed.source_record_provenance += row.provenance;
        this.removed.assertion_provenance += row.assertions;
      }
    }
  }

  result(rows: ReadonlyMap<string, number>): Readonly<{
    groups: readonly CompactionRecordGroupPlan[];
    totals: CompactionCopyCounts;
    pinnedBy: Readonly<Record<string, number>>;
    tables: readonly Removable[];
  }> {
    return {
      groups: [...this.#groups.values()].sort((a, b) =>
        a.integrationNamespace.localeCompare(b.integrationNamespace) || a.recordKind.localeCompare(b.recordKind)),
      totals: this.#totals,
      pinnedBy: this.#pinnedBy,
      tables: Object.entries(this.removed).map(([table, removable]) => ({ table, rows: rows.get(table) ?? 0, removable })),
    };
  }
}

/**
 * Phase C: every count row `where` admits, as `row_ctid`, and whether it
 * fails to raise the maximum stored before it in its partition (`repeats`).
 * The first row of a partition never repeats: its window is empty.
 */
export function phaseCMarkedSql(where = "TRUE"): string {
  return `SELECT count_row.ctid AS row_ctid,
                 COALESCE(count_row.occurrence_count <= MAX(count_row.occurrence_count) OVER (
                   PARTITION BY coverage.source_subject_id, coverage.record_kind, coverage.scope_key, coverage.contract_version,
                                count_row.partition_date, count_row.fingerprint
                   ORDER BY written.commit_sequence, count_row.observation_id
                   ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), false) AS repeats
            FROM source_occurrence_group_counts count_row
            JOIN source_occurrence_group_coverages coverage ON coverage.coverage_id = count_row.coverage_id
            JOIN canonical_commits written ON written.commit_id = coverage.commit_id
           WHERE ${where}`;
}

/** Phase C for one subject's count rows; the partition never crosses a subject. */
async function planSubjectCounts(transaction: PGliteTransaction, subject: Subject): Promise<Removable> {
  const { rows: [row] } = await transaction.query<{ rows: number; removable: number }>(`
    SELECT count(*)::int AS rows, (count(*) FILTER (WHERE marked.repeats))::int AS removable
      FROM (${phaseCMarkedSql(subjectIs("coverage.source_subject_id", subject))}) marked`);
  return { table: COUNTS, rows: row!.rows, removable: row!.removable };
}

async function countRows(transaction: PGliteTransaction, tables: readonly string[]): Promise<Map<string, number>> {
  const { rows } = await transaction.query<{ table_name: string; rows: number }>(
    tables.map((table) => `SELECT '${table}' AS table_name, count(*)::int AS rows FROM ${table}`).join("\nUNION ALL\n"),
  );
  return new Map(rows.map((row) => [row.table_name, row.rows]));
}

async function sizeTables(transaction: PGliteTransaction, tables: readonly string[]): Promise<Map<string, number>> {
  const { rows } = await transaction.query<{ table_name: string; bytes: string }>(
    `SELECT name AS table_name, pg_total_relation_size(name::regclass)::text AS bytes FROM unnest($1::text[]) AS name`,
    [tables],
  );
  return new Map(rows.map((row) => [row.table_name, Number(row.bytes)]));
}
