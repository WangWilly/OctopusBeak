import type { Locale } from "$lib/i18n/i18n.ts";
import type { CurrencyAmountDto } from "$lib/shared-ledger/types.ts";

/** A true minus sign, so a negative amount never reads as a hyphenated label. */
const MINUS = "−";

type AmountFormatOptions = Readonly<{ locale: Locale; signed?: boolean }>;
type ExactDecimal = Readonly<{ coefficient: string; scale: number }>;

function intlLocale(locale: Locale): string {
  return locale === "zh-TW" ? "zh-TW" : "en-US";
}

/** Whole units for TWD and JPY, cents for every other currency. */
function fractionDigits(currency: string): number {
  return currency === "TWD" || currency === "JPY" ? 0 : 2;
}

function withSign(digits: string, negative: boolean, zero: boolean, signed: boolean | undefined): string {
  if (zero) return digits;
  if (negative) return `${MINUS}${digits}`;
  return signed ? `+${digits}` : digits;
}

/** Round an exact decimal half-up to `digits` places and group it, sign excluded. */
function exactDigits(exact: ExactDecimal, digits: number, locale: Locale): Readonly<{ text: string; negative: boolean; zero: boolean }> | null {
  if (exact.scale < 0 || exact.scale > 10_000) return null;
  const coefficient = BigInt(exact.coefficient);
  const negative = coefficient < 0n;
  const absolute = negative ? -coefficient : coefficient;
  const unit = 10n ** BigInt(Math.max(exact.scale - digits, 0));
  const rounded = exact.scale > digits
    ? (absolute + unit / 2n) / unit
    : absolute * 10n ** BigInt(digits - exact.scale);
  const integer = rounded / 10n ** BigInt(digits);
  const fraction = digits === 0
    ? ""
    : `.${(rounded % 10n ** BigInt(digits)).toString().padStart(digits, "0")}`;
  const grouped = new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 0, useGrouping: true }).format(integer);
  return { text: `${grouped}${fraction}`, negative, zero: rounded === 0n };
}

/** An amount's digits in its currency's precision, e.g. `−19,410` or `+12.50`, without the currency code. */
export function formatAmount(
  value: number,
  currency: string,
  options: AmountFormatOptions,
  exact?: ExactDecimal,
): string {
  const digits = fractionDigits(currency);
  const fromExact = exact ? exactDigits(exact, digits, options.locale) : null;
  if (fromExact) return withSign(fromExact.text, fromExact.negative, fromExact.zero, options.signed);
  const scale = 10 ** digits;
  const rounded = Math.round(Math.abs(value) * scale) / scale;
  const text = new Intl.NumberFormat(intlLocale(options.locale), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(rounded);
  return withSign(text, value < 0, rounded === 0, options.signed);
}

/** An amount with its currency code, e.g. `TWD −1,234` or `USD +12.50`. */
export function formatMoney(amount: CurrencyAmountDto, options: AmountFormatOptions): string {
  return `${amount.currency} ${formatAmount(amount.value, amount.currency, options, amount.exact)}`;
}

/** Whole TWD with grouping, e.g. `−19,410` or, signed, `+1,860`. */
export function formatTwdNumber(value: number, locale: Locale, signed = false): string {
  return formatAmount(value, "TWD", { locale, signed });
}

export function formatTwd(value: number, locale: Locale): string {
  return formatMoney({ currency: "TWD", value }, { locale });
}

export function formatExactQuantity(exact: ExactDecimal, locale: Locale): string | null {
  const formatted = exactDigits(exact, exact.scale, locale);
  if (formatted === null) return null;
  const text = exact.scale === 0
    ? formatted.text
    : formatted.text.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return withSign(text, formatted.negative, formatted.zero, false);
}

export function formatAmountLines(amounts: CurrencyAmountDto[], locale: Locale) {
  if (amounts.length === 0) return "--";
  return amounts.map((amount) => formatMoney(amount, { locale })).join(" / ");
}

export function formatSignedAmountLines(amounts: CurrencyAmountDto[], locale: Locale) {
  if (amounts.length === 0) return "--";
  return amounts.map((amount) => formatMoney(amount, { locale, signed: true })).join(" / ");
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
