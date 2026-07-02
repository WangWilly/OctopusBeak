import assert from "node:assert/strict";
import {
  buildAllocationDonutData,
  getAllocationCurrencies,
} from "./allocation-donut-data.ts";
import type { AccountRowDto } from "$lib/shared-ledger/types.ts";

function account(
  id: string,
  group: AccountRowDto["group"],
  kind: AccountRowDto["kind"],
  amountLines: AccountRowDto["amountLines"],
): AccountRowDto {
  return {
    id,
    label: id,
    institution: "",
    product: "",
    group,
    kind,
    typeLabel: kind,
    amountLines,
    transactionCount: 0,
    assetPositionCount: 0,
    lastUpdated: null,
  };
}

const accounts: AccountRowDto[] = [
  account("bank-twd", "asset", "bank", [{ currency: "TWD", value: 700 }]),
  account("fund-twd", "investment", "fund", [
    { currency: "TWD", value: 1_500 },
    { currency: "USD", value: 10 },
  ]),
  account("card-twd", "liability", "credit-card", [{ currency: "TWD", value: -200 }]),
  account("loan-twd", "liability", "loan", [{ currency: "TWD", value: 800 }]),
  account("loan-jpy", "liability", "loan", [{ currency: "JPY", value: 1_000 }]),
];

assert.deepEqual(getAllocationCurrencies(accounts, "asset"), ["TWD", "USD"]);
assert.deepEqual(getAllocationCurrencies(accounts, "liability"), ["TWD", "JPY"]);

const assetTwd = buildAllocationDonutData(accounts, "asset");
assert.equal(assetTwd.total, 2_200);
assert.deepEqual(
  assetTwd.items.map((item) => [item.key, item.label, item.value, item.percent]),
  [
    ["fund", "Fund", 1_500, 68.2],
    ["bank", "Bank", 700, 31.8],
  ],
);

const liabilityTwd = buildAllocationDonutData(accounts, "liability");
assert.equal(liabilityTwd.total, 1_000);
assert.deepEqual(
  liabilityTwd.items.map((item) => [item.key, item.label, item.value, item.percent]),
  [
    ["loan", "Loan", 800, 80],
    ["credit-card", "Credit Card", 200, 20],
  ],
);
