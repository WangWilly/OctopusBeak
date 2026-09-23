import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync as NodeDatabaseSync } from "node:sqlite";
import { channel } from "node:diagnostics_channel";
import { DEFAULT_LEDGER_DIR } from "../../../ledger/db/client.ts";
import {
  createCanonicalSourceStore,
  type CanonicalSourceStore,
} from "../../../ledger/canonical/canonical-source-store.ts";
import { canonicalDatabaseWriterKey } from "../../../ledger/canonical/canonical-database.ts";
import {
  confirmSpendingDedupLink,
  denySpendingDedupCandidate,
  querySpendingRecognition,
  querySpendingRecognitionFromDatabase,
  recordSpendingMatchCandidate,
  revokeSpendingDedupLink,
} from "../../../ledger/canonical/spending-recognition.ts";
import {
  composePurchaseReport,
  evaluateSpendingMatchCandidates,
  type PurchaseReport,
} from "../../../ledger/canonical/spending-purchase-report.ts";
import {
  type SpendingRecognitionSnapshot,
} from "../../../ledger/canonical/spending-recognition.ts";
import type { SpendingCategory } from "../categories.ts";
import type { SpendingLoadInput, SpendingOverrideUpdate } from "../contracts.ts";
export type { SpendingLoadInput, SpendingOverrideUpdate } from "../contracts.ts";
import type {
  SpendingCandidateActionInput,
  SpendingConfirmActionInput,
  SpendingPairingCandidatesInput,
  SpendingPairingCandidatesResult,
  SpendingPairingPrewarmInput,
  SpendingPairingPrewarmResult,
  SpendingLinkActionInput,
  SpendingPageDto,
  SpendingPurchaseReportDto,
  SpendingPurchaseActionResult,
  SpendingReason,
  SpendingState,
  CanonicalSpendingAmountDto,
  CanonicalSpendingCategoryDto,
  CanonicalSpendingRecordDto,
  CanonicalSpendingView,
} from "../model.ts";
import { createSpendingPurchaseReportPatch } from "../purchase-report-patch.ts";
import {
  exactMoneyEqual,
  rankSpendingManualPaymentCandidates,
  type SpendingMatchingInvoice,
  type SpendingPurchaseTransactionView,
} from "../purchase-matching.ts";
import { createSpendingPairingCandidateViewFromTransaction } from "../pairing-presentation.ts";
import {
  SpendingPairingIndexCache,
  spendingPairingIndexEntryForTransaction,
  type SpendingPairingIndexEntry,
} from "../pairing-index.ts";
import {
  createFinancialQuery,
  queryCurrentSpendingFromDatabase,
  type CurrentSpendingQueryResult,
} from "../../shared-ledger/server/financial-query.ts";
import { exactToNumber } from "../../shared-money/exact.ts";
import type {
  CanonicalSpendingReport,
  CanonicalSpendingTransaction,
} from "../../../ledger/canonical/canonical-categorization.ts";
import {
  queryCanonicalEInvoiceByIdFromDatabase,
  type CanonicalEInvoiceView,
} from "../../../ledger/canonical/einvoice.ts";
import {
  TRANSACTION_TAXONOMY_PACKAGE_V1,
} from "../../../ledger/canonical/transaction-taxonomy.ts";
import type { SpendingInvoiceDto, SpendingItemDto } from "../model.ts";

const LOCAL_SPENDING_USER_ID = "local-user";
const fullProjectionDiagnostics = channel("octopus-beak.spending.full-projection");
const storeOpenDiagnostics = channel("octopus-beak.spending.canonical-store-open");
const fullReportComposeDiagnostics = channel("octopus-beak.spending.full-report-compose");
const pairingIndexCaches = new Map<string, SpendingPairingIndexCache>();
let latestSpendingQuery: Readonly<{ ledgerDir: string; query: CurrentSpendingQueryResult }> | null = null;
type DirectPairingReportContext = NonNullable<Extract<SpendingConfirmActionInput, { kind: "direct" }>["pairingReportContext"]>;

function pairingProgress(stage: string, startedAt: number): void {
  if (process.env.PAIRING_BENCHMARK_PROGRESS === "1")
    console.error(`[pairing-worker] ${stage}: ${(performance.now() - startedAt).toFixed(1)}ms`);
}

export type SpendingCandidateDecisionInput = SpendingCandidateActionInput;
export type SpendingLinkRevokeInput = SpendingLinkActionInput;

function taxonomyLabels(
  code: string | null | undefined,
  taxonomyId: string | null | undefined,
  taxonomyVersion: string | null | undefined,
): { en: string; zhHant: string } | null {
  if (!code || taxonomyId !== TRANSACTION_TAXONOMY_PACKAGE_V1.packageId || taxonomyVersion !== TRANSACTION_TAXONOMY_PACKAGE_V1.version) return null;
  const definition = TRANSACTION_TAXONOMY_PACKAGE_V1.categories.find((candidate) => candidate.code === code);
  if (!definition) return null;
  const labels = TRANSACTION_TAXONOMY_PACKAGE_V1.localizations[definition.localizationKey];
  return labels?.en && labels["zh-Hant"]
    ? { en: labels.en, zhHant: labels["zh-Hant"] }
    : null;
}

function canonicalAmount(
  value: Readonly<{ currency: string; coefficient: string; scale: number }>,
): CanonicalSpendingAmountDto {
  const exact = { coefficient: value.coefficient, scale: value.scale };
  return { currency: value.currency, exact, value: exactToNumber(exact) };
}

function canonicalCategory(
  value: CanonicalSpendingTransaction["categorization"],
): CanonicalSpendingCategoryDto {
  if (value.mode === "absent") {
    return {
      mode: "absent",
      code: null,
      taxonomyId: null,
      taxonomyVersion: null,
      labels: null,
      components: [],
    };
  }
  if (value.mode === "single") {
    return {
      mode: "single",
      code: value.categoryCode ?? null,
      taxonomyId: value.taxonomyId ?? null,
      taxonomyVersion: value.taxonomyVersion ?? null,
      labels: taxonomyLabels(value.categoryCode, value.taxonomyId, value.taxonomyVersion),
      components: [],
    };
  }
  return {
    mode: "allocated",
    code: null,
    taxonomyId: value.taxonomyId ?? null,
    taxonomyVersion: value.taxonomyVersion ?? null,
    labels: null,
    components: (value.components ?? []).map((component) => ({
      code: component.categoryCode,
      taxonomyId: component.taxonomyId,
      taxonomyVersion: component.taxonomyVersion,
      labels: taxonomyLabels(component.categoryCode, component.taxonomyId, component.taxonomyVersion),
      amount: canonicalAmount({
        currency: component.currency,
        coefficient: component.coefficient,
        scale: component.scale,
      }),
    })),
  };
}

function canonicalRecord(
  transaction: CanonicalSpendingTransaction,
): CanonicalSpendingRecordDto {
  const dateBasis = transaction.effectiveDateBasis ??
    (transaction.stream === "credit-card" ? "posting-date-fallback" : "effective-date");
  return {
    transactionId: transaction.transactionId,
    accountId: transaction.accountId,
    accountNumber: transaction.accountNumber,
    sourceConnectionKey: transaction.sourceConnectionKey,
    integrationNamespace: transaction.integrationNamespace,
    stream: transaction.stream,
    date: transaction.effectiveOn,
    dateBasis,
    consumeDate: transaction.consumeDate ?? null,
    postingDate: transaction.postingDate ?? null,
    description: transaction.description,
    amount: canonicalAmount(transaction.amount),
    kind: transaction.kind,
    category: canonicalCategory(transaction.categorization),
    display: {
      label: transaction.display.status === "absent" ? null : transaction.display.value,
      status: transaction.display.status,
      origin: transaction.display.status === "absent" ? null : transaction.display.origin,
      kind: transaction.display.status === "absent" ? null : transaction.display.displayKind ?? null,
    },
    tags: transaction.tags.map((tag) => ({ id: tag.tagId, label: tag.label })),
    inclusion: transaction.inclusion,
    eligibilityGap: transaction.eligibilityGap ?? null,
  };
}

function canonicalView(
  report: CanonicalSpendingReport,
  selectedMonth: string | undefined,
  selectedCategory: string | undefined,
): CanonicalSpendingView {
  const records = report.transactions.map(canonicalRecord);
  const included = report.includedTransactions.map(canonicalRecord);
  const months = [...new Set(records
    .filter((record) => record.inclusion !== "excluded")
    .map((record) => record.date.slice(0, 7)))];
  const activeMonth = selectedMonth ?? months.at(-1) ?? null;
  return {
    availability: report.transactions.length > 0
      ? "available"
      : report.reportEligibility.status === "incomplete"
        ? "unavailable"
        : "empty",
    policy: {
      id: report.inclusionPolicy.id,
      version: report.inclusionPolicy.version,
      name: report.inclusionPolicy.name,
    },
    knowledgePoint: report.knowledgePoint,
    selectedMonth: activeMonth,
    selectedCategory: selectedCategory ?? null,
    transactions: records,
    includedTransactions: included,
    totalsByCurrency: report.totalsByCurrency.map((value) => canonicalAmount(value)),
    categoryTotalsByCurrency: report.categoryTotalsByCurrency.map((value) => ({
      categoryCode: value.categoryCode,
      taxonomyId: value.taxonomyId,
      taxonomyVersion: value.taxonomyVersion,
      labels: taxonomyLabels(value.categoryCode, value.taxonomyId, value.taxonomyVersion),
      currency: value.currency,
      amount: canonicalAmount(value),
      count: value.count,
    })),
    unclassifiedByCurrency: report.unclassifiedByCurrency.map((value) => canonicalAmount(value)),
    classificationCoverage: {
      includedCount: report.classificationCoverage.includedCount,
      classifiedCount: report.classificationCoverage.classifiedCount,
      unclassifiedCount: report.classificationCoverage.unclassifiedCount,
      includedAmountByCurrency: report.classificationCoverage.includedAmountByCurrency.map((value) => canonicalAmount(value)),
      classifiedAmountByCurrency: report.classificationCoverage.classifiedAmountByCurrency.map((value) => canonicalAmount(value)),
      unclassifiedAmountByCurrency: report.classificationCoverage.unclassifiedAmountByCurrency.map((value) => canonicalAmount(value)),
    },
    reportEligibility: {
      status: report.reportEligibility.status,
      gapCount: report.reportEligibility.gapCount,
      gapAmountByCurrency: report.reportEligibility.gapAmountByCurrency.map((value) => canonicalAmount(value)),
    },
    totalStatus: report.totalStatus,
  };
}

function occurrenceUnixSeconds(invoice: CanonicalEInvoiceView): number {
  const occurrence = invoice.revision.occurrence;
  const time = occurrence.precision === "date"
    ? "T00:00:00"
    : occurrence.precision === "minute"
      ? ":00"
      : "";
  const parsed = Date.parse(`${occurrence.value}${time}+08:00`);
  if (!Number.isFinite(parsed))
    throw new Error(`Canonical E-Invoice ${invoice.revision.invoiceNumber} has an invalid occurrence.`);
  return Math.floor(parsed / 1000);
}

function invoiceItem(
  item: CanonicalEInvoiceView["revision"]["items"][number],
): SpendingItemDto {
  return {
    itemKey: item.itemId,
    sequence: item.sequence,
    quantity: item.quantity ? exactToNumber(item.quantity) : null,
    unitPrice: item.unitPrice ? exactToNumber(item.unitPrice) : null,
    paidAmount: item.amount ? exactToNumber(item.amount) : null,
    productName: item.name,
    // Spending has no category evidence for E-Invoice items yet. Keep the
    // existing DTO shape while exposing that this is not a full allocation.
    category: "other",
    completeness: item.completeness,
  };
}

function currentSpendingInvoices(
  invoices: readonly CanonicalEInvoiceView[],
): SpendingInvoiceDto[] {
  return invoices
    .filter((invoice) => invoice.revision.state !== "revoked" && invoice.revision.total !== null)
    .map((invoice) => ({
      invoiceKey: invoice.stableInvoiceKey,
      invoiceId: invoice.revision.invoiceNumber,
      issuedAt: occurrenceUnixSeconds(invoice),
      amount: exactToNumber(invoice.revision.total!),
      sellerBusinessAccountNumber: invoice.revision.seller.taxId,
      sellerName: invoice.revision.seller.name,
      sellerAddr: null,
      items: invoice.revision.items.map(invoiceItem),
      revisionKind: invoice.revision.revisionKind === "revised" ? "revised" : "issued",
    }));
}

function pairKey(invoiceId: string, transactionId: string): string {
  return `${invoiceId}/${transactionId}`;
}

type RecognitionMutation = Readonly<{
  kind: "confirmed" | "denied";
  invoiceId: string;
  transactionId: string;
}>;

function comparePurchaseRecordOrder(
  left: PurchaseReport["records"][number],
  right: PurchaseReport["records"][number],
): number {
  return left.occurrence.value.localeCompare(right.occurrence.value) || left.purchaseId.localeCompare(right.purchaseId);
}

function insertPurchaseRecord(
  records: readonly PurchaseReport["records"][number][],
  value: PurchaseReport["records"][number],
): readonly PurchaseReport["records"][number][] {
  let low = 0;
  let high = records.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (comparePurchaseRecordOrder(records[middle]!, value) <= 0) low = middle + 1;
    else high = middle;
  }
  return Object.freeze([...records.slice(0, low), value, ...records.slice(low)]);
}

function adjustPurchaseTotals(
  totals: PurchaseReport["totalsByCurrency"],
  removed: Readonly<{ currency: string; coefficient: string; scale: number }> | null,
): PurchaseReport["totalsByCurrency"] {
  if (!removed) return totals;
  const next = totals.map((entry) => {
    if (entry.currency !== removed.currency) return entry;
    const scale = Math.max(entry.scale, removed.scale);
    const coefficient = BigInt(entry.coefficient) * 10n ** BigInt(scale - entry.scale) -
      BigInt(removed.coefficient) * 10n ** BigInt(scale - removed.scale);
    return { currency: entry.currency, coefficient: coefficient.toString(), scale, count: entry.count - 1 };
  }).filter((entry) => entry.count > 0);
  return Object.freeze(next);
}

function linkedPurchaseRecord(
  invoice: CanonicalEInvoiceView,
  payment: CanonicalSpendingTransaction,
  link: SpendingRecognitionSnapshot["activeLinks"][number],
  candidateIds: readonly string[],
): PurchaseReport["records"][number] {
  const invoiceAmount = invoice.revision.total
    ? {
        coefficient: invoice.revision.total.coefficient,
        scale: invoice.revision.total.scale,
        currency: invoice.revision.total.currency,
      }
    : null;
  const occurrence = {
    value: invoice.revision.occurrence.value,
    precision: invoice.revision.occurrence.precision,
    timeZone: invoice.revision.occurrence.timeZone,
    basis: invoice.revision.occurrence.origin === "source-reported"
      ? "purchase-date" as const
      : "posting-date-fallback" as const,
  };
  return {
    purchaseId: `link:${link.eventId}`,
    basis: "linked",
    amount: payment.amount,
    occurrence,
    description: invoice.revision.seller.name ?? payment.description,
    invoice,
    transaction: payment,
    items: invoice.revision.items,
    possibleDuplicate: candidateIds.length > 0,
    candidateIds: Object.freeze([...candidateIds]),
    link,
    difference: {
      invoiceAmount,
      bankAmount: payment.amount,
      sameCurrency: invoiceAmount?.currency === payment.amount.currency,
      exactAmountEqual: invoiceAmount ? exactMoneyEqual(invoiceAmount, payment.amount) : false,
    },
    refund: null,
  };
}

function targetedPurchaseReportAfterRecognitionMutation(
  before: PurchaseReport,
  recognition: SpendingRecognitionSnapshot,
  mutation: RecognitionMutation,
): PurchaseReport {
  const target = pairKey(mutation.invoiceId, mutation.transactionId);
  const candidates = before.candidates
    .map((candidate) => {
      if (pairKey(candidate.invoiceId, candidate.transactionId) !== target) return candidate;
      return recognition.candidates.find((next) =>
        pairKey(next.invoiceId, next.transactionId) === target && next.candidateId === candidate.candidateId,
      ) ?? null;
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
  const knownCandidateIds = new Set(candidates.map((candidate) => candidate.candidateId));
  for (const candidate of recognition.candidates) {
    if (pairKey(candidate.invoiceId, candidate.transactionId) !== target) continue;
    if (!knownCandidateIds.has(candidate.candidateId)) candidates.push(candidate);
  }
  const pendingCandidateIds = new Set(candidates
    .filter((candidate) => candidate.status === "candidate")
    .map((candidate) => candidate.candidateId));
  const linkedCandidateIds = candidates
    .filter((candidate) => candidate.status === "candidate" &&
      (candidate.invoiceId === mutation.invoiceId || candidate.transactionId === mutation.transactionId))
    .map((candidate) => candidate.candidateId);
  let records: readonly PurchaseReport["records"][number][] = before.records
    .filter((record) => mutation.kind !== "confirmed" ||
      (record.invoice?.invoiceId !== mutation.invoiceId && record.transaction?.transactionId !== mutation.transactionId))
    .map((record) => {
      const candidateIds = record.candidateIds.filter((candidateId) => pendingCandidateIds.has(candidateId));
      const possibleDuplicate = candidateIds.length > 0;
      if (candidateIds.length === record.candidateIds.length && record.possibleDuplicate === possibleDuplicate) return record;
      return { ...record, candidateIds: Object.freeze(candidateIds), possibleDuplicate };
    });
  let totals = before.totalsByCurrency;
  if (mutation.kind === "confirmed") {
    const invoiceRecord = before.records.find((record) => record.invoice?.invoiceId === mutation.invoiceId);
    const paymentRecord = before.records.find((record) => record.transaction?.transactionId === mutation.transactionId);
    if (!invoiceRecord?.invoice || !paymentRecord?.transaction)
      throw new Error("Spending confirmation cannot build a targeted report patch.");
    const link = recognition.activeLinks.find((candidate) =>
      pairKey(candidate.invoiceId, candidate.transactionId) === target,
    );
    if (!link) throw new Error("Spending confirmation did not produce an active link.");
    const linked = linkedPurchaseRecord(
      invoiceRecord.invoice,
      paymentRecord.transaction,
      link,
      linkedCandidateIds,
    );
    records = insertPurchaseRecord(records, linked);
    totals = adjustPurchaseTotals(totals, invoiceRecord.amount);
  }
  return Object.freeze({
    ...before,
    knowledgeAt: recognition.knowledgeAt,
    records: Object.freeze(records),
    totalsByCurrency: totals,
    totalStatus: records.some((record) => record.possibleDuplicate)
      ? "includes-pending-confirmation"
      : "complete",
    candidates: Object.freeze(candidates),
  });
}

function directPairingPatchFromContext(
  input: Readonly<{
    context: DirectPairingReportContext;
    invoice: CanonicalEInvoiceView;
    payment: CanonicalSpendingTransaction;
    recognition: SpendingRecognitionSnapshot;
    invoiceId: string;
    transactionId: string;
    dataVersion: number;
    totalsByCurrency: SpendingPurchaseReportDto["totalsByCurrency"];
  }>,
): SpendingPurchaseActionResult {
  const { context, invoice, payment, recognition, invoiceId, transactionId, dataVersion, totalsByCurrency } = input;
  const target = pairKey(invoiceId, transactionId);
  const link = recognition.activeLinks.find((candidate) =>
    pairKey(candidate.invoiceId, candidate.transactionId) === target,
  );
  if (!link) throw new Error("Spending confirmation did not produce an active link.");
  const linkedCandidateIds = recognition.candidates
    .filter((candidate) => candidate.status === "candidate" &&
      (candidate.invoiceId === invoiceId || candidate.transactionId === transactionId))
    .map((candidate) => candidate.candidateId);
  const inferred = evaluateSpendingMatchCandidates([invoice], [payment])[0];
  const candidateOperations = inferred && context.candidateIds.includes(inferred.candidateKey)
    ? Object.freeze([{ kind: "remove" as const, id: inferred.candidateKey }])
    : Object.freeze([]);
  const linked = linkedPurchaseRecord(invoice, payment, link, linkedCandidateIds);
  const tieOffset = context.sameDatePurchaseIds.findIndex((id) => id.localeCompare(linked.purchaseId) > 0);
  const recordInsertIndex = context.recordInsertIndex + (tieOffset < 0 ? context.sameDatePurchaseIds.length : tieOffset);
  const invoiceAmount = invoice.revision.total
    ? {
        coefficient: invoice.revision.total.coefficient,
        scale: invoice.revision.total.scale,
        currency: invoice.revision.total.currency,
      }
    : null;
  return {
    patch: Object.freeze({
      kind: "spending-purchase-report-patch",
      baseKnowledgeAt: dataVersion,
      status: "ok",
      reportKind: "current",
      knowledgeAt: recognition.knowledgeAt,
      financialAt: null,
      totalsByCurrency: adjustPurchaseTotals(totalsByCurrency, invoiceAmount),
      totalStatus: context.totalStatusAfter,
      recordOperations: Object.freeze([
        { kind: "remove" as const, id: `invoice:${invoiceId}` },
        { kind: "remove" as const, id: `transaction:${transactionId}` },
        { kind: "upsert" as const, index: recordInsertIndex, value: linked },
      ]),
      candidateOperations,
    }),
  };
}

/**
 * Candidate hints are deliberately kept ephemeral until a person acts on one.
 * This lets the report show both sides of a possible duplicate without
 * creating canonical history merely by opening the Spending page.
 */
function purchaseReportWithEphemeralCandidates(
  query: CurrentSpendingQueryResult,
  report: PurchaseReport = query.purchaseReport,
): PurchaseReport {
  const activeLinkPairs = new Set(
    report.records
      .filter((record) => record.basis === "linked" && record.link)
      .map((record) => pairKey(record.link!.invoiceId, record.link!.transactionId)),
  );
  const durableByPair = new Map(
    report.candidates.map((candidate) => [pairKey(candidate.invoiceId, candidate.transactionId), candidate]),
  );
  const inferred = evaluateSpendingMatchCandidates(query.invoices, query.spending.includedTransactions)
    .filter((candidate) => !activeLinkPairs.has(pairKey(candidate.invoiceId, candidate.transactionId)))
    .map((candidate) => {
      const durable = durableByPair.get(pairKey(candidate.invoiceId, candidate.transactionId));
      if (durable && durable.status !== "candidate") return null;
      return durable ?? {
        invoiceId: candidate.invoiceId,
        transactionId: candidate.transactionId,
        candidateId: candidate.candidateKey,
        algorithm: candidate.algorithm,
        algorithmVersion: candidate.algorithmVersion,
        similarityEvidence: candidate.similarityEvidence,
        status: "candidate" as const,
      };
    })
    .filter((candidate): candidate is typeof report.candidates[number] => candidate !== null);
  const candidates = [...report.candidates];
  const known = new Set(candidates.map((candidate) => candidate.candidateId));
  for (const candidate of inferred) {
    if (!known.has(candidate.candidateId)) candidates.push(candidate);
  }
  const pendingPairs = new Set(
    candidates
      .filter((candidate) => candidate.status === "candidate")
      .map((candidate) => pairKey(candidate.invoiceId, candidate.transactionId)),
  );
  const candidateIdsByInvoice = new Map<string, string[]>();
  const candidateIdsByTransaction = new Map<string, string[]>();
  for (const candidate of candidates) {
    if (candidate.status !== "candidate") continue;
    (candidateIdsByInvoice.get(candidate.invoiceId) ?? candidateIdsByInvoice.set(candidate.invoiceId, []).get(candidate.invoiceId)!)
      .push(candidate.candidateId);
    (candidateIdsByTransaction.get(candidate.transactionId) ?? candidateIdsByTransaction.set(candidate.transactionId, []).get(candidate.transactionId)!)
      .push(candidate.candidateId);
  }
  const records = report.records.map((record) => {
    const invoiceId = record.invoice?.invoiceId;
    const transactionId = record.transaction?.transactionId;
    const candidateIds = [
      ...(invoiceId ? candidateIdsByInvoice.get(invoiceId) ?? [] : []),
      ...(transactionId ? candidateIdsByTransaction.get(transactionId) ?? [] : []),
    ];
    if (candidateIds.length === 0) return record;
    return {
      ...record,
      candidateIds: Object.freeze([...new Set([...record.candidateIds, ...candidateIds])]),
      possibleDuplicate: pendingPairs.has(pairKey(invoiceId ?? "", transactionId ?? "")) || candidateIds.length > 0,
    };
  });
  return Object.freeze({
    ...report,
    records: Object.freeze(records),
    totalStatus: records.some((record) => record.possibleDuplicate)
      ? "includes-pending-confirmation"
      : report.totalStatus,
    candidates: Object.freeze(candidates),
  });
}

function currentSpendingQuery(ledgerDir: string): CurrentSpendingQueryResult {
  fullProjectionDiagnostics.publish({ ledgerDir });
  const query = createFinancialQuery(ledgerDir).current({ kind: "current", product: "spending" });
  latestSpendingQuery = { ledgerDir, query };
  return query;
}

function currentSpendingQueryFromStore(
  store: CanonicalSourceStore,
  ledgerDir: string,
): CurrentSpendingQueryResult {
  fullProjectionDiagnostics.publish({ ledgerDir });
  return queryCurrentSpendingFromDatabase(store.db);
}

function pairingCandidatesInput(input: unknown): SpendingPairingCandidatesInput {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("Spending pairing candidates input must be an object.");
  const value = input as Record<string, unknown>;
  if (typeof value.invoiceIdentityId !== "string" || value.invoiceIdentityId.trim() === "")
    throw new TypeError("Invoice identity id is required.");
  if (!Number.isSafeInteger(value.dataVersion) || (value.dataVersion as number) < 0)
    throw new TypeError("Spending pairing data version must be a non-negative integer.");
  return {
    invoiceIdentityId: value.invoiceIdentityId.trim(),
    dataVersion: value.dataVersion as number,
    selectedTransactionId: typeof value.selectedTransactionId === "string" && value.selectedTransactionId.trim()
      ? value.selectedTransactionId.trim() : undefined,
    offset: Number.isSafeInteger(value.offset) && (value.offset as number) >= 0 ? value.offset as number : 0,
    limit: Number.isSafeInteger(value.limit) && (value.limit as number) > 0
      ? Math.min(value.limit as number, 100)
      : 50,
  };
}

function pairingPrewarmInput(input: unknown): SpendingPairingPrewarmInput {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("Spending pairing prewarm input must be an object.");
  const value = input as Record<string, unknown>;
  if (!Number.isSafeInteger(value.dataVersion) || (value.dataVersion as number) < 0)
    throw new TypeError("Spending pairing prewarm data version must be a non-negative integer.");
  return { dataVersion: value.dataVersion as number };
}

function canonicalUuidFromBlob(value: unknown, label: string): string {
  if (!(value instanceof Uint8Array) || value.byteLength !== 16)
    throw new Error(`${label} is not a canonical UUID.`);
  const hex = Buffer.from(value).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function pairingIndexCache(ledgerDir: string): SpendingPairingIndexCache {
  const cached = pairingIndexCaches.get(ledgerDir);
  if (cached) return cached;
  const created = new SpendingPairingIndexCache();
  pairingIndexCaches.set(ledgerDir, created);
  return created;
}

function pairingInvoiceViewFromDatabase(
  store: Pick<CanonicalSourceStore, "db">,
  invoiceIdentityId: string,
  knowledgeAt: number,
): CanonicalEInvoiceView {
  const invoice = queryCanonicalEInvoiceByIdFromDatabase(store.db, {
    invoiceId: invoiceIdentityId,
    knowledgeAt,
  });
  if (!invoice || invoice.revision.state === "revoked")
    throw new Error("Spending invoice selection is stale, revoked, or missing.");
  return invoice;
}

function pairingInvoiceFromDatabase(
  store: Pick<CanonicalSourceStore, "db">,
  invoiceIdentityId: string,
  knowledgeAt: number,
): SpendingMatchingInvoice {
  const row = store.db.prepare(`
    SELECT revision.state, revision.seller_name, revision.amount_coefficient,
           revision.amount_scale, revision.currency, revision.occurrence_value
      FROM einvoice_invoice_revisions revision
      JOIN canonical_commits commit_row ON commit_row.commit_id = revision.commit_id
     WHERE revision.invoice_id = ? AND commit_row.commit_sequence <= ?
     ORDER BY revision.revision_number DESC, commit_row.commit_sequence DESC
     LIMIT 1
  `).get(Buffer.from(invoiceIdentityId.replaceAll("-", ""), "hex"), knowledgeAt) as
    | Readonly<Record<string, unknown>>
    | undefined;
  if (!row || row.state === "revoked")
    throw new Error("Spending invoice selection is stale, revoked, or missing.");
  return Object.freeze({
    revision: Object.freeze({
      seller: Object.freeze({ name: typeof row.seller_name === "string" ? row.seller_name : null }),
      occurrence: Object.freeze({ value: String(row.occurrence_value) }),
      total: row.amount_coefficient === null
        ? null
        : Object.freeze({
            coefficient: String(row.amount_coefficient),
            scale: Number(row.amount_scale),
            currency: String(row.currency),
          }),
    }),
  });
}

type PairingTransactionQueryOptions = Readonly<{
  limit?: number;
  afterTransactionIdentityId?: string;
}>;

function pairingIndexEntriesFromDatabase(
  store: Pick<CanonicalSourceStore, "db">,
  options: PairingTransactionQueryOptions = {},
): readonly SpendingPairingIndexEntry[] {
  const rows = store.db.prepare(`
    SELECT current_row.transaction_id, revision.effective_on, revision.description,
           revision.amount_coefficient, revision.amount_scale, revision.currency,
           account.stream
      FROM current_transactions current_row
      JOIN transaction_revisions revision ON revision.revision_id = current_row.revision_id
      JOIN financial_transactions transaction_row ON transaction_row.transaction_id = current_row.transaction_id
      JOIN financial_accounts account ON account.account_id = transaction_row.account_id
      JOIN current_transaction_enrichment kind
        ON kind.transaction_id = current_row.transaction_id AND kind.field_name = 'kind'
      LEFT JOIN current_spending_dedup_links active_link
        ON active_link.transaction_id = current_row.transaction_id
     WHERE active_link.transaction_id IS NULL
       ${options.afterTransactionIdentityId === undefined ? "" : "AND current_row.transaction_id > ?"}
       AND revision.administrative_state = 'active'
       AND revision.economic_status = 'normal'
       AND revision.posting_status = 'posted'
       AND revision.direction = 'outflow'
       AND kind.taxonomy_code IS NOT NULL
       AND kind.taxonomy_code NOT IN ('transfer', 'cash', 'investment', 'payment.credit_card', 'payment.loan')
       AND kind.taxonomy_code NOT LIKE 'transfer.%'
       AND kind.taxonomy_code NOT LIKE 'cash.%'
       AND kind.taxonomy_code NOT LIKE 'investment.%'
       AND kind.taxonomy_code NOT LIKE 'payment.credit_card.%'
       AND kind.taxonomy_code NOT LIKE 'payment.loan.%'
     ORDER BY current_row.transaction_id
     ${options.limit === undefined ? "" : "LIMIT ?"}
  `).all(
    ...(options.afterTransactionIdentityId === undefined
      ? []
      : [Buffer.from(options.afterTransactionIdentityId.replaceAll("-", ""), "hex")]),
    ...(options.limit === undefined ? [] : [options.limit]),
  ) as readonly Readonly<Record<string, unknown>>[];
  return Object.freeze(rows.map((row) => {
    const stream = String(row.stream);
    const transaction = Object.freeze({
      transactionId: canonicalUuidFromBlob(row.transaction_id, "Pairing transaction identity"),
      effectiveOn: String(row.effective_on),
      consumeDate: null,
      postingDate: stream === "credit-card" ? String(row.effective_on) : null,
      description: typeof row.description === "string" ? row.description : null,
      amount: Object.freeze({
        coefficient: String(row.amount_coefficient),
        scale: Number(row.amount_scale),
        currency: String(row.currency),
      }),
      stream,
      effectiveDateBasis: stream === "credit-card" ? "posting-date-fallback" as const : null,
    });
    return spendingPairingIndexEntryForTransaction(transaction);
  }));
}

function pairingTransactionViewFromDatabase(
  store: Pick<CanonicalSourceStore, "db">,
  transactionIdentityId: string,
): CanonicalSpendingTransaction {
  const row = store.db.prepare(`
    SELECT current_row.transaction_id, current_row.revision_id, transaction_row.account_id,
           revision.effective_on, revision.description, revision.amount_coefficient,
           revision.amount_scale, revision.currency, revision.direction,
           revision.posting_status, revision.economic_status, revision.administrative_state,
           account.stream, account.account_no, source.source_connection_key,
           source.integration_namespace, kind.taxonomy_code
      FROM current_transactions current_row
      JOIN transaction_revisions revision ON revision.revision_id = current_row.revision_id
      JOIN financial_transactions transaction_row ON transaction_row.transaction_id = current_row.transaction_id
      JOIN financial_accounts account ON account.account_id = transaction_row.account_id
      JOIN source_connections source ON source.source_connection_id = account.source_connection_id
      JOIN current_transaction_enrichment kind
        ON kind.transaction_id = current_row.transaction_id AND kind.field_name = 'kind'
      LEFT JOIN current_spending_dedup_links active_link
        ON active_link.transaction_id = current_row.transaction_id
     WHERE current_row.transaction_id = ? AND active_link.transaction_id IS NULL
       AND revision.administrative_state = 'active' AND revision.economic_status = 'normal'
       AND revision.posting_status = 'posted' AND revision.direction = 'outflow'
     LIMIT 1
  `).get(Buffer.from(transactionIdentityId.replaceAll("-", ""), "hex")) as
    | Readonly<Record<string, unknown>>
    | undefined;
  if (!row) throw new Error("Spending payment selection is stale, linked, or ineligible.");
  const stream = String(row.stream);
  const transactionId = canonicalUuidFromBlob(row.transaction_id, "Pairing transaction identity");
  const descriptionAssertion = store.db.prepare(`
    SELECT assertion_id FROM assertions
     WHERE transaction_id = ? AND revision_id = ? AND field_name = 'transaction_revision'
     ORDER BY rowid DESC LIMIT 1
  `).get(row.transaction_id as Uint8Array, row.revision_id as Uint8Array) as
    | { assertion_id?: unknown }
    | undefined;
  const tags = (store.db.prepare(`
    SELECT tag_id, assertion_id, user_id, display_label, normalized_label, lifecycle
      FROM current_transaction_tags WHERE transaction_id = ? ORDER BY normalized_label, tag_id
  `).all(row.transaction_id as Uint8Array) as readonly Readonly<Record<string, unknown>>[]).map((tag) => ({
    tagId: canonicalUuidFromBlob(tag.tag_id, "Pairing transaction tag identity"),
    assertionId: canonicalUuidFromBlob(tag.assertion_id, "Pairing transaction tag assertion"),
    userId: String(tag.user_id),
    label: String(tag.display_label),
    normalizedLabel: String(tag.normalized_label),
    lifecycle: String(tag.lifecycle) as "active" | "archived",
    origin: "user" as const,
  }));
  return Object.freeze({
    transactionId,
    revisionId: Buffer.from(row.revision_id as Uint8Array).toString("hex"),
    accountId: Buffer.from(row.account_id as Uint8Array).toString("hex"),
    accountNumber: typeof row.account_no === "string" ? row.account_no : null,
    sourceConnectionKey: String(row.source_connection_key),
    integrationNamespace: String(row.integration_namespace),
    stream,
    effectiveOn: String(row.effective_on),
    consumeDate: null,
    postingDate: stream === "credit-card" ? String(row.effective_on) : null,
    effectiveDateBasis: stream === "credit-card" ? "posting-date-fallback" : null,
    description: typeof row.description === "string" ? row.description : null,
    amount: { coefficient: String(row.amount_coefficient), scale: Number(row.amount_scale), currency: String(row.currency) },
    direction: String(row.direction),
    postingStatus: String(row.posting_status),
    economicStatus: String(row.economic_status),
    administrativeState: String(row.administrative_state),
    kind: String(row.taxonomy_code),
    categorization: { mode: "absent" as const },
    display: row.description === null
      ? { status: "absent" as const, value: null, origin: null, displayKind: null, assertionId: null, referenceId: null }
      : {
          status: "fallback" as const,
          value: String(row.description),
          origin: "source",
          displayKind: "source_description" as const,
          assertionId: descriptionAssertion?.assertion_id
            ? canonicalUuidFromBlob(descriptionAssertion.assertion_id, "Pairing description assertion")
            : null,
          referenceId: null,
        },
    tags: Object.freeze(tags),
    inclusion: "included" as const,
  });
}

function confirmPairingLinkInDatabase(
  db: NodeDatabaseSync,
  input: Readonly<{
    invoiceId: string;
    transactionId: string;
    dataVersion: number;
    evidence: Readonly<Record<string, unknown>>;
  }>,
): Readonly<{ eventId: string; knowledgeAt: number; evidence: Readonly<Record<string, unknown>> }> {
  const invoiceId = Buffer.from(input.invoiceId.replaceAll("-", ""), "hex");
  const transactionId = Buffer.from(input.transactionId.replaceAll("-", ""), "hex");
  const eventId = Buffer.from(randomUUID().replaceAll("-", ""), "hex");
  const commitId = Buffer.from(randomUUID().replaceAll("-", ""), "hex");
  const knowledgeAt = input.dataVersion + 1;
  db.exec("BEGIN IMMEDIATE");
  try {
    const latest = Number((db.prepare(
      "SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits",
    ).get() as { value: number }).value);
    if (latest !== input.dataVersion)
      throw new Error("Spending confirmation data version is stale; reload Spending before pairing.");
    if (db.prepare(
      "SELECT 1 FROM current_spending_dedup_links WHERE invoice_id = ? OR transaction_id = ? LIMIT 1",
    ).get(invoiceId, transactionId))
      throw new Error("Spending deduplication is one invoice to one transaction.");
    db.prepare(`
      INSERT INTO canonical_commits(
        commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind
      ) VALUES (?, ?, ?, 'user/local', 'relation_resolution')
    `).run(commitId, knowledgeAt, Date.now() * 1000);
    db.prepare(`
      INSERT INTO spending_dedup_decision_events(
        event_id, decision_key, invoice_id, transaction_id, event_kind,
        decision_origin, user_id, authority_route, stable_cross_source_reference,
        evidence_json, evidence_knowledge_sequence, commit_id
      ) VALUES (?, ?, ?, ?, 'confirmed', 'user', ?, NULL, NULL, ?, ?, ?)
    `).run(
      eventId,
      `spending/user/direct/${input.invoiceId}/${input.transactionId}/${input.dataVersion}`,
      invoiceId,
      transactionId,
      LOCAL_SPENDING_USER_ID,
      JSON.stringify(input.evidence),
      input.dataVersion,
      commitId,
    );
    db.prepare(`
      INSERT INTO current_spending_dedup_links(
        invoice_id, transaction_id, confirmed_event_id, projection_commit_id
      ) VALUES (?, ?, ?, ?)
    `).run(invoiceId, transactionId, eventId, commitId);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return { eventId: canonicalUuidFromBlob(eventId, "Pairing event identity"), knowledgeAt, evidence: input.evidence };
}

/**
 * Rank manual pairing candidates in the financial worker. The renderer sends
 * only the invoice identity and the report version; transaction facts stay on
 * the worker and are indexed once per immutable data version.
 */
export function rankSpendingPaymentCandidates(
  input: SpendingPairingCandidatesInput,
  ledgerDir = DEFAULT_LEDGER_DIR,
): SpendingPairingCandidatesResult {
  const startedAt = performance.now();
  const action = pairingCandidatesInput(input);
  const databasePath = canonicalDatabaseWriterKey(ledgerDir);
  if (!existsSync(databasePath)) throw new Error("Canonical Spending database is not initialized.");
  const db = new NodeDatabaseSync(databasePath, { readOnly: true });
  const store = { db: db as CanonicalSourceStore["db"] };
  pairingProgress("read database opened", startedAt);
  try {
    const currentVersion = Number((store.db.prepare(
      "SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits",
    ).get() as { value: number }).value);
    if (currentVersion !== action.dataVersion)
      throw new Error("Spending pairing data version is stale; reload Spending before pairing.");
    const invoice = pairingInvoiceFromDatabase(store, action.invoiceIdentityId, currentVersion);
    pairingProgress("invoice loaded", startedAt);
    const cache = pairingIndexCache(ledgerDir);
    const index = cache.forVersion(currentVersion) ??
      cache.prewarmEntries(currentVersion, pairingIndexEntriesFromDatabase(store)).index;
    pairingProgress("pairing index ready", startedAt);
    const ranked = rankSpendingManualPaymentCandidates(invoice, index);
    pairingProgress("candidates ranked", startedAt);
    const offset = action.offset ?? 0;
    const limit = action.limit ?? 50;
    const page = ranked.slice(offset, offset + limit);
    const selectedRank = action.selectedTransactionId
      ? ranked.find((candidate) => candidate.transactionId === action.selectedTransactionId)
      : undefined;
    const pageIds = new Set([...page.map((candidate) => candidate.transactionId), ...(selectedRank ? [selectedRank.transactionId] : [])]);
    const pageTransactions = new Map<string, SpendingPairingIndexEntry["transaction"]>();
    if (pageIds.size > 0) {
      for (const entry of index.entries) {
        if (!pageIds.has(entry.transaction.transactionId)) continue;
        pageTransactions.set(entry.transaction.transactionId, entry.transaction);
        if (pageTransactions.size === pageIds.size) break;
      }
    }
    const candidates = page.map((candidate) => {
      const transaction = pageTransactions.get(candidate.transactionId);
      if (!transaction) throw new Error("Spending pairing candidate is missing from the current index.");
      return createSpendingPairingCandidateViewFromTransaction(transaction as SpendingPurchaseTransactionView);
    });
    pairingProgress("candidate DTOs ready", startedAt);
    return Object.freeze({
      dataVersion: currentVersion,
      candidates: Object.freeze(candidates),
      ...(action.selectedTransactionId !== undefined ? {
        selectedCandidate: selectedRank
          ? createSpendingPairingCandidateViewFromTransaction(pageTransactions.get(selectedRank.transactionId)! as SpendingPurchaseTransactionView)
          : null,
      } : {}),
      totalCandidateCount: ranked.length,
      nextOffset: offset + candidates.length < ranked.length ? offset + candidates.length : null,
    });
  } finally {
    db.close();
  }
}

/**
 * Prepare the worker-owned candidate index without making the renderer wait.
 * The immutable data version is the cache boundary; a new version replaces
 * the old index before any subsequent rank request can reuse it.
 */
export async function prewarmSpendingPairingCandidates(
  input: SpendingPairingPrewarmInput,
  ledgerDir = DEFAULT_LEDGER_DIR,
  shouldCancel: () => boolean = () => false,
): Promise<SpendingPairingPrewarmResult> {
  const action = pairingPrewarmInput(input);
  const databasePath = canonicalDatabaseWriterKey(ledgerDir);
  if (!existsSync(databasePath)) throw new Error("Canonical Spending database is not initialized.");
  const db = new NodeDatabaseSync(databasePath, { readOnly: true });
  const store = { db: db as CanonicalSourceStore["db"] };
  try {
    const currentVersion = Number((store.db.prepare(
      "SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits",
    ).get() as { value: number }).value);
    if (currentVersion !== action.dataVersion) {
      return Object.freeze({
        status: "stale" as const,
        dataVersion: currentVersion,
        requestedVersion: action.dataVersion,
      });
    }
    const cache = pairingIndexCache(ledgerDir);
    if (cache.forVersion(currentVersion))
      return Object.freeze({ status: "ready" as const, dataVersion: currentVersion, reused: true });

    // Use keyset batches so an interactive rank waits for at most one small
    // SQLite read. Unlike OFFSET batching, later batches do not rescan and
    // discard all preceding rows.
    const entries: SpendingPairingIndexEntry[] = [];
    const batchSize = 2_048;
    let afterTransactionIdentityId: string | undefined;
    while (true) {
      if (shouldCancel())
        return Object.freeze({ status: "ready" as const, dataVersion: currentVersion, reused: false });
      const batch = pairingIndexEntriesFromDatabase(store, {
        limit: batchSize,
        ...(afterTransactionIdentityId ? { afterTransactionIdentityId } : {}),
      });
      entries.push(...batch);
      if (batch.length < batchSize) break;
      afterTransactionIdentityId = batch.at(-1)!.transaction.transactionId;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (shouldCancel())
      return Object.freeze({ status: "ready" as const, dataVersion: currentVersion, reused: false });
    const latestVersion = Number((store.db.prepare(
      "SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits",
    ).get() as { value: number }).value);
    if (latestVersion !== currentVersion) {
      return Object.freeze({
        status: "stale" as const,
        dataVersion: latestVersion,
        requestedVersion: action.dataVersion,
      });
    }
    const prepared = cache.prewarmEntries(currentVersion, entries);
    return Object.freeze({ status: "ready" as const, dataVersion: currentVersion, reused: prepared.reused });
  } finally {
    db.close();
  }
}

function recordStore(ledgerDir: string) {
  const databasePath = canonicalDatabaseWriterKey(ledgerDir);
  if (!existsSync(databasePath)) throw new Error("Canonical Spending database is not initialized.");
  storeOpenDiagnostics.publish({ ledgerDir });
  return createCanonicalSourceStore(ledgerDir);
}

function pageFromQuery(
  query: CurrentSpendingQueryResult,
  purchaseReport: PurchaseReport = query.purchaseReport,
  { selectedMonth, selectedCategory }: SpendingLoadInput = {},
): SpendingPageDto {
  return {
    canonical: canonicalView(query.spending, selectedMonth, selectedCategory),
    purchaseReport: purchaseReportWithEphemeralCandidates(query, purchaseReport),
    invoices: currentSpendingInvoices(query.invoices),
  };
}

/**
 * Relation decisions do not change invoice or transaction facts. Recompose the
 * returned report from the immutable facts already read for validation and the
 * newly committed recognition snapshot, instead of running the full Spending
 * projection a second time.
 */
function actionResultAfterRecognitionMutation(
  query: CurrentSpendingQueryResult,
  store: CanonicalSourceStore,
  mutation?: RecognitionMutation,
): SpendingPurchaseActionResult {
  const before = purchaseReportWithEphemeralCandidates(query);
  const recognition = querySpendingRecognition(store);
  if (mutation) {
    const after = targetedPurchaseReportAfterRecognitionMutation(before, recognition, mutation);
    return { patch: createSpendingPurchaseReportPatch(before, after) };
  }
  fullReportComposeDiagnostics.publish({});
  const purchaseReport = composePurchaseReport({
    request: { kind: "current" },
    knowledgeAt: recognition.knowledgeAt,
    invoices: query.invoices,
    transactions: query.spending.includedTransactions,
    recognition,
  });
  const after = purchaseReportWithEphemeralCandidates(query, purchaseReport);
  return { patch: createSpendingPurchaseReportPatch(before, after) };
}

function requiredActionText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} is required.`);
  return value.trim();
}

function candidateActionValue(input: unknown): SpendingCandidateDecisionInput {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("Spending candidate action must be an object.");
  const value = input as Record<string, unknown>;
  if (value.kind !== "candidate") throw new TypeError("Spending candidate action kind must be candidate.");
  return { kind: "candidate", candidateId: requiredActionText(value.candidateId, "Candidate id") };
}

function confirmActionValue(input: unknown): SpendingConfirmActionInput {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("Spending confirmation must be an object.");
  const value = input as Record<string, unknown>;
  if (value.kind === "candidate") return candidateActionValue(input);
  if (value.kind !== "direct") throw new TypeError("Spending confirmation kind is invalid.");
  const pairingReportContext = value.pairingReportContext;
  if (pairingReportContext !== undefined) {
    if (!pairingReportContext || typeof pairingReportContext !== "object" || Array.isArray(pairingReportContext))
      throw new TypeError("Spending pairing report context must be an object.");
    const context = pairingReportContext as Record<string, unknown>;
    if (!Number.isSafeInteger(context.recordInsertIndex) || (context.recordInsertIndex as number) < 0)
      throw new TypeError("Spending pairing report insert index must be a non-negative integer.");
    if (!Array.isArray(context.candidateIds) || context.candidateIds.some((candidateId) => typeof candidateId !== "string"))
      throw new TypeError("Spending pairing report candidate ids must be an array of strings.");
    if (context.sameDatePurchaseIds !== undefined &&
        (!Array.isArray(context.sameDatePurchaseIds) || context.sameDatePurchaseIds.some((id) => typeof id !== "string")))
      throw new TypeError("Spending pairing same-date ids must be an array of strings.");
    if (context.totalStatusAfter !== "complete" && context.totalStatusAfter !== "includes-pending-confirmation")
      throw new TypeError("Spending pairing report total status is invalid.");
  }
  return {
    kind: "direct",
    invoiceIdentityId: requiredActionText(value.invoiceIdentityId, "Invoice identity id"),
    transactionIdentityId: requiredActionText(value.transactionIdentityId, "Transaction identity id"),
    ...(Number.isSafeInteger(value.dataVersion) && (value.dataVersion as number) >= 0
      ? { dataVersion: value.dataVersion as number }
      : {}),
    ...(Array.isArray(value.totalsByCurrency)
      ? { totalsByCurrency: value.totalsByCurrency as SpendingPurchaseReportDto["totalsByCurrency"] }
      : {}),
    ...(pairingReportContext
      ? {
          pairingReportContext: {
            recordInsertIndex: (pairingReportContext as Record<string, unknown>).recordInsertIndex as number,
            sameDatePurchaseIds: Object.freeze([...(((pairingReportContext as Record<string, unknown>).sameDatePurchaseIds ?? []) as string[])]),
            candidateIds: Object.freeze([...(pairingReportContext as Record<string, unknown>).candidateIds as string[]]),
            totalStatusAfter: (pairingReportContext as Record<string, unknown>).totalStatusAfter as SpendingPurchaseReportDto["totalStatus"],
          },
        }
      : {}),
  };
}

function linkActionValue(input: unknown): SpendingLinkRevokeInput {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("Spending link action must be an object.");
  const value = input as Record<string, unknown>;
  return {
    invoiceId: requiredActionText(value.invoiceId, "Invoice id"),
    transactionId: requiredActionText(value.transactionId, "Transaction id"),
  };
}

function resolveCandidate(
  query: ReturnType<typeof currentSpendingQuery>,
  candidateId: string,
) {
  const listed = query.purchaseReport.candidates.filter((candidate) => candidate.candidateId === candidateId);
  const deterministic = evaluateSpendingMatchCandidates(query.invoices, query.spending.includedTransactions);
  const ephemeral = deterministic.filter((candidate) => candidate.candidateKey === candidateId);
  if (listed.length > 1 || ephemeral.length > 1 || (listed.length === 0 && ephemeral.length === 0))
    throw new Error(listed.length + ephemeral.length === 0
      ? "Spending candidate is stale or missing."
      : "Spending candidate is ambiguous.");
  const selected = listed[0];
  if (selected && selected.status !== "candidate") throw new Error("Spending candidate is no longer pending.");
  const match = selected
    ? deterministic.filter((candidate) => candidate.invoiceId === selected.invoiceId && candidate.transactionId === selected.transactionId)
    : ephemeral;
  if (match.length !== 1) throw new Error(match.length === 0
    ? "Spending candidate no longer matches current canonical facts."
    : "Spending candidate is ambiguous.");
  return { ...match[0]!, durableCandidate: selected ?? null };
}

function decisionEvidence(candidate: ReturnType<typeof resolveCandidate>) {
  return {
    candidateKey: candidate.candidateKey,
    algorithm: candidate.algorithm,
    algorithmVersion: candidate.algorithmVersion,
    similarityEvidence: candidate.similarityEvidence,
    decisionOrigin: "local-user",
  } as const;
}

function decideCandidate(
  input: unknown,
  ledgerDir: string,
  kind: "confirmed" | "denied",
): SpendingPurchaseActionResult {
  const action = candidateActionValue(input);
  const store = recordStore(ledgerDir);
  try {
    const query = currentSpendingQueryFromStore(store, ledgerDir);
    const candidate = resolveCandidate(query, action.candidateId);
    const materialized = recordSpendingMatchCandidate(store, candidate);
    const evidence = decisionEvidence(candidate);
    const decision = {
      decisionKey: `spending/user/${kind}/${candidate.candidateKey}`,
      invoiceId: candidate.invoiceId,
      transactionId: candidate.transactionId,
      origin: { kind: "user" as const, userId: LOCAL_SPENDING_USER_ID },
      evidenceKnowledgeSequence: Math.max(query.purchaseReport.knowledgeAt, materialized.commitSequence),
      evidence,
    };
    if (kind === "confirmed") confirmSpendingDedupLink(store, decision);
    else denySpendingDedupCandidate(store, decision);
    return actionResultAfterRecognitionMutation(query, store, {
      kind,
      invoiceId: candidate.invoiceId,
      transactionId: candidate.transactionId,
    });
  } finally {
    store.close();
  }
}

export function confirmSpendingCandidate(
  input: SpendingConfirmActionInput,
  ledgerDir = DEFAULT_LEDGER_DIR,
): SpendingPurchaseActionResult {
  const action = confirmActionValue(input);
  if (action.kind === "candidate") return decideCandidate(action, ledgerDir, "confirmed");
  if (action.dataVersion !== undefined && action.totalsByCurrency !== undefined) {
    const startedAt = performance.now();
    const cachedBefore = latestSpendingQuery?.ledgerDir === ledgerDir &&
        latestSpendingQuery.query.purchaseReport.knowledgeAt === action.dataVersion
      ? purchaseReportWithEphemeralCandidates(latestSpendingQuery.query)
      : action.pairingReportContext
        ? null
        : (() => {
          const query = currentSpendingQuery(ledgerDir);
          return purchaseReportWithEphemeralCandidates(query);
        })();
    if (cachedBefore && cachedBefore.knowledgeAt !== action.dataVersion)
      throw new Error("Spending confirmation data version is stale; reload Spending before pairing.");
    const databasePath = canonicalDatabaseWriterKey(ledgerDir);
    if (!existsSync(databasePath)) throw new Error("Canonical Spending database is not initialized.");
    const db = new NodeDatabaseSync(databasePath);
    pairingProgress("confirm database opened", startedAt);
    const store = { db: db as CanonicalSourceStore["db"] };
    try {
      const currentVersion = Number((store.db.prepare(
        "SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits",
      ).get() as { value: number }).value);
      if (currentVersion !== action.dataVersion)
        throw new Error("Spending confirmation data version is stale; reload Spending before pairing.");
      const invoice = pairingInvoiceViewFromDatabase(store, action.invoiceIdentityId, currentVersion);
      pairingProgress("confirm invoice loaded", startedAt);
      const cache = pairingIndexCache(ledgerDir);
      const index = cache.forVersion(currentVersion) ??
        cache.prewarmEntries(currentVersion, pairingIndexEntriesFromDatabase(store)).index;
      const selected = index.entries.find((entry) =>
        entry.transaction.transactionId === action.transactionIdentityId,
      );
      if (!selected) throw new Error("Spending payment selection is stale, linked, or ineligible.");
      const payment = pairingTransactionViewFromDatabase(store, action.transactionIdentityId);
      pairingProgress("confirm transaction loaded", startedAt);
      const evidence = {
          decisionOrigin: "explicit-user-selection",
          invoice: {
            identityId: action.invoiceIdentityId,
            sourceRecordId: invoice.revision.sourceRecordId,
            date: invoice.revision.occurrence.value,
            amount: invoice.revision.total,
            label: invoice.revision.seller.name,
          },
          payment: {
            identityId: action.transactionIdentityId,
            sourceConnectionKey: payment.sourceConnectionKey,
            date: payment.effectiveOn,
            consumeDate: payment.consumeDate ?? null,
            postingDate: payment.postingDate ?? null,
            dateBasis: payment.effectiveDateBasis ?? "effective-date",
            amount: payment.amount,
            label: payment.description,
          },
        } as const;
      const committed = confirmPairingLinkInDatabase(db, {
        invoiceId: action.invoiceIdentityId,
        transactionId: action.transactionIdentityId,
        dataVersion: currentVersion,
        evidence,
      });
      pairingProgress("confirm committed", startedAt);
      const recognition = querySpendingRecognitionFromDatabase(store.db, { knowledgeAt: committed.knowledgeAt });
      if (cachedBefore) {
        const after = targetedPurchaseReportAfterRecognitionMutation(
          cachedBefore,
          recognition,
          {
            kind: "confirmed",
            invoiceId: action.invoiceIdentityId,
            transactionId: action.transactionIdentityId,
          },
        );
        return { patch: createSpendingPurchaseReportPatch(cachedBefore, after) };
      }
      if (!action.pairingReportContext)
        throw new Error("Spending confirmation report context is unavailable; reload Spending before pairing.");
      return directPairingPatchFromContext({
        context: action.pairingReportContext,
        invoice,
        payment,
        recognition,
        invoiceId: action.invoiceIdentityId,
        transactionId: action.transactionIdentityId,
        dataVersion: currentVersion,
        totalsByCurrency: action.totalsByCurrency,
      });
    } finally {
      db.close();
    }
  }
  const store = recordStore(ledgerDir);
  try {
    const query = currentSpendingQueryFromStore(store, ledgerDir);
    const invoice = query.purchaseReport.records.find((record) =>
      record.basis === "invoice" && record.invoice?.invoiceId === action.invoiceIdentityId,
    );
    const payment = query.purchaseReport.records.find((record) =>
      record.basis === "bank-transaction" && record.transaction?.transactionId === action.transactionIdentityId,
    );
    if (!invoice?.invoice) throw new Error("Spending invoice selection is stale, linked, revoked, or missing.");
    if (!payment?.transaction) throw new Error("Spending payment selection is stale, linked, or ineligible.");
    confirmSpendingDedupLink(store, {
      invoiceIdentityId: action.invoiceIdentityId,
      transactionIdentityId: action.transactionIdentityId,
      decisionKey: `spending/user/direct/${action.invoiceIdentityId}/${action.transactionIdentityId}/${query.purchaseReport.knowledgeAt}`,
      userId: LOCAL_SPENDING_USER_ID,
      evidenceKnowledgeSequence: query.purchaseReport.knowledgeAt,
      evidence: {
        decisionOrigin: "explicit-user-selection",
        invoice: {
          identityId: action.invoiceIdentityId,
          sourceRecordId: invoice.invoice.revision.sourceRecordId,
          date: invoice.occurrence.value,
          amount: invoice.amount,
          label: invoice.description,
        },
        payment: {
          identityId: action.transactionIdentityId,
          sourceConnectionKey: payment.transaction.sourceConnectionKey,
          date: payment.transaction.effectiveOn,
          consumeDate: payment.transaction.consumeDate ?? null,
          postingDate: payment.transaction.postingDate ?? null,
          dateBasis: payment.transaction.effectiveDateBasis ?? "effective-date",
          amount: payment.amount,
          label: payment.description,
        },
      },
    });
    return actionResultAfterRecognitionMutation(query, store, {
      kind: "confirmed",
      invoiceId: action.invoiceIdentityId,
      transactionId: action.transactionIdentityId,
    });
  } finally {
    store.close();
  }
}

export function denySpendingCandidate(
  input: SpendingCandidateDecisionInput,
  ledgerDir = DEFAULT_LEDGER_DIR,
): SpendingPurchaseActionResult {
  return decideCandidate(input, ledgerDir, "denied");
}

export function revokeSpendingLink(
  input: SpendingLinkRevokeInput,
  ledgerDir = DEFAULT_LEDGER_DIR,
): SpendingPurchaseActionResult {
  const action = linkActionValue(input);
  const store = recordStore(ledgerDir);
  try {
    const query = currentSpendingQueryFromStore(store, ledgerDir);
    const linked = query.purchaseReport.records.find((record) =>
      record.basis === "linked" &&
      record.link?.invoiceId === action.invoiceId &&
      record.link?.transactionId === action.transactionId,
    );
    if (!linked?.link) throw new Error("Spending link is stale, missing, or inactive.");
    revokeSpendingDedupLink(store, {
      decisionKey: `spending/user/revoke/${action.invoiceId}/${action.transactionId}/${query.purchaseReport.knowledgeAt}`,
      invoiceId: action.invoiceId,
      transactionId: action.transactionId,
      origin: { kind: "user", userId: LOCAL_SPENDING_USER_ID },
      evidenceKnowledgeSequence: query.purchaseReport.knowledgeAt,
      evidence: {
        reason: "user-revoked-link",
        priorEventId: linked.link.eventId,
      },
    });
    return actionResultAfterRecognitionMutation(query, store);
  } finally {
    store.close();
  }
}

export function loadSpending(
  ledgerDir = DEFAULT_LEDGER_DIR,
  { selectedMonth, selectedCategory }: SpendingLoadInput = {},
): SpendingPageDto {
  const query = currentSpendingQuery(ledgerDir);
  return pageFromQuery(query, query.purchaseReport, { selectedMonth, selectedCategory });
}

export function updateSpendingTransactionOverride(
  input: SpendingOverrideUpdate,
  ledgerDir = DEFAULT_LEDGER_DIR,
): void {
  void input;
  void ledgerDir;
  throw new Error("Canonical Spending does not support financial overrides.");
}

export function updateSpendingItemCategory(
  input: { itemKey: string; category: SpendingCategory },
  ledgerDir = DEFAULT_LEDGER_DIR,
): void {
  void input;
  void ledgerDir;
  throw new Error("Canonical Spending does not support legacy invoice categorization.");
}
