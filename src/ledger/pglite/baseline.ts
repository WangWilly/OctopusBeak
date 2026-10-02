import { PGlite } from "@electric-sql/pglite";
import { PGLITE_BASELINE_SQL } from "./baseline-sql.ts";
import {
  PGLITE_OCCURRENCE_GROUP_OBJECT_COUNTS,
  PGLITE_OCCURRENCE_GROUP_SQL,
} from "./occurrence-group-sql.ts";
import { PGLITE_SPENDING_PAIRING_PROJECTION_OBJECTS } from "./pairing-projection-sql.ts";
import {
  PGLITE_ATTESTATION_TABLES,
  PGLITE_ATTESTATION_TRIGGER_NAMES,
} from "./attestation-sql.ts";
import type { PGliteStore } from "./transaction.ts";

/** The first PGlite schema is a consolidated, fresh-start baseline. */
export const PGLITE_BASELINE_VERSION = 2;
export const CANONICAL_SQLITE_SCHEMA_VERSION = 28;

/**
 * The generator checks this digest against the reviewed canonical schema
 * before producing baseline-sql.ts. Runtime initialization only executes the
 * committed PostgreSQL baseline and never opens a SQLite source database.
 */
export const CANONICAL_SQLITE_SCHEMA_SIGNATURE =
  "faa2f18e00dc585cf6ce078d05141ef9d700de650f40f9bace1e17fffbd827ce";

const EXPECTED_OBJECT_COUNTS = Object.freeze({
  table: 121 + PGLITE_OCCURRENCE_GROUP_OBJECT_COUNTS.table,
  index: 98 + PGLITE_OCCURRENCE_GROUP_OBJECT_COUNTS.index,
  trigger: 96 + PGLITE_OCCURRENCE_GROUP_OBJECT_COUNTS.trigger,
  view: 9,
  foreignKey: 439 + PGLITE_OCCURRENCE_GROUP_OBJECT_COUNTS.foreignKey,
});

export type PGliteBaselineManifest = {
  readonly baselineVersion: number;
  readonly canonicalSchemaVersion: number;
  readonly canonicalSchemaSignature: string;
  readonly objectCounts: Readonly<typeof EXPECTED_OBJECT_COUNTS>;
  readonly invariantTriggerCount: number;
  readonly derivedProjectionObjects: typeof PGLITE_SPENDING_PAIRING_PROJECTION_OBJECTS;
  readonly attestationTables: typeof PGLITE_ATTESTATION_TABLES;
  readonly attestationTriggerNames: typeof PGLITE_ATTESTATION_TRIGGER_NAMES;
};

export const PGLITE_BASELINE_MANIFEST: PGliteBaselineManifest = Object.freeze({
  baselineVersion: PGLITE_BASELINE_VERSION,
  canonicalSchemaVersion: CANONICAL_SQLITE_SCHEMA_VERSION,
  canonicalSchemaSignature: CANONICAL_SQLITE_SCHEMA_SIGNATURE,
  objectCounts: EXPECTED_OBJECT_COUNTS,
  invariantTriggerCount: EXPECTED_OBJECT_COUNTS.trigger + PGLITE_ATTESTATION_TRIGGER_NAMES.length,
  derivedProjectionObjects: PGLITE_SPENDING_PAIRING_PROJECTION_OBJECTS,
  attestationTables: PGLITE_ATTESTATION_TABLES,
  attestationTriggerNames: PGLITE_ATTESTATION_TRIGGER_NAMES,
});

export { PGLITE_BASELINE_SQL } from "./baseline-sql.ts";

export async function applyPgliteBaseline(database: PGlite): Promise<void> {
  const installed = await database.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'pglite_baseline_metadata') AS exists",
  );
  if (installed.rows[0]?.exists) {
    await assertPgliteBaseline(database);
    return;
  }
  await database.transaction(async (transaction) => {
    await transaction.exec(PGLITE_BASELINE_SQL);
    await transaction.exec(PGLITE_OCCURRENCE_GROUP_SQL);
    await transaction.query(
      `UPDATE pglite_baseline_metadata
          SET baseline_version = $1,
              table_count = $2,
              index_count = $3,
              trigger_count = $4,
              view_count = $5,
              foreign_key_count = $6
        WHERE singleton_id = 1`,
      [
        PGLITE_BASELINE_VERSION,
        EXPECTED_OBJECT_COUNTS.table,
        EXPECTED_OBJECT_COUNTS.index,
        EXPECTED_OBJECT_COUNTS.trigger,
        EXPECTED_OBJECT_COUNTS.view,
        EXPECTED_OBJECT_COUNTS.foreignKey,
      ],
    );
  });
  await assertPgliteBaseline(database);
}

export async function assertPgliteBaseline(
  database: Pick<PGliteStore, "query"> | PGlite,
): Promise<void> {
  const metadata = await database.query<{
    baseline_version: number | string;
    canonical_schema_version: number | string;
    canonical_schema_signature: string;
    table_count: number | string;
    index_count: number | string;
    trigger_count: number | string;
    view_count: number | string;
    foreign_key_count: number | string;
  }>(
    "SELECT baseline_version, canonical_schema_version, canonical_schema_signature, table_count, index_count, trigger_count, view_count, foreign_key_count FROM pglite_baseline_metadata WHERE singleton_id = 1",
  );
  const row = metadata.rows[0];
  if (!row) throw new Error("PGlite baseline metadata is missing.");
  const numeric = (value: number | string): number => Number(value);
  if (
    numeric(row.baseline_version) !== PGLITE_BASELINE_VERSION ||
    numeric(row.canonical_schema_version) !== CANONICAL_SQLITE_SCHEMA_VERSION ||
    row.canonical_schema_signature !== CANONICAL_SQLITE_SCHEMA_SIGNATURE ||
    numeric(row.table_count) !== EXPECTED_OBJECT_COUNTS.table ||
    numeric(row.index_count) !== EXPECTED_OBJECT_COUNTS.index ||
    numeric(row.trigger_count) !== EXPECTED_OBJECT_COUNTS.trigger ||
    numeric(row.view_count) !== EXPECTED_OBJECT_COUNTS.view ||
    numeric(row.foreign_key_count) !== EXPECTED_OBJECT_COUNTS.foreignKey
  ) {
    throw new Error("PGlite baseline metadata does not match its known manifest.");
  }
  const [tables, indexes, triggers, views, foreignKeys] = await Promise.all([
    database.query<{ count: number | string }>(
      "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'",
    ),
    database.query<{ count: number | string }>(
      "SELECT COUNT(*) AS count FROM pg_class WHERE relkind = 'i' AND relnamespace = current_schema()::regnamespace",
    ),
    database.query<{ count: number | string }>(
      "SELECT COUNT(*) AS count FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = current_schema()::regnamespace)",
    ),
    database.query<{ count: number | string }>(
      "SELECT COUNT(*) AS count FROM information_schema.views WHERE table_schema = current_schema()",
    ),
    database.query<{ count: number | string }>(
      "SELECT COUNT(*) AS count FROM pg_constraint WHERE contype = 'f' AND connamespace = current_schema()::regnamespace",
    ),
  ]);
  if (
    numeric(tables.rows[0]?.count ?? -1) < EXPECTED_OBJECT_COUNTS.table ||
    numeric(indexes.rows[0]?.count ?? -1) < EXPECTED_OBJECT_COUNTS.index ||
    numeric(triggers.rows[0]?.count ?? -1) < EXPECTED_OBJECT_COUNTS.trigger ||
    numeric(views.rows[0]?.count ?? -1) < EXPECTED_OBJECT_COUNTS.view ||
    numeric(foreignKeys.rows[0]?.count ?? -1) < EXPECTED_OBJECT_COUNTS.foreignKey
  ) {
    throw new Error("PGlite baseline object inventory is incomplete.");
  }
}
