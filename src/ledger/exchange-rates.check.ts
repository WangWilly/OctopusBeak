import assert from "node:assert/strict";
import test from "node:test";
import {
  readExchangeRates,
  requiredExchangeRateCurrencies,
  syncExchangeRates,
  type ExchangeRatePersistencePort,
  type ExchangeRateRecord,
} from "./exchange-rates.ts";
import type { ExchangeRateRequest } from "./exchange-rate-requirements.ts";
import type { DailyHistoryRowDto } from "../lib/shared-ledger/types.ts";

function memoryPersistence(initial: ExchangeRateRecord[] = []) {
  const rates = new Map(initial.map((row) => [`${row.rateDate}/${row.currency}`, { ...row }]));
  const persistence: ExchangeRatePersistencePort = {
    async readExchangeRates(currencies) {
      return [...rates.values()]
        .filter((row) => currencies === undefined || currencies.includes(row.currency))
        .sort((left, right) => left.currency.localeCompare(right.currency)
          || left.rateDate.localeCompare(right.rateDate))
        .map((row) => ({ ...row }));
    },
    async upsertExchangeRates(rows) {
      for (const row of rows) rates.set(`${row.rateDate}/${row.currency}`, { ...row });
    },
  };
  return persistence;
}

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

test("required exchange-rate currencies include every non-TWD amount line", () => {
  assert.deepEqual(requiredExchangeRateCurrencies(history), ["JPY", "USD"]);
});

test("aborting the sync signal cancels its in-flight fetch before writing rates", async () => {
  const persistence = memoryPersistence();
  const controller = new AbortController();
  const inFlight = syncExchangeRates(persistence, {
    requiredFrom: "2026-01-03",
    currencies: ["USD"],
  }, {
    signal: controller.signal,
    fetchImpl: async (_input, init) => {
      controller.abort(new Error("exchange sync cancelled"));
      await new Promise<void>((resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        setTimeout(resolve, 20);
      });
      return new Response(JSON.stringify([
        { date: "2026-07-12", base: "TWD", quote: "USD", rate: 0.03125 },
      ]), { status: 200, headers: { "content-type": "application/json" } });
    },
    now: () => new Date("2026-07-12T12:00:00.000Z"),
  });

  await assert.rejects(inFlight, /exchange sync cancelled/u);
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(await readExchangeRates(persistence), []);
});

test("synchronization validates and upserts the requested Frankfurter rates", async () => {
  const persistence = memoryPersistence();
  const request: ExchangeRateRequest = {
    requiredFrom: "2026-01-03",
    currencies: ["USD"],
  };
  const validFetch: typeof fetch = async (input) => {
    assert.equal(new URL(input.toString()).searchParams.get("from"), "2025-12-27");
    return new Response(JSON.stringify([
      { date: "2026-01-03", base: "TWD", quote: "USD", rate: 0.03125 },
      { date: "2026-07-12", base: "TWD", quote: "USD", rate: 0.03125 },
      { date: "2026-07-12", base: "TWD", quote: "EUR", rate: 0.027 },
    ]), { status: 200, headers: { "content-type": "application/json" } });
  };

  const result = await syncExchangeRates(persistence, request, {
    fetchImpl: validFetch,
    now: () => new Date("2026-07-12T12:00:00.000Z"),
  });
  assert.equal(result.written, 2);
  const rates = await readExchangeRates(persistence);
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

  let fetchCalls = 0;
  const unexpectedFetch: typeof fetch = async () => {
    fetchCalls += 1;
    throw new Error("fetch should not be called");
  };
  assert.equal((await syncExchangeRates(persistence, {
    requiredFrom: null,
    currencies: [],
  }, {
    fetchImpl: unexpectedFetch,
    now: () => new Date("2026-07-12T18:00:00.000Z"),
  })).written, 0);
  assert.equal((await syncExchangeRates(persistence, request, {
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
      syncExchangeRates(persistence, request, {
        fetchImpl: invalidFetch,
        now: () => new Date("2026-07-13T18:00:00.000Z"),
      }),
    );
    assert.deepEqual(await readExchangeRates(persistence), rates);
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

  const missingRange = await syncExchangeRates(persistence, {
    requiredFrom: "2026-07-14",
    currencies: ["USD"],
  }, {
    fetchImpl: async (input) => {
      assert.equal(new URL(input.toString()).searchParams.get("from"), "2026-07-12");
      return new Response(JSON.stringify([
        { date: "2026-07-14", base: "TWD", quote: "USD", rate: 0.03125 },
      ]), { status: 200, headers: { "content-type": "application/json" } });
    },
    now: () => new Date("2026-07-15T12:00:00.000Z"),
  });
  assert.equal(missingRange.from, "2026-07-12");
});

test("sync before today's publication reuses the last published date without inventing today's rate", async () => {
  const fetchedAt = "2026-09-28T12:00:00.000Z";
  const persistence = memoryPersistence([
    { rateDate: "2026-09-01", currency: "USD", twdPerUnit: 32, source: "frankfurter-v2", fetchedAt },
    { rateDate: "2026-09-28", currency: "USD", twdPerUnit: 32, source: "frankfurter-v2", fetchedAt },
  ]);
  const result = await syncExchangeRates(persistence, {
    requiredFrom: "2026-09-01",
    currencies: ["USD"],
  }, {
    now: () => new Date("2026-09-29T02:00:00.000Z"),
    fetchImpl: async () => new Response(JSON.stringify([
      { date: "2026-09-28", base: "TWD", quote: "USD", rate: 0.03125 },
    ]), { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.equal(result.from, "2026-09-28");
  assert.equal(result.written, 1);
  assert.equal((await readExchangeRates(persistence)).some((row) => row.rateDate === "2026-09-29"), false);
});

test("unequal currency cache coverage overlaps the earliest last published date", async () => {
  const fetchedAt = "2026-07-12T12:00:00.000Z";
  const persistence = memoryPersistence([
    { rateDate: "2026-01-03", currency: "USD", twdPerUnit: 32, source: "frankfurter-v2", fetchedAt },
    { rateDate: "2026-07-12", currency: "USD", twdPerUnit: 32, source: "frankfurter-v2", fetchedAt },
    { rateDate: "2026-01-03", currency: "JPY", twdPerUnit: 0.22, source: "frankfurter-v2", fetchedAt },
    { rateDate: "2026-07-08", currency: "JPY", twdPerUnit: 0.22, source: "frankfurter-v2", fetchedAt },
  ]);
  assert.deepEqual((await readExchangeRates(persistence, ["JPY"])).map((rate) => rate.currency), ["JPY", "JPY"]);
  assert.deepEqual(await readExchangeRates(persistence, []), []);

  const result = await syncExchangeRates(persistence, {
    requiredFrom: "2026-07-11",
    currencies: ["USD", "JPY"],
  }, {
    fetchImpl: async (input) => {
      assert.equal(new URL(input.toString()).searchParams.get("from"), "2026-07-08");
      return new Response(JSON.stringify([
        { date: "2026-07-11", base: "TWD", quote: "JPY", rate: 4.5 },
        { date: "2026-07-11", base: "TWD", quote: "USD", rate: 0.03125 },
      ]), { status: 200, headers: { "content-type": "application/json" } });
    },
    now: () => new Date("2026-07-15T12:00:00.000Z"),
  });
  assert.equal(result.from, "2026-07-08");
});
