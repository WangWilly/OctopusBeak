import type { CurrencyAmountDto } from "$lib/shared-ledger/types.ts";

export function formatMoney(
  amount: CurrencyAmountDto,
  options: { signed?: boolean; locale?: string } = {},
) {
  const digits = amount.currency === "JPY" || amount.currency === "TWD" ? 0 : 2;
  const exact = amount.exact
    ? formatExactAmount(amount.exact, digits, options.locale ?? "en-US")
    : null;
  const positive = amount.exact
    ? BigInt(amount.exact.coefficient) > 0n
    : amount.value > 0;
  const prefix = options.signed && positive ? "+" : "";
  const formatted = exact ?? new Intl.NumberFormat(options.locale ?? "en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(amount.value);
  return `${amount.currency} ${prefix}${formatted}`;
}

function formatExactAmount(
  exact: { coefficient: string; scale: number },
  digits: number,
  locale: string,
): string | null {
  if (exact.scale < 0 || exact.scale > 10_000) return null;
  const coefficient = BigInt(exact.coefficient);
  const negative = coefficient < 0n;
  const absolute = negative ? -coefficient : coefficient;
  const scale = exact.scale;
  const unit = 10n ** BigInt(Math.max(scale - digits, 0));
  const rounded = scale > digits
    ? (absolute + unit / 2n) / unit
    : absolute * 10n ** BigInt(digits - scale);
  const integer = rounded / 10n ** BigInt(digits);
  const fraction = digits === 0
    ? ""
    : `.${(rounded % 10n ** BigInt(digits)).toString().padStart(digits, "0")}`;
  const groupedInteger = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
    useGrouping: true,
  }).format(integer);
  return `${negative ? "-" : ""}${groupedInteger}${fraction}`;
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
