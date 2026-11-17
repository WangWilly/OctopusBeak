import type { PersonalCategoryCode } from "../../ledger/canonical/personal-category-codes.ts";
import {
  SPENDING_CATEGORY_GROUP_DEFAULT_CODE,
  SPENDING_CATEGORY_GROUP_IDS,
  spendingCategoryCodesForGroup,
  type SpendingCategoryGroup,
} from "./category-groups.ts";
import { byAmount, byMerchant, capped, matches, type ClassifyApplyTargets, type ClassifyMerchantGroup } from "./classify-queue.ts";
import type { SpendingClassifyQueueItem } from "./model.ts";

/**
 * The classification inbox's keyboard and row rules, kept apart from the
 * modal so they can be checked without a browser.
 */

/** Code keys, in order. They stop before j and k, which move between rows. */
export const CLASSIFY_CODE_KEYS = ["a", "b", "c", "d", "e", "f"] as const;

/** Keys 1–7 pick the groups in the order the Spending page shows them. */
export function classifyGroupKey(group: SpendingCategoryGroup): string {
  return String(SPENDING_CATEGORY_GROUP_IDS.indexOf(group) + 1);
}

/** A group's codes with its default first; the rest keep the published order. */
export function classifyGroupCodes(group: SpendingCategoryGroup): readonly PersonalCategoryCode[] {
  const fallback: PersonalCategoryCode = SPENDING_CATEGORY_GROUP_DEFAULT_CODE[group];
  return [fallback, ...spendingCategoryCodesForGroup(group).filter((code) => code !== fallback)];
}

export type ClassifyKeyCommand =
  | Readonly<{ kind: "move"; delta: 1 | -1 }>
  | Readonly<{ kind: "group"; group: SpendingCategoryGroup }>
  | Readonly<{ kind: "code"; code: PersonalCategoryCode }>
  | Readonly<{ kind: "apply" }>;

/**
 * What one key press asks for, given the group the picker shows. A code key
 * needs a picked group and names one of its codes; anything else is not the
 * inbox's key and stays with the browser.
 */
export function classifyKeyCommand(key: string, group: SpendingCategoryGroup | null): ClassifyKeyCommand | null {
  if (key === "ArrowDown" || key === "j") return { kind: "move", delta: 1 };
  if (key === "ArrowUp" || key === "k") return { kind: "move", delta: -1 };
  if (key === "Enter") return { kind: "apply" };
  const groupIndex = /^[1-9]$/u.test(key) ? Number(key) - 1 : -1;
  const pickedGroup = SPENDING_CATEGORY_GROUP_IDS[groupIndex];
  if (pickedGroup) return { kind: "group", group: pickedGroup };
  if (group === null) return null;
  const code = classifyGroupCodes(group)[CLASSIFY_CODE_KEYS.indexOf(key.toLowerCase() as never)];
  return code ? { kind: "code", code } : null;
}

/** The row a move lands on: the list's ends hold, and no current row starts at the first. */
export function movedKey(keys: readonly string[], current: string | null, delta: 1 | -1): string | null {
  if (keys.length === 0) return null;
  const index = current === null ? -1 : keys.indexOf(current);
  if (index < 0) return keys[0]!;
  return keys[Math.min(keys.length - 1, Math.max(0, index + delta))]!;
}

/**
 * Which row is current once the list changes, such as when an applied row
 * leaves: the same row while it stays, else the next one that stays, else
 * the nearest earlier one, else the first row.
 */
export function followingKey(before: readonly string[], after: readonly string[], current: string | null): string | null {
  const remaining = new Set(after);
  if (current !== null && remaining.has(current)) return current;
  const index = current === null ? -1 : before.indexOf(current);
  if (index >= 0) {
    const next = before.slice(index + 1).find((key) => remaining.has(key))
      ?? before.slice(0, index).reverse().find((key) => remaining.has(key));
    if (next !== undefined) return next;
  }
  return after[0] ?? null;
}

/** The inbox's period: the twelve months that end today, as inclusive `YYYY-MM-DD` dates. */
export function classifyPeriod(today: string): Readonly<{ startDate: string; endDate: string }> {
  const [year, month, day] = today.split("-").map(Number) as [number, number, number];
  const lastDay = new Date(Date.UTC(year - 1, month, 0)).getUTCDate();
  const start = new Date(Date.UTC(year - 1, month - 1, Math.min(day, lastDay) + 1));
  return { startDate: start.toISOString().slice(0, 10), endDate: today };
}

/** What the inbox shows: its order, the search box, and the 「只看」 merchant in 依金額. */
export type ClassifyView = Readonly<{ mode: "amount" | "merchant"; query: string; merchantKey: string | null }>;

/** A merchant row with the purchases it shows and writes, and how many of its purchases the search hides. */
export type ClassifyMerchantRow = Readonly<{ group: ClassifyMerchantGroup; members: readonly SpendingClassifyQueueItem[]; unmatched: number }>;

/** The control a write comes from: the current row's apply, or 「全部套用」. */
export type ClassifyControl = Readonly<{ kind: "current"; key: string }> | Readonly<{ kind: "search" }>;

function merchantPurchaseIds(items: readonly SpendingClassifyQueueItem[], key: string): ReadonlySet<string> {
  return new Set(byMerchant(items).find((group) => group.key === key)?.purchaseIds ?? []);
}

/** The 依金額 rows, largest first: the search's matches, inside 「只看」 when one is set. */
export function classifyAmountRows(items: readonly SpendingClassifyQueueItem[], view: ClassifyView): readonly SpendingClassifyQueueItem[] {
  const only = view.merchantKey === null ? null : merchantPurchaseIds(items, view.merchantKey);
  return byAmount(items).filter((item) => (only === null || only.has(item.purchaseId)) && matches(item, view.query));
}

/** The 依商家 rows: each group with a purchase the search matches, showing only those purchases. */
export function classifyMerchantRows(items: readonly SpendingClassifyQueueItem[], query: string): readonly ClassifyMerchantRow[] {
  const byId = new Map(items.map((item) => [item.purchaseId, item]));
  return byMerchant(items).flatMap((group) => {
    const members = group.purchaseIds.map((id) => byId.get(id)!).filter((item) => matches(item, query));
    return members.length === 0 ? [] : [{ group, members, unmatched: group.count - members.length }];
  });
}

/**
 * The purchases one control writes, which are always the purchases that
 * control shows: the current row's purchase or merchant members, or every
 * row 「全部套用」 covers. A blank search covers nothing.
 */
export function classifyWriteTargets(items: readonly SpendingClassifyQueueItem[], view: ClassifyView, control: ClassifyControl): ClassifyApplyTargets {
  if (control.kind === "search") {
    if (view.query.trim() === "") return capped([]);
    const merchantKey = view.mode === "amount" ? view.merchantKey : null;
    return capped(classifyAmountRows(items, { ...view, merchantKey }).map((item) => item.purchaseId));
  }
  if (view.mode === "amount")
    return capped(classifyAmountRows(items, view).some((item) => item.purchaseId === control.key) ? [control.key] : []);
  return capped(classifyMerchantRows(items, view.query).find((row) => row.group.key === control.key)?.members.map((item) => item.purchaseId) ?? []);
}

/** 「只看」 stays while its merchant has a queued purchase the write left, whether or not the search shows it. */
export function keepsMerchantFilter(items: readonly SpendingClassifyQueueItem[], view: ClassifyView, written: readonly string[]): boolean {
  if (view.merchantKey === null) return false;
  const left = new Set(merchantPurchaseIds(items, view.merchantKey));
  for (const id of written) left.delete(id);
  return left.size > 0;
}
