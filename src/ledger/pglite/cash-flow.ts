import {
  CASH_FLOW_INCLUSION_POLICY,
  canonicalCashFlowKind,
  cashFlowClass,
  cashFlowRule,
  cashFlowTotals,
  categoryShare,
  type CashFlowCategoryShare,
  type CashFlowClass,
  type CashFlowCurrencyTotals,
  type CashFlowTransaction,
} from "../canonical/cash-flow-inclusion.ts";
import {
  cashFlowTransferSuspension,
  linkedCashFlow,
  pairCashFlowTransfers,
  type CashFlowTransferPairing,
  type StoredCashFlowTransferLink,
} from "../canonical/cash-flow-transfer.ts";
import {
  CASH_FLOW_TRANSFER_WINDOW_DAYS,
  type CashFlowTransferPair,
  type CashFlowTransferPairHistory,
  transferLinkId,
} from "../canonical/cash-flow-transfer-rules.ts";
import type { CanonicalSpendingCategorization, CanonicalSpendingTransaction } from "../canonical/canonical-spending-contracts.ts";
import { isPersonalCategoryCode } from "../canonical/personal-category-codes.ts";
import { exactFromManualAmount } from "../../lib/manual-assets/manual-assets.ts";
import { absoluteExact, compareExact, normalizeExact, sameCurrency, type ExactAmount, type ExactMoney } from "../../lib/shared-money/exact-money.ts";
import { isCategoryApplicable } from "../canonical/transaction-taxonomy.ts";
import { readKnowledgePoint } from "./knowledge-point.ts";
import { currentTransactionIdsByFinancialDate, querySpendingReport } from "./spending-facts.ts";
import { bytes, idString, ISO_DATE, pgliteQuery, rows, type PGliteSpendingReader } from "./spending-sql.ts";

/**
 * The Cash flow inclusion query (PRD #456, issue #457): every canonical and
 * Manual Account transaction dated in a range, each with its cash-flow class.
 * Canonical rows come from the same fact reader as Spending, which already
 * leaves out accounts Direct source precedence covers; Preview Financial Data
 * lives in its own tables and never reaches it.
 */

export type CashFlowRequest = Readonly<{ startDate: string; endDate: string }>;

/** The account a transaction belongs to, as a list row names it. */
export type CashFlowAccount = Readonly<{
  id: string;
  source: "canonical" | "manual";
  institutionKey: string | null;
  stream: string | null;
  /** The account number's last four digits, when it has them. */
  mask: string | null;
  /** A Manual Account's own name. */
  name: string | null;
}>;

export type CashFlowTransactionDetails = Readonly<{
  description: string | null;
  counterparty: string | null;
  note: string | null;
  /** `HH:mm`, only when the source reported a minute or second on the transaction's own date. */
  time: string | null;
  account: CashFlowAccount;
  /** What the transaction detail may change; null for a Manual Account row, which its own page edits. */
  edit: CashFlowRowEdit | null;
}>;

/** The transaction's own Current categorization, which a refund's inherited categories never replace here. */
export type CashFlowRowCategorization =
  | Readonly<{ mode: "absent" }>
  | Readonly<{ mode: "single"; origin: "user" | "source" | "derived"; categoryCode: string }>
  | Readonly<{ mode: "allocated"; components: readonly Readonly<{ categoryCode: string; amount: ExactAmount }>[] }>;

/** A canonical row's editable facts (issue #461). */
export type CashFlowRowEdit = Readonly<{
  /** The Spending purchase the `category` and `allocation` actions name: its link when linked, else the transaction. */
  purchaseId: string;
  /** Whether the row's Kind admits a Personal Category (Category applicability). */
  categorizable: boolean;
  /**
   * Whether Spending lists `purchaseId` as a purchase record, so a category or
   * split written here changes Spending too. A recognized refund or an inflow
   * keeps its category in Cash flow only.
   */
  spendingPurchase: boolean;
  categorization: CashFlowRowCategorization;
  /** Whether the shown note is the person's own, so clearing it changes something. */
  userNote: boolean;
  tags: readonly Readonly<{ tagId: string; label: string }>[];
}>;

/**
 * `transferLinkId` names the row's current Cash-flow transfer link when that
 * link is a pair: neither of its sides stays counted. A link that leaves a side
 * counted changes nothing, so its rows carry none.
 */
export type CashFlowReportTransaction = CashFlowTransaction & Readonly<{ details: CashFlowTransactionDetails; transferLinkId: string | null }>;

export type CashFlowReport = Readonly<{
  policy: typeof CASH_FLOW_INCLUSION_POLICY;
  knowledgeAt: number;
  startDate: string;
  endDate: string;
  transactions: readonly CashFlowReportTransaction[];
  totals: readonly CashFlowCurrencyTotals[];
  /** The links, suspended links and candidates with at least one side among `transactions`. */
  transfers: CashFlowTransferPairing;
  /**
   * Every side of `transfers` that Cash flow counts, in the range or not, as a
   * row shows it, plus `ownCashFlow`: its class with no link applied.
   */
  transferSides: readonly CashFlowTransferSideRow[];
  /** Pairs with a side among `transactions` that the person denied, by link id: never proposed again, never paired by hand. */
  deniedPairs: readonly string[];
}>;

export type CashFlowTransferSideRow = CashFlowReportTransaction & Readonly<{ ownCashFlow: CashFlowClass }>;

function direction(value: string): "inflow" | "outflow" {
  if (value === "inflow" || value === "outflow") return value;
  throw new Error(`Transaction direction ${value} is not supported.`);
}

/** A single category or a complete allocation in the booked currency; anything else is unclassified. */
function sharesOf(categorization: CanonicalSpendingCategorization, amount: ExactMoney): readonly CashFlowCategoryShare[] | null {
  if (categorization.mode === "single")
    return isPersonalCategoryCode(categorization.categoryCode) ? [categoryShare(categorization.categoryCode, amount)] : null;
  if (categorization.mode !== "allocated") return null;
  const shares: CashFlowCategoryShare[] = [];
  for (const component of categorization.components ?? []) {
    if (!isPersonalCategoryCode(component.categoryCode) || !sameCurrency(component, amount)) return null;
    shares.push(categoryShare(component.categoryCode, component));
  }
  return shares.length > 0 ? shares : null;
}

const unclassified = (amount: ExactMoney): readonly CashFlowCategoryShare[] => [categoryShare(null, amount)];

/**
 * A refund inherits its original's categories only through `refund_of` or `reversal_of`, as
 * Relation-backed categorization allows: a single category always, an
 * allocation only for a full refund, never a proportional guess.
 */
function inheritedShares(original: CanonicalSpendingTransaction | undefined, amount: ExactMoney): readonly CashFlowCategoryShare[] | null {
  if (!original) return null;
  if (original.categorization.mode === "single") return sharesOf(original.categorization, amount);
  if (original.categorization.mode === "allocated" && sameCurrency(original.amount, amount)
    && compareExact(absoluteExact(original.amount), amount) === 0)
    return sharesOf(original.categorization, amount);
  return null;
}

function counted(transaction: CanonicalSpendingTransaction): boolean {
  return transaction.administrativeState === "active"
    && transaction.postingStatus === "posted"
    && transaction.economicStatus !== "canceled";
}

/** Run one `IN (...)` read per chunk of transaction ids. */
async function byChunk<T extends Record<string, unknown>>(
  reader: PGliteSpendingReader,
  ids: readonly string[],
  sql: (placeholders: string) => string,
  leading: readonly unknown[] = [],
): Promise<T[]> {
  const found: T[] = [];
  for (let start = 0; start < ids.length; start += 2_048) {
    const chunk = ids.slice(start, start + 2_048);
    const params = [...leading, ...chunk.map((id) => bytes(id, "Transaction"))];
    found.push(...rows(await pgliteQuery<T>(reader, sql(chunk.map(() => "?").join(",")), params)));
  }
  return found;
}

/** The `evidenceKind` the Kind enrichment recorded for each transaction, when it recorded one. */
async function kindEvidence(reader: PGliteSpendingReader, transactionIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const found = await byChunk<{ transaction_id: unknown; evidence_kind: unknown }>(reader, transactionIds, (placeholders) =>
    `SELECT enrichment.transaction_id, (output.provenance_json::jsonb)->>'evidenceKind' AS evidence_kind
       FROM current_transaction_enrichment enrichment
       JOIN enrichment_run_outputs output
         ON output.transaction_id = enrichment.transaction_id
        AND output.field_name = 'kind'
        AND output.assertion_id = enrichment.assertion_id
      WHERE enrichment.field_name = 'kind'
        AND enrichment.transaction_id IN (${placeholders})`);
  return new Map(found.filter((row) => typeof row.evidence_kind === "string")
    .map((row) => [idString(row.transaction_id, "Kind transaction"), row.evidence_kind as string]));
}

/**
 * Each refund's `refund_of` or `reversal_of` original, or null when it names
 * several originals: such a refund is still related, but inherits nothing.
 */
async function refundOriginals(reader: PGliteSpendingReader, refundIds: readonly string[]): Promise<ReadonlyMap<string, string | null>> {
  const originals = new Map<string, string | null>();
  for (const row of await byChunk<{ from_transaction_id: unknown; to_transaction_id: unknown }>(reader, refundIds, (placeholders) =>
    `SELECT DISTINCT from_transaction_id, to_transaction_id
       FROM canonical_credit_card_relations
      WHERE relation_kind IN ('refund_of', 'reversal_of')
        AND from_transaction_id IN (${placeholders})`)) {
    const refund = idString(row.from_transaction_id, "Refund transaction");
    const original = idString(row.to_transaction_id, "Refunded transaction");
    originals.set(refund, originals.has(refund) && originals.get(refund) !== original ? null : original);
  }
  return originals;
}

/** Transactions Spending recognizes as an active refund, the same rows as active_refunds in the Purchase report. */
async function spendingRefunds(reader: PGliteSpendingReader, knowledgeAt: number, transactionIds: readonly string[]): Promise<ReadonlySet<string>> {
  const found = await byChunk<{ transaction_id: unknown }>(reader, transactionIds, (placeholders) =>
    `WITH ranked AS (
       SELECT identity.transaction_id, revision.state, revision.amount_coefficient, revision.occurrence_value,
              ROW_NUMBER() OVER (
                PARTITION BY revision.refund_id
                ORDER BY revision.revision_number DESC, commit_row.commit_sequence DESC, revision.revision_id DESC
              ) AS revision_rank
         FROM spending_refund_revisions revision
         JOIN spending_refund_identities identity ON identity.refund_id = revision.refund_id
         JOIN canonical_commits commit_row ON commit_row.commit_id = revision.commit_id
        WHERE commit_row.commit_sequence <= ?
          AND identity.transaction_id IN (${placeholders})
     ) SELECT transaction_id FROM ranked
        WHERE revision_rank = 1 AND state = 'active'
          AND amount_coefficient IS NOT NULL AND occurrence_value IS NOT NULL`, [knowledgeAt]);
  return new Set(found.map((row) => idString(row.transaction_id, "Refund transaction")));
}

/** A defaulted midnight, a date-only time, or a time on another day than the row's date is never shown. */
export function reportedTime(local: string | null, precision: string | null, origin: string | null, date: string): string | null {
  if (local === null || origin !== "source_reported" || (precision !== "minute" && precision !== "second")) return null;
  if (local.slice(0, 10) !== date) return null;
  return /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})/u.exec(local)?.[1] ?? null;
}

export function lastFour(accountNumber: string | null): string | null {
  const digits = (accountNumber ?? "").replace(/\D/gu, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

type CanonicalFacts = Readonly<{
  counterparty: string | null;
  note: string | null;
  userNote: boolean;
  /** The confirmed Spending link event the transaction belongs to, when it is linked. */
  linkEventId: string | null;
  /** Whether Spending lists the row's purchase id as a purchase record, so a category written here shows there. */
  spendingPurchase: boolean;
  time: Readonly<{ local: string; precision: string; origin: string }> | null;
}>;

/** The counterparty display, note and source time of each current transaction revision. */
async function canonicalFacts(
  reader: PGliteSpendingReader,
  knowledgeAt: number,
  transactions: readonly CanonicalSpendingTransaction[],
): Promise<ReadonlyMap<string, CanonicalFacts>> {
  const ids = transactions.map((transaction) => transaction.transactionId);
  const counterparties = await byChunk<{ transaction_id: unknown; value_text: unknown }>(reader, ids, (placeholders) =>
    `SELECT transaction_id, value_text FROM current_transaction_enrichment
      WHERE field_name = 'counterparty_display' AND transaction_id IN (${placeholders})`);
  const notes = await byChunk<{ transaction_id: unknown; value_text: unknown; origin: unknown }>(reader, ids, (placeholders) =>
    `SELECT transaction_id, value_text, origin FROM current_transaction_fields
      WHERE field_name = 'note' AND transaction_id IN (${placeholders})`);
  // A Spending link makes a `link:` record only while its invoice is active, as the Purchase report composes it.
  const links = await byChunk<{ transaction_id: unknown; confirmed_event_id: unknown; invoice_state: unknown }>(reader, ids, (placeholders) =>
    `SELECT link.transaction_id, link.confirmed_event_id,
            (SELECT revision.state FROM einvoice_invoice_revisions revision
              WHERE revision.invoice_id = link.invoice_id
              ORDER BY revision.revision_number DESC, revision.revision_id DESC LIMIT 1) AS invoice_state
       FROM current_spending_dedup_links link WHERE link.transaction_id IN (${placeholders})`);
  const userNotes = new Set(notes.filter((row) => row.origin === "user").map((row) => idString(row.transaction_id, "Transaction")));
  const linkOf = new Map(links.filter((row) => row.invoice_state === "active")
    .map((row) => [idString(row.transaction_id, "Linked transaction"), idString(row.confirmed_event_id, "Spending link")]));
  const purchases = await spendingPurchaseIds(reader, knowledgeAt, transactions);
  const revisionOf = new Map(transactions.map((transaction) => [transaction.revisionId, transaction.transactionId]));
  const times = new Map<string, { local: string; precision: string; origin: string }>();
  const revisionIds = [...revisionOf.keys()];
  for (let start = 0; start < revisionIds.length; start += 2_048) {
    const chunk = revisionIds.slice(start, start + 2_048);
    for (const row of rows(await pgliteQuery<{ revision_id: unknown; local: unknown; precision: unknown; origin: unknown }>(reader,
      `SELECT revision_id, transaction_date_time_local AS local, time_precision AS precision, time_origin AS origin
         FROM transaction_revisions WHERE revision_id IN (${chunk.map(() => "?").join(",")})`,
      chunk.map((id) => bytes(id, "Transaction revision"))))) {
      const transactionId = revisionOf.get(idString(row.revision_id, "Transaction revision"));
      if (transactionId) times.set(transactionId, { local: String(row.local), precision: String(row.precision), origin: String(row.origin) });
    }
  }
  const text = (found: readonly { transaction_id: unknown; value_text: unknown }[]) => new Map(found
    .filter((row) => typeof row.value_text === "string" && row.value_text.trim() !== "")
    .map((row) => [idString(row.transaction_id, "Transaction"), (row.value_text as string).trim()]));
  const counterpartyOf = text(counterparties);
  const noteOf = text(notes);
  return new Map(ids.map((id) => [id, {
    counterparty: counterpartyOf.get(id) ?? null,
    note: noteOf.get(id) ?? null,
    userNote: userNotes.has(id) && noteOf.has(id),
    linkEventId: linkOf.get(id) ?? null,
    spendingPurchase: purchases.has(id),
    time: times.get(id) ?? null,
  }]));
}

/**
 * The rows among `transactions` that Spending's Purchase report lists as a
 * purchase, linked or bank-only: every row Spending includes, less a
 * recognized refund, which is a `refund:` record with no category. Read from
 * the inclusion the fact read already decided, so no Purchase record is built.
 */
async function spendingPurchaseIds(
  reader: PGliteSpendingReader,
  knowledgeAt: number,
  transactions: readonly CanonicalSpendingTransaction[],
): Promise<ReadonlySet<string>> {
  const included = transactions.filter((transaction) => transaction.inclusion === "included").map((transaction) => transaction.transactionId);
  // A recognized refund stands in for the outflow it names, so that outflow has no purchase record.
  const refunds = await spendingRefunds(reader, knowledgeAt, included);
  return new Set(included.filter((id) => !refunds.has(id)));
}

/** Category applicability is all or nothing per Kind, so one registered code decides it. */
function categorizable(kind: string | null): boolean {
  return kind !== null && isCategoryApplicable("dining", kind);
}

function canonicalDetails(transaction: CanonicalSpendingTransaction, date: string, facts: CanonicalFacts | undefined): CashFlowTransactionDetails {
  return {
    description: transaction.description?.trim() || null,
    counterparty: facts?.counterparty ?? null,
    note: facts?.note ?? null,
    time: facts?.time ? reportedTime(facts.time.local, facts.time.precision, facts.time.origin, date) : null,
    account: {
      id: transaction.accountId,
      source: "canonical",
      institutionKey: transaction.institutionKey,
      stream: transaction.stream,
      mask: lastFour(transaction.accountNumber),
      name: null,
    },
    edit: {
      purchaseId: facts?.linkEventId ? `link:${facts.linkEventId}` : `transaction:${transaction.transactionId}`,
      categorizable: categorizable(transaction.kind),
      spendingPurchase: facts?.spendingPurchase ?? false,
      categorization: rowCategorization(transaction.categorization),
      userNote: facts?.userNote ?? false,
      tags: transaction.tags.map((tag) => ({ tagId: tag.tagId, label: tag.label })),
    },
  };
}

function rowCategorization(categorization: CanonicalSpendingCategorization): CashFlowRowCategorization {
  if (categorization.mode === "single" && categorization.categoryCode && categorization.origin)
    return { mode: "single", origin: categorization.origin, categoryCode: categorization.categoryCode };
  if (categorization.mode === "allocated" && categorization.components)
    return {
      mode: "allocated",
      components: categorization.components.map((component) => ({ categoryCode: component.categoryCode, amount: normalizeExact(component) })),
    };
  return { mode: "absent" };
}

/** A canonical row, the effective date the period filter reads, and the fact row its list details come from. */
type DatedCashFlowTransaction = CashFlowTransaction & Readonly<{ effectiveOn: string; spending: CanonicalSpendingTransaction }>;

async function canonicalTransactions(
  reader: PGliteSpendingReader,
  knowledgeAt: number,
  request: CashFlowRequest | Readonly<{ transactionIds: readonly string[] }>,
): Promise<DatedCashFlowTransaction[]> {
  const report = await querySpendingReport(reader, "current", knowledgeAt, null, request);
  const counting = report.transactions.filter(counted);
  const evidenceOf = await kindEvidence(reader, counting.map((transaction) => transaction.transactionId));
  const included = counting.map((transaction) => {
    const flowDirection = direction(transaction.direction);
    const amount = { ...absoluteExact(transaction.amount), currency: transaction.amount.currency };
    const evidence = evidenceOf.get(transaction.transactionId) ?? null;
    return { transaction, flowDirection, amount, evidence, rule: cashFlowRule(transaction.kind, flowDirection) };
  });
  const refundIds = included.filter((entry) => entry.rule.class === "refund").map((entry) => entry.transaction.transactionId);
  const originalOf = await refundOriginals(reader, refundIds);
  // A card inflow whose description names nothing is a refund by direction alone; only a relation or Spending's refund recognition proves it is one.
  const directionRefunds = included
    .filter((entry) => entry.rule.class === "refund" && entry.evidence === "direction" && !originalOf.has(entry.transaction.transactionId))
    .map((entry) => entry.transaction.transactionId);
  const recognized = await spendingRefunds(reader, knowledgeAt, directionRefunds);
  const unproven = new Set(directionRefunds.filter((id) => !recognized.has(id)));
  const originalIds = [...new Set([...originalOf.values()].filter((id): id is string => id !== null))];
  const originals = originalIds.length === 0
    ? new Map<string, CanonicalSpendingTransaction>()
    : new Map((await querySpendingReport(reader, "current", knowledgeAt, null, { transactionIds: originalIds }))
      .transactions.map((original) => [original.transactionId, original]));
  return included.map(({ transaction, flowDirection, amount, evidence, rule }) => {
    const own = sharesOf(transaction.categorization, amount);
    // Only a refund's own User Categorization outranks Relation-backed categorization.
    const originalId = rule.class === "refund" && transaction.categorization.origin !== "user"
      ? originalOf.get(transaction.transactionId) ?? undefined
      : undefined;
    const inherited = originalId === undefined ? null : inheritedShares(originals.get(originalId), amount);
    return {
      effectiveOn: transaction.effectiveOn,
      spending: transaction,
      transactionId: transaction.transactionId,
      source: "canonical" as const,
      accountId: transaction.accountId,
      date: transaction.consumeDate ?? transaction.effectiveOn,
      amount,
      direction: flowDirection,
      kind: canonicalCashFlowKind(transaction.kind, evidence),
      cashFlow: unproven.has(transaction.transactionId)
        ? { class: "unresolved" as const }
        : cashFlowClass(rule, amount, inherited ?? own ?? unclassified(amount), inherited ? originalId! : null),
    };
  });
}

type ManualRow = Readonly<{
  transaction_id: string; account_id: string; occurred_on: string; amount: string; currency: string;
  kind: "purchase" | "receipt" | "transfer"; personal_category: string | null; direction: "out" | "in" | null;
  note: string | null; account_name: string;
}>;

/**
 * A Manual Account's Kind is what the person entered, so it is never a
 * producer fallback. A Manual Account transfer names its counterpart account,
 * so it counts as `transfer.internal`.
 */
async function manualTransactions(reader: PGliteSpendingReader, request: CashFlowRequest): Promise<Omit<CashFlowReportTransaction, "transferLinkId">[]> {
  const result = await reader.query<ManualRow>(
    `SELECT tx.transaction_id, tx.account_id, tx.occurred_on, tx.amount, account.currency,
            tx.kind, tx.personal_category, tx.direction, tx.note, account.name AS account_name
       FROM manual_transactions tx
       JOIN manual_assets account ON account.asset_id = tx.account_id
      WHERE tx.occurred_on BETWEEN $1 AND $2`,
    [request.startDate, request.endDate],
  );
  return result.rows.map((row) => {
    const flowDirection = row.kind === "purchase" || row.direction === "out" ? "outflow" : "inflow";
    const amount = { ...exactFromManualAmount(row.amount), currency: row.currency };
    const category = isPersonalCategoryCode(row.personal_category) ? row.personal_category : null;
    return {
      transactionId: row.transaction_id,
      source: "manual" as const,
      accountId: row.account_id,
      date: row.occurred_on,
      amount,
      direction: flowDirection,
      kind: { code: row.kind, basis: "evidence" as const },
      cashFlow: cashFlowClass(cashFlowRule(row.kind === "transfer" ? "transfer.internal" : row.kind, flowDirection), amount, [categoryShare(category, amount)], null),
      details: {
        description: null,
        counterparty: null,
        note: row.note?.trim() || null,
        time: null,
        account: { id: row.account_id, source: "manual" as const, institutionKey: null, stream: null, mask: null, name: row.account_name },
        edit: null,
      },
    };
  });
}

const FIRST_DATE = "0001-01-01";
const LAST_DATE = "9999-12-31";

/** `date` moved by `days`, held within the four-digit years an ISO date can name. */
export function shiftDate(date: string, days: number): string {
  const shifted = new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000);
  const year = shifted.getUTCFullYear();
  if (year < 1) return FIRST_DATE;
  if (year > 9999) return LAST_DATE;
  return shifted.toISOString().slice(0, 10);
}

/** The current stored links with a side among `transactionIds`, whichever side it is, valid or not. */
export async function readStoredCashFlowTransferLinks(reader: PGliteSpendingReader, transactionIds: readonly string[]): Promise<StoredCashFlowTransferLink[]> {
  type LinkRow = { outflow_transaction_id: unknown; inflow_transaction_id: unknown; event_id: unknown; link_origin: unknown; commit_sequence: unknown };
  const sql = (column: string) => (placeholders: string) =>
    `SELECT link.outflow_transaction_id, link.inflow_transaction_id, event.event_id, event.link_origin, commit_row.commit_sequence
       FROM current_cash_flow_transfer_links link
       JOIN cash_flow_transfer_decision_events event ON event.event_id = link.confirmed_event_id
       JOIN canonical_commits commit_row ON commit_row.commit_id = event.commit_id
      WHERE link.${column} IN (${placeholders})`;
  const found = [
    ...await byChunk<LinkRow>(reader, transactionIds, sql("outflow_transaction_id")),
    ...await byChunk<LinkRow>(reader, transactionIds, sql("inflow_transaction_id")),
  ];
  const links = new Map<string, StoredCashFlowTransferLink>();
  for (const row of found) {
    const origin = row.link_origin;
    if (origin !== "confirmed" && origin !== "manual") throw new Error(`Stored Cash-flow transfer link origin ${String(origin)} is not supported.`);
    const eventId = idString(row.event_id, "Transfer decision");
    links.set(eventId, {
      outflowTransactionId: idString(row.outflow_transaction_id, "Transfer outflow"),
      inflowTransactionId: idString(row.inflow_transaction_id, "Transfer inflow"),
      origin: { kind: origin, eventId, decidedAtKnowledge: Number(row.commit_sequence) },
    });
  }
  return [...links.values()];
}

/** Every decided pair whose outflow is among `transactionIds`; a denial is final. */
async function transferHistory(reader: PGliteSpendingReader, transactionIds: readonly string[]): Promise<Map<string, CashFlowTransferPairHistory>> {
  const found = await byChunk<{ outflow_transaction_id: unknown; inflow_transaction_id: unknown; denied: unknown }>(reader, transactionIds, (placeholders) =>
    `SELECT outflow_transaction_id, inflow_transaction_id, BOOL_OR(event_kind = 'denied') AS denied
       FROM cash_flow_transfer_decision_events
      WHERE outflow_transaction_id IN (${placeholders})
      GROUP BY outflow_transaction_id, inflow_transaction_id`);
  return new Map(found.map((row) => [
    `${idString(row.outflow_transaction_id, "Transfer outflow")}/${idString(row.inflow_transaction_id, "Transfer inflow")}`,
    row.denied === true ? "denied" as const : "decided" as const,
  ]));
}

export type CashFlowTransferRead = Readonly<{
  /** Every canonical row the pairing read, by transaction id. */
  sides: ReadonlyMap<string, DatedCashFlowTransaction>;
  /** The rows the read was asked about: those dated in the range, or the pair's sides that Cash flow counts. */
  focus: readonly DatedCashFlowTransaction[];
  pairing: CashFlowTransferPairing;
  history: ReadonlyMap<string, CashFlowTransferPairHistory>;
}>;

/** Hydrate canonical rows by id, one bounded read per chunk. */
async function canonicalTransactionsById(reader: PGliteSpendingReader, knowledgeAt: number, ids: readonly string[]): Promise<DatedCashFlowTransaction[]> {
  const found: DatedCashFlowTransaction[] = [];
  for (let start = 0; start < ids.length; start += 2_048)
    found.push(...await canonicalTransactions(reader, knowledgeAt, { transactionIds: ids.slice(start, start + 2_048) }));
  return found;
}

/**
 * Pair transfers around the rows dated in a range, or around the two sides of
 * one pair. The Cash flow page and every transfer decision read through here,
 * so both see the same counterparts. Pairing compares each row's financial
 * date, `date`, so the counterparts load by that date too. Whether a row is
 * linked by evidence depends on its counterparts' counterparts, so rows two
 * windows beyond the focus are read, and so is the far side of every stored
 * link.
 */
export async function readPGliteCashFlowTransfers(
  reader: PGliteSpendingReader,
  knowledgeAt: number,
  scope: CashFlowRequest | CashFlowTransferPair,
): Promise<CashFlowTransferRead> {
  const focus = "startDate" in scope
    ? await canonicalTransactions(reader, knowledgeAt, scope)
    : await canonicalTransactionsById(reader, knowledgeAt, [scope.outflowTransactionId, scope.inflowTransactionId]);
  const sides = new Map(focus.map((side) => [side.transactionId, side]));
  if (focus.length > 0) {
    const dates = focus.map((side) => side.date).sort();
    const reach = 2 * CASH_FLOW_TRANSFER_WINDOW_DAYS;
    const from = shiftDate(dates[0]!, -reach);
    const through = shiftDate(dates.at(-1)!, reach);
    const nearby = (await currentTransactionIdsByFinancialDate(reader, from, through)).filter((id) => !sides.has(id));
    for (const side of await canonicalTransactionsById(reader, knowledgeAt, nearby))
      if (side.date >= from && side.date <= through) sides.set(side.transactionId, side);
  }
  const stored = await readStoredCashFlowTransferLinks(reader, [...sides.keys()]);
  const farSides = [...new Set(stored.flatMap((link) => [link.outflowTransactionId, link.inflowTransactionId]))].filter((id) => !sides.has(id));
  for (const side of await canonicalTransactionsById(reader, knowledgeAt, farSides)) sides.set(side.transactionId, side);
  const history = await transferHistory(reader, [...sides.keys()]);
  return { sides, focus, pairing: pairCashFlowTransfers([...sides.values()], stored, history), history };
}

/** A row a search reads outside one period; `periodDate` is the date the period filter compares. */
export type CashFlowSearchRow = Omit<CashFlowReportTransaction, "transferLinkId"> & Readonly<{
  periodDate: string;
  /**
   * The row's stored link when it applies and is a pair. Evidence links are not read: they
   * join only internal-transfer Kinds and never change a row's class.
   */
  transferLinkId: string | null;
}>;

/**
 * Classify the canonical rows `transactionIds` names, in every period, the way
 * a period read classifies them, plus every Manual Account row. A stored link
 * applies or not by its two sides alone, so only the counterparts of those
 * links are read, never the rows around them.
 */
export async function readPGliteCashFlowSearchRows(
  reader: PGliteSpendingReader,
  knowledgeAt: number,
  transactionIds: readonly string[],
): Promise<CashFlowSearchRow[]> {
  const stored = await readStoredCashFlowTransferLinks(reader, transactionIds);
  const wanted = new Set(transactionIds);
  const sideIds = [...new Set([...transactionIds, ...stored.flatMap((link) => [link.outflowTransactionId, link.inflowTransactionId])])];
  const sides = new Map((await canonicalTransactionsById(reader, knowledgeAt, sideIds)).map((side) => [side.transactionId, side]));
  const linkOf = new Map<string, { linkId: string; counterpart: string }>();
  for (const link of stored) {
    if (cashFlowTransferSuspension(link, sides) !== null) continue;
    const linkId = transferLinkId(link);
    linkOf.set(link.outflowTransactionId, { linkId, counterpart: link.inflowTransactionId });
    linkOf.set(link.inflowTransactionId, { linkId, counterpart: link.outflowTransactionId });
  }
  const focus = [...sides.values()].filter((side) => wanted.has(side.transactionId));
  const factsOf = await canonicalFacts(reader, knowledgeAt, focus.map((side) => side.spending));
  const canonical = focus.map(({ effectiveOn, spending, ...side }): CashFlowSearchRow => {
    const details = canonicalDetails(spending, side.date, factsOf.get(side.transactionId));
    const link = linkOf.get(side.transactionId);
    const counterpart = link ? sides.get(link.counterpart) : undefined;
    const linked = counterpart ? linkedCashFlow(side, counterpart) : null;
    return {
      ...side,
      details,
      periodDate: effectiveOn,
      cashFlow: linked?.cashFlow ?? side.cashFlow,
      transferLinkId: linked?.paired ? link!.linkId : null,
    };
  });
  const manual = (await manualTransactions(reader, { startDate: FIRST_DATE, endDate: LAST_DATE }))
    .map((row) => ({ ...row, periodDate: row.date, transferLinkId: null }));
  return [...canonical, ...manual];
}

/**
 * Classify every transaction dated from `startDate` through `endDate`, both
 * inclusive. `details: false` is for a caller that reads only the totals: the
 * rows then carry no counterparty, note, time or Spending purchase facts.
 */
export async function readPGliteCashFlow(
  reader: PGliteSpendingReader,
  request: CashFlowRequest,
  options: Readonly<{ details?: boolean }> = {},
): Promise<CashFlowReport> {
  const { startDate, endDate } = request;
  if (!ISO_DATE.test(startDate) || !ISO_DATE.test(endDate) || startDate > endDate)
    throw new Error("Cash flow needs an ISO start date on or before its end date.");
  const knowledgeAt = await readKnowledgePoint(reader);
  const { sides, focus, pairing, history } = await readPGliteCashFlowTransfers(reader, knowledgeAt, request);
  const shown = new Set(focus.map((side) => side.transactionId));
  const touches = (pair: CashFlowTransferPair) => shown.has(pair.outflowTransactionId) || shown.has(pair.inflowTransactionId);
  const transfers = {
    links: pairing.links.filter(touches),
    suspended: pairing.suspended.filter(touches),
    candidates: pairing.candidates.filter(touches),
  };
  const linkOf = new Map(transfers.links.flatMap((link) => [
    [link.outflowTransactionId, { linkId: link.linkId, counterpart: link.inflowTransactionId }],
    [link.inflowTransactionId, { linkId: link.linkId, counterpart: link.outflowTransactionId }],
  ] as const));
  const sideIds = [...new Set([...transfers.links, ...transfers.suspended, ...transfers.candidates]
    .flatMap((pair) => [pair.outflowTransactionId, pair.inflowTransactionId]))].filter((id) => sides.has(id));
  const farSides = sideIds.filter((id) => !shown.has(id)).map((id) => sides.get(id)!);
  // Only the rows in the range and the transfer sides are shown, so only they read their details.
  const factsOf = options.details === false
    ? new Map<string, CanonicalFacts>()
    : await canonicalFacts(reader, knowledgeAt, [...focus, ...farSides].map((side) => side.spending));
  const listRow = ({ effectiveOn: _effectiveOn, spending, ...side }: DatedCashFlowTransaction): CashFlowReportTransaction => {
    const details = canonicalDetails(spending, side.date, factsOf.get(side.transactionId));
    const link = linkOf.get(side.transactionId);
    if (!link) return { ...side, details, transferLinkId: null };
    const counterpart = sides.get(link.counterpart);
    const linked = counterpart ? linkedCashFlow(side, counterpart) : null;
    return { ...side, details, cashFlow: linked?.cashFlow ?? side.cashFlow, transferLinkId: linked?.paired ? link.linkId : null };
  };
  const canonical = focus.map(listRow);
  const transferSides = sideIds.map((id) => {
    const side = sides.get(id)!;
    return { ...listRow(side), ownCashFlow: side.cashFlow };
  });
  const deniedPairs = [...history]
    .filter(([linkId, decided]) => {
      const [outflowTransactionId = "", inflowTransactionId = ""] = linkId.split("/");
      return decided === "denied" && touches({ outflowTransactionId, inflowTransactionId });
    })
    .map(([linkId]) => linkId)
    .sort();
  const manual = (await manualTransactions(reader, request)).map((row) => ({ ...row, transferLinkId: null }));
  const transactions = [...canonical, ...manual]
    .sort((left, right) => left.date.localeCompare(right.date) || left.transactionId.localeCompare(right.transactionId));
  return {
    policy: CASH_FLOW_INCLUSION_POLICY, knowledgeAt, startDate, endDate, transactions, totals: cashFlowTotals(transactions),
    transfers, transferSides, deniedPairs,
  };
}
