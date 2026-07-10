import type { CurrencyAmountDto } from "$lib/shared-ledger/types.ts";

export function formatMoney(
  amount: CurrencyAmountDto,
  options: { signed?: boolean; locale?: string } = {},
) {
  const digits = amount.currency === "JPY" || amount.currency === "TWD" ? 0 : 2;
  const prefix = options.signed && amount.value > 0 ? "+" : "";
  return `${amount.currency} ${prefix}${new Intl.NumberFormat(options.locale ?? "en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(amount.value)}`;
}

export function formatAmountLines(amounts: CurrencyAmountDto[]) {
  if (amounts.length === 0) return "--";
  return amounts.map((amount) => formatMoney(amount)).join(" / ");
}

export function formatSignedAmountLines(amounts: CurrencyAmountDto[]) {
  if (amounts.length === 0) return "--";
  return amounts.map((amount) => formatMoney(amount, { signed: true })).join(" / ");
}

export function primaryAmount(amounts: CurrencyAmountDto[]) {
  return amounts.find((amount) => amount.currency === "TWD") ?? amounts[0] ?? null;
}

export function amountValue(amounts: CurrencyAmountDto[]) {
  return Math.abs(primaryAmount(amounts)?.value ?? 0);
}

export function sumAmounts(amounts: CurrencyAmountDto[][], currency: string) {
  const value = amounts
    .flat()
    .filter((amount) => amount.currency === currency)
    .reduce((total, amount) => total + amount.value, 0);
  return Math.abs(value) > 0.000001 ? [{ currency, value }] : [];
}

export function currencyCount(amounts: CurrencyAmountDto[][]) {
  return new Set(amounts.flat().map((amount) => amount.currency)).size;
}
