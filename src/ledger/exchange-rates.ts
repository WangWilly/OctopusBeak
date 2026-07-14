import { z } from "zod";
import { openLedgerDatabase, type LedgerDatabase } from "./db/client.ts";
import type { DailyHistoryRowDto } from "../lib/shared-ledger/types.ts";

const API_URL = "https://api.frankfurter.dev/v2/rates";
const SOURCE = "frankfurter-v2";
const AMOUNT_KEYS = ["netAssets", "dailyChange", "assets", "liabilities"] as const;
const apiRowSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
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

export function readExchangeRates(db: LedgerDatabase): ExchangeRateRecord[] {
  return (db.prepare(`
    SELECT
      rate_date AS rateDate,
      currency,
      twd_per_unit AS twdPerUnit,
      source,
      fetched_at AS fetchedAt
    FROM exchange_rates
    ORDER BY currency, rate_date
  `).all() as ExchangeRateRecord[]).map((row) => ({ ...row }));
}

function synchronizationStart(
  history: DailyHistoryRowDto[],
  currencies: string[],
  cached: ExchangeRateRecord[],
) {
  const earliest = history.map((row) => row.date).sort()[0];
  if (!earliest) return null;
  return currencies.map((currency) => {
    const rows = cached.filter((row) => row.currency === currency);
    const first = rows[0]?.rateDate;
    const last = rows.at(-1)?.rateDate;
    return !first || first > earliest ? earliest : last ?? earliest;
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
  history: DailyHistoryRowDto[],
  options: SyncOptions = {},
): Promise<ExchangeRateSyncResult> {
  const now = (options.now ?? (() => new Date()))();
  const to = now.toISOString().slice(0, 10);
  const currencies = requiredExchangeRateCurrencies(history);
  if (currencies.length === 0) {
    return { requestedCurrencies: [], from: null, to, written: 0 };
  }

  const db = openLedgerDatabase(ledgerDir);
  try {
    const from = synchronizationStart(history, currencies, readExchangeRates(db));
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
    const parsed = apiResponseSchema.parse(await response.json());
    for (const currency of currencies) {
      if (!parsed.some((row) => row.quote === currency)) {
        throw new Error(`Frankfurter response missing ${currency}`);
      }
    }
    const fetchedAt = now.toISOString();
    const rows = parsed.map((row): ExchangeRateRecord => ({
      rateDate: row.date,
      currency: row.quote,
      twdPerUnit: 1 / row.rate,
      source: SOURCE,
      fetchedAt,
    }));
    upsertExchangeRates(db, rows);
    return { requestedCurrencies: currencies, from, to, written: rows.length };
  } finally {
    db.close();
  }
}
