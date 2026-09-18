import assert from "node:assert/strict";
import test from "node:test";
import {
  applyValidatedSpendingActionResult,
  beginSpendingPendingCommand,
  completeSpendingPendingCommand,
  spendingActionOutcomeConfirmed,
  spendingActionErrorCode,
  spendingPendingCommandStorageKey,
} from "./spending-action-lifecycle.ts";
import type { SpendingPurchaseReportView } from "./purchase-matching.ts";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
    removeItem(key: string) { values.delete(key); },
    read(key: string) { return values.get(key) ?? null; },
  };
}

function report(knowledgeAt = 10): SpendingPurchaseReportView {
  return {
    status: "ok",
    kind: "current",
    knowledgeAt,
    financialAt: null,
    records: [],
    totalsByCurrency: [],
    totalStatus: "complete",
    candidates: [],
  };
}

test("a logical Spending action reuses its opaque key after renderer reload", () => {
  const storage = memoryStorage();
  const identity = {
    action: "direct-pair" as const,
    firstId: "invoice-1",
    secondId: "transaction-1",
  };
  const first = beginSpendingPendingCommand(identity, storage, 100);
  const afterReload = beginSpendingPendingCommand(identity, storage, 200);
  const afterDay = beginSpendingPendingCommand(identity, storage, 100 + 25 * 60 * 60 * 1000);

  assert.equal(first.idempotencyKey, afterReload.idempotencyKey);
  assert.equal(first.idempotencyKey, afterDay.idempotencyKey);
  assert.match(first.idempotencyKey, /^renderer-/u);
  const serialized = storage.read(spendingPendingCommandStorageKey);
  assert.ok(serialized);
  assert.doesNotMatch(serialized, /amount|merchant|description|account|payload/iu);

  completeSpendingPendingCommand(afterReload, storage, 300);
  assert.equal(storage.read(spendingPendingCommandStorageKey), null);
});

test("pending Spending commands keep distinct action identities", () => {
  const storage = memoryStorage();
  for (let index = 0; index < 2; index += 1) {
    beginSpendingPendingCommand({
      action: "unlink",
      firstId: `invoice-${index}`,
      secondId: `transaction-${index}`,
    }, storage, 1_000 + index);
  }
  const parsed = JSON.parse(storage.read(spendingPendingCommandStorageKey) ?? "null") as { commands: unknown[] };
  assert.equal(parsed.commands.length, 2);
  const first = beginSpendingPendingCommand({ action: "unlink", firstId: "invoice-0", secondId: "transaction-0" }, storage, 2_000);
  const different = beginSpendingPendingCommand({ action: "unlink", firstId: "invoice-1", secondId: "transaction-1" }, storage, 2_001);
  assert.notEqual(first.idempotencyKey, different.idempotencyKey);
});

test("pending command capacity fails closed without evicting an unresolved key", () => {
  const storage = memoryStorage();
  const first = beginSpendingPendingCommand({
    action: "unlink",
    firstId: "invoice-0",
    secondId: "transaction-0",
  }, storage, 1_000);
  for (let index = 1; index < 32; index += 1) {
    beginSpendingPendingCommand({
      action: "unlink",
      firstId: `invoice-${index}`,
      secondId: `transaction-${index}`,
    }, storage, 1_000 + index);
  }

  assert.throws(
    () => beginSpendingPendingCommand({
      action: "unlink",
      firstId: "invoice-over-capacity",
      secondId: "transaction-over-capacity",
    }, storage, 2_000),
    /idempotency-storage-unavailable/iu,
  );
  const afterCapacityFailure = beginSpendingPendingCommand({
    action: "unlink",
    firstId: "invoice-0",
    secondId: "transaction-0",
  }, storage, 2_001);
  assert.equal(afterCapacityFailure.idempotencyKey, first.idempotencyKey);
});

test("storage read and write failures fail closed without issuing an ephemeral key", () => {
  const readFailure = {
    getItem() { throw new Error("storage read failed"); },
    setItem() { throw new Error("storage write failed"); },
    removeItem() { throw new Error("storage remove failed"); },
  };
  const identity = {
    action: "direct-pair" as const,
    firstId: "invoice-1",
    secondId: "transaction-1",
  };

  assert.throws(
    () => beginSpendingPendingCommand(identity, readFailure),
    /idempotency-storage-unavailable/iu,
  );
  assert.equal(
    spendingActionErrorCode(new Error("idempotency-storage-unavailable")),
    "idempotency-storage-unavailable",
  );

  const writeFailure = {
    getItem() { return null; },
    setItem() { throw new Error("storage write failed"); },
    removeItem() { return undefined; },
  };
  assert.throws(
    () => beginSpendingPendingCommand(identity, writeFailure),
    /idempotency-storage-unavailable/iu,
  );
});

test("action receipts cannot apply a patch from another displayed generation", () => {
  const current = report(10);
  const result = {
    knowledgePoint: 12,
    patch: {
      kind: "spending-recognition-patch" as const,
      baseKnowledgeAt: 11,
      knowledgeAt: 12,
      operation: "establish-link" as const,
      invoiceId: "invoice-1",
      transactionId: "transaction-1",
      eventId: "event-1",
    },
  };
  assert.throws(
    () => applyValidatedSpendingActionResult(current, result),
    /spending-action-stale/iu,
  );
});

test("a reconciled projection confirms pair and unlink outcomes explicitly", () => {
  const linked = {
    ...report(12),
    records: [{
      link: { invoiceId: "invoice-1", transactionId: "transaction-1" },
    } as SpendingPurchaseReportView["records"][number]],
  };
  const pair = {
    action: "direct-pair" as const,
    firstId: "invoice-1",
    secondId: "transaction-1",
  };
  const unlink = { ...pair, action: "unlink" as const };

  assert.equal(spendingActionOutcomeConfirmed(linked, pair), true);
  assert.equal(spendingActionOutcomeConfirmed(linked, unlink), false);
  assert.equal(spendingActionOutcomeConfirmed(report(12), pair), false);
  assert.equal(spendingActionOutcomeConfirmed(report(12), unlink), true);
});
