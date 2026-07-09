import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedgerDatabase } from "./client.ts";

const ledgerDir = mkdtempSync(join(tmpdir(), "ledger-db-migrations-"));

try {
  const seeded = openLedgerDatabase(ledgerDir);
  seeded.exec(`
    DROP TABLE personal_invoice_items;
    DROP TABLE personal_invoices;
    DELETE FROM schema_migrations WHERE version >= 4;
  `);
  seeded.close();

  const migrated = openLedgerDatabase(ledgerDir);
  const versions = migrated.prepare(
    "SELECT version FROM schema_migrations ORDER BY version",
  ).all() as Array<{ version: number }>;
  const invoiceColumns = migrated.prepare("PRAGMA table_info(personal_invoices)").all() as Array<{
    name: string;
  }>;
  const itemColumns = migrated.prepare("PRAGMA table_info(personal_invoice_items)").all() as Array<{
    name: string;
  }>;
  migrated.close();

  assert.deepEqual(
    versions.map((row) => row.version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.ok(invoiceColumns.some((column) => column.name === "invoice_key"));
  assert.ok(itemColumns.some((column) => column.name === "item_key"));
} finally {
  rmSync(ledgerDir, { recursive: true, force: true });
}
