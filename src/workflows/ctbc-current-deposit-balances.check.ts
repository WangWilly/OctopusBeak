import assert from "node:assert/strict";
import {
  CTBC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
  CTBC_CURRENT_DEPOSIT_BALANCE_HOST,
  CTBC_CURRENT_DEPOSIT_BALANCE_REQUEST_RESOURCE,
  CTBC_CURRENT_DEPOSIT_BALANCE_TRANSPORT_QUERY_KEY,
  parseCtbcCurrentDepositBalanceSnapshot,
  type CtbcCurrentDepositResponseMetadata,
} from "./ctbc-current-deposit-balances.ts";

const serverTime = 1788919783601;
const dataTime = "2026/09/09 10:09:43";
const endpoint = `https://${CTBC_CURRENT_DEPOSIT_BALANCE_HOST}${CTBC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH}`;
const requestPostData = JSON.stringify({
  resource: CTBC_CURRENT_DEPOSIT_BALANCE_REQUEST_RESOURCE,
  rqData: {},
  token: "AUTH-TOKEN-MUST-NOT-ESCAPE",
  deviceId: "DEVICE-ID-MUST-NOT-ESCAPE",
});

function response(
  overrides: Partial<CtbcCurrentDepositResponseMetadata> = {},
): CtbcCurrentDepositResponseMetadata {
  return {
    url: endpoint,
    status: 200,
    method: "POST",
    headers: {
      date: "Wed, 09 Sep 2026 02:09:43 GMT",
      "cache-control": "no-cache, no-store, must-revalidate",
      "content-type": "application/json;charset=UTF-8",
    },
    requestPostData,
    ...overrides,
  };
}

function payload(): Record<string, unknown> {
  return {
    code: "0000",
    desc: "success",
    serverTime,
    rsData: {
      twdAcctSummaryResponse: {
        twdAcctSummaryTotalAmount: "13,155",
        dataTime,
        demDepBalSummaryResponse: {
          totalAmount: "13,155",
          infoList: [
            {
              accountId: "0000314540554100",
              balance: "13,155",
              digiSvType: "",
              acctType: "01",
              accountNickName: "",
              openDt: "20200101",
              isRelaC: "N",
              availableBalance: "99,999",
            },
          ],
        },
        twdAcctSummaryTotalAmountIB: "13,155",
      },
    },
  };
}

const parsed = parseCtbcCurrentDepositBalanceSnapshot({
  payload: payload(),
  response: response(),
  observedAt: "2026-09-09T10:10:00+08:00",
});

assert.equal(parsed.length, 1);
assert.equal(parsed[0]?.accountNumber, "0000314540554100");
assert.equal(parsed[0]?.sourceAccountKey, "0000314540554100");
assert.equal(parsed[0]?.currency, "TWD");
assert.deepEqual(parsed[0]?.ledger, {
  coefficient: "13155",
  scale: 0,
  sourceLexeme: "13,155",
});
assert.equal(parsed[0]?.providerDataTime, dataTime);
assert.equal(parsed[0]?.providerServerTime, serverTime);
assert.equal(parsed[0]?.effectiveAt, "2026-09-09T02:09:43.601Z");
assert.equal(parsed[0]?.sourceEvidence.requestResource, CTBC_CURRENT_DEPOSIT_BALANCE_REQUEST_RESOURCE);
assert.equal(parsed[0]?.observedAt, "2026-09-09T10:10:00+08:00");
assert.doesNotMatch(
  JSON.stringify(parsed),
  /AUTH-TOKEN-MUST-NOT-ESCAPE|DEVICE-ID-MUST-NOT-ESCAPE/u,
);

const transportQueryValue = "TRANSPORT-VALUE-MUST-NOT-ESCAPE";
const transportQueryRows = parseCtbcCurrentDepositBalanceSnapshot({
  payload: payload(),
  response: response({
    url: `${endpoint}?${CTBC_CURRENT_DEPOSIT_BALANCE_TRANSPORT_QUERY_KEY}=${transportQueryValue}`,
  }),
  observedAt: "2026-09-09T10:10:00+08:00",
});
assert.equal(
  transportQueryRows[0]?.sourceEvidence.endpoint,
  CTBC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
);
assert.doesNotMatch(
  JSON.stringify(transportQueryRows),
  new RegExp(`${CTBC_CURRENT_DEPOSIT_BALANCE_TRANSPORT_QUERY_KEY}|${transportQueryValue}`, "u"),
);
assert.throws(
  () =>
    parseCtbcCurrentDepositBalanceSnapshot({
      payload: payload(),
      response: response({ url: `${endpoint}?unexpected=1` }),
      observedAt: "2026-09-09T10:10:00+08:00",
    }),
  /endpoint/u,
  "unknown transport query keys are rejected",
);
assert.throws(
  () =>
    parseCtbcCurrentDepositBalanceSnapshot({
      payload: payload(),
      response: response({
        url: `${endpoint}?${CTBC_CURRENT_DEPOSIT_BALANCE_TRANSPORT_QUERY_KEY}=one&${CTBC_CURRENT_DEPOSIT_BALANCE_TRANSPORT_QUERY_KEY}=two`,
      }),
      observedAt: "2026-09-09T10:10:00+08:00",
    }),
  /endpoint/u,
  "duplicate transport query keys are rejected",
);

// Taipei midnight is a valid civil time. The date check must validate the
// local fields before applying the UTC+08:00 conversion.
const midnight = payload();
midnight.serverTime = Date.UTC(2026, 8, 8, 16, 0, 0);
((midnight.rsData as Record<string, unknown>).twdAcctSummaryResponse as Record<string, unknown>).dataTime =
  "2026/09/09 00:00:00";
const midnightRows = parseCtbcCurrentDepositBalanceSnapshot({
  payload: midnight,
  response: response(),
  observedAt: "2026-09-09T00:01:00+08:00",
});
assert.equal(midnightRows[0]?.providerDataTime, "2026/09/09 00:00:00");
assert.equal(midnightRows[0]?.effectiveAt, "2026-09-08T16:00:00.000Z");

// The aggregate and available fields are syntactically checked but never
// become the ledger observation.
const changedNonLedgerAmounts = payload();
const changedSummary = (changedNonLedgerAmounts.rsData as Record<string, unknown>)
  .twdAcctSummaryResponse as Record<string, unknown>;
changedSummary.twdAcctSummaryTotalAmount = "777,777";
changedSummary.twdAcctSummaryTotalAmountIB = "888,888";
const changedDemand = changedSummary.demDepBalSummaryResponse as Record<string, unknown>;
changedDemand.totalAmount = "999,999";
(changedDemand.infoList as Array<Record<string, unknown>>)[0]!.availableBalance = "1";
const changedRows = parseCtbcCurrentDepositBalanceSnapshot({
  payload: changedNonLedgerAmounts,
  response: response(),
  observedAt: "2026-09-09T10:10:00+08:00",
});
assert.deepEqual(changedRows[0]?.ledger, parsed[0]?.ledger);

const wrongRequest = response({
  requestPostData: JSON.stringify({ resource: "/twrbc-deposit/qu002/010", rqData: {} }),
});
assert.throws(
  () => parseCtbcCurrentDepositBalanceSnapshot({ payload: payload(), response: wrongRequest, observedAt: "2026-09-09T10:10:00+08:00" }),
  /request resource is unexpected/u,
);
assert.throws(
  () => parseCtbcCurrentDepositBalanceSnapshot({
    payload: payload(),
    response: response({ requestPostData: JSON.stringify({ resource: CTBC_CURRENT_DEPOSIT_BALANCE_REQUEST_RESOURCE, rqData: "not-an-object" }) }),
    observedAt: "2026-09-09T10:10:00+08:00",
  }),
  /rqData is not an object/u,
);
const responseMetadata = payload();
responseMetadata.resource = "/twrbc-deposit/qu002/010";
const responseMetadataRows = parseCtbcCurrentDepositBalanceSnapshot({
  payload: responseMetadata,
  response: response(),
  observedAt: "2026-09-09T10:10:00+08:00",
});
assert.deepEqual(responseMetadataRows[0]?.ledger, parsed[0]?.ledger);

const missingTimestamp = payload();
delete missingTimestamp.serverTime;
assert.throws(
  () => parseCtbcCurrentDepositBalanceSnapshot({ payload: missingTimestamp, response: response(), observedAt: "2026-09-09T10:10:00+08:00" }),
  /serverTime is missing/u,
);
const inconsistentTime = payload();
((inconsistentTime.rsData as Record<string, unknown>).twdAcctSummaryResponse as Record<string, unknown>).dataTime = "2026/09/09 10:09:44";
assert.throws(
  () => parseCtbcCurrentDepositBalanceSnapshot({ payload: inconsistentTime, response: response(), observedAt: "2026-09-09T10:10:00+08:00" }),
  /does not match serverTime/u,
);
const noRows = payload();
(((noRows.rsData as Record<string, unknown>).twdAcctSummaryResponse as Record<string, unknown>).demDepBalSummaryResponse as Record<string, unknown>).infoList = [];
assert.throws(
  () => parseCtbcCurrentDepositBalanceSnapshot({ payload: noRows, response: response(), observedAt: "2026-09-09T10:10:00+08:00" }),
  /infoList must be a non-empty array/u,
);

const duplicate = payload();
const duplicateDemand = ((duplicate.rsData as Record<string, unknown>).twdAcctSummaryResponse as Record<string, unknown>).demDepBalSummaryResponse as Record<string, unknown>;
duplicateDemand.infoList = [
  ...(duplicateDemand.infoList as unknown[]),
  { ...(duplicateDemand.infoList as Array<Record<string, unknown>>)[0] },
];
assert.throws(
  () => parseCtbcCurrentDepositBalanceSnapshot({ payload: duplicate, response: response(), observedAt: "2026-09-09T10:10:00+08:00" }),
  /duplicate accountId/u,
);

for (const [field, value, pattern] of [
  ["accountId", "000031454055410", /sixteen-digit/u],
  ["balance", "13,15", /balance is not an exact decimal/u],
  ["acctType", "1", /acctType is invalid/u],
  ["openDt", "20260230", /openDt is invalid/u],
  ["isRelaC", "maybe", /isRelaC is invalid/u],
] as const) {
  const malformed = payload();
  const row = (((malformed.rsData as Record<string, unknown>).twdAcctSummaryResponse as Record<string, unknown>).demDepBalSummaryResponse as Record<string, unknown>).infoList as Array<Record<string, unknown>>;
  row[0]![field] = value;
  assert.throws(
    () => parseCtbcCurrentDepositBalanceSnapshot({ payload: malformed, response: response(), observedAt: "2026-09-09T10:10:00+08:00" }),
    pattern,
    `malformed ${field} is rejected`,
  );
}

for (const [name, overrides, pattern] of [
  ["missing date", { headers: { "cache-control": "no-cache, no-store, must-revalidate", "content-type": "application/json" } }, /HTTP Date/u],
  ["missing cache policy", { headers: { date: "Wed, 09 Sep 2026 02:09:43 GMT", "content-type": "application/json" } }, /Cache-Control/u],
  ["wrong endpoint", { url: "https://www.ctbcbank.com/other", }, /endpoint/u],
  ["wrong method", { method: "GET" }, /method/u],
  ["wrong status", { status: 503 }, /status/u],
] as const) {
  assert.throws(
    () => parseCtbcCurrentDepositBalanceSnapshot({ payload: payload(), response: response(overrides), observedAt: "2026-09-09T10:10:00+08:00" }),
    pattern,
    name,
  );
}
