import { openLedgerDatabase } from "./db/client.ts";

function main() {
  const db = openLedgerDatabase("data/ledger");
  db.close();
  console.log("ledger migrations applied");
}

main();
