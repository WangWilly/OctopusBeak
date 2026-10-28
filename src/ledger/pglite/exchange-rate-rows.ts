import type { ExchangeRateRecord } from "../exchange-rates.ts";
import type { PGliteStore, PGliteTransaction } from "./transaction.ts";

/** Reads stored rates through any reader, so a page read can keep them in its own snapshot. */
export async function readExchangeRateRows(
  reader: Pick<PGliteStore, "query"> | Pick<PGliteTransaction, "query">,
  currencies?: readonly string[],
): Promise<ExchangeRateRecord[]> {
  if (currencies?.length === 0) return [];
  const params: readonly unknown[] = currencies ?? [];
  const where = currencies
    ? `WHERE currency IN (${currencies.map((_, index) => `$${index + 1}`).join(", ")})`
    : "";
  const result = await reader.query<ExchangeRateRecord>(
    `
    SELECT rate_date AS "rateDate", currency,
           twd_per_unit AS "twdPerUnit", source,
           fetched_at AS "fetchedAt"
    FROM exchange_rates
    ${where}
    ORDER BY currency, rate_date
  `,
    params,
  );
  return result.rows.map((row) => ({ ...row }));
}
