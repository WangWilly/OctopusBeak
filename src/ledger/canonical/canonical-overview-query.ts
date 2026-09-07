import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { canonicalSqlitePath, openCanonicalDatabase } from "./canonical-database.ts";
import {
  createCanonicalProjectionRuntime,
  type CanonicalProjectionFinancialAccount,
  type CanonicalProjectionInvestmentHolding,
  type CanonicalProjectionSnapshot,
} from "./canonical-projection-runtime.ts";
import { withCanonicalSnapshot } from "./canonical-runtime.ts";

export type CanonicalOverviewAvailability =
  | "empty"
  | "awaiting"
  | "available"
  | "unavailable";

export type CanonicalOverviewExactAmount = Readonly<{
  coefficient: string;
  scale: number;
}>;

export type CanonicalOverviewAmountTrace = Readonly<{
  kind: "loan-balance-observation" | "investment-holding-observation" | "investment-margin-observation";
  accountId: string;
  observationId?: string;
  revisionId?: string;
  securityId?: string;
  effectiveAt: string;
  observedAt: string;
  knowledgePoint: number;
}>;

export type CanonicalOverviewAmount = Readonly<{
  currency: string;
  exact: CanonicalOverviewExactAmount;
  traces: readonly CanonicalOverviewAmountTrace[];
}>;

export type CanonicalOverviewPosition = Readonly<{
  id: string;
  accountId: string;
  label: string;
  symbol: string;
  name: string;
  kind: "brokerage" | "crypto";
  group: "asset";
  typeLabel: string;
  currency: string;
  amount: CanonicalOverviewAmount;
  units: CanonicalOverviewExactAmount | null;
}>;

export type CanonicalOverviewAccount = Readonly<{
  id: string;
  sourceConnectionKey: string;
  integrationNamespace: string;
  accountNo: string;
  stream: string;
  accountType: CanonicalProjectionFinancialAccount["accountType"];
  currency: string | null;
  label: string;
  institution: string;
  product: string;
  group: "asset" | "liability" | "investment";
  kind:
    | "bank"
    | "foreign"
    | "brokerage"
    | "crypto"
    | "credit-card"
    | "loan"
    | "other";
  typeLabel: string;
  amounts: readonly CanonicalOverviewAmount[];
  marginAmounts: readonly CanonicalOverviewAmount[];
  positions: readonly CanonicalOverviewPosition[];
  transactionCount: number;
  observedAt: string | null;
  availability: "available" | "awaiting" | "unavailable";
}>;

export type CanonicalOverviewSourceGap = Readonly<{
  accountId: string;
  sourceConnectionKey: string;
  accountNo: string;
  integrationNamespace?: string;
  stream?: string;
  label?: string;
  reason:
    | "current-value-not-observed"
    | "source-not-collected"
    | "canonical-read-unavailable";
}>;

/**
 * Non-financial configuration may advertise a source before its first
 * canonical capture. The Overview query consumes that expectation as input;
 * it never reads settings or source-specific tables itself.
 */
export type CanonicalOverviewExpectedSource = Readonly<{
  sourceId: string;
  integrationNamespace: string;
  label: string;
  stream?: string;
}>;

export type CanonicalOverviewProjection = Readonly<{
  availability: CanonicalOverviewAvailability;
  accounts: readonly CanonicalOverviewAccount[];
  positions: readonly CanonicalOverviewPosition[];
  sourceGaps: readonly CanonicalOverviewSourceGap[];
  importedAt: string | null;
  knowledgePoint: number;
}>;

export type CanonicalOverviewCurrentQueryResult = Readonly<{
  status: "ok";
  kind: "current";
  product: "overview";
  projection: CanonicalOverviewProjection;
}>;

export type CanonicalOverviewCurrentQuery = Readonly<{
  current(): Promise<CanonicalOverviewCurrentQueryResult>;
}>;

const ALL_TIME_SCOPE = {
  startDate: "1900-01-01",
  endDate: "2999-12-31",
} as const;

const EMPTY_PROJECTION: CanonicalOverviewProjection = Object.freeze({
  availability: "awaiting",
  accounts: [],
  positions: [],
  sourceGaps: [],
  importedAt: null,
  knowledgePoint: 0,
});

/**
 * Read the Overview product's one coherent Current Projection snapshot.
 *
 * The query intentionally has no legacy fallback. A ledger with no canonical
 * database is a source that has not reached the current projection yet, while
 * a database containing accounts without typed current values reports those
 * accounts as awaiting. Transaction amounts and statement totals are never
 * substituted for a provider current value here.
 */
export function createCanonicalOverviewQuery(
  ledgerDir: string,
  input: { expectedSources?: readonly CanonicalOverviewExpectedSource[] } = {},
): CanonicalOverviewCurrentQuery {
  const expectedSources = input.expectedSources ?? [];
  return Object.freeze({
    async current(): Promise<CanonicalOverviewCurrentQueryResult> {
      const databasePath = canonicalSqlitePath(ledgerDir);
      if (!existsSync(databasePath))
        return result(withExpectedSourceGaps(EMPTY_PROJECTION, expectedSources));

      let db: DatabaseSync | undefined;
      try {
        const opened = openCanonicalDatabase(ledgerDir, { readOnly: true });
        db = opened;
        const projection = withCanonicalSnapshot(opened, () => {
          const runtime = createCanonicalProjectionRuntime(opened);
          const snapshot = runtime.read({
            kind: "current",
            families: [
              "financial-accounts",
              "transactions",
              "overview-loan-balances",
              "investment-accounts",
              "investment-holdings",
              "investment-margin-balances",
            ],
            scope: ALL_TIME_SCOPE,
          });
          return mapProjection(snapshot, expectedSources);
        });
        return result(projection);
      } catch {
        return result(unavailableProjection(expectedSources));
      } finally {
        db?.close();
      }
    },
  });
}

function result(
  projection: CanonicalOverviewProjection,
): CanonicalOverviewCurrentQueryResult {
  return {
    status: "ok",
    kind: "current",
    product: "overview",
    projection,
  };
}

function unavailableProjection(
  expectedSources: readonly CanonicalOverviewExpectedSource[],
): CanonicalOverviewProjection {
  return {
    availability: "unavailable",
    accounts: [],
    positions: [],
    sourceGaps: expectedSources.map((source) =>
      expectedSourceGap(source, "canonical-read-unavailable"),
    ),
    importedAt: null,
    knowledgePoint: 0,
  };
}

function mapProjection(
  snapshot: CanonicalProjectionSnapshot,
  expectedSources: readonly CanonicalOverviewExpectedSource[],
): CanonicalOverviewProjection {
  const accountRows = snapshot.families["financial-accounts"];
  if (accountRows.length === 0) {
    const sourceGaps = expectedSources.map((source) =>
      expectedSourceGap(source, "source-not-collected"),
    );
    return {
      availability: sourceGaps.length > 0 ? "awaiting" : "empty",
      accounts: [],
      positions: [],
      sourceGaps,
      importedAt: null,
      knowledgePoint: snapshot.knowledgePoint,
    };
  }

  const transactionsByAccount = new Map<string, number>();
  for (const transaction of snapshot.families.transactions)
    transactionsByAccount.set(
      transaction.accountId,
      (transactionsByAccount.get(transaction.accountId) ?? 0) + 1,
    );

  const balancesByAccount = new Map<string, CanonicalProjectionSnapshot["families"]["overview-loan-balances"][number][]>();
  for (const balance of snapshot.families["overview-loan-balances"]) {
    const rows = balancesByAccount.get(balance.accountId) ?? [];
    rows.push(balance);
    balancesByAccount.set(balance.accountId, rows);
  }
  const holdingsByAccount = new Map<string, CanonicalProjectionInvestmentHolding[]>();
  for (const holding of snapshot.families["investment-holdings"])
    if (holding.isCurrent) {
      const rows = holdingsByAccount.get(holding.accountId) ?? [];
      rows.push(holding);
    holdingsByAccount.set(holding.accountId, rows);
  }
  const marginsByAccount = new Map<string, Array<CanonicalProjectionSnapshot["families"]["investment-margin-balances"][number]>>();
  for (const margin of snapshot.families["investment-margin-balances"]) {
    const rows = marginsByAccount.get(margin.accountId) ?? [];
    rows.push(margin);
    marginsByAccount.set(margin.accountId, rows);
  }

  const positions: CanonicalOverviewPosition[] = [];
  const sourceGaps: CanonicalOverviewSourceGap[] = [];
  const accounts = accountRows.map((account) => {
    const accountBalances = balancesByAccount.get(account.accountId) ?? [];
    const accountHoldings = holdingsByAccount.get(account.accountId) ?? [];
    const amounts = aggregateAccountAmounts(
      account,
      accountBalances,
      accountHoldings,
      snapshot.knowledgePoint,
    );
    const marginAmounts = aggregateMarginAmounts(
      account,
      marginsByAccount.get(account.accountId) ?? [],
      snapshot.knowledgePoint,
    );
    const rawAccountPositions = accountHoldings.flatMap((holding) => {
      const position = holdingPosition(account, holding, snapshot.knowledgePoint);
      return position ? [position] : [];
    });
    const hasUnvaluedHolding = accountHoldings.some(
      (holding) => holding.valuationCoefficient === null || holding.valuationScale === null || holding.valuationCurrency === null,
    );
    const accountPositions = hasUnvaluedHolding ? [] : rawAccountPositions;
    positions.push(...accountPositions);
    const available = amounts.length > 0 && !hasUnvaluedHolding;
    const availability = available ? "available" : "awaiting";
    if (!available)
      sourceGaps.push({
        accountId: account.accountId,
        sourceConnectionKey: account.sourceConnectionKey,
        accountNo: account.accountNo,
        integrationNamespace: account.integrationNamespace,
        stream: account.stream,
        label: `${account.integrationNamespace} ${account.accountNo}`,
        reason: "current-value-not-observed",
      });
    return {
      ...accountDisplay(account),
      amounts: hasUnvaluedHolding ? [] : amounts,
      marginAmounts: hasUnvaluedHolding ? [] : marginAmounts,
      positions: accountPositions,
      transactionCount: transactionsByAccount.get(account.accountId) ?? 0,
      observedAt: account.latestCaptureObservedAt,
      availability,
    } satisfies CanonicalOverviewAccount;
  });

  const importedAt = accountRows
    .map((row) => row.latestCaptureObservedAt)
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1) ?? null;
  sourceGaps.push(...missingExpectedSourceGaps(accounts, expectedSources));
  const availability = accounts.some((account) => account.availability === "available")
    ? "available"
    : "awaiting";
  return {
    availability,
    accounts,
    positions,
    sourceGaps,
    importedAt,
    knowledgePoint: snapshot.knowledgePoint,
  };
}

function withExpectedSourceGaps(
  projection: CanonicalOverviewProjection,
  expectedSources: readonly CanonicalOverviewExpectedSource[],
): CanonicalOverviewProjection {
  if (expectedSources.length === 0) return projection;
  const sourceGaps = [
    ...projection.sourceGaps,
    ...expectedSources.map((source) => expectedSourceGap(source, "source-not-collected")),
  ];
  return {
    ...projection,
    availability: projection.availability === "empty" ? "awaiting" : projection.availability,
    sourceGaps,
  };
}

function expectedSourceGap(
  source: CanonicalOverviewExpectedSource,
  reason: "source-not-collected" | "canonical-read-unavailable",
): CanonicalOverviewSourceGap {
  return {
    accountId: `expected:${source.sourceId}`,
    sourceConnectionKey: `expected:${source.sourceId}`,
    accountNo: "",
    integrationNamespace: source.integrationNamespace,
    stream: source.stream,
    label: source.label,
    reason,
  };
}

function missingExpectedSourceGaps(
  accounts: readonly CanonicalOverviewAccount[],
  expectedSources: readonly CanonicalOverviewExpectedSource[],
): CanonicalOverviewSourceGap[] {
  return expectedSources
    .filter((source) => !accounts.some((account) =>
      account.integrationNamespace === source.integrationNamespace
      && (!source.stream || account.stream === source.stream),
    ))
    .map((source) => expectedSourceGap(source, "source-not-collected"));
}

function accountDisplay(account: CanonicalProjectionFinancialAccount) {
  const identity = {
    id: account.accountId,
    sourceConnectionKey: account.sourceConnectionKey,
    integrationNamespace: account.integrationNamespace,
    accountNo: account.accountNo,
    stream: account.stream,
    accountType: account.accountType,
    currency: account.currency,
    label: `${account.integrationNamespace} ${account.accountNo}`,
    institution: account.integrationNamespace,
    product: account.stream,
  };
  const isForeign = account.accountType === "depository" &&
    account.currency !== null && account.currency !== "TWD";
  if (account.accountType === "depository")
    return {
      ...identity,
      group: "asset" as const,
      kind: isForeign ? "foreign" as const : "bank" as const,
      typeLabel: isForeign ? "Foreign" : "Bank",
    };
  if (account.accountType === "credit")
    return {
      ...identity,
      group: "liability" as const,
      kind: "credit-card" as const,
      typeLabel: "Credit card",
    };
  if (account.accountType === "loan")
    return {
      ...identity,
      group: "liability" as const,
      kind: "loan" as const,
      typeLabel: "Loan",
    };
  if (account.accountType === "investment") {
    const crypto = account.investmentSubtype === "crypto_exchange" || account.investmentSubtype === "non_custodial_wallet" || account.stream === "crypto" || account.stream.includes("crypto");
    return {
      ...identity,
      group: "investment" as const,
      kind: crypto ? "crypto" as const : "brokerage" as const,
      typeLabel: crypto ? "Crypto" : "Investment",
    };
  }
  return {
    ...identity,
    group: "asset" as const,
    kind: "other" as const,
    typeLabel: "Other",
  };
}

function aggregateAccountAmounts(
  account: CanonicalProjectionFinancialAccount,
  balances: readonly CanonicalProjectionSnapshot["families"]["overview-loan-balances"][number][],
  holdings: readonly CanonicalProjectionInvestmentHolding[],
  knowledgePoint: number,
): CanonicalOverviewAmount[] {
  const amounts = new Map<string, { exact: CanonicalOverviewExactAmount; traces: CanonicalOverviewAmountTrace[] }>();
  for (const balance of balances)
    addAmount(amounts, balance.currency, { coefficient: balance.coefficient, scale: balance.scale }, {
      kind: "loan-balance-observation",
      accountId: account.accountId,
      observationId: balance.observationId,
      revisionId: balance.revisionId,
      effectiveAt: balance.effectiveAt,
      observedAt: balance.observedAt,
      knowledgePoint,
    });
  for (const holding of holdings) {
    if (holding.valuationCoefficient === null || holding.valuationScale === null || holding.valuationCurrency === null)
      continue;
    addAmount(amounts, holding.valuationCurrency, { coefficient: holding.valuationCoefficient, scale: holding.valuationScale }, {
      kind: "investment-holding-observation",
      accountId: account.accountId,
      observationId: holding.measurementKey,
      securityId: holding.securityId,
      effectiveAt: holding.effectiveOn,
      observedAt: holding.observedAt,
      knowledgePoint,
    });
  }
  return [...amounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, value]) => ({ currency, exact: value.exact, traces: value.traces }));
}

function aggregateMarginAmounts(
  account: CanonicalProjectionFinancialAccount,
  margins: readonly CanonicalProjectionSnapshot["families"]["investment-margin-balances"][number][],
  knowledgePoint: number,
): CanonicalOverviewAmount[] {
  const amounts = new Map<string, { exact: CanonicalOverviewExactAmount; traces: CanonicalOverviewAmountTrace[] }>();
  for (const margin of margins)
    addAmount(amounts, margin.currency, { coefficient: margin.coefficient, scale: margin.scale }, {
      kind: "investment-margin-observation",
      accountId: account.accountId,
      observationId: margin.observationId,
      effectiveAt: margin.effectiveOn,
      observedAt: margin.observedAt,
      knowledgePoint,
    });
  return [...amounts.entries()].map(([currency, value]) => ({ currency, exact: value.exact, traces: value.traces }));
}

function holdingPosition(
  account: CanonicalProjectionFinancialAccount,
  holding: CanonicalProjectionInvestmentHolding,
  knowledgePoint: number,
): CanonicalOverviewPosition | null {
  if (holding.valuationCoefficient === null || holding.valuationScale === null || holding.valuationCurrency === null)
    return null;
  const crypto = holding.securityType === "cryptocurrency" || account.investmentSubtype === "crypto_exchange" || account.investmentSubtype === "non_custodial_wallet" || account.stream.includes("crypto");
  return {
    id: `${account.accountId}:${holding.securityId}`,
    accountId: account.accountId,
    label: holding.securityName ?? holding.securityTicker ?? holding.securityKey,
    symbol: holding.securityTicker ?? holding.securityKey,
    name: holding.securityName ?? holding.securityKey,
    kind: crypto ? "crypto" : "brokerage",
    group: "asset",
    typeLabel: crypto ? "Crypto" : "Investment",
    currency: holding.valuationCurrency,
    amount: {
      currency: holding.valuationCurrency,
      exact: { coefficient: holding.valuationCoefficient, scale: holding.valuationScale },
      traces: [{
        kind: "investment-holding-observation",
        accountId: account.accountId,
        observationId: holding.measurementKey,
        securityId: holding.securityId,
        effectiveAt: holding.effectiveOn,
        observedAt: holding.observedAt,
        knowledgePoint,
      }],
    },
    units: holding.quantityCoefficient !== null && holding.quantityScale !== null
      ? { coefficient: holding.quantityCoefficient, scale: holding.quantityScale }
      : null,
  };
}

function addAmount(
  amounts: Map<string, { exact: CanonicalOverviewExactAmount; traces: CanonicalOverviewAmountTrace[] }>,
  currency: string,
  exact: CanonicalOverviewExactAmount,
  trace: CanonicalOverviewAmountTrace,
): void {
  const current = amounts.get(currency);
  if (!current) {
    amounts.set(currency, { exact: normalize(exact), traces: [trace] });
    return;
  }
  current.exact = addExact(current.exact, exact);
  current.traces.push(trace);
}

function normalize(value: CanonicalOverviewExactAmount): CanonicalOverviewExactAmount {
  const coefficient = BigInt(value.coefficient);
  if (coefficient === 0n) return { coefficient: "0", scale: 0 };
  let scale = value.scale;
  let normalized = coefficient;
  while (scale > 0 && normalized % 10n === 0n) {
    normalized /= 10n;
    scale -= 1;
  }
  return { coefficient: normalized.toString(), scale };
}

function addExact(left: CanonicalOverviewExactAmount, right: CanonicalOverviewExactAmount): CanonicalOverviewExactAmount {
  const scale = Math.max(left.scale, right.scale);
  const leftCoefficient = BigInt(left.coefficient) * 10n ** BigInt(scale - left.scale);
  const rightCoefficient = BigInt(right.coefficient) * 10n ** BigInt(scale - right.scale);
  return normalize({ coefficient: (leftCoefficient + rightCoefficient).toString(), scale });
}

export function exactAmountToNumber(value: CanonicalOverviewExactAmount): number {
  const coefficient = BigInt(value.coefficient);
  const number = Number(coefficient) / 10 ** value.scale;
  // The exact coefficient/scale remains authoritative when a value cannot be
  // represented by JavaScript's presentation number. Returning zero here
  // would turn an overflow or underflow into a fabricated financial value.
  return coefficient !== 0n && number === 0
    ? Number.NaN
    : Number.isFinite(number)
      ? number
      : Number.NaN;
}
