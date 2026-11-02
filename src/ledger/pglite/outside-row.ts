import { institutionNames } from "../../lib/institutions/institutions.ts";
import type { Origin } from "../../lib/shared-ledger/provenance.ts";
import type { CurrencyAmountDto } from "../../lib/shared-ledger/types.ts";
import { exactToNumber, type ExactAmount } from "../../lib/shared-money/exact-money.ts";

/** The building blocks every Outside financial data row and balance series shares. */

export type BalancePoint = Readonly<{ date: string; currency: string; exact: ExactAmount }>;

/** One account's dated balances kept outside canonical history: Preview Financial Data or a Manual Asset. */
export type BalanceSeries = Readonly<{
  accountId: string;
  label: string;
  side: "asset" | "liability";
  marker: Origin;
  /** From this date on the account counts toward nothing (Preview Time Deposit Closure, a closed loan, an ended Manual Asset). */
  closedOn: string | null;
  points: readonly BalancePoint[];
}>;

export const PREVIEW_INSTITUTION_NAMES = institutionNames("en");

export function previewRowId(previewAccountId: string): string {
  return `preview:${previewAccountId}`;
}

export function exactFromDecimal(amount: string): ExactAmount {
  const [whole, fraction = ""] = amount.replace(/^\+/u, "").split(".");
  return { coefficient: BigInt(`${whole}${fraction}`).toString(), scale: fraction.length };
}

export function amountLine(currency: string, exact: ExactAmount): CurrencyAmountDto {
  return { currency, value: exactToNumber(exact), exact: { ...exact } };
}

export function pointsByDate(observations: readonly Readonly<{ amount: string; currency: string; observedAt: Readonly<{ at: string }> }>[]): BalancePoint[] {
  const sorted = [...observations].sort((left, right) => Date.parse(left.observedAt.at) - Date.parse(right.observedAt.at));
  const byDate = new Map<string, BalancePoint>();
  for (const observation of sorted) {
    const date = observation.observedAt.at.slice(0, 10);
    byDate.set(date, { date, currency: observation.currency, exact: exactFromDecimal(observation.amount) });
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}


/** Groups rows read for many accounts in one query, keeping the query's order within each account. */
export function byPreviewAccount<Row extends Readonly<{ previewAccountId: string }>>(rows: readonly Row[]): (previewAccountId: string) => readonly Row[] {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const group = groups.get(row.previewAccountId);
    if (group) group.push(row);
    else groups.set(row.previewAccountId, [row]);
  }
  return (previewAccountId) => groups.get(previewAccountId) ?? [];
}
