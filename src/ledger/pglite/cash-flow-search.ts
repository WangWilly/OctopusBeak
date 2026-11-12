import { cashFlowRule, type CashFlowRule } from "../canonical/cash-flow-inclusion.ts";
import { PERSONAL_CATEGORY_CODES } from "../canonical/personal-category-codes.ts";
import { TRANSACTION_KIND_CODES } from "../canonical/transaction-taxonomy.ts";
import { cashFlowCopy } from "../../lib/cash-flow/copy.ts";
import { CASH_FLOW_SEARCH_FIELDS, cashFlowTransferRole, type CashFlowSearchField } from "../../lib/cash-flow/model.ts";
import { isInstitutionKey, institutionNames } from "../../lib/institutions/institutions.ts";
import { SPENDING_CATEGORY_GROUP_IDS } from "../../lib/spending/category-groups.ts";
import { spendingCopy } from "../../lib/spending/copy.ts";
import { compareExact, normalizeCurrency, normalizeExact, type ExactAmount } from "../../lib/shared-money/exact-money.ts";
import { lastFour, readPGliteCashFlowSearchRows, type CashFlowAccount, type CashFlowReportTransaction, type CashFlowSearchRow } from "./cash-flow.ts";
import { bytes, idString, pgliteQuery, rows, type PGliteSpendingReader } from "./spending-sql.ts";

/**
 * Cash flow search (issue #460): one rule decides whether a row matches, both
 * inside the period and across all periods. Across all periods, SQL first
 * narrows the canonical rows to those that could match, and only those are
 * classified.
 */

const LOCALES = ["zh-TW", "en"] as const;
const institutionLabels = LOCALES.map((locale) => institutionNames(locale));

export type CashFlowAmountQuery = Readonly<{ amount: ExactAmount; currency: string | null }>;

const CURRENCY_PREFIXES: readonly (readonly [RegExp, string | null])[] = [
  [/^(?:NT\$|TWD)/iu, "TWD"],
  [/^(?:US\$|USD)/iu, "USD"],
  [/^\$/u, null],
];

/** `2,370`, `NT$300`, `USD 12.5` or `-300.5` as an exact amount, with the currency it names; null when the query is not an amount. */
export function amountQuery(query: string): CashFlowAmountQuery | null {
  let text = query.replace(/[\s,]/gu, "").replace(/^[+\-−]/u, "");
  let currency: string | null = null;
  for (const [prefix, code] of CURRENCY_PREFIXES) {
    if (!prefix.test(text)) continue;
    text = text.replace(prefix, "");
    currency = code;
    break;
  }
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(text);
  if (!match) return null;
  const fraction = match[2] ?? "";
  return { amount: normalizeExact({ coefficient: BigInt(`${match[1]}${fraction}`).toString(), scale: fraction.length }), currency };
}

type MatchableRow = Pick<CashFlowReportTransaction, "details" | "cashFlow" | "amount" | "source" | "kind" | "transferLinkId">;

function categoryLabels(transaction: MatchableRow): string[] {
  const flow = transaction.cashFlow;
  return LOCALES.flatMap((locale) => {
    const cash = cashFlowCopy[locale].cashFlow;
    const spending = spendingCopy[locale].spending;
    switch (flow.class) {
      case "inflow":
        return [cash.inflowGroups[flow.group]];
      case "not_counted":
        return [cashFlowTransferRole(transaction) === "other" ? cash.otherTransfer : cash.notCounted[flow.reason]];
      case "unresolved":
        return [cash.unresolvedTag];
      case "outflow":
      case "refund":
        return [
          ...(flow.class === "refund" ? [cash.refund] : []),
          ...flow.categories.flatMap((share) => share.category === null
            ? [cash.unclassified]
            : [spending.categoryGroups[share.group], spending.personalCategories[share.category]]),
        ];
    }
  });
}

function accountLabels(account: Pick<CashFlowAccount, "institutionKey" | "mask" | "name">): string[] {
  const key = account.institutionKey;
  return [
    ...(key !== null && isInstitutionKey(key) ? institutionLabels.map((names) => names[key]) : []),
    account.mask,
    account.name,
  ].filter((value): value is string => typeof value === "string");
}

const includes = (needle: string) => (value: string | null) => value !== null && value.toLocaleLowerCase().includes(needle);

/**
 * The fields a transaction matches: a case-insensitive substring of its text
 * fields, and for an amount query, the exact amount in the currency the query
 * names, or in any currency when it names none.
 */
export function cashFlowMatches(transaction: MatchableRow, query: string): readonly CashFlowSearchField[] {
  const has = includes(query.toLocaleLowerCase());
  const amount = amountQuery(query);
  const matched: Record<CashFlowSearchField, boolean> = {
    description: has(transaction.details.description),
    counterparty: has(transaction.details.counterparty),
    category: categoryLabels(transaction).some(has),
    account: accountLabels(transaction.details.account).some(has),
    amount: amount !== null
      && (amount.currency === null || amount.currency === normalizeCurrency(transaction.amount.currency))
      && compareExact(normalizeExact(transaction.amount), amount.amount) === 0,
    note: has(transaction.details.note),
  };
  return CASH_FLOW_SEARCH_FIELDS.filter((field) => matched[field]);
}

/** Whether a row `rule` decides could carry a matching category label; `outflowLabels` stands for every Spending category label. */
function ruleMatches(rule: CashFlowRule, has: (value: string) => boolean, outflowLabels: boolean): boolean {
  const labels = LOCALES.flatMap((locale): string[] => {
    const cash = cashFlowCopy[locale].cashFlow;
    switch (rule.class) {
      case "inflow":
        return [cash.inflowGroups[rule.group]];
      case "not_counted":
        return rule.reason === "transfer" ? [cash.notCounted.transfer, cash.otherTransfer] : [cash.notCounted[rule.reason]];
      case "unresolved":
        return [cash.unresolvedTag];
      case "refund":
        // A refund nothing proves stays unresolved.
        return [cash.refund, cash.unresolvedTag];
      case "outflow":
        return [];
    }
  });
  return labels.some(has) || ((rule.class === "outflow" || rule.class === "refund") && outflowLabels);
}

/** Which Kinds could carry a category label that contains `needle`. */
function categoryKinds(needle: string): Readonly<{ kinds: readonly string[]; unregistered: boolean; linked: boolean }> {
  const has = (value: string) => value.toLocaleLowerCase().includes(needle);
  const outflowLabels = LOCALES.some((locale) => {
    const spending = spendingCopy[locale].spending;
    return has(cashFlowCopy[locale].cashFlow.unclassified)
      || SPENDING_CATEGORY_GROUP_IDS.some((group) => has(spending.categoryGroups[group]))
      || PERSONAL_CATEGORY_CODES.some((code) => has(spending.personalCategories[code]));
  });
  const kinds = TRANSACTION_KIND_CODES.filter((code) =>
    ruleMatches(cashFlowRule(code, "inflow"), has, outflowLabels) || ruleMatches(cashFlowRule(code, "outflow"), has, outflowLabels));
  return {
    kinds,
    unregistered: LOCALES.some((locale) => has(cashFlowCopy[locale].cashFlow.unresolvedTag)),
    linked: LOCALES.some((locale) => has(cashFlowCopy[locale].cashFlow.notCounted.transfer)),
  };
}

/** PGlite's `lower` folds ASCII only, so a needle with other cased letters is matched in JavaScript instead. */
const sqlFoldable = (needle: string) => [...needle].every((char) => char <= "\u007f" || char.toLowerCase() === char.toUpperCase());

/**
 * Every current canonical transaction that could match `query`, a superset of
 * the matches: classification and `cashFlowMatches` decide the rest.
 */
export async function cashFlowSearchCandidates(reader: PGliteSpendingReader, query: string): Promise<string[]> {
  const needle = query.toLocaleLowerCase();
  const ids = new Set<string>();
  const add = (found: readonly { transaction_id: unknown }[]) => {
    for (const row of found) ids.add(idString(row.transaction_id, "Transaction identity"));
  };
  const foldable = sqlFoldable(needle);
  const matchesText = includes(needle);
  const text = async (column: string, from: string, id = "transaction_id") => {
    const found = rows(await pgliteQuery<{ transaction_id: unknown; value: unknown }>(reader,
      `SELECT ${id} AS transaction_id, ${column} AS value ${from} AND ${foldable ? `strpos(lower(${column}), ?) > 0` : `${column} IS NOT NULL`}`,
      foldable ? [needle] : []));
    add(found.filter((row) => typeof row.value === "string" && matchesText(row.value)));
  };
  await text("revision.description", `FROM current_transactions
    JOIN transaction_revisions revision ON revision.revision_id = current_transactions.revision_id WHERE TRUE`, "current_transactions.transaction_id");
  await text("value_text", "FROM current_transaction_enrichment WHERE field_name = 'counterparty_display'");
  await text("value_text", "FROM current_transaction_fields WHERE field_name = 'note'");

  const amount = amountQuery(query);
  if (amount !== null) {
    // Scaling the stored coefficient to the query's scale compares the two exactly.
    add(rows(await pgliteQuery<{ transaction_id: unknown }>(reader,
      `SELECT current_row.transaction_id
         FROM current_transactions current_row
         JOIN transaction_revisions revision ON revision.revision_id = current_row.revision_id
        WHERE ABS(CAST(revision.amount_coefficient AS NUMERIC)) * power(10::NUMERIC, CAST(? AS INTEGER) - revision.amount_scale) = CAST(? AS NUMERIC)
          ${amount.currency === null ? "" : "AND upper(trim(revision.currency)) = ?"}`,
      [amount.amount.scale, amount.amount.coefficient, ...amount.currency === null ? [] : [amount.currency]])));
  }

  const accounts = rows(await pgliteQuery<{ account_id: unknown; institution_key: unknown; account_no: unknown }>(reader,
    "SELECT account_id, institution_key, account_no FROM financial_accounts"));
  const accountIds = accounts
    .filter((account) => accountLabels({
      institutionKey: typeof account.institution_key === "string" ? account.institution_key : null,
      mask: lastFour(typeof account.account_no === "string" ? account.account_no : null),
      name: null,
    }).some(matchesText))
    .map((account) => idString(account.account_id, "Account identity"));
  for (let start = 0; start < accountIds.length; start += 2_048) {
    const chunk = accountIds.slice(start, start + 2_048);
    add(rows(await pgliteQuery<{ transaction_id: unknown }>(reader,
      `SELECT current_row.transaction_id
         FROM current_transactions current_row
         JOIN financial_transactions transaction_row ON transaction_row.transaction_id = current_row.transaction_id
        WHERE transaction_row.account_id IN (${chunk.map(() => "?").join(",")})`,
      chunk.map((id) => bytes(id, "Account identity")))));
  }

  const category = categoryKinds(needle);
  if (category.kinds.length > 0)
    add(rows(await pgliteQuery<{ transaction_id: unknown }>(reader,
      `SELECT transaction_id FROM current_transaction_enrichment
        WHERE field_name = 'kind' AND taxonomy_code IN (${category.kinds.map(() => "?").join(",")})`,
      [...category.kinds])));
  if (category.unregistered)
    add(rows(await pgliteQuery<{ transaction_id: unknown }>(reader,
      `SELECT current_row.transaction_id
         FROM current_transactions current_row
         LEFT JOIN current_transaction_enrichment kind
           ON kind.transaction_id = current_row.transaction_id AND kind.field_name = 'kind'
        WHERE kind.taxonomy_code IS NULL OR kind.taxonomy_code NOT IN (${TRANSACTION_KIND_CODES.map(() => "?").join(",")})`,
      [...TRANSACTION_KIND_CODES])));
  // A stored link turns two fallback sides into an internal transfer.
  if (category.linked)
    add(rows(await pgliteQuery<{ transaction_id: unknown }>(reader,
      `SELECT outflow_transaction_id AS transaction_id FROM current_cash_flow_transfer_links
       UNION SELECT inflow_transaction_id FROM current_cash_flow_transfer_links`)));
  return [...ids];
}

/** Every row in every period that matches `query`, classified as a period read classifies it. */
export async function readCashFlowSearchMatches(reader: PGliteSpendingReader, knowledgeAt: number, query: string): Promise<CashFlowSearchRow[]> {
  const candidates = await cashFlowSearchCandidates(reader, query);
  return (await readPGliteCashFlowSearchRows(reader, knowledgeAt, candidates))
    .filter((row) => cashFlowMatches(row, query).length > 0);
}
