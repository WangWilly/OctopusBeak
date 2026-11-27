import assert from "node:assert/strict";
import test from "node:test";
import { maicoinCashFlowIncome, maicoinValueTwd, type CryptoOutflow, type MaicoinInflow } from "./maicoin-cash-flow-income.ts";

const twd = (coefficient: string, scale = 0) => ({ coefficient, scale, currency: "TWD" });
const deposit = (transactionId: string, quantity: string, date = "2026-09-10", coin = "USDT"): MaicoinInflow => ({
  transactionId, coin, quantity: { coefficient: quantity, scale: 0 }, date,
  statement: { rowType: "deposit", valueTwd: twd("1000") },
});
const withdrawal = (transactionId: string, coefficient: string, scale = 0, date = "2026-09-10", coin = "USDT"): CryptoOutflow => ({
  transactionId, coin, quantity: { coefficient, scale }, date,
});

test("the admitted exact value rounds half-up to cents", () => {
  assert.deepEqual(maicoinValueTwd(twd("2675", 3)), { coefficient: "268", scale: 2, currency: "TWD" });
  assert.deepEqual(maicoinValueTwd(twd("4", 3)), { coefficient: "0", scale: 0, currency: "TWD" });
  assert.deepEqual(maicoinValueTwd(twd("12")), { coefficient: "12", scale: 0, currency: "TWD" });
  assert.deepEqual(maicoinValueTwd(twd("1234567890123456789012345", 20)), { coefficient: "1234568", scale: 2, currency: "TWD" });
  assert.equal(maicoinValueTwd(null), null);
});

test("a withdrawal up to exactly 1% above the deposit is the same transfer", () => {
  assert.equal(maicoinCashFlowIncome([deposit("in", "200")], [withdrawal("out", "202")]).has("in"), false);
  assert.equal(maicoinCashFlowIncome([deposit("in", "200")], [withdrawal("out", "20201", 2)]).get("in")?.group, "income");
  assert.equal(maicoinCashFlowIncome([deposit("in", "200", "2026-09-10")], [withdrawal("out", "200", 0, "2026-09-13")]).has("in"), false);
  assert.equal(maicoinCashFlowIncome([deposit("in", "200", "2026-09-10")], [withdrawal("out", "200", 0, "2026-09-14")]).has("in"), true);
});

test("two deposits sharing one withdrawal both count", () => {
  const income = maicoinCashFlowIncome([deposit("a", "200"), deposit("b", "200")], [withdrawal("out", "200")]);
  assert.deepEqual([...income.keys()].sort(), ["a", "b"]);
});

test("a reward never matches a withdrawal, and a TWD deposit or another row type is not income", () => {
  const reward: MaicoinInflow = { ...deposit("reward", "200"), statement: { rowType: "reward", valueTwd: twd("5") } };
  const twdDeposit = deposit("twd", "200", "2026-09-10", "TWD");
  const transfer: MaicoinInflow = { ...deposit("transfer", "200"), statement: { rowType: "transfer", valueTwd: twd("5") } };
  const income = maicoinCashFlowIncome([reward, twdDeposit, transfer], [withdrawal("out", "200")]);
  assert.deepEqual([...income], [["reward", { group: "income.reward", value: { coefficient: "5", scale: 0, currency: "TWD" } }]]);
});
