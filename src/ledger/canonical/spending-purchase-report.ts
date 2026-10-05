/** Pure purchase-report compatibility exports; persistence is PGlite-owned. */
export * from "./spending-purchase-report-core.ts";
export type { PurchaseLineage } from "./spending-purchase-contracts.ts";
export {
  calendarDayDistance,
  transactionPurchaseDate,
} from "../../lib/spending/purchase-matching.ts";
export { rankSpendingManualPaymentCandidates } from "./spending-manual-pairing.ts";
export type { SpendingManualPaymentCandidate } from "./spending-manual-pairing.ts";
