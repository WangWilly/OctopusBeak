import assert from "node:assert/strict";
import test from "node:test";
import {
  addExact,
  addKeepingScale,
  addMoney,
  addToTotals,
  compareExact,
  compareMoney,
  decimalToExact,
  divideExact,
  equalMoney,
  ExactMoneyError,
  exactToNumber,
  isZeroExact,
  mergeMoneyTotals,
  moneyKey,
  moneyTotals,
  multiplyExact,
  negateMoney,
  normalizeExact,
  normalizeMoney,
  parseExactAmount,
  parseExactMoney,
  readTotals,
  subtractMoney,
  type ExactMoney,
  type MoneyTotalsAccumulator,
} from "./exact-money.ts";

const money = (coefficient: string, scale: number, currency = "TWD"): ExactMoney => ({ coefficient, scale, currency });

/** A small seeded generator (mulberry32) so property failures replay exactly. */
function generator(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const integer = (max: number) => Math.floor(next() * (max + 1));
  const pick = <T>(values: readonly T[]): T => values[integer(values.length - 1)]!;
  const amount = (): ExactMoney => {
    const digits = Array.from({ length: 1 + integer(24) }, () => String(integer(9))).join("");
    const sign = next() < 0.3 ? "-" : "";
    const coefficient = next() < 0.1 ? "0" : `${sign}${digits}`;
    return money(coefficient, integer(6), pick(["TWD", "twd", " TWD ", "USD", "usd", "JPY"]));
  };
  return { integer, amount, list: (max: number) => Array.from({ length: integer(max) }, amount) };
}

const RUNS = 300;

test("parse validates the boundary and returns the value as given", () => {
  assert.deepEqual(parseExactMoney({ coefficient: "-1050", scale: 2, currency: "twd" }), money("-1050", 2, "twd"));
  assert.deepEqual(parseExactAmount({ coefficient: "7", scale: 1000 }), { coefficient: "7", scale: 1000 });
  for (const bad of [
    null,
    { coefficient: "1.5", scale: 0, currency: "TWD" },
    { coefficient: "", scale: 0, currency: "TWD" },
    { coefficient: 15, scale: 0, currency: "TWD" },
    { coefficient: "15", scale: -1, currency: "TWD" },
    { coefficient: "15", scale: 1001, currency: "TWD" },
    { coefficient: "15", scale: 1.5, currency: "TWD" },
    { coefficient: "15", scale: 0, currency: " " },
    { coefficient: "15", scale: 0 },
  ]) assert.throws(() => parseExactMoney(bad), ExactMoneyError, JSON.stringify(bad));
});

test("normalize reduces scale, folds zero, and upper-cases the currency", () => {
  assert.deepEqual(normalizeMoney(money("10000", 2, " twd ")), money("100", 0, "TWD"));
  assert.deepEqual(normalizeMoney(money("-1050", 3)), money("-105", 2));
  assert.deepEqual(normalizeMoney(money("0", 4)), money("0", 0));
  assert.deepEqual(normalizeMoney(money("-0", 2)), money("0", 0));
  assert.deepEqual(normalizeExact({ coefficient: "120", scale: 0 }), { coefficient: "120", scale: 0 }, "integer zeros stay");
});

test("money of one currency adds, subtracts, compares, and equals across case and scale", () => {
  assert.deepEqual(addMoney(money("10000", 2, "twd"), money("5", 0)), money("105", 0));
  assert.deepEqual(subtractMoney(money("1", 0), money("150", 2, "Twd")), money("-5", 1));
  assert.deepEqual(negateMoney(money("1200", 2, "usd")), money("-12", 0, "USD"));
  assert.equal(compareMoney(money("100", 0), money("10001", 2)), -1);
  assert.equal(equalMoney(money("100", 0, "twd"), money("10000", 2, "TWD")), true, "100 equals 100.00");
  assert.equal(equalMoney(money("100", 0, "TWD"), money("100", 0, "USD")), false);
  assert.equal(moneyKey(money("10000", 2, " twd")), "TWD:100:0");
  assert.throws(() => addMoney(money("1", 0, "TWD"), money("1", 0, "USD")), ExactMoneyError);
  assert.throws(() => compareMoney(money("1", 0, "TWD"), money("1", 0, "USD")), ExactMoneyError);
});

test("addKeepingScale keeps the larger operand scale for display totals", () => {
  assert.deepEqual(addKeepingScale({ coefficient: "100", scale: 2 }, { coefficient: "2", scale: 0 }), { coefficient: "300", scale: 2 });
  assert.deepEqual(addKeepingScale({ coefficient: "100", scale: 2 }, { coefficient: "-100", scale: 2 }), { coefficient: "0", scale: 2 });
});

test("scalar operations keep their earlier behaviour", () => {
  assert.deepEqual(multiplyExact({ coefficient: "15", scale: 1 }, { coefficient: "20", scale: 1 }), { coefficient: "3", scale: 0 });
  assert.deepEqual(divideExact({ coefficient: "1", scale: 0 }, { coefficient: "3", scale: 0 }, 4), { coefficient: "3333", scale: 4 });
  assert.deepEqual(divideExact({ coefficient: "2", scale: 0 }, { coefficient: "3", scale: 0 }, 2), { coefficient: "67", scale: 2 }, "half-up");
  assert.deepEqual(divideExact({ coefficient: "-2", scale: 0 }, { coefficient: "3", scale: 0 }, 2), { coefficient: "-67", scale: 2 });
  assert.equal(divideExact({ coefficient: "1", scale: 0 }, { coefficient: "0", scale: 2 }), null);
  assert.deepEqual(decimalToExact(12.5), { coefficient: "125", scale: 1 });
  assert.deepEqual(decimalToExact(1e21), { coefficient: "1000000000000000000000", scale: 0 });
  assert.deepEqual(decimalToExact(1.5e-7), { coefficient: "15", scale: 8 });
  assert.equal(decimalToExact(Number.NaN), null);
  assert.equal(exactToNumber({ coefficient: "-1250", scale: 2 }), -12.5);
  assert.ok(Number.isNaN(exactToNumber({ coefficient: "1", scale: 400 })), "underflow is NaN, not a fabricated zero");
  assert.ok(Number.isNaN(exactToNumber({ coefficient: `1${"0".repeat(400)}`, scale: 0 })), "overflow is NaN");
  assert.equal(exactToNumber({ coefficient: "0", scale: 400 }), 0);
});

test("totals group by upper-cased currency, count amounts, and keep a counted zero", () => {
  assert.deepEqual(
    moneyTotals([money("10000", 2, "twd"), money("-100", 0, "TWD"), money("150", 2, "usd")]),
    [
      { currency: "TWD", coefficient: "0", scale: 0, count: 2 },
      { currency: "USD", coefficient: "15", scale: 1, count: 1 },
    ],
  );
  const keyed: MoneyTotalsAccumulator = new Map();
  addToTotals(keyed, money("100", 0, "twd"), (currency) => `2026-01|${currency}`);
  addToTotals(keyed, money("100", 0, "TWD"), (currency) => `2026-01|${currency}`);
  addToTotals(keyed, negateMoney(money("100", 0)), (currency) => `2026-01|${currency}`, -1);
  addToTotals(keyed, money("5", 0, "TWD"), (currency) => `2026-02|${currency}`);
  addToTotals(keyed, negateMoney(money("5", 0)), (currency) => `2026-02|${currency}`, -1);
  assert.deepEqual(readTotals(keyed), [{ key: "2026-01|TWD", currency: "TWD", coefficient: "100", scale: 0, count: 1 }], "a total that counts nothing drops out");
});

test("properties: addition is commutative and associative with zero as identity", () => {
  const random = generator(0x5eed01);
  const zero = { coefficient: "0", scale: 0 };
  for (let run = 0; run < RUNS; run += 1) {
    const [a, b, c] = [random.amount(), random.amount(), random.amount()];
    assert.deepEqual(addExact(a, b), addExact(b, a));
    assert.deepEqual(addExact(addExact(a, b), c), addExact(a, addExact(b, c)));
    assert.deepEqual(addExact(a, zero), normalizeExact(a));
    assert.equal(compareExact(addExact(a, b), addExact(b, a)), 0);
  }
});

test("properties: equal holds exactly when the normalized keys match", () => {
  const random = generator(0x5eed02);
  for (let run = 0; run < RUNS; run += 1) {
    const a = random.amount();
    const padding = random.integer(5);
    const padded = { ...a, coefficient: isZeroExact(a) ? "0" : `${a.coefficient}${"0".repeat(padding)}`, scale: a.scale + padding };
    assert.equal(equalMoney(a, padded), true);
    assert.equal(moneyKey(a), moneyKey(padded));
    const b = random.amount();
    assert.equal(equalMoney(a, b), moneyKey(a) === moneyKey(b));
  }
});

test("properties: normalize is idempotent", () => {
  const random = generator(0x5eed03);
  for (let run = 0; run < RUNS; run += 1) {
    const once = normalizeMoney(random.amount());
    assert.deepEqual(normalizeMoney(once), once);
  }
});

test("properties: sum-then-reduce equals reduce-then-sum", () => {
  const random = generator(0x5eed04);
  for (let run = 0; run < RUNS; run += 1) {
    const values = Array.from({ length: 1 + random.integer(6) }, random.amount);
    const kept = values.reduce<{ coefficient: string; scale: number }>((sum, value) => addKeepingScale(sum, value), { coefficient: "0", scale: 0 });
    const reduced = values.map(normalizeExact).reduce<{ coefficient: string; scale: number }>(addExact, { coefficient: "0", scale: 0 });
    assert.deepEqual(normalizeExact(kept), reduced);
  }
});

test("properties: totals of a concatenation merge the totals of its parts", () => {
  const random = generator(0x5eed05);
  for (let run = 0; run < RUNS; run += 1) {
    const xs = random.list(8);
    const ys = random.list(8);
    assert.deepEqual(moneyTotals([...xs, ...ys]), mergeMoneyTotals(moneyTotals(xs), moneyTotals(ys)));
    assert.equal(
      moneyTotals(xs).reduce((count, total) => count + total.count, 0),
      xs.length,
      "every amount is counted once",
    );
  }
});

test("a totals key that leaves out the currency refuses to add two currencies together", () => {
  const totals: MoneyTotalsAccumulator = new Map();
  addToTotals(totals, { coefficient: "1", scale: 0, currency: "TWD" }, () => "all");
  assert.throws(() => addToTotals(totals, { coefficient: "1", scale: 0, currency: "USD" }, () => "all"), ExactMoneyError);
  addToTotals(totals, { coefficient: "2", scale: 0, currency: " twd " }, () => "all");
  assert.deepEqual(readTotals(totals).map(({ coefficient, currency, count }) => ({ coefficient, currency, count })), [
    { coefficient: "3", currency: "TWD", count: 2 },
  ]);
});
