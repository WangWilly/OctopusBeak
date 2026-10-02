// Provider display labels and their ISO denominations form one source contract.
// Amount parsing and split-cell recognition derive their labels from this map.
const sourceCurrencyAliases: Readonly<Record<string, string>> = {
  台幣: "TWD", 新臺幣: "TWD", 新台幣: "TWD", 美元: "USD", 美金: "USD",
  日圓: "JPY", 歐元: "EUR", 港幣: "HKD", 澳幣: "AUD", 人民幣: "CNY",
  南非幣: "ZAR", 紐幣: "NZD", 英鎊: "GBP",
};
const sourceCurrencyLabels = new Set([
  ...Object.keys(sourceCurrencyAliases), ...Object.values(sourceCurrencyAliases),
]);
const currencyLabelPattern = [...sourceCurrencyLabels]
  .map(label => label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|");
const decimalPattern = "(?:\\d+|\\d{1,3}(?:,\\d{3})+)(?:\\.\\d+)?";
const amountCurrencyPattern = new RegExp(
  `^(?:(${currencyLabelPattern})\\s*${decimalPattern}|${decimalPattern}\\s*(${currencyLabelPattern}))$`, "u",
);

export function canonicalYuantaFundCurrency(value: string): string {
  const normalized = value.trim().toUpperCase();
  return sourceCurrencyAliases[normalized] ?? normalized;
}

export function isYuantaFundSourceCurrencyLabel(value: string): boolean {
  return sourceCurrencyLabels.has(value);
}

export function yuantaFundSourceAmountCurrency(value: string): string {
  // Source amounts may carry a denomination before or after the number.
  // Never borrow a fund's pricing currency when that label is missing.
  const match = amountCurrencyPattern.exec(value.trim());
  const label = match?.[1] ?? match?.[2];
  if (!label) throw new Error("YuanTa account history cash amount has no explicit source currency.");
  return canonicalYuantaFundCurrency(label);
}
