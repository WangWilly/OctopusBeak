import { openLedgerDatabase } from "../src/ledger/db/client.ts";

export function migrateLedgerBeforeWindow(
  ledgerDir = process.env.OCTOPUSBEAK_LEDGER_DIR,
  seams: {
    beforeOpen: () => void;
    open: (dir?: string) => { close: () => void };
  } = {
    beforeOpen: () => {},
    open: (dir?: string) => openLedgerDatabase(dir),
  },
) {
  seams.beforeOpen();
  const db = seams.open(ledgerDir);
  db.close();
}
