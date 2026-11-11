import assert from "node:assert/strict";
import { CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS } from "../ledger/canonical/current-deposit-route-contracts.ts";
import { type ProviderResponse, verifyProviderResponse } from "./provider-response.ts";
import {
  CTBC_CURRENT_DEPOSIT_BALANCE_TRANSPORT_QUERY_KEY,
  CTBC_CURRENT_DEPOSIT_RESPONSE,
  ctbcCurrentBalanceSnapshot,
  parseCtbcCurrentDepositBalanceSnapshot,
  type ExistingCtbcFinancialCapture,
} from "./ctbc-current-deposit-balances.ts";
import { captureCurrentStateSnapshots } from "./current-state-snapshot-capture.ts";
import { snapshotCheckProduct, stagedBalanceRequest } from "./current-state-snapshot-capture.fixtures.ts";

const CONTRACT = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS["ctbc/domestic-deposit/current-balance-v1"];

const serverTime = 1788919783601;
const accountNumber = ["0000", "1234", "5678", "9100"].join("");
const dataTime = "2026/09/09 10:09:43";
const endpoint = `https://${CONTRACT.endpointHost}${CONTRACT.endpointPath}`;
const requestPostData = JSON.stringify({
  resource: CONTRACT.requestResource,
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
              accountId: accountNumber,
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
assert.equal(parsed[0]?.accountNumber, accountNumber);
assert.equal(parsed[0]?.sourceAccountKey, accountNumber);
assert.equal(parsed[0]?.currency, "TWD");
assert.deepEqual(parsed[0]?.ledger, {
  coefficient: "13155",
  scale: 0,
  sourceLexeme: "13,155",
});
assert.equal(parsed[0]?.providerDataTime, dataTime);
assert.equal(parsed[0]?.providerServerTime, serverTime);
assert.equal(parsed[0]?.effectiveAt, "2026-09-09T02:09:43.601Z");
assert.equal(parsed[0]?.sourceEvidence.requestResource, CONTRACT.requestResource);
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
  CONTRACT.endpointPath,
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
  () => parse(payload(), response(), JSON.stringify({ resource: CONTRACT.requestResource, rqData: "not-an-object" })),
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
  ["accountId", accountNumber.slice(0, -1), /sixteen-digit/u],
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

const conflictingAccountNumber = ["0000", "1234", "5678", "9101"].join("");
const existingIdentity: ExistingCtbcFinancialCapture = {
  authorityRoute: "ctbc/domestic-deposit/human-attested-v1",
  identity: {
    integrationNamespace: "ctbc",
    sourceConnectionKey: "sha256:ctbc-connection",
    identityEpochKey: "sha256:ctbc-epoch",
    stream: "domestic-deposit",
    subjectDigest: "sha256:ctbc-subject",
    accountNo: accountNumber,
    sourceAccountKey: accountNumber,
    accountNumber: { value: accountNumber },
    currency: "TWD",
  },
};
const otherAccount = {
  ...existingIdentity.identity,
  accountNo: conflictingAccountNumber,
  sourceAccountKey: conflictingAccountNumber,
  accountNumber: { value: conflictingAccountNumber },
};

/** Drive the declaration over this check's summary reply for the admitted captures. */
function snapshot(captures: readonly ExistingCtbcFinancialCapture[]) {
  return captureCurrentStateSnapshots(ctbcCurrentBalanceSnapshot, {
    captures,
    acquire: async () => ({
      evidence: { kind: "json", bytes: new TextEncoder().encode(JSON.stringify(payload())) },
      response: response(),
      requestPostData,
    }),
    product: snapshotCheckProduct({ now: "2026-09-09T02:10:00.000Z" }),
  });
}

{
  const staged = await snapshot([existingIdentity]);
  assert.equal(staged.matched[0]?.capture, existingIdentity);
  assert.deepEqual(staged.items.map((item) => [item.product, item.itemKey]), [
    ["current-balance", `current-balance:domestic-deposit:${accountNumber}`],
  ]);
  const request = stagedBalanceRequest(staged.items[0]);
  assert.equal(request.capture.routeKey, "ctbc/domestic-deposit/current-balance-v1");
  assert.equal(request.capture.sourceConnectionKey, "sha256:ctbc-connection");
  assert.equal(request.capture.identityEpoch, "sha256:ctbc-epoch");
  assert.equal(request.capture.subjectDigest, "sha256:ctbc-subject");
  assert.deepEqual([request.capture.scope.startDate, request.capture.scope.endDate], ["2026-09-09", "2026-09-09"]);
  assert.equal(request.account.sourceAccountKey, accountNumber);
  assert.equal(request.account.currency, "TWD");
  assert.equal(request.observations.length, 1);
  assert.equal(request.observations[0]?.balanceKind, "ledger");
  assert.deepEqual(request.observations[0]?.balance, { coefficient: "13155", scale: 0 });
  assert.equal(request.observations[0]?.effectiveAt, "2026-09-09T02:09:43.601Z");
  assert.equal(request.observations[0]?.evidenceSourceField, "serverTime");
  assert.equal(request.observations[0]?.evidenceSourceValue, String(serverTime));
  assert.equal(request.capture.records[0]?.compact.sourceField, "balance");
  assert.equal(request.capture.records[0]?.compact.requestResource, CONTRACT.requestResource);
  assert.doesNotMatch(
    JSON.stringify(staged.items),
    /availableBalance|twdAcctSummaryTotalAmount|AUTH-TOKEN|DEVICE-ID|deviceId/u,
  );
}

await assert.rejects(
  snapshot([{ ...existingIdentity, identity: otherAccount }]),
  /^Error: CTBC current deposit snapshot has no admitted account identity\.$/u,
  "a summary row without an admitted identity rejects the snapshot",
);
for (const otherScope of [
  { sourceConnectionKey: "sha256:other-ctbc-connection" },
  { identityEpochKey: "sha256:other-ctbc-epoch" },
])
  await assert.rejects(
    snapshot([existingIdentity, { ...existingIdentity, identity: { ...otherAccount, ...otherScope } }]),
    /^Error: CTBC current deposit captures span more than one source connection or identity epoch\.$/u,
    "a capture outside the run's connection and epoch fails closed",
  );
await assert.rejects(
  snapshot([{
    ...existingIdentity,
    identity: { ...otherAccount, sourceAccountKey: accountNumber },
  }]),
  /exactly match existing account evidence/u,
  "a capture keyed to the row whose account evidence differs is refused",
);
await assert.rejects(
  snapshot([{ ...existingIdentity, authorityRoute: "ctbc/domestic-deposit/preflight-v1" }]),
  /not an admitted TWD CTBC account/u,
);
