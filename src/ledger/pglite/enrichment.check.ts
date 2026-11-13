import assert from "node:assert/strict";
import { test } from "node:test";
import { derivePGliteTransactionKind, type PGliteProjectionTransaction } from "./enrichment.ts";

const card = (direction: "inflow" | "outflow", description: string): PGliteProjectionTransaction => ({
  transactionId: "00000000-0000-4000-8000-000000000001",
  sourceRecordId: "00000000-0000-4000-8000-000000000002",
  direction,
  amountCoefficient: "5000",
  amountScale: 0,
  currency: "TWD",
  effectiveOn: "2026-10-05",
  description,
  sourcePayload: null,
  integrationNamespace: "esun",
  stream: "credit-card",
  sourceConnectionKey: "connection",
  identityEpoch: "epoch",
});

test("a card bill payment credit gets payment.credit_card from its label, on the card route", () => {
  const kind = derivePGliteTransactionKind(card("inflow", "自動扣繳 謝謝"));
  assert.equal(kind?.value, "payment.credit_card");
  assert.equal(kind?.evidenceKind, "bank-rule");
  assert.equal(kind?.routeId, "esun/credit-card/direction-enrichment/v1/kind");
  assert.equal(kind?.ruleLineage, "credit-card/direction/v1/inflow-description",
    "a new lineage makes an earlier direction-only refund re-derive");
});

test("a card inflow whose label names nothing keeps the direction fallback", () => {
  const kind = derivePGliteTransactionKind(card("inflow", "全聯福利中心"));
  assert.deepEqual([kind?.value, kind?.evidenceKind, kind?.ruleLineage], ["refund", "direction", "credit-card/direction/v1/direction-fallback"]);
});

test("a card outflow stays a purchase whatever its label says", () => {
  const kind = derivePGliteTransactionKind(card("outflow", "繳費 中華電信"));
  assert.deepEqual([kind?.value, kind?.evidenceKind], ["purchase", "direction"]);
});
