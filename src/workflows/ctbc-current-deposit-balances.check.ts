import assert from "node:assert/strict";
import { type ProviderResponse, verifyProviderResponse } from "./provider-response.ts";
import {
  CTBC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
  CTBC_CURRENT_DEPOSIT_BALANCE_HOST,
  CTBC_CURRENT_DEPOSIT_BALANCE_REQUEST_RESOURCE,
  CTBC_CURRENT_DEPOSIT_BALANCE_TRANSPORT_QUERY_KEY,
  CTBC_CURRENT_DEPOSIT_RESPONSE,
  parseCtbcCurrentDepositBalanceSnapshot,
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

function response(overrides: Partial<ProviderResponse> = {}): ProviderResponse {
  return {
    url: endpoint,
    status: 200,
    method: "POST",
    headers: {
      date: "Wed, 09 Sep 2026 02:09:43 GMT",
      "cache-control": "no-cache, no-store, must-revalidate",
      "content-type": "application/json;charset=UTF-8",
    },
    ...overrides,
  };
}

function parse(candidate: unknown, candidateResponse: ProviderResponse, requestBody: string | null = requestPostData) {
  return parseCtbcCurrentDepositBalanceSnapshot({
    payload: candidate,
    response: verifyProviderResponse(CTBC_CURRENT_DEPOSIT_RESPONSE, candidateResponse, "2026-09-09T10:10:00+08:00"),
    requestPostData: requestBody,
  });
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
              accountId: "0000123456789100",
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

const parsed = parse(payload(), response());

assert.equal(parsed.length, 1);
assert.equal(parsed[0]?.accountNumber, "0000123456789100");
assert.equal(parsed[0]?.sourceAccountKey, "0000123456789100");
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
const transportQueryRows = parse(payload(), response({
    url: `${endpoint}?${CTBC_CURRENT_DEPOSIT_BALANCE_TRANSPORT_QUERY_KEY}=${transportQueryValue}`,
  }));
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
    parse(payload(), response({ url: `${endpoint}?unexpected=1` })),
  /endpoint/u,
  "unknown transport query keys are rejected",
);
assert.throws(
  () =>
    parse(payload(), response({
        url: `${endpoint}?${CTBC_CURRENT_DEPOSIT_BALANCE_TRANSPORT_QUERY_KEY}=one&${CTBC_CURRENT_DEPOSIT_BALANCE_TRANSPORT_QUERY_KEY}=two`,
      })),
  /endpoint/u,
  "duplicate transport query keys are rejected",
);

// Taipei midnight is a valid civil time. The date check must validate the
// local fields before applying the UTC+08:00 conversion.
const midnight = payload();
midnight.serverTime = Date.UTC(2026, 8, 8, 16, 0, 0);
((midnight.rsData as Record<string, unknown>).twdAcctSummaryResponse as Record<string, unknown>).dataTime =
  "2026/09/09 00:00:00";
const midnightRows = parse(midnight, response());
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
const changedRows = parse(changedNonLedgerAmounts, response());
assert.deepEqual(changedRows[0]?.ledger, parsed[0]?.ledger);

assert.throws(
  () => parse(payload(), response(), JSON.stringify({ resource: "/twrbc-deposit/qu002/010", rqData: {} })),
  /request resource is unexpected/u,
);
assert.throws(
  () => parse(payload(), response(), JSON.stringify({ resource: CTBC_CURRENT_DEPOSIT_BALANCE_REQUEST_RESOURCE, rqData: "not-an-object" })),
  /rqData is not an object/u,
);
const responseMetadata = payload();
responseMetadata.resource = "/twrbc-deposit/qu002/010";
const responseMetadataRows = parse(responseMetadata, response());
assert.deepEqual(responseMetadataRows[0]?.ledger, parsed[0]?.ledger);

const missingTimestamp = payload();
delete missingTimestamp.serverTime;
assert.throws(
  () => parse(missingTimestamp, response()),
  /serverTime is missing/u,
);
const inconsistentTime = payload();
((inconsistentTime.rsData as Record<string, unknown>).twdAcctSummaryResponse as Record<string, unknown>).dataTime = "2026/09/09 10:09:44";
assert.throws(
  () => parse(inconsistentTime, response()),
  /does not match serverTime/u,
);
const noRows = payload();
(((noRows.rsData as Record<string, unknown>).twdAcctSummaryResponse as Record<string, unknown>).demDepBalSummaryResponse as Record<string, unknown>).infoList = [];
assert.throws(
  () => parse(noRows, response()),
  /infoList must be a non-empty array/u,
);

const duplicate = payload();
const duplicateDemand = ((duplicate.rsData as Record<string, unknown>).twdAcctSummaryResponse as Record<string, unknown>).demDepBalSummaryResponse as Record<string, unknown>;
duplicateDemand.infoList = [
  ...(duplicateDemand.infoList as unknown[]),
  { ...(duplicateDemand.infoList as Array<Record<string, unknown>>)[0] },
];
assert.throws(
  () => parse(duplicate, response()),
  /duplicate accountId/u,
);

for (const [field, value, pattern] of [
  ["accountId", "000012345678910", /sixteen-digit/u],
  ["balance", "13,15", /balance is not an exact decimal/u],
  ["acctType", "1", /acctType is invalid/u],
  ["openDt", "20260230", /openDt is invalid/u],
  ["isRelaC", "maybe", /isRelaC is invalid/u],
] as const) {
  const malformed = payload();
  const row = (((malformed.rsData as Record<string, unknown>).twdAcctSummaryResponse as Record<string, unknown>).demDepBalSummaryResponse as Record<string, unknown>).infoList as Array<Record<string, unknown>>;
  row[0]![field] = value;
  assert.throws(
    () => parse(malformed, response()),
    pattern,
    `malformed ${field} is rejected`,
  );
}

for (const [name, overrides, pattern] of [
  ["missing must-revalidate", { headers: { date: "Wed, 09 Sep 2026 02:09:43 GMT", "cache-control": "no-cache, no-store", "content-type": "application/json" } }, /Cache-Control/u],
  ["non-JSON content type", { headers: { date: "Wed, 09 Sep 2026 02:09:43 GMT", "cache-control": "no-cache, no-store, must-revalidate", "content-type": "text/html" } }, /content type/u],
  ["wrong endpoint", { url: "https://www.ctbcbank.com/other", }, /endpoint/u],
  ["wrong method", { method: "GET" }, /method/u],
] as const) {
  assert.throws(
    () => parse(payload(), response(overrides)),
    pattern,
    name,
  );
}
