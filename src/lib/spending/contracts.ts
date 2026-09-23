import type { SpendingCategory } from "./categories.ts";

/** Inputs shared by the desktop Spending page and its read providers. */
export type SpendingLoadInput = {
  selectedMonth?: string;
  selectedCategory?: SpendingCategory | string;
};
