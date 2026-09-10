import assert from "node:assert/strict";

import {
  CATHAY_CURRENT_DOMESTIC_ENDPOINT_PATH,
  CATHAY_CURRENT_FOREIGN_ENDPOINT_PATH,
  parseCathayCurrentDepositBalanceSnapshot,
} from "./cathay-current-deposit-balances.ts";
import {
  buildCathayCurrentDepositBalanceCaptures,
  CATHAY_CURRENT_DOMESTIC_BALANCE_AUTHORITY_ROUTE,
  CATHAY_CURRENT_FOREIGN_BALANCE_AUTHORITY_ROUTE,
} from "./cathay-current-deposit-canonical.ts";
import {
  admitCurrentDepositBalanceCapture,
} from "../ledger/canonical/current-deposit-balance-writer.ts";

const systemTime = "2026-09-08T21:20:04.1234567+08:00";
const observedAt = "2026-09-08T21:20:10.000+08:00";
const date = "Tue, 08 Sep 2026 13:20:04 GMT";

const domesticRows = parseCathayCurrentDepositBalanceSnapshot({
  kind: "domestic",
  response: {
    url: `https://www.cathaybk.com.tw${CATHAY_CURRENT_DOMESTIC_ENDPOINT_PATH}`,
    status: 200,
    method: "POST",
    headers: { date },
  },
  rawBody: `{"success":true,"systemTime":"${systemTime}","content":{"depositData":{"queryStatus":"Success","datas":[{"accountNo":"0000123456789012","accountBalance":1000.00,"avaliableBalance":900.25}]}}}`,
  observedAt,
  uiAccountNumbers: ["123456789012"],
});

const domesticCaptures = buildCathayCurrentDepositBalanceCaptures(
  domesticRows,
  {
    sourceConnectionKey: "cathay-default-source",
    identityEpochKey: "cathay-domestic-deposit-v1",
    subjectDigest: "sha256:cathay-subject-v1",
    observedAt,
    scopeDate: "2026-09-08",
  },
);
assert.equal(domesticCaptures.length, 1);
const domesticCapture = domesticCaptures[0]!;
assert.match(domesticCapture.captureId, /^[0-9a-f-]{36}$/u);
assert.equal(domesticCapture.authorityRoute, CATHAY_CURRENT_DOMESTIC_BALANCE_AUTHORITY_ROUTE);
assert.deepEqual(domesticCapture.identity, {
  integrationNamespace: "cathay",
  sourceConnectionKey: "cathay-default-source",
  identityEpochKey: "cathay-domestic-deposit-v1",
  stream: "domestic-deposit",
  sourceAccountKey: "123456789012",
});
assert.equal(domesticCapture.pages[0]?.rowCount, 2);
assert.equal(domesticCapture.records.length, 2);
assert.deepEqual(
  domesticCapture.observations.map((observation) => ({
    kind: observation.balanceKind,
    field: observation.sourceField,
    currency: observation.currency,
    sourceRecordKey: observation.sourceRecordKey,
    effectiveAt: observation.time.effectiveAt,
    sourceTime: observation.time.sourceValue,
  })),
  [
    {
      kind: "ledger",
      field: "accountBalance",
      currency: "TWD",
      sourceRecordKey: domesticCapture.records[0]?.sourceRecordKey,
      effectiveAt: systemTime,
      sourceTime: systemTime,
    },
    {
      kind: "available",
      field: "avaliableBalance",
      currency: "TWD",
      sourceRecordKey: domesticCapture.records[1]?.sourceRecordKey,
      effectiveAt: systemTime,
      sourceTime: systemTime,
    },
  ],
);
assert.equal(domesticCapture.records[0]?.compact.observedAt, undefined);
assert.equal(domesticCapture.records[0]?.compact.effectiveTimeSourceField, "systemTime");
assert.equal(domesticCapture.records[0]?.compact.effectiveTimeSourceValue, systemTime);
assert.match(domesticCapture.records[0]?.contentHash ?? "", /^sha256:[A-Za-z0-9_-]+$/u);
assert.doesNotThrow(() => admitCurrentDepositBalanceCapture(domesticCapture));

const foreignRows = parseCathayCurrentDepositBalanceSnapshot({
  kind: "foreign",
  response: {
    url: `https://www.cathaybk.com.tw${CATHAY_CURRENT_FOREIGN_ENDPOINT_PATH}`,
    status: 200,
    method: "POST",
    headers: { date },
  },
  rawBody: `{"success":true,"systemTime":"${systemTime}","content":{"isGetDemandAccountSuccess":true,"demandAccounts":[{"account":"123456789012","demandType":"DemandDeposit","status":"Normal","details":[{"currencyCode":"USD","balance":10.00,"equalTwdBalance":320.00},{"currencyCode":"JPY","balance":2000,"equalTwdBalance":450.00}]}]}}`,
  observedAt,
});
const foreignCaptures = buildCathayCurrentDepositBalanceCaptures(
  foreignRows,
  {
    sourceConnectionKey: "sha256:cathay-foreign-connection",
    identityEpochKey: "sha256:cathay-foreign-epoch",
    subjectDigest: "sha256:cathay-foreign-subject",
    observedAt,
    scopeDate: "2026-09-08",
  },
);
assert.equal(foreignCaptures.length, 1);
const foreignCapture = foreignCaptures[0]!;
assert.equal(foreignCapture.authorityRoute, CATHAY_CURRENT_FOREIGN_BALANCE_AUTHORITY_ROUTE);
assert.equal(foreignCapture.identity.sourceAccountKey, "123456789012");
assert.deepEqual(
  foreignCapture.observations.map((observation) => [
    observation.balanceKind,
    observation.currency,
    observation.sourceField,
  ]),
  [
    ["ledger", "USD", "balance"],
    ["ledger", "JPY", "balance"],
  ],
);
assert.equal(
  foreignCapture.observations.some((observation) => observation.balanceKind === "available"),
  false,
);
assert.doesNotThrow(() => admitCurrentDepositBalanceCapture(foreignCapture));

console.log("cathay-current-deposit-canonical.check passed");
