import {
  POST_CURRENT_DEPOSIT_BALANCE_BIZ_CODE,
  POST_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
  POST_CURRENT_DEPOSIT_BALANCE_HOST,
  POST_CURRENT_DEPOSIT_BALANCE_PAGE_COUNT,
  POST_CURRENT_DEPOSIT_BALANCE_TXN_CODE,
  type PostCurrentDepositResponse,
} from "./post-current-deposit-balances.ts";

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
      url: `https://${POST_CURRENT_DEPOSIT_BALANCE_HOST}${POST_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH}`,
      status: 200,
      method: "POST",
      headers: {
        date,
        "cache-control": "no-store",
        "content-type": "application/json; charset=UTF-8",
      },
      requestPostData: JSON.stringify({
        header: {
          TxnCode: POST_CURRENT_DEPOSIT_BALANCE_TXN_CODE,
          BizCode: POST_CURRENT_DEPOSIT_BALANCE_BIZ_CODE,
        },
        body: { pageCount: POST_CURRENT_DEPOSIT_BALANCE_PAGE_COUNT },
      }),
    },
  };
}
