import type { PersonalCategoryCode } from "../../ledger/canonical/personal-category-codes.ts";
import {
  SPENDING_CATEGORY_GROUP_DEFAULT_CODE,
  SPENDING_CATEGORY_GROUP_IDS,
  spendingCategoryCodesForGroup,
  type SpendingCategoryGroup,
} from "./category-groups.ts";

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
