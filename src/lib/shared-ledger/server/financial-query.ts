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
export type LedgerFinancialProduct = Exclude<FinancialProduct, "spending">;

export type CurrentOverviewLedgerQueryRequest = {
  kind: "current";
  product: "overview";
};

export type CurrentOverviewExchangeRateQueryRequest =
  | {
    kind: "current";
    product: "overview";
    selection: "latest";
    currencies: string[];
  }
  | {
    kind: "current";
    product: "overview";
    selection: "history";
    currencies: string[];
    firstDate: string;
    lastDate: string;
  };

type CurrentRequestByProduct = {
  assets: { kind: "current"; product: "assets" };
  overview: CurrentOverviewLedgerQueryRequest | CurrentOverviewExchangeRateQueryRequest;
  spending: { kind: "current"; product: "spending" };
  liabilities: { kind: "current"; product: "liabilities" };
};

export type CurrentFinancialQueryRequest<Product extends FinancialProduct = FinancialProduct> =
  CurrentRequestByProduct[Product];

export type HistoricalCutoff =
  | { kind: "financial-time"; at: string }
  | { kind: "knowledge-time"; at: string }
  | { kind: "both"; financialAt: string; knowledgeAt: string };

export type HistoricalFinancialQueryRequest = {
  kind: "historical";
  product: FinancialProduct;
  cutoff: HistoricalCutoff;
};

export type LineageSubject<SubjectKind extends string = string> = {
  kind: SubjectKind;
  id: string;
};

export type LineageFinancialQueryRequest<SubjectKind extends string = string> = {
  kind: "lineage";
  product: FinancialProduct;
  subject: LineageSubject<SubjectKind>;
};

export type UnsupportedFinancialQueryResult<Kind extends "historical" | "lineage"> = {
  status: "unsupported";
  kind: Kind;
  reason: Kind extends "historical"
    ? "legacy-adapter-does-not-support-historical-queries"
    : "legacy-adapter-does-not-support-lineage-queries";
};

export type ExchangeRateQueryRow = {
  rateDate: string;
  currency: string;
  twdPerUnit: number;
};

export type LegacySpendingInvoiceRow = {
  invoice_key: string;
  invoice_id: string;
  issued_at: number | string | null;
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

export type CurrentLedgerQueryResult<Product extends LedgerFinancialProduct> = {
  status: "ok";
  kind: "current";
  product: Product;
  /** Legacy rows after the established active-lineage visibility rules. */
  ledger: LedgerQueryData;
  unavailableAccountIssues: UnavailableAccountIssue[];
  unavailableAccounts: AccountRowDto[];
};

export type CurrentSpendingQueryResult = {
  status: "ok";
  kind: "current";
  product: "spending";
  spending: LegacySpendingQueryData;
};

export type CurrentOverviewExchangeRateQueryResult = {
  status: "ok";
  kind: "current";
  product: "overview";
  selection: "latest" | "history";
  exchangeRates: ExchangeRateQueryRow[];
};

export type CurrentFinancialQueryResult<Product extends FinancialProduct = FinancialProduct> =
  Product extends "spending"
    ? CurrentSpendingQueryResult
    : Product extends "overview"
      ? CurrentLedgerQueryResult<"overview"> | CurrentOverviewExchangeRateQueryResult
      : Product extends LedgerFinancialProduct
      ? CurrentLedgerQueryResult<Product>
      : never;

export type HistoricalFinancialProjection<Projection = never> = {
  status: "ok";
  kind: "historical";
  product: FinancialProduct;
  cutoff: HistoricalCutoff;
  projection: Projection;
};

export type HistoricalFinancialQueryResult<Projection = never> =
  | HistoricalFinancialProjection<Projection>
  | UnsupportedFinancialQueryResult<"historical">;

export type LineageFinancialProjection<Entry = never, SubjectKind extends string = string> = {
  status: "ok";
  kind: "lineage";
  product: FinancialProduct;
  subject: LineageSubject<SubjectKind>;
  lineage: readonly Entry[];
};

export type LineageFinancialQueryResult<Entry = never, SubjectKind extends string = string> =
  | LineageFinancialProjection<Entry, SubjectKind>
  | UnsupportedFinancialQueryResult<"lineage">;

export interface FinancialQueryBoundary {
  current(request: CurrentFinancialQueryRequest<"spending">): CurrentSpendingQueryResult;
  current(request: CurrentOverviewLedgerQueryRequest): Promise<CurrentLedgerQueryResult<"overview">>;
  current(request: CurrentOverviewExchangeRateQueryRequest): Promise<CurrentOverviewExchangeRateQueryResult>;
  current<Product extends LedgerFinancialProduct>(
    request: CurrentFinancialQueryRequest<Product> & { product: Exclude<Product, "overview"> },
  ): Promise<CurrentLedgerQueryResult<Product>>;
  historical(request: HistoricalFinancialQueryRequest): Promise<HistoricalFinancialQueryResult<never>>;
  lineage(request: LineageFinancialQueryRequest): Promise<LineageFinancialQueryResult<never>>;
}

/**
 * Creates the product read boundary. The default implementation is deliberately
 * a legacy adapter; it preserves current ledger behavior while leaving the
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

  current(request: CurrentFinancialQueryRequest<"spending">): CurrentSpendingQueryResult;
  current(request: CurrentOverviewLedgerQueryRequest): Promise<CurrentLedgerQueryResult<"overview">>;
  current(request: CurrentOverviewExchangeRateQueryRequest): Promise<CurrentOverviewExchangeRateQueryResult>;
  current<Product extends LedgerFinancialProduct>(
    request: CurrentFinancialQueryRequest<Product>,
  ): Promise<CurrentLedgerQueryResult<Product>>;
  current(
    request: CurrentFinancialQueryRequest,
  ): CurrentSpendingQueryResult
    | Promise<CurrentLedgerQueryResult<LedgerFinancialProduct> | CurrentOverviewExchangeRateQueryResult> {
    if (request.product === "spending") return this.readCurrentSpending();
    if (request.product === "overview" && "selection" in request) {
      return this.readCurrentOverviewExchangeRates(request);
    }
    if (request.product === "assets") return this.readCurrentAssets();
    if (request.product === "overview") return this.readCurrentOverview();
    return this.readCurrentLiabilities();
  }

  private async readCurrentOverviewExchangeRates(
    request: CurrentOverviewExchangeRateQueryRequest,
  ): Promise<CurrentOverviewExchangeRateQueryResult> {
    if (request.currencies.length === 0) {
      return {
        status: "ok",
        kind: "current",
        product: "overview",
        selection: request.selection,
        exchangeRates: [],
      };
    }
    const sqlite = openLedgerDatabase(this.ledgerDir);
    try {
      const placeholders = request.currencies.map(() => "?").join(", ");
      if (request.selection === "latest") {
        const exchangeRates = (sqlite.prepare(`
          SELECT rate.rate_date AS rateDate, rate.currency, rate.twd_per_unit AS twdPerUnit
          FROM exchange_rates AS rate
          WHERE rate.currency IN (${placeholders})
            AND rate.rate_date = (
              SELECT MAX(rate_date)
              FROM exchange_rates AS current_rate
              WHERE current_rate.currency = rate.currency
            )
          ORDER BY rate.currency
        `).all(...request.currencies) as ExchangeRateQueryRow[]).map((rate) => ({ ...rate }));
        return { status: "ok", kind: "current", product: "overview", selection: "latest", exchangeRates };
      }
      const exchangeRates = (sqlite.prepare(`
        SELECT
          rate_date AS rateDate,
          currency,
          twd_per_unit AS twdPerUnit
        FROM exchange_rates AS rate
        WHERE currency IN (${placeholders})
          AND rate_date <= ?
          AND (
            rate_date >= ?
            OR rate_date = (
              SELECT MAX(rate_date)
              FROM exchange_rates AS prior
              WHERE prior.currency = rate.currency
                AND prior.rate_date < ?
            )
          )
        ORDER BY currency, rate_date
      `).all(...request.currencies, request.lastDate, request.firstDate, request.firstDate) as ExchangeRateQueryRow[])
        .map((rate) => ({ ...rate }));
      return { status: "ok", kind: "current", product: "overview", selection: "history", exchangeRates };
    } finally {
      sqlite.close();
    }
  }

  async historical(
    _request: HistoricalFinancialQueryRequest,
  ): Promise<HistoricalFinancialQueryResult<never>> {
    return {
      status: "unsupported",
      kind: "historical",
      reason: "legacy-adapter-does-not-support-historical-queries",
    };
  }

  async lineage(
    _request: LineageFinancialQueryRequest,
  ): Promise<LineageFinancialQueryResult<never>> {
    return {
      status: "unsupported",
      kind: "lineage",
      reason: "legacy-adapter-does-not-support-lineage-queries",
    };
  }

  private async readCurrentAssets(): Promise<CurrentLedgerQueryResult<"assets">> {
    const { db, sqlite } = openLedgerDrizzle(this.ledgerDir);
    try {
      const data: LedgerQueryData = {
        ...emptyLedgerQueryData(),
        sourceFiles: await db.select().from(schema.sourceFileImports).all(),
        sourceRowLineage: await db.select().from(schema.sourceRowLineage).all(),
        accountTransactions: await db.select().from(schema.accountTransactions).all(),
        foreignCurrencyTransactions: await db.select().from(schema.foreignCurrencyTransactions).all(),
        creditCardCaptures: await db.select().from(schema.creditCardCaptures).all(),
        creditCardCaptureEntries: await db.select().from(schema.creditCardCaptureEntries).all(),
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
      return currentLedgerResult(sqlite, "assets", data);
    } finally {
      sqlite.close();
    }
  }

  private async readCurrentOverview(): Promise<CurrentLedgerQueryResult<"overview">> {
    const { db, sqlite } = openLedgerDrizzle(this.ledgerDir);
    try {
      const data: LedgerQueryData = {
        ...emptyLedgerQueryData(),
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
        brokerageHoldings: await db.select().from(schema.brokerageHoldings).all(),
        maicoinAccountSnapshots: await db.select().from(schema.maicoinAccountSnapshots).all(),
        maicoinStatementRows: await db.select().from(schema.maicoinStatementRows).all(),
      };
      return currentLedgerResult(sqlite, "overview", data);
    } finally {
      sqlite.close();
    }
  }

  private async readCurrentLiabilities(): Promise<CurrentLedgerQueryResult<"liabilities">> {
    const { db, sqlite } = openLedgerDrizzle(this.ledgerDir);
    try {
      const data: LedgerQueryData = {
        ...emptyLedgerQueryData(),
        sourceFiles: await db.select().from(schema.sourceFileImports).all(),
        creditCardStatementLines: await db.select().from(schema.creditCardStatementLines).all(),
        creditCardCaptures: await db.select().from(schema.creditCardCaptures).all(),
        creditCardCaptureEntries: await db.select().from(schema.creditCardCaptureEntries).all(),
        creditCardSnapshots: await db.select().from(schema.creditCardSnapshots).all(),
        loanTransactions: await db.select().from(schema.loanTransactions).all(),
        maicoinAccountSnapshots: await db.select().from(schema.maicoinAccountSnapshots).all(),
      };
      return currentLedgerResult(sqlite, "liabilities", data);
    } finally {
      sqlite.close();
    }
  }

  private readCurrentSpending(): CurrentSpendingQueryResult {
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
}

function currentLedgerResult<Product extends LedgerFinancialProduct>(
  sqlite: ReturnType<typeof openLedgerDrizzle>["sqlite"],
  product: Product,
  data: LedgerQueryData,
): CurrentLedgerQueryResult<Product> {
  const support = loadActiveLedgerSupport(sqlite);
  const unavailableAccountIssues = loadUnavailableAccountIssues(sqlite, data, support);
  return {
    status: "ok",
    kind: "current",
    product,
    ledger: applyLedgerVisibility(data, support),
    unavailableAccountIssues,
    unavailableAccounts: unavailableAccountIssues.map(unavailableAccountFromIssue),
  };
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
