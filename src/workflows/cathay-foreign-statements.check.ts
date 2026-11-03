import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import {
  admitForeignCurrencyDepositCapture,
} from "../ledger/canonical/foreign-currency-deposit-admission.ts";

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
