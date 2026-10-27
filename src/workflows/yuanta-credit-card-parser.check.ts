import assert from "node:assert/strict";
import {
  collectYuantaCreditCardHistorySummaries,
  hasUntraversedPager,
  parseYuantaCreditCardSettledStatementHistoryPage,
  parseYuantaCreditCardSettledStatementSummaries,
  parseYuantaCurrentCreditCardUsedCreditSummaryHtml,
  resolveYuantaSettledStatementCycles,
  traverseYuantaCreditCardSettledStatementSummaryPages,
  YUANTA_CREDIT_CARD_SETTLED_SUMMARY_PARSER_CONTRACT,
  YuantaCreditCardSummaryParseError,
} from "./yuanta-credit-card-parser.ts";
import { YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST } from "../ledger/canonical/yuanta-credit-card-human-attestation-contract.ts";

assert.equal(
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST.semantics.settledSummaryParserContract,
  YUANTA_CREDIT_CARD_SETTLED_SUMMARY_PARSER_CONTRACT,
  "the attested manifest names the parser contract this module implements",
);

const yuantaCurrentCredit = parseYuantaCurrentCreditCardUsedCreditSummaryHtml(`
  <table class="rwdTable">
    <tr><th>信用額度</th><th>已使用額度</th><th>信用額度餘額</th><th>預借現金額度</th></tr>
    <tr><td>100,000</td><td>12,345</td><td>87,655</td><td>20,000</td></tr>
  </table>
  <table class="rwdTable">
    <tr><th>帳單結帳日</th><th>本月繳款期限</th><th>最近繳款日期</th><th>本期帳單金額</th></tr>
    <tr><td>2026/09/01</td><td>2026/09/20</td><td></td><td>5,000</td></tr>
  </table>
`);
assert.deepEqual(yuantaCurrentCredit, {
  limit: "100000",
  usedCredit: "12345",
  available: "87655",
  sourceField: "已使用額度",
});
const nestedYuantaCurrentCreditHtml = `
  <table class="rwdTable decoy">
    <tr><th>帳單結帳日</th><th>本月繳款期限</th></tr>
    <tr><td>2026/09/01</td><td>2026/09/20</td></tr>
  </table>
  <table class="layout rwdTable">
    <tr><td>
      <table class="rwdTable">
        <tr><th>信用額度</th><th>已使用額度</th><th>信用額度餘額</th><th>預借現金額度</th></tr>
        <tr><td>200,000</td><td>12,300.50</td><td>187,699.50</td><td>40,000</td></tr>
      </table>
    </td></tr>
  </table>
`;
assert.deepEqual(
  parseYuantaCurrentCreditCardUsedCreditSummaryHtml(nestedYuantaCurrentCreditHtml),
  {
    limit: "200000",
    usedCredit: "12300.50",
    available: "187699.50",
    sourceField: "已使用額度",
  },
);
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
const verticalPeriodTextSupplementFixture = `
  <section class="summary-result">
    <table class="rwdTable">
      <tr><th>帳單月份</th><th>本期應繳金額</th><th>已繳款金額</th></tr>
      <tr><td>2026/06月</td><td>1,234</td><td>9,999</td></tr>
    </table>
    <p>帳單月份：2026/05 顯示月份（非權威）　已繳款金額：999,999　結帳日：115/06/20 繳款截止日：115/07/05 本期應繳總額：888,888 本期最低應繳額：123</p>
  </section>
`;
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
