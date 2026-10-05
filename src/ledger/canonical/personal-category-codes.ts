/**
 * Published first-version Personal Category codes. This module has no runtime
 * imports so the renderer and the taxonomy package share one code list.
 */
export const PERSONAL_CATEGORY_CODES = [
  "food_and_groceries",
  "dining",
  "alcohol_and_tobacco",
  "clothing_and_footwear",
  "housing_and_utilities",
  "household_goods_and_services",
  "healthcare",
  "transportation",
  "travel",
  "information_and_communication",
  "recreation_sports_and_culture",
  "education",
  "personal_and_family_care",
  "insurance",
  "taxes_and_government",
  "gifts_and_donations",
  "work_and_business",
] as const;

export type PersonalCategoryCode = (typeof PERSONAL_CATEGORY_CODES)[number];

const codeSet: ReadonlySet<string> = new Set(PERSONAL_CATEGORY_CODES);

export function isPersonalCategoryCode(value: unknown): value is PersonalCategoryCode {
  return typeof value === "string" && codeSet.has(value);
}
