import {
  E_INVOICE_CONTRACT_VERSION,
  E_INVOICE_CURRENCY_AUTHORITY,
  E_INVOICE_ROUTE,
  buildCanonicalEInvoiceSourceEvidence,
  type CanonicalEInvoiceCaptureInput,
} from "./einvoice.ts";

export type AdvertisedEInvoiceReadinessEntry = Readonly<{
  sourceId: "einvoice";
  productId: "personal-invoices";
  workflow: "einvoicePersonalInvoices";
  authority: typeof E_INVOICE_ROUTE;
  contractVersion: typeof E_INVOICE_CONTRACT_VERSION;
  currencyAuthority: typeof E_INVOICE_CURRENCY_AUTHORITY;
  fixtureEvidence: "canonical-versioned-synthetic";
  admissionEvidence: "commitCanonicalEInvoiceCapture";
  queryEvidence: "current-historical-lineage";
  contractComplete: true;
  blockers: readonly [];
}>;

const EMPTY_FIXTURE: CanonicalEInvoiceCaptureInput = {
  captureId: "readiness-empty-complete-scope",
  sourceConnectionKey: "sha256:readiness-connection",
  identityEpoch: "sha256:readiness-epoch",
  subjectDigest: "sha256:readiness-subject",
  observedAt: "2026-01-01T00:00:00Z",
  scope: {
    startDate: "2026-01-01",
    endDate: "2026-01-01",
    kind: "point-in-time",
    completeness: "single-page",
    invoiceCompleteness: "complete",
    itemCompleteness: "complete",
    absenceAuthority: "provider-explicit-no-data",
  },
  pages: [
    {
      pageOrdinal: 0,
      responseCode: "204",
      rowCount: 0,
      terminal: true,
      metadata: { fixture: "einvoice-empty-complete-scope" },
    },
  ],
  invoices: [],
};

/** The manifest is executable: an invalid fixture cannot advertise readiness. */
export const ADVERTISED_E_INVOICE_READINESS: readonly AdvertisedEInvoiceReadinessEntry[] = Object.freeze([
  Object.freeze({
    sourceId: "einvoice" as const,
    productId: "personal-invoices" as const,
    workflow: "einvoicePersonalInvoices" as const,
    authority: E_INVOICE_ROUTE,
    contractVersion: E_INVOICE_CONTRACT_VERSION,
    currencyAuthority: E_INVOICE_CURRENCY_AUTHORITY,
    fixtureEvidence: "canonical-versioned-synthetic" as const,
    admissionEvidence: "commitCanonicalEInvoiceCapture" as const,
    queryEvidence: "current-historical-lineage" as const,
    contractComplete: true as const,
    blockers: [] as const,
  }),
]);

export function evaluateAdvertisedEInvoiceReadiness(
  entries: readonly AdvertisedEInvoiceReadinessEntry[] = ADVERTISED_E_INVOICE_READINESS,
): void {
  if (entries.length !== 1 || entries[0]?.sourceId !== "einvoice")
    throw new Error("Advertised E-Invoice readiness must contain exactly one canonical source.");
  const entry = entries[0]!;
  if (!entry.contractComplete || entry.blockers.length > 0)
    throw new Error("Advertised E-Invoice readiness contract is incomplete.");
  if (entry.authority !== E_INVOICE_ROUTE || entry.contractVersion !== E_INVOICE_CONTRACT_VERSION)
    throw new Error("Advertised E-Invoice readiness route/contract drifted.");
  buildCanonicalEInvoiceSourceEvidence(EMPTY_FIXTURE);
}

export function isAdvertisedEInvoiceEntryReleaseReady(
  entry: AdvertisedEInvoiceReadinessEntry,
): boolean {
  return entry.sourceId === "einvoice" &&
    entry.productId === "personal-invoices" &&
    entry.contractComplete === true &&
    entry.blockers.length === 0 &&
    entry.fixtureEvidence === "canonical-versioned-synthetic" &&
    entry.admissionEvidence === "commitCanonicalEInvoiceCapture" &&
    entry.queryEvidence === "current-historical-lineage";
}
