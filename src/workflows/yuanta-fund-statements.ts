import type { Frame, Locator, Page } from "playwright";
import { z } from "zod";
import {
  PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND,
  PGLITE_CANONICAL_INVESTMENT_RELATIONS_RESOLVE_COMMAND,
} from "../ledger/pglite/workflow-client.ts";
import type { SourceTextPort } from "../lib/automation/source-text.ts";
import {
  admitCanonicalInvestmentCapture,
  CanonicalInvestmentAdmissionError,
  type InvestmentValidatedCapture,
} from "../ledger/canonical/investment-financial-admission.ts";
import {
  assignYuantaInvestmentTransactionOccurrences,
  buildYuantaInvestmentCapture,
  type YuantaCanonicalInvestmentRow,
} from "../ledger/canonical/yuanta-investment-adapters.ts";
import { deriveSourceConnectionIdentityKey } from "../ledger/canonical/source-connection-identity.ts";
import type { CanonicalOccurrenceGroupCoverage } from "../ledger/canonical/occurrence-groups.ts";
import type { BrowserScope } from "./frame-scope.ts";
import { yuantaEbankSite, type YuantaEbankSite, type YuantaRoute } from "./yuanta-ebank-site.ts";
import {
  StatementComponentAbsentError,
  type ProductCollectionHandle,
  type ProductCollectionSummary,
  type ProductStageRequest,
} from "../lib/automation/product-collection.ts";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";
import type { CollectionPeriod } from "../lib/automation/collection-period.ts";
import { aggregateYuantaFundHoldingLots } from "./yuanta-fund-holdings.ts";
import { yuantaFundAdditionalEventRows } from "./yuanta-fund-events.ts";
import { resolveYuantaFundIdentity } from "./yuanta-fund-identity.ts";
import { assertYuantaFundHistoryQueryRequest } from "./yuanta-fund-history-query.ts";
import { yuantaFundAccountHistoryQueries, yuantaFundAccountHistoryKey, yuantaFundAccountHistoryType, yuantaFundAccountHistoryScope, yuantaFundAccountHistoryQueryFields, yuantaFundAccountHistoryTableLabels, yuantaFundHistoryInvestmentTypes, type YuantaFundAccountHistoryQuery } from "./yuanta-fund-account-history.ts";
import { canonicalYuantaFundCurrency, isYuantaFundSourceCurrencyLabel, yuantaFundSourceAmountCurrency } from "./yuanta-fund-currency.ts";

const YUANTA_FUND_INVESTMENT_CONTRACT_VERSION =
  "yuanta-fund/investment/canonical-v1" as const;
const FUND_TABLE_SELECTOR =
  "table.rwdTable, table.normalTable, table.formTable";

type FundPosition = {
  // Bank form parameters: route, transaction number, native fund code.
  txnType: string;
  paperNo: string;
  trustNo: string;
  label: string;
};

type ParsedTable = {
  category: string;
  fund: string | null;
  period: string | null;
  tableLabel: string;
  rows: string[][];
  cellColspans?: number[][];
  cellLines?: string[][][];
  historyQuery?: YuantaFundAccountHistoryQuery;
};

type ParsedHtmlTableRows = {
  rows: string[][];
  cellColspans: number[][];
  cellLines: string[][][];
};

type NormalizedRow = {
  category: string;
  fund: string | null;
  period: string | null;
  values: string[];
};

type TableOutputConfig = {
  rawColumns: string[];
  headers: string[];
  normalize: (columns: Record<string, string>) => string[];
};

export const yuantaFundStatementsInputSchema = z.object({
  fundFilters: z.array(z.string()).default([]),
  includePortfolioSummary: z.boolean().default(true),
  includeInvestmentDetails: z.boolean().default(false),
  includeHistoricalTransactions: z.boolean().default(true),
  includeOffHourOrders: z.boolean().default(false),
});
const inputSchema = yuantaFundStatementsInputSchema;

type WorkflowInput = z.infer<typeof inputSchema>;

export type YuantaFundCollectionInput = WorkflowInput & Readonly<{
  yuantaUserId: string;
  yuantaAccount: string;
}>;

const cashDividendHeaders = [
  "入帳日期",
  "基金名稱",
  "交易編號",
  "基準日期",
  "計價幣別",
  "基準單位數",
  "分配金額",
  "匯率",
  "分配率",
  "入帳帳號",
  "已扣稅款",
  "補充保費",
  "入帳金額",
];

function normalizeCashDividendColumns(columns: Record<string, string>): string[] {
  const [fundName, transactionNo] = splitFundNameAndTransactionNo(
    columns["基金名稱 交易編號"] ?? "",
  );
  const [recordDate, currency] = splitWhitespacePair(
    columns["基準日期 計價幣別"] ?? "",
  );
  const [baseUnits, dividendAmount] = splitWhitespacePair(
    columns["基準單位數 分配金額"] ?? "",
  );
  const [exchangeRate, dividendRate] = splitWhitespacePair(
    columns["匯率 分配率"] ?? "",
  );
  const [withheldTax, supplementaryPremium] = splitWhitespacePair(
    columns["已扣稅款 補充保費"] ?? "",
  );
  const [creditedAmount, depositAccount] = "入帳金額 入帳帳號" in columns
    ? splitWhitespacePair(columns["入帳金額 入帳帳號"] ?? "")
    : ["", columns["入帳帳號"] ?? ""];

  return [
    columns["入帳日期"] ?? "",
    fundName,
    transactionNo,
    recordDate,
    currency,
    baseUnits,
    dividendAmount,
    exchangeRate,
    dividendRate,
    depositAccount,
    withheldTax,
    supplementaryPremium,
    creditedAmount,
  ];
}

const tableOutputConfigsByLabel: Record<string, TableOutputConfig> = {
  "portfolio-summary": simpleTableConfig([
    "基金名稱",
    "基金類型",
    "投資幣別",
    "投資金額",
    "不含息參考市值",
    "不含息參考損益",
    "不含息參考報酬率",
    "含息參考損益",
    "含息參考報酬率",
    "狀態",
  ]),
  "currency-total": simpleTableConfig([
    "幣別總計",
    "投資金額",
    "不含息參考市值",
    "不含息參考損益",
    "不含息參考報酬率",
    "含息參考損益",
    "含息參考報酬率",
  ]),
  "investment-detail": {
    rawColumns: [
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
    headers: [
      "投資日期",
      "投資幣別",
      "基金名稱",
      "交易編號",
      "效率投資",
      "投資金額",
      "不含息參考市值",
      "投資淨值",
      "參考淨值",
      "單位數",
      "參考匯率",
      "不含息參考損益",
      "不含息參考報酬率",
      "含息參考損益",
      "含息參考報酬率",
      "累積配息",
      "在途交易",
    ],
    normalize: (columns) => {
      const [fundName, transactionNo] = splitFundNameAndTransactionNo(
        columns["基金名稱 交易編號"] ?? "",
      );
      const [investedAmount, marketValueExDividend] = splitWhitespacePair(
        columns["投資金額 不含息參考市值"] ?? "",
      );
      const [purchaseNav, referenceNav] = splitWhitespacePair(
        columns["投資淨值 參考淨值"] ?? "",
      );
      const [units, referenceExchangeRate] = splitWhitespacePair(
        columns["單位數 參考匯率"] ?? "",
      );
      const [gainLossExDividend, returnRateExDividend] = splitWhitespacePair(
        columns["(不含息) 參考損益 參考報酬率"] ?? "",
      );
      const [gainLossWithDividend, returnRateWithDividend] =
        splitWhitespacePair(columns["(含息) 參考損益 參考報酬率"] ?? "");
      const [accumulatedDividend, pendingTransaction] = splitWhitespacePair(
        columns["累積配息 在途交易"] ?? "",
      );

      return [
        columns["投資日期"] ?? "",
        columns["幣別"] ?? "",
        fundName,
        transactionNo,
        columns["效率投資"] ?? "",
        investedAmount,
        marketValueExDividend,
        purchaseNav,
        referenceNav,
        units,
        referenceExchangeRate,
        gainLossExDividend,
        returnRateExDividend,
        gainLossWithDividend,
        returnRateWithDividend,
        accumulatedDividend,
        pendingTransaction,
      ];
    },
  },
  "reference-nav": simpleTableConfig([
    "參考項目",
    "參考基準日",
    "參考淨值",
    "最新淨值查詢",
  ]),
  "buy-details": simpleTableConfig([
    "投資日期",
    "基金名稱",
    "交易編號",
    "投資金額",
    "申購匯率",
    "申購淨值",
    "申購手續費",
    "點數折抵",
    "申購單位數",
  ]),
  "redemption-details": {
    rawColumns: [
      "贖回日期 分配日期",
      "基金名稱 交易編號",
      "贖回投資金額 單位數",
      "贖回價格 贖回匯率",
      "信託管理費 短線費用",
      "遞延手續費",
      "入帳帳號 入帳淨額",
      "贖回參考損益 參考贖回報酬率",
      "備註",
    ],
    headers: [
      "贖回日期",
      "分配日期",
      "基金名稱",
      "交易編號",
      "贖回投資金額",
      "贖回單位數",
      "贖回價格",
      "贖回匯率",
      "信託管理費",
      "短線費用",
      "遞延手續費",
      "入帳帳號",
      "入帳淨額",
      "贖回參考損益",
      "參考贖回報酬率",
      "備註",
    ],
    normalize: (columns) => {
      const [redemptionDate, allocationDate] = splitWhitespacePair(
        columns["贖回日期 分配日期"] ?? "",
      );
      const [fundName, transactionNo] = splitFundNameAndTransactionNo(
        columns["基金名稱 交易編號"] ?? "",
      );
      const [redemptionAmount, units] = splitWhitespacePair(
        columns["贖回投資金額 單位數"] ?? "",
      );
      const [redemptionPrice, redemptionRate] = splitWhitespacePair(
        columns["贖回價格 贖回匯率"] ?? "",
      );
      const [trustFee, shortTermFee] = splitWhitespacePair(
        columns["信託管理費 短線費用"] ?? "",
      );
      const [depositAccount, netDepositAmount] = splitWhitespacePair(
        columns["入帳帳號 入帳淨額"] ?? "",
      );
      const [referenceGainLoss, referenceReturnRate] = splitWhitespacePair(
        columns["贖回參考損益 參考贖回報酬率"] ?? "",
      );

      return [
        redemptionDate,
        allocationDate,
        fundName,
        transactionNo,
        redemptionAmount,
        units,
        redemptionPrice,
        redemptionRate,
        trustFee,
        shortTermFee,
        columns["遞延手續費"] ?? "",
        depositAccount,
        netDepositAmount,
        referenceGainLoss,
        referenceReturnRate,
        columns["備註"] ?? "",
      ];
    },
  },
  "conversion-details": {
    rawColumns: [
      "轉出日期 轉入日期",
      "交易編號",
      "轉出基金 轉入基金",
      "轉換投資金額",
      "轉出單位數 轉入單位數",
      "轉出基金淨值 轉入基金淨值",
      "轉換匯率 短線費用",
      "銀行轉換手續費 基金公司轉換手續費",
    ],
    headers: [
      "轉出日期",
      "轉入日期",
      "交易編號",
      "轉出基金",
      "轉入基金",
      "轉換投資金額",
      "轉出單位數",
      "轉入單位數",
      "轉出基金淨值",
      "轉入基金淨值",
      "轉換匯率",
      "短線費用",
      "銀行轉換手續費",
      "基金公司轉換手續費",
    ],
    normalize: (columns) => {
      const [transferOutDate, transferInDate] = splitWhitespacePair(
        columns["轉出日期 轉入日期"] ?? "",
      );
      const [transferOutFund, transferInFund] = splitWhitespacePair(
        columns["轉出基金 轉入基金"] ?? "",
      );
      const [transferOutUnits, transferInUnits] = splitWhitespacePair(
        columns["轉出單位數 轉入單位數"] ?? "",
      );
      const [transferOutNav, transferInNav] = splitWhitespacePair(
        columns["轉出基金淨值 轉入基金淨值"] ?? "",
      );
      const [conversionRate, shortTermFee] = splitWhitespacePair(
        columns["轉換匯率 短線費用"] ?? "",
      );
      const [bankFee, fundCompanyFee] = splitWhitespacePair(
        columns["銀行轉換手續費 基金公司轉換手續費"] ?? "",
      );

      return [
        transferOutDate,
        transferInDate,
        columns["交易編號"] ?? "",
        transferOutFund,
        transferInFund,
        columns["轉換投資金額"] ?? "",
        transferOutUnits,
        transferInUnits,
        transferOutNav,
        transferInNav,
        conversionRate,
        shortTermFee,
        bankFee,
        fundCompanyFee,
      ];
    },
  },
  "cash-dividend-details": {
    rawColumns: [
      "入帳日期",
      "基金名稱 交易編號",
      "基準日期 計價幣別",
      "基準單位數 分配金額",
      "匯率 分配率",
      "入帳帳號",
    ],
    headers: cashDividendHeaders,
    normalize: normalizeCashDividendColumns,
  },
  "unit-dividend-details": simpleTableConfig([
    "分配日期",
    "基金名稱",
    "交易編號",
    "基準日期",
    "基準單位數",
    "分配率",
    "分配單位數",
  ]),
  "offhour-buy-orders": simpleTableConfig([
    "申購基金",
    "投資類型",
    "申購日期",
    "投資生效日期",
    "投資幣別",
    "客戶風險等級",
    "扣款帳號/信用卡卡號",
    "申購手續費",
    "每月扣款日期",
    "每次投資金額",
    "扣款起始日",
    "扣款到期日",
    "精選組合",
    "介紹人編號",
    "公開說明書交付方式",
  ]),
  "offhour-conversion-orders": simpleTableConfig([
    "轉出基金",
    "轉換方式",
    "轉換幣別",
    "申請日期",
    "轉換生效日期",
    "轉入基金",
    "轉換金額",
    "轉換單位數",
    "風險等級",
    "扣繳手續費帳號",
    "轉換手續費",
    "客戶風險等級",
    "介紹人編號",
    "公開說明書交付方式",
  ]),
  "offhour-redemption-orders": simpleTableConfig([
    "贖回基金",
    "贖回方式",
    "申請日期",
    "贖回生效日期",
    "贖回轉入帳號",
    "贖回投資金額",
    "贖回單位數",
  ]),
  "offhour-redemption-rebuy-orders": simpleTableConfig([
    "贖回基金",
    "贖回方式",
    "申請日期",
    "贖回生效日期",
    "贖回投資金額",
    "贖回單位數",
    "贖回轉入帳號",
    "再申購基金",
    "預估再申購手續費率",
    "保留金額",
  ]),
  "offhour-change-orders": simpleTableConfig([
    "異動基金",
    "申請日期",
    "生效日期",
    "異動種類",
    "變更後設定值",
  ]),
};

const cashDividendTaxLayout: TableOutputConfig = {
  rawColumns: [
    "入帳日期",
    "基金名稱 交易編號",
    "基準日期 計價幣別",
    "基準單位數 分配金額",
    "匯率 分配率",
    "已扣稅款 補充保費",
    "入帳金額 入帳帳號",
  ],
  headers: cashDividendHeaders,
  normalize: normalizeCashDividendColumns,
};
const tableOutputLayoutsByLabel: Record<string, readonly TableOutputConfig[]> = {
  "cash-dividend-details": [
    tableOutputConfigsByLabel["cash-dividend-details"],
    cashDividendTaxLayout,
  ],
};
tableOutputConfigsByLabel["redemption-account-details"] = {
  rawColumns: ["贖回日期 分配日期", "基金名稱 交易編號", "贖回投資金額 單位數", "贖回價格 贖回匯率",
    "信託管理費 短線費用", "入帳帳號 入帳淨額", "贖回參考損益 參考贖回報酬率", "預計入帳"],
  headers: tableOutputConfigsByLabel["redemption-details"].headers,
  normalize: columns => tableOutputConfigsByLabel["redemption-details"].normalize({
    ...columns, "遞延手續費": "", "備註": columns["預計入帳"] ?? "",
  }),
};
for (const variable of [false, true]) {
  tableOutputConfigsByLabel[variable ? "variable-deduction-details" : "deduction-details"] = {
    rawColumns: variable
      ? ["基金名稱 交易編號", "扣款日期", "扣款帳號/信用卡卡號", "投資金額", "當次扣款比重", "手續費", "申購單位數", "申購匯率", "申購淨值"]
      : ["扣款日期", "基金名稱 交易編號", "扣款帳號/信用卡卡號", "投資金額", "手續費", "申購單位數", "申購匯率", "申購淨值"],
    headers: [...tableOutputConfigsByLabel["buy-details"].headers, "扣款帳號/信用卡卡號", "當次扣款比重"],
    normalize: columns => {
      const [name, transactionNo] = splitFundNameAndTransactionNo(columns["基金名稱 交易編號"] ?? "");
      return [columns["扣款日期"] ?? "", name, transactionNo, columns["投資金額"] ?? "",
        columns["申購匯率"] ?? "", columns["申購淨值"] ?? "", columns["手續費"] ?? "", "",
        columns["申購單位數"] ?? "", columns["扣款帳號/信用卡卡號"] ?? "", columns["當次扣款比重"] ?? ""];
    },
  };
}
const fundPurchaseTableLabels = ["buy-details", "deduction-details", "variable-deduction-details"];
const fundRedemptionTableLabels = ["redemption-details", "redemption-account-details"];
const fundFinancialHistoryTableLabels = [...fundPurchaseTableLabels, ...fundRedemptionTableLabels,
  "conversion-details", "cash-dividend-details", "unit-dividend-details"];

function cleanText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function simpleTableConfig(headers: string[]): TableOutputConfig {
  return {
    rawColumns: headers,
    headers,
    normalize: (columns) => headers.map((header) => columns[header] ?? ""),
  };
}

export function splitWhitespacePair(value: string): [string, string] {
  const lines = value.split(/\r?\n/u).map(cleanText).filter(Boolean);
  if (lines.length > 2) {
    throw new Error("YuanTa paired cell has more than two source lines.");
  }
  if (lines.length === 2) return [lines[0], lines[1]];
  const text = cleanText(value);
  const parts = text.split(" ").filter(Boolean);
  if (parts.length <= 1) return [text, ""];
  return [parts[0] ?? "", parts.slice(1).join(" ")];
}

function splitFundNameAndTransactionNo(value: string): [string, string] {
  const text = cleanText(value);
  const match = text.match(/^(.+?)\s+([A-Z]{1,8}\d[\w-]*)$/);
  if (!match) return [text, ""];
  return [match[1] ?? "", match[2] ?? ""];
}

/** The fund query's dates as YYYY/MM/DD and the label its captured tables carry. */
function yuantaFundQueryRange({ start, end }: CollectionPeriod): {
  startDate: string;
  endDate: string;
  label: string;
} {
  const startDate = start.replaceAll("-", "/");
  const endDate = end.replaceAll("-", "/");
  return { startDate, endDate, label: `${startDate}-${endDate}` };
}

/** Whether a scope shows fund tables and body text that matches the page it should be. */
const fundTablesShow = (bodyPattern: RegExp) => async (scope: BrowserScope): Promise<boolean> => {
  if ((await scope.locator(FUND_TABLE_SELECTOR).count().catch(() => 0)) === 0) return false;
  return bodyPattern.test(cleanText(await scope.locator("body").innerText().catch(() => "")));
};

const FUND_PORTFOLIO_SUMMARY_ROUTE: YuantaRoute = {
  path: "fundsummary?TxnType=FundSummary",
  menuId: "menu_fundSummary",
  description: "YuanTa fund portfolio summary tables",
  ready: fundTablesShow(/基金名稱|幣別總計|投資金額/),
};

const FUND_INVESTMENT_OVERVIEW_ROUTE: YuantaRoute = {
  path: "fundsummary?TxnType=unknow",
  menuId: "menu_fundUknow",
  description: "YuanTa fund investment detail tables",
  ready: fundTablesShow(/投資日期|交易編號|基金明細查詢|無持有基金|未持有基金|無基金部位/),
};

const FUND_ACCOUNT_HISTORY_ROUTE: YuantaRoute = {
  path: "fundtransactiondetails",
  menuId: "menu_fundtransactiondetails",
  description: "YuanTa account fund history query",
  ready: async (scope) =>
    (await scope.locator('input[name="fundtransactiondetails_sdate"]').count().catch(() => 0)) > 0,
};

const PREVIOUS_DOCUMENT_MARK = "__yuantaFundPreviousDocument";

/** Mark every document shown now, so a wait after a form submit skips the page it replaced. */
async function markShownDocuments(site: YuantaEbankSite): Promise<void> {
  for (const scope of site.frames.scopes()) {
    await site.frames.race(scope.evaluate((mark) => {
      (window as unknown as Record<string, unknown>)[mark] = true;
    }, PREVIOUS_DOCUMENT_MARK).catch(() => undefined));
  }
}

const isMarkedDocument = (scope: BrowserScope) =>
  scope.evaluate((mark) => (window as unknown as Record<string, unknown>)[mark] === true, PREVIOUS_DOCUMENT_MARK)
    .catch(() => true);

async function waitForFundTables(
  site: YuantaEbankSite,
  bodyPattern: RegExp,
  description: string,
  options: Readonly<{ replacingMarked?: boolean }> = {},
): Promise<BrowserScope> {
  const shows = fundTablesShow(bodyPattern);
  return await site.frames.until(async () => {
    for (const scope of site.frames.scopes()) {
      if (options.replacingMarked && await isMarkedDocument(scope)) continue;
      if (await shows(scope)) return scope;
    }
    return null;
  }, `Timed out waiting for ${description}.`);
}

const settleScope = (site: YuantaEbankSite, scope: BrowserScope) =>
  site.frames.settle(scope === site.frames.page ? undefined : scope as Frame);

/** Wait for fund tables in a document that replaced the marked ones, then let it settle. */
async function waitForSubmittedFundTables(
  site: YuantaEbankSite,
  bodyPattern: RegExp,
  description: string,
): Promise<BrowserScope> {
  const scope = await waitForFundTables(site, bodyPattern, description, { replacingMarked: true });
  await settleScope(site, scope);
  return scope;
}

async function openPortfolioSummary(site: YuantaEbankSite): Promise<BrowserScope> {
  return await site.open(FUND_PORTFOLIO_SUMMARY_ROUTE);
}

async function openInvestmentOverview(site: YuantaEbankSite): Promise<BrowserScope> {
  return await site.open(FUND_INVESTMENT_OVERVIEW_ROUTE);
}

export function isYuantaFundPositionAbsentText(
  value: string | null | undefined,
): boolean {
  return /無持有基金|未持有基金|無基金部位|沒有基金部位|查無基金/.test(
    cleanText(value),
  );
}

async function openOffHourOrders(site: YuantaEbankSite): Promise<BrowserScope> {
  await openInvestmentOverview(site);
  const scope = await waitForFundTables(
    site,
    /doOffhourQuery|營業時間外交易查詢/,
    "YuanTa fund investment overview off-hour link",
  );
  const link = await site.frames.firstVisible(
    (candidate) => candidate.locator('a[onclick*="doOffhourQuery"]'),
    "YuanTa regular fund off-hour orders link",
    { in: scope },
  );
  await site.frames.race(link.click({ force: true }));
  await settleScope(site, scope);
  // No captured page shows whether doOffhourQuery navigates or rewrites the
  // overview in place, so there is no condition that the overview is gone.
  await site.frames.pause(750);
  return await waitForFundTables(
    site,
    /申購基金|轉出基金|查詢起迄日/,
    "YuanTa off-hour fund orders tables",
  );
}

async function queryOffHourOrders(
  site: YuantaEbankSite,
  startDate: string,
  endDate: string,
): Promise<BrowserScope> {
  const scope = await site.frames.scopeWith("#sdate, #edate");
  await site.frames.race(scope.locator("#sdate").fill(startDate));
  await site.frames.race(scope.locator("#edate").fill(endDate));
  await markShownDocuments(site);
  await submitForm(site, scope, "offhourqueryandcancel?method=query", {});
  return await waitForSubmittedFundTables(
    site,
    /申購基金|轉出基金|查詢起迄日/,
    "queried YuanTa off-hour fund orders tables",
  );
}

export async function extractFundPositions(
  site: YuantaEbankSite,
  allowEmptyHistory = false,
): Promise<FundPosition[]> {
  const scope = await waitForFundTables(
    site,
    /fundDetail|基金明細查詢|交易編號|無持有基金|未持有基金|無基金部位|查無基金/,
    "YuanTa fund positions",
  );
  const links = scope.locator('a[onclick*="fundDetail("]');
  const count = await links.count();
  const positions = new Map<string, FundPosition>();

  for (let index = 0; index < count; index += 1) {
    const link = links.nth(index);
    const onclick = (await link.getAttribute("onclick")) ?? "";
    const match = onclick.match(
      /fundDetail\(['"]([^'"]+)['"],['"]([^'"]+)['"],['"]([^'"]+)['"]\)/,
    );
    if (!match) continue;

    const [, txnType, paperNo, trustNo] = match;
    const rowText = cleanText(
      await link
        .locator("xpath=ancestor::tr[1]")
        .innerText()
        .catch(() => ""),
    );
    const label = cleanText(await link.textContent()) || rowText || paperNo;
    const key = `${txnType}:${paperNo}:${trustNo}`;
    if (!positions.has(key)) {
      positions.set(key, { txnType, paperNo, trustNo, label });
    }
  }

  const result = [...positions.values()];
  if (result.length === 0) {
    const bodyText = await scope
      .locator("body")
      .innerText()
      .catch(() => "");
    if (isYuantaFundPositionAbsentText(bodyText)) {
      if (allowEmptyHistory) return [];
      throw new StatementComponentAbsentError(
        "No YuanTa fund position is available for this login.",
        "no_data",
      );
    }
  }

  return result;
}

export function yuantaFundHistoryResultIsUnpaged(markup: string): boolean {
  return !/(?:class|id)\s*=\s*["'][^"']*\b(?:pager|pagination)\b|\b(?:下一頁|下頁|next\s*page)\b|\b(?:currentPage|pageIndex|pageNo|pageNumber|pageSize)\b/iu.test(
    markup,
  );
}

async function openFundDetail(
  site: YuantaEbankSite,
  position: FundPosition,
): Promise<BrowserScope> {
  const scope = await waitForFundTables(
    site,
    /fundDetail|基金明細查詢|交易編號/,
    "YuanTa fund investment detail tables",
  );

  await markShownDocuments(site);
  await submitForm(site, scope, "fundsummary", {
    TxnType: position.txnType,
    PapernNo: position.paperNo,
    TrustNo: position.trustNo,
  });
  return await waitForSubmittedFundTables(
    site,
    /交易明細查詢|參考淨值|投資日期/,
    `YuanTa fund detail page for ${position.paperNo}`,
  );
}

async function queryAccountFundTransactions(
  site: YuantaEbankSite,
  query: YuantaFundAccountHistoryQuery,
  startDate: string,
  endDate: string,
): Promise<void> {
  // Re-enter the general account query: detail-page fields can retain a lot filter.
  const scope = await site.open(FUND_ACCOUNT_HISTORY_ROUTE);
  for (const name of ["isFromFundDetail", "is_fromFund"]) {
    const field = scope.locator(`input[name="${name}"]`);
    if (await field.count() && await site.frames.race(field.first().inputValue()) === "Y")
      throw new Error("YuanTa account fund history retained a position detail scope.");
  }
  const queryFields = yuantaFundAccountHistoryQueryFields(query, startDate, endDate);
  await markShownDocuments(site);
  const responsePromise = site.frames.race(site.frames.page.waitForResponse(response =>
    response.request().method() === "POST" &&
    new URL(response.url()).pathname === "/nib/tx/fundtransactiondetails", { timeout: 30_000 }));
  const [, response] = await Promise.all([
    submitForm(site, scope, "fundtransactiondetails", queryFields), responsePromise,
  ]);
  if (!response.ok()) throw new Error("YuanTa account fund history response failed.");
  assertYuantaFundHistoryQueryRequest(new URLSearchParams(response.request().postData() ?? ""), queryFields);
  const resultScope = await waitForSubmittedFundTables(site,
    /查詢日期|申購匯率|贖回日期|轉出日期|入帳日期|分配日期|查無資料/,
    "YuanTa account fund history result");
  if (!yuantaFundHistoryResultIsUnpaged(await site.frames.race(resultScope.locator("body").innerHTML())))
    throw new Error("YuanTa account fund history has untraversed pagination.");
}

async function submitForm(
  site: YuantaEbankSite,
  scope: BrowserScope,
  action: string,
  values: Record<string, string>,
): Promise<void> {
  await site.frames.race(scope
    .locator("form#mform, form[name='mform']")
    .first()
    .evaluate(
      (formElement, { action: formAction, values: formValues }) => {
        const form = formElement as HTMLFormElement;
        for (const [name, value] of Object.entries(formValues)) {
          const byName = form.elements.namedItem(name);
          const element = byName instanceof RadioNodeList ? byName[0] : byName;
          if (element && "value" in element) {
            (element as HTMLInputElement).value = value;
            continue;
          }

          const input = document.createElement("input");
          input.type = "hidden";
          input.name = name;
          input.value = value;
          form.appendChild(input);
        }

        form.action = formAction;
        form.submit();
      },
      { action, values },
    ));
}

async function parseFundTables(
  site: YuantaEbankSite,
  category: string,
  fund: string | null,
  period: string | null,
  sourceText: SourceTextPort,
): Promise<ParsedTable[]> {
  site.frames.signal.throwIfAborted();
  const scope = await site.frames.scopeWith(FUND_TABLE_SELECTOR);
  sourceText.assertIntact(await site.frames.race(scope.locator("body").innerHTML()));
  const tables = scope.locator(FUND_TABLE_SELECTOR);
  const count = await tables.count();
  const parsed: ParsedTable[] = [];

  for (let tableIndex = 0; tableIndex < count; tableIndex += 1) {
    const table = tables.nth(tableIndex);
    const { rows, cellColspans, cellLines } = await parseHtmlTableRows(table);
    if (rows.length === 0) continue;

    const tableLabel = classifyTable(category, rows, tableIndex);
    parsed.push({
      category,
      fund,
      period,
      tableLabel,
      rows,
      cellColspans,
      cellLines,
    });
  }

  if (parsed.length === 0) {
    throw new Error(`No YuanTa fund tables found for ${category}.`);
  }

  sourceText.assertIntact(JSON.stringify(parsed));

  return parsed;
}

export async function parseHtmlTableRows(
  table: Locator,
): Promise<ParsedHtmlTableRows> {
  const rows = table.locator("tr");
  const rowCount = await rows.count();
  const parsedRows: string[][] = [];
  const parsedCellColspans: number[][] = [];
  const parsedCellLines: string[][][] = [];

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const cells = rows.nth(rowIndex).locator("th, td");
    const cellCount = await cells.count();
    const values: string[] = [];
    const cellColspans: number[] = [];
    const cellLines: string[][] = [];

    for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
      const cell = cells.nth(cellIndex);
      const sourceText = await cell.innerText();
      values.push(cleanText(sourceText));
      cellLines.push(sourceText.split(/\r?\n/u).map(cleanText).filter(Boolean));
      const rawColspan = await cell.getAttribute("colspan");
      const colspan = rawColspan ? Number.parseInt(rawColspan, 10) : 1;
      cellColspans.push(Number.isInteger(colspan) && colspan > 0 ? colspan : 1);
    }

    if (values.some((value) => value.length > 0)) {
      parsedRows.push(values);
      parsedCellColspans.push(cellColspans);
      parsedCellLines.push(cellLines);
    }
  }

  if (parsedRows.length === 0) {
    const text = cleanText(await table.innerText());
    if (text) {
      parsedRows.push([text]);
      parsedCellColspans.push([1]);
      parsedCellLines.push([[text]]);
    }
  }

  return { rows: parsedRows, cellColspans: parsedCellColspans, cellLines: parsedCellLines };
}

function classifyTable(
  category: string,
  rows: string[][],
  tableIndex: number,
): string {
  const text = rows.flat().join(" ");

  if (/基金名稱.*基金類型.*投資幣別/.test(text)) return "portfolio-summary";
  if (/投資日期.*基金名稱.*交易編號.*累積配息/.test(text)) {
    return "investment-detail";
  }
  if (/幣別總計.*投資金額/.test(text)) return "currency-total";
  if (/參考項目.*參考基準日.*參考淨值/.test(text)) {
    return "reference-nav";
  }
  if (/交易功能項目.*確認送出/.test(text)) {
    return "transaction-query-form";
  }
  if (/查詢日期.*查詢基金/.test(text)) return "transaction-query-summary";
  if (/^\*?查詢日期/u.test(rows[0]?.[0] ?? "")) return "transaction-query-summary";
  if (/投資日期.*申購匯率.*申購淨值.*申購單位數/.test(text)) {
    return "buy-details";
  }
  if (/贖回日期.*入帳帳號.*入帳淨額/.test(text)) {
    return /遞延手續費/u.test(rows[findHeaderRowIndex({ rows } as ParsedTable)]?.join(" ") ?? "")
      ? "redemption-details" : "redemption-account-details";
  }
  if (/扣款日期.*申購單位數.*申購匯率.*申購淨值/u.test(text))
    return /當次扣款比重/u.test(text) ? "variable-deduction-details" : "deduction-details";
  if (/轉出日期.*轉入日期.*轉出基金.*轉入基金/.test(text)) {
    return "conversion-details";
  }
  if (/入帳日期.*分配金額.*入帳帳號/.test(text)) {
    return "cash-dividend-details";
  }
  if (/分配日期.*分配單位數/.test(text)) {
    return "unit-dividend-details";
  }
  if (/申購基金.*投資類型.*申購日期/.test(text)) {
    return "offhour-buy-orders";
  }
  if (/轉出基金.*轉換方式.*轉入基金/.test(text)) {
    return "offhour-conversion-orders";
  }
  if (/再申購基金.*預估再申購手續費率/.test(text)) {
    return "offhour-redemption-rebuy-orders";
  }
  if (/贖回基金.*贖回方式.*贖回轉入帳號/.test(text)) {
    return "offhour-redemption-orders";
  }
  if (/異動基金.*異動種類.*變更後設定值/.test(text)) {
    return "offhour-change-orders";
  }
  if (/查詢起迄日/.test(text)) return "offhour-query-form";

  return `${category}-table-${tableIndex + 1}`;
}

function headerScore(row: string[]): number {
  return row.filter((value) =>
    /日期|基金|交易|投資|金額|幣別|單位|淨值|帳號|類型|損益|報酬率/.test(value),
  ).length;
}

function findHeaderRowIndex(table: ParsedTable): number {
  let bestIndex = -1;
  let bestScore = 0;

  for (let index = 0; index < table.rows.length; index += 1) {
    const score = headerScore(table.rows[index]);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }

  if (bestScore > 0) return bestIndex;
  return table.rows[0].some((header) => header.length > 0) ? 0 : -1;
}

function alignValuesToHeaders(values: string[], headers: string[]): string[] {
  const aligned = [...values];
  while (aligned.length > headers.length && !aligned[0]) {
    aligned.shift();
  }
  return aligned;
}

function isRepeatedHeaderRow(values: string[], headers: string[]): boolean {
  if (values.length !== headers.length) return false;
  return values.every((value, index) => !value || cleanText(value) === headers[index]);
}

function tableHasNoData(table: ParsedTable): boolean {
  const text = table.rows.flat().join(" ");
  return /查無資料|無資料|無交易明細/.test(text);
}

function assertYuantaFundHistoryQueryResult(
  tables: readonly ParsedTable[],
  position: FundPosition | string,
): void {
  const positionKey = typeof position === "string" ? position : fundPositionKey(position);
  const scopedTables = tables.filter(
    (table) => table.category === "historical-transactions" && table.fund === positionKey,
  );
  if (scopedTables.length === 0)
    throw new Error("Yuanta fund history result is missing for its requested scope.");

  let explicitEmpty = false;
  let capturedRows = 0;
  for (const table of scopedTables) {
    const hasExplicitEmpty = table.rows.flat().some((cell) => /查無資料/u.test(cell));
    explicitEmpty ||= hasExplicitEmpty;
    if ([...fundPurchaseTableLabels, ...fundRedemptionTableLabels].includes(table.tableLabel)) {
      const rows = normalizedColumnRecords(table);
      if (rows.length === 0 && !hasExplicitEmpty)
        throw new Error(`Yuanta fund ${table.tableLabel} table has no complete row or explicit empty result.`);
      for (const row of rows) {
        const date = canonicalSourceDate(
          row[fundPurchaseTableLabels.includes(table.tableLabel) ? "投資日期" : "贖回日期"] ?? "",
        );
        const quantity = row[fundPurchaseTableLabels.includes(table.tableLabel) ? "申購單位數" : "贖回單位數"] ?? "";
        const cash = row[fundPurchaseTableLabels.includes(table.tableLabel) ? "投資金額" : "入帳淨額"] ?? "";
        if (!quantity.trim() || !cash.trim())
          throw new Error(`Yuanta fund ${table.tableLabel} row is missing transaction amounts.`);
        capturedRows += 1;
        // Validate the source date shape here; its query-range bound is checked
        // against the coverage proof when canonical slots are assigned.
        void date;
      }
      continue;
    }

    if (["conversion-details", "cash-dividend-details", "unit-dividend-details"].includes(table.tableLabel)) {
      const rows = normalizedColumnRecords(table);
      if (rows.length > 0) {
        for (const row of rows) {
          const dateFields = table.tableLabel === "conversion-details" ? ["轉出日期", "轉入日期"]
            : [table.tableLabel === "cash-dividend-details" ? "入帳日期" : "分配日期"];
          dateFields.forEach(field => canonicalSourceDate(row[field] ?? ""));
        }
        capturedRows += rows.length;
        continue;
      }
      if (!hasExplicitEmpty)
        throw new Error(`Yuanta fund ${table.tableLabel} result is not explicitly empty.`);
      continue;
    }

    if (table.tableLabel.startsWith("historical-transactions-table-") &&
        !hasExplicitEmpty && table.rows.flat().some((cell) => cell.trim()))
      throw new Error("Yuanta fund history contains an unrecognized result table.");
  }

  if (capturedRows === 0 && !explicitEmpty)
    throw new Error("Yuanta fund history query did not report rows or an explicit empty result.");
}

function tableOutputConfigForTable(table: ParsedTable): TableOutputConfig | undefined {
  const layouts = tableOutputLayoutsByLabel[table.tableLabel];
  const exactLayout = layouts?.find(layout => table.rows.some(row => {
    const headers = alignValuesToHeaders(row, layout.rawColumns)
      .map(value => cleanText(value).replace(/\s*\?/gu, ""));
    return headers.length === layout.rawColumns.length &&
      headers.every((header, index) => header === layout.rawColumns[index]);
  }));
  if (layouts && !exactLayout && !tableHasNoData(table))
    throw new Error("YuanTa history table requires supported source headers.");
  return exactLayout ?? tableOutputConfigsByLabel[table.tableLabel];
}

export function normalizedRowsForTable(table: ParsedTable): NormalizedRow[] {
  const config = tableOutputConfigForTable(table);
  if (!config) return [];
  if (tableHasNoData(table)) {
    if (fundFinancialHistoryTableLabels.includes(table.tableLabel) &&
      table.rows.some(row => row.some(value => /^\d{4}[/-]\d{2}[/-]\d{2}/u.test(cleanText(value)))))
      throw new Error("YuanTa history table contradicts its explicit empty result.");
    return [];
  }

  const headerRowIndex = findMatchingHeaderRowIndex(table, config.rawColumns);
  if (headerRowIndex < 0) return [];

  const sourceHeaders = (table.rows[headerRowIndex] ?? []).map(value => cleanText(value).replace(/\s*\?/gu, ""));
  const scalarOrderRequired = [...fundPurchaseTableLabels, "unit-dividend-details"].includes(table.tableLabel);
  const sourceColumnOrder = scalarOrderRequired
    ? config.rawColumns.map(header => sourceHeaders.indexOf(cleanText(header))) : null;
  const exactSourceColumnOrder = sourceColumnOrder && sourceHeaders.length === config.rawColumns.length &&
    sourceColumnOrder.every(index => index >= 0) && new Set(sourceColumnOrder).size === sourceColumnOrder.length
    ? sourceColumnOrder : null;
  if (scalarOrderRequired && !exactSourceColumnOrder)
    throw new Error("YuanTa scalar history table requires complete unique source headers.");
  const rows: NormalizedRow[] = [];

  for (
    let rowIndex = headerRowIndex + 1;
    rowIndex < table.rows.length;
    rowIndex += 1
  ) {
    if (table.tableLabel === "redemption-account-details" && cleanText(table.rows[rowIndex]?.[0]) === "合計") {
      // The observed account report has an eight-cell aggregate footer without
      // merged cells. Require its full label layout before excluding it.
      const footer = table.rows[rowIndex]!;
      const spans = table.cellColspans?.[rowIndex];
      if (spans?.length !== 8 || spans.some(span => span !== 1) || footer.length !== 8 || cleanText(footer[1]) !== "贖回投資金額" ||
        cleanText(footer[3]) !== "贖回參考損益" || cleanText(footer[5]) !== "贖回參考報酬率" ||
        cleanText(footer[7]) !== "")
        throw new Error("YuanTa redemption aggregate footer has an unsupported source shape.");
      continue;
    }
    const sourceValues = normalizedRawRowValues(table, rowIndex, config.rawColumns);
    if (fundFinancialHistoryTableLabels.includes(table.tableLabel) &&
      sourceValues.some(value => value.length > 0) && sourceValues.length !== config.rawColumns.length)
      throw new Error("YuanTa history row has an unsupported source column count.");
    const values = exactSourceColumnOrder ? exactSourceColumnOrder.map(index => sourceValues[index] ?? "") : sourceValues;
    if (!values.some((value) => value.length > 0)) continue;
    if (values.length !== config.rawColumns.length) continue;
    if (isRepeatedHeaderRow(values, config.rawColumns)) continue;

    const rowColumns: Record<string, string> = {};
    for (let columnIndex = 0; columnIndex < values.length; columnIndex += 1) {
      const header =
        config.rawColumns[columnIndex] ?? `column_${columnIndex + 1}`;
      rowColumns[header] = values[columnIndex] ?? "";
    }

    const normalizedValues = config.normalize(rowColumns);
    if (normalizedValues.length !== config.headers.length) {
      throw new Error(
        `Normalized YuanTa fund table ${table.tableLabel} produced ${normalizedValues.length} values for ${config.headers.length} headers.`,
      );
    }
    if (!normalizedValues.some((value) => value.length > 0)) continue;

    rows.push({
      category: table.category,
      fund: table.fund,
      period: table.period,
      values: normalizedValues,
    });
  }

  return rows;
}

function normalizedRawRowValues(
  table: ParsedTable,
  rowIndex: number,
  columns: string[],
): string[] {
  const rawValues = table.rows[rowIndex] ?? [];
  const rawColspans = table.cellColspans?.[rowIndex];

  if (fundRedemptionTableLabels.includes(table.tableLabel) && table.cellLines?.[rowIndex]) {
    const sourceLines = table.cellLines[rowIndex];
    if (rawValues.length !== columns.length || sourceLines.length !== columns.length)
      throw new Error("YuanTa redemption row has an unsupported source shape.");
    return rawValues.map((value, index) => {
      if (!["贖回日期 分配日期", "基金名稱 交易編號", "贖回投資金額 單位數", "贖回價格 贖回匯率",
        "信託管理費 短線費用", "入帳帳號 入帳淨額", "贖回參考損益 參考贖回報酬率"].includes(columns[index])) return value;
      const logicalLines: string[] = [];
      for (let line = 0; line < sourceLines[index].length; line += 1) {
        const current = sourceLines[index][line];
        if (isYuantaFundSourceCurrencyLabel(current) &&
          /^[\d,]+(?:\.\d+)?$/u.test(sourceLines[index][line + 1] ?? "")) {
          logicalLines.push(`${current} ${sourceLines[index][++line]}`);
        } else logicalLines.push(current);
      }
      if (columns[index] === "入帳帳號 入帳淨額" && logicalLines.length === 3) {
        if (!logicalLines[0] || !/^\d+$/u.test(logicalLines[1]!))
          throw new Error("YuanTa redemption account description has an unsupported source shape.");
        yuantaFundSourceAmountCurrency(logicalLines[2]!);
        return `${logicalLines[0]} ${logicalLines[1]}\n${logicalLines[2]}`;
      }
      return logicalLines.join("\n");
    });
  }

  if (table.tableLabel === "conversion-details" && table.cellLines?.[rowIndex]) {
    const lines = table.cellLines[rowIndex];
    if (rawValues.length !== columns.length || lines.length !== columns.length) {
      throw new Error("YuanTa conversion row has an unsupported source shape.");
    }
    return rawValues.map((value, index) =>
      [0, 2, 4, 5, 6, 7].includes(index) ? lines[index].join("\n") : value,
    );
  }

  // YuanTa's reference-NAV table has four logical columns, but the last
  // value cell spans the value and empty lookup columns. Preserve the source
  // value in its original column and add only the represented empty column.
  if (
    table.tableLabel === "reference-nav" &&
    rawValues.length === 3 &&
    rawColspans?.length === 3 &&
    rawColspans[0] === 1 &&
    rawColspans[1] === 1 &&
    rawColspans[2] === 2
  ) {
    return [...rawValues, ""];
  }

  if (table.tableLabel === "reference-nav") {
    const aligned = alignValuesToHeaders(rawValues, columns);
    const hasOnlyUnitColspans =
      !rawColspans || rawColspans.every((colspan) => colspan === 1);
    if (aligned.length === columns.length && hasOnlyUnitColspans) {
      return aligned;
    }
    throw new Error(
      `YuanTa reference-NAV row ${rowIndex} has an unsupported source shape.`,
    );
  }

  return alignValuesToHeaders(rawValues, columns);
}

function findMatchingHeaderRowIndex(
  table: ParsedTable,
  columns: string[],
): number {
  for (let index = 0; index < table.rows.length; index += 1) {
    const row = alignValuesToHeaders(table.rows[index], columns);
    if (row.length !== columns.length) continue;

    const sameCellCount = row.filter(
      (value, cellIndex) => value === columns[cellIndex],
    ).length;
    if (sameCellCount >= Math.max(2, Math.floor(columns.length * 0.6))) {
      return index;
    }
  }

  return findHeaderRowIndex(table);
}

async function captureTables(
  site: YuantaEbankSite,
  parsedTables: ParsedTable[],
  category: string,
  fund: string | null,
  period: string | null,
  sourceText: SourceTextPort,
): Promise<void> {
  const tables = await parseFundTables(site, category, fund, period, sourceText);
  for (const table of tables) {
    parsedTables.push(table);
  }
}

type YuantaFundValuationBasis = {
  fundKey: string;
  navEffectiveOn: string;
  fxEffectiveOn: string;
};

const fundPositionKey = (position: FundPosition): string =>
  [position.txnType, position.paperNo, position.trustNo]
    .map(encodeURIComponent)
    .join(":");

function canonicalSourceDate(value: string): string {
  const normalized = value.trim().replaceAll("/", "-");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error("YuanTa fund source basis date is missing.");
  }
  return normalized;
}

function canonicalExactAmount(value: string): {
  coefficient: string;
  scale: number;
} {
  if (value.includes("-")) {
    throw new Error("YuanTa fund amount must be non-negative.");
  }
  const normalized = value.replaceAll(",", "").replace(/[^0-9.]/g, "");
  const match = /^(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) throw new Error("YuanTa fund amount is not an exact decimal.");
  return {
    coefficient: `${match[1]}${match[2] ?? ""}`.replace(/^0+(?=\d)/, ""),
    scale: match[2]?.length ?? 0,
  };
}

function normalizedColumnRecords(
  table: ParsedTable,
): Array<Record<string, string>> {
  const config = tableOutputConfigForTable(table);
  if (!config) return [];
  return normalizedRowsForTable(table).map((row) =>
    Object.fromEntries(
      config.headers.map((header, index) => [header, row.values[index] ?? ""]),
    ),
  );
}

export function parseYuantaFundValuationBasis(
  table: ParsedTable,
): YuantaFundValuationBasis {
  if (table.tableLabel !== "reference-nav" || !table.fund) {
    throw new Error(
      "YuanTa fund valuation basis table is not position-scoped.",
    );
  }
  const rows = normalizedColumnRecords(table);
  const nav = rows.find((row) => row["參考項目"]?.trim() === "贖回");
  const fx = rows.find((row) => row["參考項目"]?.trim() === "匯率");
  if (!nav?.["參考基準日"] || !fx?.["參考基準日"]) {
    throw new Error(
      "YuanTa fund valuation requires source-reported NAV and FX basis dates.",
    );
  }
  return {
    fundKey: table.fund,
    navEffectiveOn: canonicalSourceDate(nav["參考基準日"]),
    fxEffectiveOn: canonicalSourceDate(fx["參考基準日"]),
  };
}

function positionForTransactionNumber(
  positions: readonly FundPosition[],
  sourceTransactionNo: string,
): FundPosition | undefined {
  const normalized = cleanText(sourceTransactionNo);
  const matches = positions.filter((position) =>
    normalized.length > 0 && normalized === cleanText(position.paperNo),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

type YuantaFundCanonicalAdmission =
  | {
      status: "admitted";
      contractVersion: "yuanta-fund/investment/canonical-v1";
      holdingCount: number;
      transactionCount: number;
    }
  | {
      status: "partial";
      contractVersion: "yuanta-fund/investment/canonical-v1";
      holdingCount: number;
      transactionCount: number;
      reason:
        | "no-investment-holding-evidence"
        | "source-effective-time-evidence-incomplete";
    }
  | {
      status: "not-admitted";
      reason:
        | "no-investment-holding-evidence"
        | "source-effective-time-evidence-incomplete"
        | "transaction-source-evidence-incomplete";
    };

// Causes stay in memory and are excluded from source/admission JSON.
const fundAdmissionCauses = new WeakMap<object, unknown>();
function failedFundAdmission<T extends YuantaFundCanonicalAdmission>(admission: T, cause: unknown): T {
  fundAdmissionCauses.set(admission, cause);
  return admission;
}
function fundAdmissionError(admission: YuantaFundCanonicalAdmission, message: string): CanonicalInvestmentAdmissionError {
  const error = new CanonicalInvestmentAdmissionError(message);
  if (fundAdmissionCauses.has(admission))
    Object.defineProperty(error, "cause", { value: fundAdmissionCauses.get(admission), configurable: true });
  return error;
}

function fundCurrencyByPositionKey(
  holdingRows: readonly Record<string, string>[],
  positions: readonly FundPosition[],
): Map<string, string> {
  const currencies = new Map<string, string>();
  for (const row of holdingRows) {
    const position = positionForTransactionNumber(
      positions,
      row["交易編號"] ?? "",
    );
    if (!position) {
      throw new Error("fund holding has no stable provider position");
    }
    const currency = canonicalYuantaFundCurrency(row["投資幣別"] ?? "");
    if (!currency) throw new Error("fund holding has no source currency");
    const key = fundPositionKey(position);
    const previous = currencies.get(key);
    if (previous && previous !== currency) {
      throw new Error("fund holding currency changed within one position");
    }
    currencies.set(key, currency);
  }
  return currencies;
}

function yuantaFundTransactionRows(tables: readonly ParsedTable[]): YuantaCanonicalInvestmentRow[] {
  const transactions: YuantaCanonicalInvestmentRow[] = [];
  for (const table of tables) {
    if (
      !table.fund ||
      !fundFinancialHistoryTableLabels.includes(table.tableLabel)
    ) {
      continue;
    }
    const accountHistoryType = yuantaFundAccountHistoryType(table.fund);
    if (!accountHistoryType)
      throw new Error("YuanTa fund history requires an account-wide investment-type query.");
    const occurrenceScope = yuantaFundAccountHistoryScope(accountHistoryType);
    if (![...fundPurchaseTableLabels, ...fundRedemptionTableLabels].includes(table.tableLabel)) {
      for (const row of normalizedColumnRecords(table)) {
        transactions.push(...yuantaFundAdditionalEventRows(table.tableLabel, row,
          occurrenceScope, { amount: canonicalExactAmount, date: canonicalSourceDate, currency: canonicalYuantaFundCurrency,
            cashCurrency: yuantaFundSourceAmountCurrency,
          }));
      }
      continue;
    }
    const action = fundPurchaseTableLabels.includes(table.tableLabel) ? "buy" : "sell";
    for (const row of normalizedColumnRecords(table)) {
      const effectiveOn = canonicalSourceDate(
        row[action === "buy" ? "投資日期" : "贖回日期"] ?? "",
      );
      const quantityValue =
        row[action === "buy" ? "申購單位數" : "贖回單位數"] ?? "";
      const cashValue = row[action === "buy" ? "投資金額" : "入帳淨額"] ?? "";
      const currency = yuantaFundSourceAmountCurrency(cashValue);
      const security = resolveYuantaFundIdentity(row["基金名稱"] ?? "");
      transactions.push({
        sourceRecordKey: deriveSourceConnectionIdentityKey(
          "yuanta-fund-transaction-record",
          [
            occurrenceScope,
            row["交易編號"] ?? "",
            action,
            effectiveOn,
            quantityValue,
            cashValue,
          ],
        ),
        occurrenceScopeKey: occurrenceScope,
        occurrenceFingerprintFields: action === "buy"
          ? [
              row["交易編號"] ?? "",
              security.name,
              row["投資金額"] ?? "",
              row["申購匯率"] ?? "",
              row["申購淨值"] ?? "",
              row["申購手續費"] ?? "",
              row["點數折抵"] ?? "",
              row["申購單位數"] ?? "",
              ...(table.tableLabel === "buy-details" ? [] : [row["扣款帳號/信用卡卡號"] ?? "", row["當次扣款比重"] ?? ""]),
            ]
          : [
              row["交易編號"] ?? "",
              security.name,
              row["分配日期"] ?? "",
              row["贖回投資金額"] ?? "",
              row["贖回單位數"] ?? "",
              row["贖回價格"] ?? "",
              row["贖回匯率"] ?? "",
              row["信託管理費"] ?? "",
              row["短線費用"] ?? "",
              row["遞延手續費"] ?? "",
              row["入帳淨額"] ?? "",
              row["備註"] ?? "",
            ],
        producerSecurityId: security.producerSecurityId,
        securityName: security.name,
        securityCurrency: security.pricingCurrency,
        securityIdentityKind: "source-fund-name",
        currency,
        effectiveOn,
        action,
        quantity: canonicalExactAmount(quantityValue),
        cashEffect: { ...canonicalExactAmount(cashValue), currency },
      });
    }
  }
  // Equal history rows from distinct position queries do not prove whether
  // they are one shared event or separate economic occurrences. Reject the
  // capture; only repeated rows within one proven query bucket get slots.
  const observedScopes = new Map<string, string>();
  for (const transaction of transactions) {
    const fingerprint = JSON.stringify([transaction.producerSecurityId, transaction.action,
      transaction.effectiveOn, transaction.occurrenceFingerprintFields]);
    const scope = transaction.occurrenceScopeKey!;
    const prior = observedScopes.get(fingerprint);
    if (prior && prior !== scope)
      throw new Error("YuanTa history has overlapping account history queries without cross-query occurrence evidence.");
    observedScopes.set(fingerprint, scope);
  }
  return transactions;
}

/** A canonical holding is admissible only when every overview lot can be
 * joined to position-scoped source evidence for its financial effective date.
 * If the provider's historical buy/redemption table exposes an economic date,
 * those transactions may still be admitted when the current holding snapshot
 * has no source-reported as-of date. */
export function evaluateYuantaFundCanonicalAdmission(
  tables: readonly ParsedTable[],
  positions: readonly FundPosition[] = [],
  historyProof?: YuantaFundHistoryProof,
): YuantaFundCanonicalAdmission {
  const holdingRows = tables
    .filter(
      (table) =>
        table.tableLabel === "investment-detail" &&
        table.category === "investment-overview",
    )
    .flatMap(normalizedColumnRecords);
  let transactionRows: YuantaCanonicalInvestmentRow[];
  try {
    transactionRows = yuantaFundTransactionRows(tables);
  } catch (cause) {
    return failedFundAdmission({
      status: "not-admitted",
      reason: "transaction-source-evidence-incomplete",
    }, cause);
  }
  const transactionCount = transactionRows.length;
  if (holdingRows.length === 0) {
    const explicitEmptyHoldings = tables.some(table => table.tableLabel === "current-position-absence" &&
      table.category === "investment-source-evidence" && table.rows.length === 1 &&
      table.rows[0]?.length === 1 && table.rows[0][0] === "無基金部位");
    if (explicitEmptyHoldings && (transactionCount > 0 || historyProof)) return {
      status: "admitted", contractVersion: YUANTA_FUND_INVESTMENT_CONTRACT_VERSION,
      holdingCount: 0, transactionCount,
    };
    return transactionCount > 0
      ? {
          status: "partial",
          contractVersion: "yuanta-fund/investment/canonical-v1",
          holdingCount: 0,
          transactionCount,
          reason: "no-investment-holding-evidence",
        }
      : {
          status: "not-admitted",
          reason: "no-investment-holding-evidence",
        };
  }
  try {
    const currencyByPosition = fundCurrencyByPositionKey(
      holdingRows,
      positions,
    );
    const basisByFund = new Map(
      tables
        .filter((table) => table.tableLabel === "reference-nav")
        .map(parseYuantaFundValuationBasis)
        .map((basis) => [basis.fundKey, basis]),
    );
    for (const row of holdingRows) {
      const position = positionForTransactionNumber(
        positions,
        row["交易編號"] ?? "",
      );
      if (
        !position ||
        !basisByFund.has(fundPositionKey(position)) ||
        !currencyByPosition.has(fundPositionKey(position))
      ) {
        throw new Error("holding lot has no position-scoped valuation basis");
      }
    }
    return {
      status: "admitted",
      contractVersion: "yuanta-fund/investment/canonical-v1",
      holdingCount: holdingRows.length,
      transactionCount,
    };
  } catch (cause) {
    return failedFundAdmission(transactionCount > 0
      ? {
          status: "partial",
          contractVersion: "yuanta-fund/investment/canonical-v1",
          holdingCount: holdingRows.length,
          transactionCount,
          reason: "source-effective-time-evidence-incomplete",
        }
      : {
          status: "not-admitted",
          reason: "source-effective-time-evidence-incomplete",
        }, cause);
  }
}

export function assertYuantaFundCanonicalAdmission(
  admission: YuantaFundCanonicalAdmission,
): asserts admission is Extract<
  YuantaFundCanonicalAdmission,
  { status: "admitted" }
> {
  if (admission.status === "admitted") return;
  if (admission.status === "partial") {
    const holdingEvidenceMessage =
      admission.reason === "no-investment-holding-evidence"
        ? "no current holding observation was captured"
        : "the source did not report a holding effective date";
    throw fundAdmissionError(admission,
      `Yuanta fund canonical admission partial: ${admission.reason}. ` +
        `${admission.transactionCount} dated transaction row(s) were rejected; ` +
        `the complete source was not admitted because ${holdingEvidenceMessage}.`,
    );
  }
  throw fundAdmissionError(admission,
    `Yuanta fund canonical admission failed: ${admission.reason}. ` +
      "Canonical Financial Commit was not opened.",
  );
}

function yuantaFundCanonicalItems(
  input: YuantaFundCollectionInput,
  positions: readonly FundPosition[],
  tables: readonly ParsedTable[],
  historyProof: YuantaFundHistoryProof | undefined,
  now: () => string,
): ProductStageRequest[] {
  const admission = evaluateYuantaFundCanonicalAdmission(tables, positions, historyProof);
  assertYuantaFundCanonicalAdmission(admission);

  const overviewRows = tables
    .filter(
      (table) =>
        table.tableLabel === "investment-detail" &&
        table.category === "investment-overview",
    )
    .flatMap(normalizedColumnRecords);
  const currencyByPosition = fundCurrencyByPositionKey(overviewRows, positions);
  const basisByFund = new Map(
    tables
      .filter((table) => table.tableLabel === "reference-nav")
      .map(parseYuantaFundValuationBasis)
      .map((basis) => [basis.fundKey, basis]),
  );
  const holdingLots: YuantaCanonicalInvestmentRow[] = overviewRows.map((row) => {
    const position = positionForTransactionNumber(
      positions,
      row["交易編號"] ?? "",
    );
    if (!position) {
      throw new Error("YuanTa fund holding has no stable producer position.");
    }
    const basis = basisByFund.get(fundPositionKey(position));
    if (!basis) {
      throw new Error("YuanTa fund holding has no valuation basis evidence.");
    }
    const currency = currencyByPosition.get(fundPositionKey(position));
    if (!currency) {
      throw new Error("YuanTa fund holding has no source currency.");
    }
    const usesReferenceFx = currency === "TWD";
    const effectiveOn = usesReferenceFx
      ? [basis.navEffectiveOn, basis.fxEffectiveOn].sort().at(-1)!
      : basis.navEffectiveOn;
    const sourceRecordKey = deriveSourceConnectionIdentityKey(
      "yuanta-fund-holding-record",
      [
        position.paperNo,
        position.trustNo,
        effectiveOn,
        row["單位數"] ?? "",
        row["不含息參考市值"] ?? "",
      ],
    );
    return {
      sourceRecordKey,
      producerSecurityId: resolveYuantaFundIdentity(row["基金名稱"] ?? "").producerSecurityId,
      securityIdentityKind: "source-fund-name" as const,
      securityCurrency: null,
      securityName: resolveYuantaFundIdentity(row["基金名稱"] ?? "").name,
      currency,
      effectiveOn,
      quantity: canonicalExactAmount(row["單位數"] ?? ""),
      valuation: {
        ...canonicalExactAmount(row["不含息參考市值"] ?? ""),
        currency,
      },
      effectiveTimeEvidence: {
        sourceField: usesReferenceFx
          ? "reference-nav-and-fx-basis-date"
          : "reference-nav-basis-date",
        components: [
          {
            role: "reference-nav" as const,
            sourceField: "贖回/參考基準日",
            value: basis.navEffectiveOn,
          },
          ...(usesReferenceFx
            ? [
                {
                  role: "reference-fx" as const,
                  sourceField: "匯率/參考基準日",
                  value: basis.fxEffectiveOn,
                },
              ]
            : []),
        ],
      },
    };
  });
  const holdings = aggregateYuantaFundHoldingLots(holdingLots);
  const transactionRows = yuantaFundTransactionRows(tables);
  if (!historyProof && transactionRows.length > 0)
    throw new Error("Yuanta fund transaction rows cannot be admitted without complete history coverage.");
  const transactions = historyProof
    ? assignYuantaInvestmentTransactionOccurrences({
        contractVersion: YUANTA_FUND_INVESTMENT_CONTRACT_VERSION,
        transactions: transactionRows,
        transactionHistory: historyProof.transactionHistory,
        occurrenceGroupCoverage: historyProof.occurrenceGroupCoverage,
      })
    : transactionRows;

  const sourceConnectionKey = deriveSourceConnectionIdentityKey("yuanta-fund", [
    input.yuantaUserId,
    input.yuantaAccount,
  ]);
  const accountKey = deriveSourceConnectionIdentityKey("yuanta-fund-account", [
    sourceConnectionKey,
    input.yuantaAccount,
  ]);
  const observedAt = now();
  const captureGroups = new Map<
    string,
    {
      holdings: YuantaCanonicalInvestmentRow[];
      transactions: YuantaCanonicalInvestmentRow[];
    }
  >();
  for (const holding of holdings) {
    const group = captureGroups.get(holding.effectiveOn) ?? {
      holdings: [],
      transactions: [],
    };
    group.holdings.push(holding);
    captureGroups.set(holding.effectiveOn, group);
  }
  if (holdings.length > 0) {
    const firstGroup = captureGroups.values().next().value as
      | {
          holdings: YuantaCanonicalInvestmentRow[];
          transactions: YuantaCanonicalInvestmentRow[];
        }
      | undefined;
    if (firstGroup) firstGroup.transactions = transactions;
  } else if (transactions.length > 0) {
    // A whole account history proof belongs to one complete transaction set.
    // Splitting by economic date would strip coverage from later captures.
    const effectiveOn = transactions.map(transaction => transaction.effectiveOn).sort().at(-1)!;
    captureGroups.set(effectiveOn, { holdings: [], transactions });
  } else if (historyProof) {
    // An explicitly empty account still carries complete dated history evidence.
    // Its query end is the coverage boundary, not an invented holding valuation date.
    captureGroups.set(historyProof.transactionHistory.endDate, { holdings: [], transactions: [] });
  }

  const captures: InvestmentValidatedCapture[] = [];
  const historyCaptureDate = historyProof
    ? captureGroups.keys().next().value as string | undefined
    : undefined;
  for (const [sourceEffectiveOn, group] of captureGroups) {
    const holdingSnapshot = yuantaFundHoldingSnapshot(group, historyProof, observedAt);
    const capture = buildYuantaInvestmentCapture({
      sourceId: "yuanta-fund",
      captureId: `yuanta-fund-investment:${deriveSourceConnectionIdentityKey("yuanta-fund-capture", [sourceConnectionKey, accountKey, sourceEffectiveOn, observedAt])}`,
      sourceConnectionKey,
      identityEpochKey: deriveSourceConnectionIdentityKey("yuanta-fund-epoch", [
        sourceConnectionKey,
        input.yuantaAccount,
      ]),
      accountKey,
      reportingCurrency: "TWD",
      observedAt,
      sourceEffectiveOn,
      ...(historyProof && sourceEffectiveOn === historyCaptureDate
        ? {
            transactionHistory: historyProof.transactionHistory,
            occurrenceGroupCoverage: historyProof.occurrenceGroupCoverage,
          }
        : {}),
      ...(holdingSnapshot ? { holdingSnapshot } : {}),
      holdings: group.holdings,
      transactions: group.transactions,
    });
    captures.push(admitCanonicalInvestmentCapture(capture));
  }
  if (captures.length === 0)
    throw new Error("Yuanta fund admission produced no canonical captures.");
  return captures.map((capture) => ({
    product: "investment",
    itemKey: capture.captureId,
    command: {
      kind: PGLITE_CANONICAL_INVESTMENT_COMMIT_COMMAND,
      request: { capture },
    },
    relationCommands: () => [
      {
        kind: PGLITE_CANONICAL_INVESTMENT_RELATIONS_RESOLVE_COMMAND,
        request: {
          sourceConnectionKey: capture.identity.sourceConnectionKey,
          observedAt: capture.observedAt,
        },
      },
    ],
  }));
}

/**
 * Every admitted holding comes from the account-wide overview, so a capture
 * with holdings is the account's complete inventory at its NAV basis date. An
 * explicit position absence is complete only when the account history runs to
 * the collection date, because a sale after a past query end would otherwise
 * be dated too early.
 */
function yuantaFundHoldingSnapshot(
  group: Readonly<{ holdings: readonly YuantaCanonicalInvestmentRow[]; transactions: readonly YuantaCanonicalInvestmentRow[] }>,
  historyProof: YuantaFundHistoryProof | undefined,
  observedAt: string,
): Readonly<{ sourceField: string }> | undefined {
  if (group.holdings.length > 0)
    return { sourceField: [...new Set(group.holdings.map(holding => holding.effectiveTimeEvidence?.sourceField ?? "as_of_date"))].sort().join("+") };
  if (historyProof?.transactionHistory.endDate !== taipeiDate(observedAt)) return undefined;
  return {
    sourceField: group.transactions.length > 0
      ? "position-absence-and-latest-history-transaction-date"
      : "position-absence-and-history-end-date",
  };
}

function taipeiDate(instant: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(instant));
}

export type YuantaFundSourceSnapshot = Readonly<{
  positions: readonly FundPosition[];
  tables: readonly ParsedTable[];
  transactionHistory?: Readonly<{
    startDate: string;
    endDate: string;
    complete: true;
  }>;
  occurrenceGroupCoverage?: readonly CanonicalOccurrenceGroupCoverage[];
  accountHistoryQueryCoverage?: readonly YuantaFundAccountHistoryQuery[];
}>;

type YuantaFundHistoryProof = Readonly<{
  transactionHistory: Readonly<{
    startDate: string;
    endDate: string;
    complete: true;
  }>;
  occurrenceGroupCoverage: readonly CanonicalOccurrenceGroupCoverage[];
}>;

function validateYuantaFundHistoryProof(
  source: YuantaFundSourceSnapshot,
  input: WorkflowInput,
  period: () => CollectionPeriod,
): YuantaFundHistoryProof | undefined {
  const historicalTables = source.tables.filter(
    (table) => table.category === "historical-transactions",
  );
  if (!input.includeHistoricalTransactions) {
    if (source.transactionHistory || source.occurrenceGroupCoverage || source.accountHistoryQueryCoverage || historicalTables.length > 0)
      throw new Error("Yuanta fund transaction rows require a complete history query.");
    return undefined;
  }

  const history = source.transactionHistory;
  const coverage = source.occurrenceGroupCoverage;
  if (!source.accountHistoryQueryCoverage)
    throw new Error("Yuanta fund history requires the complete account-wide report inventory.");
  const requestedRange = yuantaFundQueryRange(period());
  const startDate = canonicalSourceDate(requestedRange.startDate);
  const endDate = canonicalSourceDate(requestedRange.endDate);
  if (!history?.complete || history.startDate !== startDate || history.endDate !== endDate ||
      startDate > endDate || !coverage)
    throw new Error("Yuanta fund transaction history does not prove the requested full date range.");

  const queryKey = (query: YuantaFundAccountHistoryQuery) => `${query.investmentType}:${query.detail}`;
  const expected = new Set(yuantaFundAccountHistoryQueries.map(queryKey));
  const actual = source.accountHistoryQueryCoverage.map(queryKey);
  if (actual.length !== expected.size || new Set(actual).size !== expected.size || actual.some(key => !expected.has(key)))
    throw new Error("Yuanta fund account history is missing or repeating a required investment-type report.");
  const scopes = new Set(yuantaFundHistoryInvestmentTypes.map(yuantaFundAccountHistoryScope));
  if (coverage.length !== scopes.size || new Set(coverage.map(entry => entry.scopeKey)).size !== scopes.size ||
    coverage.some(entry => !scopes.has(entry.scopeKey) || entry.startDate !== startDate || entry.endDate !== endDate ||
      entry.contractVersion !== YUANTA_FUND_INVESTMENT_CONTRACT_VERSION))
    throw new Error("Yuanta fund account history coverage does not match its complete report inventory.");
  for (const query of yuantaFundAccountHistoryQueries) {
    const queryTables = historicalTables.filter(table => table.historyQuery && queryKey(table.historyQuery) === queryKey(query));
    const labels: readonly string[] = query.detail === "sell" ? fundRedemptionTableLabels
      : query.detail === "deduct" ? [query.investmentType === "type3" ? "variable-deduction-details" : "deduction-details"]
      : [yuantaFundAccountHistoryTableLabels[query.detail]];
    if (queryTables.filter(table => labels.includes(table.tableLabel)).length !== 1 ||
      queryTables.some(table => table.fund !== yuantaFundAccountHistoryKey(query.investmentType) ||
        (fundFinancialHistoryTableLabels.includes(table.tableLabel) && !labels.includes(table.tableLabel))))
      throw new Error("Yuanta fund account history has no unique result for its requested report.");
    assertYuantaFundHistoryQueryResult(queryTables, yuantaFundAccountHistoryKey(query.investmentType));
  }
  if (historicalTables.some(table => !table.historyQuery || !expected.has(queryKey(table.historyQuery)) ||
    !yuantaFundAccountHistoryType(table.fund ?? "")))
    throw new Error("Yuanta fund account history has unqueried evidence.");
  return { transactionHistory: history, occurrenceGroupCoverage: coverage };
}

/** Read the fund pages the input asks for, in order, before anything is built (ADR 0065). */
export async function readYuantaFundSource(
  page: Page,
  input: WorkflowInput,
  context: WorkflowContext,
  product: ProductCollectionHandle,
): Promise<YuantaFundSourceSnapshot> {
  const site = yuantaEbankSite(page, context);
  const sourceText = context.text;
  const dateRange = yuantaFundQueryRange(product.collectionPeriod());
  const historyStartDate = canonicalSourceDate(dateRange.startDate);
  const historyEndDate = canonicalSourceDate(dateRange.endDate);
  const tables: ParsedTable[] = [];
  const occurrenceGroupCoverage: CanonicalOccurrenceGroupCoverage[] = [];
  let positions: FundPosition[] = [];
  const checkCancelled = () => context.signal.throwIfAborted();

  if (input.includePortfolioSummary) {
    checkCancelled();
    await product.reportActivity("query");
    await openPortfolioSummary(site);
    await captureTables(site, tables, "portfolio-summary", null, null, sourceText);
  }

  if (input.includeInvestmentDetails || input.includeHistoricalTransactions) {
    checkCancelled();
    await product.reportActivity("query");
    const overviewScope = await openInvestmentOverview(site);
    positions = await extractFundPositions(site, input.includeHistoricalTransactions);
    if (positions.length === 0 && input.includeHistoricalTransactions) {
      if (!isYuantaFundPositionAbsentText(await site.frames.race(overviewScope.locator("body").innerText())))
        throw new Error("YuanTa empty position inventory has no explicit source absence evidence.");
      tables.push({ category: "investment-source-evidence", fund: null, period: null,
        tableLabel: "current-position-absence", rows: [["無基金部位"]] });
    }
    await captureTables(
      site,
      tables,
      "investment-overview",
      null,
      null,
      sourceText,
    );
    if (positions.length === 0 && !input.includeHistoricalTransactions)
      throw new Error("Could not find matching YuanTa fund positions.");

    for (const position of positions) {
      checkCancelled();
      await product.reportActivity("query");
      await openInvestmentOverview(site);
      await openFundDetail(site, position);
      await captureTables(
        site,
        tables,
        "investment-source-evidence",
        fundPositionKey(position),
        null,
        sourceText,
      );

    }
  }

  if (input.includeHistoricalTransactions) {
    if (input.fundFilters.length)
      throw new Error("YuanTa complete account history cannot use a fund subset filter.");
    for (const query of yuantaFundAccountHistoryQueries) {
      checkCancelled();
      await product.reportActivity("query");
      await queryAccountFundTransactions(site, query, dateRange.startDate, dateRange.endDate);
      const firstTable = tables.length;
      const key = yuantaFundAccountHistoryKey(query.investmentType);
      await captureTables(site, tables, "historical-transactions", key, dateRange.label, sourceText);
      for (const table of tables.slice(firstTable)) table.historyQuery = query;
      assertYuantaFundHistoryQueryResult(tables.slice(firstTable), key);
    }
    for (const type of yuantaFundHistoryInvestmentTypes) occurrenceGroupCoverage.push({
      scopeKey: yuantaFundAccountHistoryScope(type), startDate: historyStartDate, endDate: historyEndDate,
      contractVersion: YUANTA_FUND_INVESTMENT_CONTRACT_VERSION,
    });
    // Closed products may no longer appear in the subscription catalog. Only an
    // exact, independently sourced public association can supplement that catalog.

  }

  if (input.includeOffHourOrders) {
    checkCancelled();
    await product.reportActivity("query");
    await openOffHourOrders(site);
    await product.reportActivity("query");
    await queryOffHourOrders(site, dateRange.startDate, dateRange.endDate);
    await captureTables(
      site,
      tables,
      "offhour-orders",
      null,
      dateRange.label,
      sourceText,
    );
  }

  checkCancelled();
  if (input.includeHistoricalTransactions && occurrenceGroupCoverage.length === 0)
    throw new Error("Yuanta fund history has no queried position buckets to prove complete.");
  return {
    positions,
    tables,
    ...(input.includeHistoricalTransactions
      ? {
          transactionHistory: {
            startDate: historyStartDate,
            endDate: historyEndDate,
            complete: true as const,
          },
          occurrenceGroupCoverage,
          accountHistoryQueryCoverage: yuantaFundAccountHistoryQueries,
        }
      : {}),
  };
}

/** Build and stage the fund investment capture from a read snapshot. */
export async function stageYuantaFund(
  snapshot: YuantaFundSourceSnapshot,
  input: YuantaFundCollectionInput,
  context: WorkflowContext,
  product: ProductCollectionHandle,
): Promise<ProductCollectionSummary> {
  context.signal.throwIfAborted();
  context.text.assertIntact(JSON.stringify(snapshot.tables));

  const items = yuantaFundCanonicalItems(
    input,
    snapshot.positions,
    snapshot.tables,
    validateYuantaFundHistoryProof(snapshot, input, product.collectionPeriod),
    () => context.now(),
  );
  context.signal.throwIfAborted();
  product.stage(...items);
  return {
    sourceCaptureCount: snapshot.tables.length,
    rowCount: snapshot.tables.reduce(
      (count, table) => count + table.rows.length,
      0,
    ),
  };
}

export async function runYuantaFundStatements(
  page: Page,
  input: YuantaFundCollectionInput,
  context: WorkflowContext,
  product: ProductCollectionHandle,
): Promise<ProductCollectionSummary> {
  context.signal.throwIfAborted();
  const snapshot = await readYuantaFundSource(page, input, context, product);
  return await stageYuantaFund(snapshot, input, context, product);
}
