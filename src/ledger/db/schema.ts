import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const commonColumns = () => ({
  statementRowId: text("statement_row_id").primaryKey(),
  sourceFileId: text("source_file_id").notNull(),
  importRunId: text("import_run_id").notNull(),
  sourceRelativePath: text("source_relative_path").notNull(),
  sourceRowIndex: integer("source_row_index").notNull(),
  sourceHash: text("source_hash").notNull(),
  contentHash: text("content_hash").notNull(),
  bank: text("bank").notNull(),
  product: text("product").notNull(),
  rawPayloadJson: text("raw_payload_json").notNull(),
  importedAt: text("imported_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const schemaMigrations = sqliteTable("schema_migrations", {
  version: integer("version").primaryKey(),
  name: text("name").notNull(),
  appliedAt: text("applied_at").notNull(),
});

export const importRuns = sqliteTable("import_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  importRunId: text("import_run_id").notNull(),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  recordJson: text("record_json").notNull(),
});

export const sourceFiles = sqliteTable("source_files", {
  sourceFileId: text("source_file_id").primaryKey(),
  importRunId: text("import_run_id").notNull(),
  sourceFile: text("source_file"),
  sourceRelativePath: text("source_relative_path").notNull(),
  sourceFileHash: text("source_file_hash").notNull(),
  sourceFileBytes: integer("source_file_bytes").notNull(),
  sourceFileModifiedAt: text("source_file_modified_at"),
  importedAt: text("imported_at").notNull(),
  bank: text("bank").notNull(),
  product: text("product").notNull(),
  rowCount: integer("row_count").notNull(),
  status: text("status").notNull(),
  recordJson: text("record_json").notNull(),
});

export const sourceFileImports = sqliteTable("source_file_imports", {
  sourceFileId: text("source_file_id").notNull(),
  importRunId: text("import_run_id").notNull(),
  sourceRelativePath: text("source_relative_path").notNull(),
  sourceFileHash: text("source_file_hash").notNull(),
  sourceFileBytes: integer("source_file_bytes").notNull(),
  sourceFileModifiedAt: text("source_file_modified_at"),
  importedAt: text("imported_at").notNull(),
  bank: text("bank").notNull(),
  product: text("product").notNull(),
  rowCount: integer("row_count").notNull(),
  status: text("status").notNull(),
  recordJson: text("record_json").notNull(),
}, (table) => [primaryKey({ columns: [table.sourceFileId, table.importRunId] })]);

export const dataIssues = sqliteTable("data_issues", {
  dataIssueId: text("data_issue_id").primaryKey(),
  accountId: text("account_id").notNull(),
  accountLabel: text("account_label").notNull(),
  accountContextJson: text("account_context_json").notNull(),
  fieldKey: text("field_key").notNull(),
  reportedValue: real("reported_value").notNull(),
  currency: text("currency").notNull(),
  dataDate: text("data_date"),
  note: text("note").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [check("ck_data_issues_status", sql`${table.status} IN ('pending','investigating','resolved','restored')`)]);

export const disabledImportSources = sqliteTable("disabled_import_sources", {
  disabledImportSourceId: text("disabled_import_source_id").primaryKey(),
  dataIssueId: text("data_issue_id").notNull(),
  sourceFileId: text("source_file_id").notNull(),
  importRunId: text("import_run_id").notNull(),
  reason: text("reason").notNull(),
  state: text("state").notNull(),
  disabledAt: text("disabled_at").notNull(),
  restoredAt: text("restored_at"),
  previewToken: text("preview_token").notNull(),
}, (table) => [
  uniqueIndex("uq_disabled_import_source_scope").on(table.sourceFileId, table.importRunId),
  check("ck_disabled_import_sources_state", sql`${table.state} IN ('active','restored')`),
]);

export const dataIssueEvents = sqliteTable("data_issue_events", {
  dataIssueEventId: text("data_issue_event_id").primaryKey(),
  dataIssueId: text("data_issue_id").notNull(),
  eventType: text("event_type").notNull(),
  stage: text("stage").notNull(),
  outcome: text("outcome").notNull(),
  summary: text("summary").notNull(),
  detailsJson: text("details_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("idx_data_issue_events_case_time").on(table.dataIssueId, table.createdAt),
  check("ck_data_issue_events_outcome", sql`${table.outcome} IN ('succeeded','blocked','failed')`),
]);

export const accountTransactions = sqliteTable("account_transactions", {
  ...commonColumns(),
  accountName: text("account_name"),
  accountNumber: text("account_number"),
  currency: text("currency").notNull(),
  accountingDate: text("accounting_date"),
  transactionDate: text("transaction_date"),
  transactionTime: text("transaction_time"),
  transactionAtUtc: text("transaction_at_utc"),
  description: text("description"),
  withdrawalAmount: real("withdrawal_amount"),
  depositAmount: real("deposit_amount"),
  balanceAfter: real("balance_after"),
  note: text("note"),
  fxRate: real("fx_rate"),
});

export const foreignCurrencyTransactions = sqliteTable("foreign_currency_transactions", {
  ...commonColumns(),
  accountName: text("account_name"),
  accountNumber: text("account_number"),
  queryCurrency: text("query_currency"),
  currency: text("currency").notNull(),
  accountingDate: text("accounting_date"),
  transactionDate: text("transaction_date"),
  transactionTime: text("transaction_time"),
  transactionAtUtc: text("transaction_at_utc"),
  description: text("description"),
  withdrawalAmount: real("withdrawal_amount"),
  depositAmount: real("deposit_amount"),
  balanceAfter: real("balance_after"),
  note: text("note"),
  fxRate: real("fx_rate"),
});

export const creditCardStatementLines = sqliteTable("credit_card_statement_lines", {
  ...commonColumns(),
  semanticKey: text("semantic_key"),
  contentKey: text("content_key"),
  occurrenceIndex: integer("occurrence_index"),
  firstSeenAt: text("first_seen_at"),
  lastSeenAt: text("last_seen_at"),
  statementType: text("statement_type").notNull(),
  statementPeriod: text("statement_period"),
  cardNumber: text("card_number"),
  cardLabel: text("card_label"),
  consumeDate: text("consume_date"),
  postingDate: text("posting_date"),
  description: text("description"),
  countryCurrency: text("country_currency"),
  foreignExchangeDate: text("foreign_exchange_date"),
  foreignCurrency: text("foreign_currency"),
  foreignAmount: real("foreign_amount"),
  twdAmount: real("twd_amount"),
  installmentAction: text("installment_action"),
  paymentStatus: text("payment_status"),
}, (table) => [
  uniqueIndex("uq_credit_card_statement_lines_content_occurrence")
    .on(table.contentKey, table.occurrenceIndex)
    .where(sql`${table.contentKey} IS NOT NULL AND ${table.occurrenceIndex} IS NOT NULL`),
]);

export const creditCardCaptures = sqliteTable("credit_card_captures", {
  captureId: text("capture_id").primaryKey(),
  bank: text("bank").notNull(),
  product: text("product").notNull(),
  capturedAt: text("captured_at").notNull(),
  completenessJson: text("completeness_json").notNull(),
});

export const creditCardCaptureEntries = sqliteTable("credit_card_capture_entries", {
  captureId: text("capture_id").notNull(),
  statementRowId: text("statement_row_id").notNull(),
  sourceFileId: text("source_file_id").notNull(),
  sourceRowIndex: integer("source_row_index").notNull(),
  bank: text("bank").notNull(),
  product: text("product").notNull(),
  cardKey: text("card_key").notNull(),
  statementType: text("statement_type").notNull(),
}, (table) => [
  primaryKey({ columns: [table.captureId, table.sourceFileId, table.sourceRowIndex] }),
  index("idx_credit_card_capture_entries_latest").on(
    table.bank,
    table.product,
    table.cardKey,
    table.captureId,
    table.statementType,
  ),
  check("ck_credit_card_capture_entries_statement_type", sql`${table.statementType} IN ('billed','unbilled')`),
]);

export const creditCardSnapshots = sqliteTable("credit_card_snapshots", {
  snapshotId: text("snapshot_id").primaryKey(),
  captureId: text("capture_id"),
  sourceFileId: text("source_file_id").notNull(),
  bank: text("bank").notNull(),
  product: text("product").notNull(),
  cardKey: text("card_key").notNull(),
  statementType: text("statement_type").notNull(),
  capturedAt: text("captured_at").notNull(),
  asOfDate: text("as_of_date").notNull(),
  currency: text("currency").notNull(),
  transactionCount: integer("transaction_count").notNull(),
  totalAmount: real("total_amount").notNull(),
}, (table) => [
  uniqueIndex("uq_credit_card_snapshots_source_card_type").on(
    table.sourceFileId,
    table.cardKey,
    table.statementType,
    table.asOfDate,
  ),
  index("idx_credit_card_snapshots_card_day").on(
    table.cardKey,
    table.statementType,
    table.asOfDate,
    table.capturedAt,
  ),
  check("ck_credit_card_snapshots_transaction_count", sql`${table.transactionCount} >= 0`),
  check("ck_credit_card_snapshots_statement_type", sql`${table.statementType} IN ('billed','unbilled')`),
]);

export const loanTransactions = sqliteTable("loan_transactions", {
  ...commonColumns(),
  accountNumber: text("account_number"),
  tradeDate: text("trade_date"),
  postingDate: text("posting_date"),
  item: text("item"),
  interestStartDate: text("interest_start_date"),
  interestEndDate: text("interest_end_date"),
  amount: real("amount"),
  interestRate: text("interest_rate"),
  balanceAfter: real("balance_after"),
  overpayment: real("overpayment"),
  note: text("note"),
});

export const fundHoldings = sqliteTable("fund_holdings", {
  ...commonColumns(),
  dataType: text("data_type"),
  fundId: text("fund_id"),
  queryPeriod: text("query_period"),
  fundName: text("fund_name"),
  fundType: text("fund_type"),
  currency: text("currency"),
  investmentAmount: real("investment_amount"),
  marketValueWithoutDividend: real("market_value_without_dividend"),
  unrealizedPnlWithoutDividend: real("unrealized_pnl_without_dividend"),
  returnRateWithoutDividend: text("return_rate_without_dividend"),
  unrealizedPnlWithDividend: real("unrealized_pnl_with_dividend"),
  returnRateWithDividend: text("return_rate_with_dividend"),
  holdingStatus: text("holding_status"),
});

export const fundBuyTransactions = sqliteTable("fund_buy_transactions", {
  ...commonColumns(),
  fundId: text("fund_id"),
  investmentDate: text("investment_date"),
  fundName: text("fund_name"),
  transactionNumber: text("transaction_number"),
  currency: text("currency"),
  investmentAmount: real("investment_amount"),
  subscriptionFee: real("subscription_fee"),
  subscriptionFeeCurrency: text("subscription_fee_currency"),
  subscribedUnits: real("subscribed_units"),
});

export const fundRedemptionTransactions = sqliteTable("fund_redemption_transactions", {
  ...commonColumns(),
  fundId: text("fund_id"),
  redemptionDate: text("redemption_date"),
  fundName: text("fund_name"),
  transactionNumber: text("transaction_number"),
  redemptionInvestmentAmount: real("redemption_investment_amount"),
  redemptionUnits: real("redemption_units"),
  netDepositAmount: real("net_deposit_amount"),
  referencePnl: real("reference_pnl"),
  note: text("note"),
});

export const fundCashDividends = sqliteTable("fund_cash_dividends", {
  ...commonColumns(),
  fundId: text("fund_id"),
  depositDate: text("deposit_date"),
  fundName: text("fund_name"),
  transactionNumber: text("transaction_number"),
  currency: text("currency"),
  distributionAmount: real("distribution_amount"),
  distributionCurrency: text("distribution_currency"),
  fxRate: real("fx_rate"),
});

export const fundConversionTransactions = sqliteTable("fund_conversion_transactions", {
  ...commonColumns(),
  queryPeriod: text("query_period"),
  conversionOutDate: text("conversion_out_date"),
  conversionInDate: text("conversion_in_date"),
  transactionNumber: text("transaction_number"),
  fromFundName: text("from_fund_name"),
  toFundName: text("to_fund_name"),
  conversionInvestmentAmount: real("conversion_investment_amount"),
});

export const brokerageHoldings = sqliteTable("brokerage_holdings", {
  ...commonColumns(),
  asOfDate: text("as_of_date"),
  accountNumber: text("account_number"),
  assetType: text("asset_type"),
  subCategory: text("sub_category"),
  productCode: text("product_code"),
  productName: text("product_name"),
  currency: text("currency"),
  quantity: real("quantity"),
  marketDate: text("market_date"),
  marketPrice: real("market_price"),
  marketValueOriginal: real("market_value_original"),
  marketValueTwd: real("market_value_twd"),
  costPrice: real("cost_price"),
  costAmount: real("cost_amount"),
  unrealizedPnlOriginal: real("unrealized_pnl_original"),
  unrealizedPnlTwd: real("unrealized_pnl_twd"),
  returnRate: text("return_rate"),
  fxRate: real("fx_rate"),
});

export const brokerageTradeTransactions = sqliteTable("brokerage_trade_transactions", {
  ...commonColumns(),
  tradeDate: text("trade_date"),
  accountNumber: text("account_number"),
  assetType: text("asset_type"),
  tradeType: text("trade_type"),
  subCategory: text("sub_category"),
  productCode: text("product_code"),
  productName: text("product_name"),
  currency: text("currency"),
  action: text("action"),
  quantity: real("quantity"),
  price: real("price"),
  grossAmount: real("gross_amount"),
  fee: real("fee"),
  tax: real("tax"),
  settlementAmount: real("settlement_amount"),
  settlementCurrency: text("settlement_currency"),
  realizedPnl: real("realized_pnl"),
  costAmount: real("cost_amount"),
});

export const maicoinSyncRuns = sqliteTable("maicoin_sync_runs", {
  syncRunId: text("sync_run_id").primaryKey(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  subAccount: text("sub_account").notNull(),
  walletTypesJson: text("wallet_types_json").notNull(),
  statementEnabled: integer("statement_enabled").notNull(),
  statementLimit: integer("statement_limit").notNull(),
  recordJson: text("record_json").notNull(),
});

export const maicoinAccountSnapshots = sqliteTable("maicoin_account_snapshots", {
  snapshotId: text("snapshot_id").primaryKey(),
  syncRunId: text("sync_run_id").notNull(),
  capturedAt: text("captured_at").notNull(),
  subAccount: text("sub_account").notNull(),
  walletType: text("wallet_type").notNull(),
  currency: text("currency").notNull(),
  balance: real("balance").notNull(),
  locked: real("locked").notNull(),
  staked: real("staked"),
  principal: real("principal"),
  interest: real("interest"),
  totalQuantity: real("total_quantity").notNull(),
  priceMarket: text("price_market"),
  priceCurrency: text("price_currency"),
  price: real("price"),
  valueTwd: real("value_twd"),
  priceAt: text("price_at"),
  rawAccountJson: text("raw_account_json").notNull(),
  rawPriceJson: text("raw_price_json"),
  createdAt: text("created_at").notNull(),
});

export const maicoinStatementRows = sqliteTable("maicoin_statement_rows", {
  statementId: text("statement_id").primaryKey(),
  syncRunId: text("sync_run_id").notNull(),
  capturedAt: text("captured_at").notNull(),
  endpoint: text("endpoint").notNull(),
  walletType: text("wallet_type"),
  rowType: text("row_type").notNull(),
  externalId: text("external_id").notNull(),
  occurredAt: text("occurred_at"),
  currency: text("currency"),
  amount: real("amount"),
  fee: real("fee"),
  feeCurrency: text("fee_currency"),
  market: text("market"),
  side: text("side"),
  price: real("price"),
  valueTwd: real("value_twd"),
  rawPayloadJson: text("raw_payload_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const automationTaskRuns = sqliteTable("automation_task_runs", {
  taskRunId: text("task_run_id").primaryKey(),
  taskId: text("task_id").notNull(),
  script: text("script").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  attempt: integer("attempt").notNull(),
  maxAttempts: integer("max_attempts").notNull(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  exitCode: integer("exit_code"),
  signal: text("signal"),
  errorMessage: text("error_message"),
  logPath: text("log_path").notNull(),
  logTail: text("log_tail").notNull(),
  recordJson: text("record_json").notNull(),
});

export const exchangeRates = sqliteTable("exchange_rates", {
  rateDate: text("rate_date").notNull(),
  currency: text("currency").notNull(),
  twdPerUnit: real("twd_per_unit").notNull(),
  source: text("source").notNull(),
  fetchedAt: text("fetched_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.rateDate, table.currency] }),
  index("idx_exchange_rates_currency_date").on(table.currency, table.rateDate),
  check("ck_exchange_rates_twd_per_unit", sql`${table.twdPerUnit} > 0`),
]);
