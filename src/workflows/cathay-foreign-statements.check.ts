import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { admitForeignCurrencyDepositCapture } from "../ledger/canonical/foreign-currency-deposit.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./cathay-statements.js")
      return nextResolve("./cathay-statements.ts", context);
    return nextResolve(specifier, context);
  },
});

const { buildCathayForeignCurrencyCaptureInput } = await import(
  "./cathay-foreign-statements.ts"
);

const capture = buildCathayForeignCurrencyCaptureInput(
  { account: "CATHAY-FOREIGN-133" },
  "USD",
  "one_week",
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
);

assert.equal(capture.accountType, "depository");
assert.equal(capture.records[0]!.currencyEvidence.currency, "USD");
assert.equal(capture.records[0]!.sourceReportedRate?.baseCurrency, "USD");
assert.equal(capture.records[0]!.sourceReportedRate?.quoteCurrency, "TWD");
assert.equal(capture.records[0]!.sourceReportedRate?.rate, "31.50");
assert.deepEqual(
  admitForeignCurrencyDepositCapture(capture).records[0]!.conversionEvidence
    ?.sourceReportedRate?.amount,
  { coefficient: "315", scale: 1 },
);
assert.throws(
  () =>
    buildCathayForeignCurrencyCaptureInput(
      { account: "CATHAY-FOREIGN-133" },
      "USD",
      "one_week",
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
    ),
  /exact decimal string/i,
);
