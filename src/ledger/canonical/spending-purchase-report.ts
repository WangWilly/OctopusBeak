/** Pure purchase-report compatibility exports; persistence is PGlite-owned. */
export * from "./spending-purchase-report-core.ts";
export type { PurchaseLineage } from "./spending-purchase-contracts.ts";
export {
  calendarDayDistance,
  rankSpendingManualPaymentCandidates,
  transactionPurchaseDate,
} from "../../lib/spending/purchase-matching.ts";
export type { SpendingManualPaymentCandidate } from "../../lib/spending/purchase-matching.ts";
