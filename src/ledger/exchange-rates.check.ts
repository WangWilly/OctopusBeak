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
import type { ExchangeRateRequest } from "./exchange-rate-requirements.ts";
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

  const request: ExchangeRateRequest = {
    requiredFrom: "2026-01-03",
    currencies: ["USD"],
  };

  const validFetch: typeof fetch = async () => new Response(JSON.stringify([
    { date: "2026-01-03", base: "TWD", quote: "USD", rate: 0.03125 },
    { date: "2026-07-12", base: "TWD", quote: "USD", rate: 0.03125 },
    { date: "2026-07-12", base: "TWD", quote: "EUR", rate: 0.027 },
  ]), { status: 200, headers: { "content-type": "application/json" } });

  const result = await syncExchangeRates(ledgerDir, request, {
    fetchImpl: validFetch,
    now: () => new Date("2026-07-12T12:00:00.000Z"),
  });
  assert.equal(result.written, 2);

  const db = openLedgerDatabase(ledgerDir);
  const rates = readExchangeRates(db);
  assert.deepEqual(rates, [
    {
      rateDate: "2026-01-03",
      currency: "USD",
      twdPerUnit: 32,
      source: "frankfurter-v2",
      fetchedAt: "2026-07-12T12:00:00.000Z",
    },
    {
      rateDate: "2026-07-12",
      currency: "USD",
      twdPerUnit: 32,
      source: "frankfurter-v2",
      fetchedAt: "2026-07-12T12:00:00.000Z",
    },
  ]);
  assert.equal(rates.some((rate) => rate.currency === "EUR"), false);
  db.close();

  let fetchCalls = 0;
  const unexpectedFetch: typeof fetch = async () => {
    fetchCalls += 1;
    throw new Error("fetch should not be called");
  };
  assert.equal((await syncExchangeRates(ledgerDir, {
    requiredFrom: null,
    currencies: [],
  }, {
    fetchImpl: unexpectedFetch,
    now: () => new Date("2026-07-12T18:00:00.000Z"),
  })).written, 0);
  assert.equal((await syncExchangeRates(ledgerDir, request, {
    fetchImpl: unexpectedFetch,
    now: () => new Date("2026-07-12T18:00:00.000Z"),
  })).written, 0);
  assert.equal(fetchCalls, 0);

  async function assertRejectedWithoutChangingCache(responseRows: unknown[]) {
    const invalidFetch: typeof fetch = async () => new Response(JSON.stringify(responseRows), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    await assert.rejects(
      syncExchangeRates(ledgerDir, request, {
        fetchImpl: invalidFetch,
        now: () => new Date("2026-07-13T18:00:00.000Z"),
      }),
    );

    const unchangedDb = openLedgerDatabase(ledgerDir, { readOnly: true });
    assert.deepEqual(readExchangeRates(unchangedDb), rates);
    unchangedDb.close();
  }

  await assertRejectedWithoutChangingCache([
    { date: "2026-02-30", base: "TWD", quote: "USD", rate: 0.03125 },
  ]);
  await assertRejectedWithoutChangingCache([
    { date: "2026-07-14", base: "TWD", quote: "USD", rate: 0.03125 },
  ]);
  await assertRejectedWithoutChangingCache([
    { date: "2026-07-13", base: "TWD", quote: "USD", rate: Number.MIN_VALUE },
  ]);
  await assertRejectedWithoutChangingCache([]);

  const missingRange = await syncExchangeRates(ledgerDir, {
    requiredFrom: "2026-07-14",
    currencies: ["USD"],
  }, {
    fetchImpl: async (input) => {
      assert.equal(new URL(input.toString()).searchParams.get("from"), "2026-07-14");
      return new Response(JSON.stringify([
        { date: "2026-07-14", base: "TWD", quote: "USD", rate: 0.03125 },
      ]), { status: 200, headers: { "content-type": "application/json" } });
    },
    now: () => new Date("2026-07-15T12:00:00.000Z"),
  });
  assert.equal(missingRange.from, "2026-07-14");
} finally {
  await rm(ledgerDir, { recursive: true, force: true });
}
