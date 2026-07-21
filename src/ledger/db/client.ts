import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "./schema.ts";
import { migrateLedgerDb } from "./migrations.ts";

export const SQLITE_LEDGER_FILE = "ledger.sqlite";
export const DEFAULT_LEDGER_DIR = process.env.LEDGER_DIR ?? "data/ledger";
const SQLITE_BUSY_TIMEOUT_MS = 30_000;
export type LedgerDatabase = InstanceType<typeof DatabaseSync>;

export function ledgerSqlitePath(ledgerDir = DEFAULT_LEDGER_DIR) {
  return join(ledgerDir, SQLITE_LEDGER_FILE);
}

export function openLedgerDatabase(
  ledgerDir = DEFAULT_LEDGER_DIR,
  options: { migrate?: boolean; readOnly?: boolean } = {},
): LedgerDatabase {
  const sqlitePath = ledgerSqlitePath(ledgerDir);
  if (options.readOnly && !existsSync(sqlitePath)) {
    throw new Error(`Missing SQLite ledger: ${sqlitePath}`);
  }
  if (!options.readOnly) mkdirSync(ledgerDir, { recursive: true });

  const db = options.readOnly
    ? new DatabaseSync(sqlitePath, { readOnly: true })
    : new DatabaseSync(sqlitePath);
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA foreign_keys = ON");
  if (!options.readOnly) {
    db.exec("PRAGMA journal_mode = WAL");
    if (options.migrate !== false) migrateLedgerDb(db);
  }
  return db;
}

export function openLedgerDrizzle(ledgerDir = DEFAULT_LEDGER_DIR) {
  const sqlite = openLedgerDatabase(ledgerDir);
  return {
    sqlite,
    db: drizzle(async (sql, params, method) => {
      const statement = sqlite.prepare(sql);
      if (method === "run") {
        const result = statement.run(...params);
        return { rows: [result] };
      }
      if (method === "get") {
        const row = statement.get(...params);
        return { rows: row ? Object.values(row) : undefined as unknown as unknown[] };
      }
      const rows = statement.all(...params) as Record<string, unknown>[];
      return { rows: rows.map((row) => Object.values(row)) };
    }, { schema }),
  };
}
