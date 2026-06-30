import assert from "node:assert/strict";
import type { LiabilitiesPageDto } from "./types.ts";

const model = {
  accounts: [],
  transactionsByAccount: {},
  dailyHistoryByAccount: {},
  dailyHistory: [
    {
      date: "2026-06-30",
      netAssets: [],
      dailyChange: [],
      assets: [],
      liabilities: [{ currency: "TWD", value: 1 }],
      accountChanges: [],
      positionCount: 0,
    },
  ],
} satisfies LiabilitiesPageDto;

assert.equal(model.dailyHistory[0]?.liabilities[0]?.value, 1);
