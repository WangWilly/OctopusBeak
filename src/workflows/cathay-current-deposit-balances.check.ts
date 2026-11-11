import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS } from "../ledger/canonical/current-deposit-route-contracts.ts";
import { type ProviderResponse, verifyProviderResponse } from "./provider-response.ts";
import {
  cathayDomesticOverviewBody,
  cathayForeignOverviewBody,
  cathayOverviewAcquired,
  cathayOverviewPage,
} from "./cathay-current-deposit-balances.fixtures.ts";
import { registerHooks } from "node:module";
import { strictSourceText } from "../lib/automation/source-text.ts";
import { sourceReader } from "./provider-response-reader.ts";
import type { CathayAdmittedDeposit } from "./cathay-current-deposit-balances.ts";
import { captureCurrentStateSnapshots } from "./current-state-snapshot-capture.ts";
import { snapshotCheckProduct, stagedBalanceRequest } from "./current-state-snapshot-capture.fixtures.ts";
import type { ProductCollectionStageEvent } from "../lib/automation/product-collection.ts";
import {
  admitCathayDomesticDepositCapture,
  CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  CATHAY_DOMESTIC_DEPOSIT_STREAM,
} from "../ledger/canonical/cathay-domestic-deposit-admission.ts";
import { CATHAY_FOREIGN_CURRENCY_DEPOSIT_FIXTURE_V1 } from "../ledger/canonical/foreign-currency-deposit.fixtures.ts";
import { admitForeignCurrencyDepositCapture } from "../ledger/canonical/foreign-currency-deposit-admission.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./cathay-statements.js") {
      return nextResolve("./cathay-statements.ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const {
  cathayCurrentDepositResponseDeclaration,
  cathayDomesticCurrentBalanceSnapshot,
  cathayForeignCurrentBalanceSnapshot,
  parseCathayCurrentDepositBalanceSnapshot,
} = await import("./cathay-current-deposit-balances.ts");
const DOMESTIC_CONTRACT = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS["cathay/domestic-deposit/current-balance-v1"];
const FOREIGN_CONTRACT = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS["cathay/foreign-currency/current-balance-v1"];

const observedAt = "2026-09-08T21:20:10+08:00";
const httpDate = "Tue, 08 Sep 2026 13:20:04 GMT";
const systemTime = "2026-09-08T21:20:04.1234567+08:00";
const uiAccountNumber = ["1234", "5678", "9012"].join("");
const timeDepositNumber = ["0000", "9999", "9999", "9999"].join("");

const rawResponse = (
  kind: "domestic" | "foreign",
  overrides: Partial<ProviderResponse> = {},
): ProviderResponse => ({
  url: `https://${DOMESTIC_CONTRACT.endpointHost}${
    kind === "domestic"
      ? DOMESTIC_CONTRACT.endpointPath
      : FOREIGN_CONTRACT.endpointPath
  }`,
  status: 200,
  method: "POST",
  headers: { "content-type": "application/json; charset=utf-8", date: httpDate },
  ...overrides,
});

const response = (
  kind: "domestic" | "foreign",
  overrides: Partial<ProviderResponse> = {},
) => verifyProviderResponse(cathayCurrentDepositResponseDeclaration(kind), rawResponse(kind, overrides), observedAt);

const domesticBody = `{"success":true,"systemTime":"${systemTime}","content":{"depositData":{"queryStatus":"Success","totalAccountBalance":9999.99,"totalAvaliableBalance":8888.88,"datas":[{"accountType":"DemandDeposit","accountNo":"0000${uiAccountNumber}","accountName":"fixture domestic","accountNickName":"fixture","accountBalance":1000.00,"avaliableBalance":900.25,"datas":[]}]},"timeDepositData":[{"accountNo":"${timeDepositNumber}","accountBalance":999999.99}]}}`;

const domestic = parseCathayCurrentDepositBalanceSnapshot({
  kind: "domestic",
  response: response("domestic"),
  rawBody: domesticBody,
  uiAccountNumbers: ["123456789012"],
});

assert.equal(domestic.length, 1);
const domesticRow = domestic[0];
if (!domesticRow || domesticRow.kind !== "domestic") {
  throw new Error("Cathay domestic fixture did not produce a domestic row.");
}
assert.equal(domesticRow.sourceAccountKey, "123456789012");
assert.equal(domesticRow.uiAccountNumber, "123456789012");
assert.equal(domesticRow.providerAccountNumber, "0000123456789012");
assert.equal(domesticRow.currency, "TWD");
assert.deepEqual(domesticRow.ledger, {
  coefficient: "100000",
  scale: 2,
  sourceLexeme: "1000.00",
});
assert.deepEqual(domesticRow.available, {
  coefficient: "90025",
  scale: 2,
  sourceLexeme: "900.25",
});
assert.notDeepEqual(domesticRow.ledger, domesticRow.available);
assert.deepEqual(
  domesticRow.observations.map((entry) => entry.kind),
  ["ledger", "available"],
);
assert.equal(domesticRow.providerSystemTime, systemTime);
assert.equal(domesticRow.effectiveAt, systemTime);
assert.equal(domesticRow.httpDate, httpDate);
assert.match(domesticRow.sourceEvidence.responseDigest, /^sha256:[A-Za-z0-9_-]+$/u);
assert.equal(domesticRow.observedAt, observedAt);
assert.equal(domesticRow.observations[0]?.effectiveTimeBasis, "provider-system-time");
assert.equal(domesticRow.observations[0]?.effectiveTimeEvidence.value, systemTime);
assert.doesNotMatch(JSON.stringify(domestic), /999999/u);

const foreignBody = `{"success":true,"systemTime":"${systemTime}","content":{"isGetDemandAccountSuccess":true,"demandAccounts":[{"account":"${uiAccountNumber}","nickName":null,"demandType":"DemandDeposit","status":"Normal","details":[{"currencyId":"02","currencyCode":"USD","currency":"美元","balance":10.00,"equalTwdBalance":320.00,"dueDate":null},{"currencyId":"16","currencyCode":"JPY","currency":"日幣","balance":2000,"equalTwdBalance":450.00,"dueDate":null}]}],"depositAccounts":[{"account":"ignored-deposit-account"}]}}`;

const foreign = parseCathayCurrentDepositBalanceSnapshot({
  kind: "foreign",
  response: response("foreign"),
  rawBody: foreignBody,
});

assert.deepEqual(
  foreign.map((row) => {
    if (row.kind !== "foreign") {
      throw new Error("Cathay foreign fixture did not produce a foreign row.");
    }
    return {
      sourceAccountKey: row.sourceAccountKey,
      accountNumber: row.accountNumber,
      currency: row.currency,
      sourceCode: row.currencySourceCode,
      ledger: row.ledger,
      observationKinds: row.observations.map((entry) => entry.kind),
    };
  }),
  [
    {
      sourceAccountKey: "123456789012",
      accountNumber: uiAccountNumber,
      currency: "USD",
      sourceCode: "USD",
      ledger: { coefficient: "1000", scale: 2, sourceLexeme: "10.00" },
      observationKinds: ["ledger"],
    },
    {
      sourceAccountKey: "123456789012",
      accountNumber: uiAccountNumber,
      currency: "JPY",
      sourceCode: "JPY",
      ledger: { coefficient: "2000", scale: 0, sourceLexeme: "2000" },
      observationKinds: ["ledger"],
    },
  ],
);
assert.equal(foreign.length, 2);
assert.equal(
  foreign[0]?.sourceEvidence.responseDigest,
  foreign[1]?.sourceEvidence.responseDigest,
);
assert.match(foreign[0]?.sourceEvidence.responseDigest ?? "", /^sha256:[A-Za-z0-9_-]+$/u);
assert.doesNotMatch(JSON.stringify(foreign), /available|equalTwdBalance|depositAccounts/u);

const domesticInput = {
  kind: "domestic" as const,
  response: response("domestic"),
  rawBody: domesticBody,
  uiAccountNumbers: ["123456789012"],
};

assert.throws(() => response("domestic", { method: "GET" }), /method is not POST/u);
assert.throws(
  () => verifyProviderResponse(cathayCurrentDepositResponseDeclaration("foreign"), rawResponse("domestic"), observedAt),
  /endpoint is unexpected/u,
  "each overview kind admits only its own endpoint",
);
assert.equal(response("domestic", { headers: { "content-type": "text/plain", date: httpDate } }).contentType, "text/plain");
assert.throws(
  () => response("domestic", { headers: { "content-type": "text/html; charset=utf-8", date: httpDate } }),
  /content type is unexpected/u,
);
assert.equal(
  response("domestic", { url: `${rawResponse("domestic").url}?_=1` }).url.search,
  "?_=1",
  "Cathay never constrained the overview query",
);
assert.throws(
  () =>
    parseCathayCurrentDepositBalanceSnapshot({
      ...domesticInput,
      rawBody: domesticBody.replace(`"success":true`, `"success":false`),
    }),
  /API response was not successful/u,
);
assert.throws(
  () =>
    parseCathayCurrentDepositBalanceSnapshot({
      ...domesticInput,
      rawBody: domesticBody.replace(systemTime, "2026-02-30T21:20:04.1234567+08:00"),
    }),
  /systemTime has an invalid calendar date/u,
);
assert.throws(
  () =>
    parseCathayCurrentDepositBalanceSnapshot({
      ...domesticInput,
      rawBody: domesticBody.replace(systemTime, "2026-09-08T23:20:04.1234567+08:00"),
    }),
  /inconsistent with HTTP Date/u,
);
assert.throws(
  () =>
    parseCathayCurrentDepositBalanceSnapshot({
      ...domesticInput,
      rawBody: domesticBody.replace('"depositData":', '"wrongData":'),
    }),
  /depositData is invalid/u,
);
assert.throws(
  () =>
    parseCathayCurrentDepositBalanceSnapshot({
      ...domesticInput,
      uiAccountNumbers: ["123456789013"],
    }),
  /does not bind exactly/u,
);
assert.throws(
  () =>
    parseCathayCurrentDepositBalanceSnapshot({
      ...domesticInput,
      uiAccountNumbers: ["123456789012", "987654321098"],
    }),
  /binding is incomplete/u,
);
assert.throws(
  () =>
    parseCathayCurrentDepositBalanceSnapshot({
      ...domesticInput,
      rawBody: domesticBody.replace("1000.00", '"1,2"'),
    }),
  /not an exact decimal/u,
);

const foreignInput = {
  kind: "foreign" as const,
  response: response("foreign"),
  rawBody: foreignBody,
};
assert.throws(
  () =>
    parseCathayCurrentDepositBalanceSnapshot({
      ...foreignInput,
      rawBody: foreignBody.replace('"isGetDemandAccountSuccess":true', '"isGetDemandAccountSuccess":false'),
    }),
  /not successful/u,
);
assert.throws(
  () =>
    parseCathayCurrentDepositBalanceSnapshot({
      ...foreignInput,
      rawBody: foreignBody.replace('"demandType":"DemandDeposit"', '"demandType":"TimeDeposit"'),
    }),
  /not a normal demand account/u,
);
assert.throws(
  () =>
    parseCathayCurrentDepositBalanceSnapshot({
      ...foreignInput,
      rawBody: foreignBody.replace('"currencyCode":"USD"', '"currencyCode":"usd"'),
    }),
  /currencyCode is invalid/u,
);
assert.throws(
  () =>
    parseCathayCurrentDepositBalanceSnapshot({
      ...foreignInput,
      rawBody: foreignBody.replace("10.00", '"1,2"'),
    }),
  /not an exact decimal/u,
);

{
  const { readCathayCurrentDepositBalanceResponse } = await import("./cathay-current-deposit-balances.ts");
  const running = {
    reader: sourceReader({ now: () => "2026-09-08T13:20:10.000Z", text: strictSourceText }),
    signal: new AbortController().signal,
  };
  const ui = ["9990", "0000", "0001"].join("");
  const body = cathayDomesticOverviewBody(systemTime, [{ ui, ledger: "1000.00", available: "900.25" }]);
  const overview = { body, date: httpDate, uiAccounts: [ui] };
  const read = await readCathayCurrentDepositBalanceResponse(cathayOverviewPage({}, { domestic: overview }), "domestic", running);
  assert.equal(new TextDecoder().decode(read.evidence.bytes), body, "the reader hands over the response bytes undecoded");
  assert.deepEqual(read.uiAccountNumbers, [ui]);
  assert.equal(read.response.url, `https://${DOMESTIC_CONTRACT.endpointHost}${DOMESTIC_CONTRACT.endpointPath}`);
  assert.equal(read.response.method, "POST");
  const foreignRead = await readCathayCurrentDepositBalanceResponse(
    cathayOverviewPage({}, { foreign: { body: foreignBody, date: httpDate } }),
    "foreign",
    running,
  );
  assert.equal(foreignRead.uiAccountNumbers, undefined);
  await assert.rejects(
    readCathayCurrentDepositBalanceResponse(cathayOverviewPage({}, { domestic: { ...overview, posts: 2 } }), "domestic", running),
    /^Error: Cathay current balance source response was missing or ambiguous\.$/u,
  );
}

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
const admittedForRows: CathayAdmittedDeposit = {
  identity: { ...admittedStatement.identity, accountNo: uiAccountNumber, sourceAccountKey: uiAccountNumber },
};
const domesticOverview = {
  body: cathayDomesticOverviewBody(systemTime, [
    { ui: otherAccountKey, ledger: "1.00", available: "1.00" },
    { ui: uiAccountNumber, ledger: "1000.00", available: "900.25" },
  ]),
  date: httpDate,
  uiAccounts: [otherAccountKey, uiAccountNumber],
};

function product(events: string[] = []) {
  const event: ProductCollectionStageEvent = async (_stage, outcome, code) => void events.push(`${code} ${outcome}`);
  return snapshotCheckProduct({ now: observedAt, event });
}

async function domesticBalances(
  admitted: readonly CathayAdmittedDeposit[],
  overview = domesticOverview,
  events?: string[],
) {
  const { items } = await captureCurrentStateSnapshots(cathayDomesticCurrentBalanceSnapshot(admitted), {
    product: product(events),
    captures: admitted,
    acquire: async () => cathayOverviewAcquired("domestic", overview),
  });
  return items;
}

{
  const events: string[] = [];
  const items = await domesticBalances([admittedForRows], domesticOverview, events);
  assert.deepEqual(
    items.map((item) => [item.product, item.itemKey]),
    [["domestic-current-balance", `current-balance:domestic-deposit:${uiAccountNumber}`]],
    "only the admitted account is staged, and an unadmitted overview row is skipped",
  );
  const { capture, account, observations } = stagedBalanceRequest(items[0]);
  assert.deepEqual(
    [capture.sourceConnectionKey, capture.identityEpoch, capture.stream, account.sourceAccountKey],
    [admittedStatement.identity.sourceConnectionKey, admittedStatement.identity.identityEpochKey, admittedStatement.identity.stream, uiAccountNumber],
    "the balance takes its identity from the admitted statement capture",
  );
  assert.equal(
    capture.subjectDigest,
    `sha256:${createHash("sha256").update(`cathay/current-deposit-subject/v1|${capture.sourceConnectionKey}|${capture.identityEpoch}`, "utf8").digest("base64url")}`,
    "a domestic balance derives its subject from the connection and epoch",
  );
  assert.match(capture.captureId, /^[0-9a-f-]{36}$/u);
  assert.equal(capture.integrationNamespace, "cathay");
  assert.equal(capture.routeKey, "cathay/domestic-deposit/current-balance-v1");
  assert.equal(capture.observedAt, observedAt);
  assert.deepEqual([capture.scope.startDate, capture.scope.endDate], ["2026-09-08", "2026-09-08"]);
  assert.equal(account.currency, "TWD");
  assert.equal(capture.pages[0]?.rowCount, 2);
  assert.equal(capture.records.length, 2);
  assert.deepEqual(
    observations.map((observation, index) => ({
      kind: observation.balanceKind,
      field: capture.records[index]?.compact.sourceField,
      currency: observation.currency,
      balance: observation.balance,
      linked: observation.evidenceSourceRecordKey === capture.records[index]?.occurrenceKey,
      effectiveAt: observation.effectiveAt,
      sourceField: observation.evidenceSourceField,
      sourceTime: observation.evidenceSourceValue,
    })),
    [
      {
        kind: "ledger",
        field: "accountBalance",
        currency: "TWD",
        balance: { coefficient: "100000", scale: 2 },
        linked: true,
        effectiveAt: systemTime,
        sourceField: "systemTime",
        sourceTime: systemTime,
      },
      {
        kind: "available",
        field: "avaliableBalance",
        currency: "TWD",
        balance: { coefficient: "90025", scale: 2 },
        linked: true,
        effectiveAt: systemTime,
        sourceField: "systemTime",
        sourceTime: systemTime,
      },
    ],
  );
  assert.equal(capture.records[0]?.compact.observedAt, undefined);
  assert.equal(capture.records[0]?.compact.effectiveTimeSourceField, "systemTime");
  assert.equal(capture.records[0]?.compact.effectiveTimeSourceValue, systemTime);
  assert.match(capture.records[0]?.contentHash ?? "", /^sha256:[A-Za-z0-9_-]+$/u);
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
await assert.rejects(
  domesticBalances([{ identity: { ...admittedForRows.identity, stream: "foreign-currency-deposit" } }]),
  /^Error: Cathay domestic current balance row stream does not match its admitted capture\.$/u,
  "a capture keyed to the row on another stream is refused",
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
    date: httpDate,
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
    admitted: readonly CathayAdmittedDeposit[],
    overview: typeof foreignOverview = foreignOverview,
  ) => captureCurrentStateSnapshots(cathayForeignCurrentBalanceSnapshot(admitted), {
    product: product(),
    captures: admitted,
    acquire: async () => cathayOverviewAcquired("foreign", overview),
  });
  const admit = (captures: readonly ReturnType<typeof foreignCapture>[]) =>
    captures.map((capture) => admitForeignCurrencyDepositCapture(capture));

  const admitted = admit([foreignCapture(foreignAccount, "USD"), foreignCapture(foreignAccount, "JPY")]);
  const staged = await foreignBalances(admitted);
  assert.deepEqual(
    staged.items.map((item) => [item.product, item.itemKey]),
    [["foreign-current-balance", `current-balance:foreign-currency-deposit:${foreignAccount}:JPY+USD`]],
    "a row for an account the run did not admit is skipped silently",
  );
  assert.deepEqual(
    staged.matched.map(({ capture }) => capture),
    [admitted[0]],
    "captures of one account that agree on its identity keep the first",
  );
  const { capture, account, observations } = stagedBalanceRequest(staged.items[0]);
  assert.equal(capture.routeKey, "cathay/foreign-currency/current-balance-v1");
  assert.equal(capture.subjectDigest, admitted[0]!.identity.subjectDigest, "a foreign balance keeps its admitted subject");
  assert.equal(account.sourceAccountKey, foreignAccount);
  assert.deepEqual([capture.scope.startDate, capture.scope.endDate], ["2026-09-08", "2026-09-08"]);
  assert.deepEqual(
    observations.map((observation, index) => [
      observation.balanceKind,
      observation.currency,
      capture.records[index]?.compact.sourceField,
    ]),
    [
      ["ledger", "USD", "balance"],
      ["ledger", "JPY", "balance"],
    ],
    "a foreign account carries only ledger balances",
  );
  await assert.rejects(
    foreignBalances(admit([foreignCapture(foreignAccount, "USD")]), {
      ...foreignOverview,
      body: cathayForeignOverviewBody(systemTime, [
        { number: unadmittedForeign, details: [{ currency: "USD", balance: "1.00" }] },
      ]),
    }),
    /^Error: Cathay current foreign balance response did not contain an admitted account\.$/u,
  );
  await assert.rejects(
    foreignBalances(admit([foreignCapture(foreignAccount, "USD"), foreignCapture(["0011", "1111", "1111"].join(""), "USD")])),
    /^Error: Cathay current foreign balance response omitted an admitted account\.$/u,
  );
  await assert.rejects(
    foreignBalances([admitted[0]!, { identity: { ...admitted[0]!.identity, subjectDigest: "sha256:cathay-other-subject" } }]),
    /^Error: Cathay admitted deposit identities are ambiguous\.$/u,
  );
}

console.log("cathay-current-deposit-balances.check passed");
