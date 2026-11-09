import assert from "node:assert/strict";
import test from "node:test";
import {
  YUANTA_FOREIGN_SETTLEMENT_MARKET_CONTRACT_VERSION,
  YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY,
} from "./investment-funding-contract.ts";
import {
  YuantaSettlementCalendarNotCoveredError,
  yuantaForeignSettlementEffectiveOn,
} from "./yuanta-foreign-settlement-calendar.ts";

const settle = (effectiveOn: string, action: "buy" | "sell") =>
  yuantaForeignSettlementEffectiveOn({
    settlementMarket: YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY,
    settlementMarketContractVersion: YUANTA_FOREIGN_SETTLEMENT_MARKET_CONTRACT_VERSION,
    effectiveOn,
    action,
  });

test("US-equity buys settle one Taiwan business day later and sells two", () => {
  assert.equal(settle("2026-08-12", "buy"), "2026-08-13");
  assert.equal(settle("2026-08-12", "sell"), "2026-08-14");
  assert.equal(settle("2026-08-14", "buy"), "2026-08-17", "weekends are not business days");
});

test("2026 settlements skip the national holidays added in 2025", () => {
  assert.equal(settle("2026-09-25", "buy"), "2026-09-29", "2026-09-28 is 孔子誕辰紀念日");
  assert.equal(settle("2026-10-23", "buy"), "2026-10-27", "2026-10-26 is the 光復節 observed day");
  assert.equal(settle("2026-12-24", "buy"), "2026-12-28", "2026-12-25 is 行憲紀念日");
});

test("2027 settlements follow the 116年 government calendar", () => {
  assert.equal(settle("2027-02-03", "buy"), "2027-02-11", "Lunar New Year closes 2027-02-04 through 2027-02-10");
  assert.equal(settle("2027-04-01", "sell"), "2027-04-07", "2027-04-05 and 2027-04-06 are closed");
  assert.equal(settle("2027-09-27", "sell"), "2027-09-30", "2027-09-28 is 孔子誕辰紀念日");
  assert.equal(settle("2027-12-23", "buy"), "2027-12-27", "2027-12-24 is the 行憲紀念日 observed day");
});

test("a settlement walk crosses New Year into the next covered year", () => {
  assert.equal(settle("2026-12-30", "sell"), "2027-01-04");
  assert.equal(settle("2026-12-31", "buy"), "2027-01-04");
});

test("a settlement day outside the calendar fails with a named error", () => {
  for (const [effectiveOn, action, uncovered] of [
    ["2028-01-03", "buy", "2028-01-04"],
    ["2027-12-30", "sell", "2028-01-01"],
    ["2025-06-02", "buy", "2025-06-03"],
  ] as const) {
    assert.throws(
      () => settle(effectiveOn, action),
      (error: unknown) => {
        assert.ok(error instanceof YuantaSettlementCalendarNotCoveredError);
        assert.equal(error.name, "YuantaSettlementCalendarNotCoveredError");
        assert.equal(error.date, uncovered);
        assert.equal(error.coverage.start, "2026-01-01");
        assert.equal(error.coverage.end, "2027-12-31");
        return true;
      },
      `${effectiveOn} ${action}`,
    );
  }
});

test("an unknown market contract version is refused", () => {
  assert.throws(() =>
    yuantaForeignSettlementEffectiveOn({
      settlementMarket: YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY,
      settlementMarketContractVersion: "yuanta/foreign-settlement/market-v1",
      effectiveOn: "2026-08-12",
      action: "buy",
    }),
  /market contract/u);
});
