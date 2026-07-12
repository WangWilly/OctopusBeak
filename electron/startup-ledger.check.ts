import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedgerDatabase } from "../src/ledger/db/client.ts";
import { migrateLedgerBeforeWindow } from "./startup-ledger.ts";

const ledgerDir = mkdtempSync(join(tmpdir(), "startup-ledger-"));

try {
  const seeded = openLedgerDatabase(ledgerDir);
  seeded.prepare("DELETE FROM schema_migrations WHERE version >= 14").run();
  seeded.close();

  const events: string[] = [];
  migrateLedgerBeforeWindow(ledgerDir, {
    open: () => ({ close: () => events.push("close") }),
    beforeOpen: () => events.push("open"),
  });
  events.push("window");
  assert.deepEqual(events, ["open", "close", "window"]);

  const failedEvents: string[] = [];
  assert.throws(
    () => migrateLedgerBeforeWindow(ledgerDir, {
      open: () => {
        throw new Error("migration failed");
      },
      beforeOpen: () => failedEvents.push("open"),
    }),
    /migration failed/,
  );
  assert.deepEqual(failedEvents, ["open"]);
} finally {
  rmSync(ledgerDir, { recursive: true, force: true });
}
