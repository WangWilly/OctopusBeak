import { z } from "zod";
import type { DailyHistoryRowDto } from "../lib/shared-ledger/types.ts";
import type { ExchangeRateRequest } from "./exchange-rate-requirements.ts";

const API_URL = "https://api.frankfurter.dev/v2/rates";
const SOURCE = "frankfurter-v2";
const RATE_LOOKBACK_DAYS = 7;
const AMOUNT_KEYS = ["netAssets", "dailyChange", "assets", "liabilities"] as const;
const apiRowSchema = z.object({
  date: z.iso.date(),
  base: z.literal("TWD"),
  quote: z.string().regex(/^[A-Z]{3}$/),
  rate: z.number().positive().finite(),
});
const apiResponseSchema = z.array(apiRowSchema);

export type ExchangeRateRecord = {
  rateDate: string;
  currency: string;
  twdPerUnit: number;
  source: string;
  fetchedAt: string;
};

/** Async exchange-rate seam backed by the worker-owned PGlite database. */
export interface ExchangeRatePersistencePort {
  readExchangeRates(currencies?: string[]): Promise<ExchangeRateRecord[]>;
  upsertExchangeRates(rows: readonly ExchangeRateRecord[]): Promise<void>;
}

export type ExchangeRateSyncResult = {
  requestedCurrencies: string[];
  from: string | null;
  to: string;
  written: number;
};

type SyncOptions = {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  signal?: AbortSignal;
};

export type ExchangeRateSyncOptions = SyncOptions;

export function requiredExchangeRateCurrencies(history: readonly DailyHistoryRowDto[]) {
  return [...new Set(history.flatMap((row) =>
    AMOUNT_KEYS.flatMap((key) => row[key].map((amount) => amount.currency)),
  ))]
    .filter((currency) => currency !== "TWD" && currency !== "UNKNOWN")
    .sort();
}

export function readExchangeRates(
  persistence: ExchangeRatePersistencePort,
  currencies?: string[],
): Promise<ExchangeRateRecord[]> {
  return persistence.readExchangeRates(currencies);
}

function synchronizationStart(
  requiredFrom: string,
  to: string,
  currencies: string[],
  cached: ExchangeRateRecord[],
) {
  const coverageFrom = new Date(`${requiredFrom}T00:00:00.000Z`);
  coverageFrom.setUTCDate(coverageFrom.getUTCDate() - RATE_LOOKBACK_DAYS);
  const coverageDate = coverageFrom.toISOString().slice(0, 10);
  return currencies.flatMap((currency) => {
    const rows = cached.filter((row) => row.currency === currency);
    const first = rows[0]?.rateDate;
    const last = rows.at(-1)?.rateDate;
    if (!first || first > requiredFrom) return coverageDate;
    if (last && last >= to) return [];
    const next = new Date(`${last}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const nextDate = next.toISOString().slice(0, 10);
    return nextDate < coverageDate ? coverageDate : nextDate;
  }).sort()[0] ?? null;
}

export function syncExchangeRates(
  persistence: ExchangeRatePersistencePort,
  request: ExchangeRateRequest,
  options: SyncOptions = {},
): Promise<ExchangeRateSyncResult> {
  return syncExchangeRatesWithPersistence(persistence, request, options);
}

/** Run exchange-rate synchronization against the injected persistence port. */
export async function syncExchangeRatesWithPersistence(
  persistence: ExchangeRatePersistencePort,
  request: ExchangeRateRequest,
  options: SyncOptions = {},
): Promise<ExchangeRateSyncResult> {
  options.signal?.throwIfAborted();
  const now = (options.now ?? (() => new Date()))();
  const to = now.toISOString().slice(0, 10);
  const currencies = [...new Set(request.currencies)]
    .filter((currency) => currency !== "TWD" && currency !== "UNKNOWN")
    .sort();
  if (currencies.length === 0 || !request.requiredFrom) {
    return { requestedCurrencies: currencies, from: null, to, written: 0 };
  }

  const from = synchronizationStart(
    request.requiredFrom,
    to,
    currencies,
    await persistence.readExchangeRates(currencies),
  );
  options.signal?.throwIfAborted();
  if (!from || from > to) {
    return { requestedCurrencies: currencies, from, to, written: 0 };
  }
  const url = new URL(API_URL);
  url.searchParams.set("base", "TWD");
  url.searchParams.set("quotes", currencies.join(","));
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  const timeoutSignal = AbortSignal.timeout(10_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  const response = await (options.fetchImpl ?? fetch)(url, { signal });
  options.signal?.throwIfAborted();
  if (!response.ok) {
    throw new Error(`Frankfurter request failed: ${response.status}`);
  }
  const parsed = apiResponseSchema.parse(await response.json())
    .filter((row) => currencies.includes(row.quote));
  options.signal?.throwIfAborted();
  if (parsed.some((row) => row.date < from || row.date > to)) {
    throw new Error(`Frankfurter response date outside ${from}..${to}`);
  }
  for (const currency of currencies) {
    if (!parsed.some((row) => row.quote === currency)) {
      throw new Error(`Frankfurter response missing ${currency}`);
    }
  }
  const fetchedAt = now.toISOString();
  const rows = parsed.map((row): ExchangeRateRecord => {
    const twdPerUnit = 1 / row.rate;
    if (!Number.isFinite(twdPerUnit) || twdPerUnit <= 0) {
      throw new Error(`Frankfurter response has invalid inverse rate for ${row.quote}`);
    }
    return {
      rateDate: row.date,
      currency: row.quote,
      twdPerUnit,
      source: SOURCE,
      fetchedAt,
    };
  });
  options.signal?.throwIfAborted();
  await persistence.upsertExchangeRates(rows);
  return { requestedCurrencies: currencies, from, to, written: rows.length };
}
