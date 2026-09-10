import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { CanonicalInvestmentAdmissionError } from "../ledger/canonical/investment-financial.ts";
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

const source = await readFile(
  new URL("./yuanta-fund-statements.ts", import.meta.url),
  "utf8",
);

assert.match(source, /yuanta-fund-positions-found/);
assert.match(source, /yuanta-fund-history-start/);
assert.match(source, /yuanta-fund-positions-found[\s\S]*durationMs/);
assert.match(source, /yuanta-fund-history-start[\s\S]*startedAt/);
assert.match(source, /yuanta-fund-history-complete[\s\S]*durationMs/);
assert.match(source, /const fundProgress = \(\) =>/);
assert.match(source, /selectedFunds = fundPositions/);
assert.doesNotMatch(source, /selectedFunds = fundPositions\.filter/);
assert.match(source, /runFundMenuAction\(/);
assert.match(source, /startUrl: YUANTA_ENTRY_URL/);
assert.match(source, /evaluateYuantaFundCanonicalAdmission/);
assert.match(source, /reference-nav-and-fx-basis-date/);
assert.match(source, /investment-source-evidence/);
assert.match(source, /yuanta-fund-canonical-admitted/);
assert.match(source, /yuanta-fund-canonical-not-admitted/);
assert.match(source, /yuanta-fund-canonical-partial/);
assert.match(
  source,
  /const files = await writeOutputTableFiles\(nextTimestamp, parsedTables\);[\s\S]*assertYuantaFundCanonicalAdmission\(canonicalAdmission\);/,
);
assert.match(
  source,
  /automation-progress: \$\{[\s\S]*75 \+[\s\S]*Math\.min\(\s*24,/,
);

assert.equal(isYuantaFundPositionAbsentText("目前無持有基金"), true);
assert.equal(isYuantaFundPositionAbsentText("未持有基金部位"), true);
assert.equal(
  isYuantaFundPositionAbsentText("投資日期 基金名稱 交易編號"),
  false,
);
// Live investment-overview rows report the source currency as 台幣. It must
// reach the canonical adapter as ISO TWD rather than as a display label.
assert.equal(canonicalYuantaFundCurrency("台幣"), "TWD");

const position = {
  txnType: "S",
  paperNo: "FUND001",
  trustNo: "T12345",
  label: "SANITIZED FUND",
};
const fundKey = "S:FUND001:T12345";
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
      "SANITIZED FUND T12345",
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
      "T12345",
      "10000",
      "1",
      "10",
      "0",
      "0",
      "1000",
    ],
  ],
};
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
  evaluateYuantaFundCanonicalAdmission([overview, colspanBasisTable], [position]),
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
    error.message.includes("1 dated transaction row(s) were committed") &&
    error.message.includes("current holding observations were not committed"),
);
const wrappedPartialRun = await runSelectedStatements(["fund"], [
  {
    typeId: "fund",
    run: async () => {
      assertYuantaFundCanonicalAdmission(partialAdmission);
      return { count: 1 };
    },
  },
]);
assert.deepEqual(wrappedPartialRun.results, [
  {
    typeId: "fund",
    status: "failed",
    error:
      "Yuanta fund canonical admission partial: source-effective-time-evidence-incomplete. 1 dated transaction row(s) were committed; current holding observations were not committed because the source did not report a holding effective date.",
  },
]);
assert.equal(Object.hasOwn(wrappedPartialRun.outputs, "fund"), false);
const wrappedIncompleteRun = await runSelectedStatements(["fund"], [
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
]);
assert.deepEqual(wrappedIncompleteRun.results, [
  {
    typeId: "fund",
    status: "failed",
    error:
      "Yuanta fund canonical admission failed: source-effective-time-evidence-incomplete. Raw statement files were saved; canonical investment data was not committed.",
  },
]);
assert.equal(Object.hasOwn(wrappedIncompleteRun.outputs, "fund"), false);

const wrappedAdmittedRun = await runSelectedStatements(["fund"], [
  {
    typeId: "fund",
    run: async () => {
      assertYuantaFundCanonicalAdmission(
        evaluateYuantaFundCanonicalAdmission([overview, basisTable], [position]),
      );
      return { count: 1 };
    },
  },
]);
assert.deepEqual(wrappedAdmittedRun.results, [
  { typeId: "fund", status: "success" },
]);
assert.deepEqual(wrappedAdmittedRun.outputs.fund, { count: 1 });
