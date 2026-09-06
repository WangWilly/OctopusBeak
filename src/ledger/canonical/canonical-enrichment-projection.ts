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
  refreshCanonicalDisplayAndTagsProjection(db, commitId, cutoffSequence);
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
  refreshCanonicalDisplayAndTagsProjection(db, commitId, cutoffSequence);
}

/**
 * Rebuild the Runtime-owned current participation and tag accelerators from
 * the immutable assertion spine. Display resolution itself remains in the
 * enrichment query so historical reads can apply one bounded knowledge point.
 */
export function refreshCanonicalDisplayAndTagsProjection(
  db: DatabaseSync,
  commitId: CanonicalId,
  cutoffSequence: number,
): void {
  if (
    !relationExists(db, "current_counterparty_participations") ||
    !relationExists(db, "current_transaction_tags")
  ) return;

  db.exec("DELETE FROM current_counterparty_participations");
  db.exec("DELETE FROM current_transaction_tags");

  db.prepare(`
    WITH output_candidates AS (
      SELECT output.assertion_id, output.transaction_id, output.route_id,
             output.commit_id, output.rowid AS output_rowid,
             ROW_NUMBER() OVER (
               PARTITION BY output.assertion_id
               ORDER BY output_commit.commit_sequence DESC, output.rowid DESC
             ) AS output_rank
        FROM enrichment_run_outputs output
        JOIN canonical_commits output_commit ON output_commit.commit_id = output.commit_id
       WHERE output.field_name = 'counterparty_role'
         AND output.output_state = 'supported'
         AND output_commit.commit_sequence <= ?
    ), role_candidates AS (
      SELECT candidate.assertion_id, candidate.transaction_id,
             candidate.route_id, candidate.output_rowid,
             ROW_NUMBER() OVER (
               PARTITION BY candidate.transaction_id
               ORDER BY output_commit.commit_sequence DESC, candidate.output_rowid DESC,
                        candidate.assertion_id DESC
             ) AS role_rank
        FROM output_candidates candidate
        JOIN canonical_commits output_commit ON output_commit.commit_id = candidate.commit_id
        JOIN assertions assertion ON assertion.assertion_id = candidate.assertion_id
        JOIN financial_transactions transaction_row ON transaction_row.transaction_id = candidate.transaction_id
        JOIN financial_accounts account ON account.account_id = transaction_row.account_id
        JOIN source_connections connection ON connection.source_connection_id = account.source_connection_id
        JOIN automatic_enrichment_authority_routes route ON route.route_id = candidate.route_id
       WHERE candidate.output_rank = 1
         AND assertion.field_name = 'counterparty_role'
         AND (SELECT commit_sequence FROM canonical_commits
               WHERE commit_id = assertion.created_commit_id) <= ?
         AND route.valid_from_commit_sequence <= ?
         AND (route.valid_to_commit_sequence IS NULL OR ? < route.valid_to_commit_sequence)
         AND (route.scope_kind = 'global' OR
              (route.scope_kind = 'source_stream' AND
               route.scope_key = connection.integration_namespace || '/' || account.stream))
         AND COALESCE((SELECT event_kind
                         FROM assertion_transitions event
                         JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id
                        WHERE event.assertion_id = assertion.assertion_id
                          AND event_commit.commit_sequence <= ?
                        ORDER BY event_commit.commit_sequence DESC, event.rowid DESC
                        LIMIT 1), 'observed') NOT IN ('withdrawn','superseded')
    )
    INSERT INTO current_counterparty_participations(
      transaction_id, participation_id, assertion_id, participation_key,
      role_code, reference_id, observed_name, observed_reference,
      source_classification_scheme, source_classification_code, origin,
      producer_id, producer_version, route_id, provenance_json,
      projection_commit_id)
    SELECT participation.transaction_id, participation.participation_id,
           participation.assertion_id, participation.participation_key,
           participation.role_code, participation.reference_id,
           participation.observed_name, participation.observed_reference,
           participation.source_classification_scheme,
           participation.source_classification_code, participation.origin,
           participation.producer_id, participation.producer_version,
           participation.route_id, participation.provenance_json, ?
      FROM counterparty_participations participation
      JOIN role_candidates role
        ON role.assertion_id = participation.assertion_id
       AND role.transaction_id = participation.transaction_id
       AND role.role_rank = 1
      JOIN canonical_commits participation_commit
        ON participation_commit.commit_id = participation.commit_id
     WHERE participation_commit.commit_sequence <= ?
       AND COALESCE((SELECT event_kind
                       FROM assertion_transitions event
                       JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id
                      WHERE event.assertion_id = participation.assertion_id
                        AND event_commit.commit_sequence <= ?
                      ORDER BY event_commit.commit_sequence DESC, event.rowid DESC
                      LIMIT 1), 'observed') NOT IN ('withdrawn','superseded')
  `).run(
    cutoffSequence,
    cutoffSequence,
    cutoffSequence,
    cutoffSequence,
    cutoffSequence,
    commitId,
    cutoffSequence,
    cutoffSequence,
  );

  db.prepare(`
    INSERT INTO current_transaction_tags(
      transaction_id, tag_id, assertion_id, user_id, display_label,
      normalized_label, lifecycle, projection_commit_id)
    SELECT association.transaction_id, association.tag_id, association.assertion_id,
           assertion.producer_id, label.display_label, label.normalized_label,
           'active', ?
      FROM transaction_tag_assertion_values association
      JOIN assertions assertion ON assertion.assertion_id = association.assertion_id
      JOIN canonical_commits assertion_commit ON assertion_commit.commit_id = assertion.created_commit_id
      JOIN user_tags tag ON tag.tag_id = association.tag_id
      JOIN user_tag_label_revisions label
        ON label.tag_id = association.tag_id
       AND label.user_id = tag.user_id
      JOIN canonical_commits label_commit ON label_commit.commit_id = label.created_commit_id
     WHERE assertion.origin = 'user'
       AND assertion.field_name = 'note'
       AND assertion_commit.commit_sequence <= ?
       AND label_commit.commit_sequence <= ?
       AND label.rowid = (
         SELECT current_label.rowid
           FROM user_tag_label_revisions current_label
           JOIN canonical_commits current_label_commit
             ON current_label_commit.commit_id = current_label.created_commit_id
          WHERE current_label.tag_id = association.tag_id
            AND current_label_commit.commit_sequence <= ?
          ORDER BY current_label_commit.commit_sequence DESC, current_label.rowid DESC
          LIMIT 1
       )
       AND (
         SELECT status.lifecycle
           FROM user_tag_status_revisions status
           JOIN canonical_commits status_commit ON status_commit.commit_id = status.created_commit_id
          WHERE status.tag_id = association.tag_id
            AND status_commit.commit_sequence <= ?
          ORDER BY status_commit.commit_sequence DESC, status.rowid DESC
          LIMIT 1
       ) = 'active'
       AND COALESCE((SELECT event_kind
                       FROM assertion_transitions event
                       JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id
                      WHERE event.assertion_id = association.assertion_id
                        AND event_commit.commit_sequence <= ?
                      ORDER BY event_commit.commit_sequence DESC, event.rowid DESC
                      LIMIT 1), 'observed') NOT IN ('withdrawn','superseded')
  `).run(commitId, cutoffSequence, cutoffSequence, cutoffSequence, cutoffSequence, cutoffSequence);
}
