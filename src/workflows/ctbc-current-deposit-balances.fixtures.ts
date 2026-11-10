import { CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS } from "../ledger/canonical/current-deposit-route-contracts.ts";
import type { CtbcCurrentDepositResponse } from "./ctbc-current-deposit-balances.ts";

const CONTRACT = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS["ctbc/domestic-deposit/current-balance-v1"];

/** The Taipei `YYYY/MM/DD hh:mm:ss` CTBC writes beside its serverTime. */
function taipeiDataTime(serverTime: number): string {
  const taipei = new Date(serverTime + 8 * 60 * 60 * 1_000).toISOString();
  return `${taipei.slice(0, 10).replaceAll("-", "/")} ${taipei.slice(11, 19)}`;
}

/** A recorded-shape CTBC current-summary response with one row per account. */
export function ctbcCurrentDepositResponse(
  accounts: readonly Readonly<{ accountId: string; balance: string }>[],
  serverTime = Date.parse("2026-09-25T11:59:00.000Z"),
): CtbcCurrentDepositResponse {
  const payload = {
    code: "0000",
    serverTime,
    rsData: {
      twdAcctSummaryResponse: {
        twdAcctSummaryTotalAmount: "0",
        dataTime: taipeiDataTime(serverTime),
        demDepBalSummaryResponse: {
          totalAmount: "0",
          infoList: accounts.map(({ accountId, balance }) => ({
            accountId,
            balance,
            digiSvType: "",
            acctType: "01",
            accountNickName: "",
            openDt: "20200101",
            isRelaC: "N",
            availableBalance: balance,
          })),
        },
        twdAcctSummaryTotalAmountIB: "0",
      },
    },
  };
  return {
    evidence: { kind: "json", bytes: new TextEncoder().encode(JSON.stringify(payload)) },
    response: {
      url: `https://${CONTRACT.endpointHost}${CONTRACT.endpointPath}`,
      status: 200,
      method: "POST",
      headers: {
        date: new Date(Math.floor(serverTime / 1_000) * 1_000).toUTCString(),
        "cache-control": "no-cache, no-store, must-revalidate",
        "content-type": "application/json;charset=UTF-8",
      },
    },
    requestPostData: JSON.stringify({ resource: CONTRACT.requestResource, rqData: {} }),
  };
}
