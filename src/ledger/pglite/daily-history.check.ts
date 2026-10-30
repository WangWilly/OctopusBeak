import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalOverviewAccount } from "../canonical/canonical-overview-query.ts";
import { readPGliteDailyHistory, type PGliteDailyHistoryReader } from "./daily-history.ts";

function balance(date: string, coefficient: string, scale: number) {
  return {
    event_date: date,
    event_type: "balance",
    account_id: "account-1",
    account_type: "depository",
    integration_namespace: "fubon",
    balance_kind: "ledger",
    currency: "TWD",
    coefficient,
    scale,
    security_id: null,
    observed_at: null,
  };
}

function readerOf(rows: readonly unknown[]): PGliteDailyHistoryReader {
  return { query: async <T>() => ({ rows: rows as readonly T[] }) };
}

const accounts = [{ id: "account-1", label: "Deposit" }] as unknown as readonly CanonicalOverviewAccount[];

test("a tiny non-zero balance and its change are shown; an exact zero is not", async () => {
  const history = await readPGliteDailyHistory(readerOf([
    balance("2026-01-01", "1", 7),
    balance("2026-01-02", "30", 8),
    balance("2026-01-03", "0", 2),
  ]), 1, accounts);
  assert.deepEqual(history.map((row) => [row.date, row.assets.map((line) => line.exact), row.dailyChange.map((line) => line.exact)]), [
    ["2026-01-01", [{ coefficient: "1", scale: 7 }], []],
    ["2026-01-02", [{ coefficient: "3", scale: 7 }], [{ coefficient: "2", scale: 7 }]],
    ["2026-01-03", [], [{ coefficient: "-3", scale: 7 }]],
  ]);
  assert.equal(history[0]!.assets[0]!.value, 1e-7);
});
