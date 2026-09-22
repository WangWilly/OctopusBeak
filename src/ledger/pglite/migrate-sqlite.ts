import { existsSync } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";

export type SqliteToPgliteMigration = {
  sourcePath: string;
  targetDir: string;
  baselineSql: string;
  tables: readonly string[];
};

function quotedIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error(`Invalid migration identifier: ${value}`);
  return `"${value}"`;
}

/** Build the target off to the side and publish it only after all requested rows are copied. */
export async function migrateSqliteToPglite(input: SqliteToPgliteMigration): Promise<void> {
  if (existsSync(input.targetDir)) throw new Error("PGlite target already exists");
  const source = new DatabaseSync(input.sourcePath, { readOnly: true });
  const stagingDir = await mkdtemp(join(dirname(input.targetDir), ".pglite-migration-"));
  let target: PGlite | undefined;
  try {
    target = await PGlite.create(stagingDir);
    await target.exec(input.baselineSql);
    for (const table of input.tables) {
      const quotedTable = quotedIdentifier(table);
      const columns = source.prepare(`PRAGMA table_info(${quotedTable})`).all() as { name: string }[];
      if (columns.length === 0) throw new Error(`Source table is missing: ${table}`);
      const names = columns.map(({ name }) => quotedIdentifier(name));
      const placeholders = names.map((_column, index) => `$${index + 1}`);
      const insert = `INSERT INTO ${quotedTable} (${names.join(", ")}) VALUES (${placeholders.join(", ")})`;
      const rows = source.prepare(`SELECT ${names.join(", ")} FROM ${quotedTable}`).all() as Record<string, unknown>[];
      await target.transaction(async (transaction) => {
        for (const row of rows) await transaction.query(insert, columns.map(({ name }) => row[name]));
      });
      const result = await target.query<{ count: number }>(`SELECT count(*)::integer AS count FROM ${quotedTable}`);
      if (result.rows[0]?.count !== rows.length) throw new Error(`Row count mismatch: ${table}`);
    }
    await target.close();
    target = undefined;
    if (existsSync(input.targetDir)) throw new Error("PGlite target appeared during migration");
    await rename(stagingDir, input.targetDir);
  } finally {
    source.close();
    if (target) await target.close();
    await rm(stagingDir, { recursive: true, force: true });
  }
}
