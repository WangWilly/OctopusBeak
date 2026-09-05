import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./browser-interaction.js") {
      return nextResolve("./browser-interaction.ts", context);
    }
    if (specifier === "./yuanta-statements.js") {
      return nextResolve("./yuanta-statements.ts", context);
    }
    return nextResolve(specifier, context);
  },
});

const {
  buildYuantaCanonicalCreditCardCaptures,
  deriveYuantaCanonicalHumanAttestation,
  deriveYuantaProjectedInstrumentIdentity,
  diagnoseYuantaCreditCardHistoryHtml,
  collectYuantaCreditCardHistorySummaries,
  hasUntraversedPager,
  isCreditCardProductAbsentText,
  diagnoseYuantaCreditCardSummaryHtml,
  parseYuantaCreditCardSettledStatementSummaries,
  parseYuantaCreditCardSettledStatementHistoryPage,
  pauseBeforeYuantaCreditCardHistorySummaryParse,
  resolveYuantaSettledStatementCycles,
  toYuantaCanonicalCreditCardSourceRow,
  submitCreditCardMonthOptions,
  traverseYuantaCreditCardSettledStatementSummaryPages,
  YUANTA_CREDIT_CARD_HISTORY_DIAGNOSTIC_SOURCE_KEY,
  YUANTA_CREDIT_CARD_SETTLED_SUMMARY_PARSER_CONTRACT,
  YuantaCreditCardSummaryParseError,
  yuantaCanonicalHumanAttestationFromEnvironment,
  yuantaCreditCardCaptureBuilderOptions,
  yuantaCreditCardTerminalPagesFromHtml,
  yuantaInspectFirstHistorySummaryEnabled,
  YUANTA_INSPECT_FIRST_HISTORY_SUMMARY_ENV,
} = await import("./yuanta-credit-card-statements.ts");
const {
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST,
} = await import("../ledger/canonical/yuanta-credit-card-human-attestation.ts");

assert.equal(
  YUANTA_CREDIT_CARD_SETTLED_SUMMARY_PARSER_CONTRACT,
  "yuanta-credit-card.settled-summary-parser.v7-exact-period-balance-a",
);
assert.equal(
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.semantics
    .settledSummaryParserContract,
  YUANTA_CREDIT_CARD_SETTLED_SUMMARY_PARSER_CONTRACT,
);

const previousInspectionEnv = process.env[YUANTA_INSPECT_FIRST_HISTORY_SUMMARY_ENV];
const previousInspectionNodeEnv = process.env.NODE_ENV;
try {
  delete process.env[YUANTA_INSPECT_FIRST_HISTORY_SUMMARY_ENV];
  delete process.env.NODE_ENV;
  assert.equal(yuantaInspectFirstHistorySummaryEnabled(false), false);
  assert.equal(yuantaInspectFirstHistorySummaryEnabled(true), true);
  process.env[YUANTA_INSPECT_FIRST_HISTORY_SUMMARY_ENV] = "1";
  assert.equal(yuantaInspectFirstHistorySummaryEnabled(false), true);
  process.env[YUANTA_INSPECT_FIRST_HISTORY_SUMMARY_ENV] = "true";
  assert.equal(yuantaInspectFirstHistorySummaryEnabled(false), false);
  process.env.NODE_ENV = "production";
  process.env[YUANTA_INSPECT_FIRST_HISTORY_SUMMARY_ENV] = "1";
  assert.equal(yuantaInspectFirstHistorySummaryEnabled(true), false);
} finally {
  if (previousInspectionEnv === undefined)
    delete process.env[YUANTA_INSPECT_FIRST_HISTORY_SUMMARY_ENV];
  else process.env[YUANTA_INSPECT_FIRST_HISTORY_SUMMARY_ENV] = previousInspectionEnv;
  if (previousInspectionNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousInspectionNodeEnv;
}

const settledSummaryFixture = `
  <section>
    <table class="summary">
      <tr><th>帳單月份</th><th>結帳日</th><th>出帳日</th><th>繳款截止日</th><th>本期應繳總額</th><th>本期最低應繳額</th><th>繳款狀態</th></tr>
      <tr><td>115/06</td><td>115/06/20</td><td>115/06/21</td><td>115/07/05</td><td>NT$ 1,234.00</td><td>123</td><td>未繳</td></tr>
      <tr><td>115/05</td><td>115/05/20</td><td>115/05/21</td><td>115/06/05</td><td>2,000</td><td>200</td><td>已繳</td></tr>
      <tr><td>115/04</td><td>115/04/20</td><td>115/04/21</td><td>115/05/05</td><td>3,000</td><td>300</td><td>部分繳款</td></tr>
    </table>
  </section>
`;
const issuerSummaries = parseYuantaCreditCardSettledStatementSummaries(
  settledSummaryFixture,
);
assert.equal(issuerSummaries.length, 3);
assert.deepEqual(issuerSummaries[0], {
  period: "115/06",
  closeDate: "2026-06-20",
  issueDate: "2026-06-21",
  dueDate: "2026-07-05",
  balance: "1234.00",
  minimumPayment: "123",
  paymentStatus: "未繳",
});
for (const [rawPeriod, expectedPeriod] of [
  ["民國115年06月", "115/06"],
  ["115年06月份", "115/06"],
  ["2026年06月", "2026/06"],
  ["115 年 06 月", "115/06"],
  ["帳單月份： （ 115.06 ）", "115/06"],
] as const) {
  const formattedSummaries = parseYuantaCreditCardSettledStatementSummaries(
    settledSummaryFixture.replace("115/06", rawPeriod),
  );
  assert.equal(formattedSummaries[0]?.period, expectedPeriod);
}
for (const rawPeriod of ["2026/06月", "2026/06月份", "2026/06期"]) {
  const formattedSummaries = parseYuantaCreditCardSettledStatementSummaries(
    settledSummaryFixture.replace("115/06", rawPeriod),
  );
  assert.equal(formattedSummaries[0]?.period, "2026/06");
}
for (const invalidPeriod of [
  "115/06/20",
  "115/13",
  "115/00",
  "115/06 116/07",
  "民國2026年06月",
  "115年06月及115年07月",
  "2026/06/20",
  "2026/06摘要",
  "2026/06月摘要",
  "2026/13期",
]) {
  assert.throws(
    () =>
      parseYuantaCreditCardSettledStatementSummaries(
        settledSummaryFixture.replace("115/06", invalidPeriod),
      ),
    /period.*(?:invalid|ambiguous)/iu,
  );
}
const invalidPeriodShapeCases = [
  {
    raw: "115/06/20",
    shape: "full-date",
    digitGroupLengths: [3, 2, 2],
    separatorIds: ["slash"],
  },
  {
    raw: "NT$1,234",
    shape: "money",
    digitGroupLengths: [1, 3],
    separatorIds: [],
  },
  {
    raw: "4111-1111-1111-1111",
    shape: "other",
    digitGroupLengths: [4, 4, 4, 4],
    separatorIds: ["dash"],
  },
] as const;
for (const testCase of invalidPeriodShapeCases) {
  const diagnostic = diagnoseYuantaCreditCardSummaryHtml(
    settledSummaryFixture.replace("115/06", testCase.raw),
  );
  assert.equal(diagnostic.invalidFieldFamily, "period");
  assert.equal(diagnostic.invalidValueShapeClass, testCase.shape);
  assert.deepEqual(
    diagnostic.invalidValueDigitGroupLengths,
    testCase.digitGroupLengths,
  );
  assert.deepEqual(diagnostic.invalidValueSeparatorIds, testCase.separatorIds);
  assert.equal(diagnostic.invalidValueCellTagPairIds.length > 0, true);
  assert.equal(diagnostic.invalidValueLayoutPositionIds.length > 0, true);
  assert.equal(typeof diagnostic.invalidValueCellCount, "number");
  assert.equal(typeof diagnostic.invalidValueLabelCellCount, "number");
  assert.notEqual(diagnostic.invalidValueRawLengthBucket, null);
  assert.equal(diagnostic.invalidValueContainsKnownLabel, false);
  const serializedDiagnostic = JSON.stringify(diagnostic);
  assert.equal(serializedDiagnostic.includes(testCase.raw), false);
  assert.equal(serializedDiagnostic.includes("4111-1111-1111-1111"), false);
}
const splitSummaryFixture = `
  <section class="summary-result">
    <div class="summary-card">
      <table class="summary-meta">
        <tr><th>帳單月份</th><th>本期應繳金額</th><th>已繳款金額</th></tr>
        <tr><td>115/06</td><td>NT$ 1,234.00</td><td>0</td></tr>
      </table>
      <table class="summary-dates">
        <tr><th>結帳日</th><td>115/06/20</td></tr>
        <tr><th>繳款截止日</th><td>115/07/05</td></tr>
        <tr><th>本期最低應繳額</th><td>123</td></tr>
      </table>
    </div>
  </section>
`;
assert.deepEqual(
  parseYuantaCreditCardSettledStatementSummaries(splitSummaryFixture),
  [{
    period: "115/06",
    closeDate: "2026-06-20",
    issueDate: "2026-06-20",
    dueDate: "2026-07-05",
    balance: "1234.00",
    minimumPayment: "123",
  }],
);
assert.deepEqual(
  diagnoseYuantaCreditCardSummaryHtml(splitSummaryFixture).requiredFields,
  {
    period: true,
    closeDate: true,
    dueDate: true,
    balance: true,
    minimumPayment: true,
  },
);
const ambiguousPeriodSplitFixture = `
  <section class="summary-result">
    <div class="summary-card">
      <table class="summary-periods">
        <tr><th>帳單月份</th><th>本期應繳金額</th></tr>
        <tr><td>115/06</td><td>1,234</td></tr>
        <tr><td>115/05</td><td>2,000</td></tr>
      </table>
      <table class="summary-dates">
        <tr><th>結帳日</th><td>115/06/20</td></tr>
        <tr><th>繳款截止日</th><td>115/07/05</td></tr>
        <tr><th>本期最低應繳額</th><td>123</td></tr>
      </table>
    </div>
  </section>
`;
assert.throws(
  () => parseYuantaCreditCardSettledStatementSummaries(ambiguousPeriodSplitFixture),
  /ambiguous|boundary|summary/u,
);
const conflictingTotalSplitFixture = splitSummaryFixture.replace(
  /(<table class="summary-dates">[\s\S]*?)(<\/table>)/u,
  "$1<tr><th>本期應繳金額</th><td>2,000</td></tr>$2",
);
assert.throws(
  () => parseYuantaCreditCardSettledStatementSummaries(conflictingTotalSplitFixture),
  /conflicting|summary/u,
);
const settledCycles = resolveYuantaSettledStatementCycles(issuerSummaries);
assert.deepEqual(settledCycles.map((cycle) => [cycle.period, cycle.cycleStart, cycle.cycleEnd]), [
  ["115/05", "2026-04-21", "2026-05-20"],
  ["115/06", "2026-05-21", "2026-06-20"],
]);
assert.throws(
  () => parseYuantaCreditCardSettledStatementSummaries("<table><tr><td>結帳日</td><td>115/06/20</td></tr></table>"),
  /summary|missing|incomplete|issuer/u,
);
const incompleteSummaryFixture = `
  <section class="summary-result">
    <table class="summary">
      <tr><th>帳單月份</th><th>結帳日</th><th>繳款截止日</th><th>本期應繳總額</th><th>本期最低應繳額</th></tr>
      <tr><td>115/06</td><td>115/06/20</td><td>115/07/05</td><td></td><td></td></tr>
    </table>
  </section>
`;
let incompleteSummaryError: unknown;
try {
  parseYuantaCreditCardSettledStatementSummaries(incompleteSummaryFixture);
} catch (error) {
  incompleteSummaryError = error;
}
assert.ok(incompleteSummaryError instanceof YuantaCreditCardSummaryParseError);
if (incompleteSummaryError instanceof YuantaCreditCardSummaryParseError) {
  const diagnostic = incompleteSummaryError.diagnostic;
  assert.equal(diagnostic.summaryPageCount, 1);
  assert.equal(diagnostic.candidateFound, true);
  assert.equal(diagnostic.candidateTableCount, 1);
  assert.equal(diagnostic.candidateRowCount, 2);
  assert.deepEqual(diagnostic.requiredFields, {
    period: true,
    closeDate: true,
    dueDate: true,
    balance: true,
    minimumPayment: true,
  });
  assert.equal(diagnostic.parsedUniquePeriodCount, 1);
  assert.equal(diagnostic.allRequiredFields, false);
  assert.equal(diagnostic.candidateGroupCount, 1);
  assert.equal(diagnostic.completeGroupCount, 0);
  assert.deepEqual(diagnostic.partialGroupFieldMasks, ["11101"]);
  assert.equal(diagnostic.ambiguityReason, "value-invalid");
  assert.equal(diagnostic.invalidFieldFamily, "minimumPayment");
  assert.deepEqual(diagnostic.extractionStrategyIds, ["table-header-matrix"]);
  assert.deepEqual(diagnostic.matchedAliasIds, [
    "period.billing-month",
    "close-date.settlement-date",
    "due-date.payment-deadline",
    "balance.total-due",
    "minimum-payment.minimum-due",
  ]);
  const serializedDiagnostic = JSON.stringify(diagnostic);
  assert.equal(serializedDiagnostic.includes("115/06"), false);
  assert.equal(serializedDiagnostic.includes("115/06/20"), false);
  assert.equal(serializedDiagnostic.includes("1,234"), false);
  assert.equal(serializedDiagnostic.includes("PAN"), false);
}
assert.deepEqual(
  diagnoseYuantaCreditCardSummaryHtml(incompleteSummaryFixture).requiredFields,
  {
    period: true,
    closeDate: true,
    dueDate: true,
    balance: true,
    minimumPayment: true,
  },
);
assert.throws(
  () => parseYuantaCreditCardSettledStatementSummaries(
    settledSummaryFixture.replace(
      "</section>",
      '<div class="summary-pagination"><a class="pager" href="javascript:goPage(2)">下一頁</a></div></section>',
    ),
  ),
  /untraversed pagination/u,
);
assert.throws(
  () =>
    parseYuantaCreditCardSettledStatementSummaries(
      settledSummaryFixture.replace("NT$ 1,234.00", "not-an-amount"),
    ),
  /balance|invalid|summary/u,
);
assert.throws(
  () =>
    parseYuantaCreditCardSettledStatementSummaries(
      settledSummaryFixture.replace("115/07/05", "115/02/31"),
    ),
  /due|invalid|summary/u,
);
assert.throws(
  () =>
    parseYuantaCreditCardSettledStatementSummaries(
      settledSummaryFixture.replace(
        "<tr><td>115/04</td>",
        "<tr><td>115/05</td>",
      ),
    ),
  /unique|period|summary/u,
);
assert.throws(
  () =>
    resolveYuantaSettledStatementCycles([
      issuerSummaries[0]!,
      {
        ...issuerSummaries[1]!,
        closeDate: "2026-07-20",
        issueDate: "2026-07-21",
        dueDate: "2026-08-05",
      },
      issuerSummaries[2]!,
    ]),
  /monotonic/u,
);

const noPagerResponse = `
  <table class="rwdTable"><tr><td>本期帳單</td></tr></table>
  <a onclick="queryMonth('0')">115/06</a>
`;
const pagerResponse = `
  <table class="rwdTable"><tr><td>本期帳單</td></tr></table>
  <a class="pager" href="javascript:goPage(2)">下一頁</a>
`;

assert.equal(hasUntraversedPager(noPagerResponse), false);
assert.equal(hasUntraversedPager(pagerResponse), true);
assert.equal(
  hasUntraversedPager('<nav><a class="next" href="/other/next">下一頁</a></nav><p>第2頁</p>'),
  true,
);
assert.equal(hasUntraversedPager("<p>第2頁</p>"), false);
assert.doesNotThrow(() =>
  parseYuantaCreditCardSettledStatementSummaries(
    `<nav><a class="next" href="/menu/next">下一頁</a></nav>${settledSummaryFixture}`,
  ),
);
assert.doesNotThrow(() =>
  parseYuantaCreditCardSettledStatementSummaries(
    `<main><nav><a class="next" href="/menu/next">下一頁</a></nav>${settledSummaryFixture}</main>`,
  ),
);
assert.equal(isCreditCardProductAbsentText("目前未持有信用卡"), true);
assert.equal(isCreditCardProductAbsentText("查無資料"), false);

const summaryPageOne = settledSummaryFixture
  .replace(
    /\s*<tr><td>115\/04<\/td>[\s\S]*?<\/tr>/u,
    "",
  )
  .replace(
    "</section>",
    '<div class="summary-pagination"><a class="pager" href="javascript:goPage(2)">下一頁</a></div></section>',
  );
const summaryPageTwo = `
  <section class="summary-result">
    <table class="summary">
      <tr><th>帳單月份</th><th>結帳日</th><th>出帳日</th><th>繳款截止日</th><th>本期應繳總額</th><th>本期最低應繳額</th><th>繳款狀態</th></tr>
      <tr><td>115/04</td><td>115/04/20</td><td>115/04/21</td><td>115/05/05</td><td>3,000</td><td>300</td><td>部分繳款</td></tr>
    </table>
  </section>
`;
const traversalRequests: number[] = [];
const traversed = await traverseYuantaCreditCardSettledStatementSummaryPages(
  summaryPageOne,
  async (request) => {
    traversalRequests.push(request.pageOrdinal);
    assert.equal(request.pageTarget, "page:2");
    return summaryPageTwo;
  },
);
assert.deepEqual(traversalRequests, [1]);
assert.deepEqual(
  traversed.summaries.map((summary) => summary.period),
  ["115/06", "115/05", "115/04"],
);
assert.deepEqual(
  traversed.pages.map((page) => [page.pageOrdinal, page.terminal]),
  [[0, false], [1, true]],
);
assert.deepEqual(
  parseYuantaCreditCardSettledStatementSummaries(summaryPageTwo).map(
    (summary) => summary.period,
  ),
  ["115/04"],
);
await assert.rejects(
  traverseYuantaCreditCardSettledStatementSummaryPages(
    summaryPageOne,
    async () => summaryPageOne,
  ),
  /repeated page/u,
);

const submitted: number[] = [];
const handled: number[] = [];
const inspectionPauseCalls: string[] = [];
await pauseBeforeYuantaCreditCardHistorySummaryParse({
  enabled: false,
  session: "yuanta-debug-session",
  monthIndex: 0,
  pageOrdinal: 0,
  pauseFn: async (session) => {
    inspectionPauseCalls.push(session);
  },
});
await pauseBeforeYuantaCreditCardHistorySummaryParse({
  enabled: true,
  session: "yuanta-debug-session",
  monthIndex: 1,
  pageOrdinal: 1,
  pauseFn: async (session) => {
    inspectionPauseCalls.push(session);
  },
});
assert.equal(inspectionPauseCalls.length, 0);
await pauseBeforeYuantaCreditCardHistorySummaryParse({
  enabled: true,
  session: "yuanta-debug-session",
  monthIndex: 0,
  pageOrdinal: 0,
  pauseFn: async (session) => {
    inspectionPauseCalls.push(session);
  },
});
assert.deepEqual(inspectionPauseCalls, ["yuanta-debug-session"]);
const previousNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "production";
try {
  await pauseBeforeYuantaCreditCardHistorySummaryParse({
    enabled: true,
    session: "yuanta-debug-session",
    monthIndex: 0,
    pageOrdinal: 0,
    pauseFn: async (session) => {
      inspectionPauseCalls.push(session);
    },
  });
  assert.deepEqual(inspectionPauseCalls, ["yuanta-debug-session"]);
} finally {
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
}
await submitCreditCardMonthOptions(
  [
    { index: 0, label: "115/06" },
    { index: 1, label: "115/05" },
  ],
  async (month) => {
    submitted.push(month.index);
    return noPagerResponse;
  },
  (month) => {
    handled.push(month.index);
  },
);
assert.deepEqual(submitted, [0, 1]);
assert.deepEqual(handled, [0, 1]);
await assert.rejects(
  submitCreditCardMonthOptions(
    [{ index: 0, label: "115/06" }],
    async () => pagerResponse,
    () => assert.fail("truncated response must not be handled"),
  ),
  /untraversed pagination/,
);

const historyPageSettledFieldsFixture = `
  <section class="history-result">
    <table class="history-transactions">
      <tr><th>消費日期</th><th>入帳日期</th><th>消費明細</th><th>新臺幣金額</th></tr>
      <tr><td>115/06/01</td><td>115/06/02</td><td>TEST PAN 4111-1111-1111-1111</td><td>1,234.00</td></tr>
    </table>
    <div class="settled-summary-card">
      <table class="payment-summary">
        <tr><th>已繳款金額</th><th>本期應繳金額</th></tr>
        <tr><td>0</td><td>1,234.00</td></tr>
      </table>
      <dl>
        <dt>結帳日</dt><dd>115/06/20</dd>
        <dt>繳款截止日</dt><dd>115/07/05</dd>
        <dt>本期最低應繳額</dt><dd>123</dd>
      </dl>
    </div>
  </section>
`;
const historyDiagnostic = diagnoseYuantaCreditCardHistoryHtml(
  historyPageSettledFieldsFixture,
  5,
);
assert.deepEqual(historyDiagnostic, {
  sourceKey: YUANTA_CREDIT_CARD_HISTORY_DIAGNOSTIC_SOURCE_KEY,
  monthIndex: 5,
  candidateFound: true,
  candidateContainerCount: 3,
  candidateTableCount: 1,
  candidateRowCount: 2,
  requiredFields: {
    period: false,
    closeDate: true,
    dueDate: true,
    balance: true,
    minimumPayment: true,
  },
  matchedAliasIds: [
    "close-date.settlement-date",
    "due-date.payment-deadline",
    "balance.total-due",
    "minimum-payment.minimum-due",
  ],
  allRequiredFields: false,
  candidateGroupCount: 1,
  completeGroupCount: 0,
  partialGroupFieldMasks: ["01111"],
  ambiguityReason: "partial-candidate",
  invalidFieldFamily: null,
  invalidValueShapeClass: null,
  invalidValueDigitGroupLengths: [],
  invalidValueSeparatorIds: [],
  invalidValueCellTagPairIds: [],
  invalidValueLayoutPositionIds: [],
  invalidValueCellCount: null,
  invalidValueLabelCellCount: null,
  invalidValueRawLengthBucket: null,
  invalidValueContainsKnownLabel: null,
  extractionStrategyIds: ["table-key-value-pairs"],
  parserContractId: YUANTA_CREDIT_CARD_SETTLED_SUMMARY_PARSER_CONTRACT,
  fieldSourceLayoutIds: ["text-label-value"],
  fieldSourceLayoutByField: {
    period: [],
    closeDate: ["text-label-value"],
    dueDate: ["text-label-value"],
    balance: ["text-label-value"],
    minimumPayment: ["text-label-value"],
  },
});
assert.equal(JSON.stringify(historyDiagnostic).includes("115/06"), false);
assert.equal(JSON.stringify(historyDiagnostic).includes("115/06/20"), false);
assert.equal(JSON.stringify(historyDiagnostic).includes("1,234"), false);
assert.equal(JSON.stringify(historyDiagnostic).includes("4111-1111-1111-1111"), false);
assert.deepEqual(
  diagnoseYuantaCreditCardHistoryHtml(historyPageSettledFieldsFixture, 0)
    .monthIndex,
  0,
);
assert.equal(
  diagnoseYuantaCreditCardHistoryHtml(historyPageSettledFieldsFixture, 0)
    .sourceKey,
  YUANTA_CREDIT_CARD_HISTORY_DIAGNOSTIC_SOURCE_KEY,
);
const singleTableSplitRowsFixture = `
  <section class="history-result">
    <table class="settled-summary">
      <tr><th>帳單月份</th><td>115/06</td><th>結帳日</th><td>115/06/20</td></tr>
      <tr><th>繳款截止日</th><td>115/07/05</td><th>本期應繳總額</th><td>1,234</td></tr>
      <tr><th>本期最低應繳額</th><td>123</td><th>繳款狀態</th><td>未繳</td></tr>
      <tr><td>備註</td><td>已結帳</td></tr>
    </table>
  </section>
`;
const groupedLabelValueRowsFixture = `
  <section class="history-result">
    <table class="settled-summary">
      <tr><th>帳單月份</th><th>結帳日</th></tr>
      <tr><td>115/06</td><td>115/06/20</td></tr>
      <tr><th>繳款截止日</th><th>本期應繳總額</th><th>本期最低應繳額</th></tr>
      <tr><td>115/07/05</td><td>1,234</td><td>123</td></tr>
    </table>
  </section>
`;
const groupedLabelValueRowsDiagnostic = diagnoseYuantaCreditCardHistoryHtml(
  groupedLabelValueRowsFixture,
  0,
);
assert.equal(groupedLabelValueRowsDiagnostic.allRequiredFields, true);
assert.equal(groupedLabelValueRowsDiagnostic.candidateGroupCount, 1);
assert.equal(groupedLabelValueRowsDiagnostic.completeGroupCount, 1);
assert.deepEqual(groupedLabelValueRowsDiagnostic.partialGroupFieldMasks, []);
assert.equal(groupedLabelValueRowsDiagnostic.ambiguityReason, "none");
assert.deepEqual(groupedLabelValueRowsDiagnostic.extractionStrategyIds, [
  "table-grouped-label-rows",
]);
assert.doesNotMatch(
  JSON.stringify(groupedLabelValueRowsDiagnostic),
  /115\/06|115\/06\/20|1,234|PAN/iu,
);
assert.doesNotThrow(() => {
  const { summary } = parseYuantaCreditCardSettledStatementHistoryPage(
    groupedLabelValueRowsFixture,
    { index: 0, label: "115/06" },
    0,
  );
  assert.equal(summary.period, "115/06");
  assert.equal(summary.closeDate, "2026-06-20");
  assert.equal(summary.balance, "1234");
    assert.equal(summary.minimumPayment, "123");
});
const verticalLabelValueGridFixture = `
  <section class="fmain">
    <div class="cardBx Mb_m">
      <div class="card-title">帳單月份 999/99</div>
      <a class="month-tab" href="#">115/05</a>
      <table class="rwdTable">
        <tr><th>帳單月份</th><th>期間提示</th><th>結帳日</th><th>繳款截止日</th><th>本期應繳總額</th></tr>
        <tr><td>115/06</td><td>DECOY-PERIOD-VALUE</td><td>115/06/20</td><td>115/07/05</td><td>NT$ 1,234.00</td></tr>
        <tr><th>本期最低應繳額</th><th>欄位說明</th><th>保留欄位</th><th>備註</th><th>狀態提示</th></tr>
        <tr><td>123</td><td>備註值</td><td>保留值</td><td>說明值</td><td>狀態值</td></tr>
      </table>
    </div>
  </section>
`;
const verticalSummary = parseYuantaCreditCardSettledStatementSummaries(
  verticalLabelValueGridFixture,
);
assert.equal(verticalSummary.length, 1);
assert.deepEqual(verticalSummary[0], {
  period: "115/06",
  closeDate: "2026-06-20",
  issueDate: "2026-06-20",
  dueDate: "2026-07-05",
  balance: "1234.00",
  minimumPayment: "123",
});
const verticalDiagnostic = diagnoseYuantaCreditCardSummaryHtml(
  verticalLabelValueGridFixture,
);
assert.equal(verticalDiagnostic.allRequiredFields, true);
assert.equal(verticalDiagnostic.completeGroupCount, 1);
assert.deepEqual(verticalDiagnostic.extractionStrategyIds, [
  "table-vertical-grid",
]);
assert.doesNotMatch(
  JSON.stringify(verticalDiagnostic),
  /DECOY-PERIOD-VALUE|999\/99/iu,
);
const invalidVerticalPeriodDiagnostic = diagnoseYuantaCreditCardSummaryHtml(
  verticalLabelValueGridFixture.replace("115/06", "2026/06月摘要"),
);
assert.equal(invalidVerticalPeriodDiagnostic.invalidFieldFamily, "period");
assert.deepEqual(
  invalidVerticalPeriodDiagnostic.invalidValueCellTagPairIds,
  ["th->td"],
);
assert.deepEqual(
  invalidVerticalPeriodDiagnostic.invalidValueLayoutPositionIds,
  ["vertical-grid-same-column"],
);
assert.doesNotMatch(
  JSON.stringify(invalidVerticalPeriodDiagnostic),
  /2026\/06月摘要|DECOY-PERIOD-VALUE/iu,
);
const verticalHistory = parseYuantaCreditCardSettledStatementHistoryPage(
  verticalLabelValueGridFixture,
  { index: 0, label: "115/06" },
  0,
);
assert.equal(verticalHistory.summary.period, "115/06");
assert.equal(verticalHistory.summary.balance, "1234.00");
assert.equal(verticalHistory.summary.minimumPayment, "123");
const verticalSourceInvariantFixture = verticalLabelValueGridFixture
  .replace("<th>期間提示</th>", "<th>2026/06/99</th>")
  .replace("<td>115/06</td>", "<td>2026/06月</td>");
const verticalSourceInvariantSummary =
  parseYuantaCreditCardSettledStatementSummaries(
    verticalSourceInvariantFixture,
  );
assert.equal(verticalSourceInvariantSummary[0]?.period, "2026/06");
const invalidVerticalSourceInvariantDiagnostic =
  diagnoseYuantaCreditCardSummaryHtml(
    verticalSourceInvariantFixture.replace(
      "<td>2026/06月</td>",
      "<td>2026/06摘要</td>",
    ),
  );
assert.equal(invalidVerticalSourceInvariantDiagnostic.invalidFieldFamily, "period");
assert.deepEqual(
  invalidVerticalSourceInvariantDiagnostic.invalidValueCellTagPairIds,
  ["th->td"],
);
assert.deepEqual(
  invalidVerticalSourceInvariantDiagnostic.invalidValueLayoutPositionIds,
  ["vertical-grid-same-column"],
);
assert.doesNotMatch(
  JSON.stringify(invalidVerticalSourceInvariantDiagnostic),
  /2026\/06摘要|2026\/06\/99/iu,
);
assert.deepEqual(
  invalidVerticalSourceInvariantDiagnostic.fieldSourceLayoutByField.period,
  ["vertical-grid-same-column"],
);
const mixedRowPeriodColumnFixture = `
  <section class="fmain">
    <div class="cardBx Mb_m">
      <table class="rwdTable">
        <tr><th>帳單月份</th><th>2026/06/99</th><th>結帳日</th><th>繳款截止日</th><th>摘要提示</th></tr>
        <tr><th>2026/06月</th><th>欄位提示</th><th>結帳日</th><th>繳款截止日</th><th>摘要值</th></tr>
        <tr><th>結帳日</th><th>繳款截止日</th><th>本期應繳總額</th><th>本期最低應繳額</th><th>備註</th></tr>
        <tr><td>115/06/20</td><td>115/07/05</td><td>NT$ 1,234.00</td><td>123</td><td>備註值</td></tr>
      </table>
    </div>
  </section>
`;
const mixedRowPeriodColumnSummary =
  parseYuantaCreditCardSettledStatementSummaries(
    mixedRowPeriodColumnFixture,
  );
assert.equal(mixedRowPeriodColumnSummary.length, 1);
assert.deepEqual(mixedRowPeriodColumnSummary[0], {
  period: "2026/06",
  closeDate: "2026-06-20",
  issueDate: "2026-06-20",
  dueDate: "2026-07-05",
  balance: "1234.00",
  minimumPayment: "123",
});
const mixedRowPeriodColumnDiagnostic = diagnoseYuantaCreditCardSummaryHtml(
  mixedRowPeriodColumnFixture,
);
assert.equal(mixedRowPeriodColumnDiagnostic.allRequiredFields, true);
assert.deepEqual(mixedRowPeriodColumnDiagnostic.extractionStrategyIds, [
  "table-vertical-grid",
]);
assert.equal(
  mixedRowPeriodColumnDiagnostic.parserContractId,
  YUANTA_CREDIT_CARD_SETTLED_SUMMARY_PARSER_CONTRACT,
);
assert.deepEqual(mixedRowPeriodColumnDiagnostic.fieldSourceLayoutIds, [
  "vertical-grid-same-column",
]);
assert.deepEqual(mixedRowPeriodColumnDiagnostic.fieldSourceLayoutByField, {
  period: ["vertical-grid-same-column"],
  closeDate: ["vertical-grid-same-column"],
  dueDate: ["vertical-grid-same-column"],
  balance: ["vertical-grid-same-column"],
  minimumPayment: ["vertical-grid-same-column"],
});
assert.doesNotMatch(
  JSON.stringify(mixedRowPeriodColumnDiagnostic),
  /2026\/06\/99|欄位提示|115\/06\/20|1,234/iu,
);
const verticalPeriodTextSupplementFixture = `
  <section class="summary-result">
    <table class="rwdTable">
      <tr><th>帳單月份</th><th>本期應繳金額</th><th>已繳款金額</th></tr>
      <tr><td>2026/06月</td><td>1,234</td><td>9,999</td></tr>
    </table>
    <p>帳單月份：2026/05 顯示月份（非權威）　已繳款金額：999,999　結帳日：115/06/20 繳款截止日：115/07/05 本期應繳總額：888,888 本期最低應繳額：123</p>
  </section>
`;
const verticalPeriodTextSupplementDiagnostic =
  diagnoseYuantaCreditCardSummaryHtml(verticalPeriodTextSupplementFixture);
assert.equal(verticalPeriodTextSupplementDiagnostic.allRequiredFields, true);
assert.deepEqual(
  verticalPeriodTextSupplementDiagnostic.fieldSourceLayoutByField,
  {
    period: ["vertical-grid-same-column"],
    closeDate: ["text-label-value"],
    dueDate: ["text-label-value"],
    balance: ["vertical-grid-same-column"],
    minimumPayment: ["text-label-value"],
  },
);
assert.deepEqual(
  parseYuantaCreditCardSettledStatementSummaries(
    verticalPeriodTextSupplementFixture,
  ),
  [{
    period: "2026/06",
    closeDate: "2026-06-20",
    issueDate: "2026-06-20",
    dueDate: "2026-07-05",
    balance: "1234",
    minimumPayment: "123",
  }],
);
assert.doesNotMatch(
  JSON.stringify(verticalPeriodTextSupplementDiagnostic),
  /2026\/05|9,999|999,999|888,888/iu,
);
assert.throws(
  () =>
    parseYuantaCreditCardSettledStatementSummaries(
      verticalPeriodTextSupplementFixture.replace(
        "<th>本期應繳金額</th>",
        "<th>摘要提示</th>",
      ),
    ),
  /balance|summary/iu,
);
assert.throws(
  () =>
    parseYuantaCreditCardSettledStatementSummaries(
      verticalPeriodTextSupplementFixture.replace(
        "<th>已繳款金額</th>",
        "<th>本期應繳總額</th>",
      ),
    ),
  /balance|duplicate|summary/iu,
);
assert.throws(
  () =>
    parseYuantaCreditCardSettledStatementSummaries(
      verticalPeriodTextSupplementFixture.replace(
        "<td>1,234</td>",
        '<td rowspan="2">1,234</td>',
      ),
    ),
  /balance|ambiguous|span|summary/iu,
);
assert.throws(
  () =>
    parseYuantaCreditCardSettledStatementSummaries(
      verticalPeriodTextSupplementFixture.replace(
        "<td>1,234</td>",
        "<td>not-an-amount</td>",
      ),
    ),
  /balance.*invalid|summary/iu,
);
const invalidBalanceDiagnostic = diagnoseYuantaCreditCardSummaryHtml(
  verticalPeriodTextSupplementFixture.replace(
    "<td>1,234</td>",
    "<td>not-an-amount</td>",
  ),
);
assert.equal(invalidBalanceDiagnostic.invalidFieldFamily, "balance");
assert.deepEqual(
  invalidBalanceDiagnostic.fieldSourceLayoutByField.balance,
  ["vertical-grid-same-column"],
);
assert.doesNotMatch(
  JSON.stringify(invalidBalanceDiagnostic),
  /not-an-amount|888,888|999,999/iu,
);
const conflictingBalanceFixture = verticalPeriodTextSupplementFixture.replace(
  "  </section>",
  `
    <table class="summary-secondary">
      <tr><th>本期應繳總額</th><td>2,000</td></tr>
    </table>
  </section>`,
);
assert.throws(
  () =>
    parseYuantaCreditCardSettledStatementSummaries(conflictingBalanceFixture),
  /conflicting.*balance|balance.*conflict|summary/iu,
);
const invalidVerticalPeriodTextSupplementDiagnostic =
  diagnoseYuantaCreditCardSummaryHtml(
    verticalPeriodTextSupplementFixture.replace(
      "2026/06月",
      "2026/06摘要",
    ),
  );
assert.equal(
  invalidVerticalPeriodTextSupplementDiagnostic.invalidFieldFamily,
  "period",
);
assert.deepEqual(
  invalidVerticalPeriodTextSupplementDiagnostic.invalidValueCellTagPairIds,
  ["th->td"],
);
assert.deepEqual(
  invalidVerticalPeriodTextSupplementDiagnostic.invalidValueLayoutPositionIds,
  ["vertical-grid-same-column"],
);
assert.deepEqual(
  invalidVerticalPeriodTextSupplementDiagnostic.fieldSourceLayoutByField.period,
  ["vertical-grid-same-column"],
);
assert.doesNotMatch(
  JSON.stringify(invalidVerticalPeriodTextSupplementDiagnostic),
  /2026\/06摘要|115\/06\/20|1,234/iu,
);
assert.throws(
  () =>
    parseYuantaCreditCardSettledStatementSummaries(
      verticalPeriodTextSupplementFixture.replace(
        "<td>2026/06月</td>",
        "<td>2026/06/99</td>",
      ),
    ),
  /period.*invalid|summary/iu,
);
assert.throws(
  () =>
    parseYuantaCreditCardSettledStatementSummaries(
      verticalPeriodTextSupplementFixture.replace(
        "<td>2026/06月</td>",
        "<td></td>",
      ),
    ),
  /period|missing|summary/iu,
);
assert.throws(
  () =>
    parseYuantaCreditCardSettledStatementSummaries(
      verticalPeriodTextSupplementFixture.replace(
        "<th>帳單月份</th>",
        "<th>提示欄位</th>",
      ),
    ),
  /exact period|row 0|period|summary/iu,
);
assert.throws(
  () =>
    parseYuantaCreditCardSettledStatementSummaries(
      verticalPeriodTextSupplementFixture.replace(
        "<th>本期應繳金額</th>",
        "<th>帳單月份</th>",
      ),
    ),
  /duplicate|shifted|period|summary/iu,
);
assert.throws(
  () =>
    parseYuantaCreditCardSettledStatementSummaries(
      verticalPeriodTextSupplementFixture.replace(
        "<td>2026/06月</td>",
        '<td rowspan="2">2026/06月</td>',
      ),
    ),
  /ambiguous|span|summary/iu,
);
assert.throws(
  () =>
    parseYuantaCreditCardSettledStatementSummaries(
      mixedRowPeriodColumnFixture.replace(
        "<th>2026/06月</th>",
        '<th rowspan="2">2026/06月</th>',
      ),
    ),
  /ambiguous|span|summary/iu,
);
assert.throws(
  () =>
    parseYuantaCreditCardSettledStatementSummaries(
      mixedRowPeriodColumnFixture.replace(
        "<th>2026/06月</th>",
        "<th>結帳日</th>",
      ),
    ),
  /incomplete|invalid|period|summary/iu,
);
assert.throws(
  () =>
    parseYuantaCreditCardSettledStatementSummaries(
      mixedRowPeriodColumnFixture.replace(
        "<th>備註</th>",
        "<th>帳單月份</th>",
      ),
    ),
  /multiple|ambiguous|period|summary/iu,
);
assert.throws(
  () =>
    parseYuantaCreditCardSettledStatementSummaries(
      mixedRowPeriodColumnFixture.replace(
        "<th>2026/06/99</th>",
        "<th>2026/05</th>",
      ),
    ),
  /conflicting|ambiguous|period|summary/iu,
);
assert.throws(
  () =>
    parseYuantaCreditCardSettledStatementSummaries(
      mixedRowPeriodColumnFixture.replace(
        "<td>115/07/05</td>",
        "<th>115/07/05</th>",
      ),
    ),
  /vertical|ambiguous|summary/iu,
);
const mixedTagVerticalGridFixture = verticalLabelValueGridFixture
  .replace("<th>期間提示</th>", "<th>2026/06/99</th>")
  .replace(
    "<tr><td>115/06</td><td>DECOY-PERIOD-VALUE</td><td>115/06/20</td><td>115/07/05</td><td>NT$ 1,234.00</td></tr>",
    "<tr><th>2026/06月</th><th>DECOY-VALUE</th><th>115/06/20</th><th>115/07/05</th><th>NT$ 1,234.00</th></tr>",
  );
const mixedTagVerticalSummary = parseYuantaCreditCardSettledStatementSummaries(
  mixedTagVerticalGridFixture,
);
assert.equal(mixedTagVerticalSummary[0]?.period, "2026/06");
assert.equal(mixedTagVerticalSummary[0]?.closeDate, "2026-06-20");
assert.equal(mixedTagVerticalSummary[0]?.dueDate, "2026-07-05");
assert.equal(mixedTagVerticalSummary[0]?.balance, "1234.00");
assert.equal(mixedTagVerticalSummary[0]?.minimumPayment, "123");
const invalidMixedTagVerticalDiagnostic = diagnoseYuantaCreditCardSummaryHtml(
  mixedTagVerticalGridFixture.replace(
    "<th>2026/06月</th>",
    "<th>2026/06摘要</th>",
  ),
);
assert.equal(invalidMixedTagVerticalDiagnostic.invalidFieldFamily, "period");
assert.deepEqual(invalidMixedTagVerticalDiagnostic.invalidValueCellTagPairIds, [
  "th->th",
]);
assert.deepEqual(
  invalidMixedTagVerticalDiagnostic.invalidValueLayoutPositionIds,
  ["vertical-grid-same-column"],
);
assert.doesNotMatch(
  JSON.stringify(invalidMixedTagVerticalDiagnostic),
  /2026\/06摘要|2026\/06\/99/iu,
);
assert.throws(
  () => parseYuantaCreditCardSettledStatementSummaries(
    mixedTagVerticalGridFixture.replace(
      "<th>DECOY-VALUE</th>",
      "<td>DECOY-VALUE</td>",
    ),
  ),
  /vertical|ambiguous|summary/iu,
);
assert.throws(
  () => parseYuantaCreditCardSettledStatementSummaries(
    mixedTagVerticalGridFixture.replace(
      "<th>DECOY-VALUE</th>",
      "<th>結帳日</th>",
    ),
  ),
  /incomplete|summary|period/iu,
);
assert.throws(
  () => parseYuantaCreditCardSettledStatementSummaries(
    mixedTagVerticalGridFixture.replace(
      "<th>2026/06月</th>",
      '<th colspan="2">2026/06月</th>',
    ),
  ),
  /ambiguous|span|summary/iu,
);
assert.throws(
  () => parseYuantaCreditCardSettledStatementSummaries(
    mixedTagVerticalGridFixture.replace(
      "<th>2026/06/99</th>",
      "<th>帳單月份</th>",
    ),
  ),
  /multiple|ambiguous|summary/iu,
);
assert.throws(
  () => parseYuantaCreditCardSettledStatementSummaries(
    verticalLabelValueGridFixture.replace(
      "<th>帳單月份</th>",
      '<th rowspan="2">帳單月份</th>',
    ),
  ),
  /ambiguous.*(?:span|summary)/iu,
);
assert.throws(
  () => parseYuantaCreditCardSettledStatementSummaries(
    verticalLabelValueGridFixture.replace(
      `        <tr><td>123</td><td>備註值</td><td>保留值</td><td>說明值</td><td>狀態值</td></tr>\n`,
      "",
    ),
  ),
  /missing|summary|incomplete/iu,
);
assert.throws(
  () => parseYuantaCreditCardSettledStatementSummaries(
    verticalLabelValueGridFixture.replace(
      "<th>期間提示</th>",
      "<th>帳單月份</th>",
    ),
  ),
  /multiple|ambiguous|summary/iu,
);
const verticalAndPairConflictFixture = verticalLabelValueGridFixture.replace(
  "      </table>",
  `
        <tr><th>帳單月份</th><td>115/05</td><th>結帳日</th><td>115/05/20</td></tr>
        <tr><th>繳款截止日</th><td>115/06/05</td><th>本期應繳總額</th><td>2,000</td></tr>
        <tr><th>本期最低應繳額</th><td>200</td></tr>
      </table>`,
);
assert.throws(
  () => parseYuantaCreditCardSettledStatementSummaries(verticalAndPairConflictFixture),
  /conflicting|ambiguous|summary/iu,
);
const ambiguousGroupedAndPairFixture = `
  <table class="settled-summary">
    <tr><th>帳單月份</th><th>結帳日</th></tr>
    <tr><td>115/06</td><td>115/06/20</td></tr>
    <tr><th>繳款截止日</th><td>115/07/05</td><th>本期應繳總額</th><td>1,234</td></tr>
    <tr><th>本期最低應繳額</th><td>123</td></tr>
  </table>
`;
assert.throws(
  () => parseYuantaCreditCardSettledStatementSummaries(ambiguousGroupedAndPairFixture),
  /ambiguous.*(?:strateg|summary)/iu,
);
const ambiguousGroupedAndPairDiagnostic = diagnoseYuantaCreditCardSummaryHtml(
  ambiguousGroupedAndPairFixture,
);
assert.equal(ambiguousGroupedAndPairDiagnostic.ambiguityReason, "multiple-complete");
assert.doesNotMatch(
  JSON.stringify(ambiguousGroupedAndPairDiagnostic),
  /115\/06|115\/06\/20|1,234|PAN/iu,
);
const singleTableSplitRowsDiagnostic = diagnoseYuantaCreditCardHistoryHtml(
  singleTableSplitRowsFixture,
  0,
);
assert.equal(singleTableSplitRowsDiagnostic.candidateTableCount, 1);
assert.equal(singleTableSplitRowsDiagnostic.candidateRowCount, 4);
assert.equal(singleTableSplitRowsDiagnostic.allRequiredFields, true);
assert.equal(singleTableSplitRowsDiagnostic.candidateGroupCount, 1);
assert.equal(singleTableSplitRowsDiagnostic.completeGroupCount, 1);
assert.deepEqual(singleTableSplitRowsDiagnostic.partialGroupFieldMasks, []);
assert.equal(singleTableSplitRowsDiagnostic.ambiguityReason, "none");
assert.deepEqual(singleTableSplitRowsDiagnostic.extractionStrategyIds, [
  "table-key-value-pairs",
]);
assert.doesNotMatch(
  JSON.stringify(singleTableSplitRowsDiagnostic),
  /115\/06|115\/06\/20|1,234|PAN/iu,
);
assert.doesNotThrow(() => {
  const { summary } = parseYuantaCreditCardSettledStatementHistoryPage(
    singleTableSplitRowsFixture,
    { index: 0, label: "115/06" },
    0,
  );
  assert.equal(summary.period, "115/06");
  assert.equal(summary.balance, "1234");
  assert.equal(summary.minimumPayment, "123");
});
const invalidSplitRowsValueFixture = singleTableSplitRowsFixture.replace(
  "1,234",
  "not-an-amount",
);
const invalidSplitRowsDiagnostic = diagnoseYuantaCreditCardHistoryHtml(
  invalidSplitRowsValueFixture,
  0,
);
assert.equal(invalidSplitRowsDiagnostic.allRequiredFields, true);
assert.equal(invalidSplitRowsDiagnostic.candidateGroupCount, 1);
assert.equal(invalidSplitRowsDiagnostic.completeGroupCount, 1);
assert.deepEqual(invalidSplitRowsDiagnostic.partialGroupFieldMasks, []);
assert.equal(invalidSplitRowsDiagnostic.ambiguityReason, "value-invalid");
assert.equal(invalidSplitRowsDiagnostic.invalidFieldFamily, "balance");
assert.deepEqual(invalidSplitRowsDiagnostic.extractionStrategyIds, [
  "table-key-value-pairs",
]);
assert.doesNotMatch(
  JSON.stringify(invalidSplitRowsDiagnostic),
  /115\/06|115\/06\/20|not-an-amount|PAN/iu,
);
assert.throws(
  () => parseYuantaCreditCardSettledStatementSummaries(invalidSplitRowsValueFixture),
  /balance.*invalid/u,
);
const historyPeriods = [
  "115/01",
  "115/02",
  "115/03",
  "115/04",
  "115/05",
  "115/06",
];
const historySummaryPageFixtures = historyPeriods.map((period, index) => {
  const closeMonth = String(index + 1).padStart(2, "0");
  const dueMonth = String(index + 2).padStart(2, "0");
  return `
    <section class="history-result">
      <table class="history-transactions">
        <tr><th>消費日期</th><th>入帳日期</th><th>消費明細</th><th>新臺幣金額</th></tr>
        <tr><td>115/${closeMonth}/02</td><td>115/${closeMonth}/03</td><td>SETTLED TEST ROW</td><td>100</td></tr>
      </table>
      <div class="settled-summary-card">
        <table class="settled-summary">
          <tr><th>帳單月份</th><th>結帳日</th><th>出帳日</th><th>繳款截止日</th><th>本期應繳總額</th><th>本期最低應繳額</th></tr>
          <tr><td>${period}</td><td>115/${closeMonth}/20</td><td>115/${closeMonth}/21</td><td>115/${dueMonth}/05</td><td>1,000</td><td>100</td></tr>
        </table>
      </div>
    </section>
  `;
});
const historyPageEvidence = historySummaryPageFixtures.map((html, index) =>
  parseYuantaCreditCardSettledStatementHistoryPage(
    html,
    { index, label: historyPeriods[index]! },
    index,
  ),
);
const equivalentPeriodHistoryPage = historySummaryPageFixtures[5]!.replace(
  "<td>115/06</td><td>115/06/20",
  "<td>民國115年06月</td><td>115/06/20",
);
assert.equal(
  parseYuantaCreditCardSettledStatementHistoryPage(
    equivalentPeriodHistoryPage,
    { index: 5, label: "115年06月份" },
    5,
  ).summary.period,
  "115/06",
);
assert.deepEqual(
  historyPageEvidence.map((page) => [page.pageOrdinal, page.monthIndex, page.summary.period]),
  historyPeriods.map((period, index) => [index, index, period]),
);
const historyIssuerSummaries = collectYuantaCreditCardHistorySummaries(
  historyPageEvidence,
  historyPeriods.map((label, index) => ({ index, label })),
);
assert.deepEqual(
  historyIssuerSummaries.map((summary) => summary.period),
  historyPeriods,
);
assert.equal(resolveYuantaSettledStatementCycles(historyIssuerSummaries).length, 5);
assert.throws(
  () =>
    parseYuantaCreditCardSettledStatementHistoryPage(
      historySummaryPageFixtures[0]!,
      { index: 0, label: "115/02" },
      0,
    ),
  /period.*match|mismatch/u,
);
for (const invalidLabel of ["", "   ", "not-a-period", "115/13"]) {
  assert.throws(
    () =>
      parseYuantaCreditCardSettledStatementHistoryPage(
        historySummaryPageFixtures[0]!,
        { index: 0, label: invalidLabel },
        0,
      ),
    /selected provider month.*(?:required|invalid)|period.*invalid|period.*match/u,
  );
}
assert.throws(
  () =>
    parseYuantaCreditCardSettledStatementHistoryPage(
      historySummaryPageFixtures[0]!.replace("本期最低應繳額", "非最低欄位"),
      { index: 0, label: historyPeriods[0]! },
      0,
    ),
  /incomplete|summary/u,
);
assert.throws(
  () =>
    parseYuantaCreditCardSettledStatementHistoryPage(
      historySummaryPageFixtures[0]!.replace(
        "</table>\n      </div>",
        `<tr><td>115/01</td><td>115/01/20</td><td>115/01/21</td><td>115/02/05</td><td>1,000</td><td>100</td></tr></table>\n      </div>`,
      ),
      { index: 0, label: historyPeriods[0]! },
      0,
    ),
  /unique|period|summary/u,
);
assert.throws(
  () =>
    collectYuantaCreditCardHistorySummaries(
      historyPageEvidence.slice(0, 5),
      historyPeriods.map((label, index) => ({ index, label })),
    ),
  /page|summary|six|count/u,
);
assert.throws(
  () =>
    collectYuantaCreditCardHistorySummaries(
      historyPageEvidence.map((page, index) =>
        index === 5
          ? { ...page, summary: { ...page.summary, period: "115/05" } }
          : page,
      ),
      historyPeriods.map((label, index) => ({ index, label })),
    ),
  /unique|period|summary/u,
);
assert.throws(
  () =>
    collectYuantaCreditCardHistorySummaries(
      historyPageEvidence.map((page, index) =>
        index === 1 ? { ...page, monthIndex: 2 } : page,
      ),
      historyPeriods.map((label, index) => ({ index, label })),
    ),
  /association|month|page/u,
);
const nonMonotonicHistorySummaries = historyIssuerSummaries.map((summary, index) =>
  index === 3
    ? { ...summary, closeDate: "2026-02-20", issueDate: "2026-02-21" }
    : summary,
);
assert.throws(
  () => resolveYuantaSettledStatementCycles(nonMonotonicHistorySummaries),
  /monotonic|ordered/u,
);

const identity = deriveYuantaCanonicalHumanAttestation(
  {
    yuanta_user_id: " user-001 ",
    yuanta_account: " main-account ",
    yuanta_password: "password-must-not-affect-identity",
  },
  "synthetic-managed-secret",
);
assert.ok(identity);
assert.deepEqual(
  identity,
  deriveYuantaCanonicalHumanAttestation(
    {
      yuanta_user_id: "USER-001",
      yuanta_account: "MAIN-ACCOUNT",
      yuanta_password: "rotated-password",
    },
    "synthetic-managed-secret",
  ),
);
assert.notDeepEqual(
  identity,
  deriveYuantaCanonicalHumanAttestation(
    { yuanta_user_id: "other-user", yuanta_account: "main-account" },
    "synthetic-managed-secret",
  ),
);
assert.equal(
  identity?.sourceConnectionKey,
  deriveYuantaCanonicalHumanAttestation(
    { yuanta_user_id: "user-001", yuanta_account: "main-account" },
    "different-managed-secret",
  )?.sourceConnectionKey,
  "managed-secret rotation must not change Source Connection identity",
);
assert.notDeepEqual(
  identity,
  deriveYuantaCanonicalHumanAttestation(
    { yuanta_user_id: "user-001", yuanta_account: "main-account" },
    "different-managed-secret",
  ),
);
assert.equal(
  deriveYuantaCanonicalHumanAttestation(
    { yuanta_user_id: "user-001", yuanta_account: "" },
    "synthetic-managed-secret",
  ),
  undefined,
);
assert.doesNotMatch(
  JSON.stringify(identity),
  /user-001|main-account|synthetic-managed-secret/iu,
);
const identitySecretKey = "LIBRETTO_CLOUD_FUBON_CARD_IDENTITY_FINGERPRINT_KEY";
const previousIdentitySecret = process.env[identitySecretKey];
process.env[identitySecretKey] = "synthetic-managed-secret";
try {
  assert.deepEqual(
    yuantaCanonicalHumanAttestationFromEnvironment({
      yuanta_user_id: "USER-001",
      yuanta_account: "MAIN-ACCOUNT",
    }),
    identity,
  );
} finally {
  if (previousIdentitySecret === undefined) delete process.env[identitySecretKey];
  else process.env[identitySecretKey] = previousIdentitySecret;
}

const periods = [
  "115/01",
  "115/02",
  "115/03",
  "115/04",
  "115/05",
  "115/06",
];
const monthOptions = periods.map((label, index) => ({ index, label }));
const workflowSummaries = periods.map((period, index) => {
  const month = String(index + 1).padStart(2, "0");
  return {
    period,
    cycleStart: `2026-${month}-01`,
    cycleEnd: `2026-${month}-20`,
    issueDate: `2026-${month}-21`,
    dueDate: `2026-${month}-25`,
    balance: "100.00",
    minimumPayment: "10.00",
  };
});
const billedRows = periods.map((period, index) => ({
  creditCardNo: "4111-11**-****-1234",
  creditCardName: "SYNTHETIC PRIMARY CARD",
  consumeDate: `2026-0${index + 1}-02`,
  postedDate: `2026-0${index + 1}-03`,
  description: `BILLED ${period}`,
  countryCurrency: "台灣/TWD",
  foreignExchangeDate: "",
  foreignAmount: "",
  twdAmount: "100.00",
  paymentStatus: "已繳",
  period,
}));
const unbilledRows = [
  {
    ...billedRows[0],
    consumeDate: "2026-07-02",
    postedDate: "2026-07-03",
    description: "UNBILLED PURCHASE",
    twdAmount: "-25.00",
    paymentStatus: "",
    period: null,
  },
];
const fullCaptureMetadata = {
  snapshotMode: "full" as const,
  captureId: "yuanta-workflow-capture",
  capturedAt: "2026-08-27T00:00:00.000Z",
  captureKinds: ["billed", "unbilled"] as ["billed", "unbilled"],
  completenessEvidence: {
    bank: "yuanta",
    monthIndexes: [0, 1, 2, 3, 4, 5],
    unbilled: true,
    pagination: "none",
  },
};
const captureInput = {
  capture: fullCaptureMetadata,
  identity,
  instrumentFingerprintSecret: "synthetic-managed-secret",
  allMonthOptions: monthOptions,
  selectedMonthOptions: monthOptions,
  includeUnbilled: true,
  includeSummary: true,
  terminalPages: [true, true, true, true, true, true, true],
  billedRows,
  unbilledRows,
  statementSummaries: workflowSummaries,
};
const builderOptions = yuantaCreditCardCaptureBuilderOptions(captureInput);
assert.ok(builderOptions);
assert.deepEqual(builderOptions.billedPeriods, periods);
assert.equal(builderOptions.billedRows[0]?.creditCardNo, "****1234");
assert.match(
  builderOptions.billedRows[0]?.instrumentKey ?? "",
  /^yuanta_instrument_[A-Za-z0-9_-]{43}$/u,
);
assert.equal(builderOptions.unbilledRows[0]?.period, null);
const historyCaptureInput = {
  ...captureInput,
  statementSummaries: resolveYuantaSettledStatementCycles(historyIssuerSummaries),
};
const historyBuilderOptions = yuantaCreditCardCaptureBuilderOptions(historyCaptureInput);
assert.ok(historyBuilderOptions);
assert.equal(historyBuilderOptions.statementSummaries?.length, 5);
assert.equal(
  buildYuantaCanonicalCreditCardCaptures(historyCaptureInput)[0]?.statements.length,
  5,
);
assert.equal(
  yuantaCreditCardCaptureBuilderOptions({
    ...captureInput,
    includeSummary: false,
    statementSummaries: undefined,
  }),
  undefined,
);
assert.deepEqual(
  yuantaCreditCardTerminalPagesFromHtml([noPagerResponse], pagerResponse),
  [true, false],
);
const canonicalCaptures = buildYuantaCanonicalCreditCardCaptures(captureInput);
assert.equal(canonicalCaptures.length, 1);
const canonicalCapture = canonicalCaptures[0]!;
assert.equal(canonicalCapture.transactions.length, 7);
assert.equal(canonicalCapture.statements.length, 6);
assert.equal(canonicalCapture.scope.completeness.settledSummaryEvidencePresent, true);
assert.equal(
  canonicalCapture.transactions.filter((transaction) => transaction.billingStatus === "billed").length,
  6,
);
assert.equal(
  canonicalCapture.transactions.filter((transaction) => transaction.billingStatus === "unbilled").length,
  1,
);
assert.equal(
  canonicalCapture.transactions.filter(
    (transaction) => transaction.billingStatus === "billed" && transaction.statementKey,
  ).length,
  6,
);
assert.equal(canonicalCapture.transactions.at(-1)?.direction, "inflow");
assert.equal(canonicalCapture.instruments[0]?.cardMask, "****1234");
assert.doesNotMatch(
  JSON.stringify(canonicalCapture),
  /411111|4111-11|synthetic-managed-secret/iu,
);

const primaryProjection = deriveYuantaProjectedInstrumentIdentity(
  "4111-11**-****-1234",
  identity,
  "synthetic-managed-secret",
);
const repeatedProjection = deriveYuantaProjectedInstrumentIdentity(
  "4111-11XX-XXXX-1234",
  identity,
  "synthetic-managed-secret",
);
const sameLastFourDifferentPrefix = deriveYuantaProjectedInstrumentIdentity(
  "5222-22**-****-1234",
  identity,
  "synthetic-managed-secret",
);
assert.ok(primaryProjection);
assert.deepEqual(primaryProjection, repeatedProjection);
assert.notEqual(
  primaryProjection.instrumentKey,
  sameLastFourDifferentPrefix?.instrumentKey,
);
assert.equal(primaryProjection.cardMask, "****1234");
assert.doesNotMatch(JSON.stringify(primaryProjection), /411111|4111-11/u);
const twoInstrumentRows = billedRows.map((row, index) =>
  index === 1
    ? {
        ...row,
        creditCardNo: "5222-22**-****-1234",
        creditCardName: "SYNTHETIC SECOND CARD",
      }
    : row,
);
const twoInstrumentCapture = buildYuantaCanonicalCreditCardCaptures({
  ...captureInput,
  billedRows: twoInstrumentRows,
})[0]!;
const repeatedTwoInstrumentCapture = buildYuantaCanonicalCreditCardCaptures({
  ...captureInput,
  capture: { ...fullCaptureMetadata, captureId: "yuanta-workflow-repeat" },
  billedRows: twoInstrumentRows,
})[0]!;
assert.equal(twoInstrumentCapture.instruments.length, 2);
assert.deepEqual(
  twoInstrumentCapture.instruments.map((instrument) => instrument.cardMask),
  ["****1234", "****1234"],
);
assert.equal(
  new Set(twoInstrumentCapture.instruments.map((instrument) => instrument.instrumentKey)).size,
  2,
);
assert.deepEqual(
  twoInstrumentCapture.transactions.map((transaction) => transaction.sourceKey).sort(),
  repeatedTwoInstrumentCapture.transactions
    .map((transaction) => transaction.sourceKey)
    .sort(),
);
assert.doesNotMatch(
  JSON.stringify(twoInstrumentCapture),
  /411111|4111-11|522222|5222-22|synthetic-managed-secret/iu,
);
for (const malformed of [
  "****1234",
  "1234",
  "4111111111111234",
  "4111-11**-***-1234",
  "4111-11**-****-12A4",
])
  assert.equal(
    deriveYuantaProjectedInstrumentIdentity(
      malformed,
      identity,
      "synthetic-managed-secret",
    ),
    undefined,
  );
assert.equal(
  deriveYuantaProjectedInstrumentIdentity(
    "4111-11**-****-1234",
    identity,
    "",
  ),
  undefined,
);

const explicitSummaries = periods.map((period, index) => {
  const month = String(index + 1).padStart(2, "0");
  return {
    period,
    cycleStart: `2026-${month}-01`,
    cycleEnd: `2026-${month}-20`,
    issueDate: `2026-${month}-21`,
    dueDate: `2026-${month}-25`,
    balance: "100.00",
    minimumPayment: "10.00",
  };
});
const explicitCanonicalCapture = buildYuantaCanonicalCreditCardCaptures({
  ...captureInput,
  statementSummaries: explicitSummaries,
})[0]!;
assert.equal(explicitCanonicalCapture.statements.length, 6);
assert.equal(
  explicitCanonicalCapture.scope.completeness.settledSummaryEvidencePresent,
  true,
);
assert.equal(
  explicitCanonicalCapture.transactions.filter(
    (transaction) => transaction.billingStatus === "billed" && transaction.statementKey,
  ).length,
  6,
);
assert.ok(
  explicitCanonicalCapture.statements.every((statement) =>
    statement.transactionSourceKeys.every((sourceRecordKey) =>
      explicitCanonicalCapture.transactions.some(
        (transaction) =>
          transaction.sourceRecordKey === sourceRecordKey &&
          transaction.statementKey === statement.statementKey,
      ),
    ),
  ),
);
assert.equal(
  yuantaCreditCardCaptureBuilderOptions({
    ...captureInput,
    selectedMonthOptions: monthOptions.slice(0, 5),
  }),
  undefined,
);
assert.deepEqual(
  buildYuantaCanonicalCreditCardCaptures({
    ...captureInput,
    terminalPages: [true, true, true, true, true, true, false],
  }),
  [],
);
assert.equal(
  toYuantaCanonicalCreditCardSourceRow({
    ...billedRows[0],
    creditCardNo: "4111-11**-****-1234",
  }, identity, "synthetic-managed-secret")?.creditCardNo,
  "****1234",
);
assert.equal(
  toYuantaCanonicalCreditCardSourceRow(
    { ...billedRows[0], creditCardNo: "****1234" },
    identity,
    "synthetic-managed-secret",
  ),
  undefined,
);
assert.equal(
  yuantaCreditCardCaptureBuilderOptions({
    ...captureInput,
    instrumentFingerprintSecret: "",
  }),
  undefined,
);
