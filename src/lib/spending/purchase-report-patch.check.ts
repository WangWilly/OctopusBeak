import assert from "node:assert/strict";
import test from "node:test";
import type {
  SpendingPurchaseCandidateView,
  SpendingPurchaseRecordView,
  SpendingPurchaseReportView,
} from "./purchase-matching.ts";
import {
  applySpendingPurchaseReportPatch,
  createSpendingPurchaseReportPatch,
} from "./purchase-report-patch.ts";

function record(purchaseId: string, possibleDuplicate = false): SpendingPurchaseRecordView {
  return {
    purchaseId,
    basis: "invoice",
    amount: { currency: "TWD", coefficient: "100", scale: 0 },
    occurrence: { value: "2026-09-01", precision: "date", timeZone: "Asia/Taipei", basis: "purchase-date" },
    description: purchaseId,
    invoice: null,
    transaction: null,
    items: [],
    possibleDuplicate,
    candidateIds: possibleDuplicate ? [`candidate-${purchaseId}`] : [],
    link: null,
    difference: null,
    refund: null,
    category: { mode: "absent" },
    itemCategorizations: [],
  };
}

function candidate(candidateId: string, status: SpendingPurchaseCandidateView["status"]): SpendingPurchaseCandidateView {
  return { candidateId, algorithm: "test", algorithmVersion: "1", status };
}

function report(
  records: readonly SpendingPurchaseRecordView[],
  candidates: readonly SpendingPurchaseCandidateView[],
  knowledgeAt = 1,
): SpendingPurchaseReportView {
  return {
    status: "ok",
    kind: "current",
    knowledgeAt,
    financialAt: "2026-09-01T00:00:00.000Z",
    records,
    totalsByCurrency: [{ currency: "TWD", coefficient: String(records.length * 100), scale: 0, count: records.length }],
    totalStatus: records.some((value) => value.possibleDuplicate) ? "includes-pending-confirmation" : "complete",
    candidates,
  };
}

test("a Spending purchase report patch exactly reproduces sparse changes and ordering", () => {
  const unchanged = record("unchanged");
  const before = report(
    [record("removed"), unchanged, record("changed", true), record("moved")],
    [candidate("removed-candidate", "candidate"), candidate("changed-candidate", "candidate")],
  );
  const after = report(
    [record("moved"), unchanged, record("changed"), record("inserted")],
    [candidate("changed-candidate", "confirmed"), candidate("inserted-candidate", "candidate")],
    4,
  );

  const patch = createSpendingPurchaseReportPatch(before, after);
  assert.deepEqual(applySpendingPurchaseReportPatch(before, patch), after);
  assert.equal(patch.recordOperations.some((operation) => operation.kind === "remove"), true);
  assert.equal(patch.recordOperations.some((operation) => operation.kind === "move"), true);
  assert.equal(patch.recordOperations.some((operation) => operation.kind === "upsert"), true);
  assert.equal(
    patch.recordOperations.some((operation) => operation.kind === "upsert" && operation.value.purchaseId === "unchanged"),
    false,
    "unchanged records are not copied into the action response",
  );
});

test("applying a stale Spending patch fails instead of silently corrupting local state", () => {
  const current = report([record("current")], []);
  const patch = createSpendingPurchaseReportPatch(current, report([], []));
  assert.throws(
    () => applySpendingPurchaseReportPatch(report([record("different")], []), patch),
    /cannot remove missing current/,
  );
});

test("a Spending patch rejects a different knowledge snapshot", () => {
  const current = report([record("current")], [], 1);
  const patch = createSpendingPurchaseReportPatch(current, report([record("current")], [], 2));
  assert.throws(
    () => applySpendingPurchaseReportPatch(report([record("current")], [], 0), patch),
    /does not match the currently displayed report/,
  );
});

test("a one-record action does not clone hundreds of unchanged records", () => {
  const records = Array.from({ length: 600 }, (_, index) => record(`record-${index}`));
  const before = report(records, [], 10);
  const after = report(
    records.map((value, index) => index === 300 ? { ...value, description: "updated" } : value),
    [],
    11,
  );
  const patch = createSpendingPurchaseReportPatch(before, after);

  assert.equal(patch.recordOperations.length, 1);
  assert.equal(patch.recordOperations[0]?.kind, "upsert");
  assert.ok(JSON.stringify({ patch }).length < JSON.stringify({ purchaseReport: after }).length / 20,
    "the mutation payload stays below five percent of a full 600-record report");
});
