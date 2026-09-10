import {
  exactAmountToNumber,
  type CanonicalOverviewAccount,
  type CanonicalOverviewAmount,
  type CanonicalOverviewPosition,
  type CanonicalOverviewProjection,
} from "../../../ledger/canonical/canonical-overview-query.ts";
import type {
  AccountRowDto,
  AssetPositionDto,
  CreditCardBalanceDto,
  CreditCardAccountDto,
  CreditCardStatementDto,
  CurrentProjectionStateDto,
  DailyHistoryRowDto,
  TransactionRowDto,
} from "../types.ts";

export type CanonicalProductDto = CurrentProjectionStateDto & {
  accounts: AccountRowDto[];
  marginAccounts: AccountRowDto[];
  positionsByAccount: Record<string, AssetPositionDto[]>;
  transactionsByAccount: Record<string, TransactionRowDto[]>;
  dailyHistoryByAccount: Record<string, DailyHistoryRowDto[]>;
  dailyHistory: DailyHistoryRowDto[];
};

export function mapCanonicalProduct(
  projection: CanonicalOverviewProjection,
  product: "assets" | "liabilities",
): CanonicalProductDto {
  const allAccounts = projection.accounts.map(mapAccount);
  const accounts = allAccounts
    .filter((account) => product === "assets" ? account.group !== "liability" : account.group === "liability")
  const marginAccounts = product === "liabilities"
    ? allAccounts
      .filter((account) => account.group === "investment" && (account.marginAmountLines?.length ?? 0) > 0)
      .map((account) => ({
        ...account,
        amountLines: account.marginAmountLines ?? [],
        marginAmountLines: undefined,
        // Margin observations are a separate liability fact. An unvalued
        // investment holding must not hide a margin amount that was observed
        // for the same provider account; retain the parent account's source
        // gap below so the page can report available/partial coverage.
        valueAvailability: "available" as const,
      }))
    : undefined;
  const visibleAccounts = [...accounts, ...(marginAccounts ?? [])];
  const accountIds = new Set(visibleAccounts.map((account) => account.id));
  const positionsByAccount: Record<string, AssetPositionDto[]> = {};
  if (product === "assets") {
    for (const position of projection.positions) {
      if (!accountIds.has(position.accountId)) continue;
      const rows = positionsByAccount[position.accountId] ?? [];
      rows.push(mapPosition(position));
      positionsByAccount[position.accountId] = rows;
    }
  }
  const transactionsByAccount: Record<string, TransactionRowDto[]> = {};
  for (const transaction of projection.transactions) {
    if (!accountIds.has(transaction.accountId)) continue;
    const rows = transactionsByAccount[transaction.accountId] ?? [];
    const amountExact = signedExact(transaction.amount, transaction.direction);
    rows.push({
      date: transaction.effectiveOn,
      occurredAtUtc: null,
      label: transaction.description ?? "",
      type: transaction.direction,
      amount: exactAmountToNumber(amountExact),
      amountExact,
      currency: transaction.currency,
      note: transaction.postingStatus,
    });
    transactionsByAccount[transaction.accountId] = rows;
  }
  const sourceGaps = projection.sourceGaps
    .filter((gap) => accountIds.has(gap.accountId) || expectedGapMatchesProduct(gap, product))
    .map((gap) => ({ ...gap }));
  const availability = productAvailability(visibleAccounts, sourceGaps, projection.availability);
  return {
    availability,
    coverage: coverageFor(availability, sourceGaps),
    sourceGaps,
    importedAt: projection.importedAt,
    accounts,
    marginAccounts: marginAccounts ?? [],
    positionsByAccount,
    transactionsByAccount,
    dailyHistoryByAccount: {},
    dailyHistory: [],
  };
}

function mapAccount(account: CanonicalOverviewAccount): AccountRowDto {
  return {
    id: account.id,
    canonicalAccountId: account.id,
    label: account.label,
    institution: account.institution,
    product: account.product,
    group: account.group,
    kind: account.kind,
    typeLabel: account.typeLabel,
    amountLines: account.amounts.map(mapAmount),
    ...(account.marginAmounts.length > 0
      ? { marginAmountLines: account.marginAmounts.map(mapAmount) }
      : {}),
    ...(account.creditCard
      ? { creditCard: mapCanonicalCreditCard(account.creditCard) }
      : {}),
    transactionCount: account.transactionCount,
    assetPositionCount: account.positions.length,
    lastUpdated: account.observedAt ? account.observedAt.slice(0, 10) : null,
    valueAvailability: account.availability,
  };
}

export function mapCanonicalCreditCard(
  creditCard: NonNullable<CanonicalOverviewAccount["creditCard"]>,
): CreditCardAccountDto {
  return {
    statements: creditCard.statements.map((statement): CreditCardStatementDto => ({
      statementId: statement.statementId,
      statementRevisionId: statement.statementRevisionId,
      statementKey: statement.statementKey,
      revisionNumber: statement.revisionNumber,
      cycleStart: statement.cycleStart,
      cycleEnd: statement.cycleEnd,
      issueDate: statement.issueDate,
      dueDate: statement.dueDate,
      currency: statement.currency,
      statementBalance: mapExact(statement.currency, statement.statementBalance),
      minimumPayment: statement.minimumPayment
        ? mapExact(statement.currency, statement.minimumPayment)
        : null,
      memberships: statement.memberships.map((membership) => ({ ...membership })),
    })),
    ...(creditCard.currentUsedCredit
      ? { currentUsedCredit: mapCreditCardBalance(creditCard.currentUsedCredit) }
      : {}),
  };
}

function mapCreditCardBalance(
  balance: NonNullable<NonNullable<CanonicalOverviewAccount["creditCard"]>["currentUsedCredit"]>,
): CreditCardBalanceDto {
  return {
    balanceKind: balance.balanceKind,
    estimateKind: balance.estimateKind,
    estimateBasis: balance.estimateBasis,
    estimateFormula: balance.estimateFormula,
    amount: {
      currency: balance.currency,
      value: exactAmountToNumber(balance.amount),
      exact: { ...balance.amount },
    },
    componentLimit: balance.componentLimit,
    componentAvailable: balance.componentAvailable,
  };
}

function mapPosition(position: CanonicalOverviewPosition): AssetPositionDto {
  return {
    symbol: position.symbol,
    name: position.name,
    units: position.units ? exactToDecimal(position.units) : "--",
    value: position.amount ? exactAmountToNumber(position.amount.exact) : null,
    valueExact: position.amount ? { ...position.amount.exact } : null,
    ...(position.amount ? { valueAvailability: "available" as const } : { valueAvailability: "awaiting" as const }),
    currency: position.currency,
    change: "--",
    metricLabel: position.typeLabel,
  };
}

function signedExact(
  exact: { coefficient: string; scale: number },
  direction: string,
): { coefficient: string; scale: number } {
  const coefficient = BigInt(exact.coefficient);
  return {
    coefficient: (direction.toLowerCase() === "outflow" ? -coefficient : coefficient).toString(),
    scale: exact.scale,
  };
}

function mapAmount(amount: CanonicalOverviewAmount) {
  return mapExact(amount.currency, amount.exact, amount.traces);
}

function mapExact(
  currency: string,
  exact: { coefficient: string; scale: number },
  traces?: CanonicalOverviewAmount["traces"],
) {
  return {
    currency,
    value: exactAmountToNumber(exact),
    exact: { coefficient: exact.coefficient, scale: exact.scale },
    ...(traces ? { traces: traces.map((trace) => ({ ...trace })) } : {}),
  };
}

function exactToDecimal(exact: { coefficient: string; scale: number }): string {
  const coefficient = BigInt(exact.coefficient);
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString();
  if (exact.scale === 0) return `${negative ? "-" : ""}${digits}`;
  const padded = digits.padStart(exact.scale + 1, "0");
  const splitAt = padded.length - exact.scale;
  return `${negative ? "-" : ""}${padded.slice(0, splitAt)}.${padded.slice(splitAt)}`;
}

function productAvailability(
  accounts: readonly AccountRowDto[],
  sourceGaps: readonly unknown[],
  projectionAvailability: CanonicalOverviewProjection["availability"],
): CurrentProjectionStateDto["availability"] {
  if (projectionAvailability === "unavailable") return "unavailable";
  if (accounts.length === 0)
    return sourceGaps.length > 0 ? "awaiting" : "empty";
  if (accounts.some((account) => account.valueAvailability === "available")) return "available";
  if (accounts.some((account) => account.valueAvailability === "unavailable")) return "unavailable";
  return "awaiting";
}

function coverageFor(
  availability: CurrentProjectionStateDto["availability"],
  sourceGaps: readonly unknown[],
): CurrentProjectionStateDto["coverage"] {
  if (availability === "unavailable") return "unavailable";
  if (availability === "awaiting" || availability === "empty")
    return "awaiting";
  return sourceGaps.length > 0 ? "partial" : "complete";
}

function expectedGapMatchesProduct(
  gap: { accountId: string; stream?: string },
  product: "assets" | "liabilities",
): boolean {
  if (!gap.accountId.startsWith("expected:")) return false;
  if (!gap.stream) return true;
  const liabilityStream = gap.stream === "credit-card" || gap.stream === "loan";
  return product === "liabilities" ? liabilityStream : !liabilityStream;
}
