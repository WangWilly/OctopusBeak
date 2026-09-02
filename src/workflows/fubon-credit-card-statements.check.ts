import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./browser-interaction.js") {
      return nextResolve("./browser-interaction.ts", context);
    }
    if (specifier === "./fubon-auth.js") {
      return nextResolve("./fubon-auth.ts", context);
    }
    if (specifier === "./run-selected-statements.js") {
      return nextResolve("./run-selected-statements.ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const {
  buildFubonCanonicalCreditCardCaptures,
  fubonCreditCardStatementsInputSchema,
  isFubonStatementSummaryRow,
  parseFubonStatementCardLabel,
  parseFubonSettledStatementSummary,
  resolveFubonSettledStatementCycles,
} =
  await import("./fubon-credit-card-statements.ts");
const { deriveFubonSourceConnectionKey } = await import(
  "./fubon-source-connection.ts"
);

const fubonLoginSourceConnectionKey = deriveFubonSourceConnectionKey({
  fubon_user_id: "synthetic-fubon-user",
  fubon_account: "synthetic-fubon-account",
})!;
const fubonAutomaticSourceConnectionKey = deriveFubonSourceConnectionKey({
  fubon_user_id: "synthetic-fubon-automatic-user",
  fubon_account: "synthetic-fubon-automatic-account",
})!;
const fubonOtherSourceConnectionKey = deriveFubonSourceConnectionKey({
  fubon_user_id: "synthetic-fubon-other-user",
  fubon_account: "synthetic-fubon-other-account",
})!;

const source = await readFile(
  new URL("./fubon-credit-card-statements.ts", import.meta.url),
  "utf8",
);
const loginEntry = source.slice(
  source.indexOf("async function openCreditCardLoginForm"),
  source.indexOf("async function openStatementDetailsPage"),
);
assert.match(loginEntry, /openFubonLoginForm\(page\)/);
assert.match(source, /findStatementDetailsScope/);
assert.match(source, /StatementComponentAbsentError/);
assert.match(source, /hasFubonCreditCardNoRecord\(scope\)/);
assert.doesNotMatch(
  loginEntry,
  /#menu_CCC|menu_CCC02|task_CCCQU002|landingFrame\.goto|txnFrame\.goto/,
);

const summaryRows = [
  ["115/06/21", "網路繳款"],
  ["115/06/21", "行動銀行繳款"],
  ["", "前期應繳總額"],
];
const transactionRow = ["115/06/21", "咖啡店"];

for (const row of summaryRows) {
  assert.equal(isFubonStatementSummaryRow(row), true);
}
assert.equal(isFubonStatementSummaryRow(transactionRow), false);
assert.deepEqual(parseFubonStatementCardLabel("正卡 4111 1111 1111 1111"), {
  cardNumber: "1111",
  cardLabel: "正卡",
  fullPan: "4111111111111111",
});
assert.deepEqual(parseFubonStatementCardLabel("正卡末4碼1234"), {
  cardNumber: "1234",
  cardLabel: "正卡",
});
assert.deepEqual(
  [...summaryRows, transactionRow].filter(
    (row) => !isFubonStatementSummaryRow(row),
  ),
  [transactionRow],
);

const parsedSummary = parseFubonSettledStatementSummary(
  [
    "帳單年月",
    "信用額度",
    "國內預借現金額度",
    "帳單結帳日",
    "繳款截止日",
  ],
  [
    "115/07",
    "100,000元",
    "50,000元",
    "115/07/01",
    "115/07/20",
  ],
  [
    "前期應繳總額",
    "本期應繳總額",
    "最低應繳金額",
  ],
  [
    "0.00元",
    "1,234.00元",
    "100.00元",
  ],
);
assert.deepEqual(parsedSummary, {
  period: "115/07",
  issueDate: "2026-07-01",
  dueDate: "2026-07-20",
  balance: "1234.00",
  minimumPayment: "100.00",
});

const liveShapedSummary = parseFubonSettledStatementSummary(
  [
    "帳單年月",
    "信用額度",
    "國內預借現金額度",
    "帳單結帳日",
    "繳款截止日",
  ],
  [
    "115/07",
    "100,000元",
    "50,000元",
    "民國115年7月1日（星期三）",
    "115／07／20 (星期一)",
  ],
  ["本期應繳總額"],
  ["1,234.00元"],
);
assert.deepEqual(
  {
    issueDate: liveShapedSummary.issueDate,
    dueDate: liveShapedSummary.dueDate,
  },
  {
    issueDate: "2026-07-01",
    dueDate: "2026-07-20",
  },
  "explicit ROC dates with provider weekday annotations must normalize to ISO dates",
);
assert.throws(
  () =>
    parseFubonSettledStatementSummary(
      ["帳單年月", "帳單結帳日", "繳款截止日"],
      ["115/07", "115/07/01", "115/07"],
      ["本期應繳總額"],
      ["1,234.00元"],
    ),
  /not an explicit source date/u,
  "a month-only due date must remain rejected",
);
assert.throws(
  () =>
    parseFubonSettledStatementSummary(
      ["帳單年月", "帳單結帳日", "繳款截止日"],
      ["115/07", "115/07/01", "115/07/20 至 115/08/20"],
      ["本期應繳總額"],
      ["1,234.00元"],
    ),
  /not an explicit source date/u,
  "a due-date range must remain rejected as ambiguous",
);
assert.throws(
  () =>
    parseFubonSettledStatementSummary(
      ["帳單年月", "帳單結帳日", "繳款截止日"],
      ["115/07", "115/07/01", "4111111111111111"],
      ["本期應繳總額"],
      ["1,234.00元"],
    ),
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(
      message,
      /shape\(length=16,digits=16,masked=################\)/u,
      "the date-shape diagnostic must retain only bounded metadata and masked digits",
    );
    assert.doesNotMatch(message, /4111111111111111/u);
    return true;
  },
  "date diagnostics must not expose a PAN-like source value",
);

const summaries = [
  ["period-1", "2026-07-28", "2026-08-15"],
  ["period-2", "2026-06-28", "2026-07-15"],
  ["period-3", "2026-05-28", "2026-06-15"],
  ["period-4", "2026-04-28", "2026-05-15"],
  ["period-5", "2026-03-28", "2026-04-15"],
  ["period-6", "2026-02-28", "2026-03-15"],
].map(([period, issueDate, dueDate], index) => ({
  period,
  issueDate,
  dueDate,
  balance: `${index + 1}.00`,
  minimumPayment: "1.00",
}));
assert.equal(resolveFubonSettledStatementCycles(summaries).length, 5);
const nonDateDueSummary = parseFubonSettledStatementSummary(
  ["帳單年月", "帳單結帳日", "繳款截止日"],
  ["115/07", "115/07/01", "尚未出帳（待定）"],
  ["本期應繳總額"],
  ["1,234.00元"],
);
assert.equal("dueDate" in nonDateDueSummary, false);
for (const providerStatus of ["尚未出帳", "尚未出帳（待定）", "Not yet due"]) {
  const statusSummary = parseFubonSettledStatementSummary(
    ["帳單年月", "帳單結帳日", "繳款截止日"],
    ["115/07", "115/07/01", providerStatus],
    ["本期應繳總額"],
    ["1,234.00元"],
  );
  assert.equal(
    "dueDate" in statusSummary,
    false,
    `purely textual due status ${providerStatus} must remain source-only`,
  );
}
const canonicalInput = fubonCreditCardStatementsInputSchema.parse({
  canonicalHumanAttestation: {
    sourceConnectionKey: fubonLoginSourceConnectionKey,
    identityEpochKey: "fubon-credit-epoch-v2",
    humanAttestedAccountKey: "portfolio-primary-a",
  },
});
const canonicalStatementRows = [
  {
    statement_period: "period-1",
    card_number: "1234",
    card_label: "正卡 1234",
    consume_date: "115/01/03",
    posting_date: "115/01/04",
    description: "SYNTHETIC A",
    twd_amount: "10.00",
  },
  {
    statement_period: "period-1",
    card_number: "5678",
    card_label: "正卡 5678",
    consume_date: "115/01/05",
    posting_date: "115/01/06",
    description: "SYNTHETIC B",
    twd_amount: "20.00",
  },
];
const canonicalUnbilledRows = [
  {
    statement_period: "unbilled",
    card_number: "123456******1234",
    consume_date: "115/07/03",
    posting_date: "115/07/04",
    description: "SYNTHETIC C",
    twd_amount: "-5.00",
  },
];
const canonicalGridStates = [2, 0, 0, 0, 0, 0, 1].map(
  (sourceDeclaredRowCount) => ({
    currentPage: "1",
    currentPageSize: String(2_147_483_647),
    sourceDeclaredRowCount,
  }),
);
const canonicalBuildOptions = {
  captureId: "capture-synthetic",
  observedAt: "2026-08-25T00:00:00.000Z",
  statementRows: canonicalStatementRows,
  unbilledRows: canonicalUnbilledRows,
  summaries,
  gridStates: canonicalGridStates,
  input: canonicalInput,
};

const foreignEvidenceDiagnosticRows = [
  {
    ...canonicalStatementRows[0]!,
    foreign_currency: "USD",
    description: "SENSITIVE MERCHANT 4111111111111111",
  },
  {
    ...canonicalStatementRows[1]!,
    statement_period: "unbilled",
    foreign_amount: "123.45",
    twd_amount: "-20.00",
    description: "SENSITIVE MERCHANT 654321******1111",
  },
];
const foreignEvidenceDiagnosticError = (() => {
  try {
    buildFubonCanonicalCreditCardCaptures({
      ...canonicalBuildOptions,
      captureId: "capture-foreign-evidence-diagnostic",
      statementRows: foreignEvidenceDiagnosticRows.slice(0, 1),
      unbilledRows: foreignEvidenceDiagnosticRows.slice(1),
      gridStates: canonicalGridStates.map((state, index) => ({
        ...state,
        sourceDeclaredRowCount: index === 0 ? 1 : 0,
      })),
    });
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  throw new Error("expected incomplete Fubon foreign evidence to be rejected");
})();
assert.match(
  foreignEvidenceDiagnosticError.message,
  /Fubon foreign currency and amount evidence must be complete together/u,
);
const foreignEvidenceDiagnosticMatch = /diagnostics=(\{.*\})$/u.exec(
  foreignEvidenceDiagnosticError.message,
);
assert.ok(foreignEvidenceDiagnosticMatch, "foreign evidence diagnostics must be structured JSON");
const foreignEvidenceDiagnostics = JSON.parse(foreignEvidenceDiagnosticMatch[1]!);
assert.equal(foreignEvidenceDiagnostics.affectedRowCount, 2);
assert.equal(foreignEvidenceDiagnostics.patternsTruncated, false);
assert.equal(foreignEvidenceDiagnostics.patterns.length, 2);
assert.deepEqual(foreignEvidenceDiagnostics.patterns, [
  {
    currencyPresent: true,
    amountPresent: false,
    currencyIsBookedCurrency: false,
    twdAmountPresent: true,
    billed: 1,
    unbilled: 0,
    rawSourceFieldsPresent: {
      foreignCurrency: true,
      foreignAmount: false,
      twdAmount: true,
    },
    count: 1,
  },
  {
    currencyPresent: false,
    amountPresent: true,
    currencyIsBookedCurrency: false,
    twdAmountPresent: true,
    billed: 0,
    unbilled: 1,
    rawSourceFieldsPresent: {
      foreignCurrency: false,
      foreignAmount: true,
      twdAmount: true,
    },
    count: 1,
  },
]);
assert.doesNotMatch(
  foreignEvidenceDiagnosticError.message,
  /USD|123\.45|SENSITIVE MERCHANT|4111111111111111|654321\*{6}1111|115\/01\/03|period-1|1234|5678|portfolio-primary-a/u,
  "foreign evidence diagnostics must redact source values",
);

const localMarkerRows = canonicalStatementRows.map((row, index) => ({
  ...row,
  foreign_currency: [" T W D ", "新 台 幣"][index]!,
  foreign_amount: "",
}));
const localMarkerUnbilledRows = canonicalUnbilledRows.map((row) => ({
  ...row,
  foreign_currency: "NTD",
  foreign_amount: "",
}));
const localMarkerGridStates = canonicalGridStates.map((state, index) => ({
  ...state,
  sourceDeclaredRowCount: index === 0 ? 2 : index === 6 ? 1 : 0,
}));
const localMarkerCapture = buildFubonCanonicalCreditCardCaptures({
  ...canonicalBuildOptions,
  captureId: "capture-local-currency-markers",
  statementRows: localMarkerRows,
  unbilledRows: localMarkerUnbilledRows,
  gridStates: localMarkerGridStates,
});
assert.equal(localMarkerCapture.length, 1);
assert.ok(
  localMarkerCapture[0]?.transactions.every(
    (transaction) =>
      transaction.foreignCurrency === null && transaction.foreignAmount === null,
  ),
  "known local-currency markers without a foreign amount normalize to no conversion evidence",
);
const canonicalNoMarkerCapture = buildFubonCanonicalCreditCardCaptures(
  canonicalBuildOptions,
);
assert.deepEqual(
  localMarkerCapture[0]?.transactions.map((transaction) => ({
    sourceKey: transaction.sourceKey,
    sourceRecordKey: transaction.sourceRecordKey,
    foreignCurrency: transaction.foreignCurrency,
    foreignAmount: transaction.foreignAmount,
  })),
  canonicalNoMarkerCapture[0]?.transactions.map((transaction) => ({
    sourceKey: transaction.sourceKey,
    sourceRecordKey: transaction.sourceRecordKey,
    foreignCurrency: transaction.foreignCurrency,
    foreignAmount: transaction.foreignAmount,
  })),
  "equivalent local-currency markers must not churn source identity",
);
for (const [index, marker] of ["TWD", "twd", "NTD", "新臺幣", "新台幣", "台幣"].entries()) {
  const markerCapture = buildFubonCanonicalCreditCardCaptures({
    ...canonicalBuildOptions,
    captureId: `capture-local-marker-${index}`,
    statementRows: [
      {
        ...canonicalStatementRows[0]!,
        foreign_currency: marker,
        foreign_amount: "",
      },
    ],
    unbilledRows: [],
    gridStates: canonicalGridStates.map((state, gridIndex) => ({
      ...state,
      sourceDeclaredRowCount: gridIndex === 0 ? 1 : 0,
    })),
  });
  assert.equal(markerCapture[0]?.transactions[0]?.foreignCurrency, null);
  assert.equal(markerCapture[0]?.transactions[0]?.foreignAmount, null);
}

const localMarkerWithAmountError = (() => {
  try {
    buildFubonCanonicalCreditCardCaptures({
      ...canonicalBuildOptions,
      captureId: "capture-local-currency-with-foreign-amount",
      statementRows: [
        {
          ...canonicalStatementRows[0]!,
          foreign_currency: "TWD",
          foreign_amount: "123.45",
        },
      ],
      unbilledRows: [],
      gridStates: canonicalGridStates.map((state, index) => ({
        ...state,
        sourceDeclaredRowCount: index === 0 ? 1 : 0,
      })),
    });
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  throw new Error("expected a local-currency marker paired with a foreign amount to reject");
})();
assert.match(
  localMarkerWithAmountError.message,
  /booked-currency marker cannot be paired with foreign amount evidence/u,
);
assert.match(localMarkerWithAmountError.message, /currencyIsBookedCurrency/u);
assert.doesNotMatch(
  localMarkerWithAmountError.message,
  /TWD|123\.45|period-1|1234|4111111111111111/u,
  "local-currency diagnostics must redact marker, amount, period, and card values",
);

const unknownCurrencyMarkerError = (() => {
  try {
    buildFubonCanonicalCreditCardCaptures({
      ...canonicalBuildOptions,
      captureId: "capture-unknown-currency-marker",
      statementRows: [
        {
          ...canonicalStatementRows[0]!,
          foreign_currency: "LOCAL",
        },
      ],
      unbilledRows: [],
      gridStates: canonicalGridStates.map((state, index) => ({
        ...state,
        sourceDeclaredRowCount: index === 0 ? 1 : 0,
      })),
    });
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  throw new Error("expected an unknown currency marker without an amount to reject");
})();
assert.match(
  unknownCurrencyMarkerError.message,
  /foreign currency and amount evidence must be complete together/u,
);
assert.doesNotMatch(unknownCurrencyMarkerError.message, /LOCAL/u);

const validForeignPairCapture = buildFubonCanonicalCreditCardCaptures({
  ...canonicalBuildOptions,
  captureId: "capture-valid-foreign-pair",
  statementRows: [
    {
      ...canonicalStatementRows[0]!,
      foreign_currency: "usd",
      foreign_amount: "12.34",
    },
  ],
  unbilledRows: [],
  gridStates: canonicalGridStates.map((state, index) => ({
    ...state,
    sourceDeclaredRowCount: index === 0 ? 1 : 0,
  })),
});
assert.equal(validForeignPairCapture[0]?.transactions[0]?.foreignCurrency, "USD");
assert.deepEqual(validForeignPairCapture[0]?.transactions[0]?.foreignAmount, {
  coefficient: "1234",
  scale: 2,
});
const preflightDiagnosticRows = [
  {
    ...canonicalStatementRows[0]!,
    card_number: "12",
    card_label: "Sensitive card label 654321******1111",
    description: "Sensitive transaction description CARD-PAN-SENTINEL",
  },
];
const preflightDiagnosticGridStates = canonicalGridStates.map((state, index) =>
  index === 0
    ? { currentPage: "page-secret-CARD-PAN-SENTINEL", currentPageSize: "size-secret" }
    : index === 1
      ? { ...state, sourceDeclaredRowCount: undefined }
      : state,
);
const preflightDiagnosticError = (() => {
  try {
    buildFubonCanonicalCreditCardCaptures({
      ...canonicalBuildOptions,
      captureId: "capture-preflight-diagnostic-secret",
      statementRows: preflightDiagnosticRows,
      unbilledRows: [],
      summaries: [
        summaries[0]!,
        summaries[1]!,
        summaries[2]!,
        summaries[3]!,
        summaries[4]!,
        summaries[0]!,
      ],
      gridStates: preflightDiagnosticGridStates,
      input: fubonCreditCardStatementsInputSchema.parse({
        ...canonicalInput,
        periodOffsets: [1, 2],
        statementCardLabels: ["Sensitive card filter"],
        unbilledCardNumbers: ["CARD-PAN-SENTINEL"],
      }),
    });
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  throw new Error("expected Fubon canonical preflight to reject incomplete scope");
})();
assert.match(preflightDiagnosticError.message, /requires six unfiltered terminal billed grids plus unbilled/u);
assert.match(preflightDiagnosticError.message, /period-offset-count/u);
assert.match(preflightDiagnosticError.message, /period-offset-membership/u);
assert.match(preflightDiagnosticError.message, /statement-card-filter/u);
assert.match(preflightDiagnosticError.message, /unbilled-card-filter/u);
assert.match(preflightDiagnosticError.message, /grid-terminal-shape/u);
assert.match(preflightDiagnosticError.message, /summary-period-uniqueness/u);
assert.match(preflightDiagnosticError.message, /observed-card-key-format/u);
assert.match(preflightDiagnosticError.message, /currentPage/u);
assert.match(preflightDiagnosticError.message, /currentPageSize/u);
assert.match(preflightDiagnosticError.message, /sourceDeclaredRowCountPresent/u);
assert.match(preflightDiagnosticError.message, /summaryCount/u);
assert.match(preflightDiagnosticError.message, /uniqueSummaryPeriodCount/u);
assert.match(preflightDiagnosticError.message, /observedCardKeyCount/u);
assert.match(preflightDiagnosticError.message, /observedCardKeysHaveFourDigits/u);
assert.match(preflightDiagnosticError.message, /periodOffsetsHaveExpectedCount/u);
assert.match(preflightDiagnosticError.message, /periodOffsetsHaveExpectedMembers/u);
assert.match(preflightDiagnosticError.message, /allGridsHaveTerminalShape/u);
assert.match(preflightDiagnosticError.message, /summaryPeriodsAreUnique/u);
assert.match(preflightDiagnosticError.message, /observedCardKeysPresent/u);
assert.doesNotMatch(
  preflightDiagnosticError.message,
  /Sensitive card label|Sensitive transaction description|CARD-PAN-SENTINEL|654321\*{6}1111|period-1/u,
  "canonical preflight diagnostics must not leak card, PAN, transaction, or period values",
);
const nonDateDueRows = [
  {
    ...canonicalStatementRows[0]!,
    statement_period: "period-2",
    description: "SYNTHETIC SOURCE ONLY",
  },
];
const nonDateDueGridStates = canonicalGridStates.map((state, index) => ({
  ...state,
  sourceDeclaredRowCount: index === 1 ? 1 : 0,
}));
const nonDateDueCapture = buildFubonCanonicalCreditCardCaptures({
  ...canonicalBuildOptions,
  captureId: "capture-non-date-due",
  statementRows: nonDateDueRows,
  unbilledRows: [],
  summaries: summaries.map((summary, index) =>
    index === 1 ? { ...summary, dueDate: undefined } : summary,
  ),
  gridStates: nonDateDueGridStates.map((state, index) =>
    index === 6 ? { ...state, sourceDeclaredRowCount: 0 } : state,
  ),
});
assert.equal(nonDateDueCapture.length, 1);
assert.equal(nonDateDueCapture[0]?.scope.completeness.billedPeriods.length, 6);
assert.equal(
  nonDateDueCapture[0]?.scope.completeness.periodRowCounts.reduce(
    (sum, count) => sum + count,
    0,
  ),
  1,
);
assert.equal(nonDateDueCapture[0]?.transactions.length, 1);
const sourceOnlyDueTransaction = nonDateDueCapture[0]!.transactions[0]!;
assert.equal(sourceOnlyDueTransaction.billingStatus, "billed");
assert.equal(sourceOnlyDueTransaction.statementKey, undefined);
assert.match(
  sourceOnlyDueTransaction.sourceScopeKey ?? "",
  /^fubon-source-only-period-v2:sha256:/u,
);
assert.equal(
  nonDateDueCapture[0]?.scope.completeness.grids.find(
    (grid) => grid.period === "period-2",
  )?.dueDateEvidence,
  "provider-text-status",
);
assert.equal(
  nonDateDueCapture[0]?.scope.completeness.grids.find(
    (grid) => grid.period === "period-1",
  )?.dueDateEvidence,
  "explicit-date",
);
assert.equal(nonDateDueCapture[0]?.statements.length, 4);
assert.ok(
  nonDateDueCapture[0]?.statements.every(
    (statement) =>
      !statement.transactionSourceKeys.includes(sourceOnlyDueTransaction.sourceRecordKey),
  ),
);
const allNonDateDueCapture = buildFubonCanonicalCreditCardCaptures({
  ...canonicalBuildOptions,
  captureId: "capture-all-non-date-due",
  statementRows: nonDateDueRows,
  unbilledRows: [],
  summaries: summaries.map((summary) => ({ ...summary, dueDate: undefined })),
  gridStates: nonDateDueGridStates.map((state, index) =>
    index === 6 ? { ...state, sourceDeclaredRowCount: 0 } : state,
  ),
});
assert.equal(allNonDateDueCapture.length, 1);
assert.equal(allNonDateDueCapture[0]?.statements.length, 0);
assert.equal(allNonDateDueCapture[0]?.transactions.length, 1);
assert.equal(allNonDateDueCapture[0]?.transactions[0]?.statementKey, undefined);
const canonicalCaptures = buildFubonCanonicalCreditCardCaptures(canonicalBuildOptions);
assert.equal(canonicalCaptures.length, 1);
assert.equal(canonicalCaptures[0]?.instruments.length, 2);
assert.equal(canonicalCaptures[0]?.statements.length, 5);
assert.equal(canonicalCaptures[0]?.transactions.length, 3);
assert.equal(canonicalCaptures[0]?.transactions[2]?.billingStatus, "unbilled");
assert.equal(canonicalCaptures[0]?.transactions[2]?.direction, "outflow");
assert.equal(canonicalCaptures[0]?.statements[0]?.transactionSourceKeys.length, 2);
assert.ok(
  canonicalCaptures[0]?.instruments.every((instrument) =>
    /^\*{4}\d{4}$/u.test(instrument.cardMask ?? ""),
  ),
);
assert.ok(
  canonicalCaptures[0]?.transactions.every((transaction) =>
    canonicalCaptures[0]!.instruments.some(
      (instrument) => instrument.instrumentKey === transaction.instrumentKey,
    ),
  ),
);

const shortPageGridStates = canonicalGridStates.map(
  ({ sourceDeclaredRowCount: _sourceDeclaredRowCount, ...state }) => state,
);
const shortPageCapture = buildFubonCanonicalCreditCardCaptures({
  ...canonicalBuildOptions,
  captureId: "capture-short-page",
  gridStates: shortPageGridStates,
});
assert.equal(shortPageCapture.length, 1);
assert.equal(shortPageCapture[0]?.scope.completeness.rowCountsMatch, true);
assert.ok(
  shortPageCapture[0]?.scope.completeness.grids.every(
    (grid) =>
      grid.terminalEvidence === "short-page" &&
      !Object.hasOwn(grid, "sourceDeclaredRowCount") &&
      !Object.hasOwn(grid, "sourceDeclaredScopeRowCount"),
  ),
  "missing provider totals must be represented as short-page evidence without fabricated counts",
);
for (const invalidGridStates of [
  shortPageGridStates.map((state, index) =>
    index === 0 ? { ...state, currentPage: "2" } : state,
  ),
  shortPageGridStates.map((state, index) =>
    index === 0 ? { ...state, currentPageSize: "100" } : state,
  ),
])
  assert.throws(
    () =>
      buildFubonCanonicalCreditCardCaptures({
        ...canonicalBuildOptions,
        captureId: "capture-short-page-invalid-pagination",
        gridStates: invalidGridStates,
      }),
    /terminal|grid/u,
  );

const automaticFingerprintKey = { secret: "synthetic-managed-fingerprint-key" };
const automaticInput = fubonCreditCardStatementsInputSchema.parse({
  canonicalHumanAttestation: {
    sourceConnectionKey: fubonAutomaticSourceConnectionKey,
    identityEpochKey: "fubon-credit-card-human-attested-v2",
    humanAttestedAccountKey: "portfolio_automatic_a",
  },
});
const automaticCaptures = buildFubonCanonicalCreditCardCaptures({
  ...canonicalBuildOptions,
  input: automaticInput,
  panFingerprintKey: automaticFingerprintKey,
});
const repeatedAutomaticCaptures = buildFubonCanonicalCreditCardCaptures({
  ...canonicalBuildOptions,
  captureId: "capture-synthetic-repeat",
  input: automaticInput,
  panFingerprintKey: automaticFingerprintKey,
});
assert.equal(automaticCaptures.length, 1);
assert.deepEqual(
  automaticCaptures.map((capture) => capture.identity.accountNaturalKey),
  repeatedAutomaticCaptures.map((capture) => capture.identity.accountNaturalKey),
  "the desktop-managed secret must produce stable human-attested account identities",
);
assert.deepEqual(
  automaticCaptures[0]?.transactions.map((transaction) => transaction.sourceKey),
  repeatedAutomaticCaptures[0]?.transactions.map((transaction) => transaction.sourceKey),
  "transaction source keys must not depend on capture occurrence IDs",
);
assert.equal(
  new Set(automaticCaptures[0]!.instruments.map((instrument) => instrument.instrumentKey)).size,
  2,
  "the consolidated portfolio must retain two distinct card instruments",
);
assert.equal(
  automaticCaptures[0]?.statements[0]?.transactionSourceKeys.length,
  2,
  "the consolidated statement must include billed rows from both instruments",
);
assert.ok(
  automaticCaptures.every(
    (capture) =>
      capture.identity.identityMethod === "human-attested" &&
      capture.identity.humanAttestedAccountKey?.startsWith("portfolio_") === true,
  ),
);

const sameLast4MaskedRows = canonicalStatementRows.map((row, index) => {
  const masked = index === 0 ? "123456******1234" : "654321******1234";
  return {
    ...row,
    card_number: masked,
    card_label: `正卡 ${masked}`,
  };
});
const sameLast4GridStates = canonicalGridStates.map((state, index) => ({
  ...state,
  sourceDeclaredRowCount: index === 0 ? 2 : 0,
}));
const sameLast4Capture = buildFubonCanonicalCreditCardCaptures({
  ...canonicalBuildOptions,
  captureId: "capture-same-last4-masked-cards",
  statementRows: sameLast4MaskedRows,
  unbilledRows: [],
  gridStates: sameLast4GridStates,
});
assert.equal(sameLast4Capture.length, 1);
assert.equal(sameLast4Capture[0]?.instruments.length, 2);
assert.deepEqual(
  sameLast4Capture[0]?.instruments.map((instrument) => instrument.cardMask),
  ["****1234", "****1234"],
  "distinct masked source labels may share a safe display mask",
);
assert.equal(
  new Set(sameLast4Capture[0]!.instruments.map((instrument) => instrument.instrumentKey)).size,
  2,
  "masked source labels with one last-four value must retain distinct opaque instruments",
);
assert.equal(
  new Set(sameLast4Capture[0]!.transactions.map((transaction) => transaction.instrumentKey)).size,
  2,
);
assert.equal(JSON.stringify(sameLast4Capture).includes("123456******1234"), false);
const ambiguousMaskedRows = [
  ...sameLast4MaskedRows,
  {
    ...sameLast4MaskedRows[0]!,
    card_number: "1234",
    card_label: "正卡",
    description: "SYNTHETIC AMBIGUOUS",
  },
];
assert.throws(
  () =>
    buildFubonCanonicalCreditCardCaptures({
      ...canonicalBuildOptions,
      captureId: "capture-ambiguous-last4-masked-cards",
      statementRows: ambiguousMaskedRows,
      unbilledRows: [],
      gridStates: sameLast4GridStates.map((state, index) => ({
        ...state,
        sourceDeclaredRowCount: index === 0 ? 3 : 0,
      })),
    }),
  /cannot distinguish/i,
  "a row without source instrument evidence must not be assigned among multiple masked instruments",
);

const mixedFullPanAndMaskedRows = [
  {
    ...canonicalStatementRows[0]!,
    card_number: "4111111111111111",
    card_label: "正卡 4111 1111 1111 1111",
  },
  {
    ...canonicalStatementRows[1]!,
    card_number: "654321******1111",
    card_label: "正卡 654321******1111",
  },
];
assert.throws(
  () =>
    buildFubonCanonicalCreditCardCaptures({
      ...canonicalBuildOptions,
      captureId: "capture-mixed-full-pan-masked",
      statementRows: mixedFullPanAndMaskedRows,
      unbilledRows: [],
      gridStates: sameLast4GridStates,
    }),
  /cannot distinguish|fingerprint/i,
  "full PAN and a distinct masked label sharing a last-four key must fail closed without a fingerprint key",
);
const matchingFullPanAndMaskedRows = [
  mixedFullPanAndMaskedRows[0]!,
  {
    ...mixedFullPanAndMaskedRows[1]!,
    card_number: "411111******1111",
    card_label: "正卡 411111******1111",
  },
];
const mixedWithFingerprintCapture = buildFubonCanonicalCreditCardCaptures({
  ...canonicalBuildOptions,
  captureId: "capture-mixed-full-pan-masked-keyed",
  statementRows: matchingFullPanAndMaskedRows,
  unbilledRows: [],
  gridStates: sameLast4GridStates,
  panFingerprintKey: {
    secret: "synthetic-fubon-pan-key",
    keyVersion: "test-v1",
  },
});
assert.equal(mixedWithFingerprintCapture.length, 1);
assert.equal(
  mixedWithFingerprintCapture[0]?.instruments.length,
  1,
  "a unique masked prefix+last-four match must reconcile to the observed PAN instrument",
);
assert.equal(JSON.stringify(mixedWithFingerprintCapture).includes("4111111111111111"), false);
assert.throws(
  () =>
    buildFubonCanonicalCreditCardCaptures({
      ...canonicalBuildOptions,
      captureId: "capture-mixed-full-pan-masked-keyed-mismatch",
      statementRows: mixedFullPanAndMaskedRows,
      unbilledRows: [],
      gridStates: sameLast4GridStates,
      panFingerprintKey: {
        secret: "synthetic-fubon-pan-key",
        keyVersion: "test-v1",
      },
    }),
  /reconciled|ambiguous|candidate/i,
  "a masked prefix with no matching PAN candidate must fail closed",
);
const ambiguousFullPanAndMaskedRows = [
  matchingFullPanAndMaskedRows[0]!,
  {
    ...matchingFullPanAndMaskedRows[0]!,
    card_number: "4111110000091111",
    card_label: "正卡 4111 1100 0009 1111",
  },
  matchingFullPanAndMaskedRows[1]!,
];
assert.throws(
  () =>
    buildFubonCanonicalCreditCardCaptures({
      ...canonicalBuildOptions,
      captureId: "capture-mixed-full-pan-masked-keyed-ambiguous",
      statementRows: ambiguousFullPanAndMaskedRows,
      unbilledRows: [],
      gridStates: sameLast4GridStates.map((state, index) => ({
        ...state,
        sourceDeclaredRowCount: index === 0 ? 3 : 0,
      })),
      panFingerprintKey: {
        secret: "synthetic-fubon-pan-key",
        keyVersion: "test-v1",
      },
    }),
  /reconciled|ambiguous|candidate/i,
  "a masked prefix with multiple matching PAN candidates must fail closed",
);

const crossPeriodRows = [
  {
    ...canonicalStatementRows[0]!,
    statement_period: "period-1",
    card_number: "1234",
    card_label: "正卡 1234",
  },
  {
    ...canonicalStatementRows[0]!,
    statement_period: "period-2",
    card_number: "1234",
    card_label: "正卡 1234",
  },
];
const crossPeriodGridStates = canonicalGridStates.map((state, index) => ({
  ...state,
  sourceDeclaredRowCount: index < 2 ? 1 : 0,
}));
const crossPeriodForwardCapture = buildFubonCanonicalCreditCardCaptures({
  ...canonicalBuildOptions,
  captureId: "capture-cross-period-forward",
  statementRows: crossPeriodRows,
  unbilledRows: [],
  gridStates: crossPeriodGridStates,
});
const crossPeriodReverseSummaries = summaries.slice().reverse();
const crossPeriodReverseGridStates = [
  ...crossPeriodGridStates.slice(0, 6).reverse(),
  crossPeriodGridStates[6]!,
];
const crossPeriodReverseCapture = buildFubonCanonicalCreditCardCaptures({
  ...canonicalBuildOptions,
  captureId: "capture-cross-period-reverse",
  statementRows: crossPeriodRows.slice().reverse(),
  unbilledRows: [],
  summaries: crossPeriodReverseSummaries,
  gridStates: crossPeriodReverseGridStates,
});
assert.deepEqual(
  crossPeriodForwardCapture[0]?.transactions.map((transaction) => ({
    sourceKey: transaction.sourceKey,
    sourceRecordKey: transaction.sourceRecordKey,
    statementKey: transaction.statementKey,
  })),
  crossPeriodReverseCapture[0]?.transactions.map((transaction) => ({
    sourceKey: transaction.sourceKey,
    sourceRecordKey: transaction.sourceRecordKey,
    statementKey: transaction.statementKey,
  })),
  "statement period must keep otherwise identical rows stable across tab-order permutations",
);
assert.deepEqual(
  crossPeriodForwardCapture[0]?.statements.map((statement) => ({
    statementKey: statement.statementKey,
    revisionKey: statement.revisionKey,
    transactionSourceKeys: statement.transactionSourceKeys,
  })),
  crossPeriodReverseCapture[0]?.statements.map((statement) => ({
    statementKey: statement.statementKey,
    revisionKey: statement.revisionKey,
    transactionSourceKeys: statement.transactionSourceKeys,
  })),
);

const rollingNextSummaries = [
  ...summaries.slice(1),
  {
    period: "period-7",
    issueDate: "2026-01-28",
    dueDate: "2026-02-15",
    balance: "7.00",
    minimumPayment: "1.00",
  },
];
const rollingNextGridStates = canonicalGridStates.map((state, index) => ({
  ...state,
  sourceDeclaredRowCount: index === 0 ? 1 : 0,
}));
const rollingInitialCapture = buildFubonCanonicalCreditCardCaptures({
  ...canonicalBuildOptions,
  captureId: "capture-rolling-window-initial",
  statementRows: crossPeriodRows,
  unbilledRows: [],
  gridStates: crossPeriodGridStates,
});
const rollingNextCapture = buildFubonCanonicalCreditCardCaptures({
  ...canonicalBuildOptions,
  captureId: "capture-rolling-window-next",
  statementRows: [crossPeriodRows[1]!],
  unbilledRows: [],
  summaries: rollingNextSummaries,
  gridStates: rollingNextGridStates,
});
const rollingInitialPeriod2 = rollingInitialCapture[0]!.transactions.find(
  (transaction) => transaction.statementKey === rollingNextCapture[0]!.transactions[0]!.statementKey,
)!;
const rollingNextPeriod2 = rollingNextCapture[0]!.transactions[0]!;
assert.equal(rollingInitialPeriod2.occurrenceIndex, 0);
assert.equal(rollingNextPeriod2.occurrenceIndex, 0);
assert.equal(rollingInitialPeriod2.sourceKey, rollingNextPeriod2.sourceKey);
assert.equal(rollingInitialPeriod2.sourceRecordKey, rollingNextPeriod2.sourceRecordKey);
const rollingInitialPeriod2Statement = rollingInitialCapture[0]!.statements.find(
  (statement) => statement.transactionSourceKeys.includes(rollingInitialPeriod2.sourceRecordKey),
)!;
const rollingNextPeriod2Statement = rollingNextCapture[0]!.statements.find(
  (statement) => statement.transactionSourceKeys.includes(rollingNextPeriod2.sourceRecordKey),
)!;
assert.equal(rollingInitialPeriod2Statement.statementKey, rollingNextPeriod2Statement.statementKey);
assert.equal(rollingInitialPeriod2Statement.revisionKey, rollingNextPeriod2Statement.revisionKey);
assert.deepEqual(
  rollingInitialPeriod2Statement.transactionSourceKeys,
  rollingNextPeriod2Statement.transactionSourceKeys,
  "dropping the oldest visible period must not churn the retained period's statement membership",
);

const reversedPeriodCapture = buildFubonCanonicalCreditCardCaptures({
  ...canonicalBuildOptions,
  captureId: "capture-reversed-period-order",
  summaries: summaries.slice().reverse(),
  gridStates: [
    ...canonicalGridStates.slice(0, 6).reverse(),
    canonicalGridStates[6]!,
  ],
});
assert.equal(reversedPeriodCapture.length, 1);
assert.deepEqual(
  reversedPeriodCapture[0]?.scope.completeness.billedPeriods,
  canonicalCaptures[0]?.scope.completeness.billedPeriods,
  "period offsets may be visited in reverse order while canonical evidence remains newest-to-oldest",
);
assert.deepEqual(
  reversedPeriodCapture[0]?.statements.map((statement) => statement.issueDate),
  canonicalCaptures[0]?.statements.map((statement) => statement.issueDate),
);
assert.deepEqual(
  reversedPeriodCapture[0]?.transactions.map((transaction) => transaction.sourceKey),
  canonicalCaptures[0]?.transactions.map((transaction) => transaction.sourceKey),
);
const rotatedAutomaticCaptures = buildFubonCanonicalCreditCardCaptures({
  ...canonicalBuildOptions,
  input: fubonCreditCardStatementsInputSchema.parse({
    canonicalHumanAttestation: {
      sourceConnectionKey: fubonOtherSourceConnectionKey,
      identityEpochKey: "fubon-credit-card-human-attested-v2",
      humanAttestedAccountKey: "portfolio-other-a",
    },
  }),
  panFingerprintKey: { secret: "different-managed-fingerprint-key" },
});
assert.notDeepEqual(
  automaticCaptures.map((capture) => capture.identity.accountNaturalKey),
  rotatedAutomaticCaptures.map((capture) => capture.identity.accountNaturalKey),
  "porting the encrypted managed secret is required to preserve identity",
);
const panInput = fubonCreditCardStatementsInputSchema.parse({
  canonicalHumanAttestation: {
    sourceConnectionKey: fubonLoginSourceConnectionKey,
    identityEpochKey: "fubon-credit-epoch-v2",
    humanAttestedAccountKey: "portfolio-pan-a",
  },
});
const panStatementRows = canonicalStatementRows.map((row) => ({
  ...row,
  card_number: "4111111111111111",
  card_label: "正卡 4111 1111 1111 1111",
}));
const panUnbilledRows = canonicalUnbilledRows.map((row) => ({
  ...row,
  card_number: "4111111111111111",
  card_label: "4111111111111111",
}));
const panSummaries = summaries.slice(0, 6);
const panCaptures = buildFubonCanonicalCreditCardCaptures({
  ...canonicalBuildOptions,
  statementRows: panStatementRows,
  unbilledRows: panUnbilledRows,
  summaries: panSummaries,
  input: panInput,
  panFingerprintKey: {
    secret: "synthetic-fubon-pan-key",
    keyVersion: "test-v1",
  },
});
assert.equal(panCaptures.length, 1);
assert.equal(panCaptures[0]?.identity.identityMethod, "human-attested");
assert.equal(panCaptures[0]?.identity.panLast4, undefined);
assert.equal(panCaptures[0]?.identity.panFingerprintKeyVersion, undefined);
assert.equal(JSON.stringify(panCaptures).includes("4111111111111111"), false);
const replacementPanCaptures = buildFubonCanonicalCreditCardCaptures({
  ...canonicalBuildOptions,
  captureId: "capture-replacement-pan",
  statementRows: panStatementRows.map((row) => ({
    ...row,
    card_number: "4012888888881881",
    card_label: "正卡 4012 8888 8888 1881",
  })),
  unbilledRows: panUnbilledRows.map((row) => ({
    ...row,
    card_number: "4012888888881881",
    card_label: "4012 8888 8888 1881",
  })),
  input: panInput,
  panFingerprintKey: {
    secret: "synthetic-fubon-pan-key",
    keyVersion: "test-v1",
  },
});
assert.equal(
  replacementPanCaptures[0]?.identity.accountNaturalKey,
  panCaptures[0]?.identity.accountNaturalKey,
  "a replacement full PAN may change instrument evidence but never the portfolio account identity",
);
assert.notEqual(
  replacementPanCaptures[0]?.instruments[0]?.instrumentKey,
  panCaptures[0]?.instruments[0]?.instrumentKey,
  "a replacement full PAN may establish a distinct subordinate instrument",
);
assert.throws(
  () =>
    buildFubonCanonicalCreditCardCaptures({
      ...canonicalBuildOptions,
      statementRows: panStatementRows,
      unbilledRows: panUnbilledRows,
      summaries: panSummaries,
      input: panInput,
    }),
  /fingerprint key is unavailable/i,
);
assert.throws(
  () =>
    buildFubonCanonicalCreditCardCaptures({
      ...canonicalBuildOptions,
      statementRows: canonicalStatementRows.map((row, index) =>
        index === 0 ? { ...row, card_label: "正卡 附卡 1234" } : row,
      ),
    }),
  /unambiguous|role/i,
);
assert.throws(
  () =>
    buildFubonCanonicalCreditCardCaptures({
      ...canonicalBuildOptions,
      gridStates: canonicalGridStates.map((state, index) =>
        index === 0 ? { ...state, currentPageSize: "100" } : state,
      ),
    }),
  /terminal|grid/i,
);
assert.throws(
  () =>
    buildFubonCanonicalCreditCardCaptures({
      ...canonicalBuildOptions,
      gridStates: canonicalGridStates.map((state, index) =>
        index === 0 ? { ...state, sourceDeclaredRowCount: 3 } : state,
      ),
    }),
  /totals|drift|partition/i,
);
const repeatedWorkflowCaptures = buildFubonCanonicalCreditCardCaptures({
  ...canonicalBuildOptions,
  captureId: "capture-identical-occurrences",
  statementRows: [canonicalStatementRows[0]!, canonicalStatementRows[0]!, canonicalStatementRows[1]!],
  gridStates: canonicalGridStates.map((state, index) =>
    index === 0 ? { ...state, sourceDeclaredRowCount: 3 } : state,
  ),
});
const repeatedWorkflowRows = repeatedWorkflowCaptures[0]!.transactions.filter(
  (row) => row.description === "SYNTHETIC A",
);
assert.deepEqual(
  repeatedWorkflowRows.map((row) => row.occurrenceIndex),
  [0, 1],
);
assert.notEqual(repeatedWorkflowRows[0]!.sourceKey, repeatedWorkflowRows[1]!.sourceKey);
const singleObservedCardCapture = buildFubonCanonicalCreditCardCaptures({
  captureId: "capture-single-observed-card",
  observedAt: "2026-08-25T00:00:00.000Z",
  statementRows: [
    {
      statement_period: "period-1",
      card_number: "9999",
      card_label: "正卡 9999",
      consume_date: "115/01/03",
      posting_date: "115/01/04",
      description: "SYNTHETIC SINGLE",
      twd_amount: "10.00",
    },
  ],
  unbilledRows: [],
  summaries,
  gridStates: [1, 0, 0, 0, 0, 0, 0].map((sourceDeclaredRowCount) => ({
    currentPage: "1",
    currentPageSize: String(2_147_483_647),
    sourceDeclaredRowCount,
  })),
  input: canonicalInput,
});
assert.equal(singleObservedCardCapture.length, 1);
assert.equal(singleObservedCardCapture[0]?.instruments.length, 1);

const representationProjectionKey = {
  secret: "synthetic-fubon-instrument-projection-key",
  keyVersion: "test-v1",
};
const representationInput = canonicalInput;
const representationGridStates = canonicalGridStates.map((state, index) => ({
  ...state,
  sourceDeclaredRowCount: index === 0 ? 1 : 0,
}));
const maskedRepresentationRows = [
  {
    statement_period: "period-1",
    card_number: "411111******1111",
    card_label: "正卡 411111******1111",
    consume_date: "115/01/03",
    posting_date: "115/01/04",
    description: "SYNTHETIC REPRESENTATION",
    twd_amount: "10.00",
  },
];
const fullPanRepresentationRows = [
  {
    ...maskedRepresentationRows[0]!,
    card_number: "4111111111111111",
    card_label: "正卡 4111 1111 1111 1111",
  },
];
const maskedRepresentationCapture = buildFubonCanonicalCreditCardCaptures({
  ...canonicalBuildOptions,
  captureId: "capture-representation-masked",
  statementRows: maskedRepresentationRows,
  unbilledRows: [],
  gridStates: representationGridStates,
  input: representationInput,
  panFingerprintKey: representationProjectionKey,
});
const fullPanRepresentationCapture = buildFubonCanonicalCreditCardCaptures({
  ...canonicalBuildOptions,
  captureId: "capture-representation-full-pan",
  statementRows: fullPanRepresentationRows,
  unbilledRows: [],
  gridStates: representationGridStates,
  input: representationInput,
  panFingerprintKey: representationProjectionKey,
});
assert.equal(maskedRepresentationCapture.length, 1);
assert.equal(fullPanRepresentationCapture.length, 1);
assert.equal(maskedRepresentationCapture[0]?.instruments.length, 1);
assert.equal(fullPanRepresentationCapture[0]?.instruments.length, 1);
assert.equal(
  maskedRepresentationCapture[0]?.instruments[0]?.instrumentKey,
  fullPanRepresentationCapture[0]?.instruments[0]?.instrumentKey,
  "masked and full-PAN representations must share one safe projected instrument key",
);
assert.equal(
  maskedRepresentationCapture[0]?.transactions[0]?.sourceKey,
  fullPanRepresentationCapture[0]?.transactions[0]?.sourceKey,
);
assert.equal(
  maskedRepresentationCapture[0]?.instruments[0]?.cardMask,
  fullPanRepresentationCapture[0]?.instruments[0]?.cardMask,
);
assert.equal(JSON.stringify(fullPanRepresentationCapture).includes("4111111111111111"), false);
assert.equal(JSON.stringify(fullPanRepresentationCapture).includes("411111******1111"), false);

assert.throws(
  () =>
    buildFubonCanonicalCreditCardCaptures({
      ...canonicalBuildOptions,
      captureId: "capture-representation-collision",
      statementRows: [
        fullPanRepresentationRows[0]!,
        {
          ...fullPanRepresentationRows[0]!,
          card_number: "4111110000091111",
          card_label: "正卡 4111 1100 0009 1111",
          description: "SYNTHETIC REPRESENTATION COLLISION",
        },
      ],
      unbilledRows: [],
      gridStates: representationGridStates.map((state, index) => ({
        ...state,
        sourceDeclaredRowCount: index === 0 ? 2 : 0,
      })),
      input: representationInput,
      panFingerprintKey: representationProjectionKey,
    }),
  /projection|ambiguous|candidate/i,
  "distinct PANs sharing one safe first-six+last-four projection must fail closed",
);

const { commitFubonCreditCardCaptureBatch } =
  await import("../ledger/canonical/fubon-credit-card.ts");
const { createCanonicalSourceStore } =
  await import("../ledger/canonical/canonical-source-store.ts");

for (const [firstCapture, secondCapture, direction] of [
  [maskedRepresentationCapture, fullPanRepresentationCapture, "masked-to-full-pan"],
  [fullPanRepresentationCapture, maskedRepresentationCapture, "full-pan-to-masked"],
] as const) {
  const representationStore = createCanonicalSourceStore(":memory:");
  try {
    await commitFubonCreditCardCaptureBatch(representationStore, firstCapture);
    await commitFubonCreditCardCaptureBatch(representationStore, secondCapture);
    const count = (table: string): number =>
      Number(
        (representationStore.db.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as {
          value?: number;
        }).value ?? 0,
      );
    const transactionSourceRecordCount = Number(
      (
        representationStore.db.prepare(
          `SELECT COUNT(*) AS value
           FROM source_records
           WHERE record_kind = 'fubon-credit-card-transaction'`,
        ).get() as { value?: number }
      ).value ?? 0,
    );
    const transactionProvenanceCount = Number(
      (
        representationStore.db.prepare(
          `SELECT COUNT(*) AS value
           FROM source_record_provenance provenance
           JOIN source_records record
             ON record.source_record_id = provenance.source_record_id
           WHERE record.record_kind = 'fubon-credit-card-transaction'`,
        ).get() as { value?: number }
      ).value ?? 0,
    );
    assert.equal(count("financial_accounts"), 1, direction);
    assert.equal(count("fubon_credit_instrument_details"), 1, direction);
    assert.equal(count("financial_transactions"), 1, direction);
    assert.equal(count("fubon_credit_transaction_details"), 2, direction);
    assert.equal(transactionSourceRecordCount, 2, direction);
    assert.equal(transactionProvenanceCount, 2, direction);
  } finally {
    representationStore.close();
  }
}

const canonicalStore = createCanonicalSourceStore(":memory:");
try {
  const committed = await commitFubonCreditCardCaptureBatch(
    canonicalStore,
    canonicalCaptures,
  );
  assert.equal(committed.length, 1);
  const repeatedCommitted = await commitFubonCreditCardCaptureBatch(
    canonicalStore,
    buildFubonCanonicalCreditCardCaptures({
      ...canonicalBuildOptions,
      captureId: "capture-synthetic-repeat",
      input: canonicalInput,
    }),
  );
  assert.equal(repeatedCommitted.length, 1);
  const sharedCount = (table: string): number =>
    Number(
      (canonicalStore.db.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as {
        value?: number;
      }).value ?? 0,
    );
  assert.equal(sharedCount("financial_accounts"), 1);
  assert.equal(sharedCount("source_captures"), 2);
  assert.equal(sharedCount("fubon_credit_instrument_details"), 2);
  assert.equal(sharedCount("financial_transactions"), 3);
  assert.equal(sharedCount("fubon_credit_statement_details"), 5);
} finally {
  canonicalStore.close();
}
const crossPeriodStore = createCanonicalSourceStore(":memory:");
try {
  await commitFubonCreditCardCaptureBatch(
    crossPeriodStore,
    crossPeriodForwardCapture,
  );
  const count = (table: string): number =>
    Number(
      (crossPeriodStore.db.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as {
        value?: number;
      }).value ?? 0,
    );
  const authorityTransactionCount = count("financial_transactions");
  const transactionRevisionCount = count("transaction_revisions");
  const statementRevisionCount = count("fubon_credit_statement_revision_details");
  await commitFubonCreditCardCaptureBatch(
    crossPeriodStore,
    crossPeriodReverseCapture,
  );
  assert.equal(count("financial_transactions"), authorityTransactionCount);
  assert.equal(count("transaction_revisions"), transactionRevisionCount);
  assert.equal(
    count("fubon_credit_statement_revision_details"),
    statementRevisionCount,
    "reversing tab order must not create a new statement revision",
  );
} finally {
  crossPeriodStore.close();
}
const rollingStore = createCanonicalSourceStore(":memory:");
try {
  await commitFubonCreditCardCaptureBatch(
    rollingStore,
    rollingInitialCapture,
  );
  const count = (table: string): number =>
    Number(
      (rollingStore.db.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as {
        value?: number;
      }).value ?? 0,
    );
  const authorityTransactionCount = count("financial_transactions");
  const transactionRevisionCount = count("transaction_revisions");
  const period2RevisionCount = Number(
    (
      rollingStore.db.prepare(
        `SELECT COUNT(*) AS value
         FROM fubon_credit_statement_revision_details revision
         JOIN fubon_credit_statement_details statement
           ON statement.statement_id = revision.statement_id
         WHERE statement.statement_key = ?`,
      ).get(rollingInitialPeriod2Statement.statementKey) as { value?: number }
    ).value ?? 0,
  );
  await commitFubonCreditCardCaptureBatch(rollingStore, rollingNextCapture);
  assert.equal(count("financial_transactions"), authorityTransactionCount);
  assert.equal(count("transaction_revisions"), transactionRevisionCount);
  assert.equal(
    Number(
      (
        rollingStore.db.prepare(
          `SELECT COUNT(*) AS value
           FROM fubon_credit_statement_revision_details revision
           JOIN fubon_credit_statement_details statement
             ON statement.statement_id = revision.statement_id
           WHERE statement.statement_key = ?`,
        ).get(rollingNextPeriod2Statement.statementKey) as { value?: number }
      ).value ?? 0,
    ),
    period2RevisionCount,
    "a rolling window must not create a new revision for a retained statement",
  );
} finally {
  rollingStore.close();
}
assert.match(source, /commitFubonCreditCardCaptureBatch/);
assert.match(source, /canonicalFinancialLedgerDir/);
