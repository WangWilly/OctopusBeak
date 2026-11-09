import assert from "node:assert/strict";
import test from "node:test";
import { PROBED_TRADE_TYPES, runColumnProbe } from "./probe.ts";
import { parseReportPage } from "../../src/workflows/yuanta-trade-statements.ts";
import { ProviderResponseCheckError } from "../../src/lib/automation/provider-response-check.ts";
import { MASKED_KEY, WITHHELD } from "../../src/lib/preview-sources/response-shape.ts";

const SENSITIVE = {
  brokerageAccount: ["980C", "-", "1234567"].join(""),
  accountTitleDigits: ["帳號", "98012345"].join(""),
  accountField: ["Acct", "98012345"].join("_"),
  gridAccountId: ["gridOversea_", "123456"].join(""),
  tradeDate: "2026/08/28",
  settleDate: "2026/09/02",
  symbol: "AAPLX",
  amount: "-12,345.67",
  holderName: "王小明",
  errorDetail: "AssetReport/OverseaTrade?acct=980C-1234567",
};

const RANGE = { startDate: "2026/08/11", endDate: "2026/11/09" };

function overseaHtml() {
  return `
    <script>
      var currTradeType = 'OverseaTrade';
      var accountData = [{ "AccountNo": "${SENSITIVE.brokerageAccount}", "Name": "${SENSITIVE.holderName}" }];
      $("#gridOversea").kendoGrid({
        columns: [
          { field: 'TradeDate_T2', title: '交易日期' },
          { field: 'StockID_T3', title: '股票代號' },
          { field: 'SettleDate_T4', title: '交割日' },
          { field: '${SENSITIVE.accountField}', title: '${SENSITIVE.accountTitleDigits}' },
          { field: 'AccountReceivableOrPayable_T17', title: '應收付' }
        ],
        data: [
          { "TradeDate_T2": "${SENSITIVE.tradeDate}", "StockID_T3": "${SENSITIVE.symbol}", "SettleDate_T4": "${SENSITIVE.settleDate}", "${SENSITIVE.accountField}": "${SENSITIVE.brokerageAccount}", "AccountReceivableOrPayable_T17": "${SENSITIVE.amount}", "MarketNo": 52, "DeliveryDate_T7": "${SENSITIVE.settleDate}" }
        ]
      });
      $("#${SENSITIVE.gridAccountId}").kendoGrid({
        columns: [{ field: 'Currency_T15', title: '交易幣別' }],
        data: []
      });
    </script>`;
}

function capturedFor(reportType) {
  const html = overseaHtml();
  return { page: parseReportPage(html, `https://global.yuanta.com.tw/NexusWebTrade/AssetReport/${reportType}`, reportType), html };
}

async function probe() {
  const calls = [];
  const report = await runColumnProbe(async (reportType, params) => {
    calls.push({ reportType, params });
    if (reportType === "OverseaTrade") return capturedFor(reportType);
    if (reportType === "FuturesTrade") throw new ProviderResponseCheckError("response-endpoint", SENSITIVE.errorDetail);
    if (reportType === "BondTrade") throw new Error(SENSITIVE.errorDetail);
    return { page: { grids: [] }, html: "<html></html>" };
  }, { dateRange: RANGE, rangeDays: 91, signal: new AbortController().signal });
  return { report, calls };
}

test("the probe reads every trade report the workflow reads, foreign securities first, with the workflow's parameters", async () => {
  const { calls } = await probe();
  assert.deepEqual(calls.map((call) => call.reportType), [...PROBED_TRADE_TYPES]);
  assert.deepEqual(calls.slice(0, 3).map((call) => call.reportType), ["OverseaTrade", "InternationalSecuritiesTrade", "StockTrade"]);
  assert.deepEqual(calls[0].params, { index: -1, queryDateType: "6", ...RANGE, subCategory: "Stock" });
  assert.deepEqual(calls[2].params, { index: -1, queryDateType: "6", ...RANGE });
});

test("columns come out in page order, with digit-run titles withheld and digit-run fields masked", async () => {
  const { report } = await probe();
  const oversea = report.reports[0];
  assert.equal(oversea.status, "ok");
  assert.deepEqual(oversea.grids[0], {
    gridId: "gridOversea",
    category: "Oversea",
    rowCount: 1,
    columns: [
      { field: "TradeDate_T2", title: "交易日期" },
      { field: "StockID_T3", title: "股票代號" },
      { field: "SettleDate_T4", title: "交割日" },
      { field: MASKED_KEY, title: WITHHELD },
      { field: "AccountReceivableOrPayable_T17", title: "應收付" },
    ],
  });
  assert.equal(oversea.grids[1].gridId, "{segment}");
  assert.equal(oversea.grids[1].category, "{segment}");
  assert.deepEqual(oversea.dataKeysOutsideColumns, ["AccountNo", "DeliveryDate_T7", "MarketNo", "Name"]);
});

test("the candidate detector finds 交割日 columns and settlement-date data keys", async () => {
  const { report } = await probe();
  assert.deepEqual(report.settlementDateCandidates, [
    { reportType: "OverseaTrade", gridId: "gridOversea", source: "column", field: "SettleDate_T4", title: "交割日" },
    { reportType: "OverseaTrade", gridId: null, source: "data-key", field: "DeliveryDate_T7", title: null },
  ]);
});

test("a failed report names a fixed reason, the next report still runs, and the report is incomplete", async () => {
  const { report } = await probe();
  const byType = Object.fromEntries(report.reports.map((entry) => [entry.reportType, entry]));
  assert.deepEqual(byType.FuturesTrade, { reportType: "FuturesTrade", status: "failed", reason: "response-endpoint" });
  assert.deepEqual(byType.BondTrade, { reportType: "BondTrade", status: "failed", reason: "Error" });
  assert.equal(byType.DerivativeTrade.status, "ok");
  assert.equal(report.complete, false);
});

test("no row value, account, name, date or error detail appears anywhere in the report", async () => {
  const { report } = await probe();
  const json = JSON.stringify(report);
  for (const [name, value] of Object.entries(SENSITIVE)) {
    assert.equal(json.includes(value), false, `${name} leaked into the report`);
  }
  assert.doesNotMatch(json, /\d{4,}/u);
});
