import assert from "node:assert/strict";

import {
  CATHAY_CURRENT_DOMESTIC_ENDPOINT_PATH,
  CATHAY_CURRENT_FOREIGN_ENDPOINT_PATH,
  parseCathayCurrentDepositBalanceSnapshot,
} from "./cathay-current-deposit-balances.ts";
import {
  buildCathayCurrentDepositBalanceCaptures,
  captureCathayDomesticCurrentBalances,
  captureCathayForeignCurrentBalances,
  cathayForeignCurrentBalanceCaptureMatching,
  CATHAY_CURRENT_DOMESTIC_BALANCE_AUTHORITY_ROUTE,
  CATHAY_CURRENT_FOREIGN_BALANCE_AUTHORITY_ROUTE,
} from "./cathay-current-deposit-canonical.ts";
import {
  admitCurrentDepositBalanceCapture,
} from "../ledger/pglite/current-deposit-admission.ts";
import {
  CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  CATHAY_DOMESTIC_DEPOSIT_STREAM,
  validateCathayDomesticDepositSyncInputForPGlite,
} from "../ledger/pglite/cathay-domestic-admission.ts";
import { buildCathayDomesticFinancialRequestsForPGlite } from "../ledger/pglite/cathay-domestic-adapter.ts";
import { CATHAY_FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1 } from "../ledger/canonical/foreign-currency-deposit.fixtures.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import { indexCurrentBalanceCaptures } from "./current-state-snapshot-capture.ts";
import {
  cathayDomesticOverviewBody,
  cathayForeignOverviewBody,
  cathayOverviewAcquired,
} from "./cathay-current-deposit-balances.fixtures.ts";

const systemTime = "2026-09-08T21:20:04.1234567+08:00";
const observedAt = "2026-09-08T21:20:10.000+08:00";
const date = "Tue, 08 Sep 2026 13:20:04 GMT";
const domesticAccountNumber = ["0000", "1234", "5678", "9012"].join("");
const foreignAccountNumber = ["1234", "5678", "9012"].join("");

const domesticRows = parseCathayCurrentDepositBalanceSnapshot({
  kind: "domestic",
  response: {
    url: `https://www.cathaybk.com.tw${CATHAY_CURRENT_DOMESTIC_ENDPOINT_PATH}`,
    status: 200,
    method: "POST",
    headers: { date },
  },
  rawBody: `{"success":true,"systemTime":"${systemTime}","content":{"depositData":{"queryStatus":"Success","datas":[{"accountNo":"${domesticAccountNumber}","accountBalance":1000.00,"avaliableBalance":900.25}]}}}`,
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
  rawBody: `{"success":true,"systemTime":"${systemTime}","content":{"isGetDemandAccountSuccess":true,"demandAccounts":[{"account":"${foreignAccountNumber}","demandType":"DemandDeposit","status":"Normal","details":[{"currencyCode":"USD","balance":10.00,"equalTwdBalance":320.00},{"currencyCode":"JPY","balance":2000,"equalTwdBalance":450.00}]}]}}`,
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

// Domestic balances take their identity from the run's admitted statement
// captures, so they attach to the same financial account.
const admittedStatement = buildCathayDomesticFinancialRequestsForPGlite(
  validateCathayDomesticDepositSyncInputForPGlite({
    sourceConnectionId: "synthetic-cathay-connection",
    identityEpoch: "synthetic-cathay-epoch",
    authorityRoute: CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
    stream: CATHAY_DOMESTIC_DEPOSIT_STREAM,
    syncState: { cursor: null },
    observedAt: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.observedAt,
    pages: [
      {
        accountNo: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.accountNo,
        currency: "TWD",
        scope: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.scope,
        pageOrdinal: 0,
        requestPageToken: null,
        nextPageToken: null,
        rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse,
        contractFingerprint: CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
        preflightFingerprint: "cathay/domestic-deposit/collection-v1",
        absenceAuthority: "comparable-complete-range",
      },
    ],
  }),
)[0]!;
const otherAccountKey = ["9999", "9999", "9999"].join("");
const uiKey = domesticRows[0]!.sourceAccountKey;
const admittedForRows = {
  ...admittedStatement,
  account: { ...admittedStatement.account, sourceAccountKey: uiKey },
};
const domesticOverview = {
  body: cathayDomesticOverviewBody(systemTime, [
    { ui: otherAccountKey, ledger: "1.00", available: "1.00" },
    { ui: uiKey, ledger: "1000.00", available: "900.25" },
  ]),
  date,
  uiAccounts: [otherAccountKey, uiKey],
};

function snapshotHarness(events: string[] = []) {
  return {
    product: { event: async (_stage: string, outcome: string, code: string) => void events.push(`${code} ${outcome}`) },
    text: strictSourceText,
    signal: new AbortController().signal,
  };
}

function domesticBalances(
  admitted: readonly (typeof admittedForRows)[],
  overview = domesticOverview,
  events?: string[],
) {
  return captureCathayDomesticCurrentBalances({
    ...snapshotHarness(events),
    admitted,
    acquire: async () => cathayOverviewAcquired("domestic", overview, observedAt),
  });
}

type StagedBalance = Readonly<{
  product: string;
  itemKey: string;
  command: Readonly<{
    request: Readonly<{
      capture: Readonly<{ sourceConnectionKey: string; identityEpoch: string; stream: string }>;
      account: Readonly<{ sourceAccountKey: string }>;
    }>;
  }>;
}>;

{
  const events: string[] = [];
  const items = await domesticBalances([admittedForRows], domesticOverview, events) as readonly StagedBalance[];
  assert.deepEqual(
    items.map((item) => [item.product, item.itemKey]),
    [["domestic-current-balance", `current-balance:domestic-deposit:${uiKey}`]],
    "only the admitted account is staged, and an unadmitted overview row is skipped",
  );
  const { capture, account } = items[0]!.command.request;
  assert.deepEqual(
    [capture.sourceConnectionKey, capture.identityEpoch, capture.stream, account.sourceAccountKey],
    [admittedStatement.capture.sourceConnectionKey, admittedStatement.capture.identityEpoch, admittedStatement.capture.stream, uiKey],
    "the balance takes its identity from the admitted statement capture",
  );
  assert.equal(events.at(-1), "current-balance-validation-completed completed");
}
{
  const events: string[] = [];
  await assert.rejects(
    domesticBalances([admittedStatement], domesticOverview, events),
    /^Error: Cathay domestic current balance source omitted a selected account\.$/u,
  );
  assert.equal(events.at(-1), "current-balance-validation-rejected failed", "an incomplete overview rejects validation");
  assert.ok(!events.includes("current-balance-validation-completed completed"));
}
await assert.rejects(
  domesticBalances([
    admittedForRows,
    { ...admittedForRows, capture: { ...admittedForRows.capture, identityEpoch: "sha256:other-epoch" } },
  ]),
  /^Error: Cathay domestic admitted captures do not share one source identity\.$/u,
);
{
  const events: string[] = [];
  const truncated = { ...domesticOverview, body: domesticOverview.body.replace(/\}$/u, "") };
  await assert.rejects(domesticBalances([admittedForRows], truncated, events), /not valid JSON/u);
  assert.deepEqual(events.slice(-2), ["current-balance-decoding-failed failed", "current-balance-collection-failed failed"]);
}

// Foreign balances key by the admitted account number; each account stages
// one capture carrying every currency the overview lists for it.
{
  const foreignAccount = ["0012", "3456", "7890"].join("");
  const unadmittedForeign = ["0099", "9999", "9999"].join("");
  const foreignOverview = {
    body: cathayForeignOverviewBody(systemTime, [
      { number: unadmittedForeign, details: [{ currency: "USD", balance: "1.00" }] },
      { number: foreignAccount, details: [{ currency: "USD", balance: "10.00" }, { currency: "JPY", balance: "2000" }] },
    ]),
    date,
  };
  const foreignCapture = (number: string, currency: string) => ({
    ...CATHAY_FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1,
    accountNo: number,
    captureCurrencyScope: { kind: "currency" as const, currency },
    records: CATHAY_FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1.records.map((record) => ({
      ...record,
      currencyEvidence: { kind: "row" as const, currency },
      originalAmount: { amount: record.amount, currency },
    })),
  });
  const foreignBalances = (
    admitted: readonly ReturnType<typeof foreignCapture>[],
    overview: typeof foreignOverview = foreignOverview,
  ) => captureCathayForeignCurrentBalances({
    ...snapshotHarness(),
    admitted,
    acquire: async () => cathayOverviewAcquired("foreign", overview, observedAt),
  });

  const items = await foreignBalances([foreignCapture(foreignAccount, "USD"), foreignCapture(foreignAccount, "JPY")]) as readonly StagedBalance[];
  assert.deepEqual(
    items.map((item) => [item.product, item.itemKey]),
    [["foreign-current-balance", `current-balance:foreign-currency-deposit:${foreignAccount}:JPY+USD`]],
    "a row for an account the run did not admit is skipped silently",
  );
  await assert.rejects(
    foreignBalances([foreignCapture(foreignAccount, "USD")], {
      ...foreignOverview,
      body: cathayForeignOverviewBody(systemTime, [
        { number: unadmittedForeign, details: [{ currency: "USD", balance: "1.00" }] },
      ]),
    }),
    /^Error: Cathay current foreign balance response did not contain an admitted account\.$/u,
  );
  await assert.rejects(
    foreignBalances([foreignCapture(foreignAccount, "USD"), foreignCapture(["0011", "1111", "1111"].join(""), "USD")]),
    /^Error: Cathay current foreign balance response omitted an admitted account\.$/u,
  );

  const identity = {
    accountNo: foreignAccount,
    sourceConnectionKey: "sha256:cathay-connection",
    identityEpochKey: "sha256:cathay-epoch",
    subjectDigest: "sha256:cathay-subject-first",
  };
  const lastIdentity = { ...identity, subjectDigest: "sha256:cathay-subject-last" };
  assert.deepEqual(
    indexCurrentBalanceCaptures(
      [identity, lastIdentity],
      cathayForeignCurrentBalanceCaptureMatching,
    ).match([{ sourceAccountKey: foreignAccount }]).matched.map(({ capture }) => capture),
    [lastIdentity],
    "the last admitted identity for an account wins without an ambiguity check",
  );
}

console.log("cathay-current-deposit-canonical.check passed");
