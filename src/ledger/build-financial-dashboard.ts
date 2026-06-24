import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import XLSX from "xlsx";
import { z } from "zod";

const inputSchema = z.object({
  ledgerDir: z.string().default("data/ledger"),
  outputDir: z.string().default("data/ledger"),
  includeDuplicates: z.boolean().default(false),
});

type Input = z.infer<typeof inputSchema>;

type RawRecord = Record<string, unknown>;

type BatchRecord = RawRecord & {
  importBatchId: string;
  sourceRelativePath: string;
  bank: string;
  product: string;
  rowCount: number;
  csvLayout?: {
    strategy?: string;
    detectionSource?: string;
    warnings?: string[];
  };
};

type RawTransactionOccurrence = RawRecord & {
  importBatchId: string;
  sourceHash: string;
  sourceRelativePath: string;
  sourceRowIndex: number;
  bank: string;
  product: string;
  dedupeStatus: "unique" | "duplicate";
  rawPayload: Record<string, string>;
  sourceAccountHint?: string;
};

type NormalizedTransaction = {
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
  description: string;
  status: "posted" | "unbilled" | "payment" | "detail" | "dividend" | "unknown";
  inflow: number | null;
  outflow: number | null;
  amountSigned: number | null;
  balanceAfter: number | null;
  includeInCashFlow: boolean;
  warnings: string[];
};

type AssetPosition = {
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
  sourceRelativePath: string;
  sourceRowIndex: number;
  confidence: "high" | "medium" | "low";
  warnings: string[];
};

type Classification = {
  row: RawTransactionOccurrence;
  transactions: NormalizedTransaction[];
  positions: AssetPosition[];
  auditOnlyReason?: string;
  unsupportedReason?: string;
};

type QualityIssue = {
  level: "info" | "warn" | "error";
  code: string;
  message: string;
  sourceRelativePath?: string;
  sourceRowIndex?: number;
};

type FinancialModel = {
  schemaVersion: "financial-model.v1";
  generatedAt: string;
  sourceLedgerDir: string;
  counts: {
    rawRows: number;
    uniqueRows: number;
    duplicateRows: number;
    normalizedTransactions: number;
    assetPositions: number;
    includedPositions: number;
    auditOnlyRows: number;
    unsupportedRows: number;
  };
  totals: {
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
  quality: {
    status: "pass" | "warn" | "fail";
    issues: QualityIssue[];
  };
};

type CurrencyBucket = Record<string, number>;

type DashboardMetric = {
  label: string;
  value?: string;
  amounts?: CurrencyBucket;
};

type DashboardAccount = {
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

type DashboardInstitution = {
  id: string;
  label: string;
  groups: Array<{
    kind: DashboardAccount["kind"];
    label: string;
    accounts: DashboardAccount[];
  }>;
};

type DashboardView = {
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

function parseParams(argv: string[]): Record<string, unknown> {
  const paramsIndex = argv.indexOf("--params");
  const inlineParams = argv.find((arg) => arg.startsWith("--params="));
  const rawParams =
    paramsIndex >= 0 ? argv[paramsIndex + 1] : inlineParams?.slice(9);

  if (!rawParams) return {};

  const parsed = JSON.parse(rawParams) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--params must be a JSON object");
  }

  return parsed as Record<string, unknown>;
}

async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        return JSON.parse(line) as T;
      } catch (error) {
        throw new Error(
          `Invalid JSONL in ${path}:${index + 1}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
}

async function buildSourceAccountHints(
  batches: BatchRecord[],
): Promise<Map<string, string>> {
  const hints = new Map<string, string>();

  for (const batch of batches) {
    const hint = await readSourceAccountHint(batch);
    if (hint) hints.set(batch.sourceRelativePath, hint);
  }

  return hints;
}

async function readSourceAccountHint(batch: BatchRecord): Promise<string | null> {
  if (!["fubon"].includes(batch.bank)) return null;

  try {
    const csvText = await readFile(String(batch.sourceFile), "utf8");
    const workbook = XLSX.read(csvText, { raw: false, type: "string" });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return null;

    const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], {
      defval: "",
      header: 1,
      raw: false,
    });
    const searchRows = rows.slice(0, 12);

    for (const row of searchRows) {
      const label = String(row[0] ?? "").trim();
      const value = String(row[1] ?? "").trim();
      if (!value) continue;
      if (/^(帳號|貸款帳號)$/.test(label)) return maskIdentifier(value);
    }
  } catch {
    return null;
  }

  return null;
}

function stableId(parts: unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 24);
}

function cell(row: Record<string, string>, key: string): string {
  return String(row[key] ?? "").trim();
}

function firstCell(row: Record<string, string>, keys: string[]): string {
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

function parseAmountToken(
  value: unknown,
  token: "first" | "last" = "first",
): number | null {
  const raw = String(value ?? "")
    .replace(/\u00a0/g, " ")
    .trim();
  const matches = raw.match(/-?\(?\d[\d,]*(?:\.\d+)?\)?-?/g);
  if (!matches || matches.length === 0) return null;

  return parseAmount(token === "last" ? matches[matches.length - 1] : matches[0]);
}

function currencyFromText(value: unknown, fallback = "TWD"): string {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  if (/台幣|臺幣|新台幣|新臺幣|NTD|TWD|NT\$/i.test(raw)) return "TWD";
  if (/美金|美元|美圓|USD/i.test(raw)) return "USD";
  if (/日圓|日幣|日元|JPY/i.test(raw)) return "JPY";
  return normalizeCurrency(raw, fallback);
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

function parseDateToken(
  value: unknown,
  token: "first" | "last" = "first",
): string | null {
  const raw = String(value ?? "").trim();
  const matches = raw.match(/\d{3,4}[/-]\d{1,2}[/-]\d{1,2}/g);
  if (!matches || matches.length === 0) return parseDate(raw);
  return parseDate(token === "last" ? matches[matches.length - 1] : matches[0]);
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
  if (row.sourceAccountHint) return row.sourceAccountHint;
  const sourcePathHint = sourceAccountFromPath(row);
  if (sourcePathHint) return sourcePathHint;
  return `source:${row.sourceRelativePath}`;
}

function sourceAccountFromPath(row: RawTransactionOccurrence): string | null {
  if (`${row.bank}/${row.product}` !== "yuanta/loan-statements") return null;
  const fileName = row.sourceRelativePath.split("/").pop() ?? "";
  const match = fileName.match(/(\d{4})\.csv$/);
  return match ? `****${match[1]}` : null;
}

function fundAccountId(label: string): string {
  return stableId(["fund", label.trim()]);
}

function fundLabelFromTradeField(value: string): string {
  return value
    .trim()
    .replace(/\s+[A-Z]{2}\d+(?:[-\w]+)?$/i, "")
    .trim();
}

function splitFundConversionLabels(value: string): {
  fromLabel: string;
  toLabel: string;
} | null {
  const labels = value.trim().split(/\s+/).filter(Boolean);
  if (labels.length < 2) return null;
  return {
    fromLabel: labels[0],
    toLabel: labels.slice(1).join(" "),
  };
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
    sourceRelativePath: row.sourceRelativePath,
    sourceRowIndex: row.sourceRowIndex,
    confidence: options.confidence ?? "high",
    warnings: options.warnings ?? [],
  };
}

function classifyDepositRow(
  row: RawTransactionOccurrence,
): Classification | null {
  const p = row.rawPayload;
  const bankProduct = `${row.bank}/${row.product}`;

  if (bankProduct === "cathay/statements") {
    const accountId = sourceAccount(row, cell(p, "accountNumber"));
    const date = parseDate(firstCell(p, ["accountDate", "txnDateTime"]));
    const inflow = parseAmount(cell(p, "incomeAmt"));
    const outflow = parseAmount(cell(p, "expendAmt"));
    const balanceAfter = parseAmount(cell(p, "balance"));
    const transaction: NormalizedTransaction = {
      ...baseTransaction(row, "cathay.deposit.v1", "deposit", accountId, "TWD", date),
      description: cell(p, "description") || cell(p, "memo"),
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

  if (bankProduct === "cathay/foreign-statements") {
    const accountId = sourceAccount(row, cell(p, "account"));
    const currency = normalizeCurrency(cell(p, "currencyCode"), "UNKNOWN");
    const date = parseDate(firstCell(p, ["txntDate", "transferDate"]));
    const amount = parseAmount(cell(p, "amount"));
    const balanceAfter = parseAmount(cell(p, "balance"));
    const debitCreditType = cell(p, "debitCreditType").toLowerCase();
    const isOutflow =
      debitCreditType.includes("debit") ||
      debitCreditType.includes("支") ||
      debitCreditType === "d";
    const isInflow =
      debitCreditType.includes("credit") ||
      debitCreditType.includes("存") ||
      debitCreditType === "c";
    const transaction: NormalizedTransaction = {
      ...baseTransaction(
        row,
        "cathay.foreign-deposit.v1",
        "foreign_deposit",
        accountId,
        currency,
        date,
      ),
      description: cell(p, "memo") || cell(p, "custName"),
      inflow: isInflow ? amount : null,
      outflow: isOutflow ? amount : null,
      amountSigned:
        amount === null ? null : isOutflow ? -amount : isInflow ? amount : null,
      balanceAfter,
      status: "posted",
      includeInCashFlow: amount !== null && (isInflow || isOutflow),
      warnings:
        amount !== null && !isInflow && !isOutflow
          ? ["unknown debit/credit direction"]
          : [],
    };
    return { row, transactions: [transaction], positions: [] };
  }

  if (bankProduct === "fubon/statements") {
    const accountId = sourceAccount(row);
    const date = parseDate(cell(p, "帳務日期"));
    const inflow = parseAmount(cell(p, "存入金額"));
    const outflow = parseAmount(cell(p, "支出金額"));
    const balanceAfter = parseAmount(cell(p, "即時餘額"));
    const transaction: NormalizedTransaction = {
      ...baseTransaction(row, "fubon.deposit.v1", "deposit", accountId, "TWD", date),
      description: [cell(p, "摘要"), cell(p, "附註")].filter(Boolean).join(" "),
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

  if (bankProduct === "yuanta/statements") {
    const accountId = sourceAccount(row, cell(p, "帳號"));
    const date = parseDate(firstCell(p, ["帳務日期", "交易日期"]));
    const inflow = parseAmount(cell(p, "存入金額"));
    const outflow = parseAmount(cell(p, "支出金額"));
    const balanceAfter = parseAmount(cell(p, "帳面餘額"));
    const transaction: NormalizedTransaction = {
      ...baseTransaction(row, "yuanta.deposit.v1", "deposit", accountId, "TWD", date),
      description: [cell(p, "交易說明"), cell(p, "備註")].filter(Boolean).join(" "),
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

  if (bankProduct === "yuanta/foreign-currency-statements") {
    const accountId = sourceAccount(row, cell(p, "帳號"));
    const currency = normalizeCurrency(cell(p, "幣別"), "UNKNOWN");
    const date = parseDate(firstCell(p, ["帳務日期", "交易日期"]));
    const inflow = parseAmount(cell(p, "存入金額"));
    const outflow = parseAmount(cell(p, "支出金額"));
    const balanceAfter = parseAmount(cell(p, "帳面餘額"));
    const transaction: NormalizedTransaction = {
      ...baseTransaction(
        row,
        "yuanta.foreign-deposit.v1",
        "foreign_deposit",
        accountId,
        currency,
        date,
      ),
      description: [cell(p, "交易說明"), cell(p, "交易資訊")].filter(Boolean).join(" "),
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
  const p = row.rawPayload;
  const bankProduct = `${row.bank}/${row.product}`;

  if (bankProduct === "fubon/loan-statements" && cell(p, "餘額")) {
    const accountId = sourceAccount(row);
    const date = parseDate(cell(p, "交易日期"));
    const amount = parseAmount(cell(p, "異動金額"));
    const balanceAfter = parseAmount(cell(p, "餘額"));
    const transaction: NormalizedTransaction = {
      ...baseTransaction(row, "fubon.loan.v1", "loan", accountId, "TWD", date),
      description: cell(p, "交易內容"),
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

  if (bankProduct === "fubon/loan-statements" && cell(p, "本金")) {
    const accountId = sourceAccount(row);
    const date = parseDate(cell(p, "交易日期"));
    const principal = parseAmount(cell(p, "本金"));
    const interest = parseAmount(cell(p, "利息"));
    const fees =
      (parseAmount(cell(p, "違約金")) ?? 0) +
      (parseAmount(cell(p, "遲延息")) ?? 0) +
      (parseAmount(cell(p, "緩繳息")) ?? 0);
    const amount = (principal ?? 0) + (interest ?? 0) + fees;
    const transaction: NormalizedTransaction = {
      ...baseTransaction(
        row,
        "fubon.loan-payment-detail.v1",
        "loan",
        accountId,
        "TWD",
        date,
      ),
      description: "loan payment detail",
      inflow: null,
      outflow: amount || null,
      amountSigned: amount ? -amount : null,
      balanceAfter: null,
      status: "payment",
      includeInCashFlow: false,
      warnings: ["payment detail row has no outstanding balance"],
    };
    return { row, transactions: [transaction], positions: [] };
  }

  if (bankProduct === "yuanta/loan-statements") {
    const accountId = sourceAccount(row);
    const date = parseDate(cell(p, "交易日/記帳日"));
    const amount = parseAmount(cell(p, "交易金額"));
    const balanceAfter = parseAmount(cell(p, "交易後餘額"));
    const transaction: NormalizedTransaction = {
      ...baseTransaction(row, "yuanta.loan.v1", "loan", accountId, "TWD", date),
      description: cell(p, "繳款項目"),
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
  const p = row.rawPayload;
  const bankProduct = `${row.bank}/${row.product}`;

  if (bankProduct === "fubon/credit-card-statements") {
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
      status: row.sourceRelativePath.includes("unbilled")
        ? "unbilled"
        : amount < 0
          ? "payment"
          : "posted",
      includeInCashFlow: true,
      warnings: ["transaction row only; no statement liability balance"],
    };
    return { row, transactions: [transaction], positions: [] };
  }

  if (bankProduct === "yuanta/credit-card-statements") {
    const accountId = "Yuanta credit card";
    const sourceTableLabel = cell(p, "source_table_label");

    if (sourceTableLabel === "payment-details" && cell(p, "尚未繳款")) {
      const value = parseAmount(cell(p, "尚未繳款"));
      if (value !== null) {
        const asOfDate = parseDate(
          firstCell(p, ["本月繳款期限", "最近繳款日期", "繳款截止日"]),
        );
        const position = positionFromRow(
          row,
          "yuanta.credit-card-outstanding.v1",
          "credit_card",
          accountId,
          "TWD",
          value,
          "liability",
          asOfDate,
          {
            label: accountId,
            confidence: "medium",
            warnings: ["derived from statement payment summary"],
          },
        );
        return { row, transactions: [], positions: [position] };
      }
    }

    if (sourceTableLabel === "transactions" && cell(p, "新臺幣金額")) {
      const date = parseDate(firstCell(p, ["入帳日期", "消費日期"]));
      const amount = parseAmount(cell(p, "新臺幣金額"));
      if (amount !== null) {
        if (amount <= 0) {
          return {
            row,
            transactions: [],
            positions: [],
            auditOnlyReason:
              "yuanta credit-card payment or rebate row is covered by payment details",
          };
        }
        const transaction: NormalizedTransaction = {
          ...baseTransaction(
            row,
            "yuanta.credit-card-transaction.v1",
            "credit_card",
            accountId,
            "TWD",
            date,
          ),
          description: cell(p, "消費明細"),
          inflow: null,
          outflow: amount,
          amountSigned: -amount,
          balanceAfter: null,
          status:
            cell(p, "source_category") === "unbilled" ||
            row.sourceRelativePath.includes("unbilled")
              ? "unbilled"
              : "posted",
          includeInCashFlow: true,
          warnings: ["transaction row only; not used as liability balance"],
        };
        return { row, transactions: [transaction], positions: [] };
      }
    }

    if (sourceTableLabel === "payment-details" && cell(p, "繳款金額")) {
      const amount = parseAmount(cell(p, "繳款金額"));
      if (amount !== null) {
        const transaction: NormalizedTransaction = {
          ...baseTransaction(
            row,
            "yuanta.credit-card-payment.v1",
            "credit_card",
            accountId,
            "TWD",
            parseDate(cell(p, "繳款日")),
          ),
          description: cell(p, "中文說明") || "credit card payment",
          inflow: amount,
          outflow: null,
          amountSigned: amount,
          balanceAfter: null,
          status: "payment",
          includeInCashFlow: true,
          warnings: ["payment transaction; not used as liability balance"],
        };
        return { row, transactions: [transaction], positions: [] };
      }
    }

    if (cell(p, "信用額度") || cell(p, "信用額度餘額")) {
      return {
        row,
        transactions: [],
        positions: [],
        auditOnlyReason: "credit limit metadata is not an asset/liability",
      };
    }

    if (cell(p, "本期應繳金額")) {
      return {
        row,
        transactions: [],
        positions: [],
        auditOnlyReason:
          "yuanta credit-card statement due is kept as audit metadata; aggregate payment details provide current outstanding",
      };
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
  const p = row.rawPayload;
  if (`${row.bank}/${row.product}` !== "yuanta/fund-statements") return null;

  if (cell(p, "基金名稱") && cell(p, "不含息參考市值")) {
    const value = parseAmount(cell(p, "不含息參考市值"));
    if (value !== null) {
      const currency = normalizeCurrency(firstCell(p, ["投資幣別", "幣別"]));
      const fundLabel = cell(p, "基金名稱");
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

  if (
    cell(p, "source_category") === "historical-transactions" &&
    cell(p, "source_table_label") === "buy-details" &&
    cell(p, "投資日期") &&
    cell(p, "投資金額")
  ) {
    const amountText = cell(p, "投資金額");
    const amount = parseAmountToken(amountText);
    const date = parseDate(cell(p, "投資日期"));
    if (amount !== null) {
      const currency = currencyFromText(amountText);
      const fundLabel = firstCell(p, ["基金名稱", "基金名稱 交易編號"]);
      const transaction: NormalizedTransaction = {
        ...baseTransaction(
          row,
          "yuanta.fund-buy.v1",
          "investment",
          fundAccountId(fundLabel),
          currency,
          date,
        ),
        accountLabel: fundLabel,
        description: `申購 ${fundLabel}`,
        inflow: null,
        outflow: amount,
        amountSigned: -amount,
        balanceAfter: null,
        status: "posted",
        includeInCashFlow: true,
        warnings: [],
      };
      return { row, transactions: [transaction], positions: [] };
    }
  }

  if (
    cell(p, "source_category") === "historical-transactions" &&
    cell(p, "source_table_label") === "cash-dividend-details" &&
    cell(p, "入帳日期") &&
    cell(p, "基準單位數 分配金額")
  ) {
    const amountText = cell(p, "基準單位數 分配金額");
    const amount = parseAmountToken(amountText, "last");
    const fundLabel = fundLabelFromTradeField(cell(p, "基金名稱 交易編號"));
    if (amount !== null && fundLabel) {
      const transaction: NormalizedTransaction = {
        ...baseTransaction(
          row,
          "yuanta.fund-cash-dividend.v1",
          "investment",
          fundAccountId(fundLabel),
          currencyFromText(amountText),
          parseDate(cell(p, "入帳日期")),
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

  if (
    cell(p, "source_category") === "historical-transactions" &&
    cell(p, "source_table_label") === "conversion-details" &&
    cell(p, "轉出日期 轉入日期") &&
    cell(p, "轉出基金 轉入基金") &&
    cell(p, "轉換投資金額")
  ) {
    const labels = splitFundConversionLabels(cell(p, "轉出基金 轉入基金"));
    const amountText = cell(p, "轉換投資金額");
    const amount = parseAmountToken(amountText);
    if (labels && amount !== null) {
      const transaction: NormalizedTransaction = {
        ...baseTransaction(
          row,
          "yuanta.fund-conversion-in.v1",
          "investment",
          fundAccountId(labels.toLabel),
          currencyFromText(amountText),
          parseDateToken(cell(p, "轉出日期 轉入日期"), "last"),
        ),
        accountLabel: labels.toLabel,
        description: `轉換轉入 ${labels.fromLabel} -> ${labels.toLabel}`,
        inflow: amount,
        outflow: null,
        amountSigned: amount,
        balanceAfter: null,
        status: "posted",
        includeInCashFlow: false,
        warnings: ["fund conversion is informational; not included in cash flow"],
      };
      return { row, transactions: [transaction], positions: [] };
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
  const p = row.rawPayload;
  if (`${row.bank}/${row.product}` !== "yuanta/trade-statements") return null;

  if (cell(p, "台幣現值")) {
    const valueTwd = parseAmount(cell(p, "台幣現值"));
    if (valueTwd !== null) {
      const currency = normalizeCurrency(cell(p, "交易幣別"));
      const value = parseAmount(cell(p, "原幣現值")) ?? valueTwd;
      const position = positionFromRow(
        row,
        "yuanta.brokerage-holding.v1",
        "brokerage",
        sourceAccount(row, cell(p, "交易帳號")),
        currency,
        value,
        "asset",
        parseDate(cell(p, "市價日期")),
        {
          label: [cell(p, "商品代號"), cell(p, "商品名稱")]
            .filter(Boolean)
            .join(" "),
          valueTwd,
          confidence: "high",
        },
      );
      return { row, transactions: [], positions: [position] };
    }
  }

  if (cell(p, "本日餘額")) {
    const value = parseAmount(cell(p, "本日餘額"));
    if (value !== null) {
      const position = positionFromRow(
        row,
        "yuanta.futures-balance.v1",
        "brokerage",
        "Yuanta futures",
        "TWD",
        value,
        "asset",
        null,
        {
          label: "Yuanta futures margin balance",
          confidence: "medium",
          warnings: ["futures balance has no explicit as-of date in CSV row"],
        },
      );
      return { row, transactions: [], positions: [position] };
    }
  }

  if (
    row.sourceRelativePath.includes("/holdings-") &&
    row.sourceRelativePath.includes("-summary-") &&
    cell(p, "column_1") &&
    cell(p, "column_2")
  ) {
    const value = parseAmount(cell(p, "column_2"));
    if (value !== null) {
      const position = positionFromRow(
        row,
        "yuanta.brokerage-summary-rollup.v1",
        "brokerage_rollup",
        stableId(["brokerage-rollup", row.sourceRelativePath, cell(p, "column_1")]),
        "TWD",
        value,
        "informational",
        null,
        {
          label: cell(p, "column_1"),
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

  if (cell(p, "交易日期") && cell(p, "交割金額(原幣)")) {
    const amount = parseAmount(cell(p, "交割金額(原幣)"));
    const tradeType = cell(p, "交易類別");
    const isDividend = tradeType.includes("配息");
    const transaction: NormalizedTransaction = {
      ...baseTransaction(
        row,
        "yuanta.brokerage-trade.v1",
        "brokerage",
        sourceAccount(row, cell(p, "交易帳號")),
        normalizeCurrency(
          firstCell(p, ["交割幣別", "商品幣別"]),
          "UNKNOWN",
        ),
        parseDate(cell(p, "交易日期")),
      ),
      description: [tradeType, cell(p, "商品名稱")].filter(Boolean).join(" "),
      inflow: isDividend ? amount : null,
      outflow: isDividend ? null : amount,
      amountSigned: amount === null ? null : isDividend ? amount : -amount,
      balanceAfter: null,
      status: isDividend ? "dividend" : "posted",
      includeInCashFlow: false,
      warnings: isDividend ? [] : ["trade cash-flow direction is not normalized yet"],
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

function classifyRow(row: RawTransactionOccurrence): Classification {
  const classifiers = [
    classifyDepositRow,
    classifyLoanRow,
    classifyCreditCardRow,
    classifyFundRow,
    classifyBrokerageRow,
  ];

  for (const classifier of classifiers) {
    const classified = classifier(row);
    if (classified) return classified;
  }

  return {
    row,
    transactions: [],
    positions: [],
    unsupportedReason: "no parser matched this row shape",
  };
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

function compareTransactionDate(
  left: NormalizedTransaction,
  right: NormalizedTransaction,
): number {
  const leftDate = left.date ?? "";
  const rightDate = right.date ?? "";
  if (leftDate !== rightDate) return leftDate.localeCompare(rightDate);
  return left.sourceRowIndex - right.sourceRowIndex;
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
  const leftDate = left.asOfDate ?? "";
  const rightDate = right.asOfDate ?? "";
  if (leftDate !== rightDate) return leftDate.localeCompare(rightDate);
  return left.sourceRowIndex - right.sourceRowIndex;
}

function computeTotals(positions: AssetPosition[]): FinancialModel["totals"] {
  const includedByCurrency: FinancialModel["totals"]["includedByCurrency"] = {};
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

function addCurrencyAmount(
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

function mergeCurrencyBuckets(...buckets: CurrencyBucket[]): CurrencyBucket {
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

function accountKindLabel(kind: DashboardAccount["kind"]): string {
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
): DashboardView {
  const includedPositions = positions.filter((position) => position.includeInTotals);
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
        transactions,
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
        accountTransactions,
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

  const seenSourceHashes = new Set<string>();
  for (const transaction of model.normalizedTransactions) {
    if (seenSourceHashes.has(transaction.sourceHash)) {
      issues.push({
        level: "warn",
        code: "transaction-source-reused",
        message: "Multiple normalized transactions share the same source row.",
        sourceRelativePath: transaction.sourceRelativePath,
        sourceRowIndex: transaction.sourceRowIndex,
      });
    }
    seenSourceHashes.add(transaction.sourceHash);
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

async function buildFinancialModel(input: Input): Promise<FinancialModel> {
  const ledgerDir = resolve(input.ledgerDir);
  const batches = await readJsonl<BatchRecord>(join(ledgerDir, "import_batches.jsonl"));
  const sourceAccountHints = await buildSourceAccountHints(batches);
  const rawRows = (
    await readJsonl<RawTransactionOccurrence>(
    join(ledgerDir, "raw_transaction_occurrences.jsonl"),
    )
  ).map((row) => ({
    ...row,
    sourceAccountHint: sourceAccountHints.get(row.sourceRelativePath),
  }));

  const rows = input.includeDuplicates
    ? rawRows
    : rawRows.filter((row) => row.dedupeStatus !== "duplicate");
  const sourceRows = new Map(rows.map((row) => [row.sourceHash, row]));
  const classifications = rows.map(classifyRow);
  const transactions = classifications.flatMap((item) => item.transactions);
  const directPositions = classifications.flatMap((item) => item.positions);
  const snapshotPositions = pickLatestSnapshotPositions(transactions, sourceRows);
  const assetPositions = reducePositions([...directPositions, ...snapshotPositions]);
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
  const dashboard = buildDashboardView(assetPositions, transactions);
  const baseModel = {
    schemaVersion: "financial-model.v1" as const,
    generatedAt: new Date().toISOString(),
    sourceLedgerDir: ledgerDir,
    counts: {
      rawRows: rawRows.length,
      uniqueRows: rawRows.filter((row) => row.dedupeStatus !== "duplicate").length,
      duplicateRows: rawRows.filter((row) => row.dedupeStatus === "duplicate").length,
      normalizedTransactions: transactions.length,
      assetPositions: assetPositions.length,
      includedPositions: assetPositions.filter((position) => position.includeInTotals)
        .length,
      auditOnlyRows: auditOnlyRows.length,
      unsupportedRows: unsupportedRows.length,
    },
    totals: computeTotals(assetPositions),
    dashboard,
    parserCoverage,
    assetPositions,
    normalizedTransactions: transactions,
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

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(value: number, currency: string): string {
  return `${currency} ${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
  }).format(value)}`;
}

function currencyBucketText(bucket: CurrencyBucket | undefined): string {
  const entries = Object.entries(bucket ?? {})
    .filter(([, value]) => Number.isFinite(value))
    .sort(([left], [right]) => {
      const order = ["TWD", "USD", "JPY", "UNKNOWN"];
      const leftIndex = order.indexOf(left);
      const rightIndex = order.indexOf(right);
      if (leftIndex !== -1 || rightIndex !== -1) {
        return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
      }
      return left.localeCompare(right);
    });

  if (entries.length === 0) return "-";
  return entries.map(([currency, value]) => money(value, currency)).join(" / ");
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function renderDashboard(model: FinancialModel): string {
  const generatedAt = new Date(model.generatedAt).toLocaleString("zh-TW", {
    hour12: false,
  });
  const firstAccountId = model.dashboard.institutions
    .flatMap((institution) => institution.groups)
    .flatMap((group) => group.accounts)[0]?.id;
  const overview = model.dashboard.overview;
  const summaryAccounts = model.dashboard.institutions
    .flatMap((institution) => institution.groups)
    .flatMap((group) => group.accounts);
  const summaryCounts = {
    all: summaryAccounts.length,
    cash: summaryAccounts.filter((account) => account.kind === "account").length,
    liability: summaryAccounts.filter((account) =>
      ["credit_card", "loan"].includes(account.kind),
    ).length,
    investment: summaryAccounts.filter((account) =>
      ["fund", "brokerage"].includes(account.kind),
    ).length,
  };
  const overviewMetrics = [
    {
      group: "淨值",
      label: "淨資產總額",
      value: currencyBucketText(overview.netAssets),
      primary: true,
      breakdown: [
        `${summaryCounts.all} 帳戶`,
        `${summaryCounts.cash} 現金`,
        `${summaryCounts.liability} 負債`,
        `${summaryCounts.investment} 投資`,
      ],
    },
    {
      group: "資產",
      label: "總台幣資產",
      value: currencyBucketText(overview.assets.totalTwdAssets),
      primary: false,
      breakdown: [],
    },
    {
      group: "資產",
      label: "總外幣資產",
      value: currencyBucketText(overview.assets.totalForeignAssets),
      primary: false,
      breakdown: [],
    },
    {
      group: "資產",
      label: "總投資資產",
      value: currencyBucketText(overview.assets.totalInvestmentAssets),
      primary: false,
      breakdown: [],
    },
    {
      group: "負債",
      label: "未結帳信用卡金額",
      value: currencyBucketText(overview.liabilities.unbilledCreditCardAmount),
      primary: false,
      breakdown: [],
    },
    {
      group: "負債",
      label: "貸款總餘額",
      value: currencyBucketText(overview.liabilities.loanTotalBalance),
      primary: false,
      breakdown: [],
    },
  ];
  const overviewHtml = overviewMetrics
    .map(
      (item) => `
        <div class="metric${item.primary ? " primary" : ""}">
          <span class="metric-label">${escapeHtml(item.group)} / ${escapeHtml(item.label)}</span>
          <div class="metric-value"><strong>${escapeHtml(item.value)}</strong></div>
          ${
            item.breakdown.length > 0
              ? `<div class="metric-breakdown">${item.breakdown
                  .map((label) => `<span>${escapeHtml(label)}</span>`)
                  .join("")}</div>`
              : ""
          }
        </div>`,
    )
    .join("");
  const coverageRows = Object.entries(model.parserCoverage)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([source, coverage]) => `
        <tr>
          <td>${escapeHtml(source)}</td>
          <td class="num">${coverage.rows}</td>
          <td class="num">${coverage.parsedRows}</td>
          <td class="num">${coverage.auditOnlyRows}</td>
          <td class="num">${coverage.unsupportedRows}</td>
        </tr>`,
    )
    .join("");
  const issueRows =
    model.quality.issues.length === 0
      ? `<tr><td colspan="4">No quality issues.</td></tr>`
      : model.quality.issues
          .map(
            (issue) => `
              <tr>
                <td>${escapeHtml(issue.level)}</td>
                <td>${escapeHtml(issue.code)}</td>
                <td>${escapeHtml(issue.message)}</td>
                <td>${escapeHtml(
                  issue.sourceRelativePath
                    ? `${issue.sourceRelativePath}:${issue.sourceRowIndex ?? ""}`
                    : "",
                )}</td>
              </tr>`,
          )
          .join("");
  const payload = {
    dashboard: model.dashboard,
    positions: model.assetPositions,
    transactions: model.normalizedTransactions,
    firstAccountId,
  };

  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Financial Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #ffffff;
      --surface: #f7f7f7;
      --surface-warm: #eeeeee;
      --fg: #111111;
      --fg-2: #3a3a3a;
      --muted: #707070;
      --border: #d9d9d9;
      --border-soft: #eeeeee;
      --accent: #111111;
      --accent-on: #ffffff;
      --success: #168a46;
      --warn: #b7791f;
      --danger: #c53030;
      --font-display: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-mono: "SF Mono", ui-monospace, Menlo, monospace;
      --radius-sm: 4px;
      --radius-md: 8px;
      --radius-lg: 12px;
      --radius-pill: 9999px;
      --focus-ring: 0 0 0 3px rgba(17, 17, 17, 0.18);
      --shadow-ring: 0 0 0 1px var(--border);
      --motion-fast: 150ms;
      --ease-standard: cubic-bezier(0.2, 0, 0, 1);
    }

    * { box-sizing: border-box; }
    html { background: var(--bg); }
    body {
      min-width: 0;
      margin: 0;
      background: var(--bg);
      color: var(--fg);
      font: 16px/1.52 var(--font-display);
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }
    button,
    input {
      font: inherit;
    }
    button { cursor: pointer; }
    h1, h2, h3 { margin: 0; letter-spacing: 0; }
    h1 {
      max-width: 760px;
      font: 650 54px/1.06 var(--font-display);
    }
    h2 { font: 650 24px/1.1 var(--font-display); }
    h3 {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
    }
    svg { display: block; stroke-width: 1.8; }
    .app {
      min-height: 100vh;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
    }
    .main {
      width: min(100%, 1600px);
      margin: 0 auto;
      padding: 24px clamp(16px, 4vw, 36px) 48px;
      display: grid;
      gap: 20px;
    }
    .topbar {
      min-width: 0;
      padding: 0;
      border: 0;
      background: transparent;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
    }
    .actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 12px;
      flex-wrap: wrap;
    }
    .label,
    .eyebrow,
    .metric-label,
    th,
    .chip {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0;
      text-transform: uppercase;
    }
    .subtle {
      color: var(--muted);
      font-size: 13px;
      margin-top: 4px;
    }
    .status {
      display: inline-flex;
      align-items: center;
      min-height: 30px;
      border: 1px solid var(--border);
      border-radius: var(--radius-pill);
      padding: 4px 12px;
      background: ${model.quality.status === "pass" ? "#eef8f2" : "#fff8ed"};
      color: ${model.quality.status === "pass" ? "var(--success)" : "var(--warn)"};
      font-weight: 750;
      text-transform: uppercase;
      font-size: 12px;
    }
    .tabs {
      width: max-content;
      max-width: 100%;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: color-mix(in oklab, var(--surface), var(--surface-warm) 14%);
      overflow: auto;
    }
    .tab-button {
      min-height: 34px;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--fg-2);
      font: inherit;
      font-size: 14px;
      font-weight: 650;
      padding: 0 14px;
      white-space: nowrap;
      transition:
        background var(--motion-fast) var(--ease-standard),
        color var(--motion-fast) var(--ease-standard),
        transform var(--motion-fast) var(--ease-standard),
        box-shadow var(--motion-fast) var(--ease-standard);
    }
    .tab-button:hover,
    .segment button:hover {
      background: var(--accent);
      color: var(--accent-on);
      transform: translateY(-1px);
      box-shadow: var(--shadow-ring);
    }
    .tab-button:focus-visible,
    .segment button:focus-visible,
    .account-row:focus-visible,
    .asset-button:focus-visible,
    input:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .tab-button[aria-selected="true"],
    .segment button[aria-pressed="true"] {
      background: var(--surface);
      border-color: var(--border);
      color: var(--fg);
      box-shadow: var(--shadow-ring);
    }
    .tab-panel[hidden] { display: none; }
    .summary-strip,
    .overview {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      align-items: stretch;
    }
    .metric {
      min-width: 0;
      min-height: 142px;
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      background: var(--surface);
      box-shadow: var(--shadow-ring);
      padding: 16px;
      display: grid;
      align-content: space-between;
      gap: 8px;
    }
    .metric.primary {
      border-color: var(--fg);
    }
    .metric-value {
      display: grid;
      gap: 2px;
    }
    .metric-value strong {
      display: block;
      font: 700 28px/1.08 var(--font-display);
      font-variant-numeric: tabular-nums;
      overflow-wrap: anywhere;
    }
    .metric-breakdown {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 4px;
    }
    .metric-breakdown span {
      min-height: 22px;
      padding: 3px 7px;
      border: 1px solid var(--border);
      border-radius: var(--radius-pill);
      background: var(--bg);
      color: var(--fg-2);
      font-size: 12px;
      line-height: 1.2;
      white-space: nowrap;
    }
    .workspace {
      display: grid;
      grid-template-columns: minmax(480px, 0.9fr) minmax(520px, 1.1fr);
      gap: 20px;
      align-items: start;
    }
    .panel,
    .detail-panel,
    .audit-panel {
      min-width: 0;
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      background: var(--surface);
      box-shadow: var(--shadow-ring);
      overflow: hidden;
    }
    .panel-head,
    .detail-head,
    .audit-head {
      min-height: 64px;
      padding: 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .panel-title,
    .detail-title {
      min-width: 0;
      display: grid;
      gap: 4px;
    }
    .panel-title strong,
    .detail-title strong {
      font: 650 24px/1.1 var(--font-display);
      overflow-wrap: anywhere;
    }
    .panel-body,
    .detail-body {
      padding: 20px;
    }
    .toolbar {
      display: grid;
      gap: 12px;
      margin-bottom: 16px;
    }
    .segment {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: color-mix(in oklab, var(--surface), var(--surface-warm) 14%);
      overflow: auto;
    }
    .segment button {
      min-height: 34px;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--fg-2);
      font-size: 14px;
      font-weight: 650;
      padding: 0 12px;
      white-space: nowrap;
      transition:
        background var(--motion-fast) var(--ease-standard),
        color var(--motion-fast) var(--ease-standard),
        transform var(--motion-fast) var(--ease-standard),
        box-shadow var(--motion-fast) var(--ease-standard);
    }
    .search {
      position: relative;
      min-width: 0;
    }
    .search svg {
      position: absolute;
      left: 16px;
      top: 50%;
      width: 17px;
      height: 17px;
      color: var(--muted);
      transform: translateY(-50%);
      pointer-events: none;
    }
    .search input {
      width: 100%;
      min-height: 44px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--surface);
      color: var(--fg);
      padding: 0 16px 0 44px;
      outline: none;
    }
    .account-list {
      display: grid;
      gap: 8px;
    }
    .account-row {
      width: 100%;
      min-width: 0;
      min-height: 78px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--surface);
      color: var(--fg);
      padding: 16px;
      display: grid;
      grid-template-columns: minmax(160px, 0.8fr) minmax(260px, 1.4fr) minmax(104px, 0.36fr);
      align-items: center;
      gap: 12px;
      text-align: left;
      transition:
        background var(--motion-fast) var(--ease-standard),
        border-color var(--motion-fast) var(--ease-standard),
        transform var(--motion-fast) var(--ease-standard);
    }
    .account-row:hover {
      transform: translateY(-1px);
      border-color: var(--accent);
    }
    .account-row[aria-pressed="true"],
    .account-row[data-selected="true"] {
      border-color: var(--accent);
      background: color-mix(in oklab, var(--surface), var(--surface-warm) 28%);
    }
    .account-main,
    .account-counts {
      min-width: 0;
      display: grid;
      gap: 6px;
    }
    .account-label {
      font: 650 16px/1.18 var(--font-display);
      overflow-wrap: anywhere;
    }
    .account-kind,
    .account-counts {
      color: var(--muted);
      font-size: 13px;
    }
    .account-metrics,
    .detail-metrics,
    .chip-row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      min-width: 0;
    }
    .metric-chip,
    .chip {
      min-height: 24px;
      border-radius: var(--radius-pill);
      border: 1px solid var(--border);
      background: color-mix(in oklab, var(--surface), white 30%);
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 8px;
      color: var(--fg-2);
      white-space: nowrap;
      max-width: 100%;
    }
    .metric-chip strong {
      color: var(--fg);
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .chip.asset { color: var(--success); }
    .chip.liability { color: var(--danger); }
    .chip.investment { color: var(--warn); }
    .detail-panel {
      position: sticky;
      top: 16px;
    }
    .detail-metrics {
      margin-bottom: 16px;
    }
    .detail-section + .detail-section { margin-top: 18px; }
    .table-wrap {
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      overflow: auto;
      background: var(--surface);
    }
    table {
      width: 100%;
      min-width: 720px;
      border-collapse: collapse;
      font-size: 12px;
    }
    th,
    td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border-soft);
      text-align: left;
      vertical-align: top;
    }
    th {
      background: color-mix(in oklab, var(--surface), var(--surface-warm) 16%);
      white-space: nowrap;
    }
    tr:last-child td { border-bottom: 0; }
    tbody tr:hover td {
      background: color-mix(in oklab, var(--surface), var(--surface-warm) 12%);
    }
    .asset-button {
      min-height: 28px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--bg);
      color: var(--fg);
      font: inherit;
      padding: 3px 8px;
      cursor: pointer;
      text-align: left;
      max-width: 100%;
    }
    .asset-button[aria-pressed="true"] {
      border-color: var(--accent);
      background: color-mix(in oklab, var(--surface), var(--surface-warm) 28%);
    }
    .num {
      text-align: right;
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .positive { color: var(--success); }
    .negative { color: var(--danger); }
    .muted { color: var(--muted); }
    .audit-panel { margin-top: 4px; }
    .audit-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      padding: 20px;
    }
    .empty {
      border: 1px dashed var(--border);
      border-radius: var(--radius-md);
      padding: 20px;
      color: var(--muted);
      background: color-mix(in oklab, var(--surface), var(--surface-warm) 12%);
    }
    .empty strong {
      display: block;
      margin-bottom: 4px;
      color: var(--fg);
      font: 650 16px/1.2 var(--font-display);
    }
    .source {
      color: var(--muted);
      font-size: 11px;
      max-width: 260px;
      overflow-wrap: anywhere;
    }
    @media (max-width: 1180px) {
      h1 { font-size: 44px; }
      .summary-strip,
      .overview { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .workspace { grid-template-columns: 1fr; }
      .detail-panel { position: static; }
    }
    @media (max-width: 720px) {
      h1 { font-size: 36px; }
      .main { padding: 16px 16px 32px; }
      .topbar,
      .panel-head,
      .detail-head,
      .audit-head {
        align-items: stretch;
        flex-direction: column;
      }
      .summary-strip,
      .overview {
        grid-template-columns: repeat(6, minmax(188px, 1fr));
        overflow-x: auto;
        padding-bottom: 4px;
        scroll-snap-type: x proximity;
      }
      .metric { scroll-snap-align: start; }
      .account-row {
        grid-template-columns: 1fr;
        align-items: start;
      }
      .audit-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="app">
    <main class="main">
      <header class="topbar">
        <div>
          <div class="eyebrow">Generated ${escapeHtml(generatedAt)}</div>
          <h1>Financial Dashboard</h1>
        </div>
        <div class="actions">
          <span class="status">${escapeHtml(model.quality.status)}</span>
        </div>
      </header>

    <div class="tabs" role="tablist" aria-label="Dashboard views">
      <button class="tab-button" id="tab-overview" type="button" role="tab" data-tab="overview" aria-controls="overview-panel" aria-selected="true">總覽</button>
      <button class="tab-button" id="tab-accounts" type="button" role="tab" data-tab="accounts" aria-controls="accounts-panel" aria-selected="false">帳戶</button>
    </div>

    <section class="tab-panel" id="overview-panel" role="tabpanel" aria-labelledby="tab-overview" data-tab-panel="overview">
      <div class="summary-strip overview" aria-label="Portfolio value and account counts">
        ${overviewHtml}
      </div>
    </section>

    <section class="tab-panel" id="accounts-panel" role="tabpanel" aria-labelledby="tab-accounts" data-tab-panel="accounts" hidden>
      <div class="workspace" id="accounts-workspace">
        <section class="panel account-panel" aria-labelledby="account-list-title">
          <div class="panel-head">
            <div class="panel-title">
              <span class="label">Account list</span>
              <strong id="account-list-title">帳戶</strong>
            </div>
            <span class="subtle" id="account-count" role="status" aria-live="polite">0 帳戶</span>
          </div>
          <div class="panel-body">
            <div class="toolbar">
              <div class="segment" aria-label="Account type filter">
                <button type="button" data-account-filter="all" aria-pressed="true">全部</button>
                <button type="button" data-account-filter="asset" aria-pressed="false">現金</button>
                <button type="button" data-account-filter="liability" aria-pressed="false">負債</button>
                <button type="button" data-account-filter="investment" aria-pressed="false">投資</button>
              </div>
              <label class="search" aria-label="Search accounts">
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
                  <path d="m21 21-4.35-4.35"></path>
                  <circle cx="11" cy="11" r="7"></circle>
                </svg>
                <input id="account-search" type="search" placeholder="搜尋帳戶、銀行、種類" />
              </label>
            </div>
            <div class="account-list" id="account-list" role="list"></div>
          </div>
        </section>
        <aside class="detail-panel" id="account-detail">
          <div class="detail-head">
            <div class="detail-title">
              <strong id="detail-title">明細</strong>
              <span class="subtle" id="detail-subtitle"></span>
            </div>
          </div>
          <div class="detail-body" id="detail-body"></div>
        </aside>
      </div>
    </section>

    <section class="audit-panel">
      <div class="audit-head">
        <h2>Data Quality</h2>
        <span class="subtle">${model.counts.normalizedTransactions} transactions / ${model.counts.assetPositions} positions / ${model.counts.unsupportedRows} unsupported</span>
      </div>
      <div class="audit-grid">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Source</th><th>Rows</th><th>Parsed</th><th>Audit</th><th>Unsupported</th></tr></thead>
            <tbody>${coverageRows}</tbody>
          </table>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Level</th><th>Code</th><th>Message</th><th>Source</th></tr></thead>
            <tbody>${issueRows}</tbody>
          </table>
        </div>
      </div>
    </section>
    </main>
  </div>
  <script>
    const payload = ${jsonForScript(payload)};
    const accounts = payload.dashboard.institutions.flatMap(function(institution) {
      return institution.groups.flatMap(function(group) {
        return group.accounts.map(function(account) {
          return Object.assign({ institutionLabel: institution.label, groupLabel: group.label }, account);
        });
      });
    });
    const accountsById = Object.fromEntries(accounts.map(function(account) { return [account.id, account]; }));
    const positionsById = Object.fromEntries(payload.positions.map(function(position) { return [position.id, position]; }));
    const transactionsById = Object.fromEntries(payload.transactions.map(function(transaction) { return [transaction.id, transaction]; }));
    const tabButtons = Array.from(document.querySelectorAll("[data-tab]"));
    const tabPanels = Array.from(document.querySelectorAll("[data-tab-panel]"));
    const accountList = document.getElementById("account-list");
    const accountCount = document.getElementById("account-count");
    const accountSearch = document.getElementById("account-search");
    const accountFilterButtons = Array.from(document.querySelectorAll("[data-account-filter]"));
    const accountDetail = document.getElementById("account-detail");
    const detailTitle = document.getElementById("detail-title");
    const detailSubtitle = document.getElementById("detail-subtitle");
    const detailBody = document.getElementById("detail-body");
    let selectedAccountId = payload.firstAccountId;
    let accountFilter = "all";
    const statusLabels = {
      posted: "已入帳",
      unbilled: "未結帳",
      payment: "繳款",
      detail: "明細",
      dividend: "配息",
      unknown: "未知"
    };

    function showTab(tabName) {
      for (const button of tabButtons) {
        const selected = button.dataset.tab === tabName;
        button.setAttribute("aria-selected", String(selected));
      }
      for (const panel of tabPanels) {
        panel.hidden = panel.dataset.tabPanel !== tabName;
      }
    }

    function escapeText(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function currencySort(left, right) {
      const order = ["TWD", "USD", "JPY", "UNKNOWN"];
      const leftIndex = order.indexOf(left);
      const rightIndex = order.indexOf(right);
      if (leftIndex !== -1 || rightIndex !== -1) {
        return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
      }
      return left.localeCompare(right);
    }

    function formatNumber(value) {
      return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
    }

    function formatMoney(value, currency) {
      return escapeText(currency + " " + formatNumber(value));
    }

    function formatBucket(bucket) {
      const entries = Object.entries(bucket || {})
        .filter(function(entry) { return Number.isFinite(entry[1]); })
        .sort(function(left, right) { return currencySort(left[0], right[0]); });
      if (entries.length === 0) return '<span class="muted">-</span>';
      return entries.map(function(entry) { return formatMoney(entry[1], entry[0]); }).join("<br>");
    }

    function metricHtml(metrics) {
      if (!metrics.length) return "";
      return '<div class="detail-metrics">' + metrics.map(function(metric) {
        const value = metric.value ? escapeText(metric.value) : formatBucket(metric.amounts);
        return '<span class="metric-chip"><span>' + escapeText(metric.label) + '</span><strong>' + value + '</strong></span>';
      }).join("") + "</div>";
    }

    function accountScope(account) {
      if (account.kind === "credit_card" || account.kind === "loan") return "liability";
      if (account.kind === "fund" || account.kind === "brokerage") return "investment";
      return "asset";
    }

    function accountScopeLabel(account) {
      const labels = {
        asset: "現金",
        liability: "負債",
        investment: "投資"
      };
      return labels[accountScope(account)] || "帳戶";
    }

    function accountMatchesFilter(account) {
      if (accountFilter === "all") return true;
      return accountScope(account) === accountFilter;
    }

    function accountMatchesSearch(account) {
      const query = accountSearch.value.trim().toLowerCase();
      if (!query) return true;
      const metricText = account.metrics.map(function(metric) {
        return [metric.label, metric.value, formatBucket(metric.amounts)].join(" ");
      }).join(" ");
      return [
        account.label,
        account.institution,
        account.institutionLabel,
        account.product,
        account.groupLabel,
        account.kind,
        metricText
      ].some(function(value) {
        return String(value || "").toLowerCase().includes(query);
      });
    }

    function renderAccountMetricChips(account) {
      if (!account.metrics.length) return "";
      return account.metrics.map(function(metric) {
        const value = metric.value ? escapeText(metric.value) : formatBucket(metric.amounts);
        return '<span class="metric-chip"><span>' + escapeText(metric.label) + '</span><strong>' + value + '</strong></span>';
      }).join("");
    }

    function renderAccounts() {
      if (!accountList) return;
      const filtered = accounts.filter(accountMatchesFilter).filter(accountMatchesSearch);
      if (accountCount) {
        accountCount.textContent = String(filtered.length) + " / " + String(accounts.length) + " 帳戶";
      }

      if (!filtered.some(function(account) { return account.id === selectedAccountId; }) && filtered[0]) {
        selectedAccountId = filtered[0].id;
        renderDetail(selectedAccountId);
      }

      if (!filtered.length) {
        accountList.innerHTML = '<div class="empty" role="status"><strong>找不到符合的帳戶</strong><span>請調整篩選或搜尋字詞。</span></div>';
        return;
      }

      accountList.innerHTML = filtered.map(function(account) {
        const selected = account.id === selectedAccountId;
        const scope = accountScope(account);
        return '<button class="account-row" type="button" data-account-id="' + escapeText(account.id) + '" data-selected="' + String(selected) + '" aria-pressed="' + String(selected) + '">' +
          '<span class="account-main">' +
            '<span class="account-label">' + escapeText(account.label) + '</span>' +
            '<span class="account-kind">' + escapeText(account.institutionLabel + " / " + account.groupLabel) + '</span>' +
          '</span>' +
          '<span class="account-metrics">' + renderAccountMetricChips(account) + '</span>' +
          '<span class="account-counts">' +
            '<span class="chip ' + scope + '">' + escapeText(accountScopeLabel(account)) + '</span>' +
            '<span>' + String(account.positionIds.length) + ' asset</span>' +
            '<span>' + String(account.transactionIds.length) + ' tx</span>' +
          '</span>' +
        '</button>';
      }).join("");

      for (const button of Array.from(accountList.querySelectorAll("[data-account-id]"))) {
        button.addEventListener("click", function() {
          showTab("accounts");
          selectedAccountId = button.dataset.accountId;
          renderDetail(selectedAccountId);
          renderAccounts();
          if (accountDetail) accountDetail.scrollIntoView({ block: "start", behavior: "smooth" });
        });
      }
    }

    function rowAmount(transaction) {
      if (transaction.amountSigned === null || transaction.amountSigned === undefined) {
        return '<span class="muted">-</span>';
      }
      const className = transaction.amountSigned < 0 ? "negative" : "positive";
      return '<span class="' + className + '">' + formatMoney(transaction.amountSigned, transaction.currency) + "</span>";
    }

    function positionValue(position) {
      const className = position.valueSign === "liability" ? "negative" : "positive";
      return '<span class="' + className + '">' + formatMoney(position.value, position.currency) + "</span>";
    }

    function sourceText(item) {
      return escapeText(item.sourceRelativePath + ":" + item.sourceRowIndex);
    }

    function relatedTransactions(position, transactions) {
      if (!position) return transactions;
      const parts = position.label.split(/\\s+/).filter(Boolean);
      const symbol = parts[0] || "";
      const name = parts.length > 1 ? parts.slice(1).join(" ") : position.label;
      const candidates = [symbol, name, position.label].filter(function(value) {
        return value && value.length >= 2;
      });
      return transactions.filter(function(transaction) {
        return candidates.some(function(candidate) {
          return transaction.description.includes(candidate) || position.label.includes(candidate);
        });
      });
    }

    function renderPositions(account, positions, selectedPositionId) {
      if (positions.length === 0) return '<div class="empty">No asset records.</div>';
      const rows = positions.map(function(position) {
        const selected = selectedPositionId === position.id;
        const label = account.kind === "brokerage"
          ? '<button class="asset-button" type="button" data-position-id="' + escapeText(position.id) + '" aria-pressed="' + String(selected) + '">' + escapeText(position.label) + '</button>'
          : escapeText(position.label);
        return '<tr><td>' + label + '</td><td>' + escapeText(position.assetClass) + '</td><td class="num">' + positionValue(position) + '</td><td>' + escapeText(position.asOfDate || "-") + '</td><td>' + escapeText(position.includeInTotals ? "included" : "audit") + '</td><td class="source">' + sourceText(position) + '</td></tr>';
      }).join("");
      return '<div class="table-wrap"><table><thead><tr><th>資產</th><th>種類</th><th>金額</th><th>日期</th><th>Total</th><th>Source</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    }

    function renderTransactions(transactions) {
      if (transactions.length === 0) return '<div class="empty">No transaction records.</div>';
      const rows = transactions
        .slice()
        .sort(function(left, right) {
          return String(right.date || "").localeCompare(String(left.date || "")) || right.sourceRowIndex - left.sourceRowIndex;
        })
        .map(function(transaction) {
          return '<tr><td>' + escapeText(transaction.date || "-") + '</td><td>' + escapeText(statusLabels[transaction.status] || transaction.status) + '</td><td>' + escapeText(transaction.description || "-") + '</td><td class="num">' + rowAmount(transaction) + '</td><td class="source">' + sourceText(transaction) + '</td></tr>';
        })
        .join("");
      return '<div class="table-wrap"><table><thead><tr><th>日期</th><th>狀態</th><th>描述</th><th>金額</th><th>Source</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    }

    function renderDetail(accountId, selectedPositionId) {
      const account = accountsById[accountId];
      if (!account) return;
      selectedAccountId = accountId;
      for (const button of Array.from(document.querySelectorAll("[data-account-id]"))) {
        button.setAttribute("aria-pressed", String(button.dataset.accountId === accountId));
        button.setAttribute("data-selected", String(button.dataset.accountId === accountId));
      }
      const positions = account.positionIds.map(function(id) { return positionsById[id]; }).filter(Boolean);
      const transactions = account.transactionIds.map(function(id) { return transactionsById[id]; }).filter(Boolean);
      const selectedPosition = selectedPositionId ? positionsById[selectedPositionId] : null;
      const shownTransactions = account.kind === "brokerage"
        ? relatedTransactions(selectedPosition, transactions)
        : transactions;

      detailTitle.textContent = account.label;
      detailSubtitle.textContent = account.institutionLabel + " / " + account.groupLabel;
      detailBody.innerHTML =
        metricHtml(account.metrics) +
        '<div class="detail-section"><h3>資產</h3>' + renderPositions(account, positions, selectedPositionId) + '</div>' +
        '<div class="detail-section"><h3>交易紀錄</h3>' + renderTransactions(shownTransactions) + '</div>';

      for (const button of Array.from(detailBody.querySelectorAll("[data-position-id]"))) {
        button.addEventListener("click", function() {
          renderDetail(accountId, button.dataset.positionId);
        });
      }
    }
    for (const button of tabButtons) {
      button.addEventListener("click", function() {
        showTab(button.dataset.tab);
      });
    }

    for (const button of accountFilterButtons) {
      button.addEventListener("click", function() {
        accountFilter = button.dataset.accountFilter;
        for (const item of accountFilterButtons) {
          item.setAttribute("aria-pressed", String(item === button));
        }
        renderAccounts();
      });
    }

    accountSearch.addEventListener("input", renderAccounts);

    showTab("overview");
    renderAccounts();
    renderDetail(payload.firstAccountId);
  </script>
</body>
</html>`;
}

type LedgerLensGroup = "asset" | "liability" | "investment";

type LedgerLensAccount = {
  id: string;
  label: string;
  institution: string;
  kind: DashboardAccount["kind"];
  kindLabel: string;
  group: LedgerLensGroup;
  source: string;
  amounts: CurrencyBucket;
  positionIds: string[];
  transactionIds: string[];
};

const dashboardCurrencyOrder = ["TWD", "USD", "JPY", "UNKNOWN"];

function sortCurrencyCode(left: string, right: string): number {
  const leftIndex = dashboardCurrencyOrder.indexOf(left);
  const rightIndex = dashboardCurrencyOrder.indexOf(right);
  if (leftIndex !== -1 || rightIndex !== -1) {
    return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
  }
  return left.localeCompare(right);
}

function scaledCurrencyBucket(bucket: CurrencyBucket | undefined, scale: number): CurrencyBucket {
  const scaled: CurrencyBucket = {};
  for (const [currency, value] of Object.entries(bucket ?? {})) {
    if (Number.isFinite(value)) scaled[currency] = value * scale;
  }
  return scaled;
}

function hasCurrencyAmounts(bucket: CurrencyBucket | undefined): boolean {
  return Object.values(bucket ?? {}).some((value) => Number.isFinite(value));
}

function formatDashboardMoney(value: number, currency: string): string {
  const normalized = Object.is(value, -0) ? 0 : value;
  const digits = currency === "TWD" || currency === "JPY" ? 0 : 2;
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Math.abs(normalized));
  return `${normalized < 0 ? "-" : ""}${currency} ${formatted}`;
}

function currencyBucketLines(bucket: CurrencyBucket | undefined): string[] {
  const entries = Object.entries(bucket ?? {})
    .filter(([, value]) => Number.isFinite(value))
    .sort(([left], [right]) => sortCurrencyCode(left, right));
  if (entries.length === 0) return ["-"];
  return entries.map(([currency, value]) => formatDashboardMoney(value, currency));
}

function currencyBucketSign(bucket: CurrencyBucket | undefined): "positive" | "negative" | "neutral" {
  const firstValue = Object.entries(bucket ?? {})
    .filter(([, value]) => Number.isFinite(value) && value !== 0)
    .sort(([left], [right]) => sortCurrencyCode(left, right))[0]?.[1];
  if (firstValue === undefined) return "neutral";
  return firstValue < 0 ? "negative" : "positive";
}

function latestDashboardDate(model: FinancialModel): string {
  const dates = [
    ...model.assetPositions.map((position) => position.asOfDate),
    ...model.normalizedTransactions.map((transaction) => transaction.date),
    model.generatedAt.slice(0, 10),
  ].filter((value): value is string => Boolean(value));
  return dates.sort().at(-1) ?? model.generatedAt.slice(0, 10);
}

function ledgerLensGroup(account: DashboardAccount): LedgerLensGroup {
  if (account.kind === "credit_card" || account.kind === "loan") return "liability";
  if (account.kind === "fund" || account.kind === "brokerage") return "investment";
  return "asset";
}

function accountSourceLabel(
  account: DashboardAccount,
  positionsById: Map<string, AssetPosition>,
  transactionsById: Map<string, NormalizedTransaction>,
): string {
  const source =
    account.positionIds.map((id) => positionsById.get(id)?.sourceRelativePath).find(Boolean) ??
    account.transactionIds.map((id) => transactionsById.get(id)?.sourceRelativePath).find(Boolean);
  if (!source) return account.product;
  const [folder] = source.split("/");
  return folder || source;
}

function signedAccountAmounts(
  account: DashboardAccount,
  positionsById: Map<string, AssetPosition>,
): CurrencyBucket {
  const bucket: CurrencyBucket = {};
  for (const id of account.positionIds) {
    const position = positionsById.get(id);
    if (!position || !position.includeInTotals || position.valueSign === "informational") continue;
    const sign = position.valueSign === "liability" ? -1 : 1;
    addCurrencyAmount(bucket, position.currency, position.value * sign);
  }
  if (hasCurrencyAmounts(bucket)) return bucket;

  const fallbackMetric = account.metrics.find((item) => hasCurrencyAmounts(item.amounts));
  const fallbackScale = ledgerLensGroup(account) === "liability" ? -1 : 1;
  return scaledCurrencyBucket(fallbackMetric?.amounts, fallbackScale);
}

function buildLedgerLensAccounts(model: FinancialModel): LedgerLensAccount[] {
  const positionsById = new Map(model.assetPositions.map((position) => [position.id, position]));
  const transactionsById = new Map(
    model.normalizedTransactions.map((transaction) => [transaction.id, transaction]),
  );
  return model.dashboard.institutions.flatMap((institution) =>
    institution.groups.flatMap((group) =>
      group.accounts.map((account) => ({
        id: account.id,
        label: account.label,
        institution: institution.label,
        kind: account.kind,
        kindLabel: accountKindLabel(account.kind),
        group: ledgerLensGroup(account),
        source: accountSourceLabel(account, positionsById, transactionsById),
        amounts: signedAccountAmounts(account, positionsById),
        positionIds: account.positionIds,
        transactionIds: account.transactionIds,
      })),
    ),
  );
}

function renderSummaryMetric(input: {
  label: string;
  amounts: CurrencyBucket;
  primary?: boolean;
  breakdown: string[];
}): string {
  const [primaryLine, ...secondaryLines] = currencyBucketLines(input.amounts);
  return `
        <div class="metric${input.primary ? " primary" : ""}">
          <span class="metric-label">${escapeHtml(input.label)}</span>
          <div class="metric-value">
            <strong><span data-sensitive>${escapeHtml(primaryLine)}</span></strong>
            ${secondaryLines.length > 0 ? `<small data-sensitive>${escapeHtml(secondaryLines.join(" / "))}</small>` : ""}
          </div>
          ${
            input.breakdown.length > 0
              ? `<div class="metric-breakdown">${input.breakdown
                  .map((item) => `<span>${escapeHtml(item)}</span>`)
                  .join("")}</div>`
              : ""
          }
        </div>`;
}

function renderPlainSummaryMetric(input: {
  label: string;
  value: string;
  primary?: boolean;
  breakdown: string[];
}): string {
  return `
        <div class="metric${input.primary ? " primary" : ""}">
          <span class="metric-label">${escapeHtml(input.label)}</span>
          <div class="metric-value">
            <strong>${escapeHtml(input.value)}</strong>
          </div>
          ${
            input.breakdown.length > 0
              ? `<div class="metric-breakdown">${input.breakdown
                  .map((item) => `<span>${escapeHtml(item)}</span>`)
                  .join("")}</div>`
              : ""
          }
        </div>`;
}

function renderLedgerLensStyles(includeSources = false): string {
  return `
    :root {
      color-scheme: light;
      --bg: #ffffff;
      --surface: #f7f7f7;
      --surface-warm: #eeeeee;
      --fg: #111111;
      --fg-2: #3a3a3a;
      --muted: #707070;
      --border: #d9d9d9;
      --border-soft: #eeeeee;
      --accent: #111111;
      --accent-on: #ffffff;
      --success: #168a46;
      --warn: #b7791f;
      --danger: #c53030;
      --font-display: Inter, system-ui, sans-serif;
      --font-body: Inter, system-ui, sans-serif;
      --font-mono: "SF Mono", ui-monospace, Menlo, monospace;
      --text-xs: 12px;
      --text-sm: 14px;
      --text-base: 16px;
      --text-lg: 18px;
      --text-xl: 24px;
      --text-2xl: 36px;
      --text-3xl: 54px;
      --leading-body: 1.52;
      --leading-tight: 1.06;
      --space-1: 4px;
      --space-2: 8px;
      --space-3: 12px;
      --space-4: 16px;
      --space-5: 20px;
      --space-6: 24px;
      --space-8: 32px;
      --space-12: 48px;
      --radius-sm: 4px;
      --radius-md: 8px;
      --radius-lg: 12px;
      --radius-pill: 9999px;
      --elev-ring: 0 0 0 1px var(--border);
      --elev-raised: 0 16px 40px rgba(0, 0, 0, 0.10);
      --focus-ring: 0 0 0 3px rgba(17, 17, 17, 0.18);
      --motion-fast: 150ms;
      --ease-standard: cubic-bezier(0.2, 0, 0, 1);
      --container-gutter-desktop: 36px;
      --container-gutter-phone: 16px;
    }
    * { box-sizing: border-box; }
    html { min-width: 0; background: var(--bg); }
    body {
      min-width: 0;
      margin: 0;
      color: var(--fg);
      background: var(--bg);
      font: var(--text-base)/var(--leading-body) var(--font-body);
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }
    body.modal-open { overflow: hidden; }
    button, input, select { font: inherit; }
    button { cursor: pointer; }
    svg { display: block; stroke-width: 1.8; }
    h1 {
      max-width: 760px;
      margin: var(--space-1) 0 0;
      font: 650 clamp(38px, 5.2vw, var(--text-3xl))/var(--leading-tight) var(--font-display);
      letter-spacing: 0;
      text-wrap: balance;
    }
    .app {
      min-width: 0;
      min-height: 100vh;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
    }
    .main {
      min-width: 0;
      padding: var(--space-6) clamp(var(--container-gutter-phone), 4vw, var(--container-gutter-desktop)) var(--space-12);
      display: grid;
      gap: var(--space-5);
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--space-4);
    }
    .actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: var(--space-3);
      flex-wrap: wrap;
    }
    .visibility-toggle {
      min-height: 42px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 0 var(--space-4);
      background: var(--surface);
      color: var(--fg);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-2);
      font-weight: 560;
      letter-spacing: 0.02em;
      cursor: pointer;
      user-select: none;
      transition: background var(--motion-fast) var(--ease-standard), color var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-standard), box-shadow var(--motion-fast) var(--ease-standard);
    }
    .visibility-toggle:hover {
      background: var(--accent);
      color: var(--accent-on);
      transform: translateY(-1px);
      box-shadow: var(--elev-ring);
    }
    .visibility-toggle input {
      width: 16px;
      height: 16px;
      accent-color: var(--accent);
    }
    .visibility-toggle:has(input:focus-visible) {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    html[data-values-visible="false"] [data-sensitive] {
      color: var(--muted);
    }
    .label, .eyebrow, .table th, .chip, .metric-label {
      color: var(--muted);
      font-size: var(--text-xs);
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .btn, .segment button {
      min-height: 40px;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--fg-2);
      font-weight: 560;
      letter-spacing: 0.02em;
      transition: background var(--motion-fast) var(--ease-standard), color var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-standard), box-shadow var(--motion-fast) var(--ease-standard);
    }
    .btn {
      min-height: 42px;
      padding: 0 var(--space-4);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-2);
      background: var(--surface);
      border-color: var(--border);
      color: var(--fg);
      text-decoration: none;
    }
    .btn:hover, .segment button:hover {
      background: var(--accent);
      color: var(--accent-on);
      transform: translateY(-1px);
      box-shadow: var(--elev-ring);
    }
    .btn:focus-visible, .segment button:focus-visible, .account-main:focus-visible, .tx-chip:focus-visible, .asset-chip:focus-visible, input:focus-visible, select:focus-visible, .sort-button:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .summary-strip {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: var(--space-3);
      align-items: stretch;
    }
    .metric {
      min-width: 0;
      min-height: 142px;
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      background: var(--surface);
      box-shadow: var(--elev-ring);
      padding: var(--space-4);
      display: grid;
      align-content: space-between;
      gap: var(--space-2);
    }
    .metric.primary { border-color: var(--fg); }
    .metric-value { display: grid; gap: 2px; }
    .metric strong {
      display: block;
      font: 700 clamp(22px, 2.4vw, 32px)/1.05 var(--font-display);
      font-variant-numeric: tabular-nums;
      overflow-wrap: anywhere;
    }
    .metric-value small {
      color: var(--fg-2);
      font: 650 var(--text-sm)/1.2 var(--font-mono);
      letter-spacing: 0.01em;
    }
    .metric-breakdown {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: var(--space-1);
    }
    .metric-breakdown span, .chip {
      min-height: 22px;
      padding: 3px 7px;
      border: 1px solid var(--border);
      border-radius: var(--radius-pill);
      background: var(--bg);
      color: var(--fg-2);
      line-height: 1.2;
      white-space: nowrap;
    }
    .workbench {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-5);
      align-items: start;
    }
    .panel {
      min-width: 0;
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      background: var(--surface);
      box-shadow: var(--elev-ring);
      overflow: hidden;
    }
    .panel-head {
      min-height: 64px;
      padding: var(--space-5);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
    }
    .panel-title { display: grid; gap: var(--space-1); }
    .panel-title strong { font: 650 var(--text-xl)/1.08 var(--font-display); }
    .panel-body { padding: var(--space-5); }
    .toolbar { display: grid; gap: var(--space-3); margin-bottom: var(--space-4); }
    .segment {
      display: flex;
      align-items: center;
      gap: var(--space-1);
      padding: var(--space-1);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: color-mix(in oklab, var(--surface), var(--surface-warm) 14%);
      overflow: auto;
    }
    .segment button {
      min-height: 34px;
      padding: 0 var(--space-3);
      white-space: nowrap;
      font-size: var(--text-sm);
    }
    .segment button[aria-pressed="true"] {
      background: var(--surface);
      border-color: var(--border);
      color: var(--fg);
      box-shadow: var(--elev-ring);
    }
    .search { position: relative; min-width: 0; }
    .search svg {
      position: absolute;
      left: var(--space-4);
      top: 50%;
      width: 17px;
      height: 17px;
      color: var(--muted);
      transform: translateY(-50%);
      pointer-events: none;
    }
    .search input {
      width: 100%;
      min-height: 44px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--surface);
      color: var(--fg);
      padding: 0 var(--space-4) 0 44px;
      outline: none;
    }
    .account-list, .source-list { display: grid; gap: var(--space-2); }
    .account-row {
      width: 100%;
      min-width: 0;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--surface);
      color: var(--fg);
      padding: var(--space-4);
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-areas: "main amount" "actions amount";
      gap: var(--space-3);
      text-align: left;
      transition: background var(--motion-fast) var(--ease-standard), border-color var(--motion-fast) var(--ease-standard), transform var(--motion-fast) var(--ease-standard);
    }
    .account-row:hover { transform: translateY(-1px); border-color: var(--accent); }
    .account-row[data-selected="true"] {
      border-color: var(--accent);
      background: color-mix(in oklab, var(--surface), var(--surface-warm) 28%);
    }
    .account-row[data-selected="true"] .account-name strong {
      text-decoration: underline;
      text-underline-offset: 4px;
      text-decoration-thickness: 1px;
    }
    .account-main {
      grid-area: main;
      min-width: 0;
      border: 0;
      border-radius: var(--radius-sm);
      background: transparent;
      color: inherit;
      padding: 0;
      text-align: left;
      cursor: pointer;
    }
    .account-name { min-width: 0; display: grid; gap: var(--space-2); }
    .account-name strong {
      overflow-wrap: anywhere;
      font: 650 var(--text-base)/1.18 var(--font-display);
    }
    .account-line, .muted {
      color: var(--muted);
      font-size: var(--text-sm);
    }
    .amount {
      grid-area: amount;
      align-self: start;
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
      white-space: normal;
      text-align: right;
    }
    .amount span { display: block; }
    .positive { color: var(--success); }
    .negative { color: var(--danger); }
    .neutral { color: var(--fg-2); }
    .chip-row {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      flex-wrap: wrap;
    }
    .account-actions { grid-area: actions; }
    .chip {
      display: inline-flex;
      align-items: center;
      font-size: var(--text-xs);
      font-weight: 700;
      text-transform: uppercase;
    }
    .chip.asset { color: var(--success); }
    .chip.liability { color: var(--danger); }
    .chip.investment, .chip.review { color: var(--warn); }
    .chip.ready { color: var(--success); }
    .chip.unsupported, .chip.fail { color: var(--danger); }
    .tx-chip, .asset-chip {
      cursor: pointer;
      font: inherit;
      letter-spacing: inherit;
      text-transform: inherit;
    }
    .tx-chip:hover, .asset-chip:hover {
      border-color: var(--accent);
      color: var(--fg);
      background: color-mix(in oklab, var(--surface), var(--surface-warm) 45%);
    }
    .table-wrap {
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--surface);
      overflow: auto;
    }
    .table {
      width: 100%;
      min-width: 760px;
      border-collapse: collapse;
      font-size: var(--text-sm);
    }
    .table th, .table td {
      padding: var(--space-3) var(--space-4);
      border-bottom: 1px solid var(--border-soft);
      text-align: left;
      vertical-align: middle;
    }
    .table th { background: color-mix(in oklab, var(--surface), var(--surface-warm) 16%); }
    .table tbody tr:hover td { background: color-mix(in oklab, var(--surface), var(--surface-warm) 12%); }
    .table tr:last-child td { border-bottom: 0; }
    .table .num {
      text-align: right;
      font-family: var(--font-mono);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .sort-button {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      border: 0;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font: inherit;
      letter-spacing: inherit;
      text-transform: inherit;
      padding: 0;
    }
    .sort-button:hover {
      color: var(--fg);
      text-decoration: underline;
      text-underline-offset: 3px;
    }
    .sort-mark {
      min-width: 1.2em;
      color: var(--muted);
      font-family: var(--font-mono);
      line-height: 1;
    }
    .modal-layer {
      position: fixed;
      inset: 0;
      z-index: 20;
      display: grid;
      place-items: center;
      padding: var(--space-5);
    }
    .modal-layer[hidden] { display: none; }
    .modal-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(17, 17, 17, 0.28);
      backdrop-filter: blur(3px);
    }
    .tx-window {
      position: relative;
      z-index: 1;
      width: min(960px, 100%);
      max-height: min(760px, calc(100vh - 48px));
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      background: var(--bg);
      box-shadow: var(--elev-raised);
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr);
      overflow: hidden;
    }
    .tx-window.has-tools { grid-template-rows: auto auto auto minmax(0, 1fr); }
    .tx-window-head, .tx-window-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      padding: var(--space-5);
      border-bottom: 1px solid var(--border-soft);
    }
    .tx-window-title {
      display: grid;
      gap: var(--space-1);
      min-width: 0;
    }
    .tx-window-title strong {
      font: 700 var(--text-xl)/1.12 var(--font-display);
      letter-spacing: 0;
      overflow-wrap: anywhere;
    }
    .tx-close {
      width: 40px;
      height: 40px;
      flex: 0 0 auto;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--surface);
      color: var(--fg);
      font-size: 24px;
      line-height: 1;
    }
    .tx-close:hover, .tx-close:focus-visible {
      border-color: var(--accent);
      outline: none;
      box-shadow: var(--focus-ring);
    }
    .tx-window-meta {
      justify-content: flex-start;
      flex-wrap: wrap;
      padding-top: var(--space-3);
      padding-bottom: var(--space-3);
    }
    .tx-window .table-wrap {
      border: 0;
      border-radius: 0;
      min-height: 0;
      max-height: 100%;
    }
    .tx-table-tools {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) 180px auto;
      gap: var(--space-3);
      align-items: end;
      padding: var(--space-4) var(--space-5);
      border-bottom: 1px solid var(--border-soft);
      background: color-mix(in oklab, var(--surface), white 18%);
    }
    .tx-filter, .field {
      display: grid;
      gap: var(--space-2);
      color: var(--muted);
      font: 600 var(--text-xs)/1 var(--font-body);
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .tx-filter input, .tx-filter select, .field input, .field select {
      min-height: 40px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--bg);
      color: var(--fg);
      font: 500 var(--text-sm)/1.2 var(--font-body);
      letter-spacing: 0;
      text-transform: none;
      padding: 0 var(--space-3);
      outline: none;
    }
    .tx-filter-count, .result-count {
      justify-self: end;
      padding-bottom: 11px;
      color: var(--muted);
      font: 600 var(--text-xs)/1 var(--font-mono);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .tx-table-empty td {
      color: var(--muted);
      text-align: center;
      padding: var(--space-8);
    }
    .empty {
      border: 1px dashed var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-5);
      color: var(--muted);
      background: color-mix(in oklab, var(--surface), var(--surface-warm) 12%);
    }
    .empty strong {
      display: block;
      margin-bottom: var(--space-1);
      color: var(--fg);
      font: 650 var(--text-base)/1.2 var(--font-display);
    }
    ${
      includeSources
        ? `
    .sources {
      display: grid;
      grid-template-columns: minmax(300px, 0.85fr) minmax(0, 1.15fr);
      gap: var(--space-5);
      align-items: start;
    }
    .panel-tools {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(150px, auto) auto;
      gap: var(--space-3);
      align-items: end;
      margin-bottom: var(--space-4);
    }
    .source-card {
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-4);
      background: var(--bg);
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(96px, auto);
      gap: var(--space-3);
      align-items: center;
    }
    .source-card strong {
      display: block;
      overflow-wrap: anywhere;
    }
    .source-card span {
      color: var(--muted);
      font-size: var(--text-sm);
    }
    .source-meta {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      margin-top: var(--space-2);
      align-items: center;
    }
    .progress {
      height: 6px;
      margin-top: var(--space-2);
      border-radius: var(--radius-pill);
      background: var(--surface-warm);
      overflow: hidden;
    }
    .progress span {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: var(--accent);
    }
    .table td {
      color: var(--fg-2);
      font-size: var(--text-sm);
    }
    .table td strong {
      display: block;
      color: var(--fg);
      font-weight: 650;
      overflow-wrap: anywhere;
    }
    .table-meta {
      display: block;
      margin-top: 2px;
      color: var(--muted);
      font-size: var(--text-xs);
    }`
        : ""
    }
    @media (max-width: 820px) {
      .sources { grid-template-columns: 1fr; }
      .panel-tools { grid-template-columns: 1fr; }
      .result-count { justify-self: start; padding-bottom: 0; }
    }
    @media (max-width: 720px) {
      .main { padding: var(--space-4) var(--container-gutter-phone) var(--space-8); }
      .topbar {
        align-items: stretch;
        flex-direction: column;
        display: flex;
      }
      .actions, .btn { width: 100%; }
      .summary-strip {
        grid-template-columns: repeat(4, minmax(156px, 1fr));
        overflow-x: auto;
        padding-bottom: var(--space-1);
        scroll-snap-type: x proximity;
      }
      .metric { scroll-snap-align: start; }
      .account-row {
        grid-template-columns: 1fr;
        grid-template-areas: "main" "amount" "actions";
      }
      .amount { text-align: left; }
      .modal-layer { padding: var(--space-3); }
      .tx-window { max-height: calc(100vh - 24px); }
      .tx-window-head { align-items: flex-start; }
      .tx-window-head, .tx-window-meta, .tx-table-tools {
        padding-left: var(--space-4);
        padding-right: var(--space-4);
      }
      .tx-table-tools { grid-template-columns: 1fr; }
      .tx-filter-count { justify-self: start; padding-bottom: 0; }
      .table th, .table td { padding: var(--space-3); }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        scroll-behavior: auto !important;
        transition-duration: 0.01ms !important;
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
      }
    }`;
}

function renderLedgerLensDashboard(model: FinancialModel, sourcesHref: string): string {
  const accounts = buildLedgerLensAccounts(model);
  const snapshotDate = latestDashboardDate(model);
  const summaryCounts = {
    all: accounts.length,
    asset: accounts.filter((account) => account.group === "asset").length,
    liability: accounts.filter((account) => account.group === "liability").length,
    investment: accounts.filter((account) => account.group === "investment").length,
  };
  const overview = model.dashboard.overview;
  const overviewHtml = [
    renderSummaryMetric({
      label: "Net position",
      amounts: overview.netAssets,
      primary: true,
      breakdown: [
        `${summaryCounts.all} accounts`,
        `${summaryCounts.asset} asset`,
        `${summaryCounts.liability} liability`,
        `${summaryCounts.investment} investment`,
      ],
    }),
    renderSummaryMetric({
      label: "Asset value",
      amounts: mergeCurrencyBuckets(
        overview.assets.totalTwdAssets,
        overview.assets.totalForeignAssets,
      ),
      breakdown: [
        `${accounts.filter((account) => account.kind === "account").length} bank accounts`,
        `${accounts.filter((account) => account.amounts.USD || account.amounts.JPY).length} foreign deposits`,
      ],
    }),
    renderSummaryMetric({
      label: "Liabilities",
      amounts: scaledCurrencyBucket(
        mergeCurrencyBuckets(
          overview.liabilities.unbilledCreditCardAmount,
          overview.liabilities.loanTotalBalance,
        ),
        -1,
      ),
      breakdown: [
        `${accounts.filter((account) => account.kind === "loan").length} loans`,
        `${accounts.filter((account) => account.kind === "credit_card").length} credit cards`,
      ],
    }),
    renderSummaryMetric({
      label: "Investments",
      amounts: overview.assets.totalInvestmentAssets,
      breakdown: [
        `${accounts.filter((account) => account.kind === "fund").length} funds`,
        `${accounts.filter((account) => account.kind === "brokerage").length} brokerage`,
      ],
    }),
  ].join("");
  const firstAccountId = accounts[0]?.id ?? null;
  const payload = {
    accounts,
    positions: model.assetPositions,
    transactions: model.normalizedTransactions,
    firstAccountId,
  };

  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>LedgerLens Accounts</title>
  <style>${renderLedgerLensStyles()}</style>
</head>
<body>
  <div class="app">
    <main class="main">
      <header class="topbar">
        <div>
          <div class="eyebrow">Snapshot ${escapeHtml(snapshotDate)}</div>
          <h1>Account overview</h1>
        </div>
        <div class="actions">
          <label class="visibility-toggle">
            <input id="value-visibility" type="checkbox" checked />
            <span id="value-visibility-label">Values visible</span>
          </label>
          <a class="btn" href="${escapeHtml(sourcesHref)}">Statement sources</a>
        </div>
      </header>

      <section class="summary-strip" aria-label="Portfolio value and account counts">
        ${overviewHtml}
      </section>

      <section class="workbench" id="accounts">
        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">
              <span class="label">Account list</span>
              <strong id="account-count" role="status" aria-live="polite">0 accounts</strong>
            </div>
          </div>
          <div class="panel-body">
            <div class="toolbar">
              <div class="segment" aria-label="Account type filter">
                <button type="button" data-filter="all" aria-pressed="true">All</button>
                <button type="button" data-filter="asset" aria-pressed="false">Assets</button>
                <button type="button" data-filter="liability" aria-pressed="false">Liabilities</button>
                <button type="button" data-filter="investment" aria-pressed="false">Investments</button>
              </div>
              <label class="search" aria-label="Search accounts">
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="11" cy="11" r="7"></circle>
                  <path d="M20 20l-3.5-3.5"></path>
                </svg>
                <input id="account-search" type="search" placeholder="Search account, bank, type" />
              </label>
            </div>
            <div class="account-list" id="account-list" role="list"></div>
          </div>
        </section>
      </section>
    </main>
  </div>

  <div class="modal-layer" id="tx-modal" hidden>
    <div class="modal-backdrop" data-close-modal></div>
    <section class="tx-window has-tools" role="dialog" aria-modal="true" aria-labelledby="tx-modal-title" aria-describedby="tx-modal-meta">
      <header class="tx-window-head">
        <div class="tx-window-title">
          <span class="label">Transactions</span>
          <strong id="tx-modal-title">-</strong>
        </div>
        <button class="tx-close" type="button" id="tx-modal-close" aria-label="Close transactions">&times;</button>
      </header>
      <div class="tx-window-meta" id="tx-modal-meta"></div>
      <div class="tx-table-tools" aria-label="Transaction table controls">
        <label class="tx-filter">
          <span>Filter</span>
          <input id="tx-table-filter" type="search" placeholder="Search date, status, description, source" />
        </label>
        <label class="tx-filter">
          <span>Status</span>
          <select id="tx-status-filter"><option value="all">All status</option></select>
        </label>
        <span class="tx-filter-count" id="tx-filter-count" role="status" aria-live="polite">0 rows</span>
      </div>
      <div class="table-wrap">
        <table class="table">
          <caption class="sr-only">Transactions for the selected account</caption>
          <thead>
            <tr>
              <th scope="col" data-sort-column="date" aria-sort="descending"><button class="sort-button" type="button" data-tx-sort="date">Date <span class="sort-mark" aria-hidden="true">↓</span></button></th>
              <th scope="col" data-sort-column="status"><button class="sort-button" type="button" data-tx-sort="status">Status <span class="sort-mark" aria-hidden="true"></span></button></th>
              <th scope="col" data-sort-column="description"><button class="sort-button" type="button" data-tx-sort="description">Description <span class="sort-mark" aria-hidden="true"></span></button></th>
              <th scope="col" data-sort-column="source"><button class="sort-button" type="button" data-tx-sort="source">Source <span class="sort-mark" aria-hidden="true"></span></button></th>
              <th scope="col" class="num" data-sort-column="amount"><button class="sort-button" type="button" data-tx-sort="amount">Amount <span class="sort-mark" aria-hidden="true"></span></button></th>
            </tr>
          </thead>
          <tbody id="tx-modal-rows"></tbody>
        </table>
      </div>
    </section>
  </div>

  <div class="modal-layer" id="asset-modal" hidden>
    <div class="modal-backdrop" data-close-asset-modal></div>
    <section class="tx-window" role="dialog" aria-modal="true" aria-labelledby="asset-modal-title" aria-describedby="asset-modal-meta">
      <header class="tx-window-head">
        <div class="tx-window-title">
          <span class="label">Assets</span>
          <strong id="asset-modal-title">-</strong>
        </div>
        <button class="tx-close" type="button" id="asset-modal-close" aria-label="Close assets">&times;</button>
      </header>
      <div class="tx-window-meta" id="asset-modal-meta"></div>
      <div class="table-wrap">
        <table class="table">
          <caption class="sr-only">Assets and current values for the selected account</caption>
          <thead><tr><th scope="col">Asset</th><th scope="col">Type</th><th scope="col">As of</th><th scope="col" class="num">Current value</th></tr></thead>
          <tbody id="asset-modal-rows"></tbody>
        </table>
      </div>
    </section>
  </div>

  <script>
    const payload = ${jsonForScript(payload)};
    const accounts = payload.accounts;
    const positionsById = Object.fromEntries(payload.positions.map(function(position) { return [position.id, position]; }));
    const transactionsById = Object.fromEntries(payload.transactions.map(function(transaction) { return [transaction.id, transaction]; }));
    const accountList = document.getElementById("account-list");
    const accountCount = document.getElementById("account-count");
    const accountSearch = document.getElementById("account-search");
    const valueVisibility = document.getElementById("value-visibility");
    const valueVisibilityLabel = document.getElementById("value-visibility-label");
    const filterButtons = Array.from(document.querySelectorAll("[data-filter]"));
    const txModal = document.getElementById("tx-modal");
    const txModalTitle = document.getElementById("tx-modal-title");
    const txModalMeta = document.getElementById("tx-modal-meta");
    const txModalRows = document.getElementById("tx-modal-rows");
    const txTableFilter = document.getElementById("tx-table-filter");
    const txStatusFilter = document.getElementById("tx-status-filter");
    const txFilterCount = document.getElementById("tx-filter-count");
    const txSortButtons = Array.from(document.querySelectorAll("[data-tx-sort]"));
    const txSortHeaders = Array.from(document.querySelectorAll("[data-sort-column]"));
    const txModalClose = document.getElementById("tx-modal-close");
    const assetModal = document.getElementById("asset-modal");
    const assetModalTitle = document.getElementById("asset-modal-title");
    const assetModalMeta = document.getElementById("asset-modal-meta");
    const assetModalRows = document.getElementById("asset-modal-rows");
    const assetModalClose = document.getElementById("asset-modal-close");
    const currencyOrder = ["TWD", "USD", "JPY", "UNKNOWN"];
    let selectedAccountId = payload.firstAccountId;
    let accountFilter = "all";
    let lastModalTrigger = null;
    let activeTxAccount = null;
    let txTableState = { filter: "", status: "all", sortKey: "date", sortDir: "desc" };
    const hiddenValueLabel = "••••";

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, function(char) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\\"": "&quot;", "'": "&#39;" }[char];
      });
    }
    function currencySort(left, right) {
      const leftIndex = currencyOrder.indexOf(left);
      const rightIndex = currencyOrder.indexOf(right);
      if (leftIndex !== -1 || rightIndex !== -1) return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
      return left.localeCompare(right);
    }
    function money(value, currency) {
      const digits = currency === "TWD" || currency === "JPY" ? 0 : 2;
      const safeValue = Object.is(value, -0) ? 0 : Number(value || 0);
      const formatted = new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(Math.abs(safeValue));
      return (safeValue < 0 ? "-" : "") + currency + " " + formatted;
    }
    function bucketEntries(bucket) {
      return Object.entries(bucket || {}).filter(function(entry) {
        return Number.isFinite(entry[1]);
      }).sort(function(left, right) {
        return currencySort(left[0], right[0]);
      });
    }
    function bucketLines(bucket) {
      const entries = bucketEntries(bucket);
      if (!entries.length) return ["-"];
      return entries.map(function(entry) { return money(entry[1], entry[0]); });
    }
    function sensitiveHtml(value) {
      return '<span data-sensitive>' + escapeHtml(value) + '</span>';
    }
    function applyValueVisibility() {
      const valuesVisible = !valueVisibility || valueVisibility.checked;
      document.documentElement.dataset.valuesVisible = String(valuesVisible);
      if (valueVisibilityLabel) valueVisibilityLabel.textContent = valuesVisible ? "Values visible" : "Values hidden";
      if (valueVisibility) valueVisibility.setAttribute("aria-label", valuesVisible ? "Hide values" : "Show values");
      for (const node of Array.from(document.querySelectorAll("[data-sensitive]"))) {
        if (!node.dataset.value) node.dataset.value = node.textContent || "";
        node.textContent = valuesVisible ? node.dataset.value : hiddenValueLabel;
      }
    }
    function bucketClass(bucket) {
      const first = bucketEntries(bucket).find(function(entry) { return entry[1] !== 0; });
      if (!first) return "neutral";
      return first[1] < 0 ? "negative" : "positive";
    }
    function accountClass(account) {
      if (account.group === "liability") return "liability";
      if (account.group === "investment") return "investment";
      return "asset";
    }
    function signedClass(value) {
      if (value < 0) return "negative";
      if (value > 0) return "positive";
      return "neutral";
    }
    function matchesFilter(account) {
      if (accountFilter === "all") return true;
      return account.group === accountFilter;
    }
    function matchesSearch(account) {
      const query = accountSearch.value.trim().toLowerCase();
      if (!query) return true;
      return [account.label, account.institution, account.kindLabel, account.group, account.source].some(function(field) {
        return String(field || "").toLowerCase().includes(query);
      });
    }
    function selectedAccount() {
      return accounts.find(function(account) { return account.id === selectedAccountId; }) || accounts[0];
    }
    function rowsForAccount(account) {
      return account.transactionIds.map(function(id) { return transactionsById[id]; }).filter(Boolean);
    }
    function assetsForAccount(account) {
      return account.positionIds.map(function(id) { return positionsById[id]; }).filter(Boolean);
    }
    function maskedAccountId(account) {
      const directMask = String(account.label || "").match(/\\*{2,}\\d{4}/);
      if (directMask) return directMask[0];
      for (const asset of assetsForAccount(account)) {
        const assetMask = String(asset.label || "").match(/\\*{2,}\\d{4}/);
        if (assetMask) return assetMask[0];
      }
      return "";
    }
    function accountLine(account) {
      const mask = maskedAccountId(account);
      const parts = [account.institution, account.kindLabel];
      if (mask && mask !== account.label) parts.push(mask);
      if (account.source) parts.push(account.source);
      return parts.join(" · ");
    }
    function valueForAsset(asset) {
      const signedValue = asset.valueSign === "liability" ? -Math.abs(asset.value) : asset.value;
      return money(signedValue, asset.currency);
    }
    function sourceText(item) {
      return String(item.sourceRelativePath || "") + ":" + String(item.sourceRowIndex ?? "");
    }
    function txCell(row, key) {
      if (key === "date") return row.date || "";
      if (key === "status") return row.status || "";
      if (key === "description") return row.description || "";
      if (key === "source") return sourceText(row);
      if (key === "amount") return Number(row.amountSigned);
      return "";
    }
    function txSortValue(row, key) {
      if (key === "date") {
        const timestamp = Date.parse(txCell(row, key));
        return Number.isFinite(timestamp) ? timestamp : 0;
      }
      if (key === "amount") {
        const amount = txCell(row, key);
        return Number.isFinite(amount) ? amount : 0;
      }
      return String(txCell(row, key)).toLowerCase();
    }
    function compareTxRows(left, right) {
      const leftValue = txSortValue(left, txTableState.sortKey);
      const rightValue = txSortValue(right, txTableState.sortKey);
      const direction = txTableState.sortDir === "asc" ? 1 : -1;
      if (leftValue > rightValue) return direction;
      if (leftValue < rightValue) return -direction;
      return 0;
    }
    function matchesTxFilter(row) {
      if (txTableState.status !== "all" && row.status !== txTableState.status) return false;
      const query = txTableState.filter.trim().toLowerCase();
      if (!query) return true;
      const amountLabel = Number.isFinite(row.amountSigned) ? money(row.amountSigned, row.currency) : "";
      return [row.date, row.status, row.description, sourceText(row), row.currency, amountLabel].some(function(value) {
        return String(value ?? "").toLowerCase().includes(query);
      });
    }
    function resetTxTableControls(rows) {
      txTableState = { filter: "", status: "all", sortKey: "date", sortDir: "desc" };
      txTableFilter.value = "";
      const statuses = Array.from(new Set(rows.map(function(row) { return String(row.status || "").trim(); }).filter(Boolean))).sort();
      txStatusFilter.innerHTML = '<option value="all">All status</option>' + statuses.map(function(status) {
        return '<option value="' + escapeHtml(status) + '">' + escapeHtml(status) + '</option>';
      }).join("");
      txStatusFilter.value = "all";
    }
    function updateTxSortHeaders() {
      for (const header of txSortHeaders) {
        const key = header.dataset.sortColumn;
        const active = key === txTableState.sortKey;
        if (active) header.setAttribute("aria-sort", txTableState.sortDir === "asc" ? "ascending" : "descending");
        else header.removeAttribute("aria-sort");
        const mark = header.querySelector(".sort-mark");
        if (mark) mark.textContent = active ? (txTableState.sortDir === "asc" ? "↑" : "↓") : "";
      }
    }
    function renderTxRows(account) {
      const rows = rowsForAccount(account);
      const visibleRows = rows.filter(matchesTxFilter).sort(compareTxRows);
      txFilterCount.textContent = String(visibleRows.length) + " / " + String(rows.length) + " rows";
      updateTxSortHeaders();
      if (!visibleRows.length) {
        txModalRows.innerHTML = '<tr class="tx-table-empty"><td colspan="5">No matching transactions</td></tr>';
        return;
      }
      txModalRows.innerHTML = visibleRows.map(function(row) {
        const amount = Number(row.amountSigned);
        const amountLabel = Number.isFinite(amount) ? money(amount, row.currency) : "-";
        return '<tr><td>' + escapeHtml(row.date || "-") + '</td><td>' + escapeHtml(row.status || "-") + '</td><td>' + escapeHtml(row.description || "-") + '</td><td>' + escapeHtml(sourceText(row)) + '</td><td class="num ' + (Number.isFinite(amount) ? signedClass(amount) : "neutral") + '">' + sensitiveHtml(amountLabel) + '</td></tr>';
      }).join("");
      applyValueVisibility();
    }
    function renderTxModal(account) {
      const rows = rowsForAccount(account);
      activeTxAccount = account;
      resetTxTableControls(rows);
      txModalTitle.textContent = account.institution + " / " + account.label;
      txModalMeta.innerHTML = '<span class="chip ' + accountClass(account) + '">' + escapeHtml(account.group) + '</span><span class="chip">' + String(rows.length) + ' tx</span><span class="chip">' + escapeHtml(account.kindLabel) + '</span><span class="chip">' + sensitiveHtml(bucketLines(account.amounts).join(" / ")) + '</span>';
      renderTxRows(account);
    }
    function setModalOpenState() {
      document.body.classList.toggle("modal-open", !txModal.hidden || !assetModal.hidden);
    }
    function focusableElements(container) {
      return Array.from(container.querySelectorAll("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")).filter(function(element) {
        return element.offsetParent !== null || element === document.activeElement;
      });
    }
    function trapModalFocus(event, modal) {
      const elements = focusableElements(modal);
      if (!elements.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    }
    function openTxModal(account, trigger) {
      lastModalTrigger = trigger || document.activeElement;
      renderTxModal(account);
      txModal.hidden = false;
      setModalOpenState();
      txModalClose.focus({ preventScroll: true });
    }
    function closeTxModal() {
      txModal.hidden = true;
      activeTxAccount = null;
      setModalOpenState();
      if (lastModalTrigger && typeof lastModalTrigger.focus === "function") lastModalTrigger.focus({ preventScroll: true });
    }
    function renderAssetModal(account) {
      const assets = assetsForAccount(account);
      assetModalTitle.textContent = account.institution + " / " + account.label;
      assetModalMeta.innerHTML = '<span class="chip ' + accountClass(account) + '">' + escapeHtml(account.group) + '</span><span class="chip">' + String(assets.length) + ' ' + (assets.length === 1 ? "asset" : "assets") + '</span><span class="chip">' + escapeHtml(account.kindLabel) + '</span>';
      assetModalRows.innerHTML = assets.map(function(asset) {
        const signClass = asset.valueSign === "liability" ? "negative" : asset.valueSign === "asset" ? "positive" : "neutral";
        return '<tr><td>' + escapeHtml(asset.label) + '</td><td>' + escapeHtml(asset.assetClass) + '</td><td>' + escapeHtml(asset.asOfDate || "-") + '</td><td class="num ' + signClass + '">' + sensitiveHtml(valueForAsset(asset)) + '</td></tr>';
      }).join("");
      if (!assets.length) assetModalRows.innerHTML = '<tr class="tx-table-empty"><td colspan="4">No assets</td></tr>';
      applyValueVisibility();
    }
    function openAssetModal(account, trigger) {
      lastModalTrigger = trigger || document.activeElement;
      renderAssetModal(account);
      assetModal.hidden = false;
      setModalOpenState();
      assetModalClose.focus({ preventScroll: true });
    }
    function closeAssetModal() {
      assetModal.hidden = true;
      setModalOpenState();
      if (lastModalTrigger && typeof lastModalTrigger.focus === "function") lastModalTrigger.focus({ preventScroll: true });
    }
    function renderAccounts() {
      const filtered = accounts.filter(matchesFilter).filter(matchesSearch);
      accountCount.textContent = String(filtered.length) + " accounts";
      if (!filtered.some(function(account) { return account.id === selectedAccountId; }) && filtered[0]) selectedAccountId = filtered[0].id;
      if (!filtered.length) {
        accountList.innerHTML = '<div class="empty" role="status"><strong>No matching accounts</strong><span>Adjust the filter or search.</span></div>';
        return;
      }
      accountList.innerHTML = filtered.map(function(account) {
        const txCount = rowsForAccount(account).length;
        const assetCount = assetsForAccount(account).length;
        const amountLines = bucketLines(account.amounts).map(function(line) { return sensitiveHtml(line); }).join("");
        const assetButton = assetCount ? '<button class="chip asset-chip" type="button" data-asset-account-id="' + escapeHtml(account.id) + '" aria-haspopup="dialog" aria-controls="asset-modal">' + String(assetCount) + ' ' + (assetCount === 1 ? "asset" : "assets") + '</button>' : "";
        return '<article class="account-row" role="listitem" data-account-id="' + escapeHtml(account.id) + '" data-selected="' + String(account.id === selectedAccountId) + '"><button class="account-main" type="button" data-select-account-id="' + escapeHtml(account.id) + '" aria-pressed="' + String(account.id === selectedAccountId) + '"><span class="account-name"><strong>' + escapeHtml(account.label) + '</strong><span class="account-line">' + escapeHtml(accountLine(account)) + '</span></span></button><span class="amount ' + bucketClass(account.amounts) + '">' + amountLines + '</span><span class="chip-row account-actions"><span class="chip ' + accountClass(account) + '">' + escapeHtml(account.group) + '</span>' + assetButton + '<button class="chip tx-chip" type="button" data-tx-account-id="' + escapeHtml(account.id) + '" aria-haspopup="dialog" aria-controls="tx-modal">' + String(txCount) + ' tx</button></span></article>';
      }).join("");
      applyValueVisibility();
      for (const row of Array.from(accountList.querySelectorAll("[data-account-id]"))) {
        row.addEventListener("click", function(event) {
          if (event.target.closest("button")) return;
          selectedAccountId = row.dataset.accountId;
          renderAccounts();
        });
      }
      for (const button of Array.from(accountList.querySelectorAll("[data-select-account-id]"))) {
        button.addEventListener("click", function(event) {
          event.stopPropagation();
          selectedAccountId = button.dataset.selectAccountId;
          renderAccounts();
        });
      }
      for (const button of Array.from(accountList.querySelectorAll("[data-tx-account-id]"))) {
        button.addEventListener("click", function(event) {
          event.stopPropagation();
          selectedAccountId = button.dataset.txAccountId;
          renderAccounts();
          openTxModal(selectedAccount(), button);
        });
      }
      for (const button of Array.from(accountList.querySelectorAll("[data-asset-account-id]"))) {
        button.addEventListener("click", function(event) {
          event.stopPropagation();
          selectedAccountId = button.dataset.assetAccountId;
          renderAccounts();
          openAssetModal(selectedAccount(), button);
        });
      }
    }
    if (valueVisibility) {
      valueVisibility.addEventListener("change", applyValueVisibility);
    }
    for (const button of filterButtons) {
      button.addEventListener("click", function() {
        accountFilter = button.dataset.filter;
        for (const item of filterButtons) item.setAttribute("aria-pressed", String(item === button));
        renderAccounts();
      });
    }
    accountSearch.addEventListener("input", renderAccounts);
    txTableFilter.addEventListener("input", function() {
      txTableState.filter = txTableFilter.value;
      if (activeTxAccount) renderTxRows(activeTxAccount);
    });
    txStatusFilter.addEventListener("change", function() {
      txTableState.status = txStatusFilter.value;
      if (activeTxAccount) renderTxRows(activeTxAccount);
    });
    for (const button of txSortButtons) {
      button.addEventListener("click", function() {
        const nextKey = button.dataset.txSort;
        if (txTableState.sortKey === nextKey) txTableState.sortDir = txTableState.sortDir === "asc" ? "desc" : "asc";
        else {
          txTableState.sortKey = nextKey;
          txTableState.sortDir = nextKey === "date" || nextKey === "amount" ? "desc" : "asc";
        }
        if (activeTxAccount) renderTxRows(activeTxAccount);
      });
    }
    txModalClose.addEventListener("click", closeTxModal);
    txModal.querySelector("[data-close-modal]").addEventListener("click", closeTxModal);
    assetModalClose.addEventListener("click", closeAssetModal);
    assetModal.querySelector("[data-close-asset-modal]").addEventListener("click", closeAssetModal);
    document.addEventListener("keydown", function(event) {
      if (event.key === "Escape" && !txModal.hidden) closeTxModal();
      else if (event.key === "Escape" && !assetModal.hidden) closeAssetModal();
      else if (event.key === "Tab" && !txModal.hidden) trapModalFocus(event, txModal);
      else if (event.key === "Tab" && !assetModal.hidden) trapModalFocus(event, assetModal);
    });
    renderAccounts();
  </script>
</body>
</html>`;
}

function sourceStatus(coverage: FinancialModel["parserCoverage"][string]): "ready" | "review" | "unsupported" {
  if (coverage.unsupportedRows > 0) return "unsupported";
  if (coverage.auditOnlyRows > 0) return "review";
  return "ready";
}

function sourceKeyForFinancialItem(item: { institution: string; product: string }): string {
  return `${item.institution.toLowerCase()}/${item.product}`;
}

function isAccountPosition(position: AssetPosition): boolean {
  return [
    "cash",
    "foreign_cash",
    "loan",
    "credit_card",
    "fund",
    "brokerage",
  ].includes(position.assetClass);
}

function buildSourceOutputCounts(model: FinancialModel): Record<
  string,
  {
    transactions: number;
    modelPositions: number;
    accountPositions: number;
  }
> {
  const counts: Record<
    string,
    {
      transactions: number;
      modelPositions: number;
      accountPositions: number;
    }
  > = {};

  for (const transaction of model.normalizedTransactions) {
    const key = sourceKeyForFinancialItem(transaction);
    counts[key] ??= { transactions: 0, modelPositions: 0, accountPositions: 0 };
    counts[key].transactions += 1;
  }

  for (const position of model.assetPositions) {
    const key = sourceKeyForFinancialItem(position);
    counts[key] ??= { transactions: 0, modelPositions: 0, accountPositions: 0 };
    counts[key].modelPositions += 1;
    if (isAccountPosition(position)) counts[key].accountPositions += 1;
  }

  return counts;
}

function renderLedgerLensSources(model: FinancialModel, dashboardHref: string): string {
  const snapshotDate = latestDashboardDate(model);
  const outputCounts = buildSourceOutputCounts(model);
  const sources = Object.entries(model.parserCoverage)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([source, coverage]) => {
      const output = outputCounts[source] ?? {
        transactions: 0,
        modelPositions: 0,
        accountPositions: 0,
      };
      return {
        source,
        ...coverage,
        outputTransactions: output.transactions,
        modelPositions: output.modelPositions,
        accountPositions: output.accountPositions,
        status: sourceStatus(coverage),
        parsedPercent: coverage.rows > 0 ? Math.round((coverage.parsedRows / coverage.rows) * 100) : 0,
      };
    });
  const summaryHtml = [
    renderPlainSummaryMetric({
      label: "Raw rows",
      value: new Intl.NumberFormat("en-US").format(model.counts.rawRows),
      primary: true,
      breakdown: [`${model.counts.uniqueRows} unique`, `${model.counts.duplicateRows} duplicate`],
    }),
    renderPlainSummaryMetric({
      label: "Parsed data",
      value: new Intl.NumberFormat("en-US").format(model.counts.normalizedTransactions),
      breakdown: [
        `${model.counts.assetPositions} model positions`,
        `${model.counts.includedPositions} included in totals`,
      ],
    }),
    renderPlainSummaryMetric({
      label: "Review queue",
      value: new Intl.NumberFormat("en-US").format(model.counts.auditOnlyRows),
      breakdown: [`${model.quality.issues.length} quality issues`],
    }),
    renderPlainSummaryMetric({
      label: "Unsupported",
      value: new Intl.NumberFormat("en-US").format(model.counts.unsupportedRows),
      breakdown: [`${sources.length} sources`],
    }),
  ].join("");
  const issueRows =
    model.quality.issues.length === 0
      ? `<tr><td colspan="4">No quality issues.</td></tr>`
      : model.quality.issues
          .map(
            (issue) => `
          <tr>
            <td><span class="chip ${escapeHtml(issue.level)}">${escapeHtml(issue.level)}</span></td>
            <td><strong>${escapeHtml(issue.code)}</strong><span class="table-meta">${escapeHtml(issue.message)}</span></td>
            <td>${escapeHtml(issue.sourceRelativePath ?? "-")}</td>
            <td class="num">${escapeHtml(issue.sourceRowIndex ?? "-")}</td>
          </tr>`,
          )
          .join("");
  const payload = { sources };

  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>LedgerLens Sources</title>
  <style>${renderLedgerLensStyles(true)}</style>
</head>
<body>
  <div class="app">
    <main class="main">
      <header class="topbar">
        <div>
          <div class="eyebrow">Snapshot ${escapeHtml(snapshotDate)}</div>
          <h1>Statement sources</h1>
        </div>
        <div class="actions">
          <a class="btn" href="${escapeHtml(dashboardHref)}">Account overview</a>
        </div>
      </header>

      <section class="summary-strip" aria-label="Source parsing summary">
        ${summaryHtml}
      </section>

      <section class="sources">
        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">
              <span class="label">Source files</span>
              <strong id="source-count" role="status" aria-live="polite">0 sources</strong>
            </div>
          </div>
          <div class="panel-body">
            <div class="panel-tools">
              <label class="field">
                <span>Search</span>
                <input id="source-search" type="search" placeholder="Search source path" />
              </label>
              <label class="field">
                <span>Status</span>
                <select id="source-status">
                  <option value="all">All status</option>
                  <option value="ready">Ready</option>
                  <option value="review">Review</option>
                  <option value="unsupported">Unsupported</option>
                </select>
              </label>
              <span class="result-count" id="source-result-count">0 rows</span>
            </div>
            <div class="source-list" id="source-list"></div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div class="panel-title">
              <span class="label">Quality issues</span>
              <strong>${escapeHtml(model.quality.issues.length)} issues</strong>
            </div>
          </div>
          <div class="panel-body">
            <div class="table-wrap">
              <table class="table">
                <thead><tr><th>Level</th><th>Issue</th><th>Source</th><th class="num">Row</th></tr></thead>
                <tbody>${issueRows}</tbody>
              </table>
            </div>
          </div>
        </section>
      </section>
    </main>
  </div>

  <script>
    const payload = ${jsonForScript(payload)};
    const sourceList = document.getElementById("source-list");
    const sourceCount = document.getElementById("source-count");
    const sourceSearch = document.getElementById("source-search");
    const sourceStatus = document.getElementById("source-status");
    const sourceResultCount = document.getElementById("source-result-count");
    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, function(char) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\\"": "&quot;", "'": "&#39;" }[char];
      });
    }
    function matchesSource(source) {
      const query = sourceSearch.value.trim().toLowerCase();
      const status = sourceStatus.value;
      if (status !== "all" && source.status !== status) return false;
      if (!query) return true;
      return source.source.toLowerCase().includes(query);
    }
    function renderSources() {
      const visible = payload.sources.filter(matchesSource);
      sourceCount.textContent = String(visible.length) + " sources";
      sourceResultCount.textContent = String(visible.length) + " / " + String(payload.sources.length) + " rows";
      if (!visible.length) {
        sourceList.innerHTML = '<div class="empty" role="status"><strong>No matching sources</strong><span>Adjust the filter or search.</span></div>';
        return;
      }
      sourceList.innerHTML = visible.map(function(source) {
        return '<article class="source-card"><div><strong>' + escapeHtml(source.source) + '</strong><span>' + String(source.rows) + ' rows · ' + String(source.parsedRows) + ' parsed rows · ' + String(source.auditOnlyRows) + ' review · ' + String(source.unsupportedRows) + ' unsupported</span><div class="source-meta"><span class="chip ' + source.status + '">' + escapeHtml(source.status) + '</span><span class="chip">' + String(source.outputTransactions) + ' source tx</span><span class="chip">' + String(source.accountPositions) + ' account positions</span></div><div class="progress" aria-label="' + String(source.parsedPercent) + '% parsed"><span style="width:' + String(source.parsedPercent) + '%"></span></div></div><span class="amount">' + String(source.parsedPercent) + '%</span></article>';
      }).join("");
    }
    sourceSearch.addEventListener("input", renderSources);
    sourceStatus.addEventListener("change", renderSources);
    renderSources();
  </script>
</body>
</html>`;
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const input = inputSchema.parse(parseParams(process.argv.slice(2)));
  const outputDir = resolve(input.outputDir);
  const model = await buildFinancialModel(input);
  const modelPath = join(outputDir, "financial_model.json");
  const qualityPath = join(outputDir, "financial_model_quality.json");
  const dashboardPath = join(outputDir, "financial_dashboard.html");
  const sourcesFileName = "financial_dashboard_sources.html";
  const sourcesPath = join(outputDir, sourcesFileName);

  await writeJson(modelPath, model);
  await writeJson(qualityPath, model.quality);
  await writeFile(dashboardPath, renderLedgerLensDashboard(model, sourcesFileName), "utf8");
  await writeFile(sourcesPath, renderLedgerLensSources(model, "financial_dashboard.html"), "utf8");

  console.log(
    JSON.stringify(
      {
        schemaVersion: model.schemaVersion,
        generatedAt: model.generatedAt,
        status: model.quality.status,
        counts: model.counts,
        totals: model.totals,
        modelPath,
        qualityPath,
        dashboardPath,
        sourcesPath,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
