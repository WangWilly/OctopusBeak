import assert from "node:assert/strict";
import { creditCardSemanticKey } from "./credit-card-identity.ts";

const base = {
  bank: " esun ",
  cardNumber: "1234-5678-9012-3456",
  statementType: "billed",
  consumeDate: "2026-07-01",
  description: " coffee ",
  foreignCurrency: "TWD",
  foreignAmount: null,
  twdAmount: 100,
  installmentAction: null,
  paymentStatus: "paid",
  statementPeriod: "2025/06/27 ~ 2026/06/27",
  sourceRelativePath: "first.csv",
  importedAt: "2026-07-01T00:00:00.000Z",
};

assert.equal(
  creditCardSemanticKey(base),
  creditCardSemanticKey({
    ...base,
    bank: "esun",
    cardNumber: "3456",
    description: "coffee",
    statementPeriod: "2025/07/12 ~ 2026/07/12",
    sourceRelativePath: "second.csv",
    importedAt: "2026-07-12T00:00:00.000Z",
  }),
);

for (const changed of [
  { cardNumber: "9999" },
  { twdAmount: 101 },
  { consumeDate: "2026-07-02" },
  { description: "tea" },
  { foreignCurrency: "USD" },
  { statementType: "unbilled" },
  { installmentAction: "installment" },
  { paymentStatus: "unpaid" },
]) {
  assert.notEqual(creditCardSemanticKey(base), creditCardSemanticKey({ ...base, ...changed }));
}
