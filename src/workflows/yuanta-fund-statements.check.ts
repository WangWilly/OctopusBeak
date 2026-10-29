import assert from "node:assert/strict";
import { canonicalYuantaFundCurrency, yuantaFundSourceAmountCurrency } from "./yuanta-fund-currency.ts";
import { yuantaFundAdditionalEventRows } from "./yuanta-fund-events.ts";
import { yuantaFundAccountHistoryQueries, yuantaFundAccountHistoryKey, yuantaFundAccountHistoryScope,
  yuantaFundAccountHistoryTableLabels, yuantaFundHistoryInvestmentTypes } from "./yuanta-fund-account-history.ts";
import { PGliteStore } from "../ledger/pglite/transaction.ts";
import { commitPGliteCanonicalInvestmentCapture } from "../ledger/pglite/investment.ts";
import { createPGliteCanonicalOverviewQuery } from "../ledger/pglite/overview.ts";
import { admitCanonicalInvestmentCapture } from "../ledger/canonical/investment-financial-admission.ts";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CanonicalInvestmentAdmissionError } from "../ledger/canonical/investment-financial-admission.ts";
import { deriveSourceConnectionIdentityKey } from "../ledger/canonical/source-connection-identity.ts";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import type { YuantaFundSourceSnapshot } from "./yuanta-fund-statements.ts";
import { fixedPeriod, yuantaCollectionContext, yuantaStagingHandle } from "./yuanta-collection.fixtures.ts";
import { collectionPeriod, taipeiToday } from "../lib/automation/collection-period.ts";
import { YUANTA_SOURCE } from "../lib/automation/server/sources/yuanta.ts";
import { PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND } from "../ledger/pglite/workflow-client.ts";
import { createTestPGlite } from "../ledger/pglite/baseline-test-template.ts";
import { test } from "node:test";
import { chromium } from "playwright";
import { YUANTA_EBANK_ORIGIN, yuantaEbankSite } from "./yuanta-ebank-site.ts";
import { SourceTextIntegrityError, strictSourceText } from "../lib/automation/source-text.ts";

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

const yuantaFundModule = await import("./yuanta-fund-statements.ts");
// Live conversion cells use <br> between legs; names may contain spaces.
assert.deepEqual(
  yuantaFundModule.splitWhitespacePair("SANITIZED OUT FUND\nSANITIZED IN FUND"),
  ["SANITIZED OUT FUND", "SANITIZED IN FUND"],
);
assert.throws(() => yuantaFundModule.splitWhitespacePair("OUT\nIN\nEXTRA"));
const pairedCell = {
  innerText: async () => "SANITIZED OUT FUND\nSANITIZED IN FUND",
  getAttribute: async () => null,
};
const parsedPairedCell = await yuantaFundModule.parseHtmlTableRows({
  locator: () => ({
    count: async () => 1,
    nth: () => ({ locator: () => ({ count: async () => 1, nth: () => pairedCell }) }),
  }),
} as unknown as Parameters<typeof yuantaFundModule.parseHtmlTableRows>[0]);
assert.deepEqual(parsedPairedCell.cellLines, [
  [["SANITIZED OUT FUND", "SANITIZED IN FUND"]],
]);
const conversionHeaderLines = [
  ["轉出日期", "轉入日期"], ["交易編號"], ["轉出基金", "轉入基金"],
  ["轉換投資金額"], ["轉出單位數", "轉入單位數"],
  ["轉出基金淨值", "轉入基金淨值"], ["轉換匯率", "短線費用"],
  ["銀行轉換手續費", "基金公司轉換手續費"],
];
const conversionDataLines = [
  ["2026/01/01", "2026/01/02"], ["T12345"],
  ["SANITIZED OUT FUND", "SANITIZED IN FUND"], ["100"],
  ["10", "20"], ["10", "5"], ["1", "0"], ["0", "0"],
];
const normalizedConversion = yuantaFundModule.normalizedRowsForTable({
  category: "historical-transactions", fund: "S:FUND001:T12345", period: null,
  tableLabel: "conversion-details",
  rows: [conversionHeaderLines, conversionHeaderLines, conversionDataLines]
    .map(row => row.map(lines => lines.join(" "))),
  cellLines: [conversionHeaderLines, conversionHeaderLines, conversionDataLines],
});
assert.equal(normalizedConversion.length, 1, "Repeated multiline headers are not transactions");
assert.deepEqual(normalizedConversion[0].values, [
  "2026/01/01", "2026/01/02", "T12345", "SANITIZED OUT FUND", "SANITIZED IN FUND",
  "100", "10", "20", "10", "5", "1", "0", "0", "0",
]);
// Separate name/transaction columns are identified by source headers, even
// when the provider renders them in the opposite order.
assert.deepEqual(yuantaFundModule.normalizedRowsForTable({
  category: "historical-transactions", fund: "S:FS00000001:YT01", period: null, tableLabel: "buy-details",
  rows: [["投資日期", "交易編號", "基金名稱", "投資金額", "申購匯率", "申購淨值", "申購手續費", "點數折抵", "申購單位數"],
    ["2026/08/01", "FS00000001", "SANITIZED FUND", "100", "1", "10", "0", "0", "10"]],
})[0]?.values.slice(0, 3), ["2026/08/01", "SANITIZED FUND", "FS00000001"]);
for (const badHeaders of [
  ["投資日期", "基金名稱", "基金名稱", "投資金額", "申購匯率", "申購淨值", "申購手續費", "點數折抵", "申購單位數"],
  ["投資日期", "基金名稱", "交易編號", "UNKNOWN", "申購匯率", "申購淨值", "申購手續費", "點數折抵", "申購單位數"],
]) assert.throws(() => yuantaFundModule.normalizedRowsForTable({
  category: "historical-transactions", fund: "S:FS00000001:YT01", period: null, tableLabel: "buy-details",
  rows: [badHeaders, ["2026/08/01", "SANITIZED FUND", "FS00000001", "100", "1", "10", "0", "0", "10"]],
}), /complete unique source headers/u);
const redemptionAccountHeader = [
  "贖回日期 分配日期", "基金名稱 交易編號", "贖回投資金額 單位數", "贖回價格 贖回匯率",
  "信託管理費 短線費用", "入帳帳號 入帳淨額", "贖回參考損益 參考贖回報酬率", "預計入帳",
];
const redemptionAccountData = [["2026/08/20", "2026/08/21"], ["SANITIZED CLOSED FUND", "FS00000009"],
  ["台幣 100", "10"], ["10", "1"], ["台幣 0", "台幣 0"],
  ["SANITIZED ACCOUNT DESCRIPTION", "1234", "台幣 100"], ["台幣 0", "0%"], []];
const redemptionAccountFooter = ["合計", "贖回投資金額", "台幣 100", "贖回參考損益", "台幣 0", "贖回參考報酬率", "0%", ""];
const redemptionAccountTable = {
  category: "historical-transactions", fund: "account-history:single", period: null, tableLabel: "redemption-account-details",
  rows: [redemptionAccountHeader, redemptionAccountData.map(lines => lines.join(" ")), redemptionAccountFooter],
  cellLines: [redemptionAccountHeader.map(value => value.split(" ")), redemptionAccountData, redemptionAccountFooter.map(value => [value])],
  cellColspans: Array.from({ length: 3 }, () => Array(8).fill(1) as number[]),
};
const redemptionAccountResult = yuantaFundModule.normalizedRowsForTable(redemptionAccountTable);
assert.equal(redemptionAccountResult.length, 1);
assert.equal(redemptionAccountResult[0]?.values[11], "SANITIZED ACCOUNT DESCRIPTION 1234");
assert.equal(redemptionAccountResult[0]?.values[12], "台幣 100");
const splitHkdRedemptionData = redemptionAccountData.map((lines, column) => column === 5
  ? [lines[0]!, lines[1]!, "HKD", "100"] : lines);
const splitHkdRedemption = yuantaFundModule.normalizedRowsForTable({
  ...redemptionAccountTable,
  rows: [redemptionAccountHeader, splitHkdRedemptionData.map(lines => lines.join(" "))],
  cellLines: [redemptionAccountHeader.map(value => value.split(" ")), splitHkdRedemptionData],
});
assert.equal(splitHkdRedemption[0]?.values[12], "HKD 100");
assert.throws(() => yuantaFundModule.normalizedRowsForTable({ ...redemptionAccountTable,
  rows: [...redemptionAccountTable.rows.slice(0, 2), ["合計", "SANITIZED FUND", ...redemptionAccountFooter.slice(2)]],
}), /aggregate footer/u);
assert.throws(() => yuantaFundModule.normalizedRowsForTable({ ...redemptionAccountTable,
  cellColspans: [...redemptionAccountTable.cellColspans.slice(0, 2), [1, 2, 1, 1, 1, 1, 1, 1]],
}), /aggregate footer/u);
/** A Yuanta eBank site over a fake page whose only scope shows an overview with no position. */
const emptyHoldingsSite = yuantaEbankSite({
  mainFrame: () => null,
  frames: () => [],
  locator: (selector: string) => selector === "body" ? { innerText: async () => "無基金部位" }
    : { count: async () => selector.startsWith("a[") ? 0 : 1 },
} as never, { signal: new AbortController().signal, text: strictSourceText });
assert.deepEqual(await yuantaFundModule.extractFundPositions(emptyHoldingsSite, true), []);
await assert.rejects(yuantaFundModule.extractFundPositions(emptyHoldingsSite),
  /No YuanTa fund position/u);
const evaluateYuantaFundCanonicalAdmission: typeof yuantaFundModule.evaluateYuantaFundCanonicalAdmission =
  yuantaFundModule.evaluateYuantaFundCanonicalAdmission;
const assertYuantaFundCanonicalAdmission: typeof yuantaFundModule.assertYuantaFundCanonicalAdmission =
  yuantaFundModule.assertYuantaFundCanonicalAdmission;
const isYuantaFundPositionAbsentText: typeof yuantaFundModule.isYuantaFundPositionAbsentText =
  yuantaFundModule.isYuantaFundPositionAbsentText;
const parseYuantaFundValuationBasis: typeof yuantaFundModule.parseYuantaFundValuationBasis =
  yuantaFundModule.parseYuantaFundValuationBasis;
const stageYuantaFund: typeof yuantaFundModule.stageYuantaFund =
  yuantaFundModule.stageYuantaFund;
const yuantaFundHistoryResultIsUnpaged: typeof yuantaFundModule.yuantaFundHistoryResultIsUnpaged =
  yuantaFundModule.yuantaFundHistoryResultIsUnpaged;
const yuantaFundStatementsInputSchema: typeof yuantaFundModule.yuantaFundStatementsInputSchema =
  yuantaFundModule.yuantaFundStatementsInputSchema;

const source = await readFile(
  new URL("./yuanta-fund-statements.ts", import.meta.url),
  "utf8",
);

assert.doesNotMatch(source, /console\.|emitAutomationProgress/);
assert.match(source, /positions = await extractFundPositions\(site, input.includeHistoricalTransactions\)/);
assert.match(source, /evaluateYuantaFundCanonicalAdmission/);
assert.match(source, /PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND/);
assert.match(source, /PGLITE_CANONICAL_INVESTMENT_RELATIONS_RESOLVE_COMMAND/);
assert.doesNotMatch(source, /createCanonicalInvestmentStore/);
assert.doesNotMatch(source, /commitCanonicalInvestmentCaptureBatch/);
assert.doesNotMatch(
  source,
  /from\s+["']libretto["']|LibrettoWorkflowContext|export\s+default\s+yuantaFundStatements|requirePGliteChildRpcClientFromEnv|executePGliteWorkflowRun|node:fs\/promises|writeFile\(|writeOutputTableFiles|fundDownloadsDir|waitForEvent\(["']download["']\)/u,
  "Yuanta fund typed execution must not retain a legacy runner, database client, or file output path",
);
assert.match(
  source,
  /text\.assertIntact\(JSON\.stringify\(snapshot\.tables\)\)/u,
);
assert.match(source, /export async function runYuantaFundStatements/u);
assert.match(source, /reference-nav-and-fx-basis-date/);
assert.match(source, /investment-source-evidence/);

assert.equal(isYuantaFundPositionAbsentText("目前無持有基金"), true);
assert.equal(isYuantaFundPositionAbsentText("未持有基金部位"), true);
assert.equal(
  isYuantaFundPositionAbsentText("投資日期 基金名稱 交易編號"),
  false,
);
// Live investment-overview rows report the source currency as 台幣. It must
// reach the canonical adapter as ISO TWD rather than as a display label.
assert.equal(canonicalYuantaFundCurrency("台幣"), "TWD");
assert.equal(canonicalYuantaFundCurrency("美金"), "USD");
assert.equal(yuantaFundHistoryResultIsUnpaged("<table><tr><td>查無資料</td></tr></table>"), true);
assert.equal(
  yuantaFundHistoryResultIsUnpaged('<div class="pagination"><a>下一頁</a></div>'),
  false,
);

const position = {
  txnType: "S",
  paperNo: "FS00000001",
  trustNo: "YT01",
  label: "SANITIZED FUND",
};
const fundKey = "S:FS00000001:YT01";
/** The history the fixtures cover; the run's collection period queries it. */
const fundHistoryPeriod = fixedPeriod("2026-08-01", "2026-09-08");
const fundHistoryProof = {
  transactionHistory: {
    startDate: "2026-08-01",
    endDate: "2026-09-08",
    complete: true as const,
  },
  accountHistoryQueryCoverage: yuantaFundAccountHistoryQueries,
  occurrenceGroupCoverage: yuantaFundHistoryInvestmentTypes.map(type => ({
    scopeKey: yuantaFundAccountHistoryScope(type),
    startDate: "2026-08-01",
    endDate: "2026-09-08",
    contractVersion: "yuanta-fund/investment/canonical-v1",
  })),
};
const overview = {
  category: "investment-overview",
  fund: null,
  period: null,
  tableLabel: "investment-detail",
  rows: [
    [
      "投資日期",
      "幣別",
      "基金名稱 交易編號",
      "效率投資",
      "投資金額 不含息參考市值",
      "投資淨值 參考淨值",
      "單位數 參考匯率",
      "(不含息) 參考損益 參考報酬率",
      "(含息) 參考損益 參考報酬率",
      "累積配息 在途交易",
      "操作",
    ],
    [
      "2025/01/01",
      "新臺幣",
      "SANITIZED FUND FS00000001",
      "",
      "10000 10500",
      "10 10.5",
      "1000 1",
      "500 5%",
      "500 5%",
      "0 0",
      "",
    ],
  ],
};
const basisTable = {
  category: "investment-source-evidence",
  fund: fundKey,
  period: null,
  tableLabel: "reference-nav",
  rows: [
    ["參考項目", "參考基準日", "參考淨值", "最新淨值查詢"],
    ["贖回", "2026/09/01", "10.5", ""],
    ["申購", "2026/09/01", "10.6", ""],
    ["匯率", "2026/09/02", "1", ""],
  ],
};
const colspanBasisTable = {
  category: "investment-source-evidence",
  fund: fundKey,
  period: null,
  tableLabel: "reference-nav",
  rows: [
    ["參考項目", "參考基準日", "參考淨值", "最新淨值查詢"],
    ["贖回", "2026/09/04", "10.50台幣"],
    ["申購", "2026/09/04", "10.40台幣"],
    ["匯率", "2026/09/08", "1"],
  ],
  cellColspans: [
    [1, 1, 1, 1],
    [1, 1, 2],
    [1, 1, 2],
    [1, 1, 2],
  ],
};
const buyTable = {
  category: "historical-transactions",
  fund: fundKey,
  period: "2025/01/01-2026/09/08",
  tableLabel: "buy-details",
  rows: [
    [
      "投資日期",
      "基金名稱",
      "交易編號",
      "投資金額",
      "申購匯率",
      "申購淨值",
      "申購手續費",
      "點數折抵",
      "申購單位數",
    ],
    [
      "2026/08/28",
      "SANITIZED FUND",
      "FS00000001",
      "台幣 10000",
      "1",
      "10",
      "0",
      "0",
      "1000",
    ],
  ],
};
assert.throws(() => yuantaFundModule.normalizedRowsForTable({
  ...buyTable, rows: [...buyTable.rows, ["2026/08/29", "BROKEN"]],
}), /unsupported source column count/u);
assert.throws(() => yuantaFundModule.normalizedRowsForTable({
  ...buyTable, rows: [...buyTable.rows, ["查無資料"]],
}), /contradicts its explicit empty result/u);
const cashDividendLegacyHeader = ["入帳日期", "基金名稱 交易編號", "基準日期 計價幣別", "基準單位數 分配金額", "匯率 分配率", "入帳帳號"];
const cashDividendTaxHeader = [...cashDividendLegacyHeader.slice(0, 5), "已扣稅款 補充保費", "入帳金額 入帳帳號"];
const cashDividendOutputHeaders = ["入帳日期", "基金名稱", "交易編號", "基準日期", "計價幣別", "基準單位數", "分配金額",
  "匯率", "分配率", "入帳帳號", "已扣稅款", "補充保費", "入帳金額"];
const cashDividendTable = (rows: string[][]) => ({
  category: "historical-transactions", fund: "account-history:single", period: null, tableLabel: "cash-dividend-details", rows,
});
const legacyDividendCells = ["2026/08/12", "SANITIZED FUND FS00000001", "2026/08/11 美金", "20 4.2", "1 0.21", "SYNTHETIC-ACCOUNT"];
const taxDividendCells = [...legacyDividendCells.slice(0, 5), "0.3 0.1", "3.8 SYNTHETIC-ACCOUNT"];
const taxDividendRows = yuantaFundModule.normalizedRowsForTable(cashDividendTable([cashDividendTaxHeader, taxDividendCells]));
assert.deepEqual(taxDividendRows.map(row => row.values), [[
  "2026/08/12", "SANITIZED FUND", "FS00000001", "2026/08/11", "美金", "20", "4.2", "1", "0.21", "SYNTHETIC-ACCOUNT",
  "0.3", "0.1", "3.8",
]], "The seven-column cash dividend layout splits its paired tax and credited-amount cells");
const legacyDividendRows = yuantaFundModule.normalizedRowsForTable(cashDividendTable([cashDividendLegacyHeader, legacyDividendCells]));
assert.deepEqual(legacyDividendRows.map(row => row.values), [[...taxDividendRows[0]!.values.slice(0, 10), "", "", ""]],
  "The six-column cash dividend layout keeps its positions and leaves the tax columns empty");
const dividendEventDecode = {
  amount: (value: string) => {
    const match = /^(\d+)(?:\.(\d+))?$/u.exec(value);
    if (!match) throw new Error("Invalid check source amount");
    return { coefficient: match[1]! + (match[2] ?? ""), scale: match[2]?.length ?? 0 };
  },
  date: (value: string) => value.replaceAll("/", "-"),
  currency: canonicalYuantaFundCurrency,
  cashCurrency: yuantaFundSourceAmountCurrency,
};
const dividendEventFor = (rows: ReturnType<typeof yuantaFundModule.normalizedRowsForTable>) =>
  yuantaFundAdditionalEventRows("cash-dividend-details",
    Object.fromEntries(cashDividendOutputHeaders.map((header, index) => [header, rows[0]!.values[index] ?? ""])),
    "scope", dividendEventDecode)[0]!;
assert.deepEqual(dividendEventFor(taxDividendRows).cashEffect, { coefficient: "42", scale: 1, currency: "USD" });
assert.deepEqual(dividendEventFor(taxDividendRows).cashEffect, dividendEventFor(legacyDividendRows).cashEffect,
  "The dividend cash event stays the distribution amount in the pricing currency under both layouts");
const originalDividendEvent = yuantaFundAdditionalEventRows("cash-dividend-details",
  Object.fromEntries(cashDividendOutputHeaders.slice(0, 10).map((header, index) => [header, legacyDividendRows[0]!.values[index] ?? ""])),
  "scope", dividendEventDecode)[0]!;
assert.deepEqual(dividendEventFor(legacyDividendRows), originalDividendEvent,
  "Empty new columns must not change an existing dividend's source key or occurrence fingerprint");
assert.deepEqual(dividendEventFor(taxDividendRows), originalDividendEvent,
  "New tax and credited-amount columns must not change an existing dividend's source key or occurrence fingerprint");
assert.throws(() => yuantaFundModule.normalizedRowsForTable(cashDividendTable([cashDividendTaxHeader,
  [...taxDividendCells, "EXTRA"]])), /unsupported source column count/u);
assert.throws(() => yuantaFundModule.normalizedRowsForTable(cashDividendTable([
  [...cashDividendLegacyHeader.slice(0, 5), "未知欄位"], legacyDividendCells,
])), /supported source headers/u);
assert.throws(() => yuantaFundModule.normalizedRowsForTable(cashDividendTable([
  [...cashDividendLegacyHeader.slice(0, 5), "未知欄位 補充保費", "入帳金額 入帳帳號"], taxDividendCells,
])), /supported source headers/u);
assert.deepEqual(yuantaFundModule.normalizedRowsForTable(cashDividendTable([["查無資料"]])), []);
assert.throws(() => yuantaFundModule.normalizedRowsForTable(cashDividendTable([["查無資料"], taxDividendCells])),
  /contradicts its explicit empty result/u);
assert.deepEqual(parseYuantaFundValuationBasis(basisTable), {
  fundKey,
  navEffectiveOn: "2026-09-01",
  fxEffectiveOn: "2026-09-02",
});
assert.deepEqual(parseYuantaFundValuationBasis(colspanBasisTable), {
  fundKey,
  navEffectiveOn: "2026-09-04",
  fxEffectiveOn: "2026-09-08",
});
assert.throws(
  () =>
    parseYuantaFundValuationBasis({
      ...colspanBasisTable,
      cellColspans: colspanBasisTable.cellColspans?.map((row) =>
        row.length === 3 ? [1, 1, 1] : row,
      ),
    }),
  /unsupported source shape/,
);
assert.deepEqual(
  evaluateYuantaFundCanonicalAdmission([overview, basisTable], [position]),
  {
    status: "admitted",
    contractVersion: "yuanta-fund/investment/canonical-v1",
    holdingCount: 1,
    transactionCount: 0,
  },
);
assert.deepEqual(
  evaluateYuantaFundCanonicalAdmission(
    [overview, colspanBasisTable],
    [position],
  ),
  {
    status: "admitted",
    contractVersion: "yuanta-fund/investment/canonical-v1",
    holdingCount: 1,
    transactionCount: 0,
  },
);
const incompleteAdmission = evaluateYuantaFundCanonicalAdmission(
  [overview],
  [position],
);
if (incompleteAdmission.status !== "not-admitted") {
  throw new Error("overview-only fund evidence must remain non-admitted");
}
assert.equal(
  incompleteAdmission.reason,
  "source-effective-time-evidence-incomplete",
);
assert.throws(
  () => assertYuantaFundCanonicalAdmission(incompleteAdmission),
  (error: unknown) =>
    error instanceof CanonicalInvestmentAdmissionError &&
    error.message.includes("source-effective-time-evidence-incomplete"),
);
const partialSource = completeAccountHistoryFixture({ positions: [position], tables: [overview, buyTable] });
const partialAdmission = evaluateYuantaFundCanonicalAdmission(
  partialSource.tables, [position], fundHistoryProof,
);
assert.deepEqual(partialAdmission, {
  status: "partial",
  contractVersion: "yuanta-fund/investment/canonical-v1",
  holdingCount: 1,
  transactionCount: 1,
  reason: "source-effective-time-evidence-incomplete",
});
assert.throws(
  () => assertYuantaFundCanonicalAdmission(partialAdmission),
  (error: unknown) =>
    error instanceof CanonicalInvestmentAdmissionError &&
    error.message.includes("1 dated transaction row(s) were rejected") &&
    error.message.includes("the complete source was not admitted"),
);
assert.throws(
  () => assertYuantaFundCanonicalAdmission(incompleteAdmission),
  (error: unknown) =>
    error instanceof CanonicalInvestmentAdmissionError &&
    error.message ===
      "Yuanta fund canonical admission failed: source-effective-time-evidence-incomplete. Canonical Financial Commit was not opened.",
);
assert.doesNotThrow(() =>
  assertYuantaFundCanonicalAdmission(
    evaluateYuantaFundCanonicalAdmission([overview, basisTable], [position]),
  ),
);

const fundInput = yuantaFundStatementsInputSchema.parse({
  includePortfolioSummary: false,
  includeInvestmentDetails: true,
  includeHistoricalTransactions: false,
});
const fundHistoryInput = yuantaFundStatementsInputSchema.parse({
  includePortfolioSummary: false,
  includeInvestmentDetails: true,
  includeHistoricalTransactions: true,
});
const validFundSource: YuantaFundSourceSnapshot = {
  positions: [position],
  tables: [overview, basisTable],
};
/** Construct a complete synthetic account query inventory before deliberate negative mutations. */
function completeAccountHistoryFixture(source: YuantaFundSourceSnapshot): YuantaFundSourceSnapshot {
  const historical = source.tables.filter(table => table.category === "historical-transactions");
  const detailForLabel = new Map<string, string>([
    ["buy-details", "buy"], ["redemption-details", "sell"], ["redemption-account-details", "sell"],
    ["conversion-details", "trans"], ["cash-dividend-details", "profit"], ["unit-dividend-details", "devide"],
  ]);
  const results = yuantaFundAccountHistoryQueries.flatMap(query => {
    const matching = historical.filter(table => table.historyQuery
      ? table.historyQuery.investmentType === query.investmentType && table.historyQuery.detail === query.detail
      : query.investmentType === "single" && detailForLabel.get(table.tableLabel) === query.detail);
    if (matching.length) return matching.map(table => ({ ...table,
      fund: yuantaFundAccountHistoryKey(query.investmentType), historyQuery: query,
      period: "2026/08/01-2026/09/08",
    }));
    return [{ category: "historical-transactions", fund: yuantaFundAccountHistoryKey(query.investmentType),
      historyQuery: query, period: "2026/08/01-2026/09/08",
      tableLabel: query.detail === "deduct" && query.investmentType === "type3"
        ? "variable-deduction-details" : yuantaFundAccountHistoryTableLabels[query.detail],
      rows: [["查無資料"]],
    }];
  });
  return { ...source, ...fundHistoryProof,
    tables: [...source.tables.filter(table => table.category !== "historical-transactions"), ...results] };
}

type FundRun = Readonly<{
  snapshot: YuantaFundSourceSnapshot;
  items: PGliteWorkflowRunItem[];
  signal: AbortSignal;
  now?: () => string;
}>;
const fundSource = (
  snapshot: YuantaFundSourceSnapshot,
  items: PGliteWorkflowRunItem[],
  signal: AbortSignal,
): FundRun => ({ snapshot, items, signal });
const collectFund = (input: typeof fundInput, run: FundRun) =>
  stageYuantaFund(
    run.snapshot,
    { ...input, yuantaUserId: "synthetic-login", yuantaAccount: "synthetic-account" },
    yuantaCollectionContext({ now: run.now ?? "2026-09-09T12:00:00.000Z", signal: run.signal }),
    yuantaStagingHandle(run.items, [], fundHistoryPeriod),
  );
const committedInvestmentCapture = (items: readonly PGliteWorkflowRunItem[]) => {
  const command = items[0]?.command;
  if (!command || command.kind !== PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND)
    throw new Error("Expected a canonical investment commit command.");
  return command.request.capture;
};

const typedFundOutputDirectory = await mkdtemp(
  join(tmpdir(), "yuanta-fund-typed-output-"),
);
const typedFundOriginalCwd = process.cwd();
process.chdir(typedFundOutputDirectory);
try {
  const admittedItems: PGliteWorkflowRunItem[] = [];
  const collection = await collectFund(fundInput, fundSource(
      validFundSource,
      admittedItems,
      new AbortController().signal,
    ),
  );
  assert.deepEqual(collection, {
    sourceCaptureCount: 2,
    rowCount: 6,
  });
  assert.equal(admittedItems.length, 1);
  assert.equal(admittedItems[0]?.product, "investment");
  assert.equal(committedInvestmentCapture(admittedItems).securities[0]?.producerSecurityId, "name:SANITIZED FUND");
  const mismatchedPositionItems: PGliteWorkflowRunItem[] = [];
  await assert.rejects(collectFund(fundInput, fundSource({
      positions: [{ ...position, paperNo: "FS000000010" }],
      tables: [overview, basisTable],
    }, mismatchedPositionItems, new AbortController().signal),
  ));
  assert.equal(mismatchedPositionItems.length, 0, "A partial transaction-number match cannot admit a holding");
  const multipleLotItems: PGliteWorkflowRunItem[] = [];
  const secondPosition = { ...position, paperNo: "FS00000002" };
  const secondLot = [...overview.rows[1]];
  secondLot[2] = "SANITIZED FUND FS00000002";
  secondLot[6] = "0.125 1";
  secondLot[4] = "1.3125 1.3125";
  await collectFund(fundInput, fundSource({
      positions: [position, secondPosition],
      tables: [
        { ...overview, rows: [...overview.rows, secondLot] }, basisTable,
        { ...basisTable, fund: "S:FS00000002:YT01" },
      ],
    }, multipleLotItems, new AbortController().signal),
  );
  const groupedCapture = committedInvestmentCapture(multipleLotItems);
  assert.equal(groupedCapture.holdings.length, 1);
  assert.equal(groupedCapture.holdings[0]?.lineage.sourceLots?.length, 2);
  assert.deepEqual(groupedCapture.holdings[0]?.quantity, { coefficient: "1000125", scale: 3 });
  assert.deepEqual(groupedCapture.holdings[0]?.valuation, { coefficient: "105013125", scale: 4, currency: "TWD" });
  const holding = groupedCapture.holdings[0]!;
  assert.throws(() => admitCanonicalInvestmentCapture({ ...groupedCapture, holdings: [{ ...holding,
    quantity: { coefficient: "1", scale: 0 },
  }] }), /aggregate does not equal/u);
  const sourceLots = holding.lineage.sourceLots!;
  assert.throws(() => admitCanonicalInvestmentCapture({ ...groupedCapture, holdings: [{ ...holding,
    lineage: { ...holding.lineage, sourceLots: [sourceLots[0]!, { ...sourceLots[1]!, effectiveOn: "2026-01-01" }] },
  }] }), /contradictory/u);
  const database = await createTestPGlite("ledger");
  const store = new PGliteStore(database);
  try {
    const command = multipleLotItems[0]!.command;
    if (command.kind !== PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND) throw new Error("Expected investment command");
    await assert.rejects(commitPGliteCanonicalInvestmentCapture(store, {
      ...command.request,
      capture: { ...groupedCapture, holdings: [{ ...holding, quantity: { coefficient: "1", scale: 0 } }] },
    }), /aggregate does not equal/u);
    await assert.rejects(commitPGliteCanonicalInvestmentCapture(store, {
      ...command.request,
      capture: { ...groupedCapture, holdings: [{ ...holding,
        lineage: { ...holding.lineage, sourceLots: [sourceLots[0]!, { ...sourceLots[1]!, effectiveOn: "2026-01-01" }] },
      }] },
    }), /contradictory/u);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM source_captures")).rows[0]?.count, 0);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM investment_holding_observations")).rows[0]?.count, 0);
    await commitPGliteCanonicalInvestmentCapture(store, command.request);
    const query = createPGliteCanonicalOverviewQuery(store);
    const current = (await query.current()).projection;
    assert.equal(current.positions.length, 1);
    assert.deepEqual(current.positions[0]?.units, holding.quantity);
    assert.deepEqual(current.positions[0]?.amount?.exact, { coefficient: "105013125", scale: 4 });
    const historical = (await query.historical({ knowledgeAt: current.knowledgePoint, financialAt: holding.effectiveOn })).projection;
    assert.deepEqual(historical.positions[0]?.units, holding.quantity);
    assert.deepEqual(historical.positions[0]?.amount?.exact, current.positions[0]?.amount?.exact);
    const stored = await store.query<{ lineage_json: string }>("SELECT lineage_json FROM investment_holding_observations");
    assert.deepEqual(JSON.parse(stored.rows[0]!.lineage_json).sourceLots, sourceLots);
    // Even with an unchanged total, changed constituent source evidence must
    // conflict on replay rather than being excluded from the content hash.
    const alteredLots = sourceLots.map((lot, index) => ({ ...lot,
      quantity: index === 0 ? { coefficient: "9999", scale: 1 } : { coefficient: "225", scale: 3 },
    }));
    await assert.rejects(commitPGliteCanonicalInvestmentCapture(store, { ...command.request,
      capture: { ...groupedCapture, holdings: [{ ...holding, lineage: { ...holding.lineage, sourceLots: alteredLots } }] },
    }));
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM investment_holding_observations")).rows[0]?.count, 1);

  } finally {
    await store.close();
  }


  const eventItems: PGliteWorkflowRunItem[] = [];
  const eventDateLines = conversionDataLines.map(lines => [...lines]);
  eventDateLines[0] = ["2026/08/10", "2026/08/11"];
  eventDateLines[3] = ["123.45 USD"];
  const history = {
    startDate: "2026-08-01", endDate: "2026-09-08", complete: true as const,
  };
  const catalogTable = {
    category: "investment-source-evidence", fund: null, period: null, tableLabel: "fund-security-catalog",
    rows: [["基金代碼", "基金名稱", "計價幣別"],
      ["YT01", "SANITIZED FUND", "TWD"], ["U001", "SANITIZED OUT FUND", "USD"], ["A001", "SANITIZED IN FUND", "USD"]],
  };
  await collectFund(fundHistoryInput, fundSource(completeAccountHistoryFixture({
      positions: [position],
      tables: [overview, basisTable, catalogTable, {
        category: "historical-transactions", fund: "S:FS00000001:YT01", period: "2026/08/01-2026/09/08",
        tableLabel: "conversion-details", rows: [conversionHeaderLines, eventDateLines].map(row => row.map(lines => lines.join(" "))),
        cellLines: [conversionHeaderLines, eventDateLines],
      }, {
        category: "historical-transactions", fund: "S:FS00000001:YT01", period: "2026/08/01-2026/09/08", tableLabel: "cash-dividend-details",
        rows: [["入帳日期", "基金名稱 交易編號", "基準日期 計價幣別", "基準單位數 分配金額", "匯率 分配率", "入帳帳號"],
          ["2026/08/12", "SANITIZED IN FUND FS00000001", "2026/08/11\n美金", "20 4.2", "1 0.21", "SYNTHETIC-ACCOUNT"]],
      }, {
        category: "historical-transactions", fund: "S:FS00000001:YT01", period: "2026/08/01-2026/09/08", tableLabel: "unit-dividend-details",
        rows: [["分配日期", "基金名稱", "交易編號", "基準日期", "基準單位數", "分配率", "分配單位數"],
          ["2026/08/13", "SANITIZED IN FUND", "FS00000001", "2026/08/11", "20", "0.01", "0.2"]],
      }],
    }), eventItems, new AbortController().signal));
  const overlappingItems: PGliteWorkflowRunItem[] = [];
  const conversionTable = {
    category: "historical-transactions", fund: "S:FS00000001:YT01", period: "2026/08/01-2026/09/08",
    tableLabel: "conversion-details", rows: [conversionHeaderLines, eventDateLines].map(row => row.map(lines => lines.join(" "))),
    cellLines: [conversionHeaderLines, eventDateLines],
  };
  const overlappingSource = completeAccountHistoryFixture({ positions: [position, secondPosition],
    tables: [overview, basisTable, conversionTable, { ...conversionTable }] });
  await assert.rejects(collectFund(fundHistoryInput, fundSource(overlappingSource, overlappingItems, new AbortController().signal)));
  assert.equal(overlappingItems.length, 0, "Overlapping queries cannot double-count a conversion");
  const crossScopeTable = {
    category: "historical-transactions", fund: yuantaFundAccountHistoryKey("single"),
    historyQuery: { investmentType: "single", detail: "trans" } as const,
    period: "2026/08/01-2026/09/08", tableLabel: "conversion-details",
    rows: [conversionHeaderLines, eventDateLines].map(row => row.map(lines => lines.join(" "))),
    cellLines: [conversionHeaderLines, eventDateLines],
  };
  const crossScopeSource = completeAccountHistoryFixture({ positions: [position],
    tables: [overview, basisTable, crossScopeTable, { ...crossScopeTable,
      fund: yuantaFundAccountHistoryKey("type2"),
      historyQuery: { investmentType: "type2", detail: "trans" },
    }],
  });
  const crossScopeAdmission = evaluateYuantaFundCanonicalAdmission(crossScopeSource.tables,
    crossScopeSource.positions, fundHistoryProof);
  assert.equal(JSON.stringify(crossScopeAdmission).includes("SANITIZED"), false,
    "Rejected financial source values stay out of the public admission result");
  assert.throws(() => assertYuantaFundCanonicalAdmission(crossScopeAdmission), (error: unknown) =>
    error instanceof Error && error.cause instanceof Error && /overlapping account history queries/u.test(error.cause.message));
  const crossScopeItems: PGliteWorkflowRunItem[] = [];
  await assert.rejects(collectFund(fundHistoryInput, fundSource(crossScopeSource, crossScopeItems, new AbortController().signal)));
  assert.equal(crossScopeItems.length, 0, "Account scopes cannot double-count an ambiguous conversion");
  const aliasItems: PGliteWorkflowRunItem[] = [];
  await collectFund(fundHistoryInput, fundSource(completeAccountHistoryFixture({ positions: [position],
      tables: [overview, basisTable, { ...catalogTable, rows: [["基金代碼", "基金名稱", "計價幣別"], ["YT01", "SANITIZED LONGER CATALOG FUND NAME", "TWD"]] }, buyTable],
    }), aliasItems, new AbortController().signal));
  assert.equal(committedInvestmentCapture(aliasItems).transactions[0]?.securityKey, "yuanta-fund:name:SANITIZED FUND",
    "Catalog display names cannot rename a source-reported Security");
  const eventCapture = committedInvestmentCapture(eventItems);
  assert.deepEqual(eventCapture.transactions.map(row => [row.securityKey, row.action]), [["yuanta-fund:name:SANITIZED OUT FUND", "sell"], ["yuanta-fund:name:SANITIZED IN FUND", "buy"], ["yuanta-fund:name:SANITIZED IN FUND", "dividend"], ["yuanta-fund:name:SANITIZED IN FUND", "corporate_action_in"]]);
  const eventDb = await createTestPGlite("ledger");
  const eventStore = new PGliteStore(eventDb);
  try {
    const command = eventItems[0]!.command;
    if (command.kind !== PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND) throw new Error("Expected investment command");
    await commitPGliteCanonicalInvestmentCapture(eventStore, command.request);
    const projection = (await createPGliteCanonicalOverviewQuery(eventStore).current()).projection;
    assert.equal(projection.transactions.length, 4);
    const dividend = projection.transactions.find(row => row.amount.coefficient === "42");
    assert.equal(dividend?.currency, "USD");
  } finally { await eventStore.close(); }

  const duplicateBuyTable = {
    ...buyTable,
    period: "2026/08/01-2026/09/08",
    rows: [...buyTable.rows, buyTable.rows[1]!],
  };
  const tradeKeysFor = async (table: typeof buyTable) => {
    const items: PGliteWorkflowRunItem[] = [];
    const tradeSource = completeAccountHistoryFixture({
      positions: [position], tables: [overview, basisTable, table],
    });
    await collectFund(fundHistoryInput, fundSource(tradeSource, items, new AbortController().signal),
    );
    const capture = committedInvestmentCapture(items);
    return { capture, items };
  };
  // Account queries include a closed security absent from the current holdings.
  const accountTables = yuantaFundAccountHistoryQueries.map(query => ({
    category: "historical-transactions", fund: yuantaFundAccountHistoryKey(query.investmentType), period: null,
    historyQuery: query,
    tableLabel: query.detail === "deduct" && query.investmentType === "type3" ? "variable-deduction-details"
      : yuantaFundAccountHistoryTableLabels[query.detail],
    rows: [["查無資料"]],
  }));
  accountTables[0]!.rows = [buyTable.rows[0]!,
    ["2026/08/28", "SANITIZED CLOSED FUND", "CLOSED000001", "台幣 100", "1", "10", "0", "0", "10"],
    ["2026/08/28", "SANITIZED CLOSED FUND", "CLOSED000001", "台幣 100", "1", "10", "0", "0", "10"]];
  Object.assign(accountTables[1]!, redemptionAccountTable, { historyQuery: accountTables[1]!.historyQuery });
  const accountConversionLines = eventDateLines.map(lines => [...lines]);
  accountConversionLines[3] = ["100 台幣"];
  Object.assign(accountTables[2]!, {
    rows: [conversionHeaderLines, accountConversionLines].map(row => row.map(lines => lines.join(" "))),
    cellLines: [conversionHeaderLines, accountConversionLines],
  });
  accountTables[5]!.rows = [
    ["扣款日期", "基金名稱 交易編號", "扣款帳號/信用卡卡號", "投資金額", "手續費", "申購單位數", "申購匯率", "申購淨值"],
    ["2026/08/29", "SANITIZED CLOSED FUND PERIODIC000001", "SYNTHETIC-PAYMENT", "台幣 100", "0", "10", "1", "10"],
  ];
  accountTables[10]!.rows = [
    ["基金名稱 交易編號", "扣款日期", "扣款帳號/信用卡卡號", "投資金額", "當次扣款比重", "手續費", "申購單位數", "申購匯率", "申購淨值"],
    ["SANITIZED CLOSED FUND VARIABLE000001", "2026/08/30", "SYNTHETIC-PAYMENT", "台幣 100", "100%", "0", "10", "1", "10"],
  ];
  const accountSource: YuantaFundSourceSnapshot = {
    positions: [position], tables: [overview, basisTable, { ...catalogTable,
      rows: [...catalogTable.rows, ["C001", "SANITIZED CLOSED FUND", "USD"]] }, ...accountTables],
    transactionHistory: history,
    accountHistoryQueryCoverage: yuantaFundAccountHistoryQueries,
    occurrenceGroupCoverage: yuantaFundHistoryInvestmentTypes.map(type => ({
      scopeKey: yuantaFundAccountHistoryScope(type), startDate: history.startDate, endDate: history.endDate,
      contractVersion: "yuanta-fund/investment/canonical-v1",
    })),
  };
  const accountItems: PGliteWorkflowRunItem[] = [];
  await collectFund(fundHistoryInput, fundSource(accountSource, accountItems, new AbortController().signal));
  const accountCapture = committedInvestmentCapture(accountItems);
  assert.equal(accountCapture.holdings.length, 1);
  assert.equal(accountCapture.transactions.length, 7);
  assert.deepEqual(accountCapture.transactions.filter(row => row.securityKey === "yuanta-fund:name:SANITIZED CLOSED FUND").map(row => [row.securityKey, row.cashEffect.currency]),
    Array.from({ length: 5 }, () => ["yuanta-fund:name:SANITIZED CLOSED FUND", "TWD"]));
  assert.deepEqual(accountCapture.transactions.filter(row => row.securityKey !== "yuanta-fund:name:SANITIZED CLOSED FUND")
    .map(row => [row.securityKey, row.action, row.cashEffect.currency]),
    [["yuanta-fund:name:SANITIZED OUT FUND", "sell", "TWD"], ["yuanta-fund:name:SANITIZED IN FUND", "buy", "TWD"]]);
  assert.equal(accountCapture.securities.find(row => row.securityKey === "yuanta-fund:name:SANITIZED CLOSED FUND")?.currency, "");
  const closedOnlyItems: PGliteWorkflowRunItem[] = [];
  const closedOnly = { ...accountSource, positions: [], tables: [catalogTable,
    { ...catalogTable, rows: [["基金代碼", "基金名稱", "計價幣別"], ["C001", "SANITIZED CLOSED FUND", "USD"]] },
    { category: "investment-source-evidence", fund: null, period: null, tableLabel: "current-position-absence", rows: [["無基金部位"]] },
    ...accountTables.map(table => table === accountTables[0] ? { ...table,
      rows: [table.rows[0]!, table.rows[1]!, ["2026/09/01", ...table.rows[2]!.slice(1)]] } : table)] };
  await collectFund(fundHistoryInput, fundSource(closedOnly, closedOnlyItems, new AbortController().signal));
  assert.equal(closedOnlyItems.length, 1);
  const closedOnlyCapture = committedInvestmentCapture(closedOnlyItems);
  assert.equal(closedOnlyCapture.transactions.length, 7);
  assert.equal(closedOnlyCapture.occurrenceGroupCoverage?.length, 3);
  assert.equal(closedOnlyCapture.holdings.length, 0);
  const fullyEmptySource = { ...accountSource, positions: [], tables: [
    { category: "investment-source-evidence", fund: null, period: null, tableLabel: "current-position-absence", rows: [["無基金部位"]] },
    ...accountTables.map(table => ({ ...table, rows: [["查無資料"]], cellLines: undefined })),
  ] };
  const fullyEmptyItems: PGliteWorkflowRunItem[] = [];
  await collectFund(fundHistoryInput, fundSource(fullyEmptySource, fullyEmptyItems, new AbortController().signal));
  assert.equal(fullyEmptyItems.length, 1);
  const fullyEmptyCapture = committedInvestmentCapture(fullyEmptyItems);
  assert.equal(fullyEmptyCapture.holdings.length, 0);
  assert.equal(fullyEmptyCapture.transactions.length, 0);
  assert.equal(fullyEmptyCapture.securities.length, 0);
  assert.equal(fullyEmptyCapture.scope.effectiveOn, history.endDate);
  assert.deepEqual(fullyEmptyCapture.scope.transactionHistory, history);
  assert.deepEqual(fullyEmptyCapture.occurrenceGroupCoverage, accountSource.occurrenceGroupCoverage);
  const repeatedEmptyItems: PGliteWorkflowRunItem[] = [];
  await collectFund(fundHistoryInput, { ...fundSource(fullyEmptySource, repeatedEmptyItems, new AbortController().signal),
      now: () => "2026-09-10T12:00:00.000Z" });
  const repeatedEmptyCapture = committedInvestmentCapture(repeatedEmptyItems);
  assert.notEqual(repeatedEmptyCapture.captureId, fullyEmptyCapture.captureId);
  const emptyDb = await createTestPGlite("ledger");
  try {
    const emptyStore = new PGliteStore(emptyDb);
    await commitPGliteCanonicalInvestmentCapture(emptyStore, { capture: fullyEmptyCapture });
    await commitPGliteCanonicalInvestmentCapture(emptyStore, { capture: repeatedEmptyCapture });
    const emptyOverview = await createPGliteCanonicalOverviewQuery(emptyStore).current();
    assert.equal(emptyOverview.projection.transactions.length, 0);
  } finally { await emptyDb.close(); }
  for (const invalidSource of [
    { ...fullyEmptySource, tables: fullyEmptySource.tables.slice(1) },
    { ...fullyEmptySource, tables: fullyEmptySource.tables.slice(0, -1) },
    { ...fullyEmptySource, accountHistoryQueryCoverage: yuantaFundAccountHistoryQueries.slice(0, -1) },
  ]) {
    const rejectedItems: PGliteWorkflowRunItem[] = [];
    await assert.rejects(collectFund(fundHistoryInput, fundSource(invalidSource, rejectedItems, new AbortController().signal)));
    assert.equal(rejectedItems.length, 0, "Empty history still requires explicit absence and every complete report");
  }
  const repeatAccountItems: PGliteWorkflowRunItem[] = [];
  await collectFund(fundHistoryInput, { ...fundSource(accountSource, repeatAccountItems, new AbortController().signal),
      now: () => "2026-09-10T12:00:00.000Z" });
  const missingMetadataItems: PGliteWorkflowRunItem[] = [];
  const missingMetadataSource = { ...accountSource, tables: accountSource.tables.filter(table => table.tableLabel !== "fund-security-catalog") };
  await collectFund(fundHistoryInput, { ...fundSource(missingMetadataSource, missingMetadataItems, new AbortController().signal),
      now: () => "2026-09-11T12:00:00.000Z" });
  const missingMetadataCapture = committedInvestmentCapture(missingMetadataItems);
  assert.deepEqual(missingMetadataCapture.transactions.map(row => row.transactionKey), accountCapture.transactions.map(row => row.transactionKey),
    "Catalog removal or enrichment cannot change transaction identity");
  assert.ok(missingMetadataCapture.securities.every(security => security.identityEvidence.kind === "source-fund-name" && security.currency === ""));
  const normalizedNameItems: PGliteWorkflowRunItem[] = [];
  await collectFund(fundHistoryInput, { ...fundSource({ ...missingMetadataSource, tables: missingMetadataSource.tables.map(table => table === accountTables[0]
      ? { ...table, rows: table.rows.map((row, index) => index === 0 ? row : row.map((cell, column) => column === 1 ? "SANITIZED ＣＬＯＳＥＤ ＦＵＮＤ" : cell)) } : table) },
      normalizedNameItems, new AbortController().signal), now: () => "2026-09-12T12:00:00.000Z" });
  assert.deepEqual(committedInvestmentCapture(normalizedNameItems).transactions.map(row => row.transactionKey), accountCapture.transactions.map(row => row.transactionKey));
  const accountDb = await createTestPGlite("ledger");
  const accountStore = new PGliteStore(accountDb);
  try {
    await commitPGliteCanonicalInvestmentCapture(accountStore, { capture: accountCapture });
    await commitPGliteCanonicalInvestmentCapture(accountStore, { capture: committedInvestmentCapture(repeatAccountItems) });
    await commitPGliteCanonicalInvestmentCapture(accountStore, { capture: missingMetadataCapture });
    await commitPGliteCanonicalInvestmentCapture(accountStore, { capture: committedInvestmentCapture(normalizedNameItems) });
    assert.equal((await createPGliteCanonicalOverviewQuery(accountStore).current()).projection.transactions.length, 7);
    for (const mutate of [
      (capture: typeof missingMetadataCapture) => { capture.securities[0]!.producerSecurityId = "name:OTHER"; },
      (capture: typeof missingMetadataCapture) => { capture.securities[0]!.currency = "USD"; },
      (capture: typeof missingMetadataCapture) => { capture.securities[0]!.name = "OTHER"; },
    ]) {
      const invalid = structuredClone(missingMetadataCapture); mutate(invalid);
      await assert.rejects(commitPGliteCanonicalInvestmentCapture(accountStore, { capture: invalid }), /Security identity/u);
    }
    assert.equal((await createPGliteCanonicalOverviewQuery(accountStore).current()).projection.transactions.length, 7);
  } finally { await accountStore.close(); }
  const mixedCurrencyItems: PGliteWorkflowRunItem[] = [];
  await collectFund(fundHistoryInput, fundSource({ ...missingMetadataSource, tables: missingMetadataSource.tables.map(table => table === accountTables[5]
      ? { ...table, rows: table.rows.map((row, index) => index === 0 ? row : row.map((cell, column) => column === 3 ? "美元 100" : cell)) } : table) },
      mixedCurrencyItems, new AbortController().signal));
  const mixedCurrencyCapture = committedInvestmentCapture(mixedCurrencyItems);
  assert.deepEqual(new Set(mixedCurrencyCapture.transactions.filter(row => row.securityKey === "yuanta-fund:name:SANITIZED CLOSED FUND")
    .map(row => row.cashEffect.currency)), new Set(["TWD", "USD"]));
  assert.equal(mixedCurrencyCapture.securities.find(security => security.securityKey === "yuanta-fund:name:SANITIZED CLOSED FUND")?.currency, "");
  const mixedCurrencyDb = await createTestPGlite("ledger");
  const mixedCurrencyStore = new PGliteStore(mixedCurrencyDb);
  try {
    await commitPGliteCanonicalInvestmentCapture(mixedCurrencyStore, { capture: mixedCurrencyCapture });
    assert.equal((await createPGliteCanonicalOverviewQuery(mixedCurrencyStore).current()).projection.transactions.length, 7);
  } finally { await mixedCurrencyStore.close(); }
  for (const incomplete of [
    { ...accountSource, accountHistoryQueryCoverage: yuantaFundAccountHistoryQueries.slice(1) },
    { ...accountSource, tables: accountSource.tables.filter(table => table !== accountTables[14]) },
    { ...accountSource, tables: accountSource.tables.map(table => table === accountTables[0]
      ? { ...table, fund: yuantaFundAccountHistoryKey("type2") } : table) },
    { ...accountSource, tables: accountSource.tables.map(table => table === accountTables[0]
      ? { ...table, rows: table.rows.map((row, index) => index === 0 ? row : row.map((cell, column) => column === 3 ? "100" : cell)) } : table) },
  ]) {
    const items: PGliteWorkflowRunItem[] = [];
    await assert.rejects(collectFund(fundHistoryInput, fundSource(incomplete, items, new AbortController().signal)));
    assert.equal(items.length, 0);
  }
  const firstHistory = await tradeKeysFor(duplicateBuyTable);
  const missingInventoryItems: PGliteWorkflowRunItem[] = [];
  await assert.rejects(collectFund(fundHistoryInput, fundSource({ positions: [position], tables: [overview, basisTable, buyTable],
      transactionHistory: fundHistoryProof.transactionHistory,
      occurrenceGroupCoverage: fundHistoryProof.occurrenceGroupCoverage,
    }, missingInventoryItems, new AbortController().signal)), /complete account-wide report inventory/u);
  assert.equal(missingInventoryItems.length, 0, "Current holdings cannot authorize complete account history");
  assert.equal(firstHistory.capture.transactions.length, 2);
  assert.deepEqual(firstHistory.capture.transactions.map(row => row.securityKey), ["yuanta-fund:name:SANITIZED FUND", "yuanta-fund:name:SANITIZED FUND"]);
  assert.deepEqual(
    firstHistory.capture.transactions.map((transaction) => transaction.occurrenceGroup?.ordinal),
    [1, 2],
  );
  assert.deepEqual(firstHistory.capture.scope.transactionHistory, fundHistoryProof.transactionHistory);
  assert.deepEqual(firstHistory.capture.occurrenceGroupCoverage, fundHistoryProof.occurrenceGroupCoverage);
  const originalDuplicateKeys = firstHistory.capture.transactions
    .map((transaction) => transaction.sourceRecordKey)
    .sort();
  const unrelatedTransaction = [
    "2026/08/27", "SANITIZED FUND", "T98765", "台幣 3000", "1", "10", "0", "0", "300",
  ];
  const reorderedWithInsertion = {
    ...duplicateBuyTable,
    rows: [duplicateBuyTable.rows[0]!, unrelatedTransaction, duplicateBuyTable.rows[2]!, duplicateBuyTable.rows[1]!],
  };
  const shiftedHistory = await tradeKeysFor(reorderedWithInsertion);
  assert.equal(shiftedHistory.capture.transactions.length, 3);
  assert.deepEqual(
    shiftedHistory.capture.transactions
      .filter((transaction) => transaction.effectiveOn === "2026-08-28")
      .map((transaction) => transaction.sourceRecordKey)
      .sort(),
    originalDuplicateKeys,
  );
  assert.deepEqual(
    shiftedHistory.capture.transactions
      .filter((transaction) => transaction.effectiveOn === "2026-08-28")
      .map((transaction) => transaction.occurrenceGroup?.ordinal),
    [1, 2],
  );

  const emptyHistoryItems: PGliteWorkflowRunItem[] = [];
  await collectFund(fundHistoryInput, fundSource(completeAccountHistoryFixture({
      positions: [position], tables: [overview, basisTable],
    }), emptyHistoryItems, new AbortController().signal),
  );
  const emptyCapture = committedInvestmentCapture(emptyHistoryItems);
  assert.equal(emptyCapture.transactions.length, 0);
  assert.deepEqual(emptyCapture.occurrenceGroupCoverage, fundHistoryProof.occurrenceGroupCoverage);

  const partialItems: PGliteWorkflowRunItem[] = [];
  const partialSource = completeAccountHistoryFixture({
    positions: [position], tables: [overview, buyTable],
  });
  await assert.rejects(
    collectFund(fundHistoryInput, fundSource(
        partialSource,
        partialItems,
        new AbortController().signal,
      ),
    ),
    /dated transaction row\(s\) were rejected/u,
  );
  assert.deepEqual(partialItems, []);

  const malformedItems: PGliteWorkflowRunItem[] = [];
  const malformedSource: YuantaFundSourceSnapshot = {
    positions: [position],
    tables: [
      {
        ...overview,
        rows: overview.rows.map((row) =>
          row.map((value) => value.replace("SANITIZED", "SANITIZED\uFFFD")),
        ),
      },
      basisTable,
    ],
  };
  await assert.rejects(
    collectFund(fundInput, fundSource(
        malformedSource,
        malformedItems,
        new AbortController().signal,
      ),
    ),
    /replacement-character/u,
  );
  assert.deepEqual(malformedItems, []);

  const cancelledItems: PGliteWorkflowRunItem[] = [];
  const cancellation = new AbortController();
  cancellation.abort();
  await assert.rejects(
    collectFund(fundInput, fundSource(validFundSource, cancelledItems, cancellation.signal),
    ),
    /abort/u,
  );
  assert.deepEqual(cancelledItems, []);
  assert.deepEqual(await readdir(typedFundOutputDirectory), []);
} finally {
  process.chdir(typedFundOriginalCwd);
  await rm(typedFundOutputDirectory, { recursive: true, force: true });
}

// The read half against a synthetic signed-in frameset (ADR 0066): the site
// opens each fund route in fmain, the position detail, every account history
// report and the off-hour query are submitted, and each read waits for the
// page that replaced the one it submitted from.
const FUND_SHELL_CID = "synthetic-fund-cid";
type FundShellOptions = Readonly<{
  input: Record<string, unknown>;
  signal?: AbortSignal;
  /** The summary route renders only a shell, as when the fund menu must be entered through menuaction(). */
  summaryNeedsMenu?: boolean;
  holdHistoryQuery?: () => void;
  detailNav?: string;
}>;

async function readFundThroughShell(browser: import("playwright").Browser, options: FundShellOptions) {
  const page = await browser.newPage();
  const served: string[] = [];
  const posted: Array<Readonly<{ path: string; fields: URLSearchParams }>> = [];
  const activities: string[] = [];
  const html = (body: string) => ({ contentType: "text/html; charset=utf-8", body });
  const mform = (extra = "") => `<form id="mform" name="mform" method="post" action="/nib/tx/fundsummary">
    <input type="hidden" name="cid" value="${FUND_SHELL_CID}">${extra}</form>`;
  const summary = `${mform()}<table class="rwdTable"><tr><th>基金名稱</th><th>基金類型</th><th>投資幣別</th></tr>
    <tr><td>SANITIZED FUND</td><td>股票型</td><td>台幣</td></tr></table>`;
  const overview = `${mform()}<table class="rwdTable"><tr><th>投資日期</th><th>基金名稱</th><th>交易編號</th><th>累積配息</th></tr>
    <tr><td>2026/01/02</td><td><a href="#" onclick="fundDetail('FundSingleDetail','FS00000001','YT01')">SANITIZED FUND</a></td><td>FS00000001</td><td>0</td></tr></table>
    <a href="#" onclick="doOffhourQuery()">營業時間外交易查詢</a>
    <script>function doOffhourQuery() { location.href = "/nib/tx/offhourqueryandcancel?method=init"; }</script>`;
  const detail = `${mform()}<table class="normalTable"><tr><th>參考項目</th><th>參考基準日</th><th>參考淨值</th></tr>
    <tr><td>${options.detailNav ?? "淨值"}</td><td>2026/01/30</td><td>10.5</td></tr></table>`;
  // The query form shows 查詢日期, so a read of the form instead of its result would look like a result.
  const historyForm = `${mform(`<input name="fundtransactiondetails_sdate"><input name="fundtransactiondetails_edate">`)}
    <table class="formTable"><tr><td>查詢日期</td><td>起迄</td></tr></table>`;
  const historyResult = `${mform()}<table class="normalTable"><tr><td>查無資料</td></tr></table>`;
  const offHourForm = `${mform(`<input id="sdate" name="sdate"><input id="edate" name="edate">`)}
    <table class="formTable"><tr><td>查詢起迄日</td><td>起迄</td></tr></table>`;
  const offHourResult = `${mform()}<table class="normalTable"><tr><th>申購基金</th><th>投資類型</th><th>申購日期</th></tr>
    <tr><td>SANITIZED FUND</td><td>單筆</td><td>2026/01/15</td></tr></table>`;
  try {
    await page.route(`${YUANTA_EBANK_ORIGIN}/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      served.push(`${request.method()} ${url.pathname}${url.search}`);
      if (request.method() === "POST") {
        const fields = new URLSearchParams(request.postData() ?? "");
        posted.push({ path: `${url.pathname}${url.search}`, fields });
        // The detail and off-hour results arrive late, while the page they were submitted from still shows.
        const late = () => new Promise((resolve) => setTimeout(resolve, 500));
        if (url.pathname === "/nib/tx/fundsummary") return await late().then(() => route.fulfill(html(detail)));
        if (url.pathname === "/nib/tx/fundtransactiondetails") {
          if (options.holdHistoryQuery) {
            options.holdHistoryQuery();
            return;
          }
          return await route.fulfill(html(historyResult));
        }
        if (url.pathname === "/nib/tx/offhourqueryandcancel") return await late().then(() => route.fulfill(html(offHourResult)));
      }
      const signedIn = url.searchParams.get("cid") === FUND_SHELL_CID;
      switch (url.pathname) {
        case "/nib/shell.jsp":
          return await route.fulfill(html(`<iframe name="fmenu" src="/nib/menu.jsp"></iframe><iframe name="fmain" src="/nib/tx/home?type=page&cid=${FUND_SHELL_CID}"></iframe>`));
        case "/nib/menu.jsp":
          return await route.fulfill(html(`<script>
            window.menuaction = (action, id, flag) => {
              parent.menuCalls = [...(parent.menuCalls ?? []), [action, id, flag]];
              parent.frames.fmain.location.href = "/nib/tx/" + action + "&menu=" + id;
            };
          </script>`));
        case "/nib/tx/fundsummary": {
          const txnType = url.searchParams.get("TxnType");
          if (txnType === "FundSummary") {
            const rendered = options.summaryNeedsMenu ? url.searchParams.get("menu") === "menu_fundSummary" : signedIn;
            return await route.fulfill(html(rendered ? summary : `<p>請由選單進入</p>`));
          }
          if (txnType === "unknow" && signedIn) return await route.fulfill(html(overview));
          break;
        }
        case "/nib/tx/fundtransactiondetails":
          if (signedIn) return await route.fulfill(html(historyForm));
          break;
        case "/nib/tx/offhourqueryandcancel":
          return await route.fulfill(html(offHourForm));
      }
      return await route.fulfill(html(`<p>${url.pathname}</p>`));
    });
    await page.goto(`${YUANTA_EBANK_ORIGIN}/nib/shell.jsp`, { waitUntil: "load" });
    const snapshot = await yuantaFundModule.readYuantaFundSource(
      page,
      yuantaFundStatementsInputSchema.parse(options.input),
      yuantaCollectionContext({ signal: options.signal }),
      yuantaStagingHandle([], activities, fixedPeriod("2026-01-01", "2026-01-31")),
    );
    const menuCalls = await page.evaluate(() => (window as { menuCalls?: unknown }).menuCalls);
    return { snapshot, served, posted, activities, menuCalls };
  } finally {
    await page.close();
  }
}

test("Yuanta fund source reads every page through the fund routes and submits each query from its page", async () => {
  const browser = await chromium.launch({ headless: true });
  const input = {
    includeOffHourOrders: true,
  };
  try {
    const read = await readFundThroughShell(browser, { input });
    for (const route of ["fundsummary?TxnType=FundSummary", "fundsummary?TxnType=unknow", "fundtransactiondetails"]) {
      const separator = route.includes("?") ? "&" : "?";
      assert.ok(
        read.served.includes(`GET /nib/tx/${route}${separator}type=page&cid=${FUND_SHELL_CID}`),
        `the ${route} route opens in fmain with the session's cid`,
      );
    }
    assert.equal(read.menuCalls, undefined, "a route that renders its page needs no menuaction()");
    assert.deepEqual(read.posted.map((post) => post.path), [
      "/nib/tx/fundsummary",
      ...yuantaFundAccountHistoryQueries.map(() => "/nib/tx/fundtransactiondetails"),
      "/nib/tx/offhourqueryandcancel?method=query",
    ]);
    const detailQuery = read.posted[0]!.fields;
    assert.deepEqual(
      [detailQuery.get("TxnType"), detailQuery.get("PapernNo"), detailQuery.get("TrustNo")],
      ["FundSingleDetail", "FS00000001", "YT01"],
    );
    assert.deepEqual(
      read.posted.slice(1, -1).map((post) => [post.fields.get("inv_type"), post.fields.get("qry_option"),
        post.fields.get("fundtransactiondetails_sdate"), post.fields.get("fundtransactiondetails_edate")]),
      yuantaFundAccountHistoryQueries.map((query) => [query.investmentType, query.detail, "2026/01/01", "2026/01/31"]),
      "every account history report is queried in order over the requested range",
    );
    assert.deepEqual(
      [read.posted.at(-1)!.fields.get("sdate"), read.posted.at(-1)!.fields.get("edate")],
      ["2026/01/01", "2026/01/31"],
    );
    assert.equal(read.activities.length, 3 + yuantaFundAccountHistoryQueries.length + 2);
    assert.deepEqual(read.snapshot.positions, [
      { txnType: "FundSingleDetail", paperNo: "FS00000001", trustNo: "YT01", label: "SANITIZED FUND" },
    ]);
    const labels = (category: string) =>
      read.snapshot.tables.filter((table) => table.category === category).map((table) => table.tableLabel);
    assert.deepEqual(labels("portfolio-summary"), ["portfolio-summary"]);
    assert.deepEqual(labels("investment-overview"), ["investment-detail"]);
    assert.deepEqual(labels("investment-source-evidence"), ["reference-nav"], "the detail page, not the overview it was submitted from");
    const history = read.snapshot.tables.filter((table) => table.category === "historical-transactions");
    assert.equal(history.length, yuantaFundAccountHistoryQueries.length);
    assert.ok(
      history.every((table) => table.rows.flat().join(" ") === "查無資料"),
      "each history read is the submitted result, not the query form it replaced",
    );
    assert.deepEqual(labels("offhour-orders"), ["offhour-buy-orders"]);
    assert.deepEqual(read.snapshot.accountHistoryQueryCoverage, yuantaFundAccountHistoryQueries);

    await assert.rejects(
      readFundThroughShell(browser, { input, detailNav: "淨�值" }),
      SourceTextIntegrityError,
      "a detail page with a replacement character fails the read",
    );

    const cancellation = new AbortController();
    const started = Date.now();
    await assert.rejects(
      readFundThroughShell(browser, {
        input,
        signal: cancellation.signal,
        holdHistoryQuery: () => cancellation.abort(new Error("fund read cancelled")),
      }),
      /fund read cancelled/u,
      "a run cancelled mid-query stops inside its wait",
    );
    assert.ok(Date.now() - started < 10_000, "the cancelled query does not wait out its response timeout");
  } finally {
    await browser.close();
  }
});

test("Yuanta fund summary falls back to the fund menu's menuaction() when its route renders no tables", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const read = await readFundThroughShell(browser, {
      input: { includePortfolioSummary: true, includeHistoricalTransactions: false },
      summaryNeedsMenu: true,
    });
    assert.deepEqual(read.menuCalls, [["fundsummary?TxnType=FundSummary", "menu_fundSummary", "N"]]);
    assert.deepEqual(read.snapshot.tables.map((table) => table.tableLabel), ["portfolio-summary"]);
  } finally {
    await browser.close();
  }
});

test("Yuanta funds query 365 days ending on the run's Taipei date", () => {
  const declaration = YUANTA_SOURCE.statementSelection!.products.find(({ id }) => id === "fund")!.collectionPeriod!;
  // 16:30Z on Feb 28 is 00:30 on Mar 1 in Taipei; the period starts 364 days earlier.
  const period = collectionPeriod({ today: taipeiToday("2026-02-28T16:30:00.000Z"), ...declaration });
  assert.deepEqual([period.start, period.end], ["2025-03-02", "2026-03-01"]);
});
