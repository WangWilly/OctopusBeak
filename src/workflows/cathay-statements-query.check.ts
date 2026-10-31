import assert from "node:assert/strict";
import { strictSourceText } from "../lib/automation/source-text.ts";
import { collectionPeriod, taipeiToday } from "../lib/automation/collection-period.ts";
import {
  CathayApiClient,
  type CathayDateTimeSuffixShape,
  classifyCathayRowDateShapes,
  classifyCathayDateScopeMismatch,
  cathayQueryPeriod,
  collectCathayDomesticFinancialRequests,
} from "./cathay-statements.ts";

const dateScopeTelemetry = classifyCathayDateScopeMismatch(
  { startDate: "2025-01-01", endDate: "2025-12-31" },
  [
    {
      startDate: "2025-01-02",
      endDate: "2025-12-31",
      details: [
        { privateDescription: "private-a" },
        { privateDescription: "private-b" },
      ],
    },
  ],
);
assert.deepEqual(dateScopeTelemetry, {
  pageCount: 1,
  rowCount: 2,
  startDateShape: "isoDate",
  endDateShape: "isoDate",
  startDateTimeSuffixShape: "other",
  endDateTimeSuffixShape: "other",
  startDayOffsets: [1],
  endDayOffsets: [0],
  relations: {
    exact: 0,
    excludesRequestStart: 1,
    excludesRequestEnd: 0,
    responseWithinRequest: 0,
    responseCoversRequest: 0,
    shifted: 0,
    invalid: 0,
  },
});
assert.doesNotMatch(
  JSON.stringify(dateScopeTelemetry),
  /2025-01-01|2025-01-02|2025-12-31|private-a|private-b/,
);

for (const [
  startDate,
  endDate,
  startDateShape,
  endDateShape,
  startDateTimeSuffixShape,
  endDateTimeSuffixShape,
] of [
  [undefined, undefined, "missing", "missing", "other", "other"],
  [42, false, "nonString", "nonString", "other", "other"],
  ["private-iso-date", "2025-01-02", "other", "isoDate", "other", "other"],
  [
    "20250102",
    "private-compact-date",
    "compactDate",
    "other",
    "other",
    "other",
  ],
  ["2025/01/02", "private-slash-date", "slashDate", "other", "other", "other"],
  [
    "2025-01-02T00:00:00Z",
    "private-date-time",
    "dateTimePrefix",
    "other",
    "tUtcSecond",
    "other",
  ],
  [
    "private-other-date",
    "private-other-end-date",
    "other",
    "other",
    "other",
    "other",
  ],
] as const) {
  const shapeTelemetry = classifyCathayDateScopeMismatch(
    { startDate: "2025-01-01", endDate: "2025-12-31" },
    [{ startDate: startDate as never, endDate: endDate as never }],
  );
  assert.equal(shapeTelemetry.startDateShape, startDateShape);
  assert.equal(shapeTelemetry.endDateShape, endDateShape);
  assert.equal(
    shapeTelemetry.startDateTimeSuffixShape,
    startDateTimeSuffixShape,
  );
  assert.equal(shapeTelemetry.endDateTimeSuffixShape, endDateTimeSuffixShape);
  assert.equal(shapeTelemetry.relations.invalid, 1);
  assert.doesNotMatch(
    JSON.stringify(shapeTelemetry),
    /private-iso-date|private-compact-date|private-slash-date|private-date-time|private-other-date|private-other-end-date/,
  );
}

const datetimePrefixTelemetry = classifyCathayDateScopeMismatch(
  { startDate: "2025-01-01", endDate: "2025-12-31" },
  [
    {
      startDate: "2025-01-01T00:00:00+08:00",
      endDate: "2025-12-31T23:59:59+08:00",
      details: [{ privateDescription: "private-datetime-row" }],
    },
  ],
);
assert.deepEqual(datetimePrefixTelemetry, {
  pageCount: 1,
  rowCount: 1,
  startDateShape: "dateTimePrefix",
  endDateShape: "dateTimePrefix",
  startDateTimeSuffixShape: "tNumericOffsetSecond",
  endDateTimeSuffixShape: "tNumericOffsetSecond",
  startDayOffsets: [],
  endDayOffsets: [],
  relations: {
    exact: 0,
    excludesRequestStart: 0,
    excludesRequestEnd: 0,
    responseWithinRequest: 0,
    responseCoversRequest: 0,
    shifted: 0,
    invalid: 1,
  },
});
assert.doesNotMatch(
  JSON.stringify(datetimePrefixTelemetry),
  /2025-01-01|2025-12-31|private-datetime-row/,
);

const localSecondMismatchTelemetry = classifyCathayDateScopeMismatch(
  { startDate: "2025-01-01", endDate: "2025-12-31" },
  [
    {
      startDate: "2025-01-02T00:00:00",
      endDate: "2025-12-31T23:59:59",
      details: [{ privateDescription: "private-local-second-row" }],
    },
  ],
);
assert.deepEqual(localSecondMismatchTelemetry, {
  pageCount: 1,
  rowCount: 1,
  startDateShape: "dateTimePrefix",
  endDateShape: "dateTimePrefix",
  startDateTimeSuffixShape: "tLocalSecond",
  endDateTimeSuffixShape: "tLocalSecond",
  startDayOffsets: [1],
  endDayOffsets: [0],
  relations: {
    exact: 0,
    excludesRequestStart: 1,
    excludesRequestEnd: 0,
    responseWithinRequest: 0,
    responseCoversRequest: 0,
    shifted: 0,
    invalid: 0,
  },
});
assert.doesNotMatch(
  JSON.stringify(localSecondMismatchTelemetry),
  /2025-01-02|2025-12-31|private-local-second-row/,
);

const accountDateShapeRows = [
  { accountDate: undefined, txnDateTime: "2025-01-01T00:00:00" },
  { accountDate: 42, txnDateTime: "2025-01-01T00:00:00" },
  { accountDate: "2025-01-01", txnDateTime: "2025-01-01T00:00:00" },
  { accountDate: "2025-02-30", txnDateTime: "2025-01-01T00:00:00" },
  { accountDate: "20250101", txnDateTime: "2025-01-01T00:00:00" },
  { accountDate: "2025/01/01", txnDateTime: "2025-01-01T00:00:00" },
  {
    accountDate: "2025-01-01T00:00:00",
    txnDateTime: "2025-01-01T00:00:00",
  },
  { accountDate: " 2025-01-01", txnDateTime: "2025-01-01T00:00:00" },
  {
    accountDate: "private-account-date",
    txnDateTime: "2025-01-01T00:00:00",
  },
];
const accountDateShapeTelemetry = classifyCathayRowDateShapes([
  { details: accountDateShapeRows },
]);
assert.equal(accountDateShapeTelemetry.rowCount, 9);
assert.deepEqual(accountDateShapeTelemetry.accountDateShapes, {
  missing: 1,
  nonString: 1,
  isoDate: 1,
  isoDateInvalidCalendar: 1,
  compactDate: 1,
  slashDate: 1,
  dateTimePrefix: 1,
  whitespaceWrapped: 1,
  other: 1,
});
assert.deepEqual(accountDateShapeTelemetry.accountDateTimeSuffixShapeCounts, {
  tLocalMinute: 0,
  tLocalSecond: 1,
  tLocalFractionalSecond: 0,
  tUtcMinute: 0,
  tUtcSecond: 0,
  tUtcFractionalSecond: 0,
  tNumericOffsetMinute: 0,
  tNumericOffsetSecond: 0,
  tNumericOffsetFractionalSecond: 0,
  spaceLocalMinute: 0,
  spaceLocalSecond: 0,
  spaceLocalFractionalSecond: 0,
  spaceUtcMinute: 0,
  spaceUtcSecond: 0,
  spaceUtcFractionalSecond: 0,
  spaceNumericOffsetMinute: 0,
  spaceNumericOffsetSecond: 0,
  spaceNumericOffsetFractionalSecond: 0,
  malformed: 0,
  other: 0,
});
assert.equal(accountDateShapeTelemetry.txnDateTimeShapes.tLocalSecond, 9);
assert.doesNotMatch(
  JSON.stringify(accountDateShapeTelemetry),
  /private-account-date|2025-01-01|2025-02-30/,
);

const transactionDateTimeShapeCases = [
  [undefined, "missing"],
  [42, "nonString"],
  ["2025-02-30T00:00:00", "invalidCalendarOrTime"],
  ["2025-01-01T00:00", "tLocalMinute"],
  ["2025-01-01T00:00:00", "tLocalSecond"],
  ["2025-01-01T00:00:00.000", "tLocalFractionalSecond"],
  ["2025-01-01T00:00Z", "tUtcMinute"],
  ["2025-01-01T00:00:00Z", "tUtcSecond"],
  ["2025-01-01T00:00:00.000Z", "tUtcFractionalSecond"],
  ["2025-01-01T00:00+08:00", "tNumericOffsetMinute"],
  ["2025-01-01T00:00:00+08:00", "tNumericOffsetSecond"],
  ["2025-01-01T00:00:00.000+08:00", "tNumericOffsetFractionalSecond"],
  ["2025-01-01 00:00", "spaceLocalMinute"],
  ["2025-01-01 00:00:00", "spaceLocalSecond"],
  ["2025-01-01 00:00:00.000", "spaceLocalFractionalSecond"],
  ["2025-01-01 00:00Z", "spaceUtcMinute"],
  ["2025-01-01 00:00:00Z", "spaceUtcSecond"],
  ["2025-01-01 00:00:00.000Z", "spaceUtcFractionalSecond"],
  ["2025-01-01 00:00+08:00", "spaceNumericOffsetMinute"],
  ["2025-01-01 00:00:00+08:00", "spaceNumericOffsetSecond"],
  ["2025-01-01 00:00:00.000+08:00", "spaceNumericOffsetFractionalSecond"],
  ["2025-01-01Tgarbage", "malformed"],
  ["private-transaction-date-time", "other"],
] as const;
const transactionDateTimeShapeTelemetry = classifyCathayRowDateShapes([
  {
    details: transactionDateTimeShapeCases.map(([txnDateTime]) => ({
      accountDate: "2025-01-01",
      txnDateTime,
    })),
  },
]);
assert.equal(
  transactionDateTimeShapeTelemetry.rowCount,
  transactionDateTimeShapeCases.length,
);
for (const [, expectedShape] of transactionDateTimeShapeCases) {
  assert.equal(
    transactionDateTimeShapeTelemetry.txnDateTimeShapes[expectedShape],
    1,
  );
}
assert.equal(
  transactionDateTimeShapeTelemetry.accountDateShapes.isoDate,
  transactionDateTimeShapeCases.length,
);
assert.equal(
  Object.values(
    transactionDateTimeShapeTelemetry.accountDateTimeSuffixShapeCounts,
  ).reduce((sum, count) => sum + count, 0),
  transactionDateTimeShapeTelemetry.accountDateShapes.dateTimePrefix,
);
assert.equal(
  transactionDateTimeShapeTelemetry.accountDateShapes.dateTimePrefix,
  0,
);
assert.doesNotMatch(
  JSON.stringify(transactionDateTimeShapeTelemetry),
  /private-transaction-date-time|2025-01-01|2025-02-30|Tgarbage/,
);

const accountDateTimeSuffixShapeCases: ReadonlyArray<
  readonly [unknown, CathayDateTimeSuffixShape]
> = transactionDateTimeShapeCases.filter(
  ([, expectedShape]) =>
    expectedShape !== "missing" &&
    expectedShape !== "nonString" &&
    expectedShape !== "invalidCalendarOrTime" &&
    expectedShape !== "other",
) as ReadonlyArray<readonly [unknown, CathayDateTimeSuffixShape]>;
const accountDateTimeSuffixShapeTelemetry = classifyCathayRowDateShapes([
  {
    details: accountDateTimeSuffixShapeCases.map(([accountDate]) => ({
      accountDate,
      txnDateTime: "2025-01-01T00:00:00",
    })),
  },
]);
assert.equal(
  accountDateTimeSuffixShapeTelemetry.accountDateShapes.dateTimePrefix,
  accountDateTimeSuffixShapeCases.length,
);
for (const [, expectedShape] of accountDateTimeSuffixShapeCases) {
  assert.equal(
    accountDateTimeSuffixShapeTelemetry.accountDateTimeSuffixShapeCounts[
      expectedShape
    ],
    1,
  );
}
assert.equal(
  accountDateTimeSuffixShapeTelemetry.accountDateTimeSuffixShapeCounts.other,
  0,
);
assert.equal(
  Object.values(
    accountDateTimeSuffixShapeTelemetry.accountDateTimeSuffixShapeCounts,
  ).reduce((sum, count) => sum + count, 0),
  accountDateTimeSuffixShapeTelemetry.accountDateShapes.dateTimePrefix,
);
assert.doesNotMatch(
  JSON.stringify(accountDateTimeSuffixShapeTelemetry),
  /2025-01-01|Tgarbage|private-/,
);

for (const [suffix, expected] of [
  ["T00:00", "tLocalMinute"],
  ["T00:00:00", "tLocalSecond"],
  ["T00:00:00.000", "tLocalFractionalSecond"],
  ["T00:00Z", "tUtcMinute"],
  ["T00:00:00Z", "tUtcSecond"],
  ["T00:00:00.000Z", "tUtcFractionalSecond"],
  ["T00:00+08:00", "tNumericOffsetMinute"],
  ["T00:00:00+08:00", "tNumericOffsetSecond"],
  ["T00:00:00.000+08:00", "tNumericOffsetFractionalSecond"],
  [" 00:00", "spaceLocalMinute"],
  [" 00:00:00", "spaceLocalSecond"],
  [" 00:00:00.000", "spaceLocalFractionalSecond"],
  [" 00:00Z", "spaceUtcMinute"],
  [" 00:00:00Z", "spaceUtcSecond"],
  [" 00:00:00.000Z", "spaceUtcFractionalSecond"],
  [" 00:00+08:00", "spaceNumericOffsetMinute"],
  [" 00:00:00+08:00", "spaceNumericOffsetSecond"],
  [" 00:00:00.000+08:00", "spaceNumericOffsetFractionalSecond"],
  ["Tgarbage", "malformed"],
  ["20250101", "other"],
] as const) {
  const suffixTelemetry = classifyCathayDateScopeMismatch(
    { startDate: "2025-01-01", endDate: "2025-12-31" },
    [{ startDate: `2025-01-01${suffix}`, endDate: "2025-12-31" }],
  );
  const admitted = expected === "tLocalSecond";
  assert.equal(suffixTelemetry.startDateTimeSuffixShape, expected);
  assert.deepEqual(suffixTelemetry.startDayOffsets, admitted ? [0] : []);
  assert.deepEqual(suffixTelemetry.endDayOffsets, admitted ? [0] : []);
  assert.equal(suffixTelemetry.relations.invalid, admitted ? 0 : 1);
  assert.equal(suffixTelemetry.relations.exact, admitted ? 1 : 0);
  assert.doesNotMatch(
    JSON.stringify(suffixTelemetry),
    /2025-01-01|2025-12-31|Tgarbage|20250101/,
  );
}

const directFirstAccount = {
  accountNo: "0001",
  currency: "TWD",
  branchName: "Synthetic branch 1",
};
const directSecondAccount = {
  accountNo: "20002",
  currency: "TWD",
  branchName: "Synthetic branch 2",
};

const injectedClientPage = new Proxy({}, {
  get(_target, property) {
    throw new Error(`Injected-client collection unexpectedly accessed page.${String(property)}.`);
  },
});
const expectedScope = {
  startDate: "2025-10-29",
  endDate: "2026-10-29",
};
const domesticPeriod = cathayQueryPeriod(
  collectionPeriod({
    today: "2026-10-29",
    lookBack: { years: 1, days: 1 },
  }),
);
assert.deepEqual(domesticPeriod, {
  option: "one_year",
  ...expectedScope,
});
function emptyTransferResponse(accountNo: string): string {
  return JSON.stringify({
    success: true,
    returnCode: "0000",
    content: {
      datas: [{
        queryStatus: "Success",
        accountNumber: accountNo,
        count: 0,
        ...expectedScope,
        details: [],
      }],
    },
  });
}

const requestedAccounts: string[] = [];
const directApiCollection = await collectCathayDomesticFinancialRequests(
  injectedClientPage as never,
  domesticPeriod,
  [],
  { jwtToken: "synthetic", customerId: "synthetic", idType: "id" },
  {
    client: {
      fetchDomesticAccounts: async () => [directFirstAccount, directSecondAccount],
      fetchTransferDetailsRaw: async (_session, accountNo, bounds) => {
        assert.deepEqual(bounds, expectedScope);
        requestedAccounts.push(accountNo);
        return emptyTransferResponse(accountNo);
      },
    },
  },
);
assert.deepEqual(requestedAccounts, ["0001", "20002"]);
assert.equal(directApiCollection.captureCount, 2);
assert.equal(directApiCollection.rowCount, 0);

const evaluatedRequests: unknown[] = [];
const apiOnlyPage = new Proxy(
  {
    evaluate: async (_callback: unknown, request: unknown) => {
      evaluatedRequests.push(request);
      return emptyTransferResponse("0001");
    },
  },
  {
    get(target, property, receiver) {
      if (property === "evaluate") return Reflect.get(target, property, receiver);
      throw new Error(`Cathay API client unexpectedly accessed page.${String(property)}.`);
    },
  },
);
const apiOnlyClient = new CathayApiClient(apiOnlyPage as never);
await apiOnlyClient.fetchTransferDetailsRaw(
  { jwtToken: "synthetic-token", customerId: "synthetic-customer", idType: "id" },
  "0001",
  expectedScope,
);
assert.deepEqual(evaluatedRequests, [{
  path: "/OnlineBankingApi/ClientBank/Api/ClientBank/B_ACCT_Q_TransferDetail",
  token: "synthetic-token",
  body: {
    functionSeqNo: (evaluatedRequests[0] as { body: { functionSeqNo: string } }).body.functionSeqNo,
    content: {
      customerId: "synthetic-customer",
      queryFilters: [{
        accountNumber: "0001",
        ...expectedScope,
      }],
    },
  },
}]);

const failedAccounts: string[] = [];
await assert.rejects(
  collectCathayDomesticFinancialRequests(
    injectedClientPage as never,
    domesticPeriod,
    [],
    { jwtToken: "synthetic", customerId: "synthetic", idType: "id" },
    {
      client: {
        fetchDomesticAccounts: async () => [directFirstAccount, directSecondAccount],
        fetchTransferDetailsRaw: async (_session, accountNo) => {
          failedAccounts.push(accountNo);
          if (accountNo === directSecondAccount.accountNo) {
            throw new Error("synthetic transfer failure");
          }
          return emptyTransferResponse(accountNo);
        },
      },
    },
  ),
  /synthetic transfer failure/,
);
assert.deepEqual(failedAccounts, ["0001", "20002"]);

const cancellation = new AbortController();
const cancellationReason = new Error("synthetic cancellation");
const cancelledAccounts: string[] = [];
await assert.rejects(
  collectCathayDomesticFinancialRequests(
    injectedClientPage as never,
    domesticPeriod,
    [],
    { jwtToken: "synthetic", customerId: "synthetic", idType: "id" },
    {
      source: { text: strictSourceText, signal: cancellation.signal },
      client: {
        fetchDomesticAccounts: async () => [directFirstAccount, directSecondAccount],
        fetchTransferDetailsRaw: async (_session, accountNo) => {
          cancelledAccounts.push(accountNo);
          cancellation.abort(cancellationReason);
          return emptyTransferResponse(accountNo);
        },
      },
    },
  ),
  (error) => error === cancellationReason,
);
assert.deepEqual(cancelledAccounts, ["0001"]);

const oneYearAndOneDay = { years: 1, days: 1 } as const;
assert.deepEqual(
  cathayQueryPeriod(
    collectionPeriod({
      today: taipeiToday("2028-02-28T16:30:00.000Z"),
      lookBack: oneYearAndOneDay,
    }),
  ),
  {
    option: "one_year",
    startDate: "2027-03-01",
    endDate: "2028-02-29",
  },
);
assert.deepEqual(
  cathayQueryPeriod(
    collectionPeriod({ today: "2028-03-01", lookBack: oneYearAndOneDay }),
  ),
  {
    option: "one_year",
    startDate: "2027-03-01",
    endDate: "2028-03-01",
  },
);
assert.deepEqual(
  cathayQueryPeriod(
    collectionPeriod({
      today: "2026-03-31",
      lookBack: { months: 1, days: 1 },
    }),
  ),
  {
    option: "one_month",
    startDate: "2026-02-28",
    endDate: "2026-03-31",
  },
  "a month back from Mar 31 clamps to Feb 28",
);
assert.throws(
  () =>
    cathayQueryPeriod(
      collectionPeriod({
        today: "2026-03-31",
        lookBack: { months: 2, days: 1 },
      }),
    ),
  /No Cathay period option/,
);
