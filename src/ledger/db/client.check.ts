import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedgerDatabase } from "./client.ts";

const ledgerDir = mkdtempSync(join(tmpdir(), "ledger-db-client-"));

try {
  const db = openLedgerDatabase(ledgerDir);
  const busyTimeout = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
  assert.ok(busyTimeout.timeout >= 5000);
  db.close();

  const readOnlyDb = openLedgerDatabase(ledgerDir, { readOnly: true });
  const readOnlyBusyTimeout = readOnlyDb.prepare("PRAGMA busy_timeout").get() as { timeout: number };
  assert.ok(readOnlyBusyTimeout.timeout >= 5000);
  readOnlyDb.close();
} finally {
  rmSync(ledgerDir, { recursive: true, force: true });
}
