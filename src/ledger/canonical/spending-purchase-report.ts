import type { ValidatedCanonicalDatabase as DatabaseSync } from "./canonical-database.ts";
import {
  queryCanonicalSpendingCurrentFromDatabase,
  queryCanonicalSpendingHistoricalFromDatabase,
  type CanonicalSpendingTransaction,
} from "./canonical-categorization.ts";
import {
  queryCanonicalEInvoiceHistorical,
  queryCanonicalEInvoiceHistoricalFromDatabase,
  queryCanonicalEInvoiceLineage,
  type CanonicalEInvoiceLineageQuery,
  type CanonicalEInvoiceView,
} from "./einvoice.ts";
import {
  querySpendingRecognition,
  querySpendingRecognitionFromDatabase,
  querySpendingRecognitionLineage,
  querySpendingRefundLineage,
  recordSpendingMatchCandidate,
  type SpendingPair,
  type SpendingRefundView,
} from "./spending-recognition.ts";
import {
  assertValidatedCanonicalSourceStore,
  type CanonicalSourceStore,
} from "./canonical-source-store.ts";
import { withCanonicalSnapshot } from "./canonical-runtime.ts";
import {
  canonicalPurchasePair,
  canonicalPurchaseUuid,
  composePurchaseReport,
  evaluateSpendingMatchCandidates,
} from "./spending-purchase-report-core.ts";
import type { PurchaseReport, PurchaseReportRequest } from "./spending-purchase-report-core.ts";

export {
  canonicalPurchaseUuid,
  composePurchaseReport,
  emptyPurchaseReport,
  evaluateSpendingMatchCandidates,
} from "./spending-purchase-report-core.ts";
export type {
  PurchaseOccurrence,
  PurchaseRecord,
  PurchaseReport,
  PurchaseReportRequest,
} from "./spending-purchase-report-core.ts";

export {
  calendarDayDistance,
  rankSpendingManualPaymentCandidates,
  transactionPurchaseDate,
} from "../../lib/spending/purchase-matching.ts";
export type { SpendingManualPaymentCandidate } from "../../lib/spending/purchase-matching.ts";

/**
 * Inputs already read by a containing financial query. A current Spending
 * page needs both the canonical spending projection and the purchase report;
 * accepting those immutable snapshots here avoids reading the same invoices
 * and transactions a second time from the same SQLite snapshot.
 */
export type PurchaseReportDatabaseInputs = Readonly<{
  invoices?: readonly CanonicalEInvoiceView[];
  transactions?: readonly CanonicalSpendingTransaction[];
}>;

export type PurchaseLineage = Readonly<{
  kind: "lineage";
  subject: SpendingPair | Readonly<{ stableRefundKey: string }>;
  invoice: CanonicalEInvoiceLineageQuery | null;
  recognition: readonly Readonly<Record<string, unknown>>[];
  refunds: readonly SpendingRefundView[];
}>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

/** Explicit write command; callers choose when inferred candidates become durable. */
export function materializeSpendingMatchCandidates(
  store: CanonicalSourceStore,
  candidates: ReturnType<typeof evaluateSpendingMatchCandidates>,
): readonly Readonly<{ candidateId: string; commitSequence: number }>[] {
  return Object.freeze(candidates.map((candidate) => recordSpendingMatchCandidate(store, {
    ...candidate,
    ...canonicalPurchasePair(candidate),
  })));
}

function transactionSnapshot(db: DatabaseSync, request: PurchaseReportRequest, knowledgeAt: number) {
  if (request.kind === "current") return queryCanonicalSpendingCurrentFromDatabase(db).includedTransactions;
  return queryCanonicalSpendingHistoricalFromDatabase(db, {
    financialAt: "2999-12-31",
    knowledgeAt,
  }).includedTransactions;
}

export function queryPurchaseReport(store: CanonicalSourceStore, request: PurchaseReportRequest): PurchaseReport {
  assertValidatedCanonicalSourceStore(store);
  return withCanonicalSnapshot(store.db, () => queryPurchaseReportFromDatabase(store.db, request));
}

/** Compose the complete Spending report from one caller-owned read snapshot. */
export function queryPurchaseReportFromDatabase(
  db: DatabaseSync,
  request: PurchaseReportRequest,
  inputs: PurchaseReportDatabaseInputs = {},
): PurchaseReport {
  if (request.startDate && !ISO_DATE.test(request.startDate)) throw new Error("Purchase report startDate is invalid.");
  if (request.endDate && !ISO_DATE.test(request.endDate)) throw new Error("Purchase report endDate is invalid.");
  if (request.financialAt && !ISO_DATE.test(request.financialAt)) throw new Error("Purchase report financialAt is invalid.");
  const latest = Number((db.prepare("SELECT COALESCE(MAX(commit_sequence), 0) value FROM canonical_commits").get() as { value: number }).value);
  const knowledgeAt = request.kind === "historical" ? request.knowledgeAt : latest;
  if (!Number.isSafeInteger(knowledgeAt) || knowledgeAt! < 0 || knowledgeAt! > latest)
    throw new Error("Purchase report knowledgeAt is invalid.");
  const invoices = inputs.invoices ?? queryCanonicalEInvoiceHistoricalFromDatabase(db, { knowledgeAt: knowledgeAt! }).invoices;
  const recognition = querySpendingRecognitionFromDatabase(db, { knowledgeAt: knowledgeAt! });
  const transactions = inputs.transactions ?? transactionSnapshot(db, request, knowledgeAt!);
  return composePurchaseReport({ request, knowledgeAt: knowledgeAt!, invoices, transactions, recognition });
}

export function queryPurchaseLineage(store: CanonicalSourceStore, subject: PurchaseLineage["subject"]): PurchaseLineage {
  if ("stableRefundKey" in subject)
    return { kind: "lineage", subject, invoice: null, recognition: [], refunds: querySpendingRefundLineage(store, subject.stableRefundKey) };
  const canonicalSubject = canonicalPurchasePair(subject);
  const current = queryCanonicalEInvoiceHistorical(store, {
    knowledgeAt: Number((store.db.prepare("SELECT COALESCE(MAX(commit_sequence), 0) value FROM canonical_commits").get() as { value: number }).value),
  }).invoices.find((item) => canonicalPurchaseUuid(item.invoiceId) === canonicalSubject.invoiceId);
  const invoice = current ? queryCanonicalEInvoiceLineage(store, {
    sourceConnectionKey: current.identity.sourceConnectionKey,
    identityEpoch: current.identity.identityEpoch,
    subjectDigest: current.identity.subjectDigest,
    stableInvoiceKey: current.stableInvoiceKey,
  }) : null;
  return {
    kind: "lineage",
    subject: canonicalSubject,
    invoice,
    recognition: querySpendingRecognitionLineage(store, canonicalSubject),
    refunds: [],
  };
}
