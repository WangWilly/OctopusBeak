import { CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS } from "../ledger/canonical/current-deposit-route-contracts.ts";
import type { PostCurrentDepositResponse } from "./post-current-deposit-balances.ts";

const CONTRACT = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS["post/domestic-deposit/current-balance-v1"];

/** A recorded-shape iPost asset-overview response with one PS row per account. */
export function postCurrentDepositResponse(
  accounts: readonly Readonly<{ accountNumber: string; balance: string }>[],
  date = "Fri, 25 Sep 2026 11:59:00 GMT",
): PostCurrentDepositResponse {
  const payload = [
    {
      header: { EndBracket: false, OutputType: "Screen" },
      body: {
        itemList: accounts.map(({ accountNumber, balance }) => ({
          ACT_TYPE: "PS",
          ACT_NO: accountNumber,
          BAL: balance,
        })),
      },
    },
    {
      header: { EndBracket: false, OutputType: "EndBracket" },
      body: { result: "success" },
    },
  ];
  return {
    evidence: { kind: "json", bytes: new TextEncoder().encode(JSON.stringify(payload)) },
    response: {
      url: `https://${CONTRACT.endpointHost}${CONTRACT.endpointPath}`,
      status: 200,
      method: "POST",
      headers: {
        date,
        "cache-control": "no-store",
        "content-type": "application/json; charset=UTF-8",
      },
    },
    requestPostData: JSON.stringify({
      header: {
        TxnCode: CONTRACT.requestDiscriminant.txnCode,
        BizCode: CONTRACT.requestDiscriminant.bizCode,
      },
      body: { pageCount: CONTRACT.requestDiscriminant.pageCount },
    }),
  };
}
