import { createHash } from "node:crypto";
import type {
  accountTransactions,
  brokerageHoldings,
  brokerageTradeTransactions,
  creditCardStatementLines,
  foreignCurrencyTransactions,
  fundBuyTransactions,
  fundCashDividends,
  fundConversionTransactions,
  fundHoldings,
  fundRedemptionTransactions,
  importRuns,
  loanTransactions,
  sourceFiles,
} from "../../../ledger/db/schema.ts";
import type {
  AccountGroup,
  AccountKind,
  AccountRowDto,
  AssetPositionDto,
  CurrencyAmountDto,
  TransactionRowDto,
} from "../types.ts";

type AccountTransaction = typeof accountTransactions.$inferSelect;
type ForeignCurrencyTransaction = typeof foreignCurrencyTransactions.$inferSelect;
type CreditCardStatementLine = typeof creditCardStatementLines.$inferSelect;
type LoanTransaction = typeof loanTransactions.$inferSelect;
type FundHolding = typeof fundHoldings.$inferSelect;
type FundBuyTransaction = typeof fundBuyTransactions.$inferSelect;
type FundRedemptionTransaction = typeof fundRedemptionTransactions.$inferSelect;
type FundCashDividend = typeof fundCashDividends.$inferSelect;
type FundConversionTransaction = typeof fundConversionTransactions.$inferSelect;
type BrokerageHolding = typeof brokerageHoldings.$inferSelect;
type BrokerageTradeTransaction = typeof brokerageTradeTransactions.$inferSelect;
type ImportRun = typeof importRuns.$inferSelect;
type SourceFile = typeof sourceFiles.$inferSelect;

type CommonRow = {
  bank: string;
  product: string;
  importedAt: string;
  sourceRowIndex: number;
  dedupeStatus: string;
};

export type LedgerQueryData = {
  importRuns: ImportRun[];
  sourceFiles: SourceFile[];
  accountTransactions: AccountTransaction[];
  foreignCurrencyTransactions: ForeignCurrencyTransaction[];
  creditCardStatementLines: CreditCardStatementLine[];
  loanTransactions: LoanTransaction[];
  fundHoldings: FundHolding[];
  fundBuyTransactions: FundBuyTransaction[];
  fundRedemptionTransactions: FundRedemptionTransaction[];
  fundCashDividends: FundCashDividend[];
  fundConversionTransactions: FundConversionTransaction[];
  brokerageHoldings: BrokerageHolding[];
  brokerageTradeTransactions: BrokerageTradeTransaction[];
};

export function emptyLedgerQueryData(): LedgerQueryData {
  return {
    importRuns: [],
    sourceFiles: [],
    accountTransactions: [],
    foreignCurrencyTransactions: [],
    creditCardStatementLines: [],
    loanTransactions: [],
    fundHoldings: [],
    fundBuyTransactions: [],
    fundRedemptionTransactions: [],
    fundCashDividends: [],
    fundConversionTransactions: [],
    brokerageHoldings: [],
    brokerageTradeTransactions: [],
  };
}

export type RawPosition = {
  id: string;
  accountId: string;
  label: string;
  institution: string;
  product: string;
  group: AccountGroup;
  kind: AccountKind;
  typeLabel: string;
  currency: string;
  value: number;
  asOfDate: string | null;
  importedAt: string;
  positionDetail: AssetPositionDto | null;
};

const GROUP_ORDER: Record<AccountGroup, number> = {
  asset: 0,
  investment: 1,
  liability: 2,
};

export function buildAccountOverview(data: LedgerQueryData): AccountRowDto[] {
  const positions = buildRawPositions(data);
  const transactionsByAccount = buildTransactionsByAccount(data);
  const byAccount = new Map<string, RawPosition[]>();
  for (const position of positions) {
    byAccount.set(position.accountId, [...(byAccount.get(position.accountId) ?? []), position]);
  }

  return [...byAccount.entries()]
    .map(([accountId, rows]) => {
      const first = rows[0];
      const details = rows.filter((row) => row.positionDetail);
      return {
        id: accountId,
        label: first.label,
        institution: first.institution,
        product: first.product,
        group: first.group,
        kind: first.kind,
        typeLabel: first.typeLabel,
        amountLines: bucketToAmounts(sumPositions(rows), { includeZero: true }),
        transactionCount: transactionsByAccount[accountId]?.length ?? 0,
        assetPositionCount: details.length,
        lastUpdated: rows.map((row) => row.asOfDate ?? row.importedAt.slice(0, 10)).sort().at(-1) ?? null,
      };
    })
    .sort((left, right) => {
      const group = GROUP_ORDER[left.group] - GROUP_ORDER[right.group];
      if (group !== 0) return group;
      return left.institution.localeCompare(right.institution) || left.label.localeCompare(right.label);
    });
}

export function buildRawPositions(data: LedgerQueryData): RawPosition[] {
  return [
    ...cashPositions(data.accountTransactions),
    ...foreignCashPositions(data.foreignCurrencyTransactions),
    ...creditCardPositions(data.creditCardStatementLines),
    ...loanPositions(data.loanTransactions),
    ...fundPositions(data.fundHoldings),
    ...brokeragePositions(data.brokerageHoldings),
  ];
}

export function buildTransactionsByAccount(
  data: LedgerQueryData,
): Record<string, TransactionRowDto[]> {
  const transactions: Array<[string, TransactionRowDto]> = [
    ...data.accountTransactions.filter(isUnique).map(bankTransactionDto),
    ...data.foreignCurrencyTransactions.filter(isUnique).map(foreignTransactionDto),
    ...data.creditCardStatementLines.filter(isUnique).map(creditCardTransactionDto),
    ...data.loanTransactions.filter(isUnique).map(loanTransactionDto),
    ...data.fundBuyTransactions.filter(isUnique).map(fundBuyTransactionDto),
    ...data.fundRedemptionTransactions.filter(isUnique).map(fundRedemptionTransactionDto),
    ...data.fundCashDividends.filter(isUnique).map(fundCashDividendDto),
    ...data.fundConversionTransactions.filter(isUnique).map(fundConversionTransactionDto),
    ...data.brokerageTradeTransactions.filter(isUnique).map(brokerageTransactionDto),
  ];

  const byAccount: Record<string, TransactionRowDto[]> = {};
  for (const [accountId, transaction] of transactions) {
    byAccount[accountId] = [...(byAccount[accountId] ?? []), transaction];
  }
  for (const rows of Object.values(byAccount)) {
    rows.sort((left, right) => right.date.localeCompare(left.date));
  }
  return byAccount;
}

export function buildPositionsByAccount(
  data: LedgerQueryData,
): Record<string, AssetPositionDto[]> {
  const byAccount: Record<string, AssetPositionDto[]> = {};
  for (const position of buildRawPositions(data)) {
    if (!position.positionDetail) continue;
    byAccount[position.accountId] = [
      ...(byAccount[position.accountId] ?? []),
      position.positionDetail,
    ];
  }
  return byAccount;
}

export function totalsForAccounts(accounts: AccountRowDto[]) {
  const assets: Record<string, number> = {};
  const liabilities: Record<string, number> = {};
  const investments: Record<string, number> = {};

  for (const account of accounts) {
    const bucket =
      account.group === "liability"
        ? liabilities
        : account.group === "investment"
          ? investments
          : assets;
    for (const amount of account.amountLines) addBucket(bucket, amount.currency, amount.value);
  }

  return {
    assets,
    liabilities,
    investments,
    net: subtractBuckets(addBuckets(assets, investments), liabilities),
  };
}

export function bucketToAmounts(
  bucket: Record<string, number>,
  options: { includeZero?: boolean } = {},
): CurrencyAmountDto[] {
  return Object.entries(bucket)
    .filter(([, value]) => options.includeZero || Math.abs(value) > 0.000001)
    .sort(([left], [right]) => currencyOrder(left) - currencyOrder(right) || left.localeCompare(right))
    .map(([currency, value]) => ({ currency, value }));
}

function cashPositions(rows: AccountTransaction[]): RawPosition[] {
  return latestBy(
    rows.filter((row) => isUnique(row) && row.balanceAfter !== null),
    (row) => ["cash", row.bank, row.product, row.accountNumber ?? "", currency(row.currency)].join("|"),
    (row) => sortKey(row, row.transactionDate, row.transactionTime),
  ).map((row) => ({
    id: stableId("cash-position", row.bank, row.product, row.accountNumber ?? "", row.currency),
    accountId: accountId("cash", row.bank, row.product, row.accountNumber ?? "", currency(row.currency)),
    label: `${bankLabel(row.bank)} ${maskAccount(row.accountNumber)}`,
    institution: bankLabel(row.bank),
    product: row.product,
    group: "asset",
    kind: "bank",
    typeLabel: "Bank",
    currency: currency(row.currency),
    value: row.balanceAfter ?? 0,
    asOfDate: row.transactionDate,
    importedAt: row.importedAt,
    positionDetail: null,
  }));
}

function foreignCashPositions(rows: ForeignCurrencyTransaction[]): RawPosition[] {
  return latestBy(
    rows.filter((row) => isUnique(row) && row.balanceAfter !== null),
    (row) => ["foreign", row.bank, row.product, row.accountNumber ?? "", currency(row.currency)].join("|"),
    (row) => sortKey(row, row.transactionDate, row.transactionTime),
  ).map((row) => ({
    id: stableId("foreign-position", row.bank, row.product, row.accountNumber ?? "", row.currency),
    accountId: accountId("foreign", row.bank, row.product, row.accountNumber ?? "", currency(row.currency)),
    label: `${bankLabel(row.bank)} ${maskAccount(row.accountNumber)}`,
    institution: bankLabel(row.bank),
    product: row.product,
    group: "asset",
    kind: "foreign",
    typeLabel: "Foreign",
    currency: currency(row.currency),
    value: row.balanceAfter ?? 0,
    asOfDate: row.transactionDate,
    importedAt: row.importedAt,
    positionDetail: null,
  }));
}

function creditCardPositions(rows: CreditCardStatementLine[]): RawPosition[] {
  const groups = new Map<string, { row: CreditCardStatementLine; value: number }>();
  for (const row of rows) {
    if (!isUnique(row) || row.statementType !== "unbilled") continue;
    const value = row.twdAmount ?? 0;
    if (value <= 0) continue;
    const key = ["card", row.bank, row.product, row.cardNumber ?? ""].join("|");
    const previous = groups.get(key);
    if (!previous) {
      groups.set(key, { row, value });
    } else {
      previous.value += value;
      if (sortKey(row, row.consumeDate) > sortKey(previous.row, previous.row.consumeDate)) {
        previous.row = row;
      }
    }
  }

  return [...groups.values()].map(({ row, value }) => ({
    id: stableId("card-position", row.bank, row.product, row.cardNumber ?? ""),
    accountId: accountId("card", row.bank, row.product, row.cardNumber ?? "", "TWD"),
    label: row.cardLabel?.trim() || maskAccount(row.cardNumber),
    institution: bankLabel(row.bank),
    product: row.product,
    group: "liability",
    kind: "credit-card",
    typeLabel: "Credit card",
    currency: "TWD",
    value,
    asOfDate: row.consumeDate,
    importedAt: row.importedAt,
    positionDetail: null,
  }));
}

function loanPositions(rows: LoanTransaction[]): RawPosition[] {
  return latestBy(
    rows.filter((row) => isUnique(row) && row.balanceAfter !== null),
    (row) => ["loan", row.bank, row.product, row.accountNumber ?? ""].join("|"),
    (row) => [row.tradeDate ?? "", row.importedAt, String(row.sourceRowIndex)].join("|"),
  ).map((row) => ({
    id: stableId("loan-position", row.bank, row.product, row.accountNumber ?? ""),
    accountId: accountId("loan", row.bank, row.product, row.accountNumber ?? "", "TWD"),
    label: `${bankLabel(row.bank)} loan ${maskAccount(row.accountNumber)}`,
    institution: bankLabel(row.bank),
    product: row.product,
    group: "liability",
    kind: "loan",
    typeLabel: "Loan",
    currency: "TWD",
    value: row.balanceAfter ?? 0,
    asOfDate: row.tradeDate,
    importedAt: row.importedAt,
    positionDetail: null,
  }));
}

function fundPositions(rows: FundHolding[]): RawPosition[] {
  return latestBy(
    rows.filter((row) => isUnique(row) && (row.marketValueWithoutDividend ?? row.investmentAmount) !== null),
    (row) => ["fund", row.bank, row.product, row.fundId ?? "", row.fundName ?? "", currency(row.currency)].join("|"),
    (row) => [row.importedAt, String(row.sourceRowIndex)].join("|"),
  ).map((row) => {
    const value = row.marketValueWithoutDividend ?? row.investmentAmount ?? 0;
    return {
      id: stableId("fund-position", row.bank, row.product, row.fundId ?? "", row.fundName ?? ""),
      accountId: accountId("fund", row.bank, row.product, "positions", "TWD"),
      label: `${bankLabel(row.bank)} fund positions`,
      institution: bankLabel(row.bank),
      product: row.product,
      group: "investment",
      kind: "fund",
      typeLabel: "Fund",
      currency: currency(row.currency),
      value,
      asOfDate: row.importedAt.slice(0, 10),
      importedAt: row.importedAt,
      positionDetail: {
        symbol: row.fundId?.trim() || "FUND",
        name: row.fundName?.trim() || "Fund position",
        units: "--",
        value,
        currency: currency(row.currency),
        change: row.returnRateWithoutDividend?.trim() || "--",
      },
    };
  });
}

function brokeragePositions(rows: BrokerageHolding[]): RawPosition[] {
  return latestBy(
    rows.filter((row) => isUnique(row) && (row.marketValueOriginal ?? row.marketValueTwd) !== null),
    (row) => ["brokerage", row.bank, row.product, row.accountNumber ?? "", row.productCode ?? "", currency(row.currency)].join("|"),
    (row) => [row.asOfDate ?? "", row.importedAt, String(row.sourceRowIndex)].join("|"),
  ).map((row) => {
    const value = row.marketValueOriginal ?? row.marketValueTwd ?? 0;
    return {
      id: stableId("brokerage-position", row.bank, row.product, row.accountNumber ?? "", row.productCode ?? ""),
      accountId: accountId("brokerage", row.bank, row.product, row.accountNumber ?? "", currency(row.currency)),
      label: `${bankLabel(row.bank)} brokerage ${maskAccount(row.accountNumber)}`,
      institution: bankLabel(row.bank),
      product: row.product,
      group: "investment",
      kind: "brokerage",
      typeLabel: "Brokerage",
      currency: currency(row.currency),
      value,
      asOfDate: row.asOfDate,
      importedAt: row.importedAt,
      positionDetail: {
        symbol: row.productCode?.trim() || "--",
        name: row.productName?.trim() || "Brokerage position",
        units: formatUnits(row.quantity),
        value,
        currency: currency(row.currency),
        change: row.returnRate ? `${row.returnRate}%` : "--",
      },
    };
  });
}

function bankTransactionDto(row: AccountTransaction): [string, TransactionRowDto] {
  const amount = (row.depositAmount ?? 0) - (row.withdrawalAmount ?? 0);
  return [
    accountId("cash", row.bank, row.product, row.accountNumber ?? "", currency(row.currency)),
    {
      date: row.transactionDate ?? row.accountingDate ?? row.importedAt.slice(0, 10),
      label: row.description?.trim() || "Bank transaction",
      type: amount >= 0 ? "Deposit" : "Withdrawal",
      amount,
      currency: currency(row.currency),
      note: row.note,
    },
  ];
}

function foreignTransactionDto(row: ForeignCurrencyTransaction): [string, TransactionRowDto] {
  const amount = (row.depositAmount ?? 0) - (row.withdrawalAmount ?? 0);
  return [
    accountId("foreign", row.bank, row.product, row.accountNumber ?? "", currency(row.currency)),
    {
      date: row.transactionDate ?? row.accountingDate ?? row.importedAt.slice(0, 10),
      label: row.description?.trim() || "Foreign-currency transaction",
      type: amount >= 0 ? "Credit" : "Debit",
      amount,
      currency: currency(row.currency),
      note: row.note,
    },
  ];
}

function creditCardTransactionDto(row: CreditCardStatementLine): [string, TransactionRowDto] {
  return [
    accountId("card", row.bank, row.product, row.cardNumber ?? "", "TWD"),
    {
      date: row.consumeDate ?? row.postingDate ?? row.importedAt.slice(0, 10),
      label: row.description?.trim() || "Credit-card line",
      type: row.statementType || "Card",
      amount: row.twdAmount ?? row.foreignAmount ?? 0,
      currency: row.twdAmount !== null ? "TWD" : currency(row.foreignCurrency),
      note: row.paymentStatus,
    },
  ];
}

function loanTransactionDto(row: LoanTransaction): [string, TransactionRowDto] {
  return [
    accountId("loan", row.bank, row.product, row.accountNumber ?? "", "TWD"),
    {
      date: row.tradeDate ?? row.postingDate ?? row.importedAt.slice(0, 10),
      label: row.item?.trim() || "Loan transaction",
      type: "Loan",
      amount: row.amount ?? 0,
      currency: "TWD",
      note: row.note || row.interestRate,
    },
  ];
}

function fundBuyTransactionDto(row: FundBuyTransaction): [string, TransactionRowDto] {
  return [
    accountId("fund", row.bank, row.product, "positions", "TWD"),
    {
      date: row.investmentDate ?? row.importedAt.slice(0, 10),
      label: row.fundName?.trim() || "Fund buy",
      type: "Buy",
      amount: -(row.investmentAmount ?? 0),
      currency: currency(row.currency),
      note: row.transactionNumber,
    },
  ];
}

function fundRedemptionTransactionDto(row: FundRedemptionTransaction): [string, TransactionRowDto] {
  return [
    accountId("fund", row.bank, row.product, "positions", "TWD"),
    {
      date: row.redemptionDate ?? row.importedAt.slice(0, 10),
      label: row.fundName?.trim() || "Fund redemption",
      type: "Redemption",
      amount: row.netDepositAmount ?? row.redemptionInvestmentAmount ?? 0,
      currency: "TWD",
      note: row.note || row.transactionNumber,
    },
  ];
}

function fundCashDividendDto(row: FundCashDividend): [string, TransactionRowDto] {
  return [
    accountId("fund", row.bank, row.product, "positions", "TWD"),
    {
      date: row.depositDate ?? row.importedAt.slice(0, 10),
      label: row.fundName?.trim() || "Fund dividend",
      type: "Dividend",
      amount: row.distributionAmount ?? 0,
      currency: currency(row.distributionCurrency ?? row.currency),
      note: row.transactionNumber,
    },
  ];
}

function fundConversionTransactionDto(row: FundConversionTransaction): [string, TransactionRowDto] {
  return [
    accountId("fund", row.bank, row.product, "positions", "TWD"),
    {
      date: row.conversionOutDate ?? row.conversionInDate ?? row.importedAt.slice(0, 10),
      label: [row.fromFundName, row.toFundName].filter(Boolean).join(" -> ") || "Fund conversion",
      type: "Conversion",
      amount: row.conversionInvestmentAmount ?? 0,
      currency: "TWD",
      note: row.transactionNumber,
    },
  ];
}

function brokerageTransactionDto(row: BrokerageTradeTransaction): [string, TransactionRowDto] {
  return [
    accountId("brokerage", row.bank, row.product, row.accountNumber ?? "", currency(row.currency)),
    {
      date: row.tradeDate ?? row.importedAt.slice(0, 10),
      label: [row.productCode, row.productName].filter(Boolean).join(" ") || "Brokerage trade",
      type: row.action || row.tradeType || "Trade",
      amount: row.settlementAmount ?? row.grossAmount ?? 0,
      currency: currency(row.settlementCurrency ?? row.currency),
      note: row.subCategory,
    },
  ];
}

function latestBy<T>(rows: T[], keyFor: (row: T) => string, sortFor: (row: T) => string): T[] {
  const latest = new Map<string, T>();
  for (const row of rows) {
    const key = keyFor(row);
    const previous = latest.get(key);
    if (!previous || sortFor(row) > sortFor(previous)) latest.set(key, row);
  }
  return [...latest.values()];
}

function sumPositions(rows: RawPosition[]) {
  const bucket: Record<string, number> = {};
  for (const row of rows) addBucket(bucket, row.currency, row.value);
  return bucket;
}

function addBuckets(
  left: Record<string, number>,
  right: Record<string, number>,
): Record<string, number> {
  const bucket = { ...left };
  for (const [currencyCode, value] of Object.entries(right)) {
    addBucket(bucket, currencyCode, value);
  }
  return bucket;
}

function subtractBuckets(
  left: Record<string, number>,
  right: Record<string, number>,
): Record<string, number> {
  const bucket = { ...left };
  for (const [currencyCode, value] of Object.entries(right)) {
    addBucket(bucket, currencyCode, -value);
  }
  return bucket;
}

function addBucket(bucket: Record<string, number>, currencyCode: string, value: number) {
  bucket[currencyCode] = (bucket[currencyCode] ?? 0) + value;
}

function isUnique(row: CommonRow) {
  return row.dedupeStatus !== "duplicate";
}

function sortKey(row: CommonRow, date: string | null, time?: string | null) {
  return [date ?? "", time ?? "", row.importedAt, String(row.sourceRowIndex)].join("|");
}

function accountId(kind: string, bank: string, product: string, account: string, currencyCode: string) {
  return stableId(kind, bank, product, account, currencyCode);
}

function stableId(...parts: string[]) {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24);
}

function bankLabel(bank: string) {
  return bank
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function maskAccount(account: string | null) {
  const raw = account?.trim();
  if (!raw) return "Unassigned";
  const digits = raw.replace(/\D/g, "");
  if (digits.length >= 4) return `****${digits.slice(-4)}`;
  return raw.length > 10 ? `...${raw.slice(-7)}` : raw;
}

function currency(value: string | null | undefined) {
  const normalized = (value ?? "TWD").trim().toUpperCase();
  if (!normalized || normalized === "台幣" || normalized === "NTD") return "TWD";
  return normalized;
}

function currencyOrder(value: string) {
  return value === "TWD" ? 0 : value === "USD" ? 1 : value === "JPY" ? 2 : 3;
}

function formatUnits(value: number | null) {
  if (value === null) return "--";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 4,
  }).format(value);
}
