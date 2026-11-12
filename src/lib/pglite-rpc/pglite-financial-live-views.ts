import type { PGliteFinancialOperation, PGliteFinancialResult } from "./pglite-financial-contracts.ts";

/**
 * The Financial operations main publishes as live views. Main's view table
 * must define exactly these, so the renderer can type a view without naming
 * main-process code.
 */
export const FINANCIAL_LIVE_VIEW_NAMES = [
  "financial.overview.current",
  "financial.assets.current",
  "financial.liabilities.current",
  "financial.spending.current",
  "financial.cashFlow.current",
] as const satisfies readonly PGliteFinancialOperation[];

export type PGliteFinancialLiveView = (typeof FINANCIAL_LIVE_VIEW_NAMES)[number];

/** The DTO each live view publishes: the result of the operation it loads. */
export type FinancialLiveViewDtos = {
  readonly [View in PGliteFinancialLiveView]: PGliteFinancialResult<View>;
};
