import assert from "node:assert/strict";

import {
  buildLinebankCurrentDepositBalanceCapture,
  buildLinebankCurrentDepositBalanceCaptures,
  LINEBANK_CURRENT_DOMESTIC_BALANCE_AUTHORITY_ROUTE,
} from "./linebank-current-deposit-canonical.ts";
import {
  LINEBANK_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
  LINEBANK_CURRENT_DEPOSIT_BALANCE_HOST,
  parseLinebankCurrentDepositBalanceSnapshot,
} from "./linebank-current-deposit-balances.ts";
import { admitCurrentDepositBalanceCapture } from "../ledger/pglite/current-deposit-admission.ts";
import { canonicalSourceRouteRegistration } from "../ledger/canonical/canonical-source-route-registry.ts";

const routeRegistration = canonicalSourceRouteRegistration(
  LINEBANK_CURRENT_DOMESTIC_BALANCE_AUTHORITY_ROUTE,
);
assert.ok(routeRegistration, "LINE current-balance route is registered for source admission");
assert.deepEqual(routeRegistration, {
  routeKey: LINEBANK_CURRENT_DOMESTIC_BALANCE_AUTHORITY_ROUTE,
  integrationNamespace: "linebank",
  stream: "domestic-deposit",
  contractVersions: ["linebank/current-deposit-balance-v1"],
  ruleCombinations: [{
    contractVersion: "linebank/current-deposit-balance-v1",
    postingRuleVersion: null,
    semanticRuleVersion: null,
    effectiveTimeRuleVersion: "linebank/current-deposit-balance-v1",
  }],
});

const response = {
  url: `https://${LINEBANK_CURRENT_DEPOSIT_BALANCE_HOST}${LINEBANK_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH}?featureTypeCode=01`,
  status: 200,
  method: "GET",
  headers: {
    date: "Wed, 09 Sep 2026 02:05:08 GMT",
    "cache-control": "no-cache, no-store, max-age=0, must-revalidate",
    "content-type": "application/json",
  },
};
const rawBody = `{"code":"200","message":"success","content":{"dpstAcctList":[{"acctNbr":"012345678901","arrId":"arr-main","currCd":"TWD","acctBal":999,"wdrwAvblAmt":1234.50}]}}`;
const row = parseLinebankCurrentDepositBalanceSnapshot({
  response,
  rawBody,
  observedAt: "2026-09-09T10:05:09+08:00",
})[0]!;
const financialCapture = {
  accountKey: row.sourceAccountKey,
  sourceConnection: "accessibility.linebank.com.tw",
  identityEpoch: 1700000000000,
  observedAt: "2026-09-09T10:05:00.000Z",
};

const capture = buildLinebankCurrentDepositBalanceCapture(row, financialCapture);
assert.doesNotThrow(() => admitCurrentDepositBalanceCapture(capture));
assert.equal(capture.authorityRoute, LINEBANK_CURRENT_DOMESTIC_BALANCE_AUTHORITY_ROUTE);
assert.equal(capture.identity.integrationNamespace, "linebank");
assert.equal(capture.identity.stream, "domestic-deposit");
assert.equal(capture.identity.sourceAccountKey, row.sourceAccountKey);
assert.equal(capture.observations.length, 1);
assert.equal(capture.observations[0]?.balanceKind, "available");
assert.equal(capture.observations[0]?.sourceField, "wdrwAvblAmt");
assert.deepEqual(capture.observations[0]?.balance, {
  coefficient: "123450",
  scale: 2,
});
assert.equal(capture.observations[0]?.time.effectiveTimeBasis, "provider-http-date");
assert.equal(capture.observations[0]?.time.sourceField, "HTTP Date");
assert.equal(capture.providerResponse.endpoint, `${response.url}`);
assert.equal(capture.scope.startDate, "2026-09-09");
assert.equal(capture.scope.endDate, "2026-09-09");
assert.equal(capture.records[0]?.compact.sourceField, "wdrwAvblAmt");
assert.equal(capture.records[0]?.compact.balanceKind, "available");
assert.equal(capture.pages[0]?.metadata?.featureTypeCode, "01");

const batch = buildLinebankCurrentDepositBalanceCaptures([row], [financialCapture]);
assert.equal(batch.length, 1);
assert.equal(batch[0]?.identity.sourceAccountKey, row.sourceAccountKey);

assert.throws(
  () => buildLinebankCurrentDepositBalanceCapture(row, {
    ...financialCapture,
    accountKey: "sha256:another-account",
  }),
  /does not match an existing account/u,
);
assert.throws(
  () => buildLinebankCurrentDepositBalanceCaptures([row], []),
  /no admitted financial identity/u,
);

console.log("linebank-current-deposit-canonical.check passed");
