import type { CanonicalEInvoiceLineageQuery } from "./einvoice-query-contract.ts";
import type {
  SpendingPair,
  SpendingRefundView,
} from "./spending-recognition-contracts.ts";

export type {
  PurchaseOccurrence,
  PurchaseRecord,
  PurchaseReport,
  PurchaseReportRequest,
} from "./spending-purchase-report-core.ts";

export type PurchaseLineage = Readonly<{
  kind: "lineage";
  subject: SpendingPair | Readonly<{ stableRefundKey: string }>;
  invoice: CanonicalEInvoiceLineageQuery | null;
  recognition: readonly Readonly<Record<string, unknown>>[];
  refunds: readonly SpendingRefundView[];
}>;
