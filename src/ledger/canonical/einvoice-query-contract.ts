import {
  E_INVOICE_INTEGRATION_NAMESPACE,
  E_INVOICE_RECORD_KIND,
  E_INVOICE_STREAM,
  type CanonicalEInvoiceLineageRequest,
  type CanonicalEInvoiceOccurrence,
  type CanonicalEInvoiceProvenance,
  type CanonicalEInvoiceRevisionKind,
} from "./einvoice-contract.ts";

export type CanonicalEInvoiceMoneyView = Readonly<{
  coefficient: string;
  scale: number;
  currency: "TWD";
  currencyAuthority: string;
}>;

export type CanonicalEInvoiceItemView = Readonly<{
  itemId: string;
  sequence: number;
  completeness: "complete" | "incomplete";
  name: string | null;
  quantity: { coefficient: string; scale: number } | null;
  unitPrice: CanonicalEInvoiceMoneyView | null;
  amount: CanonicalEInvoiceMoneyView | null;
  sourceFacts: Record<string, unknown>;
}>;

export type CanonicalEInvoiceRevisionView = Readonly<{
  revisionId: string;
  sourceRevisionKey: string;
  revisionNumber: number;
  revisionKind: CanonicalEInvoiceRevisionKind;
  state: "active" | "revoked";
  invoiceNumber: string;
  randomNumber: string | null;
  seller: { taxId: string; name: string | null };
  total: CanonicalEInvoiceMoneyView | null;
  occurrence: CanonicalEInvoiceOccurrence;
  authority: { routeKey: string; contractVersion: string };
  provenance: CanonicalEInvoiceProvenance;
  revocationReason: string | null;
  captureId: string;
  captureKey: string;
  sourceRecordId: string;
  commitSequence: number;
  items: readonly CanonicalEInvoiceItemView[];
}>;

export type CanonicalEInvoiceView = Readonly<{
  invoiceId: string;
  stableInvoiceKey: string;
  identity: {
    integrationNamespace: typeof E_INVOICE_INTEGRATION_NAMESPACE;
    sourceConnectionKey: string;
    identityEpoch: string;
    stream: typeof E_INVOICE_STREAM;
    recordKind: typeof E_INVOICE_RECORD_KIND;
    subjectDigest: string;
  };
  revision: CanonicalEInvoiceRevisionView;
}>;

export type CanonicalEInvoiceCurrentQuery = Readonly<{
  kind: "current";
  knowledgeAt: number;
  invoices: readonly CanonicalEInvoiceView[];
}>;

export type CanonicalEInvoiceHistoricalQuery = Readonly<{
  kind: "historical";
  knowledgeAt: number;
  invoices: readonly CanonicalEInvoiceView[];
}>;

export type CanonicalEInvoiceLineageObservation = Readonly<{
  revisionId: string;
  sourceRecordId: string;
  captureId: string;
  captureKey: string;
  commitSequence: number;
}>;

export type CanonicalEInvoiceLineageEvent = Readonly<{
  eventId: string;
  invoiceId: string;
  revisionId: string;
  sourceRecordId: string;
  captureId: string;
  captureKey: string;
  commitSequence: number;
  kind: "issued" | "revised" | "revoked" | "observed" | "superseded";
  eventAt: string;
  reason: string | null;
}>;

export type CanonicalEInvoiceLineageQuery = Readonly<{
  kind: "lineage";
  identity: CanonicalEInvoiceLineageRequest;
  invoice: CanonicalEInvoiceView | null;
  revisions: readonly CanonicalEInvoiceView[];
  observations: readonly CanonicalEInvoiceLineageObservation[];
  events: readonly CanonicalEInvoiceLineageEvent[];
  provenanceComplete: boolean;
}>;
