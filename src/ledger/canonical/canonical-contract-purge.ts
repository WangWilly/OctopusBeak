import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { assertValidatedCanonicalDatabase } from "./canonical-schema-lifecycle.ts";
import {
  CREDIT_CARD_SOURCE_CONNECTION_V1_PURGE_ID,
  CREDIT_CARD_SOURCE_CONNECTION_V1_PURGE_NAMESPACES,
  CREDIT_CARD_SOURCE_CONNECTION_V1_PURGE_STREAMS,
  FUBON_DEPOSIT_OCCURRENCE_V1_PURGE_ID,
  FUBON_DEPOSIT_OCCURRENCE_V1_PURGE_NAMESPACES,
  FUBON_DEPOSIT_OCCURRENCE_V1_PURGE_STREAMS,
  SOURCE_CONNECTION_IDENTITY_V1_PURGE_ID,
  SOURCE_CONNECTION_IDENTITY_V1_PURGE_NAMESPACES,
  SOURCE_CONNECTION_IDENTITY_V1_PURGE_STREAMS,
  YUANTA_TRADE_INVESTMENT_V2_PURGE_ID,
  YUANTA_TRADE_INVESTMENT_V2_PURGE_NAMESPACES,
  YUANTA_TRADE_INVESTMENT_V2_PURGE_STREAMS,
  YUANTA_TRADE_INVESTMENT_V3_PURGE_ID,
  YUANTA_TRADE_INVESTMENT_V3_PURGE_NAMESPACES,
  YUANTA_TRADE_INVESTMENT_V3_PURGE_STREAMS,
  isExactRetiredFubonV18BridgeState,
  canonicalCommitHasEvidence,
  validateCanonicalContractPurgeSchema,
  validateCanonicalDatabaseAfterLifecycle,
  quotedSqlIdentifier,
  blob,
  relationType,
  tableExists,
  currentUtcMicros,
} from "./canonical-schema-implementation.ts";

function bridgeRetiredFubonV18SourceCommits(db: DatabaseSync): void {
  if (!isExactRetiredFubonV18BridgeState(db)) return;

  const result = db
    .prepare(
      `INSERT INTO canonical_contract_purge_commits(purge_id, commit_id)
       SELECT ?, commit_id FROM canonical_commits
        WHERE commit_sequence BETWEEN 2 AND 552
        ORDER BY commit_sequence`,
    )
    .run(SOURCE_CONNECTION_IDENTITY_V1_PURGE_ID);
  if (Number(result.changes) !== 551)
    throw new Error(
      "Canonical v18 retired Fubon source-commit audit bridge count is invalid.",
    );
}

type SqliteForeignKey = {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
};

function canonicalTableNames(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map(({ name }) => name);
}

function selectedRowIds(db: DatabaseSync, sql: string): Set<number> {
  return new Set(
    (db.prepare(sql).all() as Array<{ rowid: number }>).map(({ rowid }) =>
      Number(rowid),
    ),
  );
}

function addSelectedRows(
  targetRows: Map<string, Set<number>>,
  table: string,
  rows: Iterable<number>,
): boolean {
  const selected = targetRows.get(table) ?? new Set<number>();
  const before = selected.size;
  for (const rowid of rows) selected.add(rowid);
  if (selected.size > 0) targetRows.set(table, selected);
  return selected.size !== before;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

type CanonicalPurgeScope = Readonly<{
  namespaces: readonly string[];
  streams: readonly string[];
  includeLoanResolverImplications?: boolean;
  /**
   * Shared identity/audit parents are deliberately retained for a product
   * scope purge.  Their other children may belong to a different stream or
   * provider and must not be pulled into this closure merely because they
   * share a parent row.
   */
  stopAtTables?: readonly string[];
}>;

function legacySourceConnectionIdentityClosure(
  db: DatabaseSync,
  scope: CanonicalPurgeScope = {
    namespaces: SOURCE_CONNECTION_IDENTITY_V1_PURGE_NAMESPACES,
    streams: SOURCE_CONNECTION_IDENTITY_V1_PURGE_STREAMS,
    includeLoanResolverImplications: true,
    stopAtTables: [
      "source_connections",
      "identity_epochs",
      "source_authority_routes",
      "canonical_commits",
      "projection_generations",
    ],
  },
): Map<string, Set<number>> {
  const targetRows = new Map<string, Set<number>>();
  const namespaces = scope.namespaces.map((value) => `'${value}'`).join(", ");
  const streams = scope.streams.map((value) => `'${value}'`).join(", ");
  const exactScope = `connection.integration_namespace IN (${namespaces}) AND scoped.stream IN (${streams})`;

  for (const table of [
    "source_captures",
    "financial_accounts",
    "source_subjects",
  ]) {
    if (!tableExists(db, table)) continue;
    addSelectedRows(
      targetRows,
      table,
      selectedRowIds(
        db,
        `SELECT scoped.rowid AS rowid
           FROM ${quotedSqlIdentifier(table)} scoped
           JOIN source_connections connection
             ON connection.source_connection_id = scoped.source_connection_id
          WHERE ${exactScope}`,
      ),
    );
  }

  // A route binding is scoped by the route's provider/product contract rather
  // than by a Capture foreign key. Seed only bindings whose route itself is
  // one of the affected provider streams; unrelated routes on the same
  // Source Connection remain available.
  if (
    tableExists(db, "source_route_bindings") &&
    tableExists(db, "source_authority_routes")
  )
    addSelectedRows(
      targetRows,
      "source_route_bindings",
      selectedRowIds(
        db,
        `SELECT binding.rowid AS rowid
           FROM source_route_bindings binding
           JOIN source_connections connection
             ON connection.source_connection_id = binding.source_connection_id
           JOIN source_authority_routes route
             ON route.authority_route = binding.authority_route
          WHERE connection.integration_namespace IN (${namespaces})
            AND route.integration_namespace = connection.integration_namespace
            AND route.stream IN (${streams})`,
      ),
    );

  // Resolver runs and settlement groups are owned by the affected connection,
  // but do not point back to a capture/account root. Seed these loan-specific
  // dependents only for connections that actually contain an affected scope.
  for (const table of scope.includeLoanResolverImplications === false
    ? []
    : ["loan_repayment_resolution_runs", "loan_repayment_settlement_groups"]) {
    if (!tableExists(db, table)) continue;
    addSelectedRows(
      targetRows,
      table,
      selectedRowIds(
        db,
        `SELECT owned.rowid AS rowid
           FROM ${quotedSqlIdentifier(table)} owned
           JOIN source_connections connection
             ON connection.source_connection_id = owned.source_connection_id
          WHERE connection.integration_namespace IN (${namespaces})
            AND EXISTS (
              SELECT 1 FROM source_captures scoped_capture
               WHERE scoped_capture.source_connection_id = connection.source_connection_id
                 AND scoped_capture.stream IN (${streams})
              UNION ALL
              SELECT 1 FROM financial_accounts scoped_account
               WHERE scoped_account.source_connection_id = connection.source_connection_id
                 AND scoped_account.stream IN (${streams})
            )`,
      ),
    );
  }

  const tables = canonicalTableNames(db).filter(
    (table) => table !== "canonical_contract_purges",
  );
  const foreignKeys = new Map<string, SqliteForeignKey[]>();
  for (const table of tables) {
    foreignKeys.set(
      table,
      db
        .prepare(`PRAGMA foreign_key_list(${quotedSqlIdentifier(table)})`)
        .all() as SqliteForeignKey[],
    );
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const childTable of tables) {
      const grouped = new Map<number, SqliteForeignKey[]>();
      for (const foreignKey of foreignKeys.get(childTable) ?? []) {
        const group = grouped.get(foreignKey.id) ?? [];
        group.push(foreignKey);
        grouped.set(foreignKey.id, group);
      }
      for (const group of grouped.values()) {
        const parentTable = group[0]!.table;
        if (scope.stopAtTables?.includes(parentTable)) continue;
        const parentRows = [...(targetRows.get(parentTable) ?? [])];
        if (parentRows.length === 0) continue;
        for (let offset = 0; offset < parentRows.length; offset += 800) {
          const batch = parentRows.slice(offset, offset + 800);
          const join = group
            .sort((left, right) => left.seq - right.seq)
            .map(
              ({ from, to }) =>
                `child.${quotedSqlIdentifier(from)} IS parent.${quotedSqlIdentifier(to)}`,
            )
            .join(" AND ");
          const rows = db
            .prepare(
              `SELECT child.rowid AS rowid
                 FROM ${quotedSqlIdentifier(childTable)} child
                 JOIN ${quotedSqlIdentifier(parentTable)} parent ON ${join}
                WHERE parent.rowid IN (${placeholders(batch.length)})`,
            )
            .all(...batch) as Array<{ rowid: number }>;
          if (
            addSelectedRows(
              targetRows,
              childTable,
              rows.map(({ rowid }) => Number(rowid)),
            )
          )
            changed = true;
        }
      }
    }
  }
  return targetRows;
}

function purgeLegacySourceConnectionIdentityScopes(db: DatabaseSync): void {
  if (
    db
      .prepare("SELECT 1 FROM canonical_contract_purges WHERE purge_id = ?")
      .get(SOURCE_CONNECTION_IDENTITY_V1_PURGE_ID)
  )
    return;

  const closure = legacySourceConnectionIdentityClosure(db);
  const purgedCommitIds = new Map<string, Uint8Array>();
  // Every canonical commit referenced by the ownership closure becomes part
  // of the non-financial purge audit. This includes Capture, resolver,
  // relation, and projection-support commits rather than assuming one commit
  // column or one product writer shape.
  for (const [table, selected] of closure) {
    const commitColumns = new Set(
      (
        db
          .prepare(`PRAGMA foreign_key_list(${quotedSqlIdentifier(table)})`)
          .all() as SqliteForeignKey[]
      )
        .filter(({ table: parentTable }) => parentTable === "canonical_commits")
        .map(({ from }) => from),
    );
    const rowids = [...selected];
    for (const column of commitColumns) {
      for (let offset = 0; offset < rowids.length; offset += 800) {
        const batch = rowids.slice(offset, offset + 800);
        const rows = db
          .prepare(
            `SELECT DISTINCT ${quotedSqlIdentifier(column)} AS commit_id
               FROM ${quotedSqlIdentifier(table)}
              WHERE rowid IN (${placeholders(batch.length)})
                AND ${quotedSqlIdentifier(column)} IS NOT NULL`,
          )
          .all(...batch) as Array<{ commit_id: Uint8Array }>;
        for (const { commit_id: commitId } of rows)
          purgedCommitIds.set(Buffer.from(commitId).toString("hex"), commitId);
      }
    }
  }
  const tableCounts = Object.fromEntries(
    [...closure.entries()]
      .filter(([, rows]) => rows.size > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([table, rows]) => [table, rows.size]),
  );
  const fingerprint = createHash("sha256");
  for (const [table, rows] of [...closure.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    for (const rowid of [...rows].sort((left, right) => left - right))
      fingerprint.update(`${table}\u0000${rowid}\n`);
  }

  // Foreign keys are disabled by the surrounding migration transaction. The
  // complete dependent closure is deleted first in logical terms; an explicit
  // foreign_key_check below is the commit gate and aborts any missed edge.
  for (const [table, rows] of closure) {
    const rowids = [...rows];
    for (let offset = 0; offset < rowids.length; offset += 800) {
      const batch = rowids.slice(offset, offset + 800);
      db.prepare(
        `DELETE FROM ${quotedSqlIdentifier(table)} WHERE rowid IN (${placeholders(batch.length)})`,
      ).run(...batch);
    }
  }
  // Projection-generation provenance is immutable operational audit. The
  // data transition removes the selected financial/source ownership closure
  // but deliberately does not drop its guard triggers or rewrite history.
  const foreignKeyDefects = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyDefects.length > 0)
    throw new Error(
      "Canonical Source Connection identity purge left a dangling foreign-key reference.",
    );

  const deletedRowCount = Object.values(tableCounts).reduce(
    (total, count) => total + count,
    0,
  );
  db.prepare(
    `INSERT INTO canonical_contract_purges(
       purge_id, schema_version, reason, scope_json, deleted_row_count,
       deleted_table_counts_json, closure_fingerprint, applied_at_utc_us
     ) VALUES (?, 11, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SOURCE_CONNECTION_IDENTITY_V1_PURGE_ID,
    "replace product-split or secret/device-dependent Source Connection identity; recollect under deterministic provider-login identity",
    JSON.stringify({
      integrationNamespaces: SOURCE_CONNECTION_IDENTITY_V1_PURGE_NAMESPACES,
      streams: SOURCE_CONNECTION_IDENTITY_V1_PURGE_STREAMS,
    }),
    deletedRowCount,
    JSON.stringify(tableCounts),
    `sha256:${fingerprint.digest("base64url")}`,
    currentUtcMicros(),
  );
  const insertPurgedCommit = db.prepare(
    "INSERT INTO canonical_contract_purge_commits(purge_id, commit_id) VALUES (?, ?)",
  );
  for (const commitId of purgedCommitIds.values())
    insertPurgedCommit.run(SOURCE_CONNECTION_IDENTITY_V1_PURGE_ID, commitId);
}

type CanonicalContractPurgeAudit = Readonly<{
  purgeId: string;
  schemaVersion: 12 | 14 | 17 | 19;
  reason: string;
  integrationNamespaces: readonly string[];
  streams: readonly string[];
}>;

function purgeCanonicalClosureToAudit(
  db: DatabaseSync,
  closure: Map<string, Set<number>>,
  audit: CanonicalContractPurgeAudit,
): void {
  const purgedCommitIds = new Map<string, Uint8Array>();
  for (const [table, selected] of closure) {
    const commitColumns = new Set(
      (
        db
          .prepare(`PRAGMA foreign_key_list(${quotedSqlIdentifier(table)})`)
          .all() as SqliteForeignKey[]
      )
        .filter(({ table: parentTable }) => parentTable === "canonical_commits")
        .map(({ from }) => from),
    );
    const rowids = [...selected];
    for (const column of commitColumns) {
      for (let offset = 0; offset < rowids.length; offset += 800) {
        const batch = rowids.slice(offset, offset + 800);
        const rows = db
          .prepare(
            `SELECT DISTINCT ${quotedSqlIdentifier(column)} AS commit_id
               FROM ${quotedSqlIdentifier(table)}
              WHERE rowid IN (${placeholders(batch.length)})
                AND ${quotedSqlIdentifier(column)} IS NOT NULL`,
          )
          .all(...batch) as Array<{ commit_id: Uint8Array }>;
        for (const { commit_id: commitId } of rows)
          purgedCommitIds.set(Buffer.from(commitId).toString("hex"), commitId);
      }
    }
  }

  const tableCounts = Object.fromEntries(
    [...closure.entries()]
      .filter(([, rows]) => rows.size > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([table, rows]) => [table, rows.size]),
  );
  const fingerprint = createHash("sha256");
  for (const [table, rows] of [...closure.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    for (const rowid of [...rows].sort((left, right) => left - right))
      fingerprint.update(`${table}\u0000${rowid}\n`);
  }

  for (const [table, rows] of closure) {
    const rowids = [...rows];
    for (let offset = 0; offset < rowids.length; offset += 800) {
      const batch = rowids.slice(offset, offset + 800);
      db.prepare(
        `DELETE FROM ${quotedSqlIdentifier(table)} WHERE rowid IN (${placeholders(batch.length)})`,
      ).run(...batch);
    }
  }
  // Keep projection-generation provenance immutable; its commits remain
  // retained audit roots even when the selected source closure is removed.
  if (db.prepare("PRAGMA foreign_key_check").all().length > 0)
    throw new Error(
      "Canonical scoped source purge left a dangling foreign-key reference.",
    );

  const deletedRowCount = Object.values(tableCounts).reduce(
    (total, count) => total + count,
    0,
  );
  db.prepare(
    `INSERT INTO canonical_contract_purges(
       purge_id, schema_version, reason, scope_json, deleted_row_count,
       deleted_table_counts_json, closure_fingerprint, applied_at_utc_us
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    audit.purgeId,
    audit.schemaVersion,
    audit.reason,
    JSON.stringify({
      integrationNamespaces: audit.integrationNamespaces,
      streams: audit.streams,
    }),
    deletedRowCount,
    JSON.stringify(tableCounts),
    `sha256:${fingerprint.digest("base64url")}`,
    currentUtcMicros(),
  );
  const insertPurgedCommit = db.prepare(
    "INSERT INTO canonical_contract_purge_commits(purge_id, commit_id) VALUES (?, ?)",
  );
  for (const commitId of purgedCommitIds.values())
    insertPurgedCommit.run(audit.purgeId, commitId);
}

function purgeLegacyCreditCardSourceScopes(db: DatabaseSync): void {
  if (
    db
      .prepare("SELECT 1 FROM canonical_contract_purges WHERE purge_id = ?")
      .get(CREDIT_CARD_SOURCE_CONNECTION_V1_PURGE_ID)
  )
    return;
  purgeCanonicalClosureToAudit(
    db,
    legacySourceConnectionIdentityClosure(db, {
      namespaces: CREDIT_CARD_SOURCE_CONNECTION_V1_PURGE_NAMESPACES,
      streams: CREDIT_CARD_SOURCE_CONNECTION_V1_PURGE_STREAMS,
      includeLoanResolverImplications: false,
      stopAtTables: [
        "source_connections",
        "identity_epochs",
        "source_authority_routes",
        "canonical_commits",
        "projection_generations",
      ],
    }),
    {
      purgeId: CREDIT_CARD_SOURCE_CONNECTION_V1_PURGE_ID,
      schemaVersion: 12,
      reason:
        "replace product-specific Fubon or Yuanta credit-card Source Connection identity; recollect under the shared caller identity",
      integrationNamespaces: CREDIT_CARD_SOURCE_CONNECTION_V1_PURGE_NAMESPACES,
      streams: CREDIT_CARD_SOURCE_CONNECTION_V1_PURGE_STREAMS,
    },
  );
}

function purgeFubonDepositOccurrenceV1Scope(db: DatabaseSync): void {
  if (
    db
      .prepare("SELECT 1 FROM canonical_contract_purges WHERE purge_id = ?")
      .get(FUBON_DEPOSIT_OCCURRENCE_V1_PURGE_ID)
  )
    return;
  purgeCanonicalClosureToAudit(
    db,
    legacySourceConnectionIdentityClosure(db, {
      namespaces: FUBON_DEPOSIT_OCCURRENCE_V1_PURGE_NAMESPACES,
      streams: FUBON_DEPOSIT_OCCURRENCE_V1_PURGE_STREAMS,
      includeLoanResolverImplications: true,
      stopAtTables: [
        "source_connections",
        "identity_epochs",
        "source_authority_routes",
        "canonical_commits",
        "projection_generations",
      ],
    }),
    {
      purgeId: FUBON_DEPOSIT_OCCURRENCE_V1_PURGE_ID,
      schemaVersion: 14,
      reason:
        "replace Fubon deposit occurrence identity that treated provider-window-dependent notes as stable; recollect under observed-composite-v2",
      integrationNamespaces: FUBON_DEPOSIT_OCCURRENCE_V1_PURGE_NAMESPACES,
      streams: FUBON_DEPOSIT_OCCURRENCE_V1_PURGE_STREAMS,
    },
  );
}

function purgeYuantaTradeInvestmentV2Scope(db: DatabaseSync): void {
  if (
    db
      .prepare("SELECT 1 FROM canonical_contract_purges WHERE purge_id = ?")
      .get(YUANTA_TRADE_INVESTMENT_V2_PURGE_ID)
  )
    return;
  purgeCanonicalClosureToAudit(
    db,
    legacySourceConnectionIdentityClosure(db, {
      namespaces: YUANTA_TRADE_INVESTMENT_V2_PURGE_NAMESPACES,
      streams: YUANTA_TRADE_INVESTMENT_V2_PURGE_STREAMS,
      includeLoanResolverImplications: false,
      stopAtTables: [
        "source_connections",
        "identity_epochs",
        "source_authority_routes",
        "canonical_commits",
        "projection_generations",
      ],
    }),
    {
      purgeId: YUANTA_TRADE_INVESTMENT_V2_PURGE_ID,
      schemaVersion: 17,
      reason:
        "replace Yuanta trade investment captures with versioned live MarketNo settlement evidence; recollect under market-v2",
      integrationNamespaces: YUANTA_TRADE_INVESTMENT_V2_PURGE_NAMESPACES,
      streams: YUANTA_TRADE_INVESTMENT_V2_PURGE_STREAMS,
    },
  );
}

function purgeYuantaTradeInvestmentV3Scope(db: DatabaseSync): boolean {
  if (
    db
      .prepare("SELECT 1 FROM canonical_contract_purges WHERE purge_id = ?")
      .get(YUANTA_TRADE_INVESTMENT_V3_PURGE_ID)
  )
    return true;
  const closure = legacySourceConnectionIdentityClosure(db, {
    namespaces: YUANTA_TRADE_INVESTMENT_V3_PURGE_NAMESPACES,
    streams: YUANTA_TRADE_INVESTMENT_V3_PURGE_STREAMS,
    includeLoanResolverImplications: false,
    stopAtTables: [
      "source_connections",
      "identity_epochs",
      "source_authority_routes",
      "canonical_commits",
      "projection_generations",
    ],
  });
  purgeCanonicalClosureToAudit(
    db,
    closure,
    {
      purgeId: YUANTA_TRADE_INVESTMENT_V3_PURGE_ID,
      schemaVersion: 19,
      reason:
        "remove Yuanta trade investment source occurrences that embedded capture-local keys and timestamps; recollect under source-content-v3",
      integrationNamespaces: YUANTA_TRADE_INVESTMENT_V3_PURGE_NAMESPACES,
      streams: YUANTA_TRADE_INVESTMENT_V3_PURGE_STREAMS,
    },
  );
  return true;
}

function reconcileProjectionCutoffsAfterContractDataTransition(
  db: DatabaseSync,
): void {
  if (relationType(db, "projection_generations") !== "table") return;
  const generations = db
    .prepare(
      `SELECT generation_id, status, switched_commit_id
         FROM projection_generations
        WHERE switched_commit_id IS NOT NULL
        ORDER BY generation_id`,
    )
    .all() as Array<{
      generation_id: number;
      status: string;
      switched_commit_id: Uint8Array;
    }>;
  const commits = db
    .prepare(
      "SELECT commit_id, commit_sequence, commit_kind FROM canonical_commits ORDER BY commit_sequence",
    )
    .all() as Array<Record<string, unknown>>;
  for (const generation of generations) {
    const switchedSequence = Number(
      (
        db
          .prepare(
            "SELECT commit_sequence FROM canonical_commits WHERE commit_id = ?",
          )
          .get(generation.switched_commit_id) as
          | { commit_sequence?: number }
          | undefined
      )?.commit_sequence ?? -1,
    );
    const retirementSequence =
      generation.status === "retired"
        ? Number(
            (
              db
                .prepare(
                  `SELECT MIN(commit_row.commit_sequence) AS sequence
                     FROM projection_generations later
                     JOIN canonical_commits commit_row
                       ON commit_row.commit_id = later.created_commit_id
                    WHERE later.generation_id > ?`,
                )
                .get(generation.generation_id) as
                | { sequence?: number }
                | undefined
            )?.sequence ?? -1,
          )
        : Number.POSITIVE_INFINITY;
    const latestEvidence = commits
      .filter((commit) => {
        const sequence = Number(commit.commit_sequence);
        return (
          sequence >= switchedSequence &&
          sequence < retirementSequence &&
          canonicalCommitHasEvidence(
            db,
            String(commit.commit_kind),
            blob(commit.commit_id),
          )
        );
      })
      .at(-1);
    if (!latestEvidence) continue;
    db.prepare(
      "UPDATE projection_generations SET build_cutoff_commit_sequence = ? WHERE generation_id = ?",
    ).run(Number(latestEvidence.commit_sequence), generation.generation_id);
    if (generation.status === "active")
      db.prepare(
        "UPDATE current_projection_state SET commit_id = ? WHERE generation = 1",
      ).run(blob(latestEvidence.commit_id));
  }
}

const REQUIRED_CANONICAL_CONTRACT_PURGES = Object.freeze([
  { id: SOURCE_CONNECTION_IDENTITY_V1_PURGE_ID, apply: purgeLegacySourceConnectionIdentityScopes },
  { id: CREDIT_CARD_SOURCE_CONNECTION_V1_PURGE_ID, apply: purgeLegacyCreditCardSourceScopes },
  { id: FUBON_DEPOSIT_OCCURRENCE_V1_PURGE_ID, apply: purgeFubonDepositOccurrenceV1Scope },
  { id: YUANTA_TRADE_INVESTMENT_V2_PURGE_ID, apply: purgeYuantaTradeInvestmentV2Scope },
  { id: YUANTA_TRADE_INVESTMENT_V3_PURGE_ID, apply: purgeYuantaTradeInvestmentV3Scope },
]);

const REQUIRED_CANONICAL_CONTRACT_PURGE_VALIDATION = Object.freeze({
  requireSourceConnectionIdentityPurge: true,
  requireCreditCardPurge: true,
  requireFubonDepositOccurrencePurge: true,
  requireYuantaTradeInvestmentPurge: true,
  requireYuantaTradeInvestmentV3Purge: true,
});

function validateRequiredCanonicalContractPurges(db: DatabaseSync): void {
  for (const transition of REQUIRED_CANONICAL_CONTRACT_PURGES)
    if (
      !db
        .prepare("SELECT 1 FROM canonical_contract_purges WHERE purge_id = ?")
        .get(transition.id)
    )
      throw new Error(
        `Canonical Contract Purge audit is missing: ${transition.id}.`,
      );
  validateCanonicalContractPurgeSchema(
    db,
    REQUIRED_CANONICAL_CONTRACT_PURGE_VALIDATION,
  );
}

function applyCanonicalContractDataTransitions(
  db: DatabaseSync,
  _openedFromVersion: number,
): void {
  assertValidatedCanonicalDatabase(db);
  // Completion is evidenced by the durable purge audit, not by the schema
  // version observed during this particular open. A process may crash after
  // the schema commit but before this data transaction commits; every reopen
  // therefore retries any audit that is still absent.
  bridgeRetiredFubonV18SourceCommits(db);
  for (const transition of REQUIRED_CANONICAL_CONTRACT_PURGES)
    transition.apply(db);
  reconcileProjectionCutoffsAfterContractDataTransition(db);
  validateRequiredCanonicalContractPurges(db);
  validateCanonicalDatabaseAfterLifecycle(db);
}

export {
  applyCanonicalContractDataTransitions,
  validateRequiredCanonicalContractPurges,
};
