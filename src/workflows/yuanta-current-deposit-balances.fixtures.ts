import { CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS } from "../ledger/canonical/current-deposit-route-contracts.ts";
import type { YuantaCurrentDepositTable } from "./yuanta-current-deposit-balances.ts";

const CONTRACT = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS["yuanta/domestic-deposit/current-balance-v1"];

/** A current-state table as the summary card's POST renders it, one cell array per balance row. */
export function yuantaCurrentDepositTable(
  rows: readonly (readonly string[])[],
  httpDate = "Thu, 24 Sep 2026 16:00:00 GMT",
): YuantaCurrentDepositTable {
  return {
    evidence: { kind: "cells", rows },
    response: {
      url: `https://${CONTRACT.endpointHost}${CONTRACT.endpointPath}`,
      status: 200,
      method: "POST",
      headers: { date: httpDate, "cache-control": "no-store" },
    },
  };
}
