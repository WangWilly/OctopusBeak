import {
  SINOPAC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
  SINOPAC_CURRENT_DEPOSIT_BALANCE_HOST,
  type SinopacCurrentDepositResponse,
} from "./sinopac-current-deposit-balances.ts";

export type SinopacCurrentDepositFixtureRow = Readonly<{
  account: string;
  currency?: string;
  currencyText?: string;
  balance: string;
}>;

/** One recorded-shape ws_bankbal SubInfo entry. */
export function sinopacCurrentDepositRow(row: SinopacCurrentDepositFixtureRow): Record<string, unknown> {
  return {
    AcctText: "SYNTHETIC ACCOUNT",
    AcctValue: row.account,
    AcctValueFormat: "###-###-#######-#",
    Curr: row.currency ?? "TWD",
    CurText: row.currencyText ?? "新台幣",
    AvailBalance: row.balance,
    AvailBalInt: null,
    MaxAvail: row.balance,
    OutStdLmt: "0",
    FixBalance: "0",
    NonTrxferFlg: "False",
    Category: "1001",
    DigiTalFg: "",
  };
}

/** A recorded-shape ws_bankbal response whose body is the given JSON payload. */
export function sinopacCurrentDepositPayloadResponse(
  payload: unknown,
  date = "Thu, 01 Oct 2026 03:59:00 GMT",
): SinopacCurrentDepositResponse {
  return {
    evidence: { kind: "json", bytes: new TextEncoder().encode(JSON.stringify(payload)) },
    response: {
      url: `https://${SINOPAC_CURRENT_DEPOSIT_BALANCE_HOST}${SINOPAC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH}`,
      status: 200,
      method: "POST",
      headers: {
        "content-type": "application/json;charset=UTF-8",
        "cache-control": "no-cache,no-store",
        date,
      },
    },
  };
}

/** A recorded-shape successful ws_bankbal response with one row per account and currency. */
export function sinopacCurrentDepositResponse(
  rows: readonly SinopacCurrentDepositFixtureRow[],
  date?: string,
): SinopacCurrentDepositResponse {
  return sinopacCurrentDepositPayloadResponse(
    [{ SubInfo: rows.map(sinopacCurrentDepositRow), Header: "SUCCESS", Message: "" }],
    date,
  );
}
