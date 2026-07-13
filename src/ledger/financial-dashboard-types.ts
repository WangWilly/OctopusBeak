export const TYPED_STATEMENT_TABLES = [
  "account_transactions",
  "foreign_currency_transactions",
  "credit_card_statement_lines",
  "loan_transactions",
  "fund_holdings",
  "fund_buy_transactions",
  "fund_redemption_transactions",
  "fund_cash_dividends",
  "fund_conversion_transactions",
  "brokerage_holdings",
  "brokerage_asset_summaries",
  "brokerage_trade_transactions",
  "unsupported_statement_rows",
] as const;

export type RawRecord = Record<string, unknown>;
export type TypedStatementTable = (typeof TYPED_STATEMENT_TABLES)[number];

export type BuildFinancialDashboardInput = {
  ledgerDir: string;
  outputDir: string;
};

export type BatchRecord = RawRecord & {
  importRunId?: string;
  importBatchId: string;
  sourceRelativePath: string;
  sourceFile?: string;
  bank: string;
  product: string;
  rowCount: number;
  importedAt?: string;
  csvLayout?: {
    strategy?: string;
    warnings?: string[];
  };
};

export type ImportRunRecord = RawRecord & {
  importRunId: string;
  startedAt?: string;
  finishedAt?: string;
};

export type RawTransactionOccurrence = RawRecord & {
  statementTable: TypedStatementTable;
  importRunId?: string;
  importBatchId: string;
  sourceHash: string;
  contentHash?: string;
  sourceRelativePath: string;
  sourceRowIndex: number;
  bank: string;
  product: string;
  typedPayload: Record<string, string>;
};

export type NormalizedTransaction = {
  id: string;
  sourceHash: string;
  sourceRelativePath: string;
  sourceRowIndex: number;
  institution: string;
  product: string;
  parserId: string;
  type:
    | "deposit"
    | "foreign_deposit"
    | "loan"
    | "credit_card"
    | "investment"
    | "brokerage";
  accountId: string;
  accountLabel: string;
  currency: string;
  date: string | null;
  occurredAt: string | null;
  description: string;
  status: "posted" | "unbilled" | "payment" | "detail" | "dividend" | "unknown";
  inflow: number | null;
  outflow: number | null;
  amountSigned: number | null;
  balanceAfter: number | null;
  includeInCashFlow: boolean;
  warnings: string[];
};

export type AssetPosition = {
  id: string;
  institution: string;
  product: string;
  parserId: string;
  assetClass:
    | "cash"
    | "foreign_cash"
    | "loan"
    | "credit_card"
    | "fund"
    | "brokerage"
    | "brokerage_rollup";
  accountId: string;
  label: string;
  currency: string;
  value: number;
  valueTwd: number | null;
  valueSign: "asset" | "liability" | "informational";
  includeInTotals: boolean;
  asOfDate: string | null;
  asOfDateTime: string | null;
  sourceRelativePath: string;
  sourceRowIndex: number;
  confidence: "high" | "medium" | "low";
  warnings: string[];
};

export type FinancialTotals = {
  includedByCurrency: Record<
    string,
    {
      assets: number;
      liabilities: number;
      net: number;
    }
  >;
  informationalByCurrency: Record<string, number>;
};

export type SnapshotAccountValue = {
  id: string;
  institution: string;
  product: string;
  assetClass: AssetPosition["assetClass"];
  accountId: string;
  label: string;
  currency: string;
  value: number;
  valueSign: AssetPosition["valueSign"];
  includeInTotals: boolean;
};

export type DailyAccountChange = SnapshotAccountValue & {
  snapshotDate: string;
  signedValue: number;
  previousSnapshotDate: string | null;
  previousValue: number | null;
  previousSignedValue: number | null;
  change: number;
};

export type AssetSnapshot = {
  importRunId: string;
  importedAt: string;
  snapshotDate: string;
  totals: FinancialTotals;
  positionCount: number;
  includedPositionCount: number;
  accounts: SnapshotAccountValue[];
};

export type DailyAssetHistoryPoint = {
  date: string;
  importRunId: string;
  importedAt: string;
  assets: CurrencyBucket;
  liabilities: CurrencyBucket;
  netAssets: CurrencyBucket;
  netChange: CurrencyBucket;
  positionCount: number;
  accountChanges: DailyAccountChange[];
};

export type SnapshotHistory = {
  snapshots: AssetSnapshot[];
  daily: DailyAssetHistoryPoint[];
};

export type Classification = {
  row: RawTransactionOccurrence;
  transactions: NormalizedTransaction[];
  positions: AssetPosition[];
  auditOnlyReason?: string;
  unsupportedReason?: string;
};

export type QualityIssue = {
  level: "info" | "warn" | "error";
  code: string;
  message: string;
  sourceRelativePath?: string;
  sourceRowIndex?: number;
};

export type FinancialModel = {
  schemaVersion: "financial-model.v1";
  generatedAt: string;
  sourceLedgerDir: string;
  sourceLedgerStore: "sqlite";
  counts: {
    normalizedTransactions: number;
    assetPositions: number;
    includedPositions: number;
    duplicateNormalizedTransactions: number;
    assetSnapshots: number;
    auditOnlyRows: number;
    unsupportedRows: number;
  };
  totals: FinancialTotals;
  dashboard: DashboardView;
  parserCoverage: Record<
    string,
    {
      rows: number;
      parsedRows: number;
      auditOnlyRows: number;
      unsupportedRows: number;
      transactions: number;
      positions: number;
    }
  >;
  assetPositions: AssetPosition[];
  normalizedTransactions: NormalizedTransaction[];
  snapshotHistory: SnapshotHistory;
  unsupportedRows: Array<{
    bank: string;
    product: string;
    sourceRelativePath: string;
    sourceRowIndex: number;
    reason: string;
  }>;
  auditOnlyRows: Array<{
    bank: string;
    product: string;
    sourceRelativePath: string;
    sourceRowIndex: number;
    reason: string;
  }>;
  sourceBatches: {
    count: number;
    layoutStrategies: Record<string, number>;
  };
  quality: {
    status: "pass" | "warn" | "fail";
    issues: QualityIssue[];
  };
};

export type CurrencyBucket = Record<string, number>;

export type DashboardMetric = {
  label: string;
  value?: string;
  amounts?: CurrencyBucket;
};

export type DashboardAccount = {
  id: string;
  label: string;
  kind: "account" | "credit_card" | "loan" | "fund" | "brokerage";
  institution: string;
  product: string;
  metrics: DashboardMetric[];
  positionIds: string[];
  transactionIds: string[];
  childAssetIds: string[];
};

export type DashboardInstitution = {
  id: string;
  label: string;
  groups: Array<{
    kind: DashboardAccount["kind"];
    label: string;
    accounts: DashboardAccount[];
  }>;
};

export type DashboardView = {
  overview: {
    assets: {
      totalTwdAssets: CurrencyBucket;
      totalForeignAssets: CurrencyBucket;
      totalInvestmentAssets: CurrencyBucket;
    };
    liabilities: {
      unbilledCreditCardAmount: CurrencyBucket;
      loanTotalBalance: CurrencyBucket;
    };
    netAssets: CurrencyBucket;
  };
  institutions: DashboardInstitution[];
};
