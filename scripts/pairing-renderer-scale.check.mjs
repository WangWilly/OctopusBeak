import assert from "node:assert/strict";
import { makeRendererModel } from "./check-pglite-pairing-ui-performance.mjs";

const candidate = {
  purchaseId: "transaction:00000000-0000-4000-8000-000000000001",
  transactionId: "00000000-0000-4000-8000-000000000001",
  amount: { coefficient: "1000", scale: 0, currency: "TWD" },
  occurrence: { value: "2026-07-02", precision: "date", timeZone: "Asia/Taipei", basis: "purchase-date" },
  description: "Scale fixture payment",
  stream: "checking",
  effectiveDateBasis: null,
};
const model = makeRendererModel("00000000-0000-4000-8000-000000000002", candidate);
const records = model.purchaseReport.records;

assert.equal(records.length, 100_000, "the renderer Pairing fixture must expose 100k report records");
assert.equal(records.filter((record) => record.basis === "linked").length, 9_999);
assert.equal(records.filter((record) => record.basis === "invoice").length, 1);
assert.equal(records.filter((record) => record.basis === "bank-transaction").length, 90_000);
assert.equal(new Set(records.flatMap((record) => record.invoice?.invoiceId ?? [])).size, 10_000);
