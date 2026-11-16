import assert from "node:assert/strict";
import test from "node:test";
import { exchangeRateText, impliedExchangeRate } from "./exchange-rate.ts";

const money = (coefficient: string, scale: number, currency: string) => ({ coefficient, scale, currency });
const text = (left: ReturnType<typeof money>, right: ReturnType<typeof money>) => {
  const rate = impliedExchangeRate(left, right);
  return rate === null ? null : exchangeRateText(rate);
};

test("a buy and a sell both read per one unit of the costlier currency", () => {
  assert.equal(text(money("3270360", 2, "TWD"), money("1000", 0, "USD")), "1 USD = 32.7036 TWD", "TWD out, USD in");
  assert.equal(text(money("100000", 2, "USD"), money("32550", 0, "TWD")), "1 USD = 32.5500 TWD", "USD out, TWD in");
});

test("a pair without TWD names the costlier currency too", () => {
  assert.equal(text(money("15025", 0, "JPY"), money("100", 0, "USD")), "1 USD = 150.2500 JPY");
  assert.equal(text(money("100", 0, "USD"), money("15025", 0, "JPY")), "1 USD = 150.2500 JPY");
});

test("the rate is exact before it rounds half up to four places, and groups its whole part", () => {
  assert.equal(text(money("10000", 0, "TWD"), money("300", 0, "USD")), "1 USD = 33.3333 TWD");
  assert.equal(text(money("200000", 0, "TWD"), money("3", 0, "USD")), "1 USD = 66,666.6667 TWD");
  assert.equal(text(money("-50", 0, "EUR"), money("100", 0, "USD")), "1 EUR = 2.0000 USD", "a signed amount reads by its size");
  assert.equal(text(money("100", 0, "USD"), money("100", 0, "EUR")), "1 EUR = 1.0000 USD", "an even trade names the codes in order");
});

test("one currency, or a zero amount, implies no rate", () => {
  assert.equal(impliedExchangeRate(money("100", 0, "TWD"), money("100", 0, "twd")), null);
  assert.equal(impliedExchangeRate(money("0", 0, "TWD"), money("100", 0, "USD")), null);
});
