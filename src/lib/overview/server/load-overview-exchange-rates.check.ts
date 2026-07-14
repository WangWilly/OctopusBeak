import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import { loadOverview } from "./load-overview.ts";

const ledgerDir = await mkdtemp(join(tmpdir(), "overview-exchange-rates-"));
try {
  const db = openLedgerDatabase(ledgerDir);
  db.prepare(`
    INSERT INTO exchange_rates
      (rate_date, currency, twd_per_unit, source, fetched_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    "2026-07-11",
    "USD",
    32,
    "frankfurter-v2",
    "2026-07-12T00:00:00.000Z",
  );
  db.close();

  const overview = await loadOverview(ledgerDir);
  assert.deepEqual(overview.exchangeRates, [
    { rateDate: "2026-07-11", currency: "USD", twdPerUnit: 32 },
  ]);
  assert.equal(overview.latestExchangeRateDate, "2026-07-11");
} finally {
  await rm(ledgerDir, { recursive: true, force: true });
}
