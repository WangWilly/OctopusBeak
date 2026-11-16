import assert from "node:assert/strict";
import { test } from "node:test";
import { derivePGliteKindCategory, derivePGliteTransactionKind, type PGliteProjectionTransaction } from "./enrichment.ts";
import { TRANSACTION_KIND_CODES } from "../canonical/transaction-taxonomy.ts";

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
  institutionKey: "esun",
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

const eventRow = (integrationNamespace: string, stream: string, accountEvent: PGliteProjectionTransaction["accountEvent"]): PGliteProjectionTransaction =>
  ({ ...card("inflow", "說明文字不影響結果"), integrationNamespace, stream, accountEvent });

test("an investment row's Kind is its recorded action, never its description (ADR 0138)", () => {
  const cases = [
    ["buy", "investment.trade.buy"],
    ["sell", "investment.trade.sell"],
    ["corporate_action_in", "investment.corporate_action"],
    ["corporate_action_out", "investment.corporate_action"],
    ["dividend", "income.dividend"],
  ] as const;
  for (const [action, expected] of cases) {
    const kind = derivePGliteTransactionKind(eventRow("maicoin", "investment", { evidenceKind: "investment-event", value: action }));
    assert.deepEqual([kind?.value, kind?.evidenceKind, kind?.sourceValue], [expected, "investment-event", action], action);
    assert.equal(kind?.routeId, "maicoin/investment/event-kind-enrichment/v1/kind");
  }
});

test("a loan row's Kind is its recorded event kind (ADR 0138)", () => {
  const cases = [
    ["payment", "payment.loan"],
    ["disbursement", "loan.disbursement"],
    ["interest", "interest.charged"],
    ["fee", "fee.loan"],
  ] as const;
  for (const [event, expected] of cases) {
    const kind = derivePGliteTransactionKind(eventRow("yuanta", "loan", { evidenceKind: "loan-event", value: event }));
    assert.deepEqual([kind?.value, kind?.evidenceKind, kind?.routeId], [expected, "loan-event", "yuanta/loan/event-kind-enrichment/v1/kind"], event);
  }
});

test("an investment or loan row without its event gets no Kind, and a stream outside the routes none either", () => {
  assert.equal(derivePGliteTransactionKind(eventRow("fubon", "loan", null)), null);
  assert.equal(derivePGliteTransactionKind(eventRow("tdcc", "investment", { evidenceKind: "investment-event", value: "buy" })), null);
});

const deposit = (integrationNamespace: string, institutionKey: string, direction: "inflow" | "outflow", description: string): PGliteProjectionTransaction =>
  ({ ...card(direction, description), integrationNamespace, institutionKey, stream: "domestic-deposit" });

test("a TDCC settlement deposit gets a bank Kind on its own route, read by its maintaining Institution", () => {
  const exchange = derivePGliteTransactionKind(deposit("tdcc", "fubon", "inflow", "行動換匯 · 0123"));
  assert.deepEqual([exchange?.value, exchange?.routeId], ["transfer.internal", "tdcc/domestic-deposit/kind-enrichment/v4/kind"]);
  const otherBank = derivePGliteTransactionKind(deposit("tdcc", "bank-007", "outflow", "提款"));
  assert.deepEqual([otherBank?.value, otherBank?.producerId], ["cash.withdrawal", "bank/deposit-kind-enrichment"]);
});

test("a Cathay passbook label gets its Kind on Cathay's route", () => {
  const kind = derivePGliteTransactionKind(deposit("cathay", "cathay", "outflow", "跨行提款"));
  assert.deepEqual([kind?.value, kind?.outputState, kind?.routeId], ["cash.withdrawal", "supported", "cathay/domestic-deposit/automatic-enrichment/v1/kind"]);
});

test("interest charged and a bank, card or loan fee derive the interest-and-fees category from the Kind, and no other Kind derives one (ADR 0141)", () => {
  const derived = TRANSACTION_KIND_CODES.flatMap((kind) => {
    const category = derivePGliteKindCategory(kind);
    return category ? [[kind, category.value, category.sourceValue, category.evidenceKind]] : [];
  });
  assert.deepEqual(derived, [
    ["fee.bank", "interest_and_fees", "fee.bank", "kind"],
    ["fee.card", "interest_and_fees", "fee.card", "kind"],
    ["fee.loan", "interest_and_fees", "fee.loan", "kind"],
    ["interest.charged", "interest_and_fees", "interest.charged", "kind"],
  ]);
  assert.equal(derivePGliteKindCategory(null), null);
  assert.equal(derivePGliteKindCategory("fee.investment"), null, "an investment-account fee never counts (ADR 0138)");
});
