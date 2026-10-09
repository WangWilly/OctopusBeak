import assert from "node:assert/strict";
import type { AssetsPageDto } from "./types.ts";

const model = {
  availability: "empty",
  coverage: "awaiting",
  sourceGaps: [],
  importedAt: null,
  accounts: [],
  coveredAccounts: [],
  positionsByAccount: {},
  transactionsByAccount: {},
  dailyHistoryByAccount: {},
  exchangeRates: [],
  dailyHistory: [
    {
      date: "2026-06-30",
      netAssets: [],
      dailyChange: [],
      assets: [{ currency: "TWD", value: 1 }],
      liabilities: [],
      accountChanges: [],
      positionCount: 0,
    },
  ],
} satisfies AssetsPageDto;

assert.equal(model.dailyHistory[0]?.assets[0]?.value, 1);
