import type {
  CurrencyAmountDto,
  DailyHistoryRowDto,
  ExchangeRateDto,
} from "../shared-ledger/types.ts";

const AMOUNT_KEYS = ["netAssets", "dailyChange", "assets", "liabilities"] as const;
const CURRENCY_ORDER = ["TWD", "JPY", "USD"];

type SelectedRate = {
  rateDate: string | null;
  twdPerUnit: number;
};

function rateOnOrBefore(
  ratesByCurrency: Map<string, ExchangeRateDto[]>,
  currency: string,
  date: string,
): SelectedRate | null {
  if (currency === "TWD") return { rateDate: null, twdPerUnit: 1 };
  const rates = ratesByCurrency.get(currency) ?? [];
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

function convertAmounts(
  amounts: CurrencyAmountDto[],
  displayCurrency: string,
  date: string,
  ratesByCurrency: Map<string, ExchangeRateDto[]>,
  usedDates: Set<string>,
): CurrencyAmountDto[] | null {
  if (amounts.length === 0) return [];
  const displayRate = rateOnOrBefore(ratesByCurrency, displayCurrency, date);
  if (!displayRate) return null;
  if (displayRate.rateDate) usedDates.add(displayRate.rateDate);
  let value = 0;
  for (const amount of amounts) {
    const sourceRate = rateOnOrBefore(ratesByCurrency, amount.currency, date);
    if (!sourceRate) return null;
    if (sourceRate.rateDate) usedDates.add(sourceRate.rateDate);
    value += amount.value * sourceRate.twdPerUnit / displayRate.twdPerUnit;
  }
  return [{ currency: displayCurrency, value }];
}

export function dailyHistoryCurrencies(rows: DailyHistoryRowDto[]) {
  const currencies = new Set(["TWD"]);
  for (const row of rows) {
    for (const key of AMOUNT_KEYS) {
      for (const amount of row[key]) {
        if (amount.currency !== "UNKNOWN") currencies.add(amount.currency);
      }
    }
  }
  return [...currencies].sort((left, right) => {
    const leftIndex = CURRENCY_ORDER.indexOf(left);
    const rightIndex = CURRENCY_ORDER.indexOf(right);
    return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex)
      || left.localeCompare(right);
  });
}

export function convertDailyHistoryRows(
  rows: DailyHistoryRowDto[],
  rates: ExchangeRateDto[],
  displayCurrency: string,
) {
  const ratesByCurrency = new Map<string, ExchangeRateDto[]>();
  for (const rate of rates) {
    const currency = rate.currency;
    const currencyRates = ratesByCurrency.get(currency) ?? [];
    currencyRates.push(rate);
    ratesByCurrency.set(currency, currencyRates);
  }
  for (const currencyRates of ratesByCurrency.values()) {
    currencyRates.sort((left, right) => left.rateDate.localeCompare(right.rateDate));
  }
  return {
    rows: rows.map((row): DailyHistoryRowDto => {
      const usedDates = new Set<string>();
      const converted = {
        netAssets: convertAmounts(row.netAssets, displayCurrency, row.date, ratesByCurrency, usedDates),
        dailyChange: convertAmounts(row.dailyChange, displayCurrency, row.date, ratesByCurrency, usedDates),
        assets: convertAmounts(row.assets, displayCurrency, row.date, ratesByCurrency, usedDates),
        liabilities: convertAmounts(row.liabilities, displayCurrency, row.date, ratesByCurrency, usedDates),
      };
      if (Object.values(converted).some((amounts) => amounts === null)) {
        return { ...row, exchangeRateDates: [], exchangeRateMissing: true };
      }
      return {
        ...row,
        netAssets: converted.netAssets ?? [],
        dailyChange: converted.dailyChange ?? [],
        assets: converted.assets ?? [],
        liabilities: converted.liabilities ?? [],
        exchangeRateDates: [...usedDates].sort(),
        exchangeRateMissing: false,
      };
    }),
  };
}
