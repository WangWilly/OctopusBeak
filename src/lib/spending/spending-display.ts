import type { Translation } from "../i18n/i18n.ts";
import { institutionForNamespace } from "../institutions/institutions.ts";
import { isPersonalCategoryCode, type PersonalCategoryCode } from "../../ledger/canonical/personal-category-codes.ts";
import { spendingCategoryGroup } from "./category-groups.ts";
import type { SpendingCandidateReasons } from "./model.ts";
import {
  calendarDayDistance,
  transactionPurchaseDate,
  type SpendingPaymentSourceView,
  type SpendingPurchaseRecordView as PurchaseRecord,
} from "./purchase-matching.ts";
import type { CategoryBreakdownKey } from "./spending-insights.ts";

/**
 * Data Series hues for the display groups (DESIGN.md: food, daily, transport,
 * shopping, home, leisure, other). Unclassified is not a series: it reads as
 * a muted neutral so it never passes for a category.
 */
export const SPENDING_GROUP_COLORS: Readonly<Record<CategoryBreakdownKey, string>> = Object.freeze({
  dining: "var(--spending-food, oklch(52% 0.11 250))",
  daily: "var(--spending-daily, oklch(52% 0.09 170))",
  transport: "var(--spending-transport, oklch(56% 0.1 70))",
  shopping: "var(--spending-shopping, oklch(53% 0.08 320))",
  home: "var(--spending-home, oklch(50% 0.07 35))",
  leisure: "var(--spending-leisure, oklch(49% 0.06 215))",
  other: "var(--spending-other, oklch(46% 0.035 250))",
  unclassified: "color-mix(in oklch, var(--muted) 45%, var(--border))",
});

export function groupLabel(t: Translation, key: CategoryBreakdownKey): string {
  return key === "unclassified" ? t.spending.unclassifiedCategory : t.spending.categoryGroups[key];
}

export function codeLabel(t: Translation, code: PersonalCategoryCode): string {
  return t.spending.personalCategories[code];
}

function groupOfCode(code: string): CategoryBreakdownKey {
  return isPersonalCategoryCode(code) ? spendingCategoryGroup(code) : "other";
}

/** The groups a purchase's category touches, largest first; Unclassified when absent. */
export function recordGroups(record: Pick<PurchaseRecord, "category">): readonly CategoryBreakdownKey[] {
  const category = record.category;
  if (category.mode === "absent") return ["unclassified"];
  if (category.mode === "single") return [groupOfCode(category.categoryCode)];
  const ordered = [...category.components]
    .sort((left, right) => Number(right.amount.coefficient) / 10 ** right.amount.scale - Number(left.amount.coefficient) / 10 ** left.amount.scale)
    .map((component) => groupOfCode(component.categoryCode));
  return [...new Set(ordered)];
}

export function recordCategoryText(t: Translation, record: Pick<PurchaseRecord, "category">): string {
  const groups = recordGroups(record);
  if (record.category.mode === "split" && groups.length > 1)
    return t.spendingReview.splitCategory(groups.map((group) => groupLabel(t, group)).join("、"));
  return groupLabel(t, groups[0] ?? "unclassified");
}

/** The single code a purchase carries, for the picker's current choice. */
export function recordCategoryCode(record: Pick<PurchaseRecord, "category">): string | null {
  return record.category.mode === "single" ? record.category.categoryCode : null;
}

export function recordMerchant(t: Translation, record: PurchaseRecord): string {
  return record.description
    ?? record.invoice?.revision.seller.name
    ?? record.transaction?.description
    ?? t.purchaseSpending.merchantUnavailable;
}

function lastFour(source: SpendingPaymentSourceView | null): string | null {
  const digits = source?.cardMask?.slice(-4) ?? "";
  return /^\d{4}$/u.test(digits) ? digits : null;
}

function institutionName(t: Translation, source: SpendingPaymentSourceView | null): string | null {
  const key = institutionForNamespace(source?.institution);
  return key ? t.institutions[key] : null;
}

/** 玉山銀行信用卡 末碼 5512, 台北富邦銀行帳戶扣款, or the stream when the institution is unknown. */
export function paymentText(
  t: Translation,
  transaction: Readonly<{ stream: string }>,
  source: SpendingPaymentSourceView | null,
  withMask = true,
): string {
  const card = transaction.stream === "credit-card";
  const institution = institutionName(t, source);
  if (!institution) return card ? t.spendingReview.unknownCard : t.spendingReview.unknownAccount;
  return card
    ? t.spendingReview.cardPayment(institution, withMask ? lastFour(source) : null)
    : t.spendingReview.accountPayment(institution);
}

/** The row's 「category · payment method」 second half. */
export function paymentMethodText(t: Translation, record: PurchaseRecord): string {
  if (record.basis === "refund") return t.spendingReview.refund;
  if (record.basis === "linked" && record.transaction)
    return t.spendingReview.mergedPayment(paymentText(t, record.transaction, record.paymentSource, false));
  if (record.transaction) return paymentText(t, record.transaction, record.paymentSource);
  return t.spendingReview.einvoice;
}

export type MatchReasons = Readonly<{
  amountEqual: boolean;
  dayDistance: number | null;
  merchantMatch: boolean;
}>;

export function reasonTexts(t: Translation, reasons: MatchReasons): readonly string[] {
  const texts: string[] = [];
  if (reasons.amountEqual) texts.push(t.spendingReview.amountEqual);
  if (reasons.dayDistance !== null && Number.isFinite(reasons.dayDistance))
    texts.push(reasons.dayDistance === 0 ? t.spendingReview.sameDay : t.spendingReview.daysApart(reasons.dayDistance));
  if (reasons.merchantMatch) texts.push(t.spendingReview.merchantMatch);
  return texts;
}

function isCandidateReasons(value: unknown): value is SpendingCandidateReasons {
  if (!value || typeof value !== "object") return false;
  const reasons = value as Record<string, unknown>;
  return reasons.amountEqual === true && typeof reasons.dayDistance === "number" && typeof reasons.merchantMatch === "boolean";
}

/**
 * Why a merged purchase's two sources were one: the reasons recorded with the
 * decision when it carried them, otherwise only what both sides still show.
 * Merchant similarity is never re-derived here.
 */
export function mergedReasons(record: PurchaseRecord): MatchReasons | null {
  if (record.basis !== "linked" || !record.transaction) return null;
  const recorded = record.link?.evidence.reasons;
  if (isCandidateReasons(recorded)) return recorded;
  const invoiceDate = record.invoice?.revision.occurrence.value ?? record.occurrence.value;
  const paymentDate = transactionPurchaseDate(record.transaction);
  const distance = calendarDayDistance(invoiceDate, paymentDate.value);
  return {
    amountEqual: record.difference ? record.difference.exactAmountEqual : false,
    dayDistance: paymentDate.basis === "posting-date-fallback" || !Number.isFinite(distance) ? null : distance,
    merchantMatch: false,
  };
}

/** `M/D` from an ISO date or date-time. */
export function monthDayText(value: string): string {
  return `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}`;
}

/** `HH:mm` when the value carries a time; occurrence precision decides whether it is shown. */
export function timeOfDay(value: string): string | null {
  return value.match(/T(\d{2}:\d{2})/u)?.[1] ?? null;
}

export function fullDateText(value: string): string {
  return `${Number(value.slice(0, 4))}/${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}`;
}

/** 2026/10/3 18:21 at minute precision, 2026/10/3 otherwise. */
export function purchaseTimeText(occurrence: PurchaseRecord["occurrence"]): string {
  const time = occurrence.precision === "date" ? null : timeOfDay(occurrence.value);
  return time ? `${fullDateText(occurrence.value)} ${time}` : fullDateText(occurrence.value);
}

/** 10月5日 週一 / Mon, Oct 5 */
export function dayHeadingText(date: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: "long", day: "numeric", weekday: "short", timeZone: "UTC" })
    .format(new Date(`${date.slice(0, 10)}T00:00:00Z`));
}

/** 2026年10月3日 週六 / Sat, Oct 3, 2026 */
export function longDateText(date: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", day: "numeric", weekday: "short", timeZone: "UTC" })
    .format(new Date(`${date.slice(0, 10)}T00:00:00Z`));
}

export function monthText(month: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1)));
}

export function shortMonthText(month: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" })
    .format(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1)));
}

/** 8/1–9/30 for a billing period. */
export function periodText(period: Readonly<{ start: string; end: string }>): string {
  return `${monthDayText(period.start)}–${monthDayText(period.end)}`;
}

/** Share as 29.1% in the reader's locale. */
export function shareText(share: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(share);
}

/** The merged decision's `M/D HH:mm` in the ledger's calendar. */
export function decidedAtText(decidedAt: string, timeZone = "Asia/Taipei"): string {
  const parsed = new Date(decidedAt);
  if (Number.isNaN(parsed.getTime())) return decidedAt;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(parsed);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${Number(part("month"))}/${Number(part("day"))} ${part("hour")}:${part("minute")}`;
}
