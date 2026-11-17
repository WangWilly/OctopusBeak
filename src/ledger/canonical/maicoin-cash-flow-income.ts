import { CASH_FLOW_TRANSFER_WINDOW_DAYS, dayGap } from "./cash-flow-transfer-rules.ts";
import { compareExact, decimalToExact, divideExact, multiplyExact, type ExactAmount, type ExactMoney } from "../../lib/shared-money/exact-money.ts";

/**
 * Which MaiCoin (MAX) inflows Cash flow counts as income (ADR 0146): a reward,
 * and a crypto deposit from outside the person's imported accounts, each at
 * the TWD value the MAX sync logged from MAX's daily close.
 */

/** The logged MAX statement row an investment row came from. */
export type MaicoinLoggedStatement = Readonly<{
  rowType: string;
  currency: string | null;
  /** `amount × price` at MAX's daily close, as the sync logged it. */
  valueTwd: number | null;
  /** MAX's own state for the statement; a reward carries none. */
  state: string | null;
}>;

/** A MAX `corporate_action_in` with the statement row it came from. */
export type MaicoinInflow = Readonly<{
  transactionId: string;
  coin: string;
  quantity: ExactAmount;
  date: string;
  statement: MaicoinLoggedStatement;
}>;

/** A `corporate_action_out` of a coin from another imported investment source, such as a Binance withdrawal. */
export type CryptoOutflow = Readonly<{ transactionId: string; coin: string; quantity: ExactAmount; date: string }>;

export type MaicoinIncomeGroup = "income" | "income.reward";

/** A null `value` leaves the row unresolved: it qualifies, but nothing values it. */
export type MaicoinIncome = Readonly<{ group: MaicoinIncomeGroup; value: ExactMoney | null }>;

/** A TWD deposit comes from a bank, which ADR 0145 matches instead. */
export function maicoinIncomeGroup(statement: MaicoinLoggedStatement, coin: string): MaicoinIncomeGroup | null {
  // A deposit MAX has not completed, or has rejected, never arrived.
  if (statement.state !== null && statement.state !== "done") return null;
  if (statement.rowType === "reward") return "income.reward";
  if (statement.rowType === "deposit" && statement.state === "done" && (statement.currency ?? coin).toUpperCase() !== "TWD") return "income";
  return null;
}

const ONE: ExactAmount = { coefficient: "1", scale: 0 };

/** The logged value, rounded half-up to two decimals. */
export function maicoinValueTwd(valueTwd: number | null): ExactMoney | null {
  if (valueTwd === null || valueTwd < 0) return null;
  const exact = decimalToExact(valueTwd);
  const rounded = exact === null ? null : divideExact(exact, ONE, 2);
  return rounded === null ? null : { ...rounded, currency: "TWD" };
}

/** The sender may have paid a network fee of up to 1% on top of what arrived. */
function fits(inflow: MaicoinInflow, outflow: CryptoOutflow): boolean {
  return inflow.coin === outflow.coin
    && dayGap(inflow.date, outflow.date) <= CASH_FLOW_TRANSFER_WINDOW_DAYS
    && compareExact(outflow.quantity, inflow.quantity) >= 0
    && compareExact(multiplyExact(outflow.quantity, { coefficient: "100", scale: 0 }), multiplyExact(inflow.quantity, { coefficient: "101", scale: 0 })) <= 0;
}

/**
 * The income each qualifying inflow counts as. A crypto deposit that fits
 * exactly one outflow, which fits no other deposit, is the person's own
 * transfer and is left out. `inflows` must hold every MAX deposit that could
 * fit one of `outflows`, so a shared outflow is seen as ambiguous.
 */
export function maicoinCashFlowIncome(inflows: readonly MaicoinInflow[], outflows: readonly CryptoOutflow[]): ReadonlyMap<string, MaicoinIncome> {
  const qualifying = inflows.flatMap((inflow) => {
    const group = maicoinIncomeGroup(inflow.statement, inflow.coin);
    return group === null ? [] : [{ inflow, group }];
  });
  const fitsOf = new Map(qualifying.filter(({ group }) => group === "income")
    .map(({ inflow }) => [inflow.transactionId, outflows.filter((outflow) => fits(inflow, outflow))]));
  const claims = new Map<string, number>();
  for (const candidates of fitsOf.values())
    for (const outflow of candidates) claims.set(outflow.transactionId, (claims.get(outflow.transactionId) ?? 0) + 1);
  const ownTransfer = (transactionId: string) => {
    const candidates = fitsOf.get(transactionId) ?? [];
    return candidates.length === 1 && claims.get(candidates[0]!.transactionId) === 1;
  };
  return new Map(qualifying
    .filter(({ inflow }) => !ownTransfer(inflow.transactionId))
    .map(({ inflow, group }) => [inflow.transactionId, { group, value: maicoinValueTwd(inflow.statement.valueTwd) }]));
}
