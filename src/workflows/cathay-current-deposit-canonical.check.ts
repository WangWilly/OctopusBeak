import assert from "node:assert/strict";

import { CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS } from "../ledger/canonical/current-deposit-route-contracts.ts";
import {
  CATHAY_CURRENT_DOMESTIC_RESPONSE,
  CATHAY_CURRENT_FOREIGN_RESPONSE,
  parseCathayCurrentDepositBalanceSnapshot,
} from "./cathay-current-deposit-balances.ts";
import {
  buildCathayCurrentDepositBalanceCaptures,
  cathayDomesticCurrentBalanceSnapshot,
  type CathayAdmittedDeposit,
  cathayCurrentBalanceCaptureMatching,
  cathayForeignCurrentBalanceSnapshot,
  CATHAY_CURRENT_DOMESTIC_BALANCE_AUTHORITY_ROUTE,
  CATHAY_CURRENT_FOREIGN_BALANCE_AUTHORITY_ROUTE,
} from "./cathay-current-deposit-canonical.ts";
import {
  admitCurrentDepositBalanceCapture,
} from "../ledger/pglite/current-deposit-admission.ts";
import {
  admitCathayDomesticDepositCapture,
  CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  CATHAY_DOMESTIC_DEPOSIT_IDENTITY_EPOCH,
  CATHAY_DOMESTIC_DEPOSIT_SOURCE_CONNECTION,
  CATHAY_DOMESTIC_DEPOSIT_STREAM,
} from "../ledger/canonical/cathay-domestic-deposit-admission.ts";
import { CATHAY_FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1 } from "../ledger/canonical/foreign-currency-deposit.fixtures.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import { captureCurrentStateSnapshots, indexCurrentBalanceCaptures } from "./current-state-snapshot-capture.ts";
import { admitForeignCurrencyDepositCapture } from "../ledger/canonical/foreign-currency-deposit-admission.ts";
import { verifyProviderResponse } from "./provider-response.ts";
import {
  cathayDomesticOverviewBody,
  cathayForeignOverviewBody,
  cathayOverviewAcquired,
} from "./cathay-current-deposit-balances.fixtures.ts";
import { productCollectionHandle, type ProductCollectionStageEvent } from "../lib/automation/product-collection.ts";

const DOMESTIC_CONTRACT = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS["cathay/domestic-deposit/current-balance-v1"];
const FOREIGN_CONTRACT = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS["cathay/foreign-currency/current-balance-v1"];

const systemTime = "2026-09-08T21:20:04.1234567+08:00";
const observedAt = "2026-09-08T21:20:10+08:00";
const date = "Tue, 08 Sep 2026 13:20:04 GMT";
const domesticAccountNumber = ["0000", "1234", "5678", "9012"].join("");
const foreignAccountNumber = ["1234", "5678", "9012"].join("");

const domesticRows = parseCathayCurrentDepositBalanceSnapshot({
  kind: "domestic",
  response: verifyProviderResponse(CATHAY_CURRENT_DOMESTIC_RESPONSE, {
    url: `https://${DOMESTIC_CONTRACT.endpointHost}${DOMESTIC_CONTRACT.endpointPath}`,
    status: 200,
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", date },
  }, observedAt),
  rawBody: `{"success":true,"systemTime":"${systemTime}","content":{"depositData":{"queryStatus":"Success","datas":[{"accountNo":"${domesticAccountNumber}","accountBalance":1000.00,"avaliableBalance":900.25}]}}}`,
  uiAccountNumbers: ["123456789012"],
});

const domesticCaptures = buildCathayCurrentDepositBalanceCaptures(
  domesticRows,
  {
    sourceConnectionKey: CATHAY_DOMESTIC_DEPOSIT_SOURCE_CONNECTION,
    identityEpochKey: CATHAY_DOMESTIC_DEPOSIT_IDENTITY_EPOCH,
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
  sourceConnectionKey: CATHAY_DOMESTIC_DEPOSIT_SOURCE_CONNECTION,
  identityEpochKey: CATHAY_DOMESTIC_DEPOSIT_IDENTITY_EPOCH,
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
  response: verifyProviderResponse(CATHAY_CURRENT_FOREIGN_RESPONSE, {
    url: `https://${FOREIGN_CONTRACT.endpointHost}${FOREIGN_CONTRACT.endpointPath}`,
    status: 200,
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", date },
  }, observedAt),
  rawBody: `{"success":true,"systemTime":"${systemTime}","content":{"isGetDemandAccountSuccess":true,"demandAccounts":[{"account":"${foreignAccountNumber}","demandType":"DemandDeposit","status":"Normal","details":[{"currencyCode":"USD","balance":10.00,"equalTwdBalance":320.00},{"currencyCode":"JPY","balance":2000,"equalTwdBalance":450.00}]}]}}`,
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
const admittedStatement = admitCathayDomesticDepositCapture({
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
});
const otherAccountKey = ["9999", "9999", "9999"].join("");
const uiKey = domesticRows[0]!.sourceAccountKey;
const admittedForRows: CathayAdmittedDeposit = {
  identity: { ...admittedStatement.identity, accountNo: uiKey, sourceAccountKey: uiKey },
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
  const event: ProductCollectionStageEvent = async (_stage, outcome, code) => void events.push(`${code} ${outcome}`);
  return {
    product: productCollectionHandle({
      now: () => observedAt,
      text: strictSourceText,
      signal: new AbortController().signal,
      event,
      stage: () => undefined,
      reportActivity: async () => undefined,
      collectionPeriod: () => { throw new Error("This check supplies no collection period."); },
    }),
  };
}

async function domesticBalances(
  admitted: readonly CathayAdmittedDeposit[],
  overview = domesticOverview,
  events?: string[],
) {
  const { items } = await captureCurrentStateSnapshots(cathayDomesticCurrentBalanceSnapshot(admitted), {
    ...snapshotHarness(events),
    captures: admitted,
    acquire: async () => cathayOverviewAcquired("domestic", overview),
  });
  return items;
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
    [admittedStatement.identity.sourceConnectionKey, admittedStatement.identity.identityEpochKey, admittedStatement.identity.stream, uiKey],
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
  assert.equal(events.at(-1), "source-validation-rejected failed", "an incomplete overview rejects validation");
  assert.ok(!events.includes("current-balance-validation-completed completed"));
}
await assert.rejects(
  domesticBalances([
    admittedForRows,
    { identity: { ...admittedForRows.identity, identityEpochKey: "sha256:other-epoch" } },
  ]),
  /^Error: Cathay admitted deposits do not share one source identity\.$/u,
);
{
  const events: string[] = [];
  const truncated = { ...domesticOverview, body: domesticOverview.body.replace(/\}$/u, "") };
  await assert.rejects(domesticBalances([admittedForRows], truncated, events), /not valid JSON/u);
  assert.equal(events.at(-1), "source-validation-rejected failed", "a reply that is not JSON rejects validation");
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
  const foreignBalances = async (
    captures: readonly ReturnType<typeof foreignCapture>[],
    overview: typeof foreignOverview = foreignOverview,
  ) => {
    const admitted = captures.map((capture) => admitForeignCurrencyDepositCapture(capture));
    const { items } = await captureCurrentStateSnapshots(cathayForeignCurrentBalanceSnapshot(admitted), {
      ...snapshotHarness(),
      captures: admitted,
      acquire: async () => cathayOverviewAcquired("foreign", overview),
    });
    return items;
  };

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
    sourceAccountKey: foreignAccount,
    sourceConnectionKey: "sha256:cathay-connection",
    identityEpochKey: "sha256:cathay-epoch",
    stream: "foreign-currency-deposit",
    subjectDigest: "sha256:cathay-subject",
  };
  const first = { identity };
  const sameAccount = { identity: { ...identity } };
  assert.deepEqual(
    indexCurrentBalanceCaptures([first, sameAccount], cathayCurrentBalanceCaptureMatching)
      .match([{ sourceAccountKey: foreignAccount }]).matched.map(({ capture }) => capture),
    [first],
    "captures of one account that agree on its identity keep the first",
  );
  assert.throws(
    () => indexCurrentBalanceCaptures(
      [first, { identity: { ...identity, subjectDigest: "sha256:cathay-other-subject" } }],
      cathayCurrentBalanceCaptureMatching,
    ),
    /^Error: Cathay admitted deposit identities are ambiguous\.$/u,
  );
}

console.log("cathay-current-deposit-canonical.check passed");
