import { createHash } from "node:crypto";
import type { PGliteStore } from "./transaction.ts";

export type OperationalMigration = Readonly<{ id: string; sql: string }>;

const signature = (sql: string) => createHash("sha256").update(sql).digest("hex");

/**
 * Applies additive schema steps recorded in `pglite_operational_migrations`,
 * each once and in order. A recorded step whose SQL changed fails rather than
 * running twice, and tables that exist without the first step's record fail
 * rather than being adopted.
 */
export async function applyOperationalMigrations(
  store: PGliteStore,
  label: string,
  migrations: readonly OperationalMigration[],
  tables: readonly string[],
): Promise<void> {
  await store.transaction(async (transaction) => {
    await transaction.exec(`CREATE TABLE IF NOT EXISTS pglite_operational_migrations (
      migration_key TEXT PRIMARY KEY,
      schema_signature TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    for (const [index, migration] of migrations.entries()) {
      const installed = await transaction.query<{ schema_signature: string }>(
        "SELECT schema_signature FROM pglite_operational_migrations WHERE migration_key=$1",
        [migration.id],
      );
      if (installed.rows[0]) {
        if (installed.rows[0].schema_signature !== signature(migration.sql))
          throw new Error(`${label} migration signature has changed: ${migration.id}`);
        continue;
      }
      if (index === 0) {
        const prior = await transaction.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
          [tables],
        );
        if (prior.rows.length > 0) throw new Error(`${label} tables exist without a migration record.`);
      }
      await transaction.exec(migration.sql);
      await transaction.query(
        "INSERT INTO pglite_operational_migrations(migration_key, schema_signature) VALUES ($1, $2)",
        [migration.id, signature(migration.sql)],
      );
    }
  });
}
