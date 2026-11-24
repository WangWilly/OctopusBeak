import type { PGliteStore, PGliteTransaction } from "./transaction.ts";

/**
 * A dry run of the ledger compaction: what it would remove from a store
 * written before ADR 0152, without changing anything. ADR 0152 left the
 * copies stored before it in place; this report is the first step of
 * compacting them, so the owner can measure real stores before any delete
 * exists. The compaction and its ADR follow it. Compaction is planned in
 * three phases, and this reports each one:
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
 * Everything runs in one read-only transaction that is rolled back, so a
 * plan is safe to read from a live store. Byte estimates use each table's
 * average size per row, indexes and TOAST included, and are only freed once
 * the tables are rewritten.
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
    SELECT per_commit.invoice_id, per_commit.commit_id,
           ROW_NUMBER() OVER history > 1 AND per_commit.observed = LAG(per_commit.observed) OVER history AS repeats
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
 * Phase A, one query per table: every row, the record it cites as
 * `cited_id`, and whether it repeats the row before it (`repeats`). Each
 * compares the columns its ADR 0152 writer compares, in its reader's order.
 */
const PHASE_A: Readonly<Record<string, Readonly<{ column: string; marked: string }>>> = {
  canonical_credit_card_transaction_details: {
    column: "source_record_id",
    marked: `SELECT domain.source_record_id AS cited_id,
        ROW_NUMBER() OVER history > 1
          AND ROW(domain.revision_id, domain.instrument_id, domain.billing_status, domain.consume_date, domain.posting_date, domain.effective_date_basis, domain.statement_key)
              IS NOT DISTINCT FROM LAG(ROW(domain.revision_id, domain.instrument_id, domain.billing_status, domain.consume_date, domain.posting_date, domain.effective_date_basis, domain.statement_key)) OVER history
          AS repeats
      FROM canonical_credit_card_transaction_details domain ${seqByCapture("domain")}
    WINDOW history AS (PARTITION BY domain.transaction_id ORDER BY domain_commit.commit_sequence, domain.source_record_id)`,
  },
  canonical_credit_card_transaction_lifecycle: {
    column: "source_record_id",
    marked: `SELECT domain.source_record_id AS cited_id,
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
    marked: `SELECT domain.source_record_id AS cited_id,
        ROW_NUMBER() OVER history > 1
          AND evidence.occurrence_key IS NOT DISTINCT FROM LAG(evidence.occurrence_key) OVER history AS repeats
      FROM canonical_credit_card_instrument_evidence domain ${seqByCapture("domain")}
      JOIN source_records evidence ON evidence.source_record_id = domain.source_record_id
    WINDOW history AS (PARTITION BY domain.instrument_id ORDER BY domain_commit.commit_sequence, domain.source_record_id)`,
  },
  canonical_credit_card_statement_summary_evidence: {
    column: "evidence_source_record_id",
    marked: `SELECT domain.evidence_source_record_id AS cited_id,
        ROW_NUMBER() OVER history > 1
          AND ROW(domain.statement_revision_id, domain.evidence_key)
              IS NOT DISTINCT FROM LAG(ROW(domain.statement_revision_id, domain.evidence_key)) OVER history AS repeats
      FROM canonical_credit_card_statement_summary_evidence domain ${seqByCapture("domain")}
      JOIN canonical_credit_card_statement_revisions revision ON revision.statement_revision_id = domain.statement_revision_id
    WINDOW history AS (PARTITION BY revision.statement_id ORDER BY domain_commit.commit_sequence, domain.evidence_source_record_id)`,
  },
  investment_security_name_observations: {
    column: "source_record_id",
    marked: `SELECT domain.source_record_id AS cited_id,
        ROW_NUMBER() OVER history > 1
          AND ROW(domain.name, domain.contract_version) IS NOT DISTINCT FROM LAG(ROW(domain.name, domain.contract_version)) OVER history AS repeats
      FROM investment_security_name_observations domain ${seqByCommit("domain")}
    WINDOW history AS (PARTITION BY domain.security_id ORDER BY domain_commit.commit_sequence, domain.capture_id)`,
  },
  transaction_relation_provenance: {
    column: "source_record_id",
    marked: `SELECT domain.source_record_id AS cited_id,
        ROW_NUMBER() OVER history > 1
          AND ROW(domain.evidence_source_record_key, domain.evidence_relation_id, domain.evidence_contract_version)
              IS NOT DISTINCT FROM LAG(ROW(domain.evidence_source_record_key, domain.evidence_relation_id, domain.evidence_contract_version)) OVER history
          AS repeats
      FROM transaction_relation_provenance domain ${seqByCommit("domain")}
    WINDOW history AS (PARTITION BY domain.relation_id ORDER BY domain_commit.commit_sequence, domain.source_record_id)`,
  },
  financial_account_identifier_observations: {
    column: "source_record_id",
    marked: `SELECT domain.source_record_id AS cited_id,
        ROW_NUMBER() OVER (
          PARTITION BY domain.account_id, domain.identifier_kind, domain.identifier_value, domain.evidence_version, domain.source_field
          ORDER BY domain_commit.commit_sequence, domain.observation_id
        ) > 1 AS repeats
      FROM financial_account_identifier_observations domain ${seqByCommit("domain")}`,
  },
  einvoice_revision_observations: {
    column: "source_record_id",
    marked: `SELECT domain.source_record_id AS cited_id, repeated.invoice_id IS NOT NULL AS repeats
      FROM einvoice_revision_observations domain
      JOIN einvoice_invoice_revisions revision ON revision.revision_id = domain.revision_id
      LEFT JOIN (${EINVOICE_REPEATS}) repeated ON repeated.invoice_id = revision.invoice_id AND repeated.commit_id = domain.commit_id`,
  },
  einvoice_revision_events: {
    column: "source_record_id",
    marked: `SELECT domain.source_record_id AS cited_id, repeated.invoice_id IS NOT NULL AS repeats
      FROM einvoice_revision_events domain
      LEFT JOIN (${EINVOICE_REPEATS}) repeated ON repeated.invoice_id = domain.invoice_id AND repeated.commit_id = domain.commit_id`,
  },
};

const SATELLITES = ["source_record_scopes", "source_record_provenance", "assertion_provenance"] as const;

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
const MANIFEST = "capture_source_record_manifests";
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
  storeBytes: number;
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

/** Plan the compaction of `store` without changing it. */
export async function planLedgerCompaction(store: PGliteStore): Promise<CompactionPlanResult> {
  return store.transaction(async (transaction) => {
    await transaction.query("SET TRANSACTION READ ONLY");
    try {
      return await plan(transaction);
    } finally {
      await transaction.rollback();
    }
  });
}

async function plan(transaction: PGliteTransaction): Promise<CompactionPlanResult> {
  const citing = await readCitingColumns(transaction);
  if (citing.problems.length > 0) return { status: "unrecognised-citations", problems: citing.problems };
  const phaseA = await planDomainRows(transaction);
  const phaseB = await planRecordCopies(transaction, citing.columns);
  const phaseC = await planCountRows(transaction);
  const sized = await sizeTables(transaction, [...phaseA, ...phaseB.tables, phaseC]);
  const estimate = (table: Omit<CompactionTablePlan, "estimatedBytes">): CompactionTablePlan => {
    const bytes = sized.get(table.table) ?? 0;
    return { ...table, estimatedBytes: table.rows === 0 ? 0 : Math.round((bytes / table.rows) * table.removable) };
  };
  const estimatedA = phaseA.map(estimate);
  const estimatedB = phaseB.tables.map(estimate);
  const estimatedC = estimate(phaseC);
  const { rows: [size] } = await transaction.query<{ bytes: string }>("SELECT pg_database_size(current_database())::text AS bytes");
  return {
    status: "planned",
    storeBytes: Number(size!.bytes),
    phaseA: estimatedA,
    phaseB: { ...phaseB, tables: estimatedB },
    phaseC: estimatedC,
    citingColumns: [...citing.columns.keys()].sort(),
    estimatedBytes: [...estimatedA, ...estimatedB, estimatedC].reduce((sum, table) => sum + table.estimatedBytes, 0),
  };
}

type FoundColumns = ReadonlyMap<string, Readonly<{ table: string; column: string; citing: CitingColumn }>>;

async function readCitingColumns(transaction: PGliteTransaction): Promise<Readonly<{
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

async function planDomainRows(transaction: PGliteTransaction): Promise<Omit<CompactionTablePlan, "estimatedBytes">[]> {
  const tables = Object.keys(PHASE_A);
  const { rows } = await transaction.query<{ table_name: string; rows: number; removable: number }>(
    tables.map((table) => `SELECT '${table}' AS table_name, count(*)::int AS rows, (count(*) FILTER (WHERE marked.repeats))::int AS removable
      FROM (${PHASE_A[table]!.marked}) marked`).join("\nUNION ALL\n"),
  );
  return tables.map((table) => {
    const row = rows.find((candidate) => candidate.table_name === table)!;
    return { table, rows: row.rows, removable: row.removable };
  });
}

const CATEGORIES = ["unchained", "first", "changed", "manifestCapture", "pinned", "lexemeOnly", "removable"] as const;
type Category = (typeof CATEGORIES)[number];

async function planRecordCopies(transaction: PGliteTransaction, columns: FoundColumns): Promise<Readonly<{
  groups: readonly CompactionRecordGroupPlan[];
  totals: CompactionCopyCounts;
  pinnedBy: Readonly<Record<string, number>>;
  tables: readonly Omit<CompactionTablePlan, "estimatedBytes">[];
}>> {
  const citations = [...columns.values()].flatMap(({ table, column, citing }) => {
    switch (citing.role) {
      case "satellite": return [];
      case "cites": return [`SELECT ${column} AS cited_id, '${table}' AS citing_table FROM ${table} WHERE ${column} IS NOT NULL`];
      case "compacted": return [`SELECT kept.cited_id, '${table}' AS citing_table FROM (${citing.marked}) kept
                                  WHERE NOT kept.repeats AND kept.cited_id IS NOT NULL`];
    }
  });
  citations.push(
    `SELECT substring(manifest.source_record_ids FROM slot * 16 + 1 FOR 16) AS cited_id, '${MANIFEST}' AS citing_table
       FROM ${MANIFEST} manifest CROSS JOIN generate_series(0, manifest.record_count - 1) AS slot`,
    `SELECT source_record_id AS cited_id, '${MIXED_PROVENANCE}' AS citing_table FROM assertion_provenance
      WHERE source_record_id IS NOT NULL AND (run_id IS NOT NULL OR enrichment_run_id IS NOT NULL OR coordinate_id IS NOT NULL)`,
  );
  const { rows } = await transaction.query<{
    integration_namespace: string;
    record_kind: string;
    category: Category;
    pinned_by: string[] | null;
    copies: number;
    scopes: number;
    provenance: number;
    assertions: number;
  }>(`
    WITH cited AS (
      SELECT cited_id, array_agg(DISTINCT citing_table ORDER BY citing_table) AS pinned_by
        FROM (${citations.join("\nUNION ALL\n")}) citation
       GROUP BY cited_id
    ),
    shape AS (
      SELECT capture_id, scope_key,
             string_agg(DISTINCT contract_version || CASE WHEN bucket_inventory_json IS NULL THEN '/n' ELSE '/i' END, ',') AS shape
        FROM source_occurrence_group_coverages GROUP BY capture_id, scope_key
    ),
    backed AS (
      SELECT source_record_id, string_agg(encode(assertion_id, 'hex'), ',' ORDER BY assertion_id) AS assertions, count(*)::int AS rows
        FROM assertion_provenance WHERE source_record_id IS NOT NULL GROUP BY source_record_id
    ),
    provenance AS (SELECT source_record_id, count(*)::int AS rows FROM source_record_provenance GROUP BY source_record_id),
    copy AS (
      SELECT record.source_record_id, connection.integration_namespace, record.record_kind,
             record.source_subject_id, record.occurrence_key, written.commit_sequence, record.sequence_lexeme,
             record.occurrence_key IS NOT NULL AND record.source_subject_id IS NOT NULL AS chained,
             md5(ROW(record.provider_key, record.content_hash, record.collision_key, record.description, record.payload_json,
                     record.occurrence_group_scope_key, record.occurrence_group_fingerprint, record.occurrence_group_partition_date,
                     record.occurrence_group_ordinal, record.occurrence_group_bucket_key,
                     shape.shape, scope.source_record_id IS NULL, scope.account_id, scope.source_subject_id, backed.assertions)::text) AS content,
             EXISTS (SELECT 1 FROM ${MANIFEST} manifest WHERE manifest.capture_id = record.capture_id) AS manifest_capture,
             cited.pinned_by,
             (scope.source_record_id IS NOT NULL)::int AS scopes, COALESCE(provenance.rows, 0) AS provenance, COALESCE(backed.rows, 0) AS assertions
        FROM source_records record
        JOIN source_captures capture ON capture.capture_id = record.capture_id
        JOIN source_connections connection ON connection.source_connection_id = capture.source_connection_id
        JOIN canonical_commits written ON written.commit_id = record.commit_id
        LEFT JOIN shape ON shape.capture_id = record.capture_id AND shape.scope_key = record.occurrence_group_scope_key
        LEFT JOIN source_record_scopes scope ON scope.source_record_id = record.source_record_id
        LEFT JOIN provenance ON provenance.source_record_id = record.source_record_id
        LEFT JOIN backed ON backed.source_record_id = record.source_record_id
        LEFT JOIN cited ON cited.cited_id = record.source_record_id
    ),
    chained AS (
      SELECT copy.*, ROW_NUMBER() OVER chain AS position,
             LAG(copy.content) OVER chain AS previous_content, LAG(copy.sequence_lexeme) OVER chain AS previous_lexeme
        FROM copy WHERE copy.chained
      WINDOW chain AS (PARTITION BY copy.source_subject_id, copy.record_kind, copy.occurrence_key
                       ORDER BY copy.commit_sequence, copy.source_record_id)
    ),
    classified AS (
      SELECT integration_namespace, record_kind, pinned_by, scopes, provenance, assertions,
             CASE WHEN position = 1 THEN 'first'
                  WHEN content IS DISTINCT FROM previous_content THEN 'changed'
                  WHEN manifest_capture THEN 'manifestCapture'
                  WHEN pinned_by IS NOT NULL THEN 'pinned'
                  WHEN sequence_lexeme IS DISTINCT FROM previous_lexeme THEN 'lexemeOnly'
                  ELSE 'removable' END AS category
        FROM chained
      UNION ALL
      SELECT integration_namespace, record_kind, pinned_by, scopes, provenance, assertions, 'unchained' AS category
        FROM copy WHERE NOT copy.chained
    )
    SELECT integration_namespace, record_kind, category,
           CASE WHEN category = 'pinned' THEN pinned_by END AS pinned_by,
           count(*)::int AS copies, sum(scopes)::int AS scopes, sum(provenance)::int AS provenance, sum(assertions)::int AS assertions
      FROM classified
     GROUP BY 1, 2, 3, 4
     ORDER BY 1, 2, 3`);
  const groups = new Map<string, { integrationNamespace: string; recordKind: string; counts: Record<keyof CompactionCopyCounts, number>; pinnedBy: Record<string, number> }>();
  const emptyCounts = (): Record<keyof CompactionCopyCounts, number> =>
    ({ copies: 0, ...Object.fromEntries(CATEGORIES.map((category) => [category, 0])) }) as Record<keyof CompactionCopyCounts, number>;
  const totals = emptyCounts();
  const pinnedBy: Record<string, number> = {};
  const removed = { source_records: 0, source_record_scopes: 0, source_record_provenance: 0, assertion_provenance: 0 };
  for (const row of rows) {
    const key = `${row.integration_namespace}\u0000${row.record_kind}`;
    const group = groups.get(key) ?? { integrationNamespace: row.integration_namespace, recordKind: row.record_kind, counts: emptyCounts(), pinnedBy: {} };
    groups.set(key, group);
    for (const counts of [group.counts, totals]) {
      counts.copies += row.copies;
      counts[row.category] += row.copies;
    }
    for (const table of row.pinned_by ?? []) {
      group.pinnedBy[table] = (group.pinnedBy[table] ?? 0) + row.copies;
      pinnedBy[table] = (pinnedBy[table] ?? 0) + row.copies;
    }
    if (row.category === "removable") {
      removed.source_records += row.copies;
      removed.source_record_scopes += row.scopes;
      removed.source_record_provenance += row.provenance;
      removed.assertion_provenance += row.assertions;
    }
  }
  const counted = await countRows(transaction, Object.keys(removed));
  return {
    groups: [...groups.values()],
    totals,
    pinnedBy,
    tables: Object.entries(removed).map(([table, removable]) => ({ table, rows: counted.get(table) ?? 0, removable })),
  };
}

async function planCountRows(transaction: PGliteTransaction): Promise<Omit<CompactionTablePlan, "estimatedBytes">> {
  const { rows: [row] } = await transaction.query<{ rows: number; removable: number }>(`
    SELECT count(*)::int AS rows, (count(*) FILTER (WHERE marked.repeats))::int AS removable FROM (
      SELECT count_row.occurrence_count <= MAX(count_row.occurrence_count) OVER (
               PARTITION BY coverage.source_subject_id, coverage.record_kind, coverage.scope_key, coverage.contract_version,
                            count_row.partition_date, count_row.fingerprint
               ORDER BY written.commit_sequence, count_row.observation_id
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS repeats
        FROM source_occurrence_group_counts count_row
        JOIN source_occurrence_group_coverages coverage ON coverage.coverage_id = count_row.coverage_id
        JOIN canonical_commits written ON written.commit_id = coverage.commit_id
    ) marked`);
  return { table: "source_occurrence_group_counts", rows: row!.rows, removable: row!.removable };
}

async function countRows(transaction: PGliteTransaction, tables: readonly string[]): Promise<Map<string, number>> {
  const { rows } = await transaction.query<{ table_name: string; rows: number }>(
    tables.map((table) => `SELECT '${table}' AS table_name, count(*)::int AS rows FROM ${table}`).join("\nUNION ALL\n"),
  );
  return new Map(rows.map((row) => [row.table_name, row.rows]));
}

async function sizeTables(transaction: PGliteTransaction, tables: readonly Readonly<{ table: string }>[]): Promise<Map<string, number>> {
  const { rows } = await transaction.query<{ table_name: string; bytes: string }>(
    `SELECT name AS table_name, pg_total_relation_size(name::regclass)::text AS bytes FROM unnest($1::text[]) AS name`,
    [tables.map(({ table }) => table)],
  );
  return new Map(rows.map((row) => [row.table_name, Number(row.bytes)]));
}
