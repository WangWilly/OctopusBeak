import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { mock } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  admitForeignCurrencyDepositCapture,
} from "../ledger/canonical/foreign-currency-deposit.ts";
import { createCanonicalSourceStore } from "../ledger/canonical/canonical-source-store.ts";
import {
  CATHAY_CURRENT_FOREIGN_ENDPOINT_PATH,
  parseCathayCurrentDepositBalanceSnapshot,
} from "./cathay-current-deposit-balances.ts";
import { commitCathayCurrentDepositBalanceCaptures } from "./cathay-current-deposit-canonical.ts";

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

const {
  buildCathayForeignCurrencyCaptureInput,
  captureCathayCurrentForeignDepositBalances,
  commitCathayForeignCanonicalCaptures,
  createCathayForeignCanonicalCaptureCollector,
  deriveCathayForeignAccountNumberEvidence,
  parseCathayApiJson,
} = await import("./cathay-foreign-statements.ts");

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
  "one_week",
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
  "one_week",
  "00000000-0000-4000-8000-000000000133",
);
collector.onStatement(
  { account: "001234567890" },
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
  value: "001234567890",
  kind: "depository-account",
  evidenceVersion: "cathay/foreign-account/account-number-v1",
  sourceField: "R_ACCT_Q_DetailAccount content.detailAccounts[].account",
});
assert.equal(
  collector.captures[0]!.captureOccurrenceId,
  "00000000-0000-4000-8000-000000000133:USD",
);
assert.deepEqual(deriveCathayForeignAccountNumberEvidence("００１２３４５６７８９０"), {
  value: "001234567890",
  kind: "depository-account",
  evidenceVersion: "cathay/foreign-account/account-number-v1",
  sourceField: "R_ACCT_Q_DetailAccount content.detailAccounts[].account",
});
assert.equal(deriveCathayForeignAccountNumberEvidence("****7890"), null);
collector.reset();
assert.equal(collector.captures.length, 0);

const freshForeignCapture = buildCathayForeignCurrencyCaptureInput(
  { account: "001234567890" },
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
      },
    ],
  },
  "2026-08-24T20:00:00.000+08:00",
  "cathay-foreign-check-fresh-account",
);
const freshForeignRows = parseCathayCurrentDepositBalanceSnapshot({
  kind: "foreign",
  response: {
    url: `https://www.cathaybk.com.tw${CATHAY_CURRENT_FOREIGN_ENDPOINT_PATH}`,
    status: 200,
    method: "POST",
    headers: { date: "Mon, 24 Aug 2026 12:00:00 GMT" },
  },
  rawBody:
    '{"success":true,"systemTime":"2026-08-24T20:00:00.0000000+08:00","content":{"isGetDemandAccountSuccess":true,"demandAccounts":[{"account":"001234567890","demandType":"DemandDeposit","status":"Normal","details":[{"currencyCode":"USD","balance":10.00,"equalTwdBalance":320.00}]}]}}',
  observedAt: "2026-08-24T20:00:05.000+08:00",
});
const freshForeignLedgerDirectory = await mkdtemp(
  join(tmpdir(), "cathay-foreign-current-fresh-133-"),
);
try {
  const lifecycle: string[] = ["foreign-commit-start"];
  const [foreignCommit] = await commitCathayForeignCanonicalCaptures(
    freshForeignLedgerDirectory,
    [freshForeignCapture],
  );
  lifecycle.push("foreign-commit-complete");
  assert.equal(foreignCommit?.transactionCount, 1);
  const currentCommit = await captureCathayCurrentForeignDepositBalances(
    {} as never,
    [freshForeignCapture],
    freshForeignLedgerDirectory,
    {
      readCurrentDepositBalances: async () => {
        assert.equal(lifecycle.at(-1), "foreign-commit-complete");
        lifecycle.push("current-read");
        return freshForeignRows;
      },
      commitCurrentDepositBalances: async (ledgerDir, captures) => {
        assert.equal(lifecycle.at(-1), "current-read");
        lifecycle.push("current-commit");
        return commitCathayCurrentDepositBalanceCaptures(ledgerDir, captures);
      },
    },
  );
  assert.deepEqual(lifecycle, [
    "foreign-commit-start",
    "foreign-commit-complete",
    "current-read",
    "current-commit",
  ]);
  assert.equal(currentCommit[0]?.revisionCount, 1);
  assert.equal(currentCommit[0]?.observationCount, 1);
} finally {
  await rm(freshForeignLedgerDirectory, { recursive: true, force: true });
}

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
  const [result] = await commitCathayForeignCanonicalCaptures(
    cathayEmptyDirectory,
    [emptyCathayCapture],
  );
  assert.equal(result?.transactionCount, 0);
  const store = createCanonicalSourceStore(join(cathayEmptyDirectory, "canonical.sqlite"));
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
