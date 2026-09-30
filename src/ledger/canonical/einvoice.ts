/**
 * Compatibility exports for the pure E-Invoice admission and query contracts.
 * SQLite persistence has moved out of the canonical runtime.
 */
export * from "./einvoice-contract.ts";
export type {
  CanonicalEInvoiceCurrentQuery,
  CanonicalEInvoiceHistoricalQuery,
  CanonicalEInvoiceItemView,
  CanonicalEInvoiceLineageEvent,
  CanonicalEInvoiceLineageObservation,
  CanonicalEInvoiceLineageQuery,
  CanonicalEInvoiceMoneyView,
  CanonicalEInvoiceRevisionView,
  CanonicalEInvoiceView,
} from "./einvoice-query-contract.ts";
