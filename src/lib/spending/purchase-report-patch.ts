import type {
  SpendingPurchaseCandidateView,
  SpendingPurchaseRecordView,
  SpendingPurchaseReportView,
} from "./purchase-matching.ts";

export type SpendingSequencePatchOperation<T> =
  | Readonly<{ kind: "remove"; id: string }>
  | Readonly<{ kind: "move"; id: string; index: number }>
  | Readonly<{ kind: "upsert"; index: number; value: T }>;

export type SpendingPurchaseReportPatch = Readonly<{
  kind: "spending-purchase-report-patch";
  baseKnowledgeAt: number;
  status: SpendingPurchaseReportView["status"];
  reportKind: SpendingPurchaseReportView["kind"];
  knowledgeAt: number;
  financialAt: string | null;
  totalsByCurrency: SpendingPurchaseReportView["totalsByCurrency"];
  totalStatus: SpendingPurchaseReportView["totalStatus"];
  recordOperations: readonly SpendingSequencePatchOperation<SpendingPurchaseRecordView>[];
  candidateOperations: readonly SpendingSequencePatchOperation<SpendingPurchaseCandidateView>[];
}>;

/**
 * The write-side Spending command intentionally returns only the recognition
 * change.  The renderer already owns the current purchase report and can
 * materialize the affected invoice/payment records from that generation.  A
 * full report is therefore never required on the confirmation critical path.
 */
export type SpendingRecognitionReportPatch = Readonly<{
  kind: "spending-recognition-patch";
  baseKnowledgeAt: number;
  knowledgeAt: number;
  operation: "establish-link" | "remove-link";
  invoiceId: string;
  transactionId: string;
  eventId: string;
}>;

export type SpendingPurchaseActionPatch = SpendingPurchaseReportPatch | SpendingRecognitionReportPatch;

export type SpendingPurchaseActionResult = Readonly<{
  knowledgePoint: number;
  patch: SpendingPurchaseActionPatch;
}>;

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sequencePatch<T>(
  before: readonly T[],
  after: readonly T[],
  identity: (value: T) => string,
): SpendingSequencePatchOperation<T>[] {
  const operations: SpendingSequencePatchOperation<T>[] = [];
  const working = [...before];
  const wanted = new Set(after.map(identity));

  for (let index = working.length - 1; index >= 0; index -= 1) {
    const id = identity(working[index]!);
    if (wanted.has(id)) continue;
    operations.push({ kind: "remove", id });
    working.splice(index, 1);
  }

  for (let index = 0; index < after.length; index += 1) {
    const expected = after[index]!;
    const id = identity(expected);
    const currentIndex = working.findIndex((value) => identity(value) === id);
    if (currentIndex === -1) {
      operations.push({ kind: "upsert", index, value: expected });
      working.splice(index, 0, expected);
      continue;
    }
    if (currentIndex !== index) {
      operations.push({ kind: "move", id, index });
      const [moved] = working.splice(currentIndex, 1);
      working.splice(index, 0, moved!);
    }
    if (!sameValue(working[index], expected)) {
      operations.push({ kind: "upsert", index, value: expected });
      working.splice(index, 1, expected);
    }
  }
  return operations;
}

function applySequencePatch<T>(
  current: readonly T[],
  operations: readonly SpendingSequencePatchOperation<T>[],
  identity: (value: T) => string,
): readonly T[] {
  const next = [...current];
  for (const operation of operations) {
    if (operation.kind === "remove") {
      const index = next.findIndex((value) => identity(value) === operation.id);
      if (index === -1) throw new Error(`Spending patch cannot remove missing ${operation.id}.`);
      next.splice(index, 1);
      continue;
    }
    if (!Number.isSafeInteger(operation.index) || operation.index < 0 || operation.index > next.length)
      throw new Error("Spending patch contains an invalid sequence index.");
    if (operation.kind === "move") {
      const currentIndex = next.findIndex((value) => identity(value) === operation.id);
      if (currentIndex === -1) throw new Error(`Spending patch cannot move missing ${operation.id}.`);
      const [moved] = next.splice(currentIndex, 1);
      next.splice(operation.index, 0, moved!);
      continue;
    }
    const id = identity(operation.value);
    const currentIndex = next.findIndex((value) => identity(value) === id);
    if (currentIndex >= 0) next.splice(currentIndex, 1);
    next.splice(operation.index, 0, operation.value);
  }
  return Object.freeze(next);
}

export function createSpendingPurchaseReportPatch(
  before: SpendingPurchaseReportView,
  after: SpendingPurchaseReportView,
): SpendingPurchaseReportPatch {
  const patch: SpendingPurchaseReportPatch = Object.freeze({
    kind: "spending-purchase-report-patch",
    baseKnowledgeAt: before.knowledgeAt,
    status: after.status,
    reportKind: after.kind,
    knowledgeAt: after.knowledgeAt,
    financialAt: after.financialAt,
    totalsByCurrency: after.totalsByCurrency,
    totalStatus: after.totalStatus,
    recordOperations: Object.freeze(sequencePatch(before.records, after.records, (record) => record.purchaseId)),
    candidateOperations: Object.freeze(sequencePatch(before.candidates, after.candidates, (candidate) => candidate.candidateId)),
  });
  if (!sameValue(applySpendingPurchaseReportPatch(before, patch), after))
    throw new Error("Spending report patch did not reproduce the committed report.");
  return patch;
}

export function applySpendingPurchaseReportPatch(
  current: SpendingPurchaseReportView,
  patch: SpendingPurchaseActionPatch,
): SpendingPurchaseReportView {
  if (patch.kind === "spending-recognition-patch")
    return applySpendingRecognitionReportPatch(current, patch);
  if (patch.kind !== "spending-purchase-report-patch") throw new Error("Spending report patch kind is invalid.");
  if (current.knowledgeAt !== patch.baseKnowledgeAt)
    throw new Error("Spending report patch does not match the currently displayed report.");
  return Object.freeze({
    status: patch.status,
    kind: patch.reportKind,
    knowledgeAt: patch.knowledgeAt,
    financialAt: patch.financialAt,
    records: applySequencePatch(current.records, patch.recordOperations, (record) => record.purchaseId),
    totalsByCurrency: patch.totalsByCurrency,
    totalStatus: patch.totalStatus,
    candidates: applySequencePatch(current.candidates, patch.candidateOperations, (candidate) => candidate.candidateId),
  });
}

function exactMoneyAdd(
  left: SpendingPurchaseReportView["totalsByCurrency"][number],
  right: SpendingPurchaseReportView["totalsByCurrency"][number],
): SpendingPurchaseReportView["totalsByCurrency"][number] {
  if (left.currency !== right.currency) throw new Error("Spending report patch money currencies do not match.");
  const scale = Math.max(left.scale, right.scale);
  return {
    currency: left.currency,
    coefficient: (
      BigInt(left.coefficient) * 10n ** BigInt(scale - left.scale) +
      BigInt(right.coefficient) * 10n ** BigInt(scale - right.scale)
    ).toString(),
    scale,
    count: left.count + right.count,
  };
}

function recordMoney(record: SpendingPurchaseRecordView): SpendingPurchaseReportView["totalsByCurrency"][number] | null {
  if (!record.amount) return null;
  return { ...record.amount, count: 1 };
}

function totalsForRecords(
  records: readonly SpendingPurchaseRecordView[],
): SpendingPurchaseReportView["totalsByCurrency"] {
  const totals = new Map<string, SpendingPurchaseReportView["totalsByCurrency"][number]>();
  for (const record of records) {
    const amount = recordMoney(record);
    if (!amount) continue;
    const previous = totals.get(amount.currency);
    totals.set(amount.currency, previous ? exactMoneyAdd(previous, amount) : amount);
  }
  return Object.freeze([...totals.values()].sort((left, right) => left.currency.localeCompare(right.currency)));
}

function transactionOccurrence(
  transaction: NonNullable<SpendingPurchaseRecordView["transaction"]>,
): SpendingPurchaseRecordView["occurrence"] {
  const value = transaction.consumeDate ?? transaction.postingDate ?? transaction.effectiveOn;
  return {
    value,
    precision: "date",
    timeZone: "unknown",
    basis: transaction.consumeDate ? "purchase-date" : "posting-date-fallback",
  };
}

function linkedRecord(
  invoice: SpendingPurchaseRecordView,
  transaction: SpendingPurchaseRecordView,
  patch: SpendingRecognitionReportPatch,
): SpendingPurchaseRecordView {
  if (!invoice.invoice || !transaction.transaction)
    throw new Error("Spending recognition patch is missing the invoice or transaction record.");
  const invoiceAmount = invoice.amount;
  const bankAmount = transaction.transaction.amount;
  return {
    purchaseId: `link:${patch.eventId}`,
    basis: "linked",
    amount: bankAmount,
    occurrence: invoice.occurrence,
    description: invoice.invoice.revision.seller.name ?? transaction.transaction.description,
    invoice: invoice.invoice,
    transaction: transaction.transaction,
    items: invoice.items,
    possibleDuplicate: false,
    candidateIds: [],
    link: {
      invoiceId: patch.invoiceId,
      transactionId: patch.transactionId,
      eventId: patch.eventId,
      origin: "user",
      evidenceKnowledgeSequence: patch.knowledgeAt,
      evidence: { command: `spending/command/v1/${patch.operation}` },
      // These fields are part of the canonical server view.  The browser
      // contract intentionally exposes only the subset needed for rendering,
      // but retaining them here lets a sparse patch reproduce a compatibility
      // report exactly when it is used by a non-product caller.
      userId: "local-user",
      authorityRoute: null,
      stableCrossSourceReference: null,
      decisionCommitSequence: patch.knowledgeAt,
    } as SpendingPurchaseRecordView["link"],
    difference: {
      invoiceAmount,
      bankAmount,
      sameCurrency: invoiceAmount?.currency === bankAmount.currency,
      exactAmountEqual: invoiceAmount
        ? invoiceAmount.currency === bankAmount.currency &&
          BigInt(invoiceAmount.coefficient) * 10n ** BigInt(Math.max(invoiceAmount.scale, bankAmount.scale) - invoiceAmount.scale) ===
          BigInt(bankAmount.coefficient) * 10n ** BigInt(Math.max(invoiceAmount.scale, bankAmount.scale) - bankAmount.scale)
        : false,
    },
    refund: null,
  };
}

function standaloneInvoice(record: SpendingPurchaseRecordView): SpendingPurchaseRecordView {
  if (!record.invoice) throw new Error("Spending recognition patch invoice record is missing invoice facts.");
  const amount = record.invoice.revision.total
    ? {
        currency: record.invoice.revision.total.currency,
        coefficient: record.invoice.revision.total.coefficient,
        scale: record.invoice.revision.total.scale,
      }
    : null;
  return {
    purchaseId: `invoice:${record.invoice.invoiceId}`,
    basis: "invoice",
    amount,
    occurrence: record.occurrence,
    description: record.invoice.revision.seller.name,
    invoice: record.invoice,
    transaction: null,
    items: record.items,
    possibleDuplicate: false,
    candidateIds: [],
    link: null,
    difference: null,
    refund: null,
  };
}

function standaloneTransaction(record: SpendingPurchaseRecordView): SpendingPurchaseRecordView {
  if (!record.transaction) throw new Error("Spending recognition patch transaction record is missing transaction facts.");
  return {
    purchaseId: `transaction:${record.transaction.transactionId}`,
    basis: "bank-transaction",
    amount: record.transaction.amount,
    occurrence: transactionOccurrence(record.transaction),
    description: record.transaction.description,
    invoice: null,
    transaction: record.transaction,
    items: [],
    possibleDuplicate: false,
    candidateIds: [],
    link: null,
    difference: null,
    refund: null,
  };
}

function sortRecords(records: readonly SpendingPurchaseRecordView[]): readonly SpendingPurchaseRecordView[] {
  return Object.freeze([...records].sort((left, right) =>
    left.occurrence.value.localeCompare(right.occurrence.value) || left.purchaseId.localeCompare(right.purchaseId)));
}

function applySpendingRecognitionReportPatch(
  current: SpendingPurchaseReportView,
  patch: SpendingRecognitionReportPatch,
): SpendingPurchaseReportView {
  if (current.knowledgeAt !== patch.baseKnowledgeAt)
    throw new Error("Spending recognition patch does not match the currently displayed report.");
  const invoice = current.records.find((record) =>
    record.invoice?.invoiceId === patch.invoiceId && record.basis !== "linked",
  );
  const transaction = current.records.find((record) =>
    record.transaction?.transactionId === patch.transactionId && record.basis !== "linked",
  );
  const linked = current.records.find((record) =>
    record.basis === "linked" && record.link?.invoiceId === patch.invoiceId && record.link?.transactionId === patch.transactionId,
  );
  let records: SpendingPurchaseRecordView[];
  let candidates = [...current.candidates];
  if (patch.operation === "establish-link") {
    if (!invoice || !transaction) throw new Error("Spending recognition patch cannot find its current pair.");
    const candidateIds = new Set([...invoice.candidateIds, ...transaction.candidateIds]);
    records = current.records
      .filter((record) => record !== invoice && record !== transaction)
      .map((record) => candidateIds.size === 0
        ? record
        : { ...record, candidateIds: record.candidateIds.filter((id) => !candidateIds.has(id)), possibleDuplicate: record.candidateIds.some((id) => !candidateIds.has(id)) })
      .concat(linkedRecord(invoice, transaction, patch));
    candidates = candidates.filter((candidate) => !candidateIds.has(candidate.candidateId));
  } else {
    if (!linked?.invoice || !linked.transaction) throw new Error("Spending recognition patch cannot find its active link.");
    records = current.records.filter((record) => record !== linked)
      .concat(standaloneInvoice(linked), standaloneTransaction(linked));
  }
  const sorted = sortRecords(records);
  return Object.freeze({
    ...current,
    knowledgeAt: patch.knowledgeAt,
    records: sorted,
    totalsByCurrency: totalsForRecords(sorted),
    totalStatus: sorted.some((record) => record.possibleDuplicate)
      ? "includes-pending-confirmation"
      : "complete",
    candidates: Object.freeze(candidates),
  });
}
