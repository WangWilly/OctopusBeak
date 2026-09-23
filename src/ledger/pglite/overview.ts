import type { PGliteStore } from "./transaction.ts";
import { buildAccountDisplayMap } from "../../lib/shared-ledger/account-display.ts";
import type {
  CanonicalOverviewAccount,
  CanonicalOverviewAmount,
  CanonicalOverviewAmountTrace,
  CanonicalOverviewCreditCardBalance,
  CanonicalOverviewCurrentQueryResult,
  CanonicalOverviewExpectedSource,
  CanonicalOverviewPosition,
  CanonicalOverviewProjection,
  CanonicalOverviewSourceGap,
  CanonicalOverviewTransaction,
} from "../canonical/canonical-overview-query.ts";

export const PGLITE_CANONICAL_OVERVIEW_QUERY = "canonical.overview.query" as const;

export type PGliteCanonicalOverviewHistoricalRequest = Readonly<{
  knowledgeAt: number;
  /** Optional financial-time upper bound, retained for parity with projections. */
  financialAt?: string;
}>;

export type PGliteCanonicalOverviewHistoricalQueryResult = Readonly<{
  status: "ok";
  kind: "historical";
  product: "overview";
  knowledgeAt: number;
  projection: CanonicalOverviewProjection;
}>;

export type PGliteCanonicalOverviewQuery = Readonly<{
  current(): Promise<CanonicalOverviewCurrentQueryResult>;
  historical(request: PGliteCanonicalOverviewHistoricalRequest): Promise<PGliteCanonicalOverviewHistoricalQueryResult>;
}>;

export type PGliteCanonicalOverviewQueryCommand = Readonly<{
  kind: typeof PGLITE_CANONICAL_OVERVIEW_QUERY;
  query: "current" | "historical";
  request?: PGliteCanonicalOverviewHistoricalRequest;
}>;

type AccountRow = Readonly<{
  account_id: string;
  source_connection_key: string;
  integration_namespace: string;
  source_account_key: string;
  account_no: string | null;
  stream: string;
  account_type: "depository" | "credit" | "loan" | "investment" | "other";
  currency: string | null;
  investment_subtype: string | null;
  observed_at: string | null;
}>;

type BalanceRow = Readonly<{
  account_id: string;
  observation_id: string;
  revision_id: string;
  balance_kind: string;
  balance_coefficient: string;
  balance_scale: number | string;
  currency: string;
  effective_at: string;
  observed_at: string;
  source_field: string;
  estimate_kind: "estimate" | null;
  estimate_basis: "provider-used-credit" | "credit-limit-minus-available" | null;
  estimate_formula: string | null;
  component_limit_coefficient: string | null;
  component_limit_scale: number | string | null;
  component_available_coefficient: string | null;
  component_available_scale: number | string | null;
}>;

type TransactionRow = Readonly<{
  transaction_id: string;
  account_id: string;
  amount_coefficient: string;
  amount_scale: number | string;
  currency: string;
  direction: string;
  posting_status: string;
  effective_on: string;
  description: string | null;
}>;

type HoldingRow = Readonly<{
  account_id: string;
  security_id: string;
  security_key: string;
  security_name: string | null;
  security_ticker: string | null;
  security_type: string;
  security_currency: string;
  quantity_coefficient: string | null;
  quantity_scale: number | string | null;
  valuation_coefficient: string | null;
  valuation_scale: number | string | null;
  valuation_currency: string | null;
  effective_on: string;
  observed_at: string;
  measurement_key: string;
  source_commit_sequence: number | string;
}>;

type MarginRow = Readonly<{
  account_id: string;
  observation_id: string;
  balance_kind: string;
  coefficient: string;
  scale: number | string;
  currency: string;
  effective_on: string;
  observed_at: string;
}>;

type InvestmentTransactionRow = Readonly<{
  transaction_id: string;
  account_id: string;
  action: string;
  cash_coefficient: string;
  cash_scale: number | string;
  cash_currency: string;
  effective_on: string;
  funding_evidence_json: string;
  description: string | null;
}>;

function uuidText(value: unknown): string {
  const hex = typeof value === "string"
    ? value.replace(/^\\x/u, "").replaceAll("-", "")
    : value instanceof Uint8Array || Buffer.isBuffer(value)
      ? Buffer.from(value).toString("hex")
      : String(value).replace(/^\\x/u, "").replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/iu.test(hex)) throw new Error("PGlite overview returned an invalid UUID.");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toLowerCase();
}

function normalizeExact(value: { coefficient: string; scale: number }): { coefficient: string; scale: number } {
  let coefficient = BigInt(value.coefficient);
  let scale = value.scale;
  if (coefficient === 0n) return { coefficient: "0", scale: 0 };
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient: coefficient.toString(), scale };
}

function addExact(
  left: { coefficient: string; scale: number },
  right: { coefficient: string; scale: number },
): { coefficient: string; scale: number } {
  const scale = Math.max(left.scale, right.scale);
  const coefficient = BigInt(left.coefficient) * 10n ** BigInt(scale - left.scale) +
    BigInt(right.coefficient) * 10n ** BigInt(scale - right.scale);
  return normalizeExact({ coefficient: coefficient.toString(), scale });
}

function sourceGap(account: AccountRow, reason: "current-value-not-observed"): CanonicalOverviewSourceGap {
  return {
    accountId: account.account_id,
    sourceConnectionKey: account.source_connection_key,
    sourceAccountKey: account.source_account_key,
    accountNo: account.account_no,
    integrationNamespace: account.integration_namespace,
    stream: account.stream,
    reason,
  };
}

function expectedSourceGap(
  source: CanonicalOverviewExpectedSource,
  reason: "source-not-collected" | "canonical-read-unavailable",
): CanonicalOverviewSourceGap {
  return {
    accountId: `expected:${source.sourceId}`,
    sourceConnectionKey: `expected:${source.sourceId}`,
    accountNo: null,
    integrationNamespace: source.integrationNamespace,
    stream: source.stream,
    label: source.label,
    reason,
  };
}

function accountClassification(account: AccountRow): Pick<CanonicalOverviewAccount, "group" | "kind" | "typeLabel"> {
  const foreign = account.account_type === "depository" &&
    (account.stream === "foreign-currency-deposit" || (account.currency !== null && account.currency !== "TWD"));
  if (account.account_type === "depository")
    return { group: "asset", kind: foreign ? "foreign" : "bank", typeLabel: foreign ? "Foreign" : "Bank" };
  if (account.account_type === "credit")
    return { group: "liability", kind: "credit-card", typeLabel: "Credit card" };
  if (account.account_type === "loan")
    return { group: "liability", kind: "loan", typeLabel: "Loan" };
  if (account.account_type === "investment") {
    const crypto = account.investment_subtype === "crypto_exchange" ||
      account.investment_subtype === "non_custodial_wallet" ||
      account.stream.includes("crypto") ||
      account.integration_namespace === "maicoin";
    const fund = account.stream.includes("fund") || account.integration_namespace === "yuanta-fund";
    return { group: "investment", kind: crypto ? "crypto" : fund ? "fund" : "brokerage", typeLabel: crypto ? "Crypto" : fund ? "Fund" : "Investment" };
  }
  return { group: "asset", kind: "other", typeLabel: "Other" };
}

function selectedBalances(account: AccountRow, rows: readonly BalanceRow[]): readonly BalanceRow[] {
  if (account.account_type === "depository") {
    const byCurrency = new Map<string, BalanceRow[]>();
    for (const row of rows) {
      const bucket = byCurrency.get(row.currency) ?? [];
      bucket.push(row);
      byCurrency.set(row.currency, bucket);
    }
    const selected: BalanceRow[] = [];
    for (const bucket of byCurrency.values()) {
      const ledger = bucket.filter((row) => row.balance_kind === "ledger");
      if (ledger.length > 0) selected.push(...ledger);
      else if (account.integration_namespace === "linebank")
        selected.push(...bucket.filter((row) => row.balance_kind === "available"));
    }
    return selected;
  }
  if (account.account_type === "loan") return rows.filter((row) =>
    row.balance_kind === "outstanding_total" ||
    row.balance_kind === "loan_outstanding" ||
    row.balance_kind === "outstanding_principal"
  );
  if (account.account_type === "credit") return rows.filter((row) => row.balance_kind === "credit_used");
  return [];
}

function amountsFor(
  account: AccountRow,
  balances: readonly BalanceRow[],
  holdings: readonly HoldingRow[],
  knowledgePoint: number,
): readonly CanonicalOverviewAmount[] {
  const byCurrency = new Map<string, { exact: { coefficient: string; scale: number }; traces: CanonicalOverviewAmountTrace[] }>();
  for (const row of selectedBalances(account, balances)) {
    const exact = { coefficient: row.balance_coefficient, scale: Number(row.balance_scale) };
    const isCreditEstimate = account.account_type === "credit";
    const trace: CanonicalOverviewAmountTrace = isCreditEstimate
      ? {
        kind: "credit-card-used-credit-estimate",
        accountId: account.account_id,
        observationId: row.observation_id,
        revisionId: row.revision_id,
        ...(row.estimate_kind === null ? {} : { estimateKind: row.estimate_kind }),
        ...(row.estimate_basis === null ? {} : { estimateBasis: row.estimate_basis }),
        ...(row.estimate_formula === null ? {} : { estimateFormula: row.estimate_formula }),
        ...(row.component_limit_coefficient === null || row.component_limit_scale === null
          ? {}
          : { componentLimit: { coefficient: row.component_limit_coefficient, scale: Number(row.component_limit_scale) } }),
        ...(row.component_available_coefficient === null || row.component_available_scale === null
          ? {}
          : { componentAvailable: { coefficient: row.component_available_coefficient, scale: Number(row.component_available_scale) } }),
        effectiveAt: row.effective_at,
        observedAt: row.observed_at,
        knowledgePoint,
      }
      : {
      kind: account.account_type === "depository" ? "depository-balance-observation" : "loan-balance-observation",
      accountId: account.account_id,
      observationId: row.observation_id,
      revisionId: row.revision_id,
      ...(account.account_type === "depository" && (row.balance_kind === "ledger" || row.balance_kind === "available")
        ? { balanceKind: row.balance_kind }
        : {}),
      ...(account.account_type === "depository" && row.balance_kind === "available" && account.integration_namespace === "linebank"
        ? { sourceField: row.source_field }
        : {}),
      effectiveAt: row.effective_at,
      observedAt: row.observed_at,
      knowledgePoint,
    };
    const current = byCurrency.get(row.currency);
    if (!current) byCurrency.set(row.currency, { exact: normalizeExact(exact), traces: [trace] });
    else {
      current.exact = addExact(current.exact, exact);
      current.traces.push(trace);
    }
  }
  for (const holding of holdings) {
    if (holding.valuation_coefficient === null || holding.valuation_scale === null || holding.valuation_currency === null)
      continue;
    const exact = {
      coefficient: holding.valuation_coefficient,
      scale: Number(holding.valuation_scale),
    };
    const trace: CanonicalOverviewAmountTrace = {
      kind: "investment-holding-observation",
      accountId: account.account_id,
      observationId: holding.measurement_key,
      securityId: holding.security_id,
      effectiveAt: holding.effective_on,
      observedAt: holding.observed_at,
      knowledgePoint,
    };
    const current = byCurrency.get(holding.valuation_currency);
    if (!current) byCurrency.set(holding.valuation_currency, { exact: normalizeExact(exact), traces: [trace] });
    else {
      current.exact = addExact(current.exact, exact);
      current.traces.push(trace);
    }
  }
  return [...byCurrency.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, value]) => ({ currency, exact: value.exact, traces: value.traces }));
}

function mapTransactions(
  rows: readonly TransactionRow[],
  investmentRows: readonly InvestmentTransactionRow[],
): readonly CanonicalOverviewTransaction[] {
  const byId = new Map<string, CanonicalOverviewTransaction>();
  for (const row of rows) {
    byId.set(row.transaction_id, {
      id: row.transaction_id,
      accountId: row.account_id,
      amount: { coefficient: row.amount_coefficient, scale: Number(row.amount_scale) },
      currency: row.currency,
      direction: row.direction,
      postingStatus: row.posting_status,
      effectiveOn: row.effective_on,
      description: row.description,
    });
  }
  for (const row of investmentRows) {
    const existing = byId.get(row.transaction_id);
    let description: string | null = row.description;
    if (description === null) {
      try {
        const parsed = JSON.parse(row.funding_evidence_json) as { description?: unknown };
        if (typeof parsed.description === "string") description = parsed.description;
      } catch {
        description = null;
      }
    }
    if (existing) {
      if (existing.description === null && description !== null)
        byId.set(row.transaction_id, { ...existing, description });
      continue;
    }
    byId.set(row.transaction_id, {
      id: row.transaction_id,
      accountId: row.account_id,
      amount: { coefficient: row.cash_coefficient, scale: Number(row.cash_scale) },
      currency: row.cash_currency,
      direction: row.action === "buy" || row.action === "corporate_action_out" ? "outflow" : "inflow",
      postingStatus: "posted",
      effectiveOn: row.effective_on,
      description,
    });
  }
  return [...byId.values()].sort((left, right) =>
    left.effectiveOn.localeCompare(right.effectiveOn) || left.id.localeCompare(right.id),
  );
}

function marginAmountsFor(
  account: AccountRow,
  rows: readonly MarginRow[],
  knowledgePoint: number,
): readonly CanonicalOverviewAmount[] {
  const byCurrency = new Map<string, { exact: { coefficient: string; scale: number }; traces: CanonicalOverviewAmountTrace[] }>();
  for (const row of rows) {
    const exact = { coefficient: row.coefficient, scale: Number(row.scale) };
    const trace: CanonicalOverviewAmountTrace = {
      kind: "investment-margin-observation",
      accountId: account.account_id,
      observationId: row.observation_id,
      effectiveAt: row.effective_on,
      observedAt: row.observed_at,
      knowledgePoint,
    };
    const current = byCurrency.get(row.currency);
    if (!current) byCurrency.set(row.currency, { exact: normalizeExact(exact), traces: [trace] });
    else {
      current.exact = addExact(current.exact, exact);
      current.traces.push(trace);
    }
  }
  return [...byCurrency.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, value]) => ({ currency, exact: value.exact, traces: value.traces }));
}

function holdingPosition(
  account: AccountRow,
  holding: HoldingRow,
  knowledgePoint: number,
): CanonicalOverviewPosition {
  const crypto = holding.security_type === "cryptocurrency" ||
    account.investment_subtype === "crypto_exchange" ||
    account.investment_subtype === "non_custodial_wallet" ||
    account.stream.includes("crypto") ||
    account.integration_namespace === "maicoin";
  const fund = account.integration_namespace === "yuanta-fund" || account.stream.includes("fund");
  const amount = holding.valuation_coefficient === null || holding.valuation_scale === null || holding.valuation_currency === null
    ? null
    : {
      currency: holding.valuation_currency,
      exact: { coefficient: holding.valuation_coefficient, scale: Number(holding.valuation_scale) },
      traces: [{
        kind: "investment-holding-observation" as const,
        accountId: account.account_id,
        observationId: holding.measurement_key,
        securityId: holding.security_id,
        effectiveAt: holding.effective_on,
        observedAt: holding.observed_at,
        knowledgePoint,
      }],
    };
  return {
    id: `${account.account_id}:${holding.security_id}`,
    accountId: account.account_id,
    label: holding.security_name ?? holding.security_ticker ?? holding.security_key,
    symbol: holding.security_ticker ?? holding.security_key,
    name: holding.security_name ?? holding.security_key,
    kind: crypto ? "crypto" : fund ? "fund" : "brokerage",
    group: "asset",
    typeLabel: crypto ? "Crypto" : fund ? "Fund" : "Investment",
    currency: holding.valuation_currency ?? holding.security_currency,
    amount,
    units: holding.quantity_coefficient === null || holding.quantity_scale === null
      ? null
      : { coefficient: holding.quantity_coefficient, scale: Number(holding.quantity_scale) },
  };
}

function creditCardBalanceFor(
  rows: readonly BalanceRow[],
): CanonicalOverviewCreditCardBalance | null {
  const row = rows.find((candidate) =>
    candidate.balance_kind === "credit_used" &&
    candidate.estimate_kind !== null &&
    candidate.estimate_basis !== null &&
    candidate.estimate_formula !== null,
  );
  if (!row || row.estimate_kind === null || row.estimate_basis === null || row.estimate_formula === null)
    return null;
  return {
    balanceKind: "credit_used",
    estimateKind: row.estimate_kind,
    estimateBasis: row.estimate_basis,
    estimateFormula: row.estimate_formula,
    amount: { coefficient: row.balance_coefficient, scale: Number(row.balance_scale) },
    currency: row.currency,
    componentLimit: row.component_limit_coefficient === null || row.component_limit_scale === null
      ? null
      : { coefficient: row.component_limit_coefficient, scale: Number(row.component_limit_scale) },
    componentAvailable: row.component_available_coefficient === null || row.component_available_scale === null
      ? null
      : { coefficient: row.component_available_coefficient, scale: Number(row.component_available_scale) },
    effectiveAt: row.effective_at,
    observedAt: row.observed_at,
    projectionCommitId: null,
    revisionCommitId: null,
  };
}

function mapProjection(
  accounts: readonly AccountRow[],
  balances: readonly BalanceRow[],
  transactions: readonly TransactionRow[],
  holdings: readonly HoldingRow[],
  margins: readonly MarginRow[],
  investmentTransactions: readonly InvestmentTransactionRow[],
  knowledgePoint: number,
  expectedSources: readonly CanonicalOverviewExpectedSource[],
): CanonicalOverviewProjection {
  if (accounts.length === 0) {
    const sourceGaps = expectedSources.map((source) => expectedSourceGap(source, "source-not-collected"));
    return {
      availability: sourceGaps.length > 0 ? "awaiting" : "empty",
      accounts: [],
      positions: [],
      transactions: mapTransactions(transactions, investmentTransactions),
      sourceGaps,
      importedAt: null,
      knowledgePoint,
    };
  }
  const byAccount = new Map<string, BalanceRow[]>();
  for (const row of balances) {
    const bucket = byAccount.get(row.account_id) ?? [];
    bucket.push(row);
    byAccount.set(row.account_id, bucket);
  }
  const holdingsByAccount = new Map<string, HoldingRow[]>();
  for (const row of holdings) {
    const bucket = holdingsByAccount.get(row.account_id) ?? [];
    bucket.push(row);
    holdingsByAccount.set(row.account_id, bucket);
  }
  const marginsByAccount = new Map<string, MarginRow[]>();
  for (const row of margins) {
    const bucket = marginsByAccount.get(row.account_id) ?? [];
    bucket.push(row);
    marginsByAccount.set(row.account_id, bucket);
  }
  const transactionDtos = mapTransactions(transactions, investmentTransactions);
  const txCount = new Map<string, number>();
  for (const row of transactionDtos) txCount.set(row.accountId, (txCount.get(row.accountId) ?? 0) + 1);
  const displays = buildAccountDisplayMap(accounts.map((account) => ({
    accountId: account.account_id,
    integrationNamespace: account.integration_namespace,
    stream: account.stream,
    accountNo: account.account_no,
    accountType: account.account_type,
    currency: account.currency,
    investmentSubtype: account.investment_subtype,
  })));
  const sourceGaps: CanonicalOverviewSourceGap[] = [];
  const positions: CanonicalOverviewPosition[] = [];
  const resultAccounts = accounts.map((account) => {
    const rows = byAccount.get(account.account_id) ?? [];
    const accountHoldings = holdingsByAccount.get(account.account_id) ?? [];
    const accountMargins = marginsByAccount.get(account.account_id) ?? [];
    const amounts = amountsFor(account, rows, accountHoldings, knowledgePoint);
    const marginAmounts = marginAmountsFor(account, accountMargins, knowledgePoint);
    const accountPositions = accountHoldings.flatMap((holding) => {
      const position = holdingPosition(account, holding, knowledgePoint);
      return position ? [position] : [];
    });
    positions.push(...accountPositions);
    const hasUnvaluedHolding = accountHoldings.some((holding) =>
      holding.valuation_coefficient === null || holding.valuation_scale === null || holding.valuation_currency === null,
    );
    const display = displays.get(account.account_id) ?? {
      label: account.account_no ?? account.source_account_key,
      institution: account.integration_namespace,
      product: account.stream,
    };
    const classification = accountClassification(account);
    const availability = amounts.length > 0 && !hasUnvaluedHolding ? "available" : "awaiting";
    if (availability === "awaiting") sourceGaps.push(sourceGap(account, "current-value-not-observed"));
    const creditCardBalance = account.account_type === "credit" ? creditCardBalanceFor(rows) : null;
    const observedAt = [
      account.observed_at,
      ...accountHoldings.map((holding) => holding.observed_at),
      ...accountMargins.map((margin) => margin.observed_at),
      ...(creditCardBalance ? [creditCardBalance.observedAt] : []),
    ].filter((value): value is string => value !== null).sort().at(-1) ?? null;
    return {
      id: account.account_id,
      sourceConnectionKey: account.source_connection_key,
      integrationNamespace: account.integration_namespace,
      sourceAccountKey: account.source_account_key,
      accountNo: account.account_no,
      stream: account.stream,
      accountType: account.account_type,
      currency: account.currency,
      label: display.label,
      institution: display.institution,
      product: display.product,
      ...classification,
      amounts: hasUnvaluedHolding ? [] : amounts,
      marginAmounts,
      positions: accountPositions,
      ...(account.account_type === "credit"
        ? { creditCard: { statements: [], ...(creditCardBalance ? { currentUsedCredit: creditCardBalance } : {}) } }
        : {}),
      transactionCount: txCount.get(account.account_id) ?? 0,
      observedAt,
      availability,
    } satisfies CanonicalOverviewAccount;
  });
  const presentExpected = new Set(accounts.map((account) => `${account.integration_namespace}\u0000${account.stream}`));
  for (const source of expectedSources)
    if (![...presentExpected].some((key) => key.startsWith(`${source.integrationNamespace}\u0000`) && (!source.stream || key === `${source.integrationNamespace}\u0000${source.stream}`)))
      sourceGaps.push(expectedSourceGap(source, "source-not-collected"));
  const observedValues = [
    ...accounts.map((account) => account.observed_at),
    ...holdings.map((holding) => holding.observed_at),
    ...margins.map((margin) => margin.observed_at),
  ];
  return {
    availability: resultAccounts.some((account) => account.availability === "available") ? "available" : "awaiting",
    accounts: resultAccounts,
    positions,
    transactions: transactionDtos,
    sourceGaps,
    importedAt: observedValues.filter((value): value is string => value !== null).sort().at(-1) ?? null,
    knowledgePoint,
  };
}

type PGliteQueryReader = Pick<PGliteStore, "query">;

async function readProjection(
  store: PGliteQueryReader,
  cutoff: PGliteCanonicalOverviewHistoricalRequest | null,
  expectedSources: readonly CanonicalOverviewExpectedSource[],
): Promise<CanonicalOverviewProjection> {
  const requestedKnowledge = cutoff?.knowledgeAt;
  if (requestedKnowledge !== undefined && (!Number.isSafeInteger(requestedKnowledge) || requestedKnowledge < 0))
    throw new Error("Overview knowledgeAt must be a non-negative safe integer.");
  const knowledgeAt = requestedKnowledge ?? Number((await store.query<{ value: number | string }>("SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits")).rows[0]?.value ?? 0);
  const financialAt = cutoff?.financialAt;
  if (financialAt !== undefined && !/^\d{4}-\d{2}-\d{2}$/u.test(financialAt))
    throw new Error("Overview financialAt must be YYYY-MM-DD.");
  const accountsQuery = store.query<AccountRow>(
    `SELECT encode(account.account_id, 'hex') AS account_id,
            connection.source_connection_key,
            connection.integration_namespace,
            account.source_account_key,
            account.account_no,
            account.stream,
            account.account_type,
            account.currency,
            investment_account.account_subtype AS investment_subtype,
            MAX(CASE WHEN capture_commit.commit_id IS NOT NULL THEN source_capture.observed_at END) AS observed_at
       FROM financial_accounts account
       JOIN source_connections connection ON connection.source_connection_id = account.source_connection_id
       JOIN canonical_commits created_commit ON created_commit.commit_id = account.created_commit_id
       LEFT JOIN investment_accounts investment_account ON investment_account.account_id = account.account_id
       LEFT JOIN capture_scopes scope ON scope.account_id = account.account_id
       LEFT JOIN source_captures source_capture ON source_capture.capture_id = scope.capture_id
       LEFT JOIN canonical_commits capture_commit
         ON capture_commit.commit_id = source_capture.commit_id
        AND capture_commit.commit_sequence <= $1
      WHERE created_commit.commit_sequence <= $1
      GROUP BY account.account_id, connection.source_connection_key,
               connection.integration_namespace, account.source_account_key,
               account.account_no, account.stream, account.account_type,
               account.currency, investment_account.account_subtype
      ORDER BY connection.integration_namespace, account.source_account_key`,
    [knowledgeAt],
  );
  const balancesQuery = store.query<BalanceRow>(
    `WITH candidates AS (
       SELECT encode(account.account_id, 'hex') AS account_id,
              encode(observation.observation_id, 'hex') AS observation_id,
              encode(revision.revision_id, 'hex') AS revision_id,
              observation.balance_kind,
              revision.balance_coefficient,
              revision.balance_scale,
              revision.currency,
              revision.effective_at,
              revision.observed_at,
              revision.effective_time_evidence_source_field AS source_field,
              detail.estimate_kind,
              detail.estimate_basis,
              detail.formula AS estimate_formula,
              detail.component_limit_coefficient,
              detail.component_limit_scale,
              detail.component_available_coefficient,
              detail.component_available_scale,
              ROW_NUMBER() OVER (
                PARTITION BY account.account_id,
                  CASE WHEN account.account_type = 'loan' THEN revision.currency
                       ELSE observation.balance_kind || ':' || revision.currency END
                ORDER BY revision.effective_at DESC, revision.observed_at DESC,
                         commit_row.commit_sequence DESC, revision.revision_number DESC
              ) AS selection_rank
         FROM balance_observation_revisions revision
         JOIN balance_observations observation ON observation.observation_id = revision.observation_id
         JOIN financial_accounts account ON account.account_id = observation.account_id
         JOIN canonical_commits commit_row ON commit_row.commit_id = revision.commit_id
         LEFT JOIN credit_card_balance_estimate_details detail ON detail.revision_id = revision.revision_id
        WHERE commit_row.commit_sequence <= $1
          AND observation.balance_kind IN ('ledger','available','outstanding_total','loan_outstanding','outstanding_principal','credit_used')
          AND ($2::text IS NULL OR substring(revision.effective_at, 1, 10) <= $2)
     )
     SELECT account_id, observation_id, revision_id, balance_kind,
            balance_coefficient, balance_scale, currency, effective_at,
            observed_at, source_field, estimate_kind, estimate_basis,
            estimate_formula, component_limit_coefficient, component_limit_scale,
            component_available_coefficient, component_available_scale
       FROM candidates WHERE selection_rank = 1`,
    [knowledgeAt, financialAt ?? null],
  );
  const transactionsQuery = store.query<TransactionRow>(
    `WITH candidates AS (
       SELECT encode(transaction.transaction_id, 'hex') AS transaction_id,
              encode(transaction.account_id, 'hex') AS account_id,
              revision.revision_id,
              revision.amount_coefficient,
              revision.amount_scale,
              revision.currency,
              revision.direction,
              revision.posting_status,
              revision.effective_on,
              revision.description,
              ROW_NUMBER() OVER (
                PARTITION BY transaction.transaction_id
                ORDER BY revision.revision_number DESC, commit_row.commit_sequence DESC
              ) AS selection_rank
         FROM financial_transactions transaction
         JOIN transaction_revisions revision ON revision.transaction_id = transaction.transaction_id
         JOIN canonical_commits commit_row ON commit_row.commit_id = revision.commit_id
        WHERE commit_row.commit_sequence <= $1
          AND ($2::text IS NULL OR revision.effective_on <= $2)
     )
     SELECT transaction_id, account_id, amount_coefficient, amount_scale,
            currency, direction, posting_status, effective_on, description
       FROM candidates candidate
      WHERE selection_rank = 1
        AND COALESCE((
          SELECT transition.event_kind
            FROM assertion_transitions transition
            JOIN assertions assertion ON assertion.assertion_id = transition.assertion_id
            JOIN canonical_commits lifecycle_commit ON lifecycle_commit.commit_id = transition.commit_id
           WHERE assertion.revision_id = candidate.revision_id
             AND lifecycle_commit.commit_sequence <= $1
           ORDER BY lifecycle_commit.commit_sequence DESC, encode(transition.event_id, 'hex') DESC
           LIMIT 1
        ), 'observed') <> 'withdrawn'
      ORDER BY effective_on, transaction_id`,
    [knowledgeAt, financialAt ?? null],
  );
  const holdingsQuery = store.query<HoldingRow>(
    `WITH candidates AS (
       SELECT encode(holding.account_id, 'hex') AS account_id,
              encode(holding.security_id, 'hex') AS security_id,
              security.security_key,
              security.name AS security_name,
              security.ticker AS security_ticker,
              security.security_type,
              security.currency AS security_currency,
              holding.quantity_coefficient,
              holding.quantity_scale,
              holding.valuation_coefficient,
              holding.valuation_scale,
              holding.valuation_currency,
              holding.effective_on,
              holding.observed_at,
              holding.measurement_key,
              commit_row.commit_sequence AS source_commit_sequence,
              ROW_NUMBER() OVER (
                PARTITION BY holding.account_id, holding.security_id
                ORDER BY holding.effective_on DESC, holding.observed_at DESC,
                         holding.revision_number DESC, commit_row.commit_sequence DESC
              ) AS selection_rank
         FROM investment_holding_observations holding
         JOIN investment_securities security ON security.security_id = holding.security_id
         JOIN canonical_commits commit_row ON commit_row.commit_id = holding.commit_id
        WHERE commit_row.commit_sequence <= $1
          AND ($2::text IS NULL OR holding.effective_on <= $2)
          AND ($3::boolean = FALSE OR holding.is_current = 1)
     )
     SELECT account_id, security_id, security_key, security_name, security_ticker,
            security_type, security_currency, quantity_coefficient, quantity_scale,
            valuation_coefficient, valuation_scale, valuation_currency,
            effective_on, observed_at, measurement_key, source_commit_sequence
       FROM candidates WHERE selection_rank = 1`,
    [knowledgeAt, financialAt ?? null, cutoff === null],
  );
  const marginsQuery = store.query<MarginRow>(
    `WITH candidates AS (
       SELECT encode(margin.account_id, 'hex') AS account_id,
              encode(margin.observation_id, 'hex') AS observation_id,
              margin.balance_kind, margin.coefficient, margin.scale,
              margin.currency, margin.effective_on, source_capture.observed_at,
              ROW_NUMBER() OVER (
                PARTITION BY margin.account_id, margin.balance_kind, margin.currency
                ORDER BY margin.effective_on DESC, commit_row.commit_sequence DESC,
                         margin.observation_id DESC
              ) AS selection_rank
         FROM investment_margin_balance_observations margin
         JOIN canonical_commits commit_row ON commit_row.commit_id = margin.commit_id
         JOIN source_captures source_capture ON source_capture.capture_id = margin.capture_id
        WHERE commit_row.commit_sequence <= $1
          AND ($2::text IS NULL OR margin.effective_on <= $2)
     )
     SELECT account_id, observation_id, balance_kind, coefficient, scale,
            currency, effective_on, observed_at
       FROM candidates WHERE selection_rank = 1`,
    [knowledgeAt, financialAt ?? null],
  );
  const investmentTransactionsQuery = store.query<InvestmentTransactionRow>(
    `SELECT encode(investment_transaction.transaction_id, 'hex') AS transaction_id,
            encode(investment_transaction.account_id, 'hex') AS account_id,
            investment_transaction.action,
            investment_transaction.cash_coefficient,
            investment_transaction.cash_scale,
            investment_transaction.cash_currency,
            investment_transaction.effective_on,
            investment_transaction.funding_evidence_json,
            source_record.description
       FROM investment_transactions investment_transaction
       JOIN canonical_commits commit_row ON commit_row.commit_id = investment_transaction.commit_id
       JOIN source_records source_record ON source_record.source_record_id = investment_transaction.source_record_id
      WHERE commit_row.commit_sequence <= $1
        AND ($2::text IS NULL OR investment_transaction.effective_on <= $2)
      ORDER BY investment_transaction.effective_on, investment_transaction.transaction_id`,
    [knowledgeAt, financialAt ?? null],
  );
  const [accounts, balances, transactions, holdings, margins, investmentTransactions] = await Promise.all([
    accountsQuery,
    balancesQuery,
    transactionsQuery,
    holdingsQuery,
    marginsQuery,
    investmentTransactionsQuery,
  ]);
  return mapProjection(
    accounts.rows,
    balances.rows,
    transactions.rows,
    holdings.rows,
    margins.rows,
    investmentTransactions.rows,
    knowledgeAt,
    expectedSources,
  );
}

export function createPGliteCanonicalOverviewQuery(
  store: PGliteQueryReader,
  input: { expectedSources?: readonly CanonicalOverviewExpectedSource[] } = {},
): PGliteCanonicalOverviewQuery {
  const expectedSources = input.expectedSources ?? [];
  return Object.freeze({
    async current(): Promise<CanonicalOverviewCurrentQueryResult> {
      try {
        return { status: "ok", kind: "current", product: "overview", projection: await readProjection(store, null, expectedSources) };
      } catch {
        return {
          status: "ok",
          kind: "current",
          product: "overview",
          projection: {
            availability: "unavailable",
            accounts: [],
            positions: [],
            transactions: [],
            sourceGaps: expectedSources.map((source) => expectedSourceGap(source, "canonical-read-unavailable")),
            importedAt: null,
            knowledgePoint: 0,
          },
        };
      }
    },
    async historical(request: PGliteCanonicalOverviewHistoricalRequest): Promise<PGliteCanonicalOverviewHistoricalQueryResult> {
      return {
        status: "ok",
        kind: "historical",
        product: "overview",
        knowledgeAt: request.knowledgeAt,
        projection: await readProjection(store, request, expectedSources),
      };
    },
  });
}

export function executePGliteCanonicalOverviewQuery(
  store: PGliteQueryReader,
  command: PGliteCanonicalOverviewQueryCommand,
  input: { expectedSources?: readonly CanonicalOverviewExpectedSource[] } = {},
): Promise<CanonicalOverviewCurrentQueryResult | PGliteCanonicalOverviewHistoricalQueryResult> {
  const query = createPGliteCanonicalOverviewQuery(store, input);
  return command.query === "current"
    ? query.current()
    : query.historical(command.request ?? { knowledgeAt: 0 });
}

export function selectPGliteOverviewAssets(
  projection: CanonicalOverviewProjection,
): CanonicalOverviewProjection {
  return selectOverviewGroup(projection, (account) => account.group === "asset" || account.group === "investment");
}

export function selectPGliteOverviewLiabilities(
  projection: CanonicalOverviewProjection,
): CanonicalOverviewProjection {
  return selectOverviewGroup(projection, (account) => account.group === "liability");
}

function selectOverviewGroup(
  projection: CanonicalOverviewProjection,
  predicate: (account: CanonicalOverviewAccount) => boolean,
): CanonicalOverviewProjection {
  const accounts = projection.accounts.filter(predicate);
  const accountIds = new Set(accounts.map((account) => account.id));
  return {
    ...projection,
    accounts,
    positions: projection.positions.filter((position) => accountIds.has(position.accountId)),
    transactions: projection.transactions.filter((transaction) => accountIds.has(transaction.accountId)),
    sourceGaps: projection.sourceGaps.filter((gap) =>
      gap.accountId.startsWith("expected:") || accountIds.has(gap.accountId),
    ),
  };
}
