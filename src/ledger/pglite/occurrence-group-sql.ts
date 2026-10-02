/** PGlite-owned occurrence-group proof tables installed with the fresh baseline. */
export const PGLITE_OCCURRENCE_GROUP_SQL = String.raw`
ALTER TABLE source_records
  ADD COLUMN occurrence_group_scope_key TEXT,
  ADD COLUMN occurrence_group_fingerprint TEXT,
  ADD COLUMN occurrence_group_partition_date DATE,
  ADD COLUMN occurrence_group_ordinal BIGINT,
  ADD COLUMN occurrence_group_bucket_key TEXT,
  ADD CONSTRAINT ck_source_records_occurrence_group_complete CHECK (
    (
      occurrence_group_scope_key IS NULL AND
      occurrence_group_fingerprint IS NULL AND
      occurrence_group_partition_date IS NULL AND
      occurrence_group_ordinal IS NULL AND
      occurrence_group_bucket_key IS NULL
    ) OR (
      occurrence_group_scope_key IS NOT NULL AND
      occurrence_group_fingerprint IS NOT NULL AND
      occurrence_group_partition_date IS NOT NULL AND
      occurrence_group_ordinal IS NOT NULL AND
      occurrence_group_scope_key ~ '^sha256:[A-Za-z0-9_-]+$' AND
      occurrence_group_fingerprint ~ '^sha256:[A-Za-z0-9_-]+$' AND
      (occurrence_group_bucket_key IS NULL OR occurrence_group_bucket_key <> '') AND
      occurrence_group_ordinal > 0
    )
  );

CREATE TABLE source_occurrence_group_coverages (
  coverage_id BYTEA PRIMARY KEY CHECK(length(coverage_id) = 16),
  capture_id BYTEA NOT NULL CHECK(length(capture_id) = 16),
  source_subject_id BYTEA NOT NULL CHECK(length(source_subject_id) = 16),
  record_kind TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  scope_start DATE NOT NULL,
  scope_end DATE NOT NULL,
  contract_version TEXT NOT NULL,
  bucket_inventory_json TEXT,
  commit_id BYTEA NOT NULL CHECK(length(commit_id) = 16),
  CHECK(scope_start <= scope_end),
  UNIQUE(capture_id, scope_key, scope_start, scope_end, contract_version),
  CONSTRAINT fk_source_occurrence_group_coverages_capture
    FOREIGN KEY(capture_id) REFERENCES source_captures(capture_id),
  CONSTRAINT fk_source_occurrence_group_coverages_subject
    FOREIGN KEY(source_subject_id) REFERENCES source_subjects(source_subject_id),
  CONSTRAINT fk_source_occurrence_group_coverages_commit
    FOREIGN KEY(commit_id) REFERENCES canonical_commits(commit_id)
);

CREATE TABLE source_occurrence_group_counts (
  observation_id BYTEA PRIMARY KEY CHECK(length(observation_id) = 16),
  coverage_id BYTEA NOT NULL,
  partition_date DATE NOT NULL,
  fingerprint TEXT NOT NULL,
  bucket_key TEXT NOT NULL DEFAULT '',
  occurrence_count BIGINT NOT NULL CHECK(occurrence_count > 0),
  UNIQUE(coverage_id, partition_date, fingerprint, bucket_key),
  CONSTRAINT fk_source_occurrence_group_counts_coverage
    FOREIGN KEY(coverage_id) REFERENCES source_occurrence_group_coverages(coverage_id)
);

CREATE INDEX idx_source_occurrence_group_coverages_lookup
  ON source_occurrence_group_coverages(
    source_subject_id, record_kind, scope_key, contract_version, scope_start, scope_end
  );

INSERT INTO pglite_invariant_manifest(object_name, object_type, target_name, enforcement)
VALUES
  ('source_occurrence_group_coverages_no_delete', 'trigger', 'source_occurrence_group_coverages', 'postgres-trigger'),
  ('source_occurrence_group_coverages_no_update', 'trigger', 'source_occurrence_group_coverages', 'postgres-trigger'),
  ('source_occurrence_group_counts_no_delete', 'trigger', 'source_occurrence_group_counts', 'postgres-trigger'),
  ('source_occurrence_group_counts_no_update', 'trigger', 'source_occurrence_group_counts', 'postgres-trigger')
ON CONFLICT (object_name) DO UPDATE SET
  object_type = EXCLUDED.object_type,
  target_name = EXCLUDED.target_name,
  enforcement = EXCLUDED.enforcement;

CREATE OR REPLACE FUNCTION pglite_guard_source_occurrence_group_coverages_no_delete()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF canonical_purge_delete_allowed() = 0 THEN
    RAISE EXCEPTION '%', 'Source occurrence group coverage is append-only';
  END IF;
  RETURN OLD;
END;
$pglite$;
CREATE TRIGGER source_occurrence_group_coverages_no_delete
  BEFORE DELETE ON source_occurrence_group_coverages
  FOR EACH ROW EXECUTE FUNCTION pglite_guard_source_occurrence_group_coverages_no_delete();

CREATE OR REPLACE FUNCTION pglite_guard_source_occurrence_group_coverages_no_update()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  RAISE EXCEPTION '%', 'Source occurrence group coverage is immutable';
END;
$pglite$;
CREATE TRIGGER source_occurrence_group_coverages_no_update
  BEFORE UPDATE ON source_occurrence_group_coverages
  FOR EACH ROW EXECUTE FUNCTION pglite_guard_source_occurrence_group_coverages_no_update();

CREATE OR REPLACE FUNCTION pglite_guard_source_occurrence_group_counts_no_delete()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF canonical_purge_delete_allowed() = 0 THEN
    RAISE EXCEPTION '%', 'Source occurrence group counts are append-only';
  END IF;
  RETURN OLD;
END;
$pglite$;
CREATE TRIGGER source_occurrence_group_counts_no_delete
  BEFORE DELETE ON source_occurrence_group_counts
  FOR EACH ROW EXECUTE FUNCTION pglite_guard_source_occurrence_group_counts_no_delete();

CREATE OR REPLACE FUNCTION pglite_guard_source_occurrence_group_counts_no_update()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  RAISE EXCEPTION '%', 'Source occurrence group counts are immutable';
END;
$pglite$;
CREATE TRIGGER source_occurrence_group_counts_no_update
  BEFORE UPDATE ON source_occurrence_group_counts
  FOR EACH ROW EXECUTE FUNCTION pglite_guard_source_occurrence_group_counts_no_update();
`;

/** Inventory added by the fresh-baseline occurrence-group extension. */
export const PGLITE_OCCURRENCE_GROUP_OBJECT_COUNTS = Object.freeze({
  table: 2,
  index: 5,
  trigger: 4,
  foreignKey: 4,
});
