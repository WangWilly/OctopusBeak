/**
 * Fresh-start PGlite schema for provider human-attestation event spines.
 *
 * These tables are deliberately kept provider-specific.  The canonical
 * implementation historically used one table per provider, and keeping that
 * shape makes the cutover contract explicit while still allowing the worker
 * implementation to share one typed transaction API.
 *
 * This SQL is part of baseline initialization.  Attestation command code
 * never executes DDL or repairs a missing table at admission time.
 */

export const PGLITE_ATTESTATION_TABLES = Object.freeze([
  "ctbc_attestation_events",
  "esun_credit_card_attestation_events",
  "fubon_credit_card_attestation_events",
  "fubon_attestation_events",
  "hncb_attestation_events",
  "post_attestation_events",
  "sinopac_attestation_events",
  "yuanta_credit_card_attestation_events",
  "yuanta_attestation_events",
] as const);

export type PGliteAttestationTableName =
  (typeof PGLITE_ATTESTATION_TABLES)[number];

export const PGLITE_ATTESTATION_TRIGGER_FUNCTION =
  "pglite_attestation_append_only_guard" as const;
export const PGLITE_ATTESTATION_TRIGGER_NAMES = Object.freeze(
  PGLITE_ATTESTATION_TABLES.map((table) => `trg_${table}_append_only`),
);

const tableSql = PGLITE_ATTESTATION_TABLES.map((table) => {
  const index = `idx_${table}_latest`;
  const trigger = `trg_${table}_append_only`;
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  event_id BYTEA PRIMARY KEY CHECK(length(event_id) = 16),
  attestation_id TEXT NOT NULL CHECK(length(btrim(attestation_id)) > 0),
  evidence_version TEXT NOT NULL CHECK(length(btrim(evidence_version)) > 0),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('attested','revoked','restored')),
  manifest_status TEXT NOT NULL CHECK(manifest_status IN ('active','revoked')),
  event_at TEXT NOT NULL CHECK(length(btrim(event_at)) > 0),
  reason TEXT,
  manifest_fingerprint TEXT NOT NULL CHECK(manifest_fingerprint LIKE 'sha256:%'),
  event_sequence BIGINT NOT NULL CHECK(event_sequence > 0),
  CHECK(
    (event_kind = 'attested' AND manifest_status = 'active') OR
    (event_kind = 'revoked' AND manifest_status = 'revoked' AND reason IS NOT NULL AND length(btrim(reason)) > 0) OR
    (event_kind = 'restored' AND manifest_status = 'active' AND reason IS NOT NULL AND length(btrim(reason)) > 0)
  ),
  UNIQUE(attestation_id, event_sequence)
);
CREATE INDEX IF NOT EXISTS ${index}
  ON ${table}(attestation_id, event_sequence, event_at, event_id);
DROP TRIGGER IF EXISTS ${trigger} ON ${table};
CREATE TRIGGER ${trigger}
  BEFORE UPDATE OR DELETE ON ${table}
  FOR EACH ROW EXECUTE FUNCTION pglite_attestation_append_only_guard();`;
}).join("\n");

/** The reviewed, idempotent initialization SQL consumed by the PGlite baseline. */
export const PGLITE_ATTESTATION_SQL: string = String.raw`
CREATE OR REPLACE FUNCTION ${PGLITE_ATTESTATION_TRIGGER_FUNCTION}()
RETURNS trigger
LANGUAGE plpgsql
AS $pglite_attestation_guard$
BEGIN
  RAISE EXCEPTION 'Human-attestation event spines are append-only.';
END;
$pglite_attestation_guard$;
${tableSql}
`;
