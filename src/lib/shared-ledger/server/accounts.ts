import { createHash } from "node:crypto";
import type {
  accountTransactions,
  brokerageHoldings,
  brokerageTradeTransactions,
  creditCardCaptureEntries,
  creditCardCaptures,
  creditCardSnapshots,
  creditCardStatementLines,
  foreignCurrencyTransactions,
  fundBuyTransactions,
  fundCashDividends,
  fundConversionTransactions,
  fundHoldings,
  fundRedemptionTransactions,
  importRuns,
  loanTransactions,
  maicoinAccountSnapshots,
  maicoinStatementRows,
  sourceFiles,
} from "../../../ledger/db/schema.ts";
import type {
  AccountGroup,
  AccountKind,
  AccountRowDto,
  AssetPositionDto,
  CurrencyAmountDto,
  ReturnCategoryDto,
  TransactionRowDto,
} from "../types.ts";

type AccountTransaction = typeof accountTransactions.$inferSelect;
type ForeignCurrencyTransaction = typeof foreignCurrencyTransactions.$inferSelect;
type CreditCardStatementLine = typeof creditCardStatementLines.$inferSelect;
type CreditCardCapture = typeof creditCardCaptures.$inferSelect;
type CreditCardCaptureEntry = typeof creditCardCaptureEntries.$inferSelect;
type CreditCardSnapshot = typeof creditCardSnapshots.$inferSelect;
type LoanTransaction = typeof loanTransactions.$inferSelect;
type FundHolding = typeof fundHoldings.$inferSelect;
type FundBuyTransaction = typeof fundBuyTransactions.$inferSelect;
type FundRedemptionTransaction = typeof fundRedemptionTransactions.$inferSelect;
type FundCashDividend = typeof fundCashDividends.$inferSelect;
type FundConversionTransaction = typeof fundConversionTransactions.$inferSelect;
type BrokerageHolding = typeof brokerageHoldings.$inferSelect;
type BrokerageTradeTransaction = typeof brokerageTradeTransactions.$inferSelect;
type MaicoinAccountSnapshot = typeof maicoinAccountSnapshots.$inferSelect;
type MaicoinStatementRow = typeof maicoinStatementRows.$inferSelect;
type ImportRun = typeof importRuns.$inferSelect;
type SourceFile = typeof sourceFiles.$inferSelect;

type CommonRow = {
  bank: string;
  product: string;
  importedAt: string;
  sourceRowIndex: number;
};

export type LedgerQueryData = {
  importRuns: ImportRun[];
  sourceFiles: SourceFile[];
  accountTransactions: AccountTransaction[];
  foreignCurrencyTransactions: ForeignCurrencyTransaction[];
  creditCardStatementLines: CreditCardStatementLine[];
  creditCardCaptures: CreditCardCapture[];
  creditCardCaptureEntries: CreditCardCaptureEntry[];
  creditCardSnapshots: CreditCardSnapshot[];
  loanTransactions: LoanTransaction[];
  fundHoldings: FundHolding[];
  fundBuyTransactions: FundBuyTransaction[];
  fundRedemptionTransactions: FundRedemptionTransaction[];
  fundCashDividends: FundCashDividend[];
  fundConversionTransactions: FundConversionTransaction[];
  brokerageHoldings: BrokerageHolding[];
  brokerageTradeTransactions: BrokerageTradeTransaction[];
  maicoinAccountSnapshots: MaicoinAccountSnapshot[];
  maicoinStatementRows: MaicoinStatementRow[];
};

export function emptyLedgerQueryData(): LedgerQueryData {
  return {
    importRuns: [],
    sourceFiles: [],
    accountTransactions: [],
    foreignCurrencyTransactions: [],
    creditCardStatementLines: [],
    creditCardCaptures: [],
    creditCardCaptureEntries: [],
    creditCardSnapshots: [],
    loanTransactions: [],
    fundHoldings: [],
    fundBuyTransactions: [],
    fundRedemptionTransactions: [],
    fundCashDividends: [],
    fundConversionTransactions: [],
    brokerageHoldings: [],
    brokerageTradeTransactions: [],
    maicoinAccountSnapshots: [],
    maicoinStatementRows: [],
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
    ...creditCardPositions(
      latestVerifiedCreditCardSnapshots(data),
      latestVerifiedCreditCardRows(data),
    ),
    ...loanPositions(data.loanTransactions),
    ...fundPositions(data.fundHoldings),
    ...brokeragePositions(data.brokerageHoldings),
    ...maicoinPositions(data.maicoinAccountSnapshots, data.maicoinStatementRows),
  ];
}

export function buildTransactionsByAccount(
  data: LedgerQueryData,
): Record<string, TransactionRowDto[]> {
  const transactions: Array<[string, TransactionRowDto]> = [
    ...data.accountTransactions.map(bankTransactionDto),
    ...data.foreignCurrencyTransactions.map(foreignTransactionDto),
    ...latestVerifiedCreditCardRows(data).map(creditCardTransactionDto),
    ...data.loanTransactions.map(loanTransactionDto),
    ...data.fundBuyTransactions.map(fundBuyTransactionDto),
    ...data.fundRedemptionTransactions.map(fundRedemptionTransactionDto),
    ...data.fundCashDividends.map(fundCashDividendDto),
    ...data.fundConversionTransactions.map(fundConversionTransactionDto),
    ...data.brokerageTradeTransactions.map(brokerageTransactionDto),
    ...maicoinTransactionDtos(data.maicoinStatementRows, data.maicoinAccountSnapshots),
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

export function latestVerifiedCreditCardRows(data: LedgerQueryData) {
  const latestCaptureByCard = latestVerifiedCreditCardCaptureIds(data);
  const rowIds = new Set(data.creditCardCaptureEntries
    .filter((entry) => latestCaptureByCard.get(creditCardCaptureEntryKey(entry)) === entry.captureId)
    .map((entry) => entry.statementRowId));
  return data.creditCardStatementLines.filter((row) => rowIds.has(row.statementRowId));
}

export function latestVerifiedCreditCardSnapshots(data: LedgerQueryData) {
  const latestCaptureByCard = latestVerifiedCreditCardCaptureIds(data);
  return data.creditCardSnapshots.filter((snapshot) => (
    snapshot.captureId !== null
    && latestCaptureByCard.get(creditCardSnapshotAccountKey(snapshot)) === snapshot.captureId
  ));
}

function latestVerifiedCreditCardCaptureIds(data: LedgerQueryData) {
  const captures = new Map(data.creditCardCaptures.map((capture) => [capture.captureId, capture]));
  const latestCaptureByCard = new Map<string, string>();
  for (const entry of data.creditCardCaptureEntries) {
    const capture = captures.get(entry.captureId);
    if (!capture) continue;
    const card = creditCardCaptureEntryKey(entry);
    const previous = captures.get(latestCaptureByCard.get(card) ?? "");
    if (!previous || [capture.capturedAt, capture.captureId].join("|") > [previous.capturedAt, previous.captureId].join("|")) {
      latestCaptureByCard.set(card, capture.captureId);
    }
  }
  return latestCaptureByCard;
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
    rows.filter((row) => row.balanceAfter !== null),
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
    rows.filter((row) => row.balanceAfter !== null),
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

function creditCardPositions(snapshots: CreditCardSnapshot[], rows: CreditCardStatementLine[]): RawPosition[] {
  const latestRows = new Map(latestBy(
    rows,
    creditCardAccountKey,
    (row) => sortKey(row, row.consumeDate),
  ).map((row) => [creditCardAccountKey(row), row]));

  return snapshots.filter((snapshot) => snapshot.statementType === "unbilled").map((snapshot) => {
    const row = latestRows.get(creditCardSnapshotAccountKey(snapshot));
    return {
      id: stableId("card-position", snapshot.bank, snapshot.product, snapshot.cardKey, snapshot.statementType),
      accountId: accountId("card", snapshot.bank, snapshot.product, snapshot.cardKey, snapshot.currency),
      label: row?.cardLabel?.trim() || maskAccount(row?.cardNumber ?? snapshot.cardKey),
      institution: bankLabel(snapshot.bank),
      product: snapshot.product,
      group: "liability",
      kind: "credit-card",
      typeLabel: "Credit card",
      currency: snapshot.currency,
      value: snapshot.totalAmount,
      asOfDate: snapshot.asOfDate,
      importedAt: snapshot.capturedAt,
      positionDetail: null,
    };
  });
}

export function latestImportedUnbilledSnapshots(snapshots: CreditCardSnapshot[]) {
  return latestBy(
    snapshots.filter((snapshot) => snapshot.statementType === "unbilled"),
    creditCardSnapshotAccountKey,
    (snapshot) => [snapshot.capturedAt, snapshot.snapshotId].join("|"),
  );
}

function loanPositions(rows: LoanTransaction[]): RawPosition[] {
  return latestBy(
    rows.filter((row) => row.balanceAfter !== null),
    (row) => ["loan", row.bank, row.product, row.accountNumber ?? ""].join("|"),
    (row) => loanSortKey(row),
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
    rows.filter((row) => (row.marketValueWithoutDividend ?? row.investmentAmount) !== null),
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
    rows.filter((row) => (row.marketValueOriginal ?? row.marketValueTwd) !== null),
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

function maicoinPositions(
  rows: MaicoinAccountSnapshot[],
  statementRows: MaicoinStatementRow[],
): RawPosition[] {
  // ponytail: desktop captures all MAX wallet types together; load sync-run coverage if partial captures need display support.
  const walletKey = (row: MaicoinAccountSnapshot) => [row.subAccount, row.walletType].join("|");
  const latestCaptureBySubAccount = new Map(
    latestBy(rows, (row) => row.subAccount, (row) => row.capturedAt)
      .map((row) => [row.subAccount, row.capturedAt]),
  );
  const latestRows = latestBy(
    rows.filter((row) => (
      row.capturedAt === latestCaptureBySubAccount.get(row.subAccount)
      && (row.totalQuantity > 0 || maicoinDebtQuantity(row) > 0)
    )),
    (row) => ["maicoin", row.subAccount, row.walletType, currency(row.currency)].join("|"),
    (row) => row.capturedAt,
  );
  const activeAssetWallets = new Set(latestRows.filter((row) => row.totalQuantity > 0).map(walletKey));
  const inactiveAssetRows = latestBy(
    rows.filter((row) => row.totalQuantity > 0),
    walletKey,
    (row) => row.capturedAt,
  ).filter((row) => !activeAssetWallets.has(walletKey(row)));
  const returns = maicoinReturnComponents(latestRows, statementRows);
  const positions = latestRows.flatMap((row) => {
    const product = row.walletType === "m" ? "M-wallet" : "Spot wallet";
    const currencyCode = currency(row.currency);
    const returnComponents = returns.get(currencyCode) ?? [];
    const returnRate = aggregateReturn(returnComponents);
    const positions: RawPosition[] = [];
    if (row.totalQuantity > 0) {
      const valued = row.valueTwd !== null;
      const value = row.valueTwd ?? row.totalQuantity;
      const account = accountId("maicoin-asset", "maicoin", product, row.subAccount, "TWD");
      positions.push({
        id: stableId("maicoin-asset", row.subAccount, row.walletType, currencyCode),
        accountId: account,
        label: `MAX ${product}`,
        institution: "MaiCoin MAX",
        product,
        group: "investment",
        kind: "crypto",
        typeLabel: "Crypto",
        currency: valued ? "TWD" : currencyCode,
        value,
        asOfDate: row.capturedAt.slice(0, 10),
        importedAt: row.capturedAt,
        positionDetail: {
          symbol: currencyCode,
          name: `${currencyCode} ${product}`,
          units: formatUnits(row.totalQuantity),
          value,
          currency: valued ? "TWD" : currencyCode,
          change: returnRate ?? "--",
          metricLabel: "Return",
        },
      });
      for (const component of returnComponents) {
        positions.push({
          id: stableId("maicoin-return", row.subAccount, row.walletType, currencyCode, component.category),
          accountId: account,
          label: `MAX ${product}`,
          institution: "MaiCoin MAX",
          product,
          group: "investment",
          kind: "crypto",
          typeLabel: "Crypto",
          currency: "TWD",
          value: 0,
          asOfDate: row.capturedAt.slice(0, 10),
          importedAt: row.capturedAt,
          positionDetail: {
            symbol: currencyCode,
            name: `${currencyCode} ${returnCategoryLabel(component.category)}`,
            units: formatUnits(component.quantity),
            value: component.currentValueTwd,
            currency: "TWD",
            change: returnPercent(component.currentValueTwd, component.costTwd) ?? "--",
            metricLabel: "Return",
            returnCategory: component.category,
            returnCostTwd: component.costTwd,
          },
        });
      }
    }

    const debtQuantity = maicoinDebtQuantity(row);
    if (debtQuantity > 0) {
      const valued = row.price !== null;
      positions.push({
        id: stableId("maicoin-liability", row.subAccount, row.walletType, currencyCode),
        accountId: accountId("maicoin-liability", "maicoin", product, row.subAccount, "TWD"),
        label: `MAX ${product} debt`,
        institution: "MaiCoin MAX",
        product,
        group: "liability",
        kind: "crypto",
        typeLabel: "Crypto debt",
        currency: valued ? "TWD" : currencyCode,
        value: valued ? debtQuantity * (row.price ?? 0) : debtQuantity,
        asOfDate: row.capturedAt.slice(0, 10),
        importedAt: row.capturedAt,
        positionDetail: null,
      });
    }
    return positions;
  });
  const inactiveAssets: RawPosition[] = inactiveAssetRows.map((row) => {
    const product = row.walletType === "m" ? "M-wallet" : "Spot wallet";
    const capturedAt = latestCaptureBySubAccount.get(row.subAccount) ?? row.capturedAt;
    return {
      id: stableId("maicoin-asset-zero", row.subAccount, row.walletType),
      accountId: accountId("maicoin-asset", "maicoin", product, row.subAccount, "TWD"),
      label: `MAX ${product}`,
      institution: "MaiCoin MAX",
      product,
      group: "investment",
      kind: "crypto",
      typeLabel: "Crypto",
      currency: "TWD",
      value: 0,
      asOfDate: capturedAt.slice(0, 10),
      importedAt: capturedAt,
      positionDetail: null,
    };
  });
  return [...positions, ...inactiveAssets];
}

function maicoinDebtQuantity(row: MaicoinAccountSnapshot) {
  return (row.principal ?? 0) + (row.interest ?? 0);
}

type CostState = {
  buckets: Record<ReturnCategoryDto, CostBucket>;
};

type CostBucket = {
  quantity: number;
  costTwd: number;
  incomplete: boolean;
};

type ReturnComponent = {
  category: ReturnCategoryDto;
  quantity: number;
  costTwd: number;
  currentValueTwd: number;
};

const RETURN_CATEGORIES: ReturnCategoryDto[] = ["trade", "deposit", "reward"];
const SPOT_STATEMENT_ROW_TYPES = new Set(["convert", "deposit", "reward", "withdrawal"]);

function maicoinReturnComponents(
  snapshots: MaicoinAccountSnapshot[],
  rows: MaicoinStatementRow[],
) {
  const states = new Map<string, CostState>();
  for (const row of [...rows].sort((left, right) => (left.occurredAt ?? "").localeCompare(right.occurredAt ?? ""))) {
    const raw = parseJson(row.rawPayloadJson);
    if (row.rowType === "trade") applyMaicoinTrade(states, row, raw);
    if (row.rowType === "convert") applyMaicoinConvert(states, raw);
    if (row.rowType === "withdrawal") reduceMaicoinCost(states, currency(stringValue(raw.currency)), amount(raw.amount));
    if (row.rowType === "deposit") addMaicoinStatementCost(states, "deposit", currency(row.currency), amount(raw.amount), row.valueTwd);
    if (row.rowType === "reward") addMaicoinStatementCost(states, "reward", currency(row.currency), amount(raw.amount), row.valueTwd);
  }

  const returns = new Map<string, ReturnComponent[]>();
  for (const snapshot of snapshots) {
    const currencyCode = currency(snapshot.currency);
    const state = states.get(currencyCode);
    if (!state || snapshot.price === null) continue;
    const trackedQuantity = RETURN_CATEGORIES.reduce((sum, category) => sum + state.buckets[category].quantity, 0);
    const scale = trackedQuantity > snapshot.totalQuantity && trackedQuantity > 0
      ? snapshot.totalQuantity / trackedQuantity
      : 1;
    const components = RETURN_CATEGORIES.flatMap((category) => {
      const bucket = state.buckets[category];
      if (bucket.incomplete || bucket.quantity <= 0 || bucket.costTwd <= 0) return [];
      const quantity = bucket.quantity * scale;
      return [{
        category,
        quantity,
        costTwd: bucket.costTwd * scale,
        currentValueTwd: quantity * snapshot.price!,
      }];
    });
    if (components.length > 0) returns.set(currencyCode, components);
  }
  return returns;
}

function applyMaicoinTrade(
  states: Map<string, CostState>,
  row: MaicoinStatementRow,
  raw: Record<string, unknown>,
) {
  const market = stringValue(raw.market);
  const units = market ? marketUnits(market) : null;
  if (!units) return;

  const base = currency(units.base);
  const quote = currency(units.quote);
  const volume = amount(raw.volume);
  const funds = amount(raw.funds);

  if (raw.side === "bid") {
    const bucket = maicoinCostState(states, base).buckets.trade;
    if (!volume || !funds || row.valueTwd === null || row.valueTwd <= 0) {
      bucket.incomplete = true;
      return;
    }
    const costTwd = row.valueTwd * ((funds + feeIn(raw, quote)) / funds);
    addMaicoinCost(states, base, "trade", volume - feeIn(raw, base), costTwd);
  } else if (raw.side === "ask") {
    reduceMaicoinCost(states, base, volume);
  }
}

function applyMaicoinConvert(
  states: Map<string, CostState>,
  raw: Record<string, unknown>,
) {
  const from = currency(raw.from_currency as string | null);
  const to = currency(raw.to_currency as string | null);
  const fromAmount = amount(raw.from_amount);
  const toAmount = amount(raw.to_amount);
  if (!fromAmount || !toAmount) return;

  const removed = reduceMaicoinCost(states, from, fromAmount);
  const removedCost = removed.reduce((sum, item) => sum + item.costTwd, 0);
  const feeTwd = amount(raw.fee_in_twd);
  for (const item of removed) {
    const quantity = toAmount * (item.quantity / fromAmount);
    const cost = item.costTwd + (removedCost > 0 ? feeTwd * (item.costTwd / removedCost) : 0);
    addMaicoinCost(states, to, item.category, quantity, cost);
  }
}

function addMaicoinCost(
  states: Map<string, CostState>,
  currencyCode: string,
  category: ReturnCategoryDto,
  quantity: number,
  costTwd: number,
) {
  if (quantity <= 0 || costTwd <= 0) return;
  const bucket = maicoinCostState(states, currencyCode).buckets[category];
  bucket.quantity += quantity;
  bucket.costTwd += costTwd;
}

function addMaicoinStatementCost(
  states: Map<string, CostState>,
  category: ReturnCategoryDto,
  currencyCode: string,
  quantity: number,
  costTwd: number | null,
) {
  const bucket = maicoinCostState(states, currencyCode).buckets[category];
  if (quantity <= 0) return;
  if (costTwd === null || costTwd <= 0) {
    bucket.incomplete = true;
    return;
  }
  bucket.quantity += quantity;
  bucket.costTwd += costTwd;
}

function reduceMaicoinCost(
  states: Map<string, CostState>,
  currencyCode: string,
  quantity: number,
) {
  if (quantity <= 0) return [];
  const state = maicoinCostState(states, currencyCode);
  const totalQuantity = RETURN_CATEGORIES.reduce((sum, category) => sum + state.buckets[category].quantity, 0);
  if (totalQuantity <= 0) {
    for (const category of RETURN_CATEGORIES) state.buckets[category].incomplete = true;
    return [];
  }
  const removedTotal = Math.min(quantity, totalQuantity);
  const removed = RETURN_CATEGORIES.flatMap((category) => {
    const bucket = state.buckets[category];
    if (bucket.quantity <= 0) return [];
    const removedQuantity = bucket.quantity * (removedTotal / totalQuantity);
    const removedCost = bucket.costTwd * (removedQuantity / bucket.quantity);
    bucket.quantity -= removedQuantity;
    bucket.costTwd -= removedCost;
    return [{ category, quantity: removedQuantity, costTwd: removedCost }];
  });
  if (quantity > removedTotal + 0.000001) {
    for (const category of RETURN_CATEGORIES) state.buckets[category].incomplete = true;
  }
  return removed;
}

function maicoinCostState(states: Map<string, CostState>, currencyCode: string) {
  const key = currency(currencyCode);
  const state = states.get(key) ?? {
    buckets: {
      trade: { quantity: 0, costTwd: 0, incomplete: false },
      deposit: { quantity: 0, costTwd: 0, incomplete: false },
      reward: { quantity: 0, costTwd: 0, incomplete: false },
    },
  };
  states.set(key, state);
  return state;
}

function aggregateReturn(components: ReturnComponent[]) {
  return returnPercent(
    components.reduce((sum, component) => sum + component.currentValueTwd, 0),
    components.reduce((sum, component) => sum + component.costTwd, 0),
  );
}

function returnPercent(valueTwd: number, costTwd: number) {
  return costTwd > 0 ? `${(((valueTwd - costTwd) / costTwd) * 100).toFixed(2)}%` : null;
}

function returnCategoryLabel(category: ReturnCategoryDto) {
  if (category === "trade") return "Trade return";
  if (category === "deposit") return "Deposit return";
  return "Reward return";
}

function marketUnits(market: string) {
  for (const quote of ["usdt", "usdc", "twd", "btc", "eth"]) {
    if (market.endsWith(quote) && market.length > quote.length) {
      return { base: market.slice(0, -quote.length), quote };
    }
  }
  return null;
}

function feeIn(raw: Record<string, unknown>, currencyCode: string) {
  return currency(raw.fee_currency as string | null) === currencyCode ? amount(raw.fee) : 0;
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numeric(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function amount(value: unknown) {
  return numeric(value) ?? 0;
}

function bankTransactionDto(row: AccountTransaction): [string, TransactionRowDto] {
  const amount = (row.depositAmount ?? 0) - (row.withdrawalAmount ?? 0);
  return [
    accountId("cash", row.bank, row.product, row.accountNumber ?? "", currency(row.currency)),
    {
      date: row.transactionDate ?? row.accountingDate ?? row.importedAt.slice(0, 10),
      occurredAtUtc: row.transactionAtUtc,
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
      occurredAtUtc: row.transactionAtUtc,
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
    accountId("card", row.bank, row.product, creditCardNumberKey(row), "TWD"),
    {
      date: row.consumeDate ?? row.postingDate ?? row.importedAt.slice(0, 10),
      occurredAtUtc: null,
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
      occurredAtUtc: null,
      label: row.item?.trim() || "Loan transaction",
      type: "Loan",
      amount: -(row.amount ?? 0),
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
      occurredAtUtc: null,
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
      occurredAtUtc: null,
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
      occurredAtUtc: null,
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
      occurredAtUtc: null,
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
      occurredAtUtc: null,
      label: [row.productCode, row.productName].filter(Boolean).join(" ") || "Brokerage trade",
      type: row.action || row.tradeType || "Trade",
      amount: row.settlementAmount ?? row.grossAmount ?? 0,
      currency: currency(row.settlementCurrency ?? row.currency),
      note: row.subCategory,
    },
  ];
}

function maicoinTransactionDtos(
  rows: MaicoinStatementRow[],
  snapshots: MaicoinAccountSnapshot[],
): Array<[string, TransactionRowDto]> {
  const accountIds = maicoinAccountIds(snapshots);
  return rows.flatMap((row) => {
    const raw = parseJson(row.rawPayloadJson);
    const account = maicoinStatementAccount(row, accountIds);
    const date = row.occurredAt?.slice(0, 10) ?? row.capturedAt.slice(0, 10);

    if (row.rowType === "trade") {
      const units = row.market ? marketUnits(row.market) : null;
      const base = currency(units?.base);
      const volume = amount(raw.volume);
      const signedVolume = row.side === "ask" ? -volume : volume;
      return [[account, {
        date,
        occurredAtUtc: row.occurredAt,
        label: row.market ?? "MAX trade",
        type: row.side === "ask" ? "Sell" : row.side === "bid" ? "Buy" : "Trade",
        amount: signedVolume,
        currency: base,
        note: row.price === null ? null : `${row.price} ${currency(units?.quote)}`,
      }]];
    }

    if (row.rowType === "convert") {
      return [
        [account, {
          date,
          occurredAtUtc: row.occurredAt,
          label: "MAX convert",
          type: "Convert out",
          amount: -amount(raw.from_amount),
          currency: currency(raw.from_currency as string | null),
          note: null,
        }],
        [account, {
          date,
          occurredAtUtc: row.occurredAt,
          label: "MAX convert",
          type: "Convert in",
          amount: amount(raw.to_amount),
          currency: currency(raw.to_currency as string | null),
          note: null,
        }],
      ];
    }

    const value = amount(raw.amount);
    const signed = row.rowType === "withdrawal" ? -value : value;
    return [[account, {
      date,
      occurredAtUtc: row.occurredAt,
      label: `MAX ${row.rowType}`,
      type: row.rowType,
      amount: signed,
      currency: currency(row.currency),
      note: stringValue(raw.note) ?? stringValue(raw.state),
    }]];
  });
}

function maicoinAccountIds(snapshots: MaicoinAccountSnapshot[]) {
  const byWalletType = new Map<string, string>();
  const byCurrency = new Map<string, string | null>();
  for (const snapshot of snapshots) {
    const product = snapshot.walletType === "m" ? "M-wallet" : "Spot wallet";
    const id = accountId("maicoin-asset", "maicoin", product, snapshot.subAccount, "TWD");
    byWalletType.set(snapshot.walletType, id);
    const currencyCode = currency(snapshot.currency);
    const existing = byCurrency.get(currencyCode);
    if (existing === undefined) byCurrency.set(currencyCode, id);
    else if (existing !== id) byCurrency.set(currencyCode, null);
  }
  return { byWalletType, byCurrency };
}

function maicoinStatementAccount(
  row: MaicoinStatementRow,
  accountIds: ReturnType<typeof maicoinAccountIds>,
) {
  if (row.walletType) {
    return accountIds.byWalletType.get(row.walletType)
      ?? accountId("maicoin-asset", "maicoin", row.walletType, "main", "TWD");
  }
  if (SPOT_STATEMENT_ROW_TYPES.has(row.rowType)) {
    return accountIds.byWalletType.get("spot") ?? accountId("maicoin-asset", "maicoin", "spot", "main", "TWD");
  }

  const currencies = [currency(row.currency)];
  const ids = [...new Set(currencies.map((currencyCode) => accountIds.byCurrency.get(currencyCode)).filter(Boolean))];
  if (ids.length === 1) return ids[0]!;
  return accountIds.byWalletType.get("spot") ?? accountId("maicoin-asset", "maicoin", "spot", "main", "TWD");
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

function sortKey(row: CommonRow, date: string | null, time?: string | null) {
  return [date ?? "", time ?? "", row.importedAt, String(row.sourceRowIndex)].join("|");
}

function loanSortKey(row: LoanTransaction) {
  const principalPriority = /本金|principal/i.test(row.item ?? "") ? "1" : "0";
  return [row.tradeDate ?? "", row.importedAt, principalPriority, String(row.sourceRowIndex)].join("|");
}

function creditCardAccountKey(row: CreditCardStatementLine) {
  return [row.bank, row.product, creditCardNumberKey(row)].join("|");
}

function creditCardCaptureEntryKey(entry: CreditCardCaptureEntry) {
  return [entry.bank, entry.product, entry.cardKey].join("|");
}

function creditCardSnapshotAccountKey(snapshot: CreditCardSnapshot) {
  return [snapshot.bank, snapshot.product, snapshot.cardKey].join("|");
}

function creditCardNumberKey(row: CreditCardStatementLine) {
  const value = row.cardNumber?.trim() || row.cardLabel?.trim() || "";
  return cardLast4(value) || value;
}

function cardLast4(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : "";
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
