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

export type SpendingPurchaseActionResult = Readonly<{
  patch: SpendingPurchaseReportPatch;
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
    const currentIndex = index < working.length && identity(working[index]!) === id
      ? index
      : working.findIndex((value) => identity(value) === id);
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
    if (working[index] !== expected && !sameValue(working[index], expected)) {
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
  patch: SpendingPurchaseReportPatch,
): SpendingPurchaseReportView {
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
