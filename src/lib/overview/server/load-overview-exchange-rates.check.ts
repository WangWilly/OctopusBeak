import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedgerDatabase } from "../../../ledger/db/client.ts";
import { seedMockLedger } from "../../../ledger/seed-mock-ledger-db.ts";
import { loadOverview } from "./load-overview.ts";

const ledgerDir = await mkdtemp(join(tmpdir(), "overview-exchange-rates-"));
try {
  seedMockLedger(ledgerDir, new Date("2026-07-11T04:00:00.000Z"));
  const db = openLedgerDatabase(ledgerDir);
  const insert = db.prepare(`
    INSERT INTO exchange_rates
      (rate_date, currency, twd_per_unit, source, fetched_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const [date, currency] of [
    ["2026-06-03", "USD"],
    ["2026-06-04", "USD"],
    ["2026-07-11", "USD"],
    ["2026-07-12", "USD"],
    ["2026-06-04", "AUD"],
  ]) insert.run(date, currency, 32, "frankfurter-v2", "2026-07-12T00:00:00.000Z");
  db.close();

  const overview = await loadOverview(ledgerDir);
  assert.deepEqual(overview.exchangeRates, [
    { rateDate: "2026-06-03", currency: "USD", twdPerUnit: 32 },
    { rateDate: "2026-06-04", currency: "USD", twdPerUnit: 32 },
    { rateDate: "2026-07-11", currency: "USD", twdPerUnit: 32 },
  ]);
  assert.equal(overview.latestExchangeRateDate, "2026-07-11");
} finally {
  await rm(ledgerDir, { recursive: true, force: true });
}
