import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedgerDatabase } from "./db/client.ts";
import {
  readExchangeRates,
  requiredExchangeRateCurrencies,
  syncExchangeRates,
} from "./exchange-rates.ts";
import type { DailyHistoryRowDto } from "../lib/shared-ledger/types.ts";

const ledgerDir = await mkdtemp(join(tmpdir(), "exchange-rates-"));
const history: DailyHistoryRowDto[] = [{
  date: "2026-07-12",
  netAssets: [
    { currency: "TWD", value: 3200 },
    { currency: "USD", value: 100 },
  ],
  dailyChange: [{ currency: "USD", value: 5 }],
  assets: [{ currency: "USD", value: 100 }],
  liabilities: [{ currency: "JPY", value: 1000 }],
  accountChanges: [],
  positionCount: 2,
}];

try {
  assert.deepEqual(requiredExchangeRateCurrencies(history), ["JPY", "USD"]);

  const validFetch: typeof fetch = async () => new Response(JSON.stringify([
    { date: "2026-07-11", base: "TWD", quote: "JPY", rate: 5 },
    { date: "2026-07-11", base: "TWD", quote: "USD", rate: 0.03125 },
    { date: "2026-07-11", base: "TWD", quote: "EUR", rate: 0.027 },
  ]), { status: 200, headers: { "content-type": "application/json" } });

  const result = await syncExchangeRates(ledgerDir, history, {
    fetchImpl: validFetch,
    now: () => new Date("2026-07-12T12:00:00.000Z"),
  });
  assert.equal(result.written, 2);

  const db = openLedgerDatabase(ledgerDir);
  const rates = readExchangeRates(db);
  assert.deepEqual(rates, [
    {
      rateDate: "2026-07-11",
      currency: "JPY",
      twdPerUnit: 0.2,
      source: "frankfurter-v2",
      fetchedAt: "2026-07-12T12:00:00.000Z",
    },
    {
      rateDate: "2026-07-11",
      currency: "USD",
      twdPerUnit: 32,
      source: "frankfurter-v2",
      fetchedAt: "2026-07-12T12:00:00.000Z",
    },
  ]);
  assert.equal(rates.some((rate) => rate.currency === "EUR"), false);
  db.close();

  const invalidFetch: typeof fetch = async () => new Response(JSON.stringify([
    { date: "2026-07-12", base: "TWD", quote: "USD", rate: 0 },
  ]), { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(
    syncExchangeRates(ledgerDir, history, {
      fetchImpl: invalidFetch,
      now: () => new Date("2026-07-12T18:00:00.000Z"),
    }),
  );

  const unchangedDb = openLedgerDatabase(ledgerDir, { readOnly: true });
  assert.equal(readExchangeRates(unchangedDb).length, 2);
  unchangedDb.close();
} finally {
  await rm(ledgerDir, { recursive: true, force: true });
}
