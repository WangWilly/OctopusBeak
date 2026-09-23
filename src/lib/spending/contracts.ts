import type { SpendingCategory } from "./categories.ts";
import type { SpendingReason, SpendingState } from "./model.ts";

/** Inputs shared by the desktop Spending page and its read providers. */
export type SpendingLoadInput = {
  selectedMonth?: string;
  selectedCategory?: SpendingCategory | string;
};

/** Legacy mutation contract retained while the SQLite fallback is available. */
export type SpendingOverrideUpdate =
  | { statementRowId: string; state: null }
  | {
    statementRowId: string;
    state: SpendingState;
    category: SpendingCategory | null;
    automaticState: SpendingState;
    automaticReason: SpendingReason | null;
  };
