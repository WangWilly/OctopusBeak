import assert from "node:assert/strict";
import type { AssetsPageDto } from "./types.ts";

const model = {
  accounts: [],
  positionsByAccount: {},
  transactionsByAccount: {},
  dailyHistoryByAccount: {},
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
