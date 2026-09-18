import assert from "node:assert/strict";
import test from "node:test";
import {
  applyValidatedSpendingActionResult,
  beginSpendingPendingCommand,
  completeSpendingPendingCommand,
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

  assert.equal(first.idempotencyKey, afterReload.idempotencyKey);
  assert.match(first.idempotencyKey, /^renderer-/u);
  const serialized = storage.read(spendingPendingCommandStorageKey);
  assert.ok(serialized);
  assert.doesNotMatch(serialized, /amount|merchant|description|account|payload/iu);

  completeSpendingPendingCommand(afterReload, storage, 300);
  assert.equal(storage.read(spendingPendingCommandStorageKey), null);
});

test("pending Spending commands are bounded and action identities stay distinct", () => {
  const storage = memoryStorage();
  for (let index = 0; index < 40; index += 1) {
    beginSpendingPendingCommand({
      action: "unlink",
      firstId: `invoice-${index}`,
      secondId: `transaction-${index}`,
    }, storage, 1_000 + index);
  }
  const parsed = JSON.parse(storage.read(spendingPendingCommandStorageKey) ?? "null") as { commands: unknown[] };
  assert.equal(parsed.commands.length, 32);
  const first = beginSpendingPendingCommand({ action: "unlink", firstId: "invoice-39", secondId: "transaction-39" }, storage, 2_000);
  const different = beginSpendingPendingCommand({ action: "unlink", firstId: "invoice-38", secondId: "transaction-38" }, storage, 2_001);
  assert.notEqual(first.idempotencyKey, different.idempotencyKey);
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
