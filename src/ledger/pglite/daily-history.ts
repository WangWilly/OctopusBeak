import type { CanonicalOverviewAccount } from "../canonical/canonical-overview-query.ts";
import type { CurrencyAmountDto, DailyHistoryRowDto } from "../../lib/shared-ledger/types.ts";
import { exactAmountToNumber } from "./overview-amount.ts";

export type PGliteDailyHistoryReader = Readonly<{
  query<T>(query: string, params?: readonly unknown[]): Promise<{ rows: readonly T[] }>;
}>;

type DailyHistoryEventRow = Readonly<{
  event_date: string;
  event_type: "balance" | "holding";
  account_id: string;
  account_type: "depository" | "credit" | "loan" | "investment" | "other";
  integration_namespace: string;
  balance_kind: string | null;
  currency: string | null;
  coefficient: string | null;
  scale: number | string | null;
  security_id: string | null;
  observed_at: string | null;
}>;

type ExactAmount = Readonly<{ coefficient: string; scale: number }>;
type AmountBuckets = Map<string, ExactAmount>;

const CURRENCY_ORDER = ["TWD", "USD", "JPY"];

function normalizeExact(value: ExactAmount): ExactAmount {
  let coefficient = BigInt(value.coefficient);
  let scale = value.scale;
  if (coefficient === 0n) return { coefficient: "0", scale: 0 };
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient: coefficient.toString(), scale };
}

function addExact(left: ExactAmount, right: ExactAmount): ExactAmount {
  const scale = Math.max(left.scale, right.scale);
  return normalizeExact({
    coefficient: (
      BigInt(left.coefficient) * 10n ** BigInt(scale - left.scale)
      + BigInt(right.coefficient) * 10n ** BigInt(scale - right.scale)
    ).toString(),
    scale,
  });
}

function signedExact(value: ExactAmount, sign: 1 | -1): ExactAmount {
  return sign === 1 ? value : { coefficient: (-BigInt(value.coefficient)).toString(), scale: value.scale };
}

function adjustBucket(bucket: AmountBuckets, currency: string, value: ExactAmount | null, sign: 1 | -1): void {
  if (!value) return;
  const current = bucket.get(currency) ?? { coefficient: "0", scale: 0 };
  const next = addExact(current, signedExact(value, sign));
  if (BigInt(next.coefficient) === 0n) bucket.delete(currency);
  else bucket.set(currency, next);
}

function amountLines(bucket: AmountBuckets): CurrencyAmountDto[] {
  return [...bucket.entries()]
    .filter(([, exact]) => Math.abs(exactAmountToNumber(exact)) > 0.000001)
    .sort(([left], [right]) => {
      const leftIndex = CURRENCY_ORDER.indexOf(left);
      const rightIndex = CURRENCY_ORDER.indexOf(right);
      return (leftIndex < 0 ? 999 : leftIndex) - (rightIndex < 0 ? 999 : rightIndex)
        || left.localeCompare(right);
    })
    .map(([currency, exact]) => ({
      currency,
      value: exactAmountToNumber(exact),
      exact: { ...exact },
    }));
}

function balanceKey(accountId: string, kind: string, currency: string): string {
  return `${accountId}\u0000${kind}\u0000${currency}`;
}

function selectedDepositoryBalance(
  rows: ReadonlyMap<string, DailyHistoryEventRow>,
  accountId: string,
  namespace: string,
  currency: string,
): DailyHistoryEventRow | undefined {
  return rows.get(balanceKey(accountId, "ledger", currency))
    ?? (namespace === "linebank" ? rows.get(balanceKey(accountId, "available", currency)) : undefined);
}

function rowExact(row: DailyHistoryEventRow | undefined): ExactAmount | null {
  if (!row || row.coefficient === null || row.scale === null) return null;
  return { coefficient: row.coefficient, scale: Number(row.scale) };
}

function netAmounts(assets: AmountBuckets, liabilities: AmountBuckets): AmountBuckets {
  const result: AmountBuckets = new Map(assets);
  for (const [currency, exact] of liabilities) adjustBucket(result, currency, exact, -1);
  return result;
}

function difference(current: AmountBuckets, previous: AmountBuckets): AmountBuckets {
  const result: AmountBuckets = new Map();
  for (const currency of new Set([...current.keys(), ...previous.keys()])) {
    const left = current.get(currency) ?? { coefficient: "0", scale: 0 };
    const right = previous.get(currency) ?? { coefficient: "0", scale: 0 };
    const scale = Math.max(left.scale, right.scale);
    const value = normalizeExact({
      coefficient: (
        BigInt(left.coefficient) * 10n ** BigInt(scale - left.scale)
        - BigInt(right.coefficient) * 10n ** BigInt(scale - right.scale)
      ).toString(),
      scale,
    });
    if (BigInt(value.coefficient) !== 0n) result.set(currency, value);
  }
  return result;
}

/**
 * Build one history row for each effective date with a canonical balance or
 * valued holding observation. Facts are read at one immutable commit version;
 * existing balances remain in the point-in-time total on later observation
 * dates, while dates without a new observation are omitted.
 */
export async function readPGliteDailyHistory(
  reader: PGliteDailyHistoryReader,
  knowledgePoint: number,
  accounts: readonly CanonicalOverviewAccount[],
): Promise<DailyHistoryRowDto[]> {
  return (await readPGliteDailyHistoryWithAccounts(reader, knowledgePoint, accounts)).dailyHistory;
}

export type PGliteDailyHistory = Readonly<{
  dailyHistory: DailyHistoryRowDto[];
  dailyHistoryByAccount: Record<string, DailyHistoryRowDto[]>;
}>;

type AccountHistoryState = { assets: AmountBuckets; liabilities: AmountBuckets; holdings: Set<string> };

/** One collection run of an investment account: every holding it reported shares one observed_at. */
type HoldingCollection = Readonly<{ accountId: string; observedAt: string; securities: ReadonlySet<string> }>;

/**
 * Investment captures are complete holding snapshots, so a security that a
 * newer collection of the same account no longer reports was sold. That
 * collection takes effect on its earliest effective date. Funds report each
 * holding on its own NAV date, which is why a collection is keyed by
 * observed_at rather than by effective date.
 */
function holdingCollectionsByStart(rows: readonly DailyHistoryEventRow[]): Map<string, HoldingCollection[]> {
  const collections = new Map<string, { accountId: string; observedAt: string; start: string; securities: Set<string> }>();
  for (const row of rows) {
    if (row.event_type !== "holding" || row.security_id === null || row.observed_at === null) continue;
    const key = `${row.account_id}\u0000${row.observed_at}`;
    const collection = collections.get(key);
    if (!collection) {
      collections.set(key, { accountId: row.account_id, observedAt: row.observed_at, start: row.event_date, securities: new Set([row.security_id]) });
    } else {
      collection.securities.add(row.security_id);
      if (row.event_date < collection.start) collection.start = row.event_date;
    }
  }
  const byStart = new Map<string, HoldingCollection[]>();
  for (const { start, ...collection } of collections.values()) {
    const starting = byStart.get(start) ?? [];
    starting.push(collection);
    byStart.set(start, starting);
  }
  return byStart;
}

/**
 * The per-account rows hold only that account's own balances and holdings on
 * the dates it changed; readers carry the latest row forward between dates.
 */
export async function readPGliteDailyHistoryWithAccounts(
  reader: PGliteDailyHistoryReader,
  knowledgePoint: number,
  accounts: readonly CanonicalOverviewAccount[],
): Promise<PGliteDailyHistory> {
  if (!Number.isSafeInteger(knowledgePoint) || knowledgePoint < 0)
    throw new Error("Overview history knowledgePoint must be a non-negative safe integer.");

  const result = await reader.query<DailyHistoryEventRow>(
    `WITH balance_candidates AS (
       SELECT substring(revision.effective_at, 1, 10) AS event_date,
              'balance'::text AS event_type,
              encode(account.account_id, 'hex') AS account_id,
              account.account_type,
              connection.integration_namespace,
              observation.balance_kind,
              revision.currency,
              revision.balance_coefficient AS coefficient,
              revision.balance_scale AS scale,
              NULL::text AS security_id,
              NULL::text AS observed_at,
              ROW_NUMBER() OVER (
                PARTITION BY account.account_id, observation.balance_kind,
                  revision.currency, substring(revision.effective_at, 1, 10)
                ORDER BY revision.effective_at DESC, revision.observed_at DESC,
                  commit_row.commit_sequence DESC, revision.revision_number DESC
              ) AS selection_rank
         FROM balance_observation_revisions revision
         JOIN balance_observations observation ON observation.observation_id = revision.observation_id
         JOIN financial_accounts account ON account.account_id = observation.account_id
         JOIN source_connections connection ON connection.source_connection_id = account.source_connection_id
         JOIN canonical_commits account_commit ON account_commit.commit_id = account.created_commit_id
         JOIN canonical_commits commit_row ON commit_row.commit_id = revision.commit_id
        WHERE account_commit.commit_sequence <= $1
          AND commit_row.commit_sequence <= $1
          AND (
            (account.account_type = 'depository' AND (
              observation.balance_kind = 'ledger'
              OR (connection.integration_namespace = 'linebank' AND observation.balance_kind = 'available')
            ))
            OR (account.account_type = 'credit' AND observation.balance_kind = 'credit_used')
            OR (account.account_type = 'loan' AND observation.balance_kind IN (
              'outstanding_total', 'loan_outstanding', 'outstanding_principal'
            ))
          )
     ), holding_candidates AS (
       SELECT holding.effective_on AS event_date,
              'holding'::text AS event_type,
              encode(account.account_id, 'hex') AS account_id,
              account.account_type,
              connection.integration_namespace,
              NULL::text AS balance_kind,
              holding.valuation_currency AS currency,
              holding.valuation_coefficient AS coefficient,
              holding.valuation_scale AS scale,
              encode(holding.security_id, 'hex') AS security_id,
              holding.observed_at,
              ROW_NUMBER() OVER (
                PARTITION BY holding.account_id, holding.security_id, holding.effective_on
                ORDER BY holding.observed_at DESC, holding.revision_number DESC,
                  commit_row.commit_sequence DESC
              ) AS selection_rank
         FROM investment_holding_observations holding
         JOIN financial_accounts account ON account.account_id = holding.account_id
         JOIN source_connections connection ON connection.source_connection_id = account.source_connection_id
         JOIN canonical_commits account_commit ON account_commit.commit_id = account.created_commit_id
         JOIN canonical_commits commit_row ON commit_row.commit_id = holding.commit_id
        WHERE account_commit.commit_sequence <= $1
          AND commit_row.commit_sequence <= $1
          AND account.account_type = 'investment'
     )
     SELECT event_date, event_type, account_id, account_type,
            integration_namespace, balance_kind, currency, coefficient, scale, security_id, observed_at
       FROM balance_candidates WHERE selection_rank = 1
     UNION ALL
     SELECT event_date, event_type, account_id, account_type,
            integration_namespace, balance_kind, currency, coefficient, scale, security_id, observed_at
       FROM holding_candidates WHERE selection_rank = 1
      ORDER BY event_date, event_type, account_id, balance_kind, security_id, currency`,
    [knowledgePoint],
  );

  if (result.rows.length === 0) return { dailyHistory: [], dailyHistoryByAccount: {} };

  const collectionsByStart = holdingCollectionsByStart(result.rows);
  const labelByAccount = new Map(accounts.map((account) => [account.id, account.label]));
  const accountOrder = new Map(accounts.map((account, index) => [account.id, index]));
  const balanceStates = new Map<string, DailyHistoryEventRow>();
  const holdingStates = new Map<string, DailyHistoryEventRow>();
  const assets: AmountBuckets = new Map();
  const liabilities: AmountBuckets = new Map();
  const rows: DailyHistoryRowDto[] = [];
  const accountStates = new Map<string, AccountHistoryState>();
  const dailyHistoryByAccount: Record<string, DailyHistoryRowDto[]> = {};
  let previousNet: AmountBuckets | null = null;
  const accountState = (accountId: string): AccountHistoryState => {
    let state = accountStates.get(accountId);
    if (!state) {
      state = { assets: new Map(), liabilities: new Map(), holdings: new Set() };
      accountStates.set(accountId, state);
    }
    return state;
  };
  const adjust = (side: "assets" | "liabilities", accountId: string, currency: string, value: ExactAmount | null, sign: 1 | -1) => {
    adjustBucket(side === "assets" ? assets : liabilities, currency, value, sign);
    adjustBucket(accountState(accountId)[side], currency, value, sign);
  };

  for (let start = 0; start < result.rows.length;) {
    const date = result.rows[start]!.event_date;
    const changedAccounts = new Set<string>();
    for (const collection of collectionsByStart.get(date) ?? []) {
      const state = accountState(collection.accountId);
      for (const securityId of [...state.holdings]) {
        const key = `${collection.accountId}\u0000${securityId}`;
        const held = holdingStates.get(key);
        if (!held || collection.securities.has(securityId) || (held.observed_at ?? "") >= collection.observedAt) continue;
        if (held.currency) adjust("assets", collection.accountId, held.currency, rowExact(held), -1);
        holdingStates.delete(key);
        state.holdings.delete(securityId);
        changedAccounts.add(collection.accountId);
      }
    }
    let end = start;
    while (end < result.rows.length && result.rows[end]!.event_date === date) {
      const event = result.rows[end]!;
      changedAccounts.add(event.account_id);
      if (event.event_type === "balance" && event.balance_kind !== null && event.currency !== null) {
        const key = balanceKey(event.account_id, event.balance_kind, event.currency);
        const previous = balanceStates.get(key);
        if (event.account_type === "depository") {
          const priorSelected = selectedDepositoryBalance(balanceStates, event.account_id, event.integration_namespace, event.currency);
          balanceStates.set(key, event);
          const nextSelected = selectedDepositoryBalance(balanceStates, event.account_id, event.integration_namespace, event.currency);
          adjust("assets", event.account_id, event.currency, rowExact(priorSelected), -1);
          adjust("assets", event.account_id, event.currency, rowExact(nextSelected), 1);
        } else if (event.account_type === "credit" && event.balance_kind === "credit_used") {
          balanceStates.set(key, event);
          adjust("liabilities", event.account_id, event.currency, rowExact(previous), -1);
          adjust("liabilities", event.account_id, event.currency, rowExact(event), 1);
        } else if (event.account_type === "loan" && ["outstanding_total", "loan_outstanding", "outstanding_principal"].includes(event.balance_kind)) {
          balanceStates.set(key, event);
          adjust("liabilities", event.account_id, event.currency, rowExact(previous), -1);
          adjust("liabilities", event.account_id, event.currency, rowExact(event), 1);
        }
      } else if (event.event_type === "holding" && event.security_id !== null) {
        const key = `${event.account_id}\u0000${event.security_id}`;
        const previous = holdingStates.get(key);
        holdingStates.set(key, event);
        accountState(event.account_id).holdings.add(event.security_id);
        if (previous?.currency) adjust("assets", event.account_id, previous.currency, rowExact(previous), -1);
        if (event.currency) adjust("assets", event.account_id, event.currency, rowExact(event), 1);
      }
      end += 1;
    }

    const net = netAmounts(assets, liabilities);
    const accountChanges = [...changedAccounts]
      .sort((left, right) => (accountOrder.get(left) ?? Number.MAX_SAFE_INTEGER) - (accountOrder.get(right) ?? Number.MAX_SAFE_INTEGER))
      .map((accountId) => labelByAccount.get(accountId))
      .filter((label): label is string => label !== undefined)
      .slice(0, 6);
    rows.push({
      date,
      netAssets: amountLines(net),
      dailyChange: previousNet ? amountLines(difference(net, previousNet)) : [],
      assets: amountLines(assets),
      liabilities: amountLines(liabilities),
      accountChanges,
      positionCount: holdingStates.size,
    });
    for (const accountId of changedAccounts) {
      const state = accountState(accountId);
      const label = labelByAccount.get(accountId);
      (dailyHistoryByAccount[accountId] ??= []).push({
        date,
        netAssets: amountLines(netAmounts(state.assets, state.liabilities)),
        dailyChange: [],
        assets: amountLines(state.assets),
        liabilities: amountLines(state.liabilities),
        accountChanges: label === undefined ? [] : [label],
        positionCount: state.holdings.size,
      });
    }
    previousNet = net;
    start = end;
  }

  return { dailyHistory: rows, dailyHistoryByAccount };
}
