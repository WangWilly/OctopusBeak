import { z } from "zod";
import { openLedgerDatabase, type LedgerDatabase } from "./db/client.ts";
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

export type ExchangeRateSyncResult = {
  requestedCurrencies: string[];
  from: string | null;
  to: string;
  written: number;
};

type SyncOptions = {
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

export function requiredExchangeRateCurrencies(history: DailyHistoryRowDto[]) {
  return [...new Set(history.flatMap((row) =>
    AMOUNT_KEYS.flatMap((key) => row[key].map((amount) => amount.currency)),
  ))]
    .filter((currency) => currency !== "TWD" && currency !== "UNKNOWN")
    .sort();
}

export function readExchangeRates(
  db: LedgerDatabase,
  currencies?: string[],
): ExchangeRateRecord[] {
  if (currencies?.length === 0) return [];
  const placeholders = currencies?.map(() => "?").join(", ");
  return (db.prepare(`
    SELECT
      rate_date AS rateDate,
      currency,
      twd_per_unit AS twdPerUnit,
      source,
      fetched_at AS fetchedAt
    FROM exchange_rates
    ${placeholders ? `WHERE currency IN (${placeholders})` : ""}
    ORDER BY currency, rate_date
  `).all(...(currencies ?? [])) as ExchangeRateRecord[]).map((row) => ({ ...row }));
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

function upsertExchangeRates(db: LedgerDatabase, rows: ExchangeRateRecord[]) {
  const statement = db.prepare(`
    INSERT INTO exchange_rates
      (rate_date, currency, twd_per_unit, source, fetched_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(rate_date, currency) DO UPDATE SET
      twd_per_unit = excluded.twd_per_unit,
      source = excluded.source,
      fetched_at = excluded.fetched_at
  `);
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      statement.run(
        row.rateDate,
        row.currency,
        row.twdPerUnit,
        row.source,
        row.fetchedAt,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function syncExchangeRates(
  ledgerDir: string,
  request: ExchangeRateRequest,
  options: SyncOptions = {},
): Promise<ExchangeRateSyncResult> {
  const now = (options.now ?? (() => new Date()))();
  const to = now.toISOString().slice(0, 10);
  const currencies = [...new Set(request.currencies)]
    .filter((currency) => currency !== "TWD" && currency !== "UNKNOWN")
    .sort();
  if (currencies.length === 0 || !request.requiredFrom) {
    return { requestedCurrencies: currencies, from: null, to, written: 0 };
  }

  const db = openLedgerDatabase(ledgerDir);
  try {
    const from = synchronizationStart(
      request.requiredFrom,
      to,
      currencies,
      readExchangeRates(db, currencies),
    );
    if (!from || from > to) {
      return { requestedCurrencies: currencies, from, to, written: 0 };
    }
    const url = new URL(API_URL);
    url.searchParams.set("base", "TWD");
    url.searchParams.set("quotes", currencies.join(","));
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);
    const response = await (options.fetchImpl ?? fetch)(url, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Frankfurter request failed: ${response.status}`);
    }
    const parsed = apiResponseSchema.parse(await response.json())
      .filter((row) => currencies.includes(row.quote));
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
    upsertExchangeRates(db, rows);
    return { requestedCurrencies: currencies, from, to, written: rows.length };
  } finally {
    db.close();
  }
}
