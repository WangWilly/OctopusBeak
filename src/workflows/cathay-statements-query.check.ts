import assert from "node:assert/strict";
import {
  CathayDomesticAccountAbsentError,
  type CathayDateTimeSuffixShape,
  classifyCathayDomesticAccountScope,
  classifyCathayRowDateShapes,
  classifyCathayDateScopeMismatch,
  downloadCathayStatements,
  prepareCathayDomesticStatementQuery,
  resolveCathayDomesticQueryPlan,
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

const structuralScopeTelemetry = classifyCathayDomesticAccountScope(
  [
    { accountNo: "0001" },
    { accountNo: "20002" },
    { accountNo: "0003" },
    { accountNo: "0004" },
  ],
  [
    "請選擇",
    "活期存款 0001",
    "活期存款 ****0002",
    "活期存款 00003",
    "活期存款 9999",
    "另一個顯示項目 0001",
  ],
);
assert.deepEqual(structuralScopeTelemetry, {
  providerAccountCount: 4,
  uiNonPlaceholderOptionCount: 5,
  matchClasses: {
    exact: 2,
    suffix: 1,
    masked: 1,
    singletonUnique: 0,
    unmatched: 2,
    duplicates: 1,
  },
});
const serializedStructuralScopeTelemetry = JSON.stringify(
  structuralScopeTelemetry,
);
for (const privateFixtureToken of [
  "0001",
  "20002",
  "0003",
  "0004",
  "9999",
  "活期存款",
  "另一個顯示項目",
]) {
  assert.doesNotMatch(
    serializedStructuralScopeTelemetry,
    new RegExp(privateFixtureToken),
  );
}

const firstAccount = {
  accountNo: "0001",
  currency: "TWD",
  branchName: "Synthetic branch 1",
};
const secondAccount = {
  accountNo: "20002",
  currency: "TWD",
  branchName: "Synthetic branch 2",
};

assert.deepEqual(
  resolveCathayDomesticQueryPlan(
    [firstAccount, secondAccount],
    ["請選擇", "活期存款 20002", "活期存款 0001"],
    ["請選擇", "最近一個月", "最近一年"],
    "one_year",
  ),
  { accountOptionIndexes: [1, 2], dateOptionIndex: 2 },
);

assert.deepEqual(
  resolveCathayDomesticQueryPlan(
    [firstAccount],
    ["請選擇", "Synthetic provider display alias without an identifier"],
    ["請選擇", "最近一年"],
    "one_year",
  ),
  { accountOptionIndexes: [1], dateOptionIndex: 1 },
);
assert.deepEqual(
  classifyCathayDomesticAccountScope(
    [firstAccount],
    ["請選擇", "Synthetic provider display alias without an identifier"],
  ),
  {
    providerAccountCount: 1,
    uiNonPlaceholderOptionCount: 1,
    matchClasses: {
      exact: 0,
      suffix: 0,
      masked: 0,
      singletonUnique: 1,
      unmatched: 0,
      duplicates: 0,
    },
  },
);

for (const [accounts, accountOptionTexts] of [
  [
    [firstAccount],
    [
      "請選擇",
      "Synthetic unmatched display alias A",
      "Synthetic unmatched display alias B",
    ],
  ],
  [
    [firstAccount, secondAccount],
    ["請選擇", "Synthetic unmatched display alias A"],
  ],
  [
    [firstAccount, secondAccount],
    [
      "請選擇",
      "Synthetic unmatched display alias A",
      "Synthetic unmatched display alias B",
    ],
  ],
  [
    [firstAccount, secondAccount],
    ["請選擇", "活期存款 0001", "Synthetic unmatched display alias B"],
  ],
  [
    [firstAccount, secondAccount],
    ["請選擇", "活期存款 ****0001", "Synthetic unmatched display alias B"],
  ],
] as const) {
  assert.throws(
    () =>
      resolveCathayDomesticQueryPlan(
        [...accounts],
        accountOptionTexts,
        ["請選擇", "最近一年"],
        "one_year",
      ),
    /account scope does not match/,
  );
}

assert.throws(
  () =>
    resolveCathayDomesticQueryPlan(
      [{ accountNo: "1111" }, { accountNo: "221111" }],
      ["請選擇", "顯示帳戶 1111", "Synthetic unmatched display alias"],
      ["請選擇", "最近一年"],
      "one_year",
    ),
  /ambiguous/,
);

assert.throws(
  () =>
    resolveCathayDomesticQueryPlan(
      [firstAccount],
      ["請選擇"],
      ["請選擇", "最近一年"],
      "one_year",
    ),
  CathayDomesticAccountAbsentError,
);
assert.throws(
  () =>
    resolveCathayDomesticQueryPlan(
      [firstAccount],
      ["請選擇", "活期存款 0001"],
      ["請選擇", "最近一個月"],
      "one_year",
    ),
  /period is not supported/,
);
assert.throws(
  () =>
    resolveCathayDomesticQueryPlan(
      [firstAccount],
      ["請選擇", "活期存款 0001"],
      ["請選擇", "最近一年", "一年"],
      "one_year",
    ),
  /period is ambiguous/,
);
assert.throws(
  () =>
    resolveCathayDomesticQueryPlan(
      [firstAccount],
      ["請選擇", "活期存款 0001", "活期存款 20002"],
      ["請選擇", "最近一年"],
      "one_year",
    ),
  /account scope does not match/,
);

const oneAccountOption = ["請選擇", "活期存款 0001"];
for (const [dateRange, supportedLabels] of [
  ["one_week", ["最近一週", "近 1 週"]],
  ["one_month", ["最近一個月", "近 1 個 月"]],
  ["three_months", ["最近三個月", "近 3 個 月"]],
  ["six_months", ["最近六個月", "近 6 個 月"]],
  ["one_year", ["最近一年", "近 1 年"]],
] as const) {
  for (const supportedLabel of supportedLabels) {
    assert.deepEqual(
      resolveCathayDomesticQueryPlan(
        [firstAccount],
        oneAccountOption,
        ["請選擇", supportedLabel],
        dateRange,
      ),
      { accountOptionIndexes: [1], dateOptionIndex: 1 },
    );
  }
}

for (const [dateRange, wrongQuantityLabel] of [
  ["one_week", "最近兩週"],
  ["one_month", "最近三個月"],
  ["three_months", "最近六個月"],
  ["six_months", "最近三個月"],
  ["one_year", "最近三年"],
] as const) {
  assert.throws(
    () =>
      resolveCathayDomesticQueryPlan(
        [firstAccount],
        oneAccountOption,
        ["請選擇", wrongQuantityLabel],
        dateRange,
      ),
    /period is not supported/,
  );
}

type OptionSet = { texts: string[]; selected: number[] };
const accountOptions: OptionSet = {
  texts: ["請選擇", "活期存款 20002", "活期存款 0001"],
  selected: [],
};
const periodOptions: OptionSet = {
  texts: ["請選擇", "最近一個月", "最近一年"],
  selected: [],
};
let openOptions: OptionSet | null = null;
let queryCount = 0;
const controlInteractions: string[] = [];

function optionLocator(options: OptionSet) {
  return {
    first: () => ({ waitFor: async () => undefined }),
    allTextContents: async () => options.texts,
    nth: (index: number) => ({
      click: async () => {
        options.selected.push(index);
        openOptions = null;
      },
    }),
  };
}

function comboLocator(options: OptionSet, label: string) {
  return {
    click: async () => {
      throw new Error("synthetic React Select dummy input is outside viewport");
    },
    locator: (selector: string) => {
      assert.equal(selector, "..");
      return {
        waitFor: async () => controlInteractions.push(`${label}:wait`),
        scrollIntoViewIfNeeded: async () =>
          controlInteractions.push(`${label}:scroll`),
        click: async () => {
          controlInteractions.push(`${label}:click`);
          openOptions = options;
        },
      };
    },
  };
}

const comboboxes = [
  comboLocator(accountOptions, "account"),
  comboLocator(periodOptions, "period"),
];
const page = {
  locator: (selector: string) => {
    if (selector === '[role="combobox"]') {
      return {
        count: async () => comboboxes.length,
        nth: (index: number) => comboboxes[index],
      };
    }
    if (selector === '[role="listbox"] [role="option"]') {
      if (!openOptions) throw new Error("No Cathay query options are open.");
      return optionLocator(openOptions);
    }
    if (selector === "table") {
      return { first: () => ({ isVisible: async () => queryCount > 0 }) };
    }
    throw new Error(`Unexpected locator: ${selector}`);
  },
  getByRole: () => ({
    count: async () => 1,
    click: async () => {
      queryCount += 1;
    },
  }),
  getByText: () => ({ first: () => ({ isVisible: async () => false }) }),
  keyboard: {
    press: async () => {
      openOptions = null;
    },
  },
  waitForTimeout: async () => undefined,
};

await prepareCathayDomesticStatementQuery(
  page as never,
  [firstAccount, secondAccount],
  "one_year",
);
assert.deepEqual(accountOptions.selected, [1, 2]);
assert.deepEqual(periodOptions.selected, [2, 2]);
assert.equal(queryCount, 2);
assert.deepEqual(controlInteractions, [
  "account:wait",
  "account:scroll",
  "account:click",
  "period:wait",
  "period:scroll",
  "period:click",
  "account:wait",
  "account:scroll",
  "account:click",
  "period:wait",
  "period:scroll",
  "period:click",
  "account:wait",
  "account:scroll",
  "account:click",
  "period:wait",
  "period:scroll",
  "period:click",
]);

let emittedScopeTelemetry: unknown = null;
const originalWarn = console.warn;
console.warn = (label: unknown, payload: unknown) => {
  if (label === "cathay-domestic-account-scope-telemetry") {
    emittedScopeTelemetry = payload;
  }
};
try {
  await assert.rejects(
    () =>
      prepareCathayDomesticStatementQuery(
        page as never,
        [firstAccount],
        "one_year",
      ),
    /account scope does not match/,
  );
} finally {
  console.warn = originalWarn;
}
assert.deepEqual(emittedScopeTelemetry, {
  providerAccountCount: 1,
  uiNonPlaceholderOptionCount: 2,
  matchClasses: {
    exact: 1,
    suffix: 0,
    masked: 0,
    singletonUnique: 0,
    unmatched: 1,
    duplicates: 0,
  },
});
assert.doesNotMatch(
  JSON.stringify(emittedScopeTelemetry),
  /0001|20002|活期存款/,
);

function delayedDomesticQueryPage(
  initialUrl: string,
  options: {
    controlsAvailable?: boolean;
    interactiveControlsAvailable?: boolean;
    interactiveClickError?: Error;
    navigationError?: Error;
  } = {},
) {
  const accountOptions: OptionSet = {
    texts: ["請選擇", "活期存款 0001"],
    selected: [],
  };
  const periodOptions: OptionSet = {
    texts: ["請選擇", "最近一年"],
    selected: [],
  };
  let currentUrl = initialUrl;
  let controlsReady = false;
  let openOptions: OptionSet | null = null;
  let queryCount = 0;
  const navigations: string[] = [];
  const comboboxes = [accountOptions, periodOptions].map((optionSet) => ({
    click: async () => {
      throw new Error("synthetic dummy input click must not be used");
    },
    locator: (selector: string) => {
      assert.equal(selector, "..");
      return {
        waitFor: async () => {
          if (options.interactiveControlsAvailable === false) {
            throw new Error("synthetic interactive control timeout");
          }
        },
        scrollIntoViewIfNeeded: async () => undefined,
        click: async () => {
          if (options.interactiveClickError) {
            throw options.interactiveClickError;
          }
          openOptions = optionSet;
        },
      };
    },
  }));

  return {
    accountOptions,
    periodOptions,
    navigations,
    queryCount: () => queryCount,
    page: {
      url: () => currentUrl,
      goto: async (url: string) => {
        if (options.navigationError) throw options.navigationError;
        navigations.push(url);
        currentUrl = url;
      },
      waitForLoadState: async () => undefined,
      locator: (selector: string) => {
        if (selector === '[role="combobox"]') {
          return {
            count: async () => (controlsReady ? comboboxes.length : 0),
            nth: (index: number) => ({
              ...comboboxes[index],
              waitFor: async () => {
                if (options.controlsAvailable === false) {
                  throw new Error("synthetic controls timeout");
                }
                controlsReady = true;
              },
            }),
          };
        }
        if (selector === '[role="listbox"] [role="option"]') {
          if (!openOptions)
            throw new Error("No Cathay query options are open.");
          return optionLocator(openOptions);
        }
        if (selector === "table") {
          return { first: () => ({ isVisible: async () => queryCount > 0 }) };
        }
        throw new Error(`Unexpected locator: ${selector}`);
      },
      getByRole: () => ({
        count: async () => 1,
        click: async () => {
          queryCount += 1;
        },
      }),
      getByText: () => ({ first: () => ({ isVisible: async () => false }) }),
      keyboard: {
        press: async () => {
          openOptions = null;
        },
      },
      waitForTimeout: async () => undefined,
    },
  };
}

const delayedPage = delayedDomesticQueryPage(
  "https://www.cathaybk.com.tw/OnlineBanking/",
);
let transferReads = 0;
await assert.rejects(
  () =>
    downloadCathayStatements(
      delayedPage.page as never,
      "one_year",
      [],
      { jwtToken: "synthetic", customerId: "synthetic", idType: "id" },
      {},
      {
        fetchDomesticAccounts: async () => [firstAccount],
        fetchTransferDetailsRaw: async () => {
          transferReads += 1;
          throw new Error("stop after Cathay UI query preparation");
        },
      },
    ),
  /stop after Cathay UI query preparation/,
);
assert.equal(delayedPage.navigations.length, 1);
assert.equal(delayedPage.queryCount(), 1);
assert.equal(transferReads, 1);

const alreadyOpenPage = delayedDomesticQueryPage(
  "https://www.cathaybk.com.tw/OnlineBanking/AcctInq/B0103_TxnDtlInq",
);
await assert.rejects(
  () =>
    downloadCathayStatements(
      alreadyOpenPage.page as never,
      "one_year",
      [],
      { jwtToken: "synthetic", customerId: "synthetic", idType: "id" },
      {},
      {
        fetchDomesticAccounts: async () => [firstAccount],
        fetchTransferDetailsRaw: async () => {
          throw new Error(
            "stop after already-open Cathay UI query preparation",
          );
        },
      },
    ),
  /stop after already-open Cathay UI query preparation/,
);
assert.deepEqual(alreadyOpenPage.navigations, []);
assert.equal(alreadyOpenPage.queryCount(), 1);

for (const [label, unavailablePage, expectedError] of [
  [
    "navigation",
    delayedDomesticQueryPage("https://www.cathaybk.com.tw/OnlineBanking/", {
      navigationError: new Error("synthetic Cathay navigation failure"),
    }),
    /synthetic Cathay navigation failure/,
  ],
  [
    "controls",
    delayedDomesticQueryPage(
      "https://www.cathaybk.com.tw/OnlineBanking/AcctInq/B0103_TxnDtlInq",
      { controlsAvailable: false },
    ),
    /query controls are unavailable/,
  ],
  [
    "interactive control",
    delayedDomesticQueryPage(
      "https://www.cathaybk.com.tw/OnlineBanking/AcctInq/B0103_TxnDtlInq",
      { interactiveControlsAvailable: false },
    ),
    /query control is not interactive/,
  ],
  [
    "intercepting content layer",
    delayedDomesticQueryPage(
      "https://www.cathaybk.com.tw/OnlineBanking/AcctInq/B0103_TxnDtlInq",
      {
        interactiveClickError: new Error(
          "synthetic Cathay content layer intercepts pointer events",
        ),
      },
    ),
    /query control is not interactive/,
  ],
] as const) {
  let unavailableTransferReads = 0;
  await assert.rejects(
    () =>
      downloadCathayStatements(
        unavailablePage.page as never,
        "one_year",
        [],
        { jwtToken: "synthetic", customerId: "synthetic", idType: "id" },
        {},
        {
          fetchDomesticAccounts: async () => [firstAccount],
          fetchTransferDetailsRaw: async () => {
            unavailableTransferReads += 1;
            return "unreachable";
          },
        },
      ),
    expectedError,
    `${label} failure must propagate before statement reads`,
  );
  assert.equal(unavailableTransferReads, 0);
  assert.equal(unavailablePage.queryCount(), 0);
}
