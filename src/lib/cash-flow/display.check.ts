import assert from "node:assert/strict";
import test from "node:test";
import type { CashFlowRow } from "./model.ts";
import { foldZeroRows } from "./display.ts";

function row(id: string, account: string, coefficient: string): CashFlowRow {
  return {
    transactionId: id,
    source: "canonical",
    accountId: account,
    date: "2026-11-11",
    amount: { coefficient, scale: 0, currency: "TWD" },
    direction: "inflow",
    kind: { code: "receipt", basis: "fallback" },
    cashFlow: { class: "inflow", group: "transfers_in" },
    details: {
      description: null, counterparty: null, note: null, time: null,
      account: { id: account, source: "canonical", institutionKey: null, stream: null, mask: null, name: null },
      edit: null,
    },
    transferLinkId: null,
    exchangeLabel: false,
  };
}

test("an account's zero rows on one day fold into one entry where the first stood", () => {
  const entries = foldZeroRows("2026-11-11", [
    row("pay", "bank", "-1009"),
    row("yield", "maicoin", "0"),
    row("bill", "bank", "-1990"),
    row("hold", "maicoin", "0"),
    row("reward", "maicoin", "5"),
  ]);
  assert.deepEqual(entries.map((entry) => entry.kind === "row" ? entry.row.transactionId : entry.rows.map((member) => member.transactionId)), [
    "pay",
    ["yield", "hold"],
    "bill",
    "reward",
  ], "a non-zero reward from the same account stays a row");
  assert.equal(entries[1]?.kind === "zeros" ? entries[1].key : null, "2026-11-11:maicoin");
});

test("a lone zero row and zero rows from different accounts stay rows", () => {
  const entries = foldZeroRows("2026-11-11", [row("a", "maicoin", "0"), row("b", "binance", "0")]);
  assert.deepEqual(entries.map((entry) => entry.kind), ["row", "row"]);
});
