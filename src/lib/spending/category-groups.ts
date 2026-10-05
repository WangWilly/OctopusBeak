import {
  PERSONAL_CATEGORY_CODES,
  type PersonalCategoryCode,
} from "../../ledger/canonical/personal-category-codes.ts";

/**
 * Spending category groups (ADR 0038, Spending v2 plan decision 1): the
 * presentation-only rollup of every Personal Category code into one of the
 * seven groups the Spending page shows. The mapping is exhaustive over the
 * published codes, so a newly published code fails to compile until it is
 * placed. `other` holds registered codes outside the six named groups and is
 * distinct from the query-time Unclassified bucket, which is not a group.
 */
export const SPENDING_CATEGORY_GROUP_IDS = [
  "dining",
  "daily",
  "transport",
  "shopping",
  "home",
  "leisure",
  "other",
] as const;

export type SpendingCategoryGroup = (typeof SPENDING_CATEGORY_GROUP_IDS)[number];

export const SPENDING_CATEGORY_GROUP_BY_CODE: Readonly<Record<PersonalCategoryCode, SpendingCategoryGroup>> = Object.freeze({
  dining: "dining",
  alcohol_and_tobacco: "dining",
  food_and_groceries: "daily",
  personal_and_family_care: "daily",
  healthcare: "daily",
  transportation: "transport",
  clothing_and_footwear: "shopping",
  housing_and_utilities: "home",
  household_goods_and_services: "home",
  information_and_communication: "home",
  recreation_sports_and_culture: "leisure",
  travel: "leisure",
  insurance: "other",
  taxes_and_government: "other",
  gifts_and_donations: "other",
  work_and_business: "other",
  education: "other",
});

export function spendingCategoryGroup(code: PersonalCategoryCode): SpendingCategoryGroup {
  return SPENDING_CATEGORY_GROUP_BY_CODE[code];
}

/** The canonical codes a group expands to; the query layer filters by these. */
export function spendingCategoryCodesForGroup(group: SpendingCategoryGroup): readonly PersonalCategoryCode[] {
  return PERSONAL_CATEGORY_CODES.filter((code) => SPENDING_CATEGORY_GROUP_BY_CODE[code] === group);
}
