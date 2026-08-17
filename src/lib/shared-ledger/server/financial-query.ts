import {
  DEFAULT_LEDGER_DIR,
  openLedgerDatabase,
  openLedgerDrizzle,
} from "../../../ledger/db/client.ts";
import * as schema from "../../../ledger/db/schema.ts";
import type { SpendingCategory } from "../../spending/categories.ts";
import type { SpendingReason, SpendingState } from "../../spending/model.ts";
import {
  activeImportSql,
  applyLedgerVisibility,
  loadActiveLedgerSupport,
  loadUnavailableAccountIssues,
} from "../../data-issues/server/ledger-visibility.ts";
import {
  emptyLedgerQueryData,
  unavailableAccountFromIssue,
  type LedgerQueryData,
  type UnavailableAccountIssue,
} from "./accounts.ts";
import type { AccountRowDto } from "../types.ts";

/** Products that may consume the financial query boundary. */
export type FinancialProduct = "assets" | "overview" | "spending" | "liabilities";

export type CurrentFinancialQueryRequest = {
  kind: "current";
  product: FinancialProduct;
};

export type HistoricalFinancialQueryRequest = {
  kind: "historical";
  product: FinancialProduct;
  financialCutoff?: string;
  knowledgeCutoff?: string;
};

export type LineageFinancialQueryRequest = {
  kind: "lineage";
  product: FinancialProduct;
  subject: {
    type: string;
    id: string;
  };
};

export type UnsupportedFinancialQueryResult = {
  status: "unsupported";
  kind: "historical" | "lineage";
  reason:
    | "legacy-adapter-does-not-support-historical-queries"
    | "legacy-adapter-does-not-support-lineage-queries";
};

export type ExchangeRateQueryRow = {
  rateDate: string;
  currency: string;
  twdPerUnit: number;
};

export type LegacySpendingInvoiceRow = {
  invoice_key: string;
  invoice_id: string;
  issued_at: unknown;
  invoice_amount: number | null;
  seller_business_account_number: string | null;
  seller_name: string | null;
  seller_addr: string | null;
  item_key: string | null;
  item_sequence_number: number | null;
  item_quantity: number | null;
  item_unit_price: number | null;
  item_paid_amount: number | null;
  item_product_name: string | null;
  category: SpendingCategory | null;
};

export type LegacySpendingAccountRow = {
  statement_row_id: string;
  bank: string;
  account_number: string | null;
  currency: string;
  date: string;
  transaction_time: string | null;
  description: string | null;
  note: string | null;
  withdrawal_amount: number | null;
  deposit_amount: number | null;
};

export type LegacySpendingCardPaymentRow = { date: string; twd_amount: number };

export type LegacySpendingOverrideRow = {
  statement_row_id: string;
  state: SpendingState;
  category: SpendingCategory | null;
  automatic_state: SpendingState;
  automatic_reason: SpendingReason | null;
  updated_at: string;
};

export type LegacySpendingQueryData = {
  invoices: LegacySpendingInvoiceRow[];
  accountTransactions: LegacySpendingAccountRow[];
  cardPayments: LegacySpendingCardPaymentRow[];
  overrides: LegacySpendingOverrideRow[];
};

export type CurrentFinancialQueryResult = {
  status: "ok";
  kind: "current";
  product: FinancialProduct;
  /** Legacy rows after the established active-lineage visibility rules. */
  ledger: LedgerQueryData;
  unavailableAccountIssues: UnavailableAccountIssue[];
  unavailableAccounts: AccountRowDto[];
  exchangeRates: ExchangeRateQueryRow[];
  spending: LegacySpendingQueryData;
};

export type CurrentSpendingQueryResult = {
  status: "ok";
  kind: "current";
  product: "spending";
  spending: LegacySpendingQueryData;
};

export type HistoricalFinancialProjection = {
  status: "ok";
  kind: "historical";
  product: FinancialProduct;
  financialCutoff: string | null;
  knowledgeCutoff: string | null;
  /** Canonical implementations will provide a typed projection here. */
  projection: unknown;
};

export type HistoricalFinancialQueryResult =
  | HistoricalFinancialProjection
  | UnsupportedFinancialQueryResult;

export type LineageFinancialProjection = {
  status: "ok";
  kind: "lineage";
  product: FinancialProduct;
  subject: LineageFinancialQueryRequest["subject"];
  /** Canonical implementations will provide typed assertion lineage here. */
  lineage: unknown;
};

export type LineageFinancialQueryResult =
  | LineageFinancialProjection
  | UnsupportedFinancialQueryResult;

export interface FinancialQueryBoundary {
  current(request: CurrentFinancialQueryRequest & { product: "spending" }): CurrentSpendingQueryResult;
  current(request: CurrentFinancialQueryRequest): Promise<CurrentFinancialQueryResult>;
  /** Synchronous current seam retained for the existing synchronous spending API. */
  currentSpending(request: CurrentFinancialQueryRequest): CurrentSpendingQueryResult;
  historical(request: HistoricalFinancialQueryRequest): Promise<HistoricalFinancialQueryResult>;
  lineage(request: LineageFinancialQueryRequest): Promise<LineageFinancialQueryResult>;
}

/**
 * Creates the product read boundary. The default implementation is deliberately
 * a legacy adapter; it preserves the current ledger behavior while leaving the
 * Current/Historical/Lineage contract seam ready for a canonical store.
 */
export function createFinancialQuery(ledgerDir = DEFAULT_LEDGER_DIR): FinancialQueryBoundary {
  return new LegacyFinancialQueryAdapter(ledgerDir);
}

class LegacyFinancialQueryAdapter implements FinancialQueryBoundary {
  private readonly ledgerDir: string;

  constructor(ledgerDir: string) {
    this.ledgerDir = ledgerDir;
  }

  current(request: CurrentFinancialQueryRequest & { product: "spending" }): CurrentSpendingQueryResult;
  current(request: CurrentFinancialQueryRequest): Promise<CurrentFinancialQueryResult>;
  current(
    request: CurrentFinancialQueryRequest,
  ): Promise<CurrentFinancialQueryResult> | CurrentSpendingQueryResult {
    if (request.product === "spending") return this.currentSpending(request);
    return this.currentAsync(request);
  }

  private async currentAsync(request: CurrentFinancialQueryRequest): Promise<CurrentFinancialQueryResult> {
    const { db, sqlite } = openLedgerDrizzle(this.ledgerDir);
    try {
      const rawData: LedgerQueryData = {
        ...emptyLedgerQueryData(),
        importRuns: await db.select().from(schema.importRuns).all(),
        sourceFiles: await db.select().from(schema.sourceFileImports).all(),
        sourceRowLineage: await db.select().from(schema.sourceRowLineage).all(),
        accountTransactions: await db.select().from(schema.accountTransactions).all(),
        foreignCurrencyTransactions: await db.select().from(schema.foreignCurrencyTransactions).all(),
        creditCardStatementLines: await db.select().from(schema.creditCardStatementLines).all(),
        creditCardCaptures: await db.select().from(schema.creditCardCaptures).all(),
        creditCardCaptureEntries: await db.select().from(schema.creditCardCaptureEntries).all(),
        creditCardSnapshots: await db.select().from(schema.creditCardSnapshots).all(),
        loanTransactions: await db.select().from(schema.loanTransactions).all(),
        fundHoldings: await db.select().from(schema.fundHoldings).all(),
        fundBuyTransactions: await db.select().from(schema.fundBuyTransactions).all(),
        fundRedemptionTransactions: await db.select().from(schema.fundRedemptionTransactions).all(),
        fundCashDividends: await db.select().from(schema.fundCashDividends).all(),
        fundConversionTransactions: await db.select().from(schema.fundConversionTransactions).all(),
        brokerageHoldings: await db.select().from(schema.brokerageHoldings).all(),
        brokerageTradeTransactions: await db.select().from(schema.brokerageTradeTransactions).all(),
        maicoinAccountSnapshots: await db.select().from(schema.maicoinAccountSnapshots).all(),
        maicoinStatementRows: await db.select().from(schema.maicoinStatementRows).all(),
      };
      const productData = ledgerDataForProduct(rawData, request.product);
      const support = loadActiveLedgerSupport(sqlite);
      const unavailableAccountIssues = loadUnavailableAccountIssues(sqlite, productData, support);
      return {
        status: "ok",
        kind: "current",
        product: request.product,
        ledger: applyLedgerVisibility(productData, support),
        unavailableAccountIssues,
        unavailableAccounts: unavailableAccountIssues.map(unavailableAccountFromIssue),
        exchangeRates: (await db.select().from(schema.exchangeRates).all()).map((rate) => ({
          rateDate: rate.rateDate,
          currency: rate.currency,
          twdPerUnit: rate.twdPerUnit,
        })),
        spending: loadSpendingQueryData(sqlite),
      };
    } finally {
      sqlite.close();
    }
  }

  currentSpending(request: CurrentFinancialQueryRequest): CurrentSpendingQueryResult {
    if (request.product !== "spending") {
      throw new Error(`Synchronous current query is only available for spending: ${request.product}`);
    }
    const sqlite = openLedgerDatabase(this.ledgerDir);
    try {
      return {
        status: "ok",
        kind: "current",
        product: "spending",
        spending: loadSpendingQueryData(sqlite),
      };
    } finally {
      sqlite.close();
    }
  }

  async historical(
    _request: HistoricalFinancialQueryRequest,
  ): Promise<HistoricalFinancialQueryResult> {
    return {
      status: "unsupported",
      kind: "historical",
      reason: "legacy-adapter-does-not-support-historical-queries",
    };
  }

  async lineage(_request: LineageFinancialQueryRequest): Promise<LineageFinancialQueryResult> {
    return {
      status: "unsupported",
      kind: "lineage",
      reason: "legacy-adapter-does-not-support-lineage-queries",
    };
  }
}

function ledgerDataForProduct(data: LedgerQueryData, product: FinancialProduct): LedgerQueryData {
  const scoped = emptyLedgerQueryData();
  scoped.sourceFiles = data.sourceFiles;
  scoped.sourceRowLineage = data.sourceRowLineage;
  if (product === "assets" || product === "overview") {
    scoped.accountTransactions = data.accountTransactions;
    scoped.foreignCurrencyTransactions = data.foreignCurrencyTransactions;
  }
  if (product === "overview" || product === "liabilities") {
    scoped.creditCardStatementLines = data.creditCardStatementLines;
    scoped.creditCardSnapshots = data.creditCardSnapshots;
    scoped.loanTransactions = data.loanTransactions;
  }
  if (product === "assets" || product === "overview" || product === "liabilities") {
    scoped.creditCardCaptures = data.creditCardCaptures;
    scoped.creditCardCaptureEntries = data.creditCardCaptureEntries;
    scoped.maicoinAccountSnapshots = data.maicoinAccountSnapshots;
  }
  if (product === "assets" || product === "overview") {
    scoped.maicoinStatementRows = data.maicoinStatementRows;
  }
  if (product === "assets" || product === "overview") {
    scoped.fundHoldings = data.fundHoldings;
    scoped.brokerageHoldings = data.brokerageHoldings;
  }
  if (product === "assets") {
    scoped.fundBuyTransactions = data.fundBuyTransactions;
    scoped.fundRedemptionTransactions = data.fundRedemptionTransactions;
    scoped.fundCashDividends = data.fundCashDividends;
    scoped.fundConversionTransactions = data.fundConversionTransactions;
    scoped.brokerageTradeTransactions = data.brokerageTradeTransactions;
  }
  return scoped;
}

function loadSpendingQueryData(db: ReturnType<typeof openLedgerDrizzle>["sqlite"]): LegacySpendingQueryData {
  const invoices = db.prepare(`
    SELECT
      personal_invoices.invoice_key,
      personal_invoices.invoice_id,
      personal_invoices.issued_at,
      personal_invoices.amount AS invoice_amount,
      personal_invoices.seller_business_account_number,
      personal_invoices.seller_name,
      personal_invoices.seller_addr,
      items.item_key,
      items.item_sequence_number,
      items.item_quantity,
      items.item_unit_price,
      items.item_paid_amount,
      items.item_product_name,
      items.category
    FROM personal_invoices
    LEFT JOIN personal_invoice_items AS items
      ON items.invoice_key = personal_invoices.invoice_key
      AND ${activeImportSql("personal_invoice_items", "items")}
    WHERE personal_invoices.status = ?
      AND ${activeImportSql("personal_invoices")}
    ORDER BY personal_invoices.issued_at, personal_invoices.invoice_key,
      items.item_sequence_number, items.item_key
  `).all("confirmed") as LegacySpendingInvoiceRow[];
  const accountTransactions = db.prepare(`
    SELECT statement_row_id, bank, account_number, currency,
      COALESCE(transaction_date, accounting_date) AS date,
      transaction_time, description, note, withdrawal_amount, deposit_amount
    FROM account_transactions
    WHERE (withdrawal_amount > 0 OR deposit_amount > 0)
      AND COALESCE(transaction_date, accounting_date) IS NOT NULL
      AND ${activeImportSql("account_transactions")}
    ORDER BY date, statement_row_id
  `).all() as LegacySpendingAccountRow[];
  const cardPayments = db.prepare(`
    SELECT COALESCE(consume_date, posting_date) AS date, twd_amount
    FROM credit_card_statement_lines
    WHERE twd_amount < 0
      AND COALESCE(consume_date, posting_date) IS NOT NULL
      AND ${activeImportSql("credit_card_statement_lines")}
  `).all() as LegacySpendingCardPaymentRow[];
  const overrides = db.prepare(`
    SELECT statement_row_id, state, category, automatic_state,
      automatic_reason, updated_at
    FROM spending_transaction_overrides
  `).all() as LegacySpendingOverrideRow[];
  return { invoices, accountTransactions, cardPayments, overrides };
}
