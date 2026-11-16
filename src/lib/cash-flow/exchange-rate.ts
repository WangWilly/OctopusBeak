import { normalizeCurrency, type ExactMoney } from "../shared-money/exact-money.ts";

/**
 * The rate a currency exchange link's two amounts imply (ADR 0143), stated per
 * one unit of the costlier currency so that a buy and a sell read the same
 * way: `1 USD = 32.7036 TWD`, never `1 TWD = 0.0306 USD`.
 */
export type ImpliedExchangeRate = Readonly<{
  /** The costlier currency: one unit of it buys at least one unit of `quote`. */
  base: string;
  quote: string;
  /** Units of `quote` per unit of `base`, at least 1, rounded half up to `RATE_DECIMALS` places. */
  rate: string;
}>;

const RATE_DECIMALS = 4;

const magnitude = (money: ExactMoney) => {
  const coefficient = BigInt(money.coefficient);
  return { coefficient: coefficient < 0n ? -coefficient : coefficient, scale: money.scale };
};

/** The rate the two amounts imply, computed exactly; null when either amount is zero or both are one currency. */
export function impliedExchangeRate(left: ExactMoney, right: ExactMoney): ImpliedExchangeRate | null {
  const leftCurrency = normalizeCurrency(left.currency);
  const rightCurrency = normalizeCurrency(right.currency);
  if (leftCurrency === rightCurrency) return null;
  const a = magnitude(left);
  const b = magnitude(right);
  if (a.coefficient === 0n || b.coefficient === 0n) return null;
  // a = ca / 10^sa and b = cb / 10^sb, so a / b = ca * 10^sb / (cb * 10^sa).
  const aOverB = { numerator: a.coefficient * 10n ** BigInt(b.scale), denominator: b.coefficient * 10n ** BigInt(a.scale) };
  // The side with the smaller amount is the costlier currency; an even trade names the currencies in code order.
  const leftCostlier = aOverB.numerator < aOverB.denominator
    || (aOverB.numerator === aOverB.denominator && leftCurrency < rightCurrency);
  const [numerator, denominator] = leftCostlier
    ? [aOverB.denominator, aOverB.numerator]
    : [aOverB.numerator, aOverB.denominator];
  const scaled = numerator * 10n ** BigInt(RATE_DECIMALS);
  const rounded = (2n * scaled + denominator) / (2n * denominator);
  const digits = rounded.toString().padStart(RATE_DECIMALS + 1, "0");
  return {
    base: leftCostlier ? leftCurrency : rightCurrency,
    quote: leftCostlier ? rightCurrency : leftCurrency,
    rate: `${digits.slice(0, -RATE_DECIMALS)}.${digits.slice(-RATE_DECIMALS)}`,
  };
}

/** `1 USD = 32.7036 TWD`, the whole part grouped by thousands. */
export function exchangeRateText(rate: ImpliedExchangeRate): string {
  const [whole = "0", fraction = ""] = rate.rate.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  return `1 ${rate.base} = ${grouped}.${fraction} ${rate.quote}`;
}
