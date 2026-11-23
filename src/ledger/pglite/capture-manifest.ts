import { applyOperationalMigrations } from "./operational-migrations.ts";
import type { PGliteStore } from "./transaction.ts";

/**
 * The Source Records a Capture reused instead of storing again (ADR 0152): one
 * row per Capture, its record ids packed as 16-byte values in one `BYTEA`. A
 * Capture's records are those it owns plus those in its manifest; a Capture
 * with no row reused nothing. The rows are financial state, so a Canonical
 * Reset empties them with the records they list.
 */
export const PGLITE_CAPTURE_MANIFEST_SQL = String.raw`
CREATE TABLE capture_source_record_manifests (
  capture_id BYTEA PRIMARY KEY REFERENCES source_captures(capture_id),
  source_record_ids BYTEA NOT NULL,
  record_count INTEGER NOT NULL CHECK(record_count > 0),
  commit_id BYTEA NOT NULL REFERENCES canonical_commits(commit_id),
  CHECK(length(source_record_ids) = record_count * 16)
);
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
 * Capture that `captureId` names, owned or reused. `captureId` is an SQL
 * expression, usually an outer column, so the subquery composes as
 * `JOIN LATERAL (...) member ON TRUE` or `IN (...)`.
 */
export function captureSourceRecordIdsSql(captureId: string): string {
  return `SELECT owned.source_record_id
            FROM source_records owned
           WHERE owned.capture_id = ${captureId}
          UNION ALL
          SELECT substring(manifest.source_record_ids FROM slot * 16 + 1 FOR 16)
            FROM capture_source_record_manifests manifest
            CROSS JOIN generate_series(0, manifest.record_count - 1) AS slot
           WHERE manifest.capture_id = ${captureId}`;
}
