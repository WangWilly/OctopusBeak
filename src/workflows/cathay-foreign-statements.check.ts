import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import {
  admitForeignCurrencyDepositCapture,
} from "../ledger/canonical/foreign-currency-deposit-admission.ts";
import { matchCurrentBalanceCaptures } from "./current-balance-capture-match.ts";
import {
  CATHAY_CURRENT_FOREIGN_ENDPOINT_PATH,
  parseCathayCurrentDepositBalanceSnapshot,
} from "./cathay-current-deposit-balances.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./cathay-statements.js")
      return nextResolve("./cathay-statements.ts", context);
    return nextResolve(specifier, context);
  },
});

// The run's collection period reaches the builder as explicit dates, so the
// historical fixture stays inside its range whatever day the check runs.
const oneWeek = { startDate: "2026-08-17", endDate: "2026-08-24" };

const {
  buildCathayForeignCurrencyCaptureInput,
  cathayForeignCurrentBalanceCaptureMatching,
  collectCathayCurrentForeignDepositBalanceCaptures,
  createCathayForeignCanonicalCaptureCollector,
  deriveCathayForeignAccountNumberEvidence,
  parseCathayApiJson,
} = await import("./cathay-foreign-statements.ts");

const capture = buildCathayForeignCurrencyCaptureInput(
  { account: "CATHAY-FOREIGN-133" },
  "USD",
  oneWeek,
  {
    currencyCode: "USD",
    transferInfos: [
      {
        sequenceNumber: "1",
        transferDate: "2026-08-23",
        debitCreditType: "C",
        amount: "10.00",
        balance: "110.00",
        exRate: "31.50",
        memo: "foreign deposit",
      },
    ],
  },
  "2026-08-24T12:00:00+08:00",
  "cathay-foreign-check-observation-1",
);

assert.equal(capture.accountType, "depository");
assert.equal(capture.accountNo, "CATHAY-FOREIGN-133");
assert.equal(capture.accountNumber, null);
assert.equal(capture.records[0]!.currencyEvidence.currency, "USD");
assert.equal(capture.records[0]!.sourceReportedRate?.baseCurrency, "USD");
assert.equal(capture.records[0]!.sourceReportedRate?.quoteCurrency, "TWD");
assert.equal(capture.records[0]!.sourceReportedRate?.rate, "31.50");
assert.deepEqual(
  admitForeignCurrencyDepositCapture(capture).records[0]!.conversionEvidence
    ?.sourceReportedRate?.amount,
  { coefficient: "315", scale: 1 },
);

// The observed transfer endpoint shape carries numeric JSON tokens in
// content.transferDetails[].transferInfos[].  Parsing those tokens with the
// ordinary JSON parser loses lexical zeroes before canonical admission.
const observedNumericCathayResponse = parseCathayApiJson<{
  content: {
    transferDetails: Array<{
      currencyCode: string;
      transferInfos: Array<Record<string, unknown>>;
    }>;
  };
}>(
  '{"success":true,"content":{"transferDetails":[{"currencyCode":"USD","transferInfos":[{"sequenceNumber":"1","transferDate":"2026-08-23","debitCreditType":"C","amount":10.00,"balance":110.00,"exRate":31.50}]}]}}',
  );
assert.equal(
  observedNumericCathayResponse.content.transferDetails[0]!.transferInfos[0]!
    .amount,
  "10.00",
);
assert.equal(
  observedNumericCathayResponse.content.transferDetails[0]!.transferInfos[0]!
    .balance,
  "110.00",
);
assert.equal(
  observedNumericCathayResponse.content.transferDetails[0]!.transferInfos[0]!
    .exRate,
  "31.50",
);
const numericJsonCapture = buildCathayForeignCurrencyCaptureInput(
  { account: "CATHAY-FOREIGN-133" },
  "USD",
  oneWeek,
  observedNumericCathayResponse.content.transferDetails[0]!,
  "2026-08-24T12:00:00+08:00",
  "cathay-foreign-check-numeric-json",
);
assert.equal(numericJsonCapture.records[0]!.amount, "10.00");
assert.deepEqual(
  admitForeignCurrencyDepositCapture(numericJsonCapture).records[0]!
    .conversionEvidence?.sourceReportedRate?.amount,
  { coefficient: "315", scale: 1 },
);
const collector = createCathayForeignCanonicalCaptureCollector(
  oneWeek,
  "00000000-0000-4000-8000-000000000133",
  () => "2026-08-24T12:00:00+08:00",
);
const syntheticCathayForeignAccountNumber = ["0012", "3456", "7890"].join("");
collector.onStatement(
  { account: syntheticCathayForeignAccountNumber },
  "USD",
  {
    currencyCode: "USD",
    transferInfos: [
      {
        sequenceNumber: "1",
        transferDate: "2026-08-23",
        debitCreditType: "C",
        amount: "10.00",
        balance: "110.00",
        exRate: "31.50",
      },
    ],
  },
);
assert.equal(collector.captures.length, 1);
assert.deepEqual(collector.captures[0]!.accountNumber, {
  value: syntheticCathayForeignAccountNumber,
  kind: "depository-account",
  evidenceVersion: "cathay/foreign-account/account-number-v1",
  sourceField: "R_ACCT_Q_DetailAccount content.detailAccounts[].account",
});
assert.equal(
  collector.captures[0]!.captureOccurrenceId,
  "00000000-0000-4000-8000-000000000133:USD",
);
assert.deepEqual(deriveCathayForeignAccountNumberEvidence("００１２３４５６７８９０"), {
  value: syntheticCathayForeignAccountNumber,
  kind: "depository-account",
  evidenceVersion: "cathay/foreign-account/account-number-v1",
  sourceField: "R_ACCT_Q_DetailAccount content.detailAccounts[].account",
});
assert.equal(deriveCathayForeignAccountNumberEvidence("****7890"), null);
collector.reset();
assert.equal(collector.captures.length, 0);

const freshForeignRows = parseCathayCurrentDepositBalanceSnapshot({
  kind: "foreign",
  response: {
    url: `https://www.cathaybk.com.tw${CATHAY_CURRENT_FOREIGN_ENDPOINT_PATH}`,
    status: 200,
    method: "POST",
    headers: { date: "Mon, 24 Aug 2026 12:00:00 GMT" },
  },
  rawBody:
    `{"success":true,"systemTime":"2026-08-24T20:00:00.0000000+08:00","content":{"isGetDemandAccountSuccess":true,"demandAccounts":[{"account":"${syntheticCathayForeignAccountNumber}","demandType":"DemandDeposit","status":"Normal","details":[{"currencyCode":"USD","balance":10.00,"equalTwdBalance":320.00}]}]}}`,
  observedAt: "2026-08-24T20:00:05.000+08:00",
});
assert.equal(freshForeignRows.length, 1);
assert.equal(freshForeignRows[0]!.sourceAccountKey, syntheticCathayForeignAccountNumber);

{
  const foreignCaptureFor = (account: string, occurrence: string) =>
    buildCathayForeignCurrencyCaptureInput(
      { account },
      "USD",
      oneWeek,
      {
        currencyCode: "USD",
        transferInfos: [{
          sequenceNumber: "1",
          transferDate: "2026-08-23",
          debitCreditType: "C",
          amount: "10.00",
          balance: "10.00",
        }],
      },
      "2026-08-24T12:00:00+08:00",
      occurrence,
    );
  const admittedCapture = foreignCaptureFor(syntheticCathayForeignAccountNumber, "cathay-foreign-check-current-1");
  const unadmittedRow = { ...freshForeignRows[0]!, sourceAccountKey: "CATHAY-FOREIGN-UNADMITTED" };
  const collectCurrent = (
    captures: Parameters<typeof collectCathayCurrentForeignDepositBalanceCaptures>[1],
    rows: typeof freshForeignRows,
  ) => collectCathayCurrentForeignDepositBalanceCaptures({} as never, captures, {
    readCurrentDepositBalances: async () => rows,
  });

  const current = await collectCurrent([admittedCapture], [unadmittedRow, freshForeignRows[0]!]);
  assert.deepEqual(
    current.map((entry) => entry.identity.sourceAccountKey),
    [syntheticCathayForeignAccountNumber],
    "a row for an account the run did not admit is skipped silently",
  );
  await assert.rejects(
    collectCurrent([admittedCapture], [unadmittedRow]),
    /^Error: Cathay current foreign balance response did not contain an admitted account\.$/u,
  );
  await assert.rejects(
    collectCurrent(
      [admittedCapture, foreignCaptureFor("CATHAY-FOREIGN-133", "cathay-foreign-check-current-2")],
      [freshForeignRows[0]!],
    ),
    /^Error: Cathay current foreign balance response omitted an admitted account\.$/u,
  );

  const identity = {
    accountNo: syntheticCathayForeignAccountNumber,
    sourceConnectionKey: "sha256:cathay-connection",
    identityEpochKey: "sha256:cathay-epoch",
    subjectDigest: "sha256:cathay-subject-first",
  };
  const lastIdentity = { ...identity, subjectDigest: "sha256:cathay-subject-last" };
  assert.deepEqual(
    matchCurrentBalanceCaptures(
      [freshForeignRows[0]!],
      [identity, lastIdentity],
      cathayForeignCurrentBalanceCaptureMatching,
    ).matched.map(({ capture }) => capture),
    [lastIdentity],
    "the last admitted identity for an account wins without an ambiguity check",
  );
}

for (const missingOccurrence of [undefined, "   "] as const) {
  assert.throws(
    () =>
      buildCathayForeignCurrencyCaptureInput(
        { account: "CATHAY-FOREIGN-133" },
        "USD",
        oneWeek,
        {
          currencyCode: "USD",
          transferInfos: [{
            sequenceNumber: "missing-occurrence",
            transferDate: "2026-08-23",
            debitCreditType: "C",
            amount: "10.00",
            balance: "110.00",
          }],
        },
        "2026-08-24T12:00:00+08:00",
        missingOccurrence,
      ),
    /capture occurrence identity/i,
  );
}
assert.throws(
  () =>
    buildCathayForeignCurrencyCaptureInput(
      { account: "CATHAY-FOREIGN-133" },
      "USD",
      oneWeek,
      {
        currencyCode: "USD",
        transferInfos: [
          {
            sequenceNumber: 9007199254740993,
            transferDate: "2026-08-23",
            debitCreditType: "C",
            amount: "10.00",
            balance: "110.00",
          },
        ],
      },
      "2026-08-24T12:00:00+08:00",
      "cathay-foreign-check-unsafe-sequence",
    ),
  /sequence.*(safe|exact)|safe.*sequence/i,
);
assert.throws(
  () =>
    buildCathayForeignCurrencyCaptureInput(
      { account: "CATHAY-FOREIGN-133" },
      "USD",
      oneWeek,
      {
        currencyCode: "USD",
        transferInfos: [
          {
            sequenceNumber: "2",
            transferDate: "2026-08-23",
            debitCreditType: "C",
            amount: 10,
            balance: "110.00",
          },
        ],
      },
      "2026-08-24T12:00:00+08:00",
      "cathay-foreign-check-observation-invalid",
    ),
  /exact decimal string/i,
);
assert.throws(
  () =>
    buildCathayForeignCurrencyCaptureInput(
      { account: "CATHAY-FOREIGN-133" },
      "USD",
      oneWeek,
      {
        currencyCode: "USD",
        transferInfos: [
          {
            sequenceNumber: "3",
            transferDate: "2026-08-23",
            debitCreditType: "C",
            amount: "1,2",
            balance: "110.00",
          },
        ],
      },
      "2026-08-24T12:00:00+08:00",
      "cathay-foreign-check-invalid-grouping",
    ),
  /exact decimal/i,
);

const emptyCathayCapture = buildCathayForeignCurrencyCaptureInput(
  { account: "CATHAY-FOREIGN-EMPTY-133" },
  "USD",
  oneWeek,
  { currencyCode: "USD", transferInfos: [] },
  "2026-08-24T12:00:00+08:00",
  "cathay-foreign-check-empty-observation",
  "provider-explicit-no-data",
);
assert.equal(emptyCathayCapture.zeroResultAuthority, "provider-explicit-no-data");
assert.equal(emptyCathayCapture.records.length, 0);
assert.throws(
  () =>
    buildCathayForeignCurrencyCaptureInput(
      { account: "CATHAY-FOREIGN-AMBIGUOUS-133" },
      "USD",
      oneWeek,
      { currencyCode: "USD", transferInfos: [] },
      "2026-08-24T12:00:00+08:00",
      "cathay-foreign-check-ambiguous-empty",
    ),
  /no-data|empty|terminal/i,
);
