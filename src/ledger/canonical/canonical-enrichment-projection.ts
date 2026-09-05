import type { DatabaseSync, SQLInputValue } from "node:sqlite";

type CanonicalId = Uint8Array;

function sqliteValue(value: unknown): SQLInputValue {
  return value === undefined ? null : value as SQLInputValue;
}

const ENRICHMENT_FIELDS = [
  "kind",
  "category",
  "counterparty_role",
  "counterparty_display",
] as const;

function relationExists(db: DatabaseSync, name: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
      .get(name),
  );
}

function populateCurrentEnrichmentProjection(
  db: DatabaseSync,
  transactionIds: readonly Uint8Array[],
  commitId: CanonicalId,
  cutoffSequence: number,
): void {
  const selectCurrent = db.prepare(`
    SELECT assertion.assertion_id, assertion.transaction_id, assertion.field_name,
           assertion.value_text, assertion.origin, assertion.producer_id,
           run.producer_version, output.route_id,
           typed.taxonomy_id, typed.taxonomy_version, typed.taxonomy_dimension,
           typed.taxonomy_code
      FROM assertions assertion
      JOIN enrichment_run_outputs output
        ON output.assertion_id = assertion.assertion_id
       AND output.output_state = 'supported'
      JOIN enrichment_runs run ON run.run_id = output.run_id
      JOIN financial_transactions transaction_row
        ON transaction_row.transaction_id = assertion.transaction_id
      JOIN financial_accounts account ON account.account_id = transaction_row.account_id
      JOIN source_connections connection
        ON connection.source_connection_id = account.source_connection_id
      JOIN automatic_enrichment_authority_routes route
        ON route.route_id = output.route_id
      LEFT JOIN enrichment_taxonomy_assertion_values typed
        ON typed.assertion_id = assertion.assertion_id
     WHERE assertion.transaction_id = ?
       AND assertion.field_name = ?
       AND (SELECT commit_sequence FROM canonical_commits
             WHERE commit_id = assertion.created_commit_id) <= ?
       AND route.valid_from_commit_sequence <= ?
       AND (route.valid_to_commit_sequence IS NULL OR ? < route.valid_to_commit_sequence)
       AND (
         route.scope_kind = 'global'
         OR (route.scope_kind = 'source_stream'
             AND route.scope_key = connection.integration_namespace || '/' || account.stream)
       )
       AND COALESCE((
         SELECT event.event_kind
           FROM assertion_transitions event
           JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id
          WHERE event.assertion_id = assertion.assertion_id
            AND event_commit.commit_sequence <= ?
          ORDER BY event_commit.commit_sequence DESC, event.rowid DESC
          LIMIT 1
       ), 'observed') NOT IN ('withdrawn','superseded')
     ORDER BY (SELECT commit_sequence FROM canonical_commits
                WHERE commit_id = assertion.created_commit_id) DESC,
              assertion.assertion_id DESC
     LIMIT 1
  `);
  const insertCurrent = db.prepare(`
    INSERT INTO current_transaction_enrichment(
      transaction_id, field_name, assertion_id, value_text, origin,
      producer_id, producer_version, route_id, taxonomy_id, taxonomy_version,
      taxonomy_dimension, taxonomy_code, projection_commit_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const transactionId of transactionIds) {
    for (const field of ENRICHMENT_FIELDS) {
      const selected = selectCurrent.get(
        transactionId,
        field,
        cutoffSequence,
        cutoffSequence,
        cutoffSequence,
        cutoffSequence,
      ) as Record<string, unknown> | undefined;
      if (!selected) continue;
      insertCurrent.run(
        transactionId,
        field,
        sqliteValue(selected.assertion_id),
        sqliteValue(selected.value_text),
        sqliteValue(selected.origin),
        sqliteValue(selected.producer_id),
        sqliteValue(selected.producer_version),
        sqliteValue(selected.route_id),
        sqliteValue(selected.taxonomy_id ?? "transaction-taxonomy"),
        sqliteValue(selected.taxonomy_version ?? "v1"),
        sqliteValue(selected.taxonomy_dimension ?? null),
        sqliteValue(selected.taxonomy_code ?? null),
        commitId,
      );
    }
  }
}

/**
 * Refreshes the Runtime-owned current enrichment projection for the subjects
 * touched by one committed run. The immutable assertions and lifecycle events
 * remain the authority; this table is only a current read acceleration.
 */
export function refreshCanonicalEnrichmentProjection(
  db: DatabaseSync,
  commitId: CanonicalId,
  cutoffSequence: number,
): void {
  if (
    !relationExists(db, "current_transaction_enrichment") ||
    !relationExists(db, "enrichment_run_outputs")
  )
    return;
  const affected = db
    .prepare(
      `SELECT DISTINCT transaction_id
         FROM enrichment_run_outputs
        WHERE commit_id = ?`,
    )
    .all(commitId) as Array<{ transaction_id?: unknown }>;
  const deleteCurrent = db.prepare(
    "DELETE FROM current_transaction_enrichment WHERE transaction_id = ?",
  );
  const transactionIds = affected.map((row) => row.transaction_id as Uint8Array);
  for (const transactionId of transactionIds) deleteCurrent.run(transactionId);
  populateCurrentEnrichmentProjection(db, transactionIds, commitId, cutoffSequence);
}

/** Rebuild the Runtime-owned current enrichment table from immutable history. */
export function rebuildCanonicalEnrichmentProjection(
  db: DatabaseSync,
  commitId: CanonicalId,
  cutoffSequence: number,
): void {
  if (!relationExists(db, "current_transaction_enrichment")) return;
  db.exec("DELETE FROM current_transaction_enrichment");
  const affected = db
    .prepare("SELECT transaction_id FROM financial_transactions")
    .all() as Array<{ transaction_id?: unknown }>;
  if (affected.length === 0) return;
  populateCurrentEnrichmentProjection(
    db,
    affected.map((transaction) => transaction.transaction_id as Uint8Array),
    commitId,
    cutoffSequence,
  );
}
