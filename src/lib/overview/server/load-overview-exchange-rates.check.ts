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
  assert.deepEqual(overview.exchangeRates, []);
  assert.equal(overview.latestExchangeRateDate, null);
  assert.deepEqual(overview.sankeyExchangeRates, []);
  assert.equal(overview.sankeyLatestExchangeRateDate, null);
  assert.equal(overview.availability, "awaiting");
  assert.equal(overview.historyAvailability, "unavailable");
  assert.equal(overview.sankey, null);
} finally {
  await rm(ledgerDir, { recursive: true, force: true });
}
