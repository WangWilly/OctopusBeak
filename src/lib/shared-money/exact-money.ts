/**
 * Exact monetary values (ADR 0078). An amount is an integer coefficient over a
 * power of ten; money pairs an amount with a currency. Every operation here
 * works on BigInt, never on binary floating point.
 *
 * Two rules hold for every money operation:
 * - Currency compares and groups upper-cased and trimmed, so `twd` and `TWD`
 *   are one denomination. Stored values are never rewritten.
 * - Canonical equality and keys use the reduced form (no trailing zero digits,
 *   zero is "0" at scale 0). `addKeepingScale` is the separate display-total
 *   operation that keeps the operands' decimals (ADR 0069).
 */

export type ExactAmount = Readonly<{
  coefficient: string;
  scale: number;
}>;

export type ExactMoney = Readonly<{ coefficient: string; scale: number; currency: string }>;

/** One per-currency total: the reduced sum and how many amounts it counts. */
export type MoneyTotal = Readonly<ExactMoney & { count: number }>;

export const MAX_EXACT_SCALE = 1000;

export class ExactMoneyError extends Error {
  override name = "ExactMoneyError";
}

const INTEGER = /^-?\d+$/u;

/** Validate an exact amount from outside the process: an integer coefficient and a scale in 0..1000. */
export function parseExactAmount(value: unknown, label = "Exact amount"): ExactAmount {
  if (typeof value !== "object" || value === null) throw new ExactMoneyError(`${label} is not an object.`);
  const { coefficient, scale } = value as Record<string, unknown>;
  if (typeof coefficient !== "string" || !INTEGER.test(coefficient))
    throw new ExactMoneyError(`${label} coefficient is not an integer.`);
  if (typeof scale !== "number" || !Number.isSafeInteger(scale) || scale < 0 || scale > MAX_EXACT_SCALE)
    throw new ExactMoneyError(`${label} scale is invalid.`);
  return { coefficient, scale };
}

/** Validate exact money from outside the process; the currency must be non-empty. The value is returned as given. */
export function parseExactMoney(value: unknown, label = "Exact money"): ExactMoney {
  const amount = parseExactAmount(value, label);
  const { currency } = value as Record<string, unknown>;
  if (typeof currency !== "string" || currency.trim() === "")
    throw new ExactMoneyError(`${label} currency is missing.`);
  return { ...amount, currency };
}

// ---------------------------------------------------------------------------
// Amounts

function aligned(value: ExactAmount, scale: number): bigint {
  return BigInt(value.coefficient) * 10n ** BigInt(scale - value.scale);
}

/** Reduce to canonical scale: no trailing zero digits after the point; zero is "0" at scale 0. */
export function normalizeExact(value: ExactAmount): ExactAmount {
  let coefficient = BigInt(value.coefficient);
  let scale = value.scale;
  if (coefficient === 0n) return { coefficient: "0", scale: 0 };
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient: coefficient.toString(), scale };
}

export function isZeroExact(value: ExactAmount): boolean {
  return BigInt(value.coefficient) === 0n;
}

export function addExact(left: ExactAmount, right: ExactAmount): ExactAmount {
  const scale = Math.max(left.scale, right.scale);
  return normalizeExact({ coefficient: (aligned(left, scale) + aligned(right, scale)).toString(), scale });
}

export function subtractExact(left: ExactAmount, right: ExactAmount): ExactAmount {
  return addExact(left, negateExact(right));
}

/** Flips the sign and keeps the scale. */
export function negateExact(value: ExactAmount): ExactAmount {
  return { coefficient: (-BigInt(value.coefficient)).toString(), scale: value.scale };
}

/** The absolute value at the same scale. */
export function absoluteExact(value: ExactAmount): ExactAmount {
  const coefficient = BigInt(value.coefficient);
  return coefficient < 0n ? negateExact(value) : { coefficient: coefficient.toString(), scale: value.scale };
}

export function compareExact(left: ExactAmount, right: ExactAmount): -1 | 0 | 1 {
  const scale = Math.max(left.scale, right.scale);
  const a = aligned(left, scale);
  const b = aligned(right, scale);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Adds at the larger operand scale and never reduces: a display total shows
 * the decimals its sources reported (ADR 0069). Not a canonical form; compare
 * and key with the reduced operations instead.
 */
export function addKeepingScale(left: ExactAmount, right: ExactAmount): ExactAmount {
  const scale = Math.max(left.scale, right.scale);
  return { coefficient: (aligned(left, scale) + aligned(right, scale)).toString(), scale };
}

export function multiplyExact(left: ExactAmount, right: ExactAmount): ExactAmount {
  return normalizeExact({
    coefficient: (BigInt(left.coefficient) * BigInt(right.coefficient)).toString(),
    scale: left.scale + right.scale,
  });
}

/** Divides with a bounded decimal scale so geometry and display stay finite. */
export function divideExact(
  left: ExactAmount,
  right: ExactAmount,
  precision = 18,
): ExactAmount | null {
  const denominator = BigInt(right.coefficient);
  if (denominator === 0n) return null;
  const leftCoefficient = BigInt(left.coefficient);
  if (leftCoefficient === 0n) return { coefficient: "0", scale: 0 };
  const negative = (leftCoefficient < 0n) !== (denominator < 0n);
  let numerator = leftCoefficient < 0n ? -leftCoefficient : leftCoefficient;
  let positiveDenominator = denominator < 0n ? -denominator : denominator;
  const exponent = precision + right.scale - left.scale;
  if (exponent >= 0) numerator *= 10n ** BigInt(exponent);
  else positiveDenominator *= 10n ** BigInt(-exponent);
  let quotient = numerator / positiveDenominator;
  if ((numerator % positiveDenominator) * 2n >= positiveDenominator) quotient += 1n;
  if (negative) quotient = -quotient;
  return normalizeExact({ coefficient: quotient.toString(), scale: precision });
}

export function decimalToExact(value: number): ExactAmount | null {
  if (!Number.isFinite(value)) return null;
  const text = String(value).toLowerCase();
  const match = text.match(/^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/);
  if (!match) return null;
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = match[2] ?? "0";
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? "0");
  let coefficient = sign * BigInt(`${whole}${fraction}`);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return normalizeExact({ coefficient: coefficient.toString(), scale });
}

/**
 * The presentation number of an exact amount. The exact value stays
 * authoritative: an amount a JavaScript number cannot represent, by overflow
 * or underflow, is NaN rather than a fabricated zero or infinity.
 */
export function exactToNumber(value: ExactAmount): number {
  const coefficient = BigInt(value.coefficient);
  const number = Number(coefficient) / 10 ** value.scale;
  return coefficient !== 0n && number === 0
    ? Number.NaN
    : Number.isFinite(number)
      ? number
      : Number.NaN;
}

// ---------------------------------------------------------------------------
// Money

/** The denomination money compares and groups by. */
export function normalizeCurrency(currency: string): string {
  return currency.trim().toUpperCase();
}

export function sameCurrency(left: Pick<ExactMoney, "currency">, right: Pick<ExactMoney, "currency">): boolean {
  return normalizeCurrency(left.currency) === normalizeCurrency(right.currency);
}

function requireSameCurrency(left: ExactMoney, right: ExactMoney): string {
  if (!sameCurrency(left, right))
    throw new ExactMoneyError(`Cannot combine ${left.currency} with ${right.currency}.`);
  return normalizeCurrency(left.currency);
}

/** Canonical money: reduced amount, upper-cased trimmed currency. */
export function normalizeMoney(value: ExactMoney): ExactMoney {
  return { ...normalizeExact(value), currency: normalizeCurrency(value.currency) };
}

export function addMoney(left: ExactMoney, right: ExactMoney): ExactMoney {
  return { ...addExact(left, right), currency: requireSameCurrency(left, right) };
}

export function subtractMoney(left: ExactMoney, right: ExactMoney): ExactMoney {
  return { ...subtractExact(left, right), currency: requireSameCurrency(left, right) };
}

export function negateMoney(value: ExactMoney): ExactMoney {
  return normalizeMoney({ ...negateExact(value), currency: value.currency });
}

/** Orders two amounts of one currency; money of different currencies has no order. */
export function compareMoney(left: ExactMoney, right: ExactMoney): -1 | 0 | 1 {
  requireSameCurrency(left, right);
  return compareExact(left, right);
}

/** Same currency (case-insensitive) and the same numeric value, whatever the scale. */
export function equalMoney(left: ExactMoney, right: ExactMoney): boolean {
  return sameCurrency(left, right) && compareExact(left, right) === 0;
}

/** A string that two values share exactly when equalMoney holds: `CUR:coefficient:scale`, reduced. */
export function moneyKey(value: ExactMoney): string {
  const normalized = normalizeMoney(value);
  return `${normalized.currency}:${normalized.coefficient}:${normalized.scale}`;
}

// ---------------------------------------------------------------------------
// Totals

type TotalEntry = { currency: string; amount: ExactAmount; count: number };

/** Running money totals by key, before they are read; see addToTotals and readTotals. */
export type MoneyTotalsAccumulator<K extends string = string> = Map<K, TotalEntry>;

/**
 * Add one amount to a running total. The key defaults to the normalized
 * currency, so `twd` and `TWD` share one total. `count` is how many amounts
 * this adds; a negative count with a negated amount removes them again.
 */
export function addToTotals<K extends string = string>(
  totals: MoneyTotalsAccumulator<K>,
  amount: ExactMoney,
  key: (currency: string) => K = (currency) => currency as K,
  count = 1,
): void {
  const currency = normalizeCurrency(amount.currency);
  const entryKey = key(currency);
  const previous = totals.get(entryKey);
  // A key that leaves out the currency must not add two currencies together.
  if (previous && previous.currency !== currency) {
    throw new ExactMoneyError(`Totals key ${entryKey} holds ${previous.currency} and ${currency}.`);
  }
  totals.set(entryKey, {
    currency,
    amount: previous ? addExact(previous.amount, amount) : normalizeExact(amount),
    count: (previous?.count ?? 0) + count,
  });
}

/** The totals sorted by key, reduced. A total counting any amount stays, even when it sums to zero. */
export function readTotals<K extends string>(
  totals: MoneyTotalsAccumulator<K>,
): readonly Readonly<MoneyTotal & { key: K }>[] {
  return [...totals.entries()]
    .filter(([, entry]) => entry.count > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => ({ key, currency: entry.currency, ...entry.amount, count: entry.count }));
}

/** Per-currency totals with counts, sorted by currency. */
export function moneyTotals(amounts: Iterable<ExactMoney>): readonly MoneyTotal[] {
  const totals: MoneyTotalsAccumulator = new Map();
  for (const amount of amounts) addToTotals(totals, amount);
  return readTotals(totals).map(({ key: _key, ...total }) => total);
}

/** Combine per-currency totals, adding amounts and counts of one currency. */
export function mergeMoneyTotals(...lists: readonly (readonly MoneyTotal[])[]): readonly MoneyTotal[] {
  const totals: MoneyTotalsAccumulator = new Map();
  for (const list of lists) for (const total of list) addToTotals(totals, total, undefined, total.count);
  return readTotals(totals).map(({ key: _key, ...total }) => total);
}
