import { exactAmountToNumber } from "./overview-amount.ts";

export type PGliteHoldingPriceReader = Readonly<{
  query<T>(query: string, params?: readonly unknown[]): Promise<{ rows: readonly T[] }>;
}>;

export type PGliteHoldingPrice = Readonly<{
  accountId: string;
  securityId: string;
  securityType: string;
  date: string;
  price: number;
  currency: string;
}>;

type HoldingPriceRow = Readonly<{
  account_id: string;
  security_id: string;
  security_type: string;
  effective_on: string;
  quantity_coefficient: string;
  quantity_scale: number | string;
  valuation_coefficient: string;
  valuation_scale: number | string;
  valuation_currency: string;
}>;

/**
 * Implied unit prices (valuation / quantity) from the user's own holding
 * observations: for each account and security, the selected observation of
 * each of its two most recent effective dates, oldest first. The per-date
 * selection matches the daily history, so a price change lines up with the
 * history row it explains.
 */
export async function readPGliteHoldingPrices(
  reader: PGliteHoldingPriceReader,
  knowledgePoint: number,
): Promise<PGliteHoldingPrice[]> {
  if (!Number.isSafeInteger(knowledgePoint) || knowledgePoint < 0)
    throw new Error("Holding price knowledgePoint must be a non-negative safe integer.");
  const result = await reader.query<HoldingPriceRow>(
    `WITH per_date AS (
       SELECT holding.account_id, holding.security_id, holding.effective_on,
              holding.quantity_coefficient, holding.quantity_scale,
              holding.valuation_coefficient, holding.valuation_scale, holding.valuation_currency,
              ROW_NUMBER() OVER (
                PARTITION BY holding.account_id, holding.security_id, holding.effective_on
                ORDER BY holding.observed_at DESC, holding.revision_number DESC,
                  commit_row.commit_sequence DESC
              ) AS date_rank
         FROM investment_holding_observations holding
         JOIN canonical_commits commit_row ON commit_row.commit_id = holding.commit_id
        WHERE commit_row.commit_sequence <= $1
     ), recent AS (
       SELECT per_date.*,
              ROW_NUMBER() OVER (
                PARTITION BY per_date.account_id, per_date.security_id
                ORDER BY per_date.effective_on DESC
              ) AS recency
         FROM per_date
        WHERE date_rank = 1
     )
     SELECT encode(recent.account_id, 'hex') AS account_id,
            encode(recent.security_id, 'hex') AS security_id,
            security.security_type,
            recent.effective_on,
            recent.quantity_coefficient, recent.quantity_scale,
            recent.valuation_coefficient, recent.valuation_scale, recent.valuation_currency
       FROM recent
       JOIN investment_securities security ON security.security_id = recent.security_id
      WHERE recent.recency <= 2
        AND recent.quantity_coefficient IS NOT NULL
        AND recent.valuation_coefficient IS NOT NULL
        AND recent.valuation_currency IS NOT NULL
      ORDER BY account_id, security_id, recent.effective_on`,
    [knowledgePoint],
  );
  return result.rows.flatMap((row) => {
    const quantity = exactAmountToNumber({ coefficient: row.quantity_coefficient, scale: Number(row.quantity_scale) });
    if (quantity === 0) return [];
    const valuation = exactAmountToNumber({ coefficient: row.valuation_coefficient, scale: Number(row.valuation_scale) });
    return [{
      accountId: row.account_id,
      securityId: row.security_id,
      securityType: row.security_type,
      date: row.effective_on,
      price: valuation / quantity,
      currency: row.valuation_currency,
    }];
  });
}
