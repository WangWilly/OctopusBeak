import { sourceTransactionAtUtc } from "./source-timezones.ts";

export type SourceMetadata = Record<string, unknown>;

export type TypedStatementTable =
  | "account_transactions"
  | "foreign_currency_transactions"
  | "credit_card_statement_lines"
  | "loan_transactions"
  | "fund_holdings"
  | "fund_buy_transactions"
  | "fund_redemption_transactions"
  | "fund_cash_dividends"
  | "fund_conversion_transactions"
  | "brokerage_holdings"
  | "brokerage_asset_summaries"
  | "brokerage_trade_transactions"
  | "personal_invoices"
  | "personal_invoice_items"
  | "unsupported_statement_rows";

export const TYPED_STATEMENT_TABLES: TypedStatementTable[] = [
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
  "personal_invoices",
  "personal_invoice_items",
  "unsupported_statement_rows",
];

export type SourceCsvContext = {
  bank: string;
  product: string;
  sourceRelativePath: string;
  metadata: SourceMetadata | null;
  headers: string[];
};

export type SourceCsvParser = {
  table: TypedStatementTable;
  parseRow: (rawPayload: Record<string, string>) => Record<string, unknown>;
};

type ParserContext = SourceCsvContext & {
  table: TypedStatementTable;
  rawPayload: Record<string, string>;
};

type ParseFields = (context: ParserContext) => Record<string, unknown>;

export function createSourceCsvParser(context: SourceCsvContext): SourceCsvParser {
  const bind = (
    table: TypedStatementTable,
    parseFields: ParseFields,
  ): SourceCsvParser => ({
    table,
    parseRow: (rawPayload) => parseFields({ ...context, table, rawPayload }),
  });

  const bankProduct = `${context.bank}/${context.product}`;
  const fileName = context.sourceRelativePath.split("/").pop() ?? "";

  if (bankProduct === "cathay/statements") {
    return bind("account_transactions", bankTransactionFields);
  }
  if (bankProduct === "ctbc/statements") {
    return bind("account_transactions", bankTransactionFields);
  }
  if (bankProduct === "fubon/statements") {
    return bind("account_transactions", bankTransactionFields);
  }
  if (bankProduct === "hncb/statements") {
    return bind("account_transactions", bankTransactionFields);
  }
  if (bankProduct === "linebank/statements") {
    return bind("account_transactions", bankTransactionFields);
  }
  if (bankProduct === "post/statements") {
    return bind("account_transactions", bankTransactionFields);
  }
  if (bankProduct === "sinopac/statements") {
    return bind("account_transactions", bankTransactionFields);
  }
  if (bankProduct === "yuanta/statements") {
    return bind("account_transactions", bankTransactionFields);
  }
  if (bankProduct === "cathay/foreign-statements") {
    return bind("foreign_currency_transactions", foreignCurrencyTransactionFields);
  }
  if (bankProduct === "linebank/foreign-statements") {
    return bind("foreign_currency_transactions", foreignCurrencyTransactionFields);
  }
  if (bankProduct === "sinopac/foreign-statements") {
    return bind("foreign_currency_transactions", foreignCurrencyTransactionFields);
  }
  if (bankProduct === "yuanta/foreign-currency-statements") {
    return bind("foreign_currency_transactions", foreignCurrencyTransactionFields);
  }
  if (bankProduct.endsWith("/credit-card-statements")) {
    return bind("credit_card_statement_lines", creditCardStatementLineFields);
  }
  if (bankProduct.endsWith("/loan-statements")) {
    return bind("loan_transactions", loanTransactionFields);
  }
  if (bankProduct === "yuanta/fund-statements") {
    if (fileName.startsWith("fund-holdings-")) {
      return bind("fund_holdings", fundHoldingFields);
    }
    if (fileName.startsWith("fund-buy-transactions-")) {
      return bind("fund_buy_transactions", fundBuyTransactionFields);
    }
    if (fileName.startsWith("fund-redemption-transactions-")) {
      return bind("fund_redemption_transactions", fundRedemptionTransactionFields);
    }
    if (fileName.startsWith("fund-cash-dividends-")) {
      return bind("fund_cash_dividends", fundCashDividendFields);
    }
    if (fileName.startsWith("fund-conversion-transactions-")) {
      return bind("fund_conversion_transactions", fundConversionTransactionFields);
    }
  }
  if (bankProduct === "yuanta/trade-statements") {
    if (fileName.startsWith("holdings-")) {
      return bind("brokerage_holdings", brokerageHoldingFields);
    }
    if (fileName.startsWith("asset-summaries-")) {
      return bind("brokerage_asset_summaries", brokerageAssetSummaryFields);
    }
    if (fileName.startsWith("trade-transactions-")) {
      return bind("brokerage_trade_transactions", brokerageTradeTransactionFields);
    }
  }
  if (bankProduct === "einvoice/personal-invoices") {
    return bind("personal_invoice_items", ({ rawPayload }) =>
      personalInvoiceItemFields(rawPayload),
    );
  }

  return bind("unsupported_statement_rows", unsupportedStatementFields);
}

function cleanTypedCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .trim()
    .replace(/^'+/, "")
    .trim();
}

function personalInvoiceItemSequenceNumber(value: unknown): number {
  const raw = cleanTypedCell(value);
  if (!raw) {
    throw new Error(
      "Invalid personal invoice item_sequence_number: item_sequence_number is required",
    );
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      "Invalid personal invoice item_sequence_number: expected a non-negative decimal integer",
    );
  }
  const sequenceNumber = Number(raw);
  if (!Number.isSafeInteger(sequenceNumber)) {
    throw new Error(
      "Invalid personal invoice item_sequence_number: exceeds the safe integer range",
    );
  }
  return sequenceNumber;
}

function sqliteInteger(value: string | number | null | undefined): number | null {
  const cleaned = cleanTypedCell(value);
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function sqliteBoolean(value: string | number | null | undefined): number {
  return ["1", "true", "y", "yes"].includes(cleanTypedCell(value).toLowerCase())
    ? 1
    : 0;
}

export function personalInvoiceKey(rawPayload: Record<string, string>): string {
  return [
    cleanTypedCell(rawPayload.invoice_id),
    cleanTypedCell(rawPayload.issued_at),
    cleanTypedCell(rawPayload.seller_business_account_number),
  ].join("|");
}

export function personalInvoiceItemKey(rawPayload: Record<string, string>): string {
  const invoiceKey = personalInvoiceKey(rawPayload);
  const sequenceNumber = personalInvoiceItemSequenceNumber(
    rawPayload.item_sequence_number,
  );
  return `${invoiceKey}|${sequenceNumber}`;
}

export function personalInvoiceFields(rawPayload: Record<string, string>) {
  return {
    invoice_key: personalInvoiceKey(rawPayload),
    carrier_customized_name: cleanTypedCell(rawPayload.carrier_customized_name),
    issued_at: sqliteInteger(rawPayload.issued_at),
    invoice_id: cleanTypedCell(rawPayload.invoice_id),
    amount: sqliteAmount(rawPayload.amount),
    status: cleanTypedCell(rawPayload.status),
    rebated: sqliteBoolean(rawPayload.rebated),
    seller_business_account_number: cleanTypedCell(
      rawPayload.seller_business_account_number,
    ),
    seller_name: cleanTypedCell(rawPayload.seller_name),
    seller_addr: cleanTypedCell(rawPayload.seller_addr),
    buyer_business_account_number: cleanTypedCell(
      rawPayload.buyer_business_account_number,
    ),
  };
}

export function personalInvoiceItemFields(rawPayload: Record<string, string>) {
  return {
    item_key: personalInvoiceItemKey(rawPayload),
    invoice_key: personalInvoiceKey(rawPayload),
    item_sequence_number: personalInvoiceItemSequenceNumber(
      rawPayload.item_sequence_number,
    ),
    item_quantity: sqliteAmount(rawPayload.item_quantity),
    item_unit_price: sqliteAmount(rawPayload.item_unit_price),
    item_paid_amount: sqliteAmount(rawPayload.item_paid_amount),
    item_product_name: cleanTypedCell(rawPayload.item_product_name),
  };
}

function payloadCell(payload: Record<string, unknown>, key: string): string {
  return cleanTypedCell(payload[key]);
}

function firstPayloadCell(
  payload: Record<string, unknown>,
  keys: string[],
): string {
  for (const key of keys) {
    const value = payloadCell(payload, key);
    if (value) return value;
  }
  return "";
}

function metadataCell(metadata: SourceMetadata | null, key: string): string {
  return cleanTypedCell(metadata?.[key]);
}

export function sqliteAmount(value: unknown): number | null {
  const raw = cleanTypedCell(value).replace(/\u00a0/g, " ").trim();
  if (!raw || raw === "-" || raw === "--") return null;
  const amountText = raw.match(/-?\(?\d[\d,]*(?:\.\d+)?\)?-?/)?.[0];
  if (!amountText) return null;
  const negative =
    /^\(.*\)$/.test(raw) ||
    raw.startsWith("-") ||
    raw.endsWith("-") ||
    amountText.startsWith("-") ||
    amountText.endsWith("-") ||
    /^\(.*\)$/.test(amountText);
  const normalized = amountText
    .replace(/[,%\s]/g, "")
    .replace(/[()]/g, "")
    .replace(/^-/, "")
    .replace(/-$/, "");
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) return null;
  return negative ? -amount : amount;
}

export function normalizeCurrencyCode(value: unknown, fallback = ""): string {
  const raw = cleanTypedCell(value);
  if (!raw || raw === "全部") return fallback;

  const normalized = raw.toUpperCase();
  const candidates = [...normalized.matchAll(/[A-Z]{3}/g)].map((match) => match[0]);
  const code = candidates.at(-1);
  if (code) return code === "NTD" ? "TWD" : code;

  if (/台幣|臺幣|新台幣|新臺幣/.test(raw)) return "TWD";
  if (/美金|美元/.test(raw)) return "USD";
  if (/日幣|日圓|日元/.test(raw)) return "JPY";
  if (/人民幣|人民币/.test(raw)) return "CNY";
  if (/港幣|港元/.test(raw)) return "HKD";
  return fallback;
}

function normalizeDateValue(value: unknown): string {
  const raw = cleanTypedCell(value);
  if (!raw) return "";

  const compactMatch = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compactMatch) {
    return `${compactMatch[1]}-${compactMatch[2]}-${compactMatch[3]}`;
  }

  const separatedMatch = raw.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (separatedMatch) {
    return [
      separatedMatch[1],
      separatedMatch[2].padStart(2, "0"),
      separatedMatch[3].padStart(2, "0"),
    ].join("-");
  }

  const rocDateMatch = raw.match(/^(\d{2,3})[/-](\d{1,2})[/-](\d{1,2})/);
  if (rocDateMatch) {
    return [
      String(Number(rocDateMatch[1]) + 1911),
      rocDateMatch[2].padStart(2, "0"),
      rocDateMatch[3].padStart(2, "0"),
    ].join("-");
  }

  return "";
}

function normalizeTimePart(value: unknown): string {
  const raw = cleanTypedCell(value);
  const match = raw.match(/(?:^|[T\s])(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return "";

  return [
    match[1].padStart(2, "0"),
    match[2],
    match[3] ?? "00",
  ].join(":");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function accountNumberFromText(value: string): string {
  return value.match(/\d{6,}/)?.[0] ?? "";
}

function accountNameFromMetadataValue(
  value: string,
  accountNumber: string,
): string {
  let accountName = value;
  if (accountNumber) {
    accountName = accountName.replace(
      new RegExp(`^${escapeRegExp(accountNumber)}\\s*`),
      "",
    );
  }
  return accountName.replace(/^\((.*)\)$/, "$1").trim();
}

function currencyFromRelativePath(sourceRelativePath: string): string {
  const fileName = sourceRelativePath.split("/").pop() ?? "";
  const match = fileName.match(/-(USD|JPY|EUR|GBP|AUD|CAD|CHF|HKD|CNY)-/i);
  return normalizeCurrencyCode(match?.[1], "TWD");
}

function accountIdentity(context: ParserContext) {
  const metadataAccount =
    metadataCell(context.metadata, "帳號") ||
    metadataCell(context.metadata, "貸款帳號");
  const accountNumber =
    firstPayloadCell(context.rawPayload, ["帳號", "account_number"]) ||
    accountNumberFromText(metadataAccount) ||
    accountNumberFromText(context.sourceRelativePath);
  const accountName =
    firstPayloadCell(context.rawPayload, ["帳戶名稱", "account_name"]) ||
    accountNameFromMetadataValue(metadataAccount, accountNumber) ||
    metadataCell(context.metadata, "分行名稱");

  return { accountName, accountNumber };
}

function bankTransactionFields(context: ParserContext) {
  const { rawPayload } = context;
  const { accountName, accountNumber } = accountIdentity(context);
  const accountingDate = normalizeDateValue(payloadCell(rawPayload, "帳務日期"));
  const transactionDate = normalizeDateValue(
    firstPayloadCell(rawPayload, ["交易日期", "帳務日期"]),
  );
  const transactionTime = normalizeTimePart(payloadCell(rawPayload, "交易時間"));
  return {
    account_name: accountName,
    account_number: accountNumber,
    currency: normalizeCurrencyCode("TWD"),
    accounting_date: accountingDate,
    transaction_date: transactionDate,
    transaction_time: transactionTime,
    transaction_at_utc: sourceTransactionAtUtc(
      context.bank,
      transactionDate,
      transactionTime,
      context.product,
    ),
    description: firstPayloadCell(rawPayload, ["摘要", "交易說明"]),
    withdrawal_amount: sqliteAmount(payloadCell(rawPayload, "支出金額")),
    deposit_amount: sqliteAmount(payloadCell(rawPayload, "存入金額")),
    balance_after: sqliteAmount(
      firstPayloadCell(rawPayload, ["即時餘額", "帳面餘額"]),
    ),
    note: firstPayloadCell(rawPayload, ["附註", "備註"]),
    fx_rate: sqliteAmount(payloadCell(rawPayload, "匯率")),
  };
}

function foreignCurrencyTransactionFields(context: ParserContext) {
  const { rawPayload, metadata, sourceRelativePath } = context;
  const { accountName, accountNumber } = accountIdentity(context);
  const accountingDate = normalizeDateValue(payloadCell(rawPayload, "帳務日期"));
  const transactionDate = normalizeDateValue(
    firstPayloadCell(rawPayload, ["交易日期", "帳務日期"]),
  );
  const transactionTime = normalizeTimePart(payloadCell(rawPayload, "交易時間"));
  const metadataCurrency = metadataCell(metadata, "幣別");
  return {
    account_name: accountName,
    account_number: accountNumber,
    query_currency: normalizeCurrencyCode(
      payloadCell(rawPayload, "查詢幣別") || metadataCurrency,
    ),
    currency: normalizeCurrencyCode(
      firstPayloadCell(rawPayload, ["幣別", "查詢幣別"]) || metadataCurrency,
      currencyFromRelativePath(sourceRelativePath),
    ),
    accounting_date: accountingDate,
    transaction_date: transactionDate,
    transaction_time: transactionTime,
    transaction_at_utc: sourceTransactionAtUtc(
      context.bank,
      transactionDate,
      transactionTime,
      context.product,
    ),
    description: firstPayloadCell(rawPayload, ["摘要", "交易說明"]),
    withdrawal_amount: sqliteAmount(payloadCell(rawPayload, "支出金額")),
    deposit_amount: sqliteAmount(payloadCell(rawPayload, "存入金額")),
    balance_after: sqliteAmount(
      firstPayloadCell(rawPayload, ["即時餘額", "帳面餘額"]),
    ),
    note: firstPayloadCell(rawPayload, ["附註", "交易資訊", "備註"]),
    fx_rate: sqliteAmount(payloadCell(rawPayload, "匯率")),
  };
}

function creditCardStatementLineFields(context: ParserContext) {
  const { rawPayload, sourceRelativePath } = context;
  return {
    statement_type: sourceRelativePath.includes("unbilled")
      ? "unbilled"
      : "billed",
    statement_period: payloadCell(rawPayload, "statement_period"),
    card_number: firstPayloadCell(rawPayload, ["card_number", "信用卡號"]),
    card_label: firstPayloadCell(rawPayload, ["card_label", "信用卡名稱"]),
    consume_date: normalizeDateValue(
      firstPayloadCell(rawPayload, ["consume_date", "消費日期"]),
    ),
    posting_date: normalizeDateValue(
      firstPayloadCell(rawPayload, ["posting_date", "入帳日期"]),
    ),
    description: firstPayloadCell(rawPayload, ["description", "消費明細"]),
    country_currency: normalizeCurrencyCode(
      firstPayloadCell(rawPayload, ["country_currency", "國家/幣別"]),
    ),
    foreign_exchange_date: normalizeDateValue(
      payloadCell(rawPayload, "外幣折算日"),
    ),
    foreign_currency: normalizeCurrencyCode(
      firstPayloadCell(rawPayload, ["foreign_currency", "國家/幣別"]),
    ),
    foreign_amount: sqliteAmount(
      firstPayloadCell(rawPayload, ["foreign_amount", "外幣金額"]),
    ),
    twd_amount: sqliteAmount(
      firstPayloadCell(rawPayload, ["twd_amount", "新臺幣金額"]),
    ),
    installment_action: payloadCell(rawPayload, "installment_action"),
    payment_status: firstPayloadCell(rawPayload, [
      "payment_status",
      "繳費狀態",
    ]),
  };
}

function loanTransactionFields(context: ParserContext) {
  const { rawPayload, metadata } = context;
  const metadataLoanAccount = metadataCell(metadata, "貸款帳號");
  return {
    account_number:
      payloadCell(rawPayload, "貸款帳戶") ||
      accountNumberFromText(metadataLoanAccount) ||
      accountNameFromMetadataValue(metadataLoanAccount, ""),
    trade_date: normalizeDateValue(
      firstPayloadCell(rawPayload, ["交易日期", "交易日"]),
    ),
    posting_date: normalizeDateValue(payloadCell(rawPayload, "記帳日")),
    item: firstPayloadCell(rawPayload, ["交易內容", "繳款項目"]),
    interest_start_date: normalizeDateValue(
      firstPayloadCell(rawPayload, ["計息起日", "提息起日"]),
    ),
    interest_end_date: normalizeDateValue(
      firstPayloadCell(rawPayload, ["計息止日", "提息迄日"]),
    ),
    amount: sqliteAmount(firstPayloadCell(rawPayload, ["異動金額", "交易金額"])),
    interest_rate: payloadCell(rawPayload, "利率"),
    balance_after: sqliteAmount(
      firstPayloadCell(rawPayload, ["餘額", "交易後餘額"]),
    ),
    overpayment: sqliteAmount(payloadCell(rawPayload, "溢繳款")),
    note: payloadCell(rawPayload, "備註"),
  };
}

function fundHoldingFields(context: ParserContext) {
  const { rawPayload } = context;
  return {
    data_type: payloadCell(rawPayload, "資料類別"),
    fund_id: payloadCell(rawPayload, "基金識別"),
    query_period: payloadCell(rawPayload, "查詢期間"),
    fund_name: payloadCell(rawPayload, "基金名稱"),
    fund_type: payloadCell(rawPayload, "基金類型"),
    currency: normalizeCurrencyCode(payloadCell(rawPayload, "投資幣別")),
    investment_amount: sqliteAmount(payloadCell(rawPayload, "投資金額")),
    market_value_without_dividend: sqliteAmount(
      payloadCell(rawPayload, "不含息參考市值"),
    ),
    unrealized_pnl_without_dividend: sqliteAmount(
      payloadCell(rawPayload, "不含息參考損益"),
    ),
    return_rate_without_dividend: payloadCell(rawPayload, "不含息參考報酬率"),
    unrealized_pnl_with_dividend: sqliteAmount(
      payloadCell(rawPayload, "含息參考損益"),
    ),
    return_rate_with_dividend: payloadCell(rawPayload, "含息參考報酬率"),
    holding_status: payloadCell(rawPayload, "狀態"),
  };
}

function fundBuyTransactionFields(context: ParserContext) {
  const { rawPayload } = context;
  const currency = normalizeCurrencyCode(payloadCell(rawPayload, "投資金額"), "TWD");
  return {
    data_type: payloadCell(rawPayload, "資料類別"),
    fund_id: payloadCell(rawPayload, "基金識別"),
    query_period: payloadCell(rawPayload, "查詢期間"),
    investment_date: normalizeDateValue(payloadCell(rawPayload, "投資日期")),
    fund_name: payloadCell(rawPayload, "基金名稱"),
    transaction_number: payloadCell(rawPayload, "交易編號"),
    currency,
    investment_amount: sqliteAmount(payloadCell(rawPayload, "投資金額")),
    subscription_fx_rate: sqliteAmount(payloadCell(rawPayload, "申購匯率")),
    subscription_nav: sqliteAmount(payloadCell(rawPayload, "申購淨值")),
    subscription_fee: sqliteAmount(payloadCell(rawPayload, "申購手續費")),
    subscription_fee_currency: normalizeCurrencyCode(
      payloadCell(rawPayload, "申購手續費"),
      currency,
    ),
    point_discount: sqliteAmount(payloadCell(rawPayload, "點數折抵")),
    subscribed_units: sqliteAmount(payloadCell(rawPayload, "申購單位數")),
  };
}

function fundRedemptionTransactionFields(context: ParserContext) {
  const { rawPayload } = context;
  return {
    data_type: payloadCell(rawPayload, "資料類別"),
    fund_id: payloadCell(rawPayload, "基金識別"),
    query_period: payloadCell(rawPayload, "查詢期間"),
    redemption_date: normalizeDateValue(payloadCell(rawPayload, "贖回日期")),
    distribution_date: normalizeDateValue(payloadCell(rawPayload, "分配日期")),
    fund_name: payloadCell(rawPayload, "基金名稱"),
    transaction_number: payloadCell(rawPayload, "交易編號"),
    redemption_investment_amount: sqliteAmount(
      payloadCell(rawPayload, "贖回投資金額"),
    ),
    redemption_units: sqliteAmount(payloadCell(rawPayload, "贖回單位數")),
    redemption_price: sqliteAmount(payloadCell(rawPayload, "贖回價格")),
    redemption_fx_rate: sqliteAmount(payloadCell(rawPayload, "贖回匯率")),
    trust_management_fee: sqliteAmount(payloadCell(rawPayload, "信託管理費")),
    short_term_fee: sqliteAmount(payloadCell(rawPayload, "短線費用")),
    deferred_fee: sqliteAmount(payloadCell(rawPayload, "遞延手續費")),
    deposit_account: payloadCell(rawPayload, "入帳帳號"),
    net_deposit_amount: sqliteAmount(payloadCell(rawPayload, "入帳淨額")),
    reference_pnl: sqliteAmount(payloadCell(rawPayload, "贖回參考損益")),
    reference_return_rate: payloadCell(rawPayload, "參考贖回報酬率"),
    note: payloadCell(rawPayload, "備註"),
  };
}

function fundCashDividendFields(context: ParserContext) {
  const { rawPayload } = context;
  const distributionCurrency = normalizeCurrencyCode(payloadCell(rawPayload, "分配金額"), "TWD");
  return {
    data_type: payloadCell(rawPayload, "資料類別"),
    fund_id: payloadCell(rawPayload, "基金識別"),
    query_period: payloadCell(rawPayload, "查詢期間"),
    deposit_date: normalizeDateValue(payloadCell(rawPayload, "入帳日期")),
    fund_name: payloadCell(rawPayload, "基金名稱"),
    transaction_number: payloadCell(rawPayload, "交易編號"),
    benchmark_date: normalizeDateValue(payloadCell(rawPayload, "基準日期")),
    currency: normalizeCurrencyCode(payloadCell(rawPayload, "計價幣別")),
    benchmark_units: sqliteAmount(payloadCell(rawPayload, "基準單位數")),
    distribution_amount: sqliteAmount(payloadCell(rawPayload, "分配金額")),
    distribution_currency: distributionCurrency,
    fx_rate: sqliteAmount(payloadCell(rawPayload, "匯率")),
    distribution_rate: payloadCell(rawPayload, "分配率"),
    deposit_account: payloadCell(rawPayload, "入帳帳號"),
  };
}

function fundConversionTransactionFields(context: ParserContext) {
  const { rawPayload } = context;
  return {
    data_type: payloadCell(rawPayload, "資料類別"),
    fund_id: payloadCell(rawPayload, "基金識別"),
    query_period: payloadCell(rawPayload, "查詢期間"),
    conversion_out_date: normalizeDateValue(payloadCell(rawPayload, "轉出日期")),
    conversion_in_date: normalizeDateValue(payloadCell(rawPayload, "轉入日期")),
    transaction_number: payloadCell(rawPayload, "交易編號"),
    from_fund_name: payloadCell(rawPayload, "轉出基金"),
    to_fund_name: payloadCell(rawPayload, "轉入基金"),
    conversion_investment_amount: sqliteAmount(
      payloadCell(rawPayload, "轉換投資金額"),
    ),
    from_units: sqliteAmount(payloadCell(rawPayload, "轉出單位數")),
    to_units: sqliteAmount(payloadCell(rawPayload, "轉入單位數")),
    from_nav: sqliteAmount(payloadCell(rawPayload, "轉出基金淨值")),
    to_nav: sqliteAmount(payloadCell(rawPayload, "轉入基金淨值")),
    conversion_fx_rate: sqliteAmount(payloadCell(rawPayload, "轉換匯率")),
    short_term_fee: sqliteAmount(payloadCell(rawPayload, "短線費用")),
    bank_conversion_fee: sqliteAmount(
      payloadCell(rawPayload, "銀行轉換手續費"),
    ),
    fund_company_conversion_fee: sqliteAmount(
      payloadCell(rawPayload, "基金公司轉換手續費"),
    ),
  };
}

function brokerageHoldingFields(context: ParserContext) {
  const { rawPayload } = context;
  return {
    as_of_date: normalizeDateValue(payloadCell(rawPayload, "as_of_date")),
    account_number: payloadCell(rawPayload, "account_number"),
    asset_type: payloadCell(rawPayload, "asset_type"),
    sub_category: payloadCell(rawPayload, "sub_category"),
    product_code: payloadCell(rawPayload, "product_code"),
    product_name: payloadCell(rawPayload, "product_name"),
    currency: normalizeCurrencyCode(payloadCell(rawPayload, "currency")),
    quantity: sqliteAmount(payloadCell(rawPayload, "quantity")),
    market_date: normalizeDateValue(payloadCell(rawPayload, "market_date")),
    market_price: sqliteAmount(payloadCell(rawPayload, "market_price")),
    market_value_original: sqliteAmount(
      payloadCell(rawPayload, "market_value_original"),
    ),
    market_value_twd: sqliteAmount(payloadCell(rawPayload, "market_value_twd")),
    cost_price: sqliteAmount(payloadCell(rawPayload, "cost_price")),
    cost_amount: sqliteAmount(payloadCell(rawPayload, "cost_amount")),
    unrealized_pnl_original: sqliteAmount(
      payloadCell(rawPayload, "unrealized_pnl_original"),
    ),
    unrealized_pnl_twd: sqliteAmount(
      payloadCell(rawPayload, "unrealized_pnl_twd"),
    ),
    return_rate: payloadCell(rawPayload, "return_rate"),
    fx_rate: sqliteAmount(payloadCell(rawPayload, "fx_rate")),
  };
}

function brokerageAssetSummaryFields(context: ParserContext) {
  const { rawPayload } = context;
  return {
    as_of_date: normalizeDateValue(payloadCell(rawPayload, "as_of_date")),
    asset_type: payloadCell(rawPayload, "asset_type"),
    asset_name: payloadCell(rawPayload, "asset_name"),
    asset_value_twd: sqliteAmount(payloadCell(rawPayload, "asset_value_twd")),
    unrealized_pnl_twd: sqliteAmount(payloadCell(rawPayload, "unrealized_pnl_twd")),
  };
}

function brokerageTradeTransactionFields(context: ParserContext) {
  const { rawPayload } = context;
  return {
    trade_date: normalizeDateValue(payloadCell(rawPayload, "trade_date")),
    account_number: payloadCell(rawPayload, "account_number"),
    asset_type: payloadCell(rawPayload, "asset_type"),
    trade_type: payloadCell(rawPayload, "trade_type"),
    sub_category: payloadCell(rawPayload, "sub_category"),
    product_code: payloadCell(rawPayload, "product_code"),
    product_name: payloadCell(rawPayload, "product_name"),
    currency: normalizeCurrencyCode(payloadCell(rawPayload, "currency")),
    action: payloadCell(rawPayload, "action"),
    quantity: sqliteAmount(payloadCell(rawPayload, "quantity")),
    price: sqliteAmount(payloadCell(rawPayload, "price")),
    gross_amount: sqliteAmount(payloadCell(rawPayload, "gross_amount")),
    fee: sqliteAmount(payloadCell(rawPayload, "fee")),
    tax: sqliteAmount(payloadCell(rawPayload, "tax")),
    settlement_amount: sqliteAmount(payloadCell(rawPayload, "settlement_amount")),
    settlement_currency: normalizeCurrencyCode(payloadCell(rawPayload, "settlement_currency")),
    realized_pnl: sqliteAmount(payloadCell(rawPayload, "realized_pnl")),
    cost_amount: sqliteAmount(payloadCell(rawPayload, "cost_amount")),
  };
}

function unsupportedStatementFields(context: ParserContext) {
  return {
    reason: "unsupported source file shape",
    headers_json: JSON.stringify(context.headers),
  };
}
