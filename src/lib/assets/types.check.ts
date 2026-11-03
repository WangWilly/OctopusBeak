import assert from "node:assert/strict";
import type { AssetsPageDto } from "./types.ts";
import { NO_PROVENANCE } from "../shared-ledger/provenance.ts";

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
  valuationDate: "2026-10-01",
  dailyHistory: [
    {
      date: "2026-06-30",
      netAssets: [],
      dailyChange: [],
      assets: [{ currency: "TWD", value: 1 }],
      liabilities: [],
      accountChanges: [],
      positionCount: 0,
      provenance: NO_PROVENANCE,
    },
  ],
} satisfies AssetsPageDto;

assert.equal(model.dailyHistory[0]?.assets[0]?.value, 1);
