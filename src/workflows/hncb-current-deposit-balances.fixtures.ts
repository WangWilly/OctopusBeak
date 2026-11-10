import { CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS } from "../ledger/canonical/current-deposit-route-contracts.ts";
import {
  HNCB_CURRENT_DEPOSIT_BALANCE_TRANSACTION,
  type HncbCurrentDepositTable,
} from "./hncb-current-deposit-balances.ts";
import { HNCB_TRX_DISPATCHER_PATH } from "./hncb-netbank-site.ts";

/** One 活期存款 result row: available balance in the fourth cell, 帳上餘額 in the eleventh. */
export function hncbCurrentDepositDetailRow(
  accountNumber: string,
  ledger = "0.00",
  available = ledger,
): readonly string[] {
  return ["SYNTHETIC", accountNumber, "TWD", available, "0", "0", "0", "0", "0", "0", ledger, "0"];
}

/** A row HNCB shows when it cannot report an account's balance; the parser skips it. */
export function hncbCurrentDepositUnavailableRow(accountNumber: string): readonly string[] {
  return ["SYNTHETIC", accountNumber, "", "-", "-", "-", "-", "-", "-", "-", "-", "-"];
}

/** The 活期存款 balance page as its GET renders it, one cell array per account row. */
export function hncbCurrentDepositDetailTable(
  rows: readonly (readonly string[])[],
  httpDate = "Tue, 01 Sep 2026 03:59:00 GMT",
): HncbCurrentDepositTable {
  return {
    view: "detail",
    evidence: { kind: "cells", rows },
    response: {
      url: `https://${CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS["hncb/domestic-deposit/current-balance-v1"].endpointHost}${HNCB_TRX_DISPATCHER_PATH}?trx=${HNCB_CURRENT_DEPOSIT_BALANCE_TRANSACTION}`,
      status: 200,
      method: "GET",
      headers: { date: httpDate, "cache-control": "no-store" },
    },
  };
}
