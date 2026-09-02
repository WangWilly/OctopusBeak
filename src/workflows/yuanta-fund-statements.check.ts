import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  evaluateYuantaFundCanonicalAdmission,
  isYuantaFundPositionAbsentText,
  parseYuantaFundValuationBasis,
} =
  await import("./yuanta-fund-statements.ts");

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
assert.match(source, /evaluateYuantaFundCanonicalAdmission/);
assert.match(source, /reference-nav-and-fx-basis-date/);
assert.match(source, /investment-source-evidence/);
assert.match(source, /yuanta-fund-canonical-admitted/);
assert.match(source, /yuanta-fund-canonical-not-admitted/);
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
assert.deepEqual(parseYuantaFundValuationBasis(basisTable), {
  fundKey,
  navEffectiveOn: "2026-09-01",
  fxEffectiveOn: "2026-09-02",
});
assert.deepEqual(
  evaluateYuantaFundCanonicalAdmission([overview, basisTable], [position]),
  {
    status: "admitted",
    contractVersion: "yuanta-fund/investment/canonical-v1",
    holdingCount: 1,
  },
);
assert.equal(
  evaluateYuantaFundCanonicalAdmission([overview], [position]).reason,
  "source-effective-time-evidence-incomplete",
);
