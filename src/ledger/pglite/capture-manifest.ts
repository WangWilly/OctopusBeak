import { applyOperationalMigrations } from "./operational-migrations.ts";
import type { PGliteStore } from "./transaction.ts";

/**
 * The Source Records a Capture reused instead of storing again (ADR 0152): one
 * row per Capture, its record ids packed as 16-byte values in one `BYTEA`. A
 * Capture's records are those it owns plus those in its manifest; a Capture
 * with no row reused nothing. The rows are financial state, so a Canonical
 * Reset empties them with the records they list.
 *
 * The packed ids carry no foreign key, so the writer must guarantee that a
 * manifest lists no id twice, lists no record whose occurrence key matches a
 * record the same Capture owns, and carries its Capture's own `commit_id`.
 *
 * Membership through a Capture's records stands for membership in its scope,
 * so the migration also pins one scope per Capture, which the generic store
 * already writes.
 */
export const PGLITE_CAPTURE_MANIFEST_SQL = String.raw`
CREATE TABLE capture_source_record_manifests (
  capture_id BYTEA PRIMARY KEY REFERENCES source_captures(capture_id),
  source_record_ids BYTEA NOT NULL,
  record_count INTEGER NOT NULL CHECK(record_count > 0),
  commit_id BYTEA NOT NULL REFERENCES canonical_commits(commit_id),
  CHECK(length(source_record_ids) = record_count * 16)
);
CREATE UNIQUE INDEX capture_scopes_one_per_capture ON capture_scopes(capture_id);
CREATE OR REPLACE FUNCTION capture_source_record_manifests_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND canonical_purge_delete_allowed() <> 0 THEN RETURN OLD; END IF;
  RAISE EXCEPTION '%', 'Capture source record manifests are append-only';
END
$$;
CREATE TRIGGER capture_source_record_manifests_append_only
  BEFORE UPDATE OR DELETE ON capture_source_record_manifests
  FOR EACH ROW EXECUTE FUNCTION capture_source_record_manifests_append_only();
`;

export const CAPTURE_MANIFEST_TABLES = ["capture_source_record_manifests"] as const;

const CAPTURE_MANIFEST_MIGRATIONS = [{ id: "capture-source-record-manifests-v1", sql: PGLITE_CAPTURE_MANIFEST_SQL }] as const;

export function applyPgliteCaptureManifestSchema(store: PGliteStore): Promise<void> {
  return applyOperationalMigrations(store, "Capture manifests", CAPTURE_MANIFEST_MIGRATIONS, CAPTURE_MANIFEST_TABLES);
}

/**
 * A subquery of one `source_record_id` column: the Source Records of the
 * Capture that `captureId` names, owned or reused. Both arguments are SQL
 * expressions, usually an outer column or a parameter, so the subquery
 * composes as `JOIN LATERAL (...) member ON TRUE` or `IN (...)`. With
 * `occurrenceKey`, each branch filters on it, so the owned branch reads the
 * `(capture_id, occurrence_key)` index instead of the whole capture.
 */
export function captureSourceRecordIdsSql(captureId: string, occurrenceKey?: string): string {
  const owned = `SELECT owned.source_record_id
            FROM source_records owned
           WHERE owned.capture_id = ${captureId}`;
  const listed = `(${manifestRecordIdsSql(`capture_id = ${captureId}`)}) listed`;
  return occurrenceKey
    ? `${owned} AND owned.occurrence_key = ${occurrenceKey}
          UNION ALL
          SELECT reused.source_record_id
            FROM ${listed}
            JOIN source_records reused ON reused.source_record_id = listed.source_record_id
           WHERE reused.occurrence_key = ${occurrenceKey}`
    : `${owned}
          UNION ALL
          SELECT listed.source_record_id
            FROM ${listed}`;
}

/**
 * One row per record a manifest lists, as `capture_id` and
 * `source_record_id`, for the manifests matching `where`, a condition on the
 * table's own columns.
 *
 * Each manifest's packed ids are read into memory once, by the inner query:
 * `OFFSET 0` keeps the planner from merging it into the outer one, and the
 * concatenation yields a value held in memory. A manifest of more than about
 * a hundred records is stored out of line, and `substring` on the stored
 * column fetches a slice of it from the TOAST table for every record listed.
 */
export function manifestRecordIdsSql(where: string): string {
  return `SELECT manifest.capture_id, substring(manifest.packed_ids FROM slot * 16 + 1 FOR 16) AS source_record_id
            FROM (SELECT capture_id, source_record_ids || ''::bytea AS packed_ids, record_count
                    FROM capture_source_record_manifests
                   WHERE ${where}
                  OFFSET 0) manifest
           CROSS JOIN generate_series(0, manifest.record_count - 1) AS slot`;
}

/**
 * `captureSourceRecordIdsSql` with each record's row: `member_id`, the id as
 * the Capture owns or lists it, then every `source_records` column, all NULL
 * for a listed record that is not stored. An owned record is read once, where
 * it is found, not looked up again by its id.
 */
export function captureSourceRecordsSql(captureId: string): string {
  return `SELECT owned.source_record_id AS member_id, owned.*
            FROM source_records owned
           WHERE owned.capture_id = ${captureId}
          UNION ALL
          SELECT listed.source_record_id AS member_id, reused.*
            FROM (${manifestRecordIdsSql(`capture_id = ${captureId}`)}) listed
            LEFT JOIN source_records reused ON reused.source_record_id = listed.source_record_id`;
}
