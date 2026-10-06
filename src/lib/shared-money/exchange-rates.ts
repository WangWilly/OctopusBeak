import type { CurrencyAmountDto, ExchangeRateDto } from "../shared-ledger/types.ts";

/** Rates per currency, sorted by rate date. */
export type ExchangeRateIndex = ReadonlyMap<string, readonly ExchangeRateDto[]>;

export type SelectedRate = {
  rateDate: string | null;
  twdPerUnit: number;
};

export type TwdConversion = {
  value: number;
  rateDates: string[];
};

export function indexExchangeRates(rates: readonly ExchangeRateDto[]): ExchangeRateIndex {
  const index = new Map<string, ExchangeRateDto[]>();
  for (const rate of rates) {
    const currencyRates = index.get(rate.currency) ?? [];
    currencyRates.push(rate);
    index.set(rate.currency, currencyRates);
  }
  for (const currencyRates of index.values()) {
    currencyRates.sort((left, right) => left.rateDate.localeCompare(right.rateDate));
  }
  return index;
}

/** Rates exist only on working days, so a date uses the newest rate on or before it. */
export function rateOnOrBefore(
  index: ExchangeRateIndex,
  currency: string,
  date: string,
): SelectedRate | null {
  if (currency === "TWD") return { rateDate: null, twdPerUnit: 1 };
  const rates = index.get(currency) ?? [];
  let low = 0;
  let high = rates.length - 1;
  let rate: ExchangeRateDto | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = rates[middle]!;
    if (candidate.rateDate <= date) {
      rate = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return rate ? { rateDate: rate.rateDate, twdPerUnit: rate.twdPerUnit } : null;
}

/** Convert per-currency amounts to one TWD value at `date`, or null when any rate is missing. */
export function convertToTwd(
  amounts: readonly CurrencyAmountDto[],
  date: string,
  index: ExchangeRateIndex,
): TwdConversion | null {
  let value = 0;
  const rateDates = new Set<string>();
  for (const amount of amounts) {
    const rate = rateOnOrBefore(index, amount.currency, date);
    if (!rate) return null;
    if (rate.rateDate) rateDates.add(rate.rateDate);
    value += amount.value * rate.twdPerUnit;
  }
  return { value, rateDates: [...rateDates].sort() };
}
