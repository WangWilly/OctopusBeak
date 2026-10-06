import type { Locale } from "../i18n/i18n.ts";
import type { AssetCategory } from "../shared-ledger/twd-valuation.ts";
import type { AccountKind } from "../shared-ledger/types.ts";

const MINUS = "−";

/** DESIGN.md Data Series, by name. */
const SERIES = {
  blue: "oklch(52% 0.11 250)",
  green: "oklch(52% 0.09 170)",
  ochre: "oklch(56% 0.1 70)",
  plum: "oklch(53% 0.08 320)",
  clay: "oklch(50% 0.07 35)",
  teal: "oklch(49% 0.06 215)",
  slate: "oklch(46% 0.035 250)",
} as const;

export const ASSET_CATEGORY_COLOR: Record<AssetCategory, string> = {
  bank: SERIES.blue,
  fund: SERIES.green,
  brokerage: SERIES.ochre,
  crypto: SERIES.plum,
  foreign: SERIES.clay,
  other: SERIES.teal,
};

export function liabilityColor(kind: AccountKind): string {
  return kind === "loan" ? SERIES.slate : kind === "credit-card" ? SERIES.clay : SERIES.teal;
}

function intlLocale(locale: Locale): string {
  return locale === "zh-TW" ? "zh-TW" : "en-US";
}

/** Whole TWD with grouping and a true minus sign, e.g. `−19,410` or `+1,860`. */
export function formatTwdNumber(value: number, locale: Locale, signed = false): string {
  const rounded = Math.round(value);
  const digits = new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: 0 }).format(Math.abs(rounded));
  if (rounded < 0) return `${MINUS}${digits}`;
  return signed && rounded > 0 ? `+${digits}` : digits;
}

export function formatTwd(value: number, locale: Locale): string {
  return `TWD ${formatTwdNumber(value, locale)}`;
}

/** Signed percentage, e.g. `+0.3%` or `−2.4%`. */
export function formatPct(ratio: number, locale: Locale, digits = 1): string {
  const value = new Intl.NumberFormat(intlLocale(locale), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Math.abs(ratio * 100));
  if (Number(value.replace(/[^\d.]/gu, "")) === 0) return `${value}%`;
  return `${ratio < 0 ? MINUS : "+"}${value}%`;
}

/** Unsigned share, e.g. `36.9%`. */
export function formatShare(ratio: number, locale: Locale): string {
  return `${new Intl.NumberFormat(intlLocale(locale), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(ratio * 100)}%`;
}

/** Rates and implied prices keep enough precision to show a small move. */
export function formatPrice(value: number, locale: Locale): string {
  const digits = Math.abs(value) >= 1000 ? 0 : Math.abs(value) >= 10 ? 2 : 4;
  return new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
}

export function formatCompact(value: number, locale: Locale): string {
  return new Intl.NumberFormat(intlLocale(locale), { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function utcDate(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

/** `10/4` in zh-TW, `Oct 4` in English. */
export function formatShortDate(date: string, locale: Locale): string {
  if (locale === "zh-TW") {
    const [, month, day] = date.split("-").map(Number);
    return `${month}/${day}`;
  }
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(utcDate(date));
}

/** `10/5 週一` in zh-TW, `Mon, Oct 5` in English. */
export function formatDayWithWeekday(date: string, locale: Locale): string {
  const weekday = new Intl.DateTimeFormat(intlLocale(locale), { weekday: "short", timeZone: "UTC" }).format(utcDate(date));
  return locale === "zh-TW" ? `${formatShortDate(date, locale)} ${weekday}` : `${weekday}, ${formatShortDate(date, locale)}`;
}

/** `6月` in zh-TW, `Jun` in English. */
export function formatMonth(date: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { month: "short", timeZone: "UTC" }).format(utcDate(date));
}

export function currencyName(code: string, locale: Locale): string | null {
  try {
    const name = new Intl.DisplayNames([intlLocale(locale)], { type: "currency" }).of(code);
    return name && name !== code ? name : null;
  } catch {
    return null;
  }
}

/**
 * The tail of an account label is the provider's account number. Only its
 * last four digits are shown, so a full number never reaches the overview.
 */
export function maskedAccountDigits(label: string): string | null {
  const identifier = label.split(" · ")[2] ?? "";
  const digits = identifier.replace(/\D/gu, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}
