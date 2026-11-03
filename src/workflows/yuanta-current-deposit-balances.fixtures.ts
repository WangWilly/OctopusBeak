import {
  YUANTA_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
  YUANTA_CURRENT_DEPOSIT_BALANCE_HOST,
  type YuantaCurrentDepositTable,
} from "./yuanta-current-deposit-balances.ts";

/** A current-state table as the summary card's POST renders it, one cell array per balance row. */
export function yuantaCurrentDepositTable(
  rows: readonly (readonly string[])[],
  httpDate = "Thu, 24 Sep 2026 16:00:00 GMT",
): YuantaCurrentDepositTable {
  return {
    evidence: { kind: "cells", rows },
    response: {
      url: `https://${YUANTA_CURRENT_DEPOSIT_BALANCE_HOST}${YUANTA_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH}`,
      status: 200,
      method: "POST",
      headers: { date: httpDate, "cache-control": "no-store" },
    },
  };
}
