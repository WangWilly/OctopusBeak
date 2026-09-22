import { createHash } from "node:crypto";
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

export type SqliteToPgliteTableReport = {
  name: string;
  rowCount: number;
  sourceDigest: string;
  targetDigest: string;
};

export type SqliteToPgliteMigrationReport = {
  tables: readonly SqliteToPgliteTableReport[];
  /** No source table is silently omitted by this migration primitive. */
  omittedTables: readonly [];
};

type SqliteColumn = { name: string; type: string; pk: number };
type Row = Record<string, unknown>;

function quotedIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error(`Invalid migration identifier: ${value}`);
  return `"${value}"`;
}

function canonicalValue(value: unknown, declaredType: string): string {
  if (value === null) return "null";
  const type = declaredType.toUpperCase();
  if (/(?:INT|NUMERIC|DECIMAL|REAL|FLOA|DOUB)/u.test(type)) {
    if (typeof value === "bigint") return `number:${value.toString()}`;
    if (typeof value === "number") return `number:${value.toString()}`;
    if (typeof value === "string" && /^[-+]?\d+(?:\.\d+)?$/u.test(value)) {
      return `number:${Number(value).toString()}`;
    }
  }
  if (typeof value === "string") return `string:${value}`;
  if (typeof value === "number") return `number:${value.toString()}`;
  if (typeof value === "bigint") return `number:${value.toString()}`;
  if (value instanceof Uint8Array) return `bytes:${Buffer.from(value).toString("base64")}`;
  if (value instanceof ArrayBuffer) return `bytes:${Buffer.from(value).toString("base64")}`;
  return `json:${JSON.stringify(value)}`;
}

function digestRows(rows: Iterable<Row>, columns: readonly SqliteColumn[]): SqliteToPgliteTableReport {
  const digest = createHash("sha256");
  let rowCount = 0;
  for (const row of rows) {
    rowCount++;
    for (const column of columns) {
      const value = canonicalValue(row[column.name], column.type);
      digest.update(`${value.length}:`);
      digest.update(value);
      digest.update(";");
    }
    digest.update("\n");
  }
  return { name: "", rowCount, sourceDigest: digest.digest("hex"), targetDigest: "" };
}

function orderBy(columns: readonly SqliteColumn[]): string {
  const primaryKey = columns
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk);
  const orderedColumns = primaryKey.length > 0 ? primaryKey : columns;
  return orderedColumns
    .map((column) => `${quotedIdentifier(column.name)} ASC NULLS FIRST`)
    .join(", ");
}

/** Build the target off to the side and publish it only after all requested rows are copied. */
export async function migrateSqliteToPglite(
  input: SqliteToPgliteMigration,
): Promise<SqliteToPgliteMigrationReport> {
  if (existsSync(input.targetDir)) throw new Error("PGlite target already exists");
  if (new Set(input.tables).size !== input.tables.length) {
    throw new Error("Duplicate migration table");
  }
  const source = new DatabaseSync(input.sourcePath, { readOnly: true });
  let stagingDir: string | undefined;
  let target: PGlite | undefined;
  const reports: SqliteToPgliteTableReport[] = [];
  let sourceTransaction = false;
  try {
    source.exec("BEGIN");
    sourceTransaction = true;
    const sourceTables = source.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as { name: string }[];
    const copied = new Set(input.tables.map(quotedIdentifier));
    const unclassified = sourceTables.map(({ name }) => name).filter((name) =>
      !copied.has(quotedIdentifier(name)));
    if (unclassified.length > 0) throw new Error(`Unclassified source tables: ${unclassified.join(", ")}`);
    stagingDir = await mkdtemp(join(dirname(input.targetDir), ".pglite-migration-"));
    target = await PGlite.create(stagingDir);
    await target.exec(input.baselineSql);
    for (const table of input.tables) {
      const quotedTable = quotedIdentifier(table);
      const columns = source.prepare(`PRAGMA table_info(${quotedTable})`).all() as SqliteColumn[];
      if (columns.length === 0) throw new Error(`Source table is missing: ${table}`);
      const names = columns.map(({ name }) => quotedIdentifier(name));
      const placeholders = names.map((_column, index) => `$${index + 1}`);
      const insert = `INSERT INTO ${quotedTable} (${names.join(", ")}) VALUES (${placeholders.join(", ")})`;
      const select = `SELECT ${names.join(", ")} FROM ${quotedTable} ORDER BY ${orderBy(columns)}`;
      const sourceReport = digestRows(
        source.prepare(select).iterate() as Iterable<Row>,
        columns,
      );
      await target.transaction(async (transaction) => {
        for (const row of source.prepare(select).iterate() as Iterable<Row>) {
          await transaction.query(insert, columns.map(({ name }) => row[name]));
        }
      });
      const targetReport = digestRows(
        (await target.query<Row>(select)).rows,
        columns,
      );
      if (sourceReport.rowCount !== targetReport.rowCount) throw new Error(`Row count mismatch: ${table}`);
      if (sourceReport.sourceDigest !== targetReport.sourceDigest) {
        throw new Error(`Content parity mismatch: ${table}`);
      }
      reports.push({
        name: table,
        rowCount: sourceReport.rowCount,
        sourceDigest: sourceReport.sourceDigest,
        targetDigest: targetReport.sourceDigest,
      });
    }
    await target.close();
    target = undefined;
    if (existsSync(input.targetDir)) throw new Error("PGlite target appeared during migration");
    await rename(stagingDir, input.targetDir);
    return { tables: reports, omittedTables: [] };
  } finally {
    if (sourceTransaction) source.exec("ROLLBACK");
    source.close();
    if (target) await target.close();
    if (stagingDir) await rm(stagingDir, { recursive: true, force: true });
  }
}
