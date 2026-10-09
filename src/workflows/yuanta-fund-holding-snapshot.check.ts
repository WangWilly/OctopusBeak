import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteBaseline } from "../ledger/pglite/baseline.ts";
import { readPGliteDailyHistory } from "../ledger/pglite/daily-history.ts";
import { commitPGliteCanonicalInvestmentCapture } from "../ledger/pglite/investment.ts";
import { createPGliteCanonicalOverviewQuery } from "../ledger/pglite/overview.ts";
import { PGliteStore } from "../ledger/pglite/transaction.ts";
import { PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND } from "../ledger/pglite/workflow-client.ts";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import type { InvestmentCaptureInput } from "../ledger/canonical/investment-financial-admission.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import {
  yuantaFundAccountHistoryKey,
  yuantaFundAccountHistoryQueries,
  yuantaFundAccountHistoryScope,
  yuantaFundAccountHistoryTableLabels,
  yuantaFundHistoryInvestmentTypes,
} from "./yuanta-fund-account-history.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./browser-interaction.js") return nextResolve("./browser-interaction.ts", context);
    if (specifier === "./yuanta-statements.js") return nextResolve("./yuanta-statements.ts", context);
    return nextResolve(specifier, context);
  },
});

const { runYuantaFundStatements, yuantaFundStatementsInputSchema } = await import("./yuanta-fund-statements.ts");

type SourceTables = Awaited<ReturnType<NonNullable<Parameters<typeof runYuantaFundStatements>[3]["collectSourceTables"]>>>;

const position = { txnType: "S", paperNo: "FS00000001", trustNo: "YT01", label: "SANITIZED FUND" };

const overview = {
  category: "investment-overview", fund: null, period: null, tableLabel: "investment-detail",
  rows: [
    ["投資日期", "幣別", "基金名稱 交易編號", "效率投資", "投資金額 不含息參考市值", "投資淨值 參考淨值",
      "單位數 參考匯率", "(不含息) 參考損益 參考報酬率", "(含息) 參考損益 參考報酬率", "累積配息 在途交易", "操作"],
    ["2025/01/01", "新臺幣", "SANITIZED FUND FS00000001", "", "10000 10500", "10 10.5", "1000 1", "500 5%", "500 5%", "0 0", ""],
  ],
};

const basis = {
  category: "investment-source-evidence", fund: "S:FS00000001:YT01", period: null, tableLabel: "reference-nav",
  rows: [
    ["參考項目", "參考基準日", "參考淨值", "最新淨值查詢"],
    ["贖回", "2026/09/01", "10.5", ""],
    ["申購", "2026/09/01", "10.6", ""],
    ["匯率", "2026/09/02", "1", ""],
  ],
};

const absence = {
  category: "investment-source-evidence", fund: null, period: null, tableLabel: "current-position-absence", rows: [["無基金部位"]],
};

const redemptionHeader = [
  "贖回日期 分配日期", "基金名稱 交易編號", "贖回投資金額 單位數", "贖回價格 贖回匯率",
  "信託管理費 短線費用", "入帳帳號 入帳淨額", "贖回參考損益 參考贖回報酬率", "預計入帳",
];
const redemptionFooter = ["合計", "贖回投資金額", "台幣 10500", "贖回參考損益", "台幣 500", "贖回參考報酬率", "5%", ""];

/** The held fund redeemed in full on redeemedOn, as the account-wide single-fund sell report shows it. */
function redemption(redeemedOn: string) {
  const data = [[redeemedOn.replaceAll("-", "/"), redeemedOn.replaceAll("-", "/")], ["SANITIZED FUND", "FS00000001"],
    ["台幣 10500", "1000"], ["10.5", "1"], ["台幣 0", "台幣 0"],
    ["SANITIZED ACCOUNT DESCRIPTION", "0001", "台幣 10500"], ["台幣 500", "5%"], []];
  return {
    tableLabel: "redemption-account-details",
    rows: [redemptionHeader, data.map(lines => lines.join(" ")), redemptionFooter],
    cellLines: [redemptionHeader.map(value => value.split(" ")), data, redemptionFooter.map(value => [value])],
    cellColspans: Array.from({ length: 3 }, () => Array(8).fill(1) as number[]),
  };
}

/** A complete account-wide history whose reports are explicitly empty, apart from an optional full redemption. */
function withHistory(
  source: Pick<SourceTables, "positions" | "tables">,
  startDate: string,
  endDate: string,
  redeemedOn?: string,
): SourceTables {
  const period = `${startDate.replaceAll("-", "/")}-${endDate.replaceAll("-", "/")}`;
  return {
    ...source,
    tables: [...source.tables, ...yuantaFundAccountHistoryQueries.map(query => ({
      category: "historical-transactions", fund: yuantaFundAccountHistoryKey(query.investmentType), historyQuery: query, period,
      tableLabel: query.detail === "deduct" && query.investmentType === "type3"
        ? "variable-deduction-details" : yuantaFundAccountHistoryTableLabels[query.detail],
      rows: [["查無資料"]],
      ...(redeemedOn && query.investmentType === "single" && query.detail === "sell" ? redemption(redeemedOn) : {}),
    }))],
    transactionHistory: { startDate, endDate, complete: true },
    accountHistoryQueryCoverage: yuantaFundAccountHistoryQueries,
    occurrenceGroupCoverage: yuantaFundHistoryInvestmentTypes.map(type => ({
      scopeKey: yuantaFundAccountHistoryScope(type), startDate, endDate, contractVersion: "yuanta-fund/investment/canonical-v1",
    })),
  };
}

async function collect(source: SourceTables, endDate: string, now: string): Promise<InvestmentCaptureInput> {
  const items: PGliteWorkflowRunItem[] = [];
  await runYuantaFundStatements(
    {} as never,
    yuantaFundStatementsInputSchema.parse({
      includePortfolioSummary: false, includeInvestmentDetails: true, includeHistoricalTransactions: true,
      customDateRange: { startDate: "2026/08/01", endDate: endDate.replaceAll("-", "/") },
    }),
    { yuanta_user_id: "synthetic-login", yuanta_account: "synthetic-account" },
    {
      collectOnly: true, deferredCommitItems: items, sourceText: strictSourceText,
      signal: new AbortController().signal, now: () => now, collectSourceTables: async () => source,
    },
  );
  assert.equal(items.length, 1);
  const command = items[0]!.command;
  if (command.kind !== PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND) throw new Error("Expected a canonical investment commit command.");
  return command.request.capture;
}

const held = (endDate: string, now: string) =>
  collect(withHistory({ positions: [position], tables: [overview, basis] }, "2026-08-01", endDate), endDate, now);
const soldOut = (endDate: string, now: string, redeemedOn?: string) =>
  collect(withHistory({ positions: [], tables: [absence] }, "2026-08-01", endDate, redeemedOn), endDate, now);

test("a Yuanta Fund holding capture declares the overview as the account's complete inventory", async () => {
  const capture = await held("2026-09-09", "2026-09-09T12:00:00.000Z");
  assert.deepEqual(capture.scope.holdingSnapshot, {
    sourceField: "reference-nav-and-fx-basis-date", value: "2026-09-02", contractVersion: "yuanta-fund/investment/canonical-v1",
  });
});

test("an explicit absence declares an empty snapshot only when the history reaches the collection date", async () => {
  const current = await soldOut("2026-09-10", "2026-09-10T02:00:00.000Z");
  assert.deepEqual(current.scope.holdingSnapshot, {
    sourceField: "position-absence-and-history-end-date", value: "2026-09-10", contractVersion: "yuanta-fund/investment/canonical-v1",
  });
  const redeemed = await soldOut("2026-09-10", "2026-09-10T02:00:00.000Z", "2026-09-05");
  assert.deepEqual(redeemed.transactions.map(({ action, effectiveOn }) => ({ action, effectiveOn })), [
    { action: "sell", effectiveOn: "2026-09-05" },
  ]);
  assert.deepEqual(redeemed.scope.holdingSnapshot, {
    sourceField: "position-absence-and-latest-history-transaction-date", value: "2026-09-05",
    contractVersion: "yuanta-fund/investment/canonical-v1",
  }, "nothing moves after the last reported sale, so the account is empty from that date");
  const past = await soldOut("2026-09-05", "2026-09-10T02:00:00.000Z");
  assert.equal(past.scope.holdingSnapshot, undefined, "a sale after a past query end must not be dated at that end");
  const pastRedeemed = await soldOut("2026-09-07", "2026-09-10T02:00:00.000Z", "2026-09-05");
  assert.equal(pastRedeemed.scope.holdingSnapshot, undefined, "a reported sale does not prove nothing moved after the query end");
});

for (const { name, redeemedOn, clearedOn } of [
  { name: "with no history events", redeemedOn: undefined, clearedOn: "2026-09-10" },
  { name: "after a reported redemption", redeemedOn: "2026-09-05", clearedOn: "2026-09-05" },
]) test(`a later empty Yuanta Fund collection ${name} clears the held fund from the overview and daily history`, async () => {
  const database = await PGlite.create();
  try {
    await applyPgliteBaseline(database);
    const store = new PGliteStore(database);
    const query = createPGliteCanonicalOverviewQuery(store);

    await commitPGliteCanonicalInvestmentCapture(store, { capture: await held("2026-09-09", "2026-09-09T12:00:00.000Z") });
    assert.deepEqual((await query.current()).projection.positions.map(({ symbol, units }) => ({ symbol, units })), [
      { symbol: "yuanta-fund:name:SANITIZED FUND", units: { coefficient: "1000", scale: 0 } },
    ]);

    await commitPGliteCanonicalInvestmentCapture(store, { capture: await soldOut("2026-09-10", "2026-09-10T02:00:00.000Z", redeemedOn) });
    const { projection } = await query.current();
    assert.deepEqual(projection.positions, [], "the sold fund is no longer current");

    const history = await readPGliteDailyHistory(store, projection.knowledgePoint, projection.accounts);
    const day = (date: string) => history.find(row => row.date === date);
    assert.equal(day("2026-09-02")?.positionCount, 1, "the fund is held from its NAV date");
    assert.deepEqual(history.at(-1), { ...history.at(-1)!, date: clearedOn, positionCount: 0, assets: [] });
  } finally {
    await database.close();
  }
});
