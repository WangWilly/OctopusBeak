import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  BatchRecord,
  ImportRunRecord,
  RawRecord,
  RawTransactionOccurrence,
  TypedStatementTable,
} from "./financial-dashboard-types.ts";

const SQLITE_LEDGER_FILE = "ledger.sqlite";
type LedgerDatabase = InstanceType<typeof DatabaseSync>;
type ColumnKind = "text" | "number";
type ColumnSpec = Readonly<Record<string, ColumnKind>>;

function readSqliteRecords<T>(db: LedgerDatabase, table: string): T[] {
  if (table !== "import_runs") {
    throw new Error(`Unsupported ledger SQLite table: ${table}`);
  }

  const rows = db
    .prepare(`SELECT record_json FROM ${table} ORDER BY id`)
    .all() as Array<{ record_json: string }>;
  return rows.map((row) => JSON.parse(row.record_json) as T);
}

function sqliteTableExists(db: LedgerDatabase, table: string): boolean {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    )
    .get(table);
  return Boolean(row);
}

function textColumn(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return value === null || value === undefined ? "" : String(value).trim();
}

function numberColumn(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function payloadFromSchema(
  row: Record<string, unknown>,
  columns: ColumnSpec,
): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const [key, kind] of Object.entries(columns)) {
    const value = kind === "number" ? numberColumn(row, key) : textColumn(row, key);
    if (value !== null && value !== "") payload[key] = String(value);
  }
  return payload;
}

function assignSchemaColumns<T extends object>(
  target: T,
  row: Record<string, unknown>,
  columns: ColumnSpec,
) {
  for (const [key, kind] of Object.entries(columns)) {
    Object.assign(target, {
      [key]: kind === "number" ? numberColumn(row, key) : textColumn(row, key),
    });
  }
}

export abstract class TypedStatementRow<T extends TypedStatementTable>
  implements RawTransactionOccurrence
{
  [key: string]: unknown;

  readonly statementTable: T;
  readonly importRunId: string;
  readonly importBatchId: string;
  readonly sourceHash: string;
  readonly rawRowHash: string;
  readonly contentHash: string;
  readonly sourceRelativePath: string;
  readonly sourceRowIndex: number;
  readonly bank: string;
  readonly product: string;
  readonly dedupeStatus: "unique" | "duplicate";
  readonly typedPayload: Record<string, string>;

  protected constructor(
    row: Record<string, unknown>,
    table: T,
    columns: ColumnSpec,
  ) {
    this.statementTable = table;
    this.importRunId = textColumn(row, "import_run_id");
    this.importBatchId = textColumn(row, "source_file_id");
    this.sourceHash = textColumn(row, "source_hash");
    this.rawRowHash = textColumn(row, "raw_row_hash");
    this.contentHash = textColumn(row, "content_hash");
    this.sourceRelativePath = textColumn(row, "source_relative_path");
    this.sourceRowIndex = numberColumn(row, "source_row_index") ?? 0;
    this.bank = textColumn(row, "bank");
    this.product = textColumn(row, "product");
    this.dedupeStatus =
      textColumn(row, "dedupe_status") === "duplicate" ? "duplicate" : "unique";
    this.typedPayload = payloadFromSchema(row, columns);
  }
}

const ACCOUNT_TRANSACTION_COLUMNS = {
  account_name: "text",
  account_number: "text",
  currency: "text",
  accounting_date: "text",
  transaction_date: "text",
  transaction_time: "text",
  description: "text",
  withdrawal_amount: "number",
  deposit_amount: "number",
  balance_after: "number",
  note: "text",
  fx_rate: "number",
} as const satisfies ColumnSpec;

export class AccountTransactionRow extends TypedStatementRow<"account_transactions"> {
  declare account_name: string;
  declare account_number: string;
  declare currency: string;
  declare accounting_date: string;
  declare transaction_date: string;
  declare transaction_time: string;
  declare description: string;
  declare withdrawal_amount: number | null;
  declare deposit_amount: number | null;
  declare balance_after: number | null;
  declare note: string;
  declare fx_rate: number | null;

  constructor(row: Record<string, unknown>) {
    super(row, "account_transactions", ACCOUNT_TRANSACTION_COLUMNS);
    assignSchemaColumns(this, row, ACCOUNT_TRANSACTION_COLUMNS);
  }
}

const FOREIGN_CURRENCY_TRANSACTION_COLUMNS = {
  account_name: "text",
  account_number: "text",
  query_currency: "text",
  currency: "text",
  accounting_date: "text",
  transaction_date: "text",
  transaction_time: "text",
  description: "text",
  withdrawal_amount: "number",
  deposit_amount: "number",
  balance_after: "number",
  note: "text",
  fx_rate: "number",
} as const satisfies ColumnSpec;

export class ForeignCurrencyTransactionRow extends TypedStatementRow<"foreign_currency_transactions"> {
  declare account_name: string;
  declare account_number: string;
  declare query_currency: string;
  declare currency: string;
  declare accounting_date: string;
  declare transaction_date: string;
  declare transaction_time: string;
  declare description: string;
  declare withdrawal_amount: number | null;
  declare deposit_amount: number | null;
  declare balance_after: number | null;
  declare note: string;
  declare fx_rate: number | null;

  constructor(row: Record<string, unknown>) {
    super(row, "foreign_currency_transactions", FOREIGN_CURRENCY_TRANSACTION_COLUMNS);
    assignSchemaColumns(this, row, FOREIGN_CURRENCY_TRANSACTION_COLUMNS);
  }
}

const CREDIT_CARD_STATEMENT_LINE_COLUMNS = {
  statement_type: "text",
  statement_period: "text",
  card_number: "text",
  card_label: "text",
  consume_date: "text",
  posting_date: "text",
  description: "text",
  country_currency: "text",
  foreign_exchange_date: "text",
  foreign_currency: "text",
  foreign_amount: "number",
  twd_amount: "number",
  installment_action: "text",
  payment_status: "text",
} as const satisfies ColumnSpec;

export class CreditCardStatementLineRow extends TypedStatementRow<"credit_card_statement_lines"> {
  declare statement_type: string;
  declare statement_period: string;
  declare card_number: string;
  declare card_label: string;
  declare consume_date: string;
  declare posting_date: string;
  declare description: string;
  declare country_currency: string;
  declare foreign_exchange_date: string;
  declare foreign_currency: string;
  declare foreign_amount: number | null;
  declare twd_amount: number | null;
  declare installment_action: string;
  declare payment_status: string;

  constructor(row: Record<string, unknown>) {
    super(row, "credit_card_statement_lines", CREDIT_CARD_STATEMENT_LINE_COLUMNS);
    assignSchemaColumns(this, row, CREDIT_CARD_STATEMENT_LINE_COLUMNS);
  }
}

const LOAN_TRANSACTION_COLUMNS = {
  account_number: "text",
  trade_date: "text",
  posting_date: "text",
  item: "text",
  interest_start_date: "text",
  interest_end_date: "text",
  amount: "number",
  interest_rate: "text",
  balance_after: "number",
  overpayment: "number",
  note: "text",
} as const satisfies ColumnSpec;

export class LoanTransactionRow extends TypedStatementRow<"loan_transactions"> {
  declare account_number: string;
  declare trade_date: string;
  declare posting_date: string;
  declare item: string;
  declare interest_start_date: string;
  declare interest_end_date: string;
  declare amount: number | null;
  declare interest_rate: string;
  declare balance_after: number | null;
  declare overpayment: number | null;
  declare note: string;

  constructor(row: Record<string, unknown>) {
    super(row, "loan_transactions", LOAN_TRANSACTION_COLUMNS);
    assignSchemaColumns(this, row, LOAN_TRANSACTION_COLUMNS);
  }
}

const FUND_HOLDING_COLUMNS = {
  data_type: "text",
  fund_id: "text",
  query_period: "text",
  fund_name: "text",
  fund_type: "text",
  currency: "text",
  investment_amount: "number",
  market_value_without_dividend: "number",
  unrealized_pnl_without_dividend: "number",
  return_rate_without_dividend: "text",
  unrealized_pnl_with_dividend: "number",
  return_rate_with_dividend: "text",
  holding_status: "text",
} as const satisfies ColumnSpec;

export class FundHoldingRow extends TypedStatementRow<"fund_holdings"> {
  declare data_type: string;
  declare fund_id: string;
  declare query_period: string;
  declare fund_name: string;
  declare fund_type: string;
  declare currency: string;
  declare investment_amount: number | null;
  declare market_value_without_dividend: number | null;
  declare unrealized_pnl_without_dividend: number | null;
  declare return_rate_without_dividend: string;
  declare unrealized_pnl_with_dividend: number | null;
  declare return_rate_with_dividend: string;
  declare holding_status: string;

  constructor(row: Record<string, unknown>) {
    super(row, "fund_holdings", FUND_HOLDING_COLUMNS);
    assignSchemaColumns(this, row, FUND_HOLDING_COLUMNS);
  }
}

const FUND_BUY_TRANSACTION_COLUMNS = {
  data_type: "text",
  fund_id: "text",
  query_period: "text",
  investment_date: "text",
  fund_name: "text",
  transaction_number: "text",
  currency: "text",
  investment_amount: "number",
  subscription_fx_rate: "number",
  subscription_nav: "number",
  subscription_fee: "number",
  subscription_fee_currency: "text",
  point_discount: "number",
  subscribed_units: "number",
} as const satisfies ColumnSpec;

export class FundBuyTransactionRow extends TypedStatementRow<"fund_buy_transactions"> {
  declare data_type: string;
  declare fund_id: string;
  declare query_period: string;
  declare investment_date: string;
  declare fund_name: string;
  declare transaction_number: string;
  declare currency: string;
  declare investment_amount: number | null;
  declare subscription_fx_rate: number | null;
  declare subscription_nav: number | null;
  declare subscription_fee: number | null;
  declare subscription_fee_currency: string;
  declare point_discount: number | null;
  declare subscribed_units: number | null;

  constructor(row: Record<string, unknown>) {
    super(row, "fund_buy_transactions", FUND_BUY_TRANSACTION_COLUMNS);
    assignSchemaColumns(this, row, FUND_BUY_TRANSACTION_COLUMNS);
  }
}

const FUND_REDEMPTION_TRANSACTION_COLUMNS = {
  data_type: "text",
  fund_id: "text",
  query_period: "text",
  redemption_date: "text",
  distribution_date: "text",
  fund_name: "text",
  transaction_number: "text",
  redemption_investment_amount: "number",
  redemption_units: "number",
  redemption_price: "number",
  redemption_fx_rate: "number",
  trust_management_fee: "number",
  short_term_fee: "number",
  deferred_fee: "number",
  deposit_account: "text",
  net_deposit_amount: "number",
  reference_pnl: "number",
  reference_return_rate: "text",
  note: "text",
} as const satisfies ColumnSpec;

export class FundRedemptionTransactionRow extends TypedStatementRow<"fund_redemption_transactions"> {
  declare data_type: string;
  declare fund_id: string;
  declare query_period: string;
  declare redemption_date: string;
  declare distribution_date: string;
  declare fund_name: string;
  declare transaction_number: string;
  declare redemption_investment_amount: number | null;
  declare redemption_units: number | null;
  declare redemption_price: number | null;
  declare redemption_fx_rate: number | null;
  declare trust_management_fee: number | null;
  declare short_term_fee: number | null;
  declare deferred_fee: number | null;
  declare deposit_account: string;
  declare net_deposit_amount: number | null;
  declare reference_pnl: number | null;
  declare reference_return_rate: string;
  declare note: string;

  constructor(row: Record<string, unknown>) {
    super(row, "fund_redemption_transactions", FUND_REDEMPTION_TRANSACTION_COLUMNS);
    assignSchemaColumns(this, row, FUND_REDEMPTION_TRANSACTION_COLUMNS);
  }
}

const FUND_CASH_DIVIDEND_COLUMNS = {
  data_type: "text",
  fund_id: "text",
  query_period: "text",
  deposit_date: "text",
  fund_name: "text",
  transaction_number: "text",
  benchmark_date: "text",
  currency: "text",
  benchmark_units: "number",
  distribution_amount: "number",
  distribution_currency: "text",
  fx_rate: "number",
  distribution_rate: "text",
  deposit_account: "text",
} as const satisfies ColumnSpec;

export class FundCashDividendRow extends TypedStatementRow<"fund_cash_dividends"> {
  declare data_type: string;
  declare fund_id: string;
  declare query_period: string;
  declare deposit_date: string;
  declare fund_name: string;
  declare transaction_number: string;
  declare benchmark_date: string;
  declare currency: string;
  declare benchmark_units: number | null;
  declare distribution_amount: number | null;
  declare distribution_currency: string;
  declare fx_rate: number | null;
  declare distribution_rate: string;
  declare deposit_account: string;

  constructor(row: Record<string, unknown>) {
    super(row, "fund_cash_dividends", FUND_CASH_DIVIDEND_COLUMNS);
    assignSchemaColumns(this, row, FUND_CASH_DIVIDEND_COLUMNS);
  }
}

const FUND_CONVERSION_TRANSACTION_COLUMNS = {
  data_type: "text",
  fund_id: "text",
  query_period: "text",
  conversion_out_date: "text",
  conversion_in_date: "text",
  transaction_number: "text",
  from_fund_name: "text",
  to_fund_name: "text",
  conversion_investment_amount: "number",
  from_units: "number",
  to_units: "number",
  from_nav: "number",
  to_nav: "number",
  conversion_fx_rate: "number",
  short_term_fee: "number",
  bank_conversion_fee: "number",
  fund_company_conversion_fee: "number",
} as const satisfies ColumnSpec;

export class FundConversionTransactionRow extends TypedStatementRow<"fund_conversion_transactions"> {
  declare data_type: string;
  declare fund_id: string;
  declare query_period: string;
  declare conversion_out_date: string;
  declare conversion_in_date: string;
  declare transaction_number: string;
  declare from_fund_name: string;
  declare to_fund_name: string;
  declare conversion_investment_amount: number | null;
  declare from_units: number | null;
  declare to_units: number | null;
  declare from_nav: number | null;
  declare to_nav: number | null;
  declare conversion_fx_rate: number | null;
  declare short_term_fee: number | null;
  declare bank_conversion_fee: number | null;
  declare fund_company_conversion_fee: number | null;

  constructor(row: Record<string, unknown>) {
    super(row, "fund_conversion_transactions", FUND_CONVERSION_TRANSACTION_COLUMNS);
    assignSchemaColumns(this, row, FUND_CONVERSION_TRANSACTION_COLUMNS);
  }
}

const BROKERAGE_HOLDING_COLUMNS = {
  as_of_date: "text",
  account_number: "text",
  asset_type: "text",
  sub_category: "text",
  product_code: "text",
  product_name: "text",
  currency: "text",
  quantity: "number",
  market_date: "text",
  market_price: "number",
  market_value_original: "number",
  market_value_twd: "number",
  cost_price: "number",
  cost_amount: "number",
  unrealized_pnl_original: "number",
  unrealized_pnl_twd: "number",
  return_rate: "text",
  fx_rate: "number",
} as const satisfies ColumnSpec;

export class BrokerageHoldingRow extends TypedStatementRow<"brokerage_holdings"> {
  declare as_of_date: string;
  declare account_number: string;
  declare asset_type: string;
  declare sub_category: string;
  declare product_code: string;
  declare product_name: string;
  declare currency: string;
  declare quantity: number | null;
  declare market_date: string;
  declare market_price: number | null;
  declare market_value_original: number | null;
  declare market_value_twd: number | null;
  declare cost_price: number | null;
  declare cost_amount: number | null;
  declare unrealized_pnl_original: number | null;
  declare unrealized_pnl_twd: number | null;
  declare return_rate: string;
  declare fx_rate: number | null;

  constructor(row: Record<string, unknown>) {
    super(row, "brokerage_holdings", BROKERAGE_HOLDING_COLUMNS);
    assignSchemaColumns(this, row, BROKERAGE_HOLDING_COLUMNS);
  }
}

const BROKERAGE_ASSET_SUMMARY_COLUMNS = {
  as_of_date: "text",
  asset_type: "text",
  asset_name: "text",
  asset_value_twd: "number",
  unrealized_pnl_twd: "number",
} as const satisfies ColumnSpec;

export class BrokerageAssetSummaryRow extends TypedStatementRow<"brokerage_asset_summaries"> {
  declare as_of_date: string;
  declare asset_type: string;
  declare asset_name: string;
  declare asset_value_twd: number | null;
  declare unrealized_pnl_twd: number | null;

  constructor(row: Record<string, unknown>) {
    super(row, "brokerage_asset_summaries", BROKERAGE_ASSET_SUMMARY_COLUMNS);
    assignSchemaColumns(this, row, BROKERAGE_ASSET_SUMMARY_COLUMNS);
  }
}

const BROKERAGE_TRADE_TRANSACTION_COLUMNS = {
  trade_date: "text",
  account_number: "text",
  asset_type: "text",
  trade_type: "text",
  sub_category: "text",
  product_code: "text",
  product_name: "text",
  currency: "text",
  action: "text",
  quantity: "number",
  price: "number",
  gross_amount: "number",
  fee: "number",
  tax: "number",
  settlement_amount: "number",
  settlement_currency: "text",
  realized_pnl: "number",
  cost_amount: "number",
} as const satisfies ColumnSpec;

export class BrokerageTradeTransactionRow extends TypedStatementRow<"brokerage_trade_transactions"> {
  declare trade_date: string;
  declare account_number: string;
  declare asset_type: string;
  declare trade_type: string;
  declare sub_category: string;
  declare product_code: string;
  declare product_name: string;
  declare currency: string;
  declare action: string;
  declare quantity: number | null;
  declare price: number | null;
  declare gross_amount: number | null;
  declare fee: number | null;
  declare tax: number | null;
  declare settlement_amount: number | null;
  declare settlement_currency: string;
  declare realized_pnl: number | null;
  declare cost_amount: number | null;

  constructor(row: Record<string, unknown>) {
    super(row, "brokerage_trade_transactions", BROKERAGE_TRADE_TRANSACTION_COLUMNS);
    assignSchemaColumns(this, row, BROKERAGE_TRADE_TRANSACTION_COLUMNS);
  }
}

const UNSUPPORTED_STATEMENT_ROW_COLUMNS = {
  reason: "text",
  headers_json: "text",
} as const satisfies ColumnSpec;

export class UnsupportedStatementRow extends TypedStatementRow<"unsupported_statement_rows"> {
  declare reason: string;
  declare headers_json: string;

  constructor(row: Record<string, unknown>) {
    super(row, "unsupported_statement_rows", UNSUPPORTED_STATEMENT_ROW_COLUMNS);
    assignSchemaColumns(this, row, UNSUPPORTED_STATEMENT_ROW_COLUMNS);
  }
}

abstract class TypedTableRepo<T extends TypedStatementRow<TypedStatementTable>> {
  private readonly db: LedgerDatabase;
  private readonly table: TypedStatementTable;
  private readonly createRow: (row: Record<string, unknown>) => T;

  protected constructor(
    db: LedgerDatabase,
    table: TypedStatementTable,
    createRow: (row: Record<string, unknown>) => T,
  ) {
    this.db = db;
    this.table = table;
    this.createRow = createRow;
  }

  all(): T[] {
    if (!sqliteTableExists(this.db, this.table)) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM ${this.table}
         ORDER BY imported_at, source_relative_path, source_row_index`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(this.createRow);
  }
}

export class AccountTransactionsRepo extends TypedTableRepo<AccountTransactionRow> {
  constructor(db: LedgerDatabase) {
    super(db, "account_transactions", (row) => new AccountTransactionRow(row));
  }
}

export class ForeignCurrencyTransactionsRepo extends TypedTableRepo<ForeignCurrencyTransactionRow> {
  constructor(db: LedgerDatabase) {
    super(db, "foreign_currency_transactions", (row) => new ForeignCurrencyTransactionRow(row));
  }
}

export class CreditCardStatementLinesRepo extends TypedTableRepo<CreditCardStatementLineRow> {
  constructor(db: LedgerDatabase) {
    super(db, "credit_card_statement_lines", (row) => new CreditCardStatementLineRow(row));
  }
}

export class LoanTransactionsRepo extends TypedTableRepo<LoanTransactionRow> {
  constructor(db: LedgerDatabase) {
    super(db, "loan_transactions", (row) => new LoanTransactionRow(row));
  }
}

export class FundHoldingsRepo extends TypedTableRepo<FundHoldingRow> {
  constructor(db: LedgerDatabase) {
    super(db, "fund_holdings", (row) => new FundHoldingRow(row));
  }
}

export class FundBuyTransactionsRepo extends TypedTableRepo<FundBuyTransactionRow> {
  constructor(db: LedgerDatabase) {
    super(db, "fund_buy_transactions", (row) => new FundBuyTransactionRow(row));
  }
}

export class FundRedemptionTransactionsRepo extends TypedTableRepo<FundRedemptionTransactionRow> {
  constructor(db: LedgerDatabase) {
    super(db, "fund_redemption_transactions", (row) => new FundRedemptionTransactionRow(row));
  }
}

export class FundCashDividendsRepo extends TypedTableRepo<FundCashDividendRow> {
  constructor(db: LedgerDatabase) {
    super(db, "fund_cash_dividends", (row) => new FundCashDividendRow(row));
  }
}

export class FundConversionTransactionsRepo extends TypedTableRepo<FundConversionTransactionRow> {
  constructor(db: LedgerDatabase) {
    super(db, "fund_conversion_transactions", (row) => new FundConversionTransactionRow(row));
  }
}

export class BrokerageHoldingsRepo extends TypedTableRepo<BrokerageHoldingRow> {
  constructor(db: LedgerDatabase) {
    super(db, "brokerage_holdings", (row) => new BrokerageHoldingRow(row));
  }
}

export class BrokerageAssetSummariesRepo extends TypedTableRepo<BrokerageAssetSummaryRow> {
  constructor(db: LedgerDatabase) {
    super(db, "brokerage_asset_summaries", (row) => new BrokerageAssetSummaryRow(row));
  }
}

export class BrokerageTradeTransactionsRepo extends TypedTableRepo<BrokerageTradeTransactionRow> {
  constructor(db: LedgerDatabase) {
    super(db, "brokerage_trade_transactions", (row) => new BrokerageTradeTransactionRow(row));
  }
}

export class UnsupportedStatementRowsRepo extends TypedTableRepo<UnsupportedStatementRow> {
  constructor(db: LedgerDatabase) {
    super(db, "unsupported_statement_rows", (row) => new UnsupportedStatementRow(row));
  }
}

function readSqliteSourceFiles(db: LedgerDatabase): BatchRecord[] {
  if (!sqliteTableExists(db, "source_files")) return [];

  const rows = db
    .prepare(
      `SELECT
        source_file_id,
        import_run_id,
        source_file,
        source_relative_path,
        source_file_hash,
        source_file_bytes,
        source_file_modified_at,
        imported_at,
        bank,
        product,
        source_sheet_name,
        csv_layout_json,
        headers_json,
        record_keys_json,
        related_raw_files_json,
        related_raw_file_metadata_json,
        row_count,
        status,
        record_json
      FROM source_files
      ORDER BY imported_at, source_relative_path`,
    )
    .all() as Array<{
    source_file_id: string;
    import_run_id: string;
    source_file: string | null;
    source_relative_path: string;
    source_file_hash: string;
    source_file_bytes: number;
    source_file_modified_at: string | null;
    imported_at: string;
    bank: string;
    product: string;
    source_sheet_name: string | null;
    csv_layout_json: string;
    headers_json: string;
    record_keys_json: string;
    related_raw_files_json: string;
    related_raw_file_metadata_json: string;
    row_count: number;
    status: string;
    record_json: string;
  }>;

  return rows.map((row) => {
    const record = JSON.parse(row.record_json || "{}") as Record<string, unknown>;
    return {
      ...record,
      importRunId: row.import_run_id,
      importBatchId: row.source_file_id,
      sourceFile: row.source_file ?? "",
      sourceRelativePath: row.source_relative_path,
      sourceFileHash: row.source_file_hash,
      sourceFileBytes: row.source_file_bytes,
      sourceFileModifiedAt: row.source_file_modified_at ?? "",
      importedAt: row.imported_at,
      bank: row.bank,
      product: row.product,
      sourceSheetName: row.source_sheet_name ?? "",
      csvLayout: JSON.parse(row.csv_layout_json || "{}"),
      headers: JSON.parse(row.headers_json || "[]"),
      recordKeys: JSON.parse(row.record_keys_json || "[]"),
      relatedRawFileRelativePaths: JSON.parse(
        row.related_raw_files_json || "[]",
      ),
      relatedRawFileMetadata: JSON.parse(
        row.related_raw_file_metadata_json || "[]",
      ),
      rowCount: row.row_count,
      status: row.status,
    } as BatchRecord;
  });
}

export type FinancialDashboardData = {
  source: "sqlite";
  batches: BatchRecord[];
  importRuns: ImportRunRecord[];
  accountTransactions: AccountTransactionRow[];
  foreignCurrencyTransactions: ForeignCurrencyTransactionRow[];
  creditCardStatementLines: CreditCardStatementLineRow[];
  loanTransactions: LoanTransactionRow[];
  fundHoldings: FundHoldingRow[];
  fundBuyTransactions: FundBuyTransactionRow[];
  fundRedemptionTransactions: FundRedemptionTransactionRow[];
  fundCashDividends: FundCashDividendRow[];
  fundConversionTransactions: FundConversionTransactionRow[];
  brokerageHoldings: BrokerageHoldingRow[];
  brokerageAssetSummaries: BrokerageAssetSummaryRow[];
  brokerageTradeTransactions: BrokerageTradeTransactionRow[];
  unsupportedStatementRows: UnsupportedStatementRow[];
};

export async function readFinancialDashboardData(
  ledgerDir: string,
): Promise<FinancialDashboardData> {
  const sqlitePath = join(ledgerDir, SQLITE_LEDGER_FILE);
  if (!existsSync(sqlitePath)) {
    throw new Error(`Missing SQLite ledger: ${sqlitePath}`);
  }

  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    return {
      source: "sqlite",
      batches: readSqliteSourceFiles(db),
      importRuns: readSqliteRecords<ImportRunRecord>(db, "import_runs"),
      accountTransactions: new AccountTransactionsRepo(db).all(),
      foreignCurrencyTransactions: new ForeignCurrencyTransactionsRepo(db).all(),
      creditCardStatementLines: new CreditCardStatementLinesRepo(db).all(),
      loanTransactions: new LoanTransactionsRepo(db).all(),
      fundHoldings: new FundHoldingsRepo(db).all(),
      fundBuyTransactions: new FundBuyTransactionsRepo(db).all(),
      fundRedemptionTransactions: new FundRedemptionTransactionsRepo(db).all(),
      fundCashDividends: new FundCashDividendsRepo(db).all(),
      fundConversionTransactions: new FundConversionTransactionsRepo(db).all(),
      brokerageHoldings: new BrokerageHoldingsRepo(db).all(),
      brokerageAssetSummaries: new BrokerageAssetSummariesRepo(db).all(),
      brokerageTradeTransactions: new BrokerageTradeTransactionsRepo(db).all(),
      unsupportedStatementRows: new UnsupportedStatementRowsRepo(db).all(),
    };
  } finally {
    db.close();
  }
}
