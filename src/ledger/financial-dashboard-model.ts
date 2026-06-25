import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  readFinancialDashboardData,
  type FinancialDashboardData,
} from "./financial-dashboard-repo.ts";
import type {
  AssetPosition,
  BatchRecord,
  BuildFinancialDashboardInput,
  Classification,
  CurrencyBucket,
  DashboardAccount,
  DashboardMetric,
  DashboardView,
  DailyAccountChange,
  DailyAssetHistoryPoint,
  FinancialModel,
  FinancialTotals,
  ImportRunRecord,
  NormalizedTransaction,
  QualityIssue,
  AssetSnapshot,
  RawTransactionOccurrence,
  SnapshotAccountValue,
  SnapshotHistory,
} from "./financial-dashboard-types.ts";

export function stableId(parts: unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 24);
}

function cell(row: Record<string, unknown>, key: string): string {
  return String(row[key] ?? "").trim();
}

function firstCell(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = cell(row, key);
    if (value) return value;
  }
  return "";
}

function parseAmount(value: unknown): number | null {
  const raw = String(value ?? "")
    .replace(/\u00a0/g, " ")
    .trim();
  if (!raw || raw === "-" || raw === "--") return null;

  const negative =
    /^\(.*\)$/.test(raw) || raw.startsWith("-") || raw.endsWith("-");
  const normalized = raw
    .replace(/[,%\s]/g, "")
    .replace(/[()]/g, "")
    .replace(/^-/, "")
    .replace(/-$/, "");
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;

  const amount = Number(normalized);
  if (!Number.isFinite(amount)) return null;
  return negative ? -amount : amount;
}

function parseDate(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const iso = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) return formatDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    return formatDate(
      Number(compact[1]),
      Number(compact[2]),
      Number(compact[3]),
    );
  }

  const rocCompact = raw.match(/^(\d{3})(\d{2})(\d{2})$/);
  if (rocCompact) {
    return formatDate(
      Number(rocCompact[1]) + 1911,
      Number(rocCompact[2]),
      Number(rocCompact[3]),
    );
  }

  const slash = raw.match(/^(\d{1,4})[/-](\d{1,2})(?:[/-](\d{1,4}))?$/);
  if (slash && slash[3]) {
    const first = Number(slash[1]);
    const middle = Number(slash[2]);
    const last = Number(slash[3]);

    if (first >= 1900) return formatDate(first, middle, last);
    if (first >= 100) return formatDate(first + 1911, middle, last);
    if (last < 100) return formatDate(last + 2000, first, middle);
    return formatDate(last, first, middle);
  }

  return null;
}

function parseDateTime(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const timeMatch = raw.match(/(?:^|[T\s])(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
  const dateText = raw.replace(/[T\s]\d{1,2}:\d{2}(?::\d{2})?.*$/, "");
  const date = parseDate(dateText);
  if (!date) return null;

  if (!timeMatch) return `${date}T00:00:00`;
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = Number(timeMatch[3] ?? "0");
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }

  return `${date}T${hour.toString().padStart(2, "0")}:${minute
    .toString()
    .padStart(2, "0")}:${second.toString().padStart(2, "0")}`;
}

function rowDateTime(row: RawTransactionOccurrence, fallbackDate: string | null) {
  const directTime = firstCell(row, [
    "transaction_time",
    "occurred_at",
    "datetime",
    "date_time",
  ]);
  const directDateTime = parseDateTime(directTime);
  if (directDateTime) return directDateTime;

  const dateText =
    firstCell(row, [
      "transaction_date",
      "accounting_date",
      "trade_date",
      "posting_date",
      "consume_date",
      "investment_date",
      "redemption_date",
      "distribution_date",
      "deposit_date",
      "benchmark_date",
      "conversion_out_date",
      "conversion_in_date",
      "as_of_date",
      "market_date",
    ]) ||
    fallbackDate ||
    "";
  if (directTime && /\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(directTime)) {
    const combined = parseDateTime(`${dateText} ${directTime}`);
    if (combined) return combined;
  }

  return parseDateTime(dateText) ?? (fallbackDate ? `${fallbackDate}T00:00:00` : null);
}

function parseStatementPeriod(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^(\d{3,4})[/-](\d{1,2})/);
  if (!match) return null;

  const year = Number(match[1]);
  return formatDate(year < 1900 ? year + 1911 : year, Number(match[2]), 1);
}

function formatDate(year: number, month: number, day: number): string | null {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }

  return `${year.toString().padStart(4, "0")}-${month
    .toString()
    .padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function institutionLabel(bank: string): string {
  const labels: Record<string, string> = {
    cathay: "Cathay",
    fubon: "Fubon",
    yuanta: "Yuanta",
  };
  return labels[bank] ?? bank;
}

function normalizeCurrency(value: string, fallback = "TWD"): string {
  const raw = value.trim();
  if (!raw) return fallback;
  const normalized = raw.toUpperCase();
  const aliases: Record<string, string> = {
    "台幣": "TWD",
    "臺幣": "TWD",
    "新台幣": "TWD",
    "新臺幣": "TWD",
    "NTD": "TWD",
    "NT$": "TWD",
    "美元": "USD",
    "美金": "USD",
    "美圓": "USD",
    "日圓": "JPY",
    "日幣": "JPY",
    "日元": "JPY",
  };
  return aliases[raw] ?? aliases[normalized] ?? normalized;
}

function maskIdentifier(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length >= 4) return `****${digits.slice(-4)}`;

  const compact = value.replace(/[^\p{L}\p{N}_-]/gu, "");
  if (!compact) return "unknown";
  if (compact.length <= 4) return compact;
  return `****${compact.slice(-4)}`;
}

function sourceAccount(row: RawTransactionOccurrence, explicit = ""): string {
  if (explicit) return maskIdentifier(explicit);
  const typedAccount = firstCell(row, [
    "account_number",
    "card_number",
  ]);
  if (typedAccount) return maskIdentifier(typedAccount);
  const typedAccountName = firstCell(row, [
    "account_name",
    "card_label",
  ]);
  if (typedAccountName) return maskIdentifier(typedAccountName);
  return `source:${row.sourceRelativePath}`;
}

function fundAccountId(label: string): string {
  return stableId(["fund", label.trim()]);
}

function baseTransaction(
  row: RawTransactionOccurrence,
  parserId: string,
  type: NormalizedTransaction["type"],
  accountId: string,
  currency: string,
  date: string | null,
): Omit<
  NormalizedTransaction,
  | "description"
  | "inflow"
  | "outflow"
  | "amountSigned"
  | "balanceAfter"
  | "status"
  | "includeInCashFlow"
  | "warnings"
> {
  return {
    id: stableId(["transaction", row.sourceHash, parserId]),
    sourceHash: row.sourceHash,
    sourceRelativePath: row.sourceRelativePath,
    sourceRowIndex: row.sourceRowIndex,
    institution: institutionLabel(row.bank),
    product: row.product,
    parserId,
    type,
    accountId,
    accountLabel: accountId,
    currency,
    date,
    occurredAt: rowDateTime(row, date),
  };
}

function positionFromRow(
  row: RawTransactionOccurrence,
  parserId: string,
  assetClass: AssetPosition["assetClass"],
  accountId: string,
  currency: string,
  value: number,
  valueSign: AssetPosition["valueSign"],
  asOfDate: string | null,
  options: {
    label?: string;
    valueTwd?: number | null;
    includeInTotals?: boolean;
    confidence?: AssetPosition["confidence"];
    warnings?: string[];
  } = {},
): AssetPosition {
  return {
    id: stableId(["position", parserId, accountId, currency, row.sourceHash]),
    institution: institutionLabel(row.bank),
    product: row.product,
    parserId,
    assetClass,
    accountId,
    label: options.label ?? accountId,
    currency,
    value,
    valueTwd: options.valueTwd ?? null,
    valueSign,
    includeInTotals: options.includeInTotals ?? true,
    asOfDate,
    asOfDateTime: rowDateTime(row, asOfDate),
    sourceRelativePath: row.sourceRelativePath,
    sourceRowIndex: row.sourceRowIndex,
    confidence: options.confidence ?? "high",
    warnings: options.warnings ?? [],
  };
}

function classifyDepositRow(
  row: RawTransactionOccurrence,
): Classification | null {
  const p = row;
  const bankProduct = `${row.bank}/${row.product}`;

  if (
    row.statementTable === "account_transactions" &&
    bankProduct === "cathay/statements" &&
    cell(p, "accounting_date")
  ) {
    const accountId = sourceAccount(row);
    const date = parseDate(firstCell(p, ["transaction_date", "accounting_date"]));
    const inflow = parseAmount(cell(p, "deposit_amount"));
    const outflow = parseAmount(cell(p, "withdrawal_amount"));
    const balanceAfter = parseAmount(cell(p, "balance_after"));
    const transaction: NormalizedTransaction = {
      ...baseTransaction(row, "cathay.deposit.v2", "deposit", accountId, "TWD", date),
      description: [cell(p, "description"), cell(p, "note")]
        .filter(Boolean)
        .join(" "),
      inflow,
      outflow,
      amountSigned: (inflow ?? 0) - (outflow ?? 0),
      balanceAfter,
      status: "posted",
      includeInCashFlow: true,
      warnings: balanceAfter === null ? ["missing balance"] : [],
    };
    return { row, transactions: [transaction], positions: [] };
  }

  if (
    row.statementTable === "foreign_currency_transactions" &&
    bankProduct === "cathay/foreign-statements" &&
    cell(p, "accounting_date")
  ) {
    const accountId = sourceAccount(row);
    const currency = normalizeCurrency(cell(p, "currency"), "UNKNOWN");
    const date = parseDate(firstCell(p, ["transaction_date", "accounting_date"]));
    const inflow = parseAmount(cell(p, "deposit_amount"));
    const outflow = parseAmount(cell(p, "withdrawal_amount"));
    const balanceAfter = parseAmount(cell(p, "balance_after"));
    const transaction: NormalizedTransaction = {
      ...baseTransaction(
        row,
        "cathay.foreign-deposit.v2",
        "foreign_deposit",
        accountId,
        currency,
        date,
      ),
      description: [cell(p, "description"), cell(p, "note")]
        .filter(Boolean)
        .join(" "),
      inflow,
      outflow,
      amountSigned: (inflow ?? 0) - (outflow ?? 0),
      balanceAfter,
      status: "posted",
      includeInCashFlow: true,
      warnings: balanceAfter === null ? ["missing balance"] : [],
    };
    return { row, transactions: [transaction], positions: [] };
  }

  if (row.statementTable === "account_transactions" && bankProduct === "fubon/statements") {
    const accountId = sourceAccount(row);
    const date = parseDate(firstCell(p, ["transaction_date", "accounting_date"]));
    const inflow = parseAmount(cell(p, "deposit_amount"));
    const outflow = parseAmount(cell(p, "withdrawal_amount"));
    const balanceAfter = parseAmount(cell(p, "balance_after"));
    const transaction: NormalizedTransaction = {
      ...baseTransaction(row, "fubon.deposit.v1", "deposit", accountId, "TWD", date),
      description: [cell(p, "description"), cell(p, "note")]
        .filter(Boolean)
        .join(" "),
      inflow,
      outflow,
      amountSigned: (inflow ?? 0) - (outflow ?? 0),
      balanceAfter,
      status: "posted",
      includeInCashFlow: true,
      warnings: balanceAfter === null ? ["missing balance"] : [],
    };
    return { row, transactions: [transaction], positions: [] };
  }

  if (row.statementTable === "account_transactions" && bankProduct === "yuanta/statements") {
    const accountId = sourceAccount(row);
    const date = parseDate(firstCell(p, ["transaction_date", "accounting_date"]));
    const inflow = parseAmount(cell(p, "deposit_amount"));
    const outflow = parseAmount(cell(p, "withdrawal_amount"));
    const balanceAfter = parseAmount(cell(p, "balance_after"));
    const transaction: NormalizedTransaction = {
      ...baseTransaction(row, "yuanta.deposit.v1", "deposit", accountId, "TWD", date),
      description: [cell(p, "description"), cell(p, "note")]
        .filter(Boolean)
        .join(" "),
      inflow,
      outflow,
      amountSigned: (inflow ?? 0) - (outflow ?? 0),
      balanceAfter,
      status: "posted",
      includeInCashFlow: true,
      warnings: balanceAfter === null ? ["missing balance"] : [],
    };
    return { row, transactions: [transaction], positions: [] };
  }

  if (
    row.statementTable === "foreign_currency_transactions" &&
    bankProduct === "yuanta/foreign-currency-statements"
  ) {
    const accountId = sourceAccount(row);
    const currency = normalizeCurrency(cell(p, "currency"), "UNKNOWN");
    const date = parseDate(firstCell(p, ["transaction_date", "accounting_date"]));
    const inflow = parseAmount(cell(p, "deposit_amount"));
    const outflow = parseAmount(cell(p, "withdrawal_amount"));
    const balanceAfter = parseAmount(cell(p, "balance_after"));
    const transaction: NormalizedTransaction = {
      ...baseTransaction(
        row,
        "yuanta.foreign-deposit.v1",
        "foreign_deposit",
        accountId,
        currency,
        date,
      ),
      description: [cell(p, "description"), cell(p, "note")]
        .filter(Boolean)
        .join(" "),
      inflow,
      outflow,
      amountSigned: (inflow ?? 0) - (outflow ?? 0),
      balanceAfter,
      status: "posted",
      includeInCashFlow: true,
      warnings: balanceAfter === null ? ["missing balance"] : [],
    };
    return { row, transactions: [transaction], positions: [] };
  }

  return null;
}

function classifyLoanRow(row: RawTransactionOccurrence): Classification | null {
  const p = row;
  const bankProduct = `${row.bank}/${row.product}`;

  if (
    row.statementTable === "loan_transactions" &&
    bankProduct === "fubon/loan-statements" &&
    cell(p, "balance_after")
  ) {
    const accountId = sourceAccount(row);
    const date = parseDate(cell(p, "trade_date"));
    const amount = parseAmount(cell(p, "amount"));
    const balanceAfter = parseAmount(cell(p, "balance_after"));
    const transaction: NormalizedTransaction = {
      ...baseTransaction(row, "fubon.loan.v1", "loan", accountId, "TWD", date),
      description: cell(p, "item"),
      inflow: null,
      outflow: amount,
      amountSigned: amount === null ? null : -amount,
      balanceAfter,
      status: "detail",
      includeInCashFlow: false,
      warnings: balanceAfter === null ? ["missing loan balance"] : [],
    };
    return { row, transactions: [transaction], positions: [] };
  }

  if (
    row.statementTable === "loan_transactions" &&
    bankProduct === "yuanta/loan-statements"
  ) {
    const accountId = sourceAccount(row);
    const date = parseDate(cell(p, "trade_date"));
    const amount = parseAmount(cell(p, "amount"));
    const balanceAfter = parseAmount(cell(p, "balance_after"));
    const transaction: NormalizedTransaction = {
      ...baseTransaction(row, "yuanta.loan.v1", "loan", accountId, "TWD", date),
      description: cell(p, "item"),
      inflow: null,
      outflow: amount,
      amountSigned: amount === null ? null : -amount,
      balanceAfter,
      status: "payment",
      includeInCashFlow: false,
      warnings: balanceAfter === null ? ["missing loan balance"] : [],
    };
    return { row, transactions: [transaction], positions: [] };
  }

  return null;
}

function classifyCreditCardRow(
  row: RawTransactionOccurrence,
): Classification | null {
  const p = row;
  const bankProduct = `${row.bank}/${row.product}`;

  if (
    row.statementTable === "credit_card_statement_lines" &&
    bankProduct === "fubon/credit-card-statements"
  ) {
    const date = parseDate(firstCell(p, ["posting_date", "consume_date"]));
    const amount = parseAmount(cell(p, "twd_amount"));
    if (amount === null) {
      return {
        row,
        transactions: [],
        positions: [],
        auditOnlyReason: "fubon credit-card row has no TWD amount",
      };
    }
    if (
      cell(p, "description") === "本期應繳總額" &&
      cell(p, "card_label") &&
      amount > 0
    ) {
      const accountId = sourceAccount(row, cell(p, "card_label"));
      const position = positionFromRow(
        row,
        "fubon.credit-card-current-due.v1",
        "credit_card",
        accountId,
        "TWD",
        amount,
        "liability",
        parseStatementPeriod(cell(p, "statement_period")),
        {
          label: accountId,
          confidence: "medium",
          warnings: ["derived from statement current due summary"],
        },
      );
      return { row, transactions: [], positions: [position] };
    }
    if (date === null && !firstCell(p, ["card_last_four", "card_number", "card_label"])) {
      return {
        row,
        transactions: [],
        positions: [],
        auditOnlyReason: "fubon credit-card statement summary row is not a transaction",
      };
    }

    const explicitAccount = firstCell(p, [
      "card_last_four",
      "card_number",
      "card_label",
    ]);
    const accountId = explicitAccount
      ? sourceAccount(row, explicitAccount)
      : "Fubon credit card";
    const transaction: NormalizedTransaction = {
      ...baseTransaction(
        row,
        "fubon.credit-card-transaction.v1",
        "credit_card",
        accountId,
        "TWD",
        date,
      ),
      description: cell(p, "description"),
      inflow: amount < 0 ? Math.abs(amount) : null,
      outflow: amount > 0 ? amount : null,
      amountSigned: -amount,
      balanceAfter: null,
      status: cell(p, "statement_type") === "unbilled"
        ? "unbilled"
        : amount < 0
          ? "payment"
          : "posted",
      includeInCashFlow: true,
      warnings: ["transaction row only; no statement liability balance"],
    };
    return { row, transactions: [transaction], positions: [] };
  }

  if (
    row.statementTable === "credit_card_statement_lines" &&
    bankProduct === "yuanta/credit-card-statements"
  ) {
    const explicitAccount = firstCell(p, ["card_number", "card_label"]);
    const accountId = explicitAccount
      ? sourceAccount(row, explicitAccount)
      : "Yuanta credit card";

    if (cell(p, "twd_amount")) {
      const date = parseDate(firstCell(p, ["posting_date", "consume_date"]));
      const amount = parseAmount(cell(p, "twd_amount"));
      if (amount !== null) {
        const transaction: NormalizedTransaction = {
          ...baseTransaction(
            row,
            "yuanta.credit-card-transaction.v2",
            "credit_card",
            accountId,
            "TWD",
            date,
          ),
          accountLabel: firstCell(p, ["card_label", "card_number"]) || accountId,
          description: cell(p, "description"),
          inflow: amount < 0 ? Math.abs(amount) : null,
          outflow: amount > 0 ? amount : null,
          amountSigned: -amount,
          balanceAfter: null,
          status: cell(p, "statement_type") === "unbilled"
            ? "unbilled"
            : amount < 0
              ? "payment"
              : "posted",
          includeInCashFlow: true,
          warnings: ["transaction row only; no statement liability balance"],
        };
        return { row, transactions: [transaction], positions: [] };
      }
    }

    return {
      row,
      transactions: [],
      positions: [],
      auditOnlyReason: "yuanta credit-card metadata or summary row not used in balance",
    };
  }

  return null;
}

function classifyFundRow(row: RawTransactionOccurrence): Classification | null {
  const p = row;
  if (`${row.bank}/${row.product}` !== "yuanta/fund-statements") return null;

  if (row.statementTable === "fund_holdings") {
    const value = parseAmount(cell(p, "market_value_without_dividend"));
    if (value !== null) {
      const currency = normalizeCurrency(cell(p, "currency"));
      const fundLabel = cell(p, "fund_name");
      const position = positionFromRow(
        row,
        "yuanta.fund-position.v1",
        "fund",
        fundAccountId(fundLabel),
        currency,
        value,
        "asset",
        null,
        {
          label: fundLabel,
          confidence: "medium",
          warnings: ["fund market value uses no explicit valuation date"],
        },
      );
      return { row, transactions: [], positions: [position] };
    }
  }

  if (row.statementTable === "fund_buy_transactions") {
    const amount = parseAmount(cell(p, "investment_amount"));
    const date = parseDate(cell(p, "investment_date"));
    if (amount !== null) {
      const fundLabel = cell(p, "fund_name");
      const transaction: NormalizedTransaction = {
        ...baseTransaction(
          row,
          "yuanta.fund-buy.v2",
          "investment",
          fundAccountId(fundLabel),
          "TWD",
          date,
        ),
        accountLabel: fundLabel,
        description: `申購 ${fundLabel}`,
        inflow: amount,
        outflow: null,
        amountSigned: amount,
        balanceAfter: null,
        status: "posted",
        includeInCashFlow: false,
        warnings: ["fund buy is an asset transfer; not included in cash flow"],
      };
      return { row, transactions: [transaction], positions: [] };
    }
  }

  if (row.statementTable === "fund_redemption_transactions") {
    const amount = parseAmount(
      firstCell(p, ["net_deposit_amount", "redemption_investment_amount"]),
    );
    if (amount !== null) {
      const fundLabel = cell(p, "fund_name");
      const transaction: NormalizedTransaction = {
        ...baseTransaction(
          row,
          "yuanta.fund-redemption.v2",
          "investment",
          fundAccountId(fundLabel),
          "TWD",
          parseDate(firstCell(p, ["distribution_date", "redemption_date"])),
        ),
        accountLabel: fundLabel,
        description: `贖回 ${fundLabel}`,
        inflow: null,
        outflow: amount,
        amountSigned: -amount,
        balanceAfter: null,
        status: "posted",
        includeInCashFlow: false,
        warnings: ["fund redemption is an asset transfer; not included in cash flow"],
      };
      return { row, transactions: [transaction], positions: [] };
    }
  }

  if (row.statementTable === "fund_cash_dividends") {
    const amount = parseAmount(cell(p, "distribution_amount"));
    const fundLabel = cell(p, "fund_name");
    if (amount !== null && fundLabel) {
      const transaction: NormalizedTransaction = {
        ...baseTransaction(
          row,
          "yuanta.fund-cash-dividend.v2",
          "investment",
          fundAccountId(fundLabel),
          normalizeCurrency(cell(p, "currency")),
          parseDate(cell(p, "deposit_date")),
        ),
        accountLabel: fundLabel,
        description: `現金配息 ${fundLabel}`,
        inflow: amount,
        outflow: null,
        amountSigned: amount,
        balanceAfter: null,
        status: "dividend",
        includeInCashFlow: true,
        warnings: [],
      };
      return { row, transactions: [transaction], positions: [] };
    }
  }

  if (row.statementTable === "fund_conversion_transactions") {
    const amount = parseAmount(cell(p, "conversion_investment_amount"));
    if (amount !== null) {
      const fromLabel = cell(p, "from_fund_name");
      const toLabel = cell(p, "to_fund_name");
      const conversionOut: NormalizedTransaction = {
        ...baseTransaction(
          row,
          "yuanta.fund-conversion-out.v2",
          "investment",
          fundAccountId(fromLabel),
          "TWD",
          parseDate(cell(p, "conversion_out_date")),
        ),
        accountLabel: fromLabel,
        description: `轉換轉出 ${fromLabel} -> ${toLabel}`,
        inflow: null,
        outflow: amount,
        amountSigned: -amount,
        balanceAfter: null,
        status: "posted",
        includeInCashFlow: false,
        warnings: ["fund conversion is informational; not included in cash flow"],
      };
      const conversionIn: NormalizedTransaction = {
        ...baseTransaction(
          row,
          "yuanta.fund-conversion-in.v2",
          "investment",
          fundAccountId(toLabel),
          "TWD",
          parseDate(cell(p, "conversion_in_date")),
        ),
        accountLabel: toLabel,
        description: `轉換轉入 ${fromLabel} -> ${toLabel}`,
        inflow: amount,
        outflow: null,
        amountSigned: amount,
        balanceAfter: null,
        status: "posted",
        includeInCashFlow: false,
        warnings: ["fund conversion is informational; not included in cash flow"],
      };
      return { row, transactions: [conversionOut, conversionIn], positions: [] };
    }
  }

  return {
    row,
    transactions: [],
    positions: [],
    auditOnlyReason: "yuanta fund row is metadata, dividend, order, or combined-cell detail",
  };
}

function classifyBrokerageRow(
  row: RawTransactionOccurrence,
): Classification | null {
  const p = row;
  if (`${row.bank}/${row.product}` !== "yuanta/trade-statements") return null;

  if (row.statementTable === "brokerage_holdings") {
    const valueTwd = parseAmount(cell(p, "market_value_twd"));
    if (valueTwd !== null) {
      const currency = normalizeCurrency(cell(p, "currency"), "UNKNOWN");
      const value = parseAmount(cell(p, "market_value_original")) ?? valueTwd;
      const position = positionFromRow(
        row,
        "yuanta.brokerage-holding.v2",
        "brokerage",
        sourceAccount(row, cell(p, "account_number")),
        currency,
        value,
        "asset",
        parseDate(firstCell(p, ["as_of_date", "market_date"])),
        {
          label: [cell(p, "product_code"), cell(p, "product_name")]
            .filter(Boolean)
            .join(" "),
          valueTwd,
          confidence: "high",
        },
      );
      return { row, transactions: [], positions: [position] };
    }
  }

  if (row.statementTable === "brokerage_asset_summaries") {
    const value = parseAmount(cell(p, "asset_value_twd"));
    if (value !== null) {
      const position = positionFromRow(
        row,
        "yuanta.brokerage-summary-rollup.v2",
        "brokerage_rollup",
        stableId(["brokerage-rollup", row.sourceRelativePath, cell(p, "asset_name")]),
        "TWD",
        value,
        "informational",
        parseDate(cell(p, "as_of_date")),
        {
          label: [cell(p, "asset_type"), cell(p, "asset_name")]
            .filter(Boolean)
            .join(" "),
          includeInTotals: false,
          confidence: "low",
          warnings: [
            "summary rollup is excluded from totals to avoid double-counting detailed holdings",
          ],
        },
      );
      return { row, transactions: [], positions: [position] };
    }
  }

  if (row.statementTable === "brokerage_trade_transactions") {
    const amount = parseAmount(cell(p, "settlement_amount"));
    const action = cell(p, "action") || cell(p, "trade_type");
    const isInflow = /賣|賣出|sell|配息|股息|息/i.test(action);
    const transaction: NormalizedTransaction = {
      ...baseTransaction(
        row,
        "yuanta.brokerage-trade.v2",
        "brokerage",
        sourceAccount(row, cell(p, "account_number")),
        normalizeCurrency(
          firstCell(p, ["settlement_currency", "currency"]),
          "UNKNOWN",
        ),
        parseDate(cell(p, "trade_date")),
      ),
      description: [action, cell(p, "product_code"), cell(p, "product_name")]
        .filter(Boolean)
        .join(" "),
      inflow: isInflow ? amount : null,
      outflow: isInflow ? null : amount,
      amountSigned: amount === null ? null : isInflow ? amount : -amount,
      balanceAfter: null,
      status: /配息|股息|息/i.test(action) ? "dividend" : "posted",
      includeInCashFlow: false,
      warnings: isInflow ? [] : ["trade cash-flow direction is not normalized yet"],
    };
    return { row, transactions: [transaction], positions: [] };
  }

  return {
    row,
    transactions: [],
    positions: [],
    auditOnlyReason: "yuanta trade row is summary label, empty category, or unsupported grid",
  };
}

function dashboardRows(data: FinancialDashboardData): RawTransactionOccurrence[] {
  return [
    ...data.accountTransactions,
    ...data.foreignCurrencyTransactions,
    ...data.creditCardStatementLines,
    ...data.loanTransactions,
    ...data.fundHoldings,
    ...data.fundBuyTransactions,
    ...data.fundRedemptionTransactions,
    ...data.fundCashDividends,
    ...data.fundConversionTransactions,
    ...data.brokerageHoldings,
    ...data.brokerageAssetSummaries,
    ...data.brokerageTradeTransactions,
    ...data.unsupportedStatementRows,
  ];
}

function classifyWith(
  rows: RawTransactionOccurrence[],
  classifier: (row: RawTransactionOccurrence) => Classification | null,
): Classification[] {
  return rows.map(
    (row) =>
      classifier(row) ?? {
        row,
        transactions: [],
        positions: [],
        unsupportedReason: `no model builder matched ${row.statementTable}`,
      },
  );
}

function classifyDashboardData(
  data: FinancialDashboardData,
  keepRow: (row: RawTransactionOccurrence) => boolean,
): Classification[] {
  const accountTransactions = data.accountTransactions.filter(keepRow);
  const foreignCurrencyTransactions =
    data.foreignCurrencyTransactions.filter(keepRow);
  const creditCardStatementLines =
    data.creditCardStatementLines.filter(keepRow);
  const loanTransactions = data.loanTransactions.filter(keepRow);
  const fundRows = [
    ...data.fundHoldings,
    ...data.fundBuyTransactions,
    ...data.fundRedemptionTransactions,
    ...data.fundCashDividends,
    ...data.fundConversionTransactions,
  ].filter(keepRow);
  const brokerageRows = [
    ...data.brokerageHoldings,
    ...data.brokerageAssetSummaries,
    ...data.brokerageTradeTransactions,
  ].filter(keepRow);
  const unsupportedRows = data.unsupportedStatementRows.filter(keepRow);

  return [
    ...classifyWith(accountTransactions, classifyDepositRow),
    ...classifyWith(foreignCurrencyTransactions, classifyDepositRow),
    ...classifyWith(creditCardStatementLines, classifyCreditCardRow),
    ...classifyWith(loanTransactions, classifyLoanRow),
    ...classifyWith(fundRows, classifyFundRow),
    ...classifyWith(brokerageRows, classifyBrokerageRow),
    ...unsupportedRows.map((row) => ({
      row,
      transactions: [],
      positions: [],
      unsupportedReason: cell(row, "reason") || "unsupported statement row",
    })),
  ];
}

function pickLatestSnapshotPositions(
  transactions: NormalizedTransaction[],
  sourceRows: Map<string, RawTransactionOccurrence>,
): AssetPosition[] {
  const latest = new Map<string, NormalizedTransaction>();

  for (const transaction of transactions) {
    if (transaction.balanceAfter === null) continue;
    const key = [
      transaction.parserId,
      transaction.accountId,
      transaction.currency,
      transaction.type,
    ].join("|");
    const previous = latest.get(key);
    if (!previous || compareTransactionDate(transaction, previous) > 0) {
      latest.set(key, transaction);
    }
  }

  const positions: AssetPosition[] = [];
  for (const transaction of latest.values()) {
    const sourceRow = sourceRows.get(transaction.sourceHash);
    if (!sourceRow || transaction.balanceAfter === null) continue;

    if (transaction.type === "loan") {
      positions.push(
        positionFromRow(
          sourceRow,
          `${transaction.parserId}.snapshot`,
          "loan",
          transaction.accountId,
          transaction.currency,
          transaction.balanceAfter,
          "liability",
          transaction.date,
          {
            label: `${transaction.institution} loan ${transaction.accountId}`,
            confidence: "high",
          },
        ),
      );
      continue;
    }

    positions.push(
      positionFromRow(
        sourceRow,
        `${transaction.parserId}.snapshot`,
        transaction.type === "foreign_deposit" ? "foreign_cash" : "cash",
        transaction.accountId,
        transaction.currency,
        transaction.balanceAfter,
        "asset",
        transaction.date,
        {
          label: `${transaction.institution} ${transaction.accountId}`,
          confidence: "high",
        },
      ),
    );
  }

  return positions;
}

function pickCreditCardLiabilityPositions(
  transactions: NormalizedTransaction[],
  sourceRows: Map<string, RawTransactionOccurrence>,
): AssetPosition[] {
  const byAccount = new Map<
    string,
    {
      transaction: NormalizedTransaction;
      value: number;
    }
  >();

  for (const transaction of transactions) {
    if (transaction.type !== "credit_card") continue;
    if (transaction.status !== "unbilled") continue;
    if (transaction.amountSigned === null || transaction.amountSigned >= 0) continue;

    const key = [transaction.accountId, transaction.currency].join("|");
    const previous = byAccount.get(key);
    const value = Math.abs(transaction.amountSigned);
    if (!previous) {
      byAccount.set(key, { transaction, value });
      continue;
    }

    previous.value += value;
    if (compareTransactionDate(transaction, previous.transaction) >= 0) {
      previous.transaction = transaction;
    }
  }

  const positions: AssetPosition[] = [];
  for (const { transaction, value } of byAccount.values()) {
    const sourceRow = sourceRows.get(transaction.sourceHash);
    if (!sourceRow || value <= 0) continue;
    positions.push(
      positionFromRow(
        sourceRow,
        "credit-card-unbilled.snapshot",
        "credit_card",
        transaction.accountId,
        transaction.currency,
        value,
        "liability",
        transaction.date,
        {
          label: transaction.accountLabel || transaction.accountId,
          confidence: "medium",
          warnings: ["derived from current unbilled credit-card transactions"],
        },
      ),
    );
  }

  return positions;
}

function compareTransactionDate(
  left: NormalizedTransaction,
  right: NormalizedTransaction,
): number {
  const leftDateTime =
    left.occurredAt ?? (left.date ? `${left.date}T00:00:00` : "");
  const rightDateTime =
    right.occurredAt ?? (right.date ? `${right.date}T00:00:00` : "");
  if (leftDateTime !== rightDateTime) {
    return leftDateTime.localeCompare(rightDateTime);
  }
  return right.sourceRowIndex - left.sourceRowIndex;
}

function reducePositions(positions: AssetPosition[]): AssetPosition[] {
  const byKey = new Map<string, AssetPosition>();

  for (const position of positions) {
    const key = [
      position.parserId,
      position.accountId,
      position.label,
      position.currency,
      position.assetClass,
      position.includeInTotals,
    ].join("|");
    const previous = byKey.get(key);
    if (!previous || comparePositionFreshness(position, previous) >= 0) {
      byKey.set(key, position);
    }
  }

  return [...byKey.values()];
}

function comparePositionFreshness(left: AssetPosition, right: AssetPosition) {
  const leftDateTime =
    left.asOfDateTime ?? (left.asOfDate ? `${left.asOfDate}T00:00:00` : "");
  const rightDateTime =
    right.asOfDateTime ?? (right.asOfDate ? `${right.asOfDate}T00:00:00` : "");
  if (leftDateTime !== rightDateTime) {
    return leftDateTime.localeCompare(rightDateTime);
  }
  return right.sourceRowIndex - left.sourceRowIndex;
}

function rowImportRunId(row: RawTransactionOccurrence): string {
  return row.importRunId ?? `legacy:${row.sourceRelativePath}`;
}

function buildImportRunTimes(
  importRuns: ImportRunRecord[],
  batches: BatchRecord[],
): Map<string, string> {
  const times = new Map<string, string>();

  for (const run of importRuns) {
    times.set(
      run.importRunId,
      run.finishedAt ?? run.startedAt ?? new Date(0).toISOString(),
    );
  }

  for (const batch of batches) {
    if (!batch.importRunId) continue;
    if (times.has(batch.importRunId)) continue;
    if (batch.importedAt) times.set(batch.importRunId, batch.importedAt);
  }

  return times;
}

function importedAtForRow(
  row: RawTransactionOccurrence,
  importRunTimes: Map<string, string>,
): string {
  const runTime = importRunTimes.get(rowImportRunId(row));
  if (runTime) return runTime;
  const importedAt = String(row.importedAt ?? "");
  return importedAt || new Date(0).toISOString();
}

function transactionDeduplicationKey(transaction: NormalizedTransaction): string {
  return stableId([
    "normalized-transaction",
    transaction.institution,
    transaction.product,
    transaction.type,
    transaction.accountId,
    transaction.currency,
    transaction.date,
    transaction.description,
    transaction.status,
    transaction.inflow,
    transaction.outflow,
    transaction.amountSigned,
    transaction.balanceAfter,
  ]);
}

function compareTransactionOccurrenceFreshness(
  left: NormalizedTransaction,
  right: NormalizedTransaction,
  sourceRows: Map<string, RawTransactionOccurrence>,
  importRunTimes: Map<string, string>,
): number {
  const leftRow = sourceRows.get(left.sourceHash);
  const rightRow = sourceRows.get(right.sourceHash);
  const leftImportedAt = leftRow
    ? importedAtForRow(leftRow, importRunTimes)
    : "";
  const rightImportedAt = rightRow
    ? importedAtForRow(rightRow, importRunTimes)
    : "";
  if (leftImportedAt !== rightImportedAt) {
    return leftImportedAt.localeCompare(rightImportedAt);
  }
  if (left.sourceRelativePath !== right.sourceRelativePath) {
    return left.sourceRelativePath.localeCompare(right.sourceRelativePath);
  }
  return left.sourceRowIndex - right.sourceRowIndex;
}

function dedupeTransactions(
  transactions: NormalizedTransaction[],
  sourceRows: Map<string, RawTransactionOccurrence>,
  importRunTimes: Map<string, string>,
): {
  transactions: NormalizedTransaction[];
  duplicateCount: number;
} {
  const byKey = new Map<string, NormalizedTransaction>();
  let duplicateCount = 0;

  for (const transaction of transactions) {
    const key = transactionDeduplicationKey(transaction);
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, transaction);
      continue;
    }

    duplicateCount += 1;
    if (
      compareTransactionOccurrenceFreshness(
        transaction,
        previous,
        sourceRows,
        importRunTimes,
      ) >= 0
    ) {
      byKey.set(key, transaction);
    }
  }

  return { transactions: [...byKey.values()], duplicateCount };
}

function selectLatestCreditCardUnbilledTransactions(
  transactions: NormalizedTransaction[],
  sourceRows: Map<string, RawTransactionOccurrence>,
  importRunTimes: Map<string, string>,
): NormalizedTransaction[] {
  const latestRunByAccount = new Map<
    string,
    { importRunId: string; importedAt: string }
  >();

  for (const transaction of transactions) {
    if (transaction.type !== "credit_card") continue;
    if (transaction.status !== "unbilled") continue;
    const sourceRow = sourceRows.get(transaction.sourceHash);
    if (!sourceRow) continue;

    const importRunId = rowImportRunId(sourceRow);
    const importedAt = importedAtForRow(sourceRow, importRunTimes);
    const key = [transaction.accountId, transaction.currency].join("|");
    const previous = latestRunByAccount.get(key);
    if (!previous || previous.importedAt <= importedAt) {
      latestRunByAccount.set(key, { importRunId, importedAt });
    }
  }

  return transactions.filter((transaction) => {
    if (transaction.type !== "credit_card") return true;
    if (transaction.status !== "unbilled") return true;
    const sourceRow = sourceRows.get(transaction.sourceHash);
    if (!sourceRow) return false;
    const key = [transaction.accountId, transaction.currency].join("|");
    return latestRunByAccount.get(key)?.importRunId === rowImportRunId(sourceRow);
  });
}

function bucketFromTotals(
  totals: FinancialTotals,
  side: "assets" | "liabilities" | "net",
): CurrencyBucket {
  const bucket: CurrencyBucket = {};
  for (const [currency, value] of Object.entries(totals.includedByCurrency)) {
    bucket[currency] = value[side];
  }
  return bucket;
}

function subtractCurrencyBuckets(
  current: CurrencyBucket,
  previous: CurrencyBucket,
): CurrencyBucket {
  const bucket: CurrencyBucket = {};
  for (const currency of new Set([
    ...Object.keys(current),
    ...Object.keys(previous),
  ])) {
    const value = (current[currency] ?? 0) - (previous[currency] ?? 0);
    if (Math.abs(value) > 0.000001) bucket[currency] = value;
  }
  return bucket;
}

function snapshotAccounts(positions: AssetPosition[]): SnapshotAccountValue[] {
  return positions
    .filter((position) => position.includeInTotals)
    .map((position) => ({
      id: stableId([
        "snapshot-account",
        position.institution,
        position.product,
        position.assetClass,
        position.accountId,
        position.label,
        position.currency,
      ]),
      institution: sourceInstitutionForPosition(position),
      product: position.product,
      assetClass: position.assetClass,
      accountId: position.accountId,
      label: position.label,
      currency: position.currency,
      value: position.value,
      valueSign: position.valueSign,
      includeInTotals: position.includeInTotals,
    }));
}

function signedSnapshotAccountValue(account: SnapshotAccountValue): number {
  if (account.valueSign === "liability") return -Math.abs(account.value);
  return account.value;
}

function totalsFromSnapshotAccounts(
  accounts: SnapshotAccountValue[],
): FinancialTotals {
  const includedByCurrency: FinancialTotals["includedByCurrency"] = {};
  const informationalByCurrency: FinancialTotals["informationalByCurrency"] = {};

  for (const account of accounts) {
    if (!account.includeInTotals) {
      informationalByCurrency[account.currency] =
        (informationalByCurrency[account.currency] ?? 0) + account.value;
      continue;
    }

    includedByCurrency[account.currency] ??= {
      assets: 0,
      liabilities: 0,
      net: 0,
    };
    if (account.valueSign === "liability") {
      includedByCurrency[account.currency].liabilities += account.value;
      includedByCurrency[account.currency].net -= account.value;
    } else {
      includedByCurrency[account.currency].assets += account.value;
      includedByCurrency[account.currency].net += account.value;
    }
  }

  return { includedByCurrency, informationalByCurrency };
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function datesBetween(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  for (
    let cursor = startDate;
    cursor <= endDate;
    cursor = addDays(cursor, 1)
  ) {
    dates.push(cursor);
  }
  return dates;
}

function buildDailyHistoryFromSnapshots(
  snapshots: AssetSnapshot[],
): DailyAssetHistoryPoint[] {
  if (snapshots.length === 0) return [];

  const sortedSnapshots = [...snapshots].sort((left, right) =>
    left.importedAt.localeCompare(right.importedAt),
  );
  const firstDate = sortedSnapshots
    .map((snapshot) => snapshot.snapshotDate)
    .sort()[0];
  const lastDate = sortedSnapshots
    .map((snapshot) => snapshot.snapshotDate)
    .sort()
    .at(-1);
  if (!firstDate || !lastDate) return [];

  const carriedAccounts = new Map<
    string,
    { account: SnapshotAccountValue; snapshotDate: string; importedAt: string }
  >();
  let previousAccounts = new Map<string, DailyAccountChange>();
  const daily: DailyAssetHistoryPoint[] = [];
  let snapshotIndex = 0;
  let latestAppliedSnapshot = sortedSnapshots[0];

  for (const date of datesBetween(firstDate, lastDate)) {
    while (
      snapshotIndex < sortedSnapshots.length &&
      sortedSnapshots[snapshotIndex].snapshotDate <= date
    ) {
      const snapshot = sortedSnapshots[snapshotIndex];
      latestAppliedSnapshot = snapshot;
      for (const account of snapshot.accounts) {
        carriedAccounts.set(account.id, {
          account,
          snapshotDate: snapshot.snapshotDate,
          importedAt: snapshot.importedAt,
        });
      }
      snapshotIndex += 1;
    }

    const accounts = [...carriedAccounts.values()]
      .sort((left, right) => left.account.id.localeCompare(right.account.id));
    const totals = totalsFromSnapshotAccounts(
      accounts.map((entry) => entry.account),
    );
    const hasPreviousDay = daily.length > 0;
    const accountChanges = accounts.map((entry) => {
      const previous = previousAccounts.get(entry.account.id);
      const signedValue = signedSnapshotAccountValue(entry.account);
      const previousSignedValue = previous?.signedValue ?? null;
      return {
        ...entry.account,
        snapshotDate: entry.snapshotDate,
        signedValue,
        previousSnapshotDate: previous?.snapshotDate ?? null,
        previousValue: previous?.value ?? null,
        previousSignedValue,
        change:
          previousSignedValue === null
            ? hasPreviousDay
              ? signedValue
              : 0
            : signedValue - previousSignedValue,
      };
    });
    const netAssets = bucketFromTotals(totals, "net");
    const previousNetAssets =
      daily.length > 0 ? daily[daily.length - 1].netAssets : {};

    daily.push({
      date,
      importRunId: latestAppliedSnapshot.importRunId,
      importedAt: latestAppliedSnapshot.importedAt,
      assets: bucketFromTotals(totals, "assets"),
      liabilities: bucketFromTotals(totals, "liabilities"),
      netAssets,
      netChange:
        daily.length > 0
          ? subtractCurrencyBuckets(netAssets, previousNetAssets)
          : {},
      positionCount: accounts.length,
      accountChanges,
    });

    previousAccounts = new Map(
      accountChanges.map((change) => [change.id, change]),
    );
  }

  return daily;
}

function buildPositionsForClassifications(
  classifications: Classification[],
  transactions: NormalizedTransaction[],
  sourceRows: Map<string, RawTransactionOccurrence>,
  creditCardTransactions: NormalizedTransaction[] = transactions,
): AssetPosition[] {
  const directPositions = classifications.flatMap((item) => item.positions);
  const snapshotPositions = pickLatestSnapshotPositions(transactions, sourceRows);
  const creditCardPositions = pickCreditCardLiabilityPositions(
    creditCardTransactions,
    sourceRows,
  );
  return reducePositions([
    ...directPositions,
    ...snapshotPositions,
    ...creditCardPositions,
  ]);
}

function buildSnapshotHistory(
  classifications: Classification[],
  sourceRows: Map<string, RawTransactionOccurrence>,
  importRunTimes: Map<string, string>,
  generatedAt: string,
): SnapshotHistory {
  const byRun = new Map<string, Classification[]>();
  for (const classification of classifications) {
    const runId = rowImportRunId(classification.row);
    byRun.set(runId, [...(byRun.get(runId) ?? []), classification]);
  }

  const snapshots = [...byRun.entries()]
    .map(([importRunId, runClassifications]) => {
      const runSourceRows = new Map(
        runClassifications.map((classification) => [
          classification.row.sourceHash,
          classification.row,
        ]),
      );
      const { transactions } = dedupeTransactions(
        runClassifications.flatMap((item) => item.transactions),
        runSourceRows,
        importRunTimes,
      );
      const positions = buildPositionsForClassifications(
        runClassifications,
        transactions,
        runSourceRows,
      );
      const importedAt =
        importRunTimes.get(importRunId) ??
        runClassifications
          .map((classification) =>
            importedAtForRow(classification.row, importRunTimes),
          )
          .sort()
          .at(-1) ??
        generatedAt;

      return {
        importRunId,
        importedAt,
        snapshotDate: importedAt.slice(0, 10),
        totals: computeTotals(positions),
        positionCount: positions.length,
        includedPositionCount: positions.filter((position) => position.includeInTotals)
          .length,
        accounts: snapshotAccounts(positions),
      };
    })
    .sort((left, right) => left.importedAt.localeCompare(right.importedAt));

  const daily = buildDailyHistoryFromSnapshots(snapshots);

  return { snapshots, daily };
}

function computeTotals(positions: AssetPosition[]): FinancialTotals {
  const includedByCurrency: FinancialTotals["includedByCurrency"] = {};
  const informationalByCurrency: Record<string, number> = {};

  for (const position of positions) {
    const currency = position.currency || "UNKNOWN";
    if (!position.includeInTotals) {
      informationalByCurrency[currency] =
        (informationalByCurrency[currency] ?? 0) + position.value;
      continue;
    }

    const bucket = (includedByCurrency[currency] ??= {
      assets: 0,
      liabilities: 0,
      net: 0,
    });
    if (position.valueSign === "liability") {
      bucket.liabilities += position.value;
      bucket.net -= position.value;
    } else {
      bucket.assets += position.value;
      bucket.net += position.value;
    }
  }

  return { includedByCurrency, informationalByCurrency };
}

export function addCurrencyAmount(
  bucket: CurrencyBucket,
  currency: string,
  value: number,
): CurrencyBucket {
  if (!Number.isFinite(value)) return bucket;
  bucket[currency] = (bucket[currency] ?? 0) + value;
  return bucket;
}

function sumPositionValues(
  positions: AssetPosition[],
  predicate: (position: AssetPosition) => boolean,
): CurrencyBucket {
  const bucket: CurrencyBucket = {};
  for (const position of positions) {
    if (!predicate(position)) continue;
    addCurrencyAmount(bucket, position.currency, position.value);
  }
  return bucket;
}

function sumTransactionLiability(
  transactions: NormalizedTransaction[],
  predicate: (transaction: NormalizedTransaction) => boolean,
): CurrencyBucket {
  const bucket: CurrencyBucket = {};
  for (const transaction of transactions) {
    if (!predicate(transaction)) continue;
    const amount = transaction.amountSigned;
    if (amount === null) continue;
    addCurrencyAmount(bucket, transaction.currency, Math.max(-amount, 0));
  }
  return bucket;
}

function sumNetPositionValues(positions: AssetPosition[]): CurrencyBucket {
  const bucket: CurrencyBucket = {};
  for (const position of positions) {
    if (!position.includeInTotals || position.valueSign === "informational") continue;
    const sign = position.valueSign === "liability" ? -1 : 1;
    addCurrencyAmount(bucket, position.currency, position.value * sign);
  }
  return bucket;
}

export function mergeCurrencyBuckets(...buckets: CurrencyBucket[]): CurrencyBucket {
  const merged: CurrencyBucket = {};
  for (const bucket of buckets) {
    for (const [currency, value] of Object.entries(bucket)) {
      addCurrencyAmount(merged, currency, value);
    }
  }
  return merged;
}

function dashboardAccountId(
  kind: DashboardAccount["kind"],
  institution: string,
  accountId: string,
): string {
  return stableId(["dashboard-account", kind, institution, accountId]);
}

function metric(label: string, amounts: CurrencyBucket): DashboardMetric {
  return { label, amounts };
}

function textMetric(label: string, value: string): DashboardMetric {
  return { label, value };
}

function sourceInstitutionForPosition(position: AssetPosition): string {
  if (position.assetClass === "brokerage" || position.assetClass === "brokerage_rollup") {
    return "Yuanta brokerage";
  }
  return position.institution;
}

function sourceInstitutionForTransaction(
  transaction: NormalizedTransaction,
): string {
  if (transaction.type === "brokerage") return "Yuanta brokerage";
  return transaction.institution;
}

export function accountKindLabel(kind: DashboardAccount["kind"]): string {
  const labels: Record<DashboardAccount["kind"], string> = {
    account: "帳戶",
    credit_card: "信用卡",
    loan: "貸款",
    fund: "基金",
    brokerage: "券商",
  };
  return labels[kind];
}

function buildDashboardView(
  positions: AssetPosition[],
  transactions: NormalizedTransaction[],
  currentTransactions: NormalizedTransaction[] = transactions,
): DashboardView {
  const includedPositions = positions.filter((position) => position.includeInTotals);
  const currentTransactionIds = new Set(
    currentTransactions.map((transaction) => transaction.id),
  );
  const overview: DashboardView["overview"] = {
    assets: {
      totalTwdAssets: sumPositionValues(
        includedPositions,
        (position) =>
          position.valueSign === "asset" &&
          position.assetClass === "cash" &&
          position.currency === "TWD",
      ),
      totalForeignAssets: sumPositionValues(
        includedPositions,
        (position) =>
          position.valueSign === "asset" && position.assetClass === "foreign_cash",
      ),
      totalInvestmentAssets: sumPositionValues(
        includedPositions,
        (position) =>
          position.valueSign === "asset" &&
          ["fund", "brokerage"].includes(position.assetClass),
      ),
    },
    liabilities: {
      unbilledCreditCardAmount: sumTransactionLiability(
        currentTransactions,
        (transaction) =>
          transaction.type === "credit_card" && transaction.status === "unbilled",
      ),
      loanTotalBalance: sumPositionValues(
        includedPositions,
        (position) =>
          position.valueSign === "liability" && position.assetClass === "loan",
      ),
    },
    netAssets: sumNetPositionValues(includedPositions),
  };

  const accountMap = new Map<string, DashboardAccount>();
  const transactionIdsByAccount = new Map<string, string[]>();
  const positionIdsByAccount = new Map<string, string[]>();

  function ensureAccount(
    kind: DashboardAccount["kind"],
    institution: string,
    product: string,
    accountId: string,
    label: string,
  ): DashboardAccount {
    const id = dashboardAccountId(kind, institution, accountId);
    const existing = accountMap.get(id);
    if (existing) return existing;

    const account: DashboardAccount = {
      id,
      label,
      kind,
      institution,
      product,
      metrics: [],
      positionIds: [],
      transactionIds: [],
      childAssetIds: [],
    };
    accountMap.set(id, account);
    return account;
  }

  function kindForPosition(position: AssetPosition): DashboardAccount["kind"] | null {
    if (position.assetClass === "cash" || position.assetClass === "foreign_cash") {
      return "account";
    }
    if (position.assetClass === "credit_card") return "credit_card";
    if (position.assetClass === "loan") return "loan";
    if (position.assetClass === "fund") return "fund";
    if (position.assetClass === "brokerage") return "brokerage";
    return null;
  }

  function kindForTransaction(
    transaction: NormalizedTransaction,
  ): DashboardAccount["kind"] | null {
    if (transaction.type === "deposit" || transaction.type === "foreign_deposit") {
      return "account";
    }
    if (transaction.type === "credit_card") return "credit_card";
    if (transaction.type === "loan") return "loan";
    if (transaction.type === "investment") return "fund";
    if (transaction.type === "brokerage") return "brokerage";
    return null;
  }

  for (const position of positions) {
    const kind = kindForPosition(position);
    if (!kind) continue;
    const institution = sourceInstitutionForPosition(position);
    const account = ensureAccount(
      kind,
      institution,
      position.product,
      position.accountId,
      kind === "brokerage"
        ? position.accountId
        : kind === "fund"
          ? position.label
          : position.accountId,
    );
    positionIdsByAccount.set(account.id, [
      ...(positionIdsByAccount.get(account.id) ?? []),
      position.id,
    ]);
    if (kind === "brokerage") {
      account.childAssetIds.push(position.id);
    }
  }

  for (const transaction of transactions) {
    const kind = kindForTransaction(transaction);
    if (!kind) continue;
    const institution = sourceInstitutionForTransaction(transaction);
    const account = ensureAccount(
      kind,
      institution,
      transaction.product,
      transaction.accountId,
      transaction.accountLabel,
    );
    transactionIdsByAccount.set(account.id, [
      ...(transactionIdsByAccount.get(account.id) ?? []),
      transaction.id,
    ]);
  }

  for (const account of accountMap.values()) {
    account.positionIds = [...new Set(positionIdsByAccount.get(account.id) ?? [])];
    account.transactionIds = [
      ...new Set(transactionIdsByAccount.get(account.id) ?? []),
    ];
    account.childAssetIds = [...new Set(account.childAssetIds)];

    const accountPositions = positions.filter((position) =>
      account.positionIds.includes(position.id),
    );
    const accountTransactions = transactions.filter((transaction) =>
      account.transactionIds.includes(transaction.id),
    );
    const accountCurrentTransactions = accountTransactions.filter((transaction) =>
      currentTransactionIds.has(transaction.id),
    );

    if (account.kind === "account") {
      const total = sumPositionValues(
        accountPositions,
        (position) => position.includeInTotals && position.valueSign === "asset",
      );
      account.metrics = [
        textMetric(
          "種類",
          accountPositions.some((position) => position.assetClass === "foreign_cash")
            ? "外幣帳戶"
            : "台幣帳戶",
        ),
        metric("總金額", total),
      ];
    } else if (account.kind === "credit_card") {
      const unbilled = sumTransactionLiability(
        accountCurrentTransactions,
        (transaction) => transaction.status === "unbilled",
      );
      const includedUnpaid = sumPositionValues(
        accountPositions,
        (position) => position.includeInTotals && position.valueSign === "liability",
      );
      const fallbackUnpaid = sumPositionValues(
        accountPositions,
        (position) => !position.includeInTotals && position.valueSign === "liability",
      );
      account.metrics = [
        metric("未結帳總金額", unbilled),
        metric(
          "未繳總金額",
          Object.keys(includedUnpaid).length > 0 ? includedUnpaid : fallbackUnpaid,
        ),
      ];
    } else if (account.kind === "loan") {
      account.metrics = [
        textMetric("種類", "貸款"),
        metric(
          "貸款餘額",
          sumPositionValues(
            accountPositions,
            (position) => position.valueSign === "liability",
          ),
        ),
      ];
    } else if (account.kind === "fund") {
      const fundValue = sumPositionValues(
        accountPositions,
        (position) => position.includeInTotals && position.valueSign === "asset",
      );
      if (Object.keys(fundValue).length === 0) {
        for (const transaction of accountTransactions) {
          if (transaction.currency && transaction.currency !== "UNKNOWN") {
            fundValue[transaction.currency] ??= 0;
          }
        }
      }
      account.metrics = [
        metric("淨值資產", fundValue),
      ];
    } else if (account.kind === "brokerage") {
      account.metrics = [
        textMetric("種類", "券商資產"),
        metric(
          "淨值總資產",
          sumPositionValues(
            accountPositions,
            (position) => position.includeInTotals && position.valueSign === "asset",
          ),
        ),
      ];
    }
  }

  const sectionLabels: Record<DashboardAccount["kind"], string> = {
    account: "帳戶",
    credit_card: "信用卡",
    loan: "貸款",
    fund: "基金",
    brokerage: "券商帳戶",
  };
  const institutionOrder = ["Fubon", "Yuanta", "Cathay", "Yuanta brokerage"];
  const sectionOrder: DashboardAccount["kind"][] = [
    "account",
    "credit_card",
    "loan",
    "fund",
    "brokerage",
  ];
  const institutions = [...new Set([...accountMap.values()].map((item) => item.institution))]
    .sort((a, b) => {
      const left = institutionOrder.indexOf(a);
      const right = institutionOrder.indexOf(b);
      if (left !== -1 || right !== -1) {
        return (left === -1 ? 999 : left) - (right === -1 ? 999 : right);
      }
      return a.localeCompare(b);
    })
    .map((institution) => {
      const accounts = [...accountMap.values()]
        .filter((account) => account.institution === institution)
        .sort(
          (a, b) =>
            sectionOrder.indexOf(a.kind) - sectionOrder.indexOf(b.kind) ||
            a.label.localeCompare(b.label),
        );
      return {
        id: stableId(["dashboard-institution", institution]),
        label: institution,
        groups: sectionOrder
          .map((kind) => ({
            kind,
            label: sectionLabels[kind],
            accounts: accounts.filter((account) => account.kind === kind),
          }))
          .filter((group) => group.accounts.length > 0),
      };
    });

  return { overview, institutions };
}

function buildQualityIssues(model: Omit<FinancialModel, "quality">): QualityIssue[] {
  const issues: QualityIssue[] = [];

  const seenSourceHashes = new Map<string, NormalizedTransaction>();
  for (const transaction of model.normalizedTransactions) {
    const previous = seenSourceHashes.get(transaction.sourceHash);
    const isExpectedFundConversionPair =
      previous?.parserId.startsWith("yuanta.fund-conversion-") &&
      transaction.parserId.startsWith("yuanta.fund-conversion-");
    if (previous && !isExpectedFundConversionPair) {
      issues.push({
        level: "warn",
        code: "transaction-source-reused",
        message: "Multiple normalized transactions share the same source row.",
        sourceRelativePath: transaction.sourceRelativePath,
        sourceRowIndex: transaction.sourceRowIndex,
      });
    }
    seenSourceHashes.set(transaction.sourceHash, transaction);
  }

  for (const position of model.assetPositions) {
    if (!Number.isFinite(position.value)) {
      issues.push({
        level: "error",
        code: "position-invalid-value",
        message: "Asset position has a non-finite value.",
        sourceRelativePath: position.sourceRelativePath,
        sourceRowIndex: position.sourceRowIndex,
      });
    }
    if (!position.currency) {
      issues.push({
        level: "error",
        code: "position-missing-currency",
        message: "Asset position is missing currency.",
        sourceRelativePath: position.sourceRelativePath,
        sourceRowIndex: position.sourceRowIndex,
      });
    }
    if (position.includeInTotals && position.valueSign === "informational") {
      issues.push({
        level: "error",
        code: "informational-position-included",
        message: "Informational position must not be included in totals.",
        sourceRelativePath: position.sourceRelativePath,
        sourceRowIndex: position.sourceRowIndex,
      });
    }
  }

  for (const [key, coverage] of Object.entries(model.parserCoverage)) {
    if (coverage.parsedRows === 0) {
      issues.push({
        level: "warn",
        code: "source-unparsed",
        message: `No rows were parsed for ${key}.`,
      });
    } else if (coverage.unsupportedRows > coverage.rows * 0.1) {
      issues.push({
        level: "warn",
        code: "source-low-coverage",
        message: `${key} has more than 10% truly unsupported rows.`,
      });
    }
  }

  return issues;
}

function statusForIssues(issues: QualityIssue[]): FinancialModel["quality"]["status"] {
  if (issues.some((issue) => issue.level === "error")) return "fail";
  if (issues.some((issue) => issue.level === "warn")) return "warn";
  return "pass";
}

function buildCoverage(
  rows: RawTransactionOccurrence[],
  classifications: Classification[],
): FinancialModel["parserCoverage"] {
  const coverage: FinancialModel["parserCoverage"] = {};

  for (const row of rows) {
    const key = `${row.bank}/${row.product}`;
    coverage[key] ??= {
      rows: 0,
      parsedRows: 0,
      auditOnlyRows: 0,
      unsupportedRows: 0,
      transactions: 0,
      positions: 0,
    };
    coverage[key].rows += 1;
  }

  for (const classification of classifications) {
    const key = `${classification.row.bank}/${classification.row.product}`;
    const bucket = coverage[key];
    const parsed =
      classification.transactions.length > 0 || classification.positions.length > 0;
    if (parsed) bucket.parsedRows += 1;
    if (classification.auditOnlyReason) bucket.auditOnlyRows += 1;
    if (classification.unsupportedReason) bucket.unsupportedRows += 1;
    bucket.transactions += classification.transactions.length;
    bucket.positions += classification.positions.length;
  }

  return coverage;
}

export async function buildFinancialModel(input: BuildFinancialDashboardInput): Promise<FinancialModel> {
  const ledgerDir = resolve(input.ledgerDir);
  const ledgerRecords = await readFinancialDashboardData(ledgerDir);
  const { batches, importRuns } = ledgerRecords;
  const importRunTimes = buildImportRunTimes(importRuns, batches);
  const typedRows = dashboardRows(ledgerRecords);

  const rows = input.includeDuplicates
    ? typedRows
    : typedRows.filter((row) => row.dedupeStatus !== "duplicate");
  const sourceRows = new Map(rows.map((row) => [row.sourceHash, row]));
  const keepRow = input.includeDuplicates
    ? () => true
    : (row: RawTransactionOccurrence) => row.dedupeStatus !== "duplicate";
  const classifications = classifyDashboardData(ledgerRecords, keepRow);
  const rawTransactions = classifications.flatMap((item) => item.transactions);
  const { transactions, duplicateCount: duplicateNormalizedTransactions } =
    dedupeTransactions(rawTransactions, sourceRows, importRunTimes);
  const generatedAt = new Date().toISOString();
  const snapshotHistory = buildSnapshotHistory(
    classifications,
    sourceRows,
    importRunTimes,
    generatedAt,
  );
  const currentTransactions = selectLatestCreditCardUnbilledTransactions(
    transactions,
    sourceRows,
    importRunTimes,
  );
  const assetPositions = buildPositionsForClassifications(
    classifications,
    transactions,
    sourceRows,
    currentTransactions,
  );
  const unsupportedRows = classifications
    .filter((item) => item.unsupportedReason)
    .map((item) => ({
      bank: item.row.bank,
      product: item.row.product,
      sourceRelativePath: item.row.sourceRelativePath,
      sourceRowIndex: item.row.sourceRowIndex,
      reason: item.unsupportedReason ?? "unsupported",
    }));
  const auditOnlyRows = classifications
    .filter((item) => item.auditOnlyReason)
    .map((item) => ({
      bank: item.row.bank,
      product: item.row.product,
      sourceRelativePath: item.row.sourceRelativePath,
      sourceRowIndex: item.row.sourceRowIndex,
      reason: item.auditOnlyReason ?? "audit only",
    }));
  const parserCoverage = buildCoverage(rows, classifications);
  const dashboard = buildDashboardView(
    assetPositions,
    transactions,
    currentTransactions,
  );
  const baseModel = {
    schemaVersion: "financial-model.v1" as const,
    generatedAt,
    sourceLedgerDir: ledgerDir,
    sourceLedgerStore: ledgerRecords.source,
    counts: {
      rawRows: typedRows.length,
      uniqueRows: typedRows.filter((row) => row.dedupeStatus !== "duplicate").length,
      duplicateRows: typedRows.filter((row) => row.dedupeStatus === "duplicate").length,
      normalizedTransactions: transactions.length,
      assetPositions: assetPositions.length,
      includedPositions: assetPositions.filter((position) => position.includeInTotals)
        .length,
      duplicateNormalizedTransactions,
      assetSnapshots: snapshotHistory.snapshots.length,
      auditOnlyRows: auditOnlyRows.length,
      unsupportedRows: unsupportedRows.length,
    },
    totals: computeTotals(assetPositions),
    dashboard,
    parserCoverage,
    assetPositions,
    normalizedTransactions: transactions,
    snapshotHistory,
    unsupportedRows,
    auditOnlyRows,
    sourceBatches: {
      count: batches.length,
      layoutStrategies: batches.reduce<Record<string, number>>((acc, batch) => {
        const key = batch.csvLayout?.strategy ?? "missing";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
    },
  };
  const issues = buildQualityIssues(baseModel);

  return {
    ...baseModel,
    quality: {
      status: statusForIssues(issues),
      issues,
    },
  };
}
