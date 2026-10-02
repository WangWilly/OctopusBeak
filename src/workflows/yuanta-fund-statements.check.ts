import assert from "node:assert/strict";
import { yuantaFundAccountHistoryQueries, yuantaFundAccountHistoryKey, yuantaFundAccountHistoryScope,
  yuantaFundAccountHistoryTableLabels, yuantaFundHistoryInvestmentTypes } from "./yuanta-fund-account-history.ts";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteBaseline } from "../ledger/pglite/baseline.ts";
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
import { strictSourceText } from "../lib/automation/source-text.ts";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import { PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND } from "../ledger/pglite/workflow-client.ts";
import { runSelectedStatements } from "./run-selected-statements.ts";

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
  ["SANITIZED ACCOUNT DESCRIPTION", "123456789012", "台幣 100"], ["台幣 0", "0%"], []];
const redemptionAccountFooter = ["合計", "贖回投資金額", "台幣 100", "贖回參考損益", "台幣 0", "贖回參考報酬率", "0%", ""];
const redemptionAccountTable = {
  category: "historical-transactions", fund: "account-history:single", period: null, tableLabel: "redemption-account-details",
  rows: [redemptionAccountHeader, redemptionAccountData.map(lines => lines.join(" ")), redemptionAccountFooter],
  cellLines: [redemptionAccountHeader.map(value => value.split(" ")), redemptionAccountData, redemptionAccountFooter.map(value => [value])],
  cellColspans: Array.from({ length: 3 }, () => Array(8).fill(1) as number[]),
};
const redemptionAccountResult = yuantaFundModule.normalizedRowsForTable(redemptionAccountTable);
assert.equal(redemptionAccountResult.length, 1);
assert.equal(redemptionAccountResult[0]?.values[11], "SANITIZED ACCOUNT DESCRIPTION 123456789012");
assert.equal(redemptionAccountResult[0]?.values[12], "台幣 100");
assert.throws(() => yuantaFundModule.normalizedRowsForTable({ ...redemptionAccountTable,
  rows: [...redemptionAccountTable.rows.slice(0, 2), ["合計", "SANITIZED FUND", ...redemptionAccountFooter.slice(2)]],
}), /aggregate footer/u);
assert.throws(() => yuantaFundModule.normalizedRowsForTable({ ...redemptionAccountTable,
  cellColspans: [...redemptionAccountTable.cellColspans.slice(0, 2), [1, 2, 1, 1, 1, 1, 1, 1]],
}), /aggregate footer/u);
const emptyHoldingsPage = {
  frames: () => [],
  locator: (selector: string) => selector === "body" ? { innerText: async () => "無基金部位" }
    : selector.startsWith("a[") ? { count: async () => 0 }
    : { first: () => ({ waitFor: async () => undefined }) },
};
assert.deepEqual(await yuantaFundModule.extractFundPositions(emptyHoldingsPage as never, true), []);
await assert.rejects(yuantaFundModule.extractFundPositions(emptyHoldingsPage as never),
  /No YuanTa fund position/u);
const evaluateYuantaFundCanonicalAdmission: typeof yuantaFundModule.evaluateYuantaFundCanonicalAdmission =
  yuantaFundModule.evaluateYuantaFundCanonicalAdmission;
const assertYuantaFundCanonicalAdmission: typeof yuantaFundModule.assertYuantaFundCanonicalAdmission =
  yuantaFundModule.assertYuantaFundCanonicalAdmission;
const isYuantaFundPositionAbsentText: typeof yuantaFundModule.isYuantaFundPositionAbsentText =
  yuantaFundModule.isYuantaFundPositionAbsentText;
const parseYuantaFundValuationBasis: typeof yuantaFundModule.parseYuantaFundValuationBasis =
  yuantaFundModule.parseYuantaFundValuationBasis;
const canonicalYuantaFundCurrency: typeof yuantaFundModule.canonicalYuantaFundCurrency =
  yuantaFundModule.canonicalYuantaFundCurrency;
const runYuantaFundStatements: typeof yuantaFundModule.runYuantaFundStatements =
  yuantaFundModule.runYuantaFundStatements;
const yuantaFundHistoryResultIsUnpaged: typeof yuantaFundModule.yuantaFundHistoryResultIsUnpaged =
  yuantaFundModule.yuantaFundHistoryResultIsUnpaged;
const yuantaFundStatementsInputSchema: typeof yuantaFundModule.yuantaFundStatementsInputSchema =
  yuantaFundModule.yuantaFundStatementsInputSchema;

const source = await readFile(
  new URL("./yuanta-fund-statements.ts", import.meta.url),
  "utf8",
);

assert.doesNotMatch(source, /console\.|emitAutomationProgress/);
assert.match(source, /positions = await extractFundPositions\(page, input.includeHistoricalTransactions\)/);
assert.match(source, /runFundMenuAction\(/);
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
  /sourceText\.assertIntact\(JSON\.stringify\(sourceCollection\.tables\)\)/u,
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
const fundHistoryDateRange = {
  startDate: "2026/08/01",
  endDate: "2026/09/08",
};
const fundHistoryProof = {
  transactionHistory: {
    startDate: "2026-08-01",
    endDate: "2026-09-08",
    complete: true as const,
  },
  occurrenceGroupCoverage: [{
    scopeKey: deriveSourceConnectionIdentityKey(
      "yuanta-fund-occurrence-scope",
      [position.txnType, position.paperNo, position.trustNo],
    ),
    startDate: "2026-08-01",
    endDate: "2026-09-08",
    contractVersion: "yuanta-fund/investment/canonical-v1",
  }],
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
      "10000",
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
const partialAdmission = evaluateYuantaFundCanonicalAdmission(
  [overview, buyTable],
  [position],
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
const wrappedPartialRun = await runSelectedStatements(
  ["fund"],
  [
    {
      typeId: "fund",
      run: async () => {
        assertYuantaFundCanonicalAdmission(partialAdmission);
        return { count: 1 };
      },
    },
  ],
);
assert.deepEqual(wrappedPartialRun.results, [
  {
    typeId: "fund",
    status: "failed",
    error:
      "Yuanta fund canonical admission partial: source-effective-time-evidence-incomplete. 1 dated transaction row(s) were rejected; the complete source was not admitted because the source did not report a holding effective date.",
  },
]);
assert.equal(Object.hasOwn(wrappedPartialRun.outputs, "fund"), false);
const wrappedIncompleteRun = await runSelectedStatements(
  ["fund"],
  [
    {
      typeId: "fund",
      run: async () => {
        assert.throws(
          () => assertYuantaFundCanonicalAdmission(incompleteAdmission),
          (error: unknown) =>
            error instanceof CanonicalInvestmentAdmissionError &&
            error.message.includes("source-effective-time-evidence-incomplete"),
        );
        assertYuantaFundCanonicalAdmission(incompleteAdmission);
        return { count: 0 };
      },
    },
  ],
);
assert.deepEqual(wrappedIncompleteRun.results, [
  {
    typeId: "fund",
    status: "failed",
    error:
      "Yuanta fund canonical admission failed: source-effective-time-evidence-incomplete. Canonical Financial Commit was not opened.",
  },
]);
assert.equal(Object.hasOwn(wrappedIncompleteRun.outputs, "fund"), false);

const wrappedAdmittedRun = await runSelectedStatements(
  ["fund"],
  [
    {
      typeId: "fund",
      run: async () => {
        assertYuantaFundCanonicalAdmission(
          evaluateYuantaFundCanonicalAdmission(
            [overview, basisTable],
            [position],
          ),
        );
        return { count: 1 };
      },
    },
  ],
);
assert.deepEqual(wrappedAdmittedRun.results, [
  { typeId: "fund", status: "success" },
]);
assert.deepEqual(wrappedAdmittedRun.outputs.fund, { count: 1 });

type FundSourceCollector = NonNullable<
  Parameters<typeof runYuantaFundStatements>[3]["collectSourceTables"]
>;
const fundInput = yuantaFundStatementsInputSchema.parse({
  includePortfolioSummary: false,
  includeInvestmentDetails: true,
  includeHistoricalTransactions: false,
});
const fundHistoryInput = yuantaFundStatementsInputSchema.parse({
  includePortfolioSummary: false,
  includeInvestmentDetails: true,
  includeHistoricalTransactions: true,
  customDateRange: fundHistoryDateRange,
});
const validFundCollector: FundSourceCollector = async () => ({
  positions: [position],
  tables: [overview, basisTable],
});
const fundDependencies = (
  collector: FundSourceCollector,
  deferredCommitItems: PGliteWorkflowRunItem[],
  signal: AbortSignal,
): Parameters<typeof runYuantaFundStatements>[3] => ({
  collectOnly: true,
  deferredCommitItems,
  sourceText: strictSourceText,
  signal,
  now: () => "2026-09-09T12:00:00.000Z",
  collectSourceTables: async (...args) => {
    const source = await collector(...args);
    // Synthetic fixtures explicitly own their entire position universe.
    return { ...source, ...(source.transactionHistory ? {
      historyPositionInventory: {
        sourceContract: "yuanta-fund/all-position-history-v1" as const,
        complete: true as const,
        positionKeys: source.positions.map(p => `${p.txnType}:${p.paperNo}:${p.trustNo}`),
      },
    } : {}) };
  },
});
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
  const collection = await runYuantaFundStatements(
    {} as never,
    fundInput,
    { yuanta_user_id: "synthetic-login", yuanta_account: "synthetic-account" },
    fundDependencies(
      validFundCollector,
      admittedItems,
      new AbortController().signal,
    ),
  );
  assert.deepEqual(collection, {
    sourceCount: 2,
    rowCount: 6,
    itemCount: 1,
  });
  assert.equal(admittedItems.length, 1);
  assert.equal(admittedItems[0]?.provider, "yuanta-fund");
  assert.equal(admittedItems[0]?.product, "investment");
  assert.equal(committedInvestmentCapture(admittedItems).securities[0]?.producerSecurityId, "name:SANITIZED FUND");
  const mismatchedPositionItems: PGliteWorkflowRunItem[] = [];
  await assert.rejects(runYuantaFundStatements(
    {} as never,
    fundInput,
    { yuanta_user_id: "synthetic-login", yuanta_account: "synthetic-account" },
    fundDependencies(async () => ({
      positions: [{ ...position, paperNo: "FS000000010" }],
      tables: [overview, basisTable],
    }), mismatchedPositionItems, new AbortController().signal),
  ));
  assert.equal(mismatchedPositionItems.length, 0, "A partial transaction-number match cannot admit a holding");
  const multipleLotItems: PGliteWorkflowRunItem[] = [];
  const secondPosition = { ...position, paperNo: "FS00000002" };
  const secondLot = [...overview.rows[1]];
  secondLot[2] = "SANITIZED FUND FS00000002";
  secondLot[6] = "0.125 1";
  secondLot[4] = "1.3125 1.3125";
  await runYuantaFundStatements(
    {} as never,
    fundInput,
    { yuanta_user_id: "synthetic-login", yuanta_account: "synthetic-account" },
    fundDependencies(async () => ({
      positions: [position, secondPosition],
      tables: [
        { ...overview, rows: [...overview.rows, secondLot] }, basisTable,
        { ...basisTable, fund: "S:FS00000002:YT01" },
      ],
    }), multipleLotItems, new AbortController().signal),
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
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
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
  const history = {
    startDate: "2026-08-01", endDate: "2026-09-08", complete: true as const,
  };
  const catalogTable = {
    category: "investment-source-evidence", fund: null, period: null, tableLabel: "fund-security-catalog",
    rows: [["基金代碼", "基金名稱", "計價幣別"],
      ["YT01", "SANITIZED FUND", "TWD"], ["U001", "SANITIZED OUT FUND", "USD"], ["A001", "SANITIZED IN FUND", "USD"]],
  };
  await runYuantaFundStatements({} as never, fundHistoryInput,
    { yuanta_user_id: "synthetic-login", yuanta_account: "synthetic-account" },
    fundDependencies(async () => ({
      positions: [position], transactionHistory: history,
      occurrenceGroupCoverage: [{ scopeKey: deriveSourceConnectionIdentityKey("yuanta-fund-occurrence-scope", ["S", position.paperNo, position.trustNo]),
        startDate: history.startDate, endDate: history.endDate, contractVersion: "yuanta-fund/investment/canonical-v1" }],
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
  const eventCollector: FundSourceCollector = async () => {
    const conversionTable = {
      category: "historical-transactions", fund: "S:FS00000001:YT01", period: "2026/08/01-2026/09/08",
      tableLabel: "conversion-details", rows: [conversionHeaderLines, eventDateLines].map(row => row.map(lines => lines.join(" "))),
      cellLines: [conversionHeaderLines, eventDateLines],
    };
    return { positions: [position, secondPosition], transactionHistory: history,
      occurrenceGroupCoverage: [position, secondPosition].map(p => ({
        scopeKey: deriveSourceConnectionIdentityKey("yuanta-fund-occurrence-scope", ["S", p.paperNo, p.trustNo]),
        startDate: history.startDate, endDate: history.endDate, contractVersion: "yuanta-fund/investment/canonical-v1",
      })), tables: [overview, basisTable, catalogTable, conversionTable,
        { ...conversionTable, fund: "S:FS00000002:YT01" }], };
  };
  const rejectedSource = await eventCollector({} as never, fundHistoryInput, {
    sourceText: strictSourceText, signal: new AbortController().signal,
  });
  const rejectedAdmission = evaluateYuantaFundCanonicalAdmission(rejectedSource.tables, rejectedSource.positions);
  assert.equal(JSON.stringify(rejectedAdmission).includes("SANITIZED"), false);
  assert.throws(() => assertYuantaFundCanonicalAdmission(rejectedAdmission), (error: unknown) =>
    error instanceof Error && error.cause instanceof Error && /overlapping position queries/u.test(error.cause.message));
  await assert.rejects(runYuantaFundStatements({} as never, fundHistoryInput,
    { yuanta_user_id: "synthetic-login", yuanta_account: "synthetic-account" },
    fundDependencies(eventCollector, overlappingItems, new AbortController().signal)));
  assert.equal(overlappingItems.length, 0, "Overlapping queries cannot double-count a conversion");
  const aliasItems: PGliteWorkflowRunItem[] = [];
  await runYuantaFundStatements({} as never, fundHistoryInput,
    { yuanta_user_id: "synthetic-login", yuanta_account: "synthetic-account" },
    fundDependencies(async () => ({ positions: [position], ...fundHistoryProof,
      tables: [overview, basisTable, { ...catalogTable, rows: [["基金代碼", "基金名稱", "計價幣別"], ["YT01", "SANITIZED LONGER CATALOG FUND NAME", "TWD"]] }, buyTable],
    }), aliasItems, new AbortController().signal));
  assert.equal(committedInvestmentCapture(aliasItems).transactions[0]?.securityKey, "yuanta-fund:YT01");
  const eventCapture = committedInvestmentCapture(eventItems);
  assert.deepEqual(eventCapture.transactions.map(row => [row.securityKey, row.action]), [["yuanta-fund:U001", "sell"], ["yuanta-fund:A001", "buy"], ["yuanta-fund:A001", "dividend"], ["yuanta-fund:A001", "corporate_action_in"]]);
  const eventDb = await PGlite.create();
  const eventStore = new PGliteStore(eventDb);
  try {
    await applyPgliteBaseline(eventDb);
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
    const collector: FundSourceCollector = async () => ({
      positions: [position],
      tables: [overview, basisTable, table],
      ...fundHistoryProof,
    });
    await runYuantaFundStatements(
      {} as never,
      fundHistoryInput,
      { yuanta_user_id: "synthetic-login", yuanta_account: "synthetic-account" },
      fundDependencies(collector, items, new AbortController().signal),
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
  const accountSource: Awaited<ReturnType<FundSourceCollector>> = {
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
  await runYuantaFundStatements({} as never, fundHistoryInput,
    { yuanta_user_id: "synthetic-login", yuanta_account: "synthetic-account" },
    fundDependencies(async () => accountSource, accountItems, new AbortController().signal));
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
  await runYuantaFundStatements({} as never, fundHistoryInput,
    { yuanta_user_id: "synthetic-login", yuanta_account: "synthetic-account" },
    fundDependencies(async () => closedOnly, closedOnlyItems, new AbortController().signal));
  assert.equal(closedOnlyItems.length, 1);
  const closedOnlyCapture = committedInvestmentCapture(closedOnlyItems);
  assert.equal(closedOnlyCapture.transactions.length, 7);
  assert.equal(closedOnlyCapture.occurrenceGroupCoverage?.length, 3);
  assert.equal(closedOnlyCapture.holdings.length, 0);
  const repeatAccountItems: PGliteWorkflowRunItem[] = [];
  await runYuantaFundStatements({} as never, fundHistoryInput,
    { yuanta_user_id: "synthetic-login", yuanta_account: "synthetic-account" },
    { ...fundDependencies(async () => accountSource, repeatAccountItems, new AbortController().signal),
      now: () => "2026-09-10T12:00:00.000Z" });
  const missingMetadataItems: PGliteWorkflowRunItem[] = [];
  const missingMetadataSource = { ...accountSource, tables: accountSource.tables.filter(table => table.tableLabel !== "fund-security-catalog") };
  await runYuantaFundStatements({} as never, fundHistoryInput,
    { yuanta_user_id: "synthetic-login", yuanta_account: "synthetic-account" },
    { ...fundDependencies(async () => missingMetadataSource, missingMetadataItems, new AbortController().signal),
      now: () => "2026-09-11T12:00:00.000Z" });
  const missingMetadataCapture = committedInvestmentCapture(missingMetadataItems);
  assert.deepEqual(missingMetadataCapture.transactions.map(row => row.transactionKey), accountCapture.transactions.map(row => row.transactionKey),
    "Catalog removal or enrichment cannot change transaction identity");
  assert.ok(missingMetadataCapture.securities.every(security => security.identityEvidence.kind === "source-fund-name" && security.currency === ""));
  const normalizedNameItems: PGliteWorkflowRunItem[] = [];
  await runYuantaFundStatements({} as never, fundHistoryInput,
    { yuanta_user_id: "synthetic-login", yuanta_account: "synthetic-account" },
    { ...fundDependencies(async () => ({ ...missingMetadataSource, tables: missingMetadataSource.tables.map(table => table === accountTables[0]
      ? { ...table, rows: table.rows.map((row, index) => index === 0 ? row : row.map((cell, column) => column === 1 ? "SANITIZED ＣＬＯＳＥＤ ＦＵＮＤ" : cell)) } : table) }),
      normalizedNameItems, new AbortController().signal), now: () => "2026-09-12T12:00:00.000Z" });
  assert.deepEqual(committedInvestmentCapture(normalizedNameItems).transactions.map(row => row.transactionKey), accountCapture.transactions.map(row => row.transactionKey));
  const accountDb = await PGlite.create();
  const accountStore = new PGliteStore(accountDb);
  try {
    await applyPgliteBaseline(accountDb);
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
  await runYuantaFundStatements({} as never, fundHistoryInput,
    { yuanta_user_id: "synthetic-login", yuanta_account: "synthetic-account" },
    fundDependencies(async () => ({ ...missingMetadataSource, tables: missingMetadataSource.tables.map(table => table === accountTables[5]
      ? { ...table, rows: table.rows.map((row, index) => index === 0 ? row : row.map((cell, column) => column === 3 ? "美元 100" : cell)) } : table) }),
      mixedCurrencyItems, new AbortController().signal));
  const mixedCurrencyCapture = committedInvestmentCapture(mixedCurrencyItems);
  assert.deepEqual(new Set(mixedCurrencyCapture.transactions.filter(row => row.securityKey === "yuanta-fund:name:SANITIZED CLOSED FUND")
    .map(row => row.cashEffect.currency)), new Set(["TWD", "USD"]));
  assert.equal(mixedCurrencyCapture.securities.find(security => security.securityKey === "yuanta-fund:name:SANITIZED CLOSED FUND")?.currency, "");
  const mixedCurrencyDb = await PGlite.create();
  const mixedCurrencyStore = new PGliteStore(mixedCurrencyDb);
  try {
    await applyPgliteBaseline(mixedCurrencyDb);
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
    await assert.rejects(runYuantaFundStatements({} as never, fundHistoryInput,
      { yuanta_user_id: "synthetic-login", yuanta_account: "synthetic-account" },
      fundDependencies(async () => incomplete, items, new AbortController().signal)));
    assert.equal(items.length, 0);
  }
  const firstHistory = await tradeKeysFor(duplicateBuyTable);
  for (const inventory of [undefined, {
    sourceContract: "yuanta-fund/all-position-history-v1" as const,
    complete: true as const,
    positionKeys: [fundKey, "S:CLOSED-SYNTHETIC-LOT:YT02"],
  }]) {
    const incompleteItems: PGliteWorkflowRunItem[] = [];
    const dependencies: Parameters<typeof runYuantaFundStatements>[3] = {
      ...fundDependencies(validFundCollector, incompleteItems, new AbortController().signal),
      collectSourceTables: async () => ({
        positions: [position], tables: [overview, basisTable, buyTable],
        ...fundHistoryProof, historyPositionInventory: inventory,
      }),
    };
    await assert.rejects(runYuantaFundStatements({} as never, fundHistoryInput,
      { yuanta_user_id: "synthetic-login", yuanta_account: "synthetic-account" }, dependencies),
      /complete position universe including closed positions/u);
    assert.equal(incompleteItems.length, 0, "Current holdings cannot authorize complete account history");
  }
  assert.equal(firstHistory.capture.transactions.length, 2);
  assert.deepEqual(firstHistory.capture.transactions.map(row => row.securityKey), ["yuanta-fund:YT01", "yuanta-fund:YT01"]);
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
    "2026/08/27", "SANITIZED FUND", "T98765", "3000", "1", "10", "0", "0", "300",
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

  const explicitEmptyHistory = {
    category: "historical-transactions",
    fund: fundKey,
    period: "2026/08/01-2026/09/08",
    tableLabel: "transaction-query-summary",
    rows: [["查詢日期", "查詢基金"], ["查無資料", ""]],
  };
  const emptyHistoryItems: PGliteWorkflowRunItem[] = [];
  await runYuantaFundStatements(
    {} as never,
    fundHistoryInput,
    { yuanta_user_id: "synthetic-login", yuanta_account: "synthetic-account" },
    fundDependencies(async () => ({
      positions: [position],
      tables: [overview, basisTable, explicitEmptyHistory],
      ...fundHistoryProof,
    }), emptyHistoryItems, new AbortController().signal),
  );
  const emptyCapture = committedInvestmentCapture(emptyHistoryItems);
  assert.equal(emptyCapture.transactions.length, 0);
  assert.deepEqual(emptyCapture.occurrenceGroupCoverage, fundHistoryProof.occurrenceGroupCoverage);

  const partialItems: PGliteWorkflowRunItem[] = [];
  const partialCollector: FundSourceCollector = async () => ({
    positions: [position],
    tables: [overview, { ...buyTable, period: "2026/08/01-2026/09/08" }],
    ...fundHistoryProof,
  });
  await assert.rejects(
    runYuantaFundStatements(
      {} as never,
      fundHistoryInput,
      {
        yuanta_user_id: "synthetic-login",
        yuanta_account: "synthetic-account",
      },
      fundDependencies(
        partialCollector,
        partialItems,
        new AbortController().signal,
      ),
    ),
    /dated transaction row\(s\) were rejected/u,
  );
  assert.deepEqual(partialItems, []);

  const malformedItems: PGliteWorkflowRunItem[] = [];
  const malformedCollector: FundSourceCollector = async () => ({
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
  });
  await assert.rejects(
    runYuantaFundStatements(
      {} as never,
      fundInput,
      {
        yuanta_user_id: "synthetic-login",
        yuanta_account: "synthetic-account",
      },
      fundDependencies(
        malformedCollector,
        malformedItems,
        new AbortController().signal,
      ),
    ),
    /replacement-character/u,
  );
  assert.deepEqual(malformedItems, []);

  const cancelledItems: PGliteWorkflowRunItem[] = [];
  const cancellation = new AbortController();
  const abortAfterCollect: FundSourceCollector = async () => {
    cancellation.abort();
    return { positions: [position], tables: [overview, basisTable] };
  };
  await assert.rejects(
    runYuantaFundStatements(
      {} as never,
      fundInput,
      {
        yuanta_user_id: "synthetic-login",
        yuanta_account: "synthetic-account",
      },
      fundDependencies(abortAfterCollect, cancelledItems, cancellation.signal),
    ),
    /abort/u,
  );
  assert.deepEqual(cancelledItems, []);
  assert.deepEqual(await readdir(typedFundOutputDirectory), []);
} finally {
  process.chdir(typedFundOriginalCwd);
  await rm(typedFundOutputDirectory, { recursive: true, force: true });
}
