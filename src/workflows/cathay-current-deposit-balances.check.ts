import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./cathay-statements.js") {
      return nextResolve("./cathay-statements.ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const {
  CATHAY_CURRENT_DEPOSIT_HOST,
  CATHAY_CURRENT_DOMESTIC_ENDPOINT_PATH,
  CATHAY_CURRENT_FOREIGN_ENDPOINT_PATH,
  parseCathayCurrentDepositBalanceSnapshot,
} = await import("./cathay-current-deposit-balances.ts");

type ResponseMetadata = Parameters<
  typeof parseCathayCurrentDepositBalanceSnapshot
>[0]["response"];

const observedAt = "2026-09-08T21:20:10+08:00";
const httpDate = "Tue, 08 Sep 2026 13:20:04 GMT";
const systemTime = "2026-09-08T21:20:04.1234567+08:00";

const response = (
  kind: "domestic" | "foreign",
  overrides: Partial<ResponseMetadata> = {},
): ResponseMetadata => ({
  url: `https://${CATHAY_CURRENT_DEPOSIT_HOST}${
    kind === "domestic"
      ? CATHAY_CURRENT_DOMESTIC_ENDPOINT_PATH
      : CATHAY_CURRENT_FOREIGN_ENDPOINT_PATH
  }`,
  status: 200,
  method: "POST",
  headers: { date: httpDate },
  ...overrides,
});

const domesticBody = `{"success":true,"systemTime":"${systemTime}","content":{"depositData":{"queryStatus":"Success","totalAccountBalance":9999.99,"totalAvaliableBalance":8888.88,"datas":[{"accountType":"DemandDeposit","accountNo":"0000123456789012","accountName":"fixture domestic","accountNickName":"fixture","accountBalance":1000.00,"avaliableBalance":900.25,"datas":[]}]},"timeDepositData":[{"accountNo":"0000999999999999","accountBalance":999999.99}]}}`;

const domestic = parseCathayCurrentDepositBalanceSnapshot({
  kind: "domestic",
  response: response("domestic"),
  rawBody: domesticBody,
  observedAt,
  uiAccountNumbers: ["123456789012"],
  financialAuthority: {
    sourceConnectionKey: "sha256:cathay-connection",
    identityEpochKey: "cathay-epoch-v1",
    authorityClass: "authenticated-current-state",
  },
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
assert.deepEqual(domesticRow.financialAuthority, {
  sourceConnectionKey: "sha256:cathay-connection",
  identityEpochKey: "cathay-epoch-v1",
  authorityClass: "authenticated-current-state",
});

const foreignBody = `{"success":true,"systemTime":"${systemTime}","content":{"isGetDemandAccountSuccess":true,"demandAccounts":[{"account":"123456789012","nickName":null,"demandType":"DemandDeposit","status":"Normal","details":[{"currencyId":"02","currencyCode":"USD","currency":"美元","balance":10.00,"equalTwdBalance":320.00,"dueDate":null},{"currencyId":"16","currencyCode":"JPY","currency":"日幣","balance":2000,"equalTwdBalance":450.00,"dueDate":null}]}],"depositAccounts":[{"account":"ignored-deposit-account"}]}}`;

const foreign = parseCathayCurrentDepositBalanceSnapshot({
  kind: "foreign",
  response: response("foreign"),
  rawBody: foreignBody,
  observedAt,
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
      accountNumber: "123456789012",
      currency: "USD",
      sourceCode: "USD",
      ledger: { coefficient: "1000", scale: 2, sourceLexeme: "10.00" },
      observationKinds: ["ledger"],
    },
    {
      sourceAccountKey: "123456789012",
      accountNumber: "123456789012",
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
  observedAt,
  uiAccountNumbers: ["123456789012"],
};

assert.throws(
  () =>
    parseCathayCurrentDepositBalanceSnapshot({
      ...domesticInput,
      response: response("domestic", {
        url: "https://evil.example/OnlineBankingApi/ClientBank/Api/ClientBank/B_ACCT_Q_DepositOverview",
      }),
    }),
  /host is unexpected/u,
);
assert.throws(
  () =>
    parseCathayCurrentDepositBalanceSnapshot({
      ...domesticInput,
      response: response("domestic", { status: 204 }),
    }),
  /status is 204/u,
);
assert.throws(
  () =>
    parseCathayCurrentDepositBalanceSnapshot({
      ...domesticInput,
      response: response("domestic", { method: "GET" }),
    }),
  /method is not POST/u,
);
assert.throws(
  () =>
    parseCathayCurrentDepositBalanceSnapshot({
      ...domesticInput,
      response: response("domestic", { method: undefined }),
    }),
  /method is not POST/u,
);
assert.throws(
  () =>
    parseCathayCurrentDepositBalanceSnapshot({
      ...domesticInput,
      response: response("domestic", {
        headers: { date: "Tue, 08 Sep 2026 13:20:04 +0000" },
      }),
    }),
  /HTTP Date is invalid/u,
);
assert.throws(
  () =>
    parseCathayCurrentDepositBalanceSnapshot({
      ...domesticInput,
      response: response("domestic", { headers: {} }),
    }),
  /HTTP Date is invalid/u,
);
assert.throws(
  () =>
    parseCathayCurrentDepositBalanceSnapshot({
      ...domesticInput,
      observedAt: "2026-02-30T21:20:10+08:00",
    }),
  /observedAt has an invalid calendar date/u,
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
  observedAt,
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

const source = await readFile(
  new URL("./cathay-current-deposit-balances.ts", import.meta.url),
  "utf8",
);
assert.match(source, /waitForResponse/u);
assert.match(source, /臺幣帳戶總覽/u);
assert.match(source, /外幣帳戶總覽/u);
assert.match(source, /R0101_FDepInq/u);
assert.match(source, /response\.text\(\)/u);
assert.doesNotMatch(source, /\bfetch\s*\(/u);
assert.doesNotMatch(source, /click\(\{\s*force:/u);

console.log("cathay-current-deposit-balances.check passed");
