import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { mock } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  admitForeignCurrencyDepositCapture,
  commitForeignCurrencyDepositCapture,
} from "../ledger/canonical/foreign-currency-deposit.ts";
import { createCanonicalSourceStore } from "../ledger/canonical/canonical-source-store.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./cathay-statements.js")
      return nextResolve("./cathay-statements.ts", context);
    return nextResolve(specifier, context);
  },
});

// Keep the historical fixture inside the one-week provider scope regardless
// of the day the check runs.  The production builder intentionally derives
// its range from the current clock, so the check supplies an explicit as-of
// date instead of allowing the fixture to age out of the scope.
mock.timers.enable({
  apis: ["Date"],
  now: new Date("2026-08-24T12:00:00.000Z"),
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
  "cathay-foreign-check-observation-1",
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
for (const missingOccurrence of [undefined, "   "] as const) {
  assert.throws(
    () =>
      buildCathayForeignCurrencyCaptureInput(
        { account: "CATHAY-FOREIGN-133" },
        "USD",
        "one_week",
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
      "one_week",
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
      "cathay-foreign-check-observation-invalid",
    ),
  /exact decimal string/i,
);

const emptyCathayCapture = buildCathayForeignCurrencyCaptureInput(
  { account: "CATHAY-FOREIGN-EMPTY-133" },
  "USD",
  "one_week",
  { currencyCode: "USD", transferInfos: [] },
  "2026-08-24T12:00:00+08:00",
  "cathay-foreign-check-empty-observation",
  "provider-explicit-no-data",
);
assert.throws(
  () =>
    buildCathayForeignCurrencyCaptureInput(
      { account: "CATHAY-FOREIGN-AMBIGUOUS-133" },
      "USD",
      "one_week",
      { currencyCode: "USD", transferInfos: [] },
      "2026-08-24T12:00:00+08:00",
      "cathay-foreign-check-ambiguous-empty",
    ),
  /no-data|empty|terminal/i,
);
const cathayEmptyDirectory = await mkdtemp(join(tmpdir(), "cathay-foreign-empty-133-"));
try {
  const store = createCanonicalSourceStore(join(cathayEmptyDirectory, "canonical.sqlite"));
  const result = await commitForeignCurrencyDepositCapture(
    store,
    admitForeignCurrencyDepositCapture(emptyCathayCapture),
  );
  assert.equal(result.transactionCount, 0);
  assert.equal(
    Number((store.db.prepare("SELECT COUNT(*) AS count FROM source_captures").get() as { count?: number }).count ?? 0),
    1,
  );
  assert.equal(
    Number((store.db.prepare("SELECT COUNT(*) AS count FROM source_sync_states").get() as { count?: number }).count ?? 0),
    1,
  );
  store.close();
} finally {
  await rm(cathayEmptyDirectory, { recursive: true, force: true });
}

mock.timers.reset();
