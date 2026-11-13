import type { PersonalCategoryCode } from "./personal-category-codes.ts";
import { TRANSACTION_KIND_CODES, type TransactionKindCode } from "./transaction-taxonomy.ts";
import { spendingCategoryGroup, type SpendingCategoryGroup } from "../../lib/spending/category-groups.ts";
import {
  addExact,
  normalizeCurrency,
  normalizeExact,
  subtractExact,
  type ExactAmount,
  type ExactMoney,
} from "../../lib/shared-money/exact-money.ts";

/**
 * Cash flow's Financial report inclusion (PRD #456): every canonical and
 * Manual Account transaction gets exactly one cash-flow class, decided by its
 * Transaction Kind and direction alone. Totals stay per currency.
 */
export const CASH_FLOW_INCLUSION_POLICY = Object.freeze({
  id: "cash-flow-by-kind",
  version: "v1",
} as const);

export type CashFlowInflowGroup =
  | Extract<TransactionKindCode, "income" | `income.${string}` | "interest.earned">
  /** An external or unspecified transfer in: 其他轉入. */
  | "transfers_in"
  | "other";

/** A Spending category group, null for Unclassified, or `transfers_out` for an external or unspecified transfer: 轉帳支出. */
export type CashFlowOutflowGroup = SpendingCategoryGroup | "transfers_out" | null;

export type CashFlowNotCountedReason =
  | "transfer"
  | "card_payment"
  | "loan_principal"
  | "loan_disbursement"
  | "investment_move"
  | "cash_withdrawal"
  | "cash_deposit"
  | "cash_movement";

/** What one Kind decides for one direction. A refund's categories are resolved later. */
export type CashFlowRule =
  | Readonly<{ class: "inflow"; group: CashFlowInflowGroup }>
  /** `by_category` groups by Spending category group; transfer Kinds take no Personal Category, so they have their own group. */
  | Readonly<{ class: "outflow"; group: "by_category" | "transfers_out" }>
  | Readonly<{ class: "refund" }>
  | Readonly<{ class: "not_counted"; reason: CashFlowNotCountedReason }>
  | Readonly<{ class: "unresolved" }>;

export type CashFlowKindInclusion = Readonly<{ inflow: CashFlowRule; outflow: CashFlowRule }>;

const OUTFLOW: CashFlowRule = { class: "outflow", group: "by_category" };
const REFUND: CashFlowRule = { class: "refund" };
const UNRESOLVED: CashFlowRule = { class: "unresolved" };
const both = (rule: CashFlowRule): CashFlowKindInclusion => ({ inflow: rule, outflow: rule });
const notCounted = (reason: CashFlowNotCountedReason) => both({ class: "not_counted", reason });
// A Kind that contradicts its direction, such as an outflow `income`, leaves inclusion undecided.
const spending = { inflow: UNRESOLVED, outflow: OUTFLOW } as const;
const refunding = { inflow: REFUND, outflow: UNRESOLVED } as const;
const earning = (group: CashFlowInflowGroup): CashFlowKindInclusion => ({ inflow: { class: "inflow", group }, outflow: UNRESOLVED });
// A transfer that is not proven internal counts until a Cash-flow transfer link shows it stayed within the person's accounts.
const transferring: CashFlowKindInclusion = { inflow: { class: "inflow", group: "transfers_in" }, outflow: { class: "outflow", group: "transfers_out" } };

/**
 * The one table that maps every registered Kind to its inclusion. Typing it
 * as a Record over the registry makes a newly registered Kind fail to compile
 * until it is placed here.
 */
export const CASH_FLOW_KIND_INCLUSION: Readonly<Record<TransactionKindCode, CashFlowKindInclusion>> = Object.freeze({
  purchase: spending,
  transfer: transferring,
  "transfer.internal": notCounted("transfer"),
  "transfer.external": transferring,
  "transfer.investment_contribution": notCounted("investment_move"),
  "transfer.investment_withdrawal": notCounted("investment_move"),
  "transfer.security_position": notCounted("investment_move"),
  payment: spending,
  "payment.bill": spending,
  "payment.credit_card": notCounted("card_payment"),
  "payment.loan": notCounted("loan_principal"),
  cash: notCounted("cash_movement"),
  "cash.deposit": notCounted("cash_deposit"),
  "cash.withdrawal": notCounted("cash_withdrawal"),
  income: earning("income"),
  "income.employment": earning("income.employment"),
  "income.employment.salary": earning("income.employment.salary"),
  "income.employment.bonus": earning("income.employment.bonus"),
  "income.business": earning("income.business"),
  "income.pension": earning("income.pension"),
  "income.government_benefit": earning("income.government_benefit"),
  "income.rental": earning("income.rental"),
  "income.reward": earning("income.reward"),
  "income.dividend": earning("income.dividend"),
  "income.investment_distribution": earning("income.investment_distribution"),
  fee: spending,
  "fee.bank": spending,
  "fee.card": spending,
  "fee.loan": spending,
  "fee.investment": spending,
  // The parent alone does not say whether the interest was earned or charged.
  interest: both(UNRESOLVED),
  "interest.earned": earning("interest.earned"),
  "interest.charged": spending,
  tax: spending,
  "tax.payment": spending,
  "tax.refund": refunding,
  "tax.withholding": spending,
  refund: refunding,
  reversal: refunding,
  adjustment: both(UNRESOLVED),
  receipt: earning("other"),
  loan: { inflow: { class: "not_counted", reason: "loan_disbursement" }, outflow: { class: "not_counted", reason: "loan_principal" } },
  "loan.disbursement": notCounted("loan_disbursement"),
  investment: notCounted("investment_move"),
  "investment.trade": notCounted("investment_move"),
  "investment.trade.buy": notCounted("investment_move"),
  "investment.trade.sell": notCounted("investment_move"),
  "investment.trade.sell_short": notCounted("investment_move"),
  "investment.trade.buy_to_cover": notCounted("investment_move"),
  "investment.trade.reinvestment": notCounted("investment_move"),
  "investment.corporate_action": notCounted("investment_move"),
  "investment.corporate_action.split": notCounted("investment_move"),
  "investment.corporate_action.merger": notCounted("investment_move"),
  "investment.corporate_action.spin_off": notCounted("investment_move"),
  "investment.corporate_action.exercise": notCounted("investment_move"),
  "investment.corporate_action.assignment": notCounted("investment_move"),
  "investment.corporate_action.expiration": notCounted("investment_move"),
});

const REGISTERED_KINDS: ReadonlySet<string> = new Set(TRANSACTION_KIND_CODES);

function isRegisteredKind(code: string): code is TransactionKindCode {
  return REGISTERED_KINDS.has(code);
}

/**
 * How much a Kind proves about where the money went (ADR 0137):
 * - `evidence`: the Kind was proven, and it alone decides inclusion.
 * - `weak`: a canonical `transfer.external` or bare `transfer`. Keywords such
 *   as 跨行 or 匯款 assign it, and they also match a move between two of the
 *   person's own accounts at different banks.
 * - `fallback`: nothing proves the purpose: a card Kind read from direction
 *   alone because the description names none, or the `purchase` or
 *   `receipt` the bank rule ends on.
 * A Cash-flow transfer link may exclude a `weak` or `fallback` side, never an
 * `evidence` one.
 */
export type CashFlowKindBasis = "evidence" | "weak" | "fallback";

export type CashFlowKind = Readonly<{ code: string; basis: CashFlowKindBasis }>;

const WEAK_TRANSFER_KINDS: ReadonlySet<string> = new Set(["transfer", "transfer.external"]);

/** `evidenceKind` is what the Kind enrichment recorded, or null when it recorded none. */
export function canonicalCashFlowKind(code: string | null, evidenceKind: string | null): CashFlowKind | null {
  if (code === null) return null;
  if (evidenceKind === "direction" || (evidenceKind === "bank-rule" && (code === "purchase" || code === "receipt")))
    return { code, basis: "fallback" };
  return { code, basis: WEAK_TRANSFER_KINDS.has(code) ? "weak" : "evidence" };
}

/** Whether a Cash-flow transfer link may decide this side's inclusion. */
export function linkExcludable(kind: CashFlowKind | null): boolean {
  return kind !== null && kind.basis !== "evidence";
}

/** An unregistered or absent Kind leaves inclusion undecided. */
export function cashFlowRule(kind: string | null, direction: "inflow" | "outflow"): CashFlowRule {
  if (kind === null || !isRegisteredKind(kind)) return UNRESOLVED;
  return CASH_FLOW_KIND_INCLUSION[kind][direction];
}

/** One part of an outflow or refund; a null category is the Unclassified bucket, or the transfers-out group. */
export type CashFlowCategoryShare = Readonly<
  | { category: PersonalCategoryCode; group: SpendingCategoryGroup; amount: ExactAmount }
  | { category: null; group: null | "transfers_out"; amount: ExactAmount }
>;

export function categoryShare(category: PersonalCategoryCode | null, value: ExactAmount): CashFlowCategoryShare {
  const amount = { coefficient: value.coefficient, scale: value.scale };
  return category === null
    ? { category: null, group: null, amount }
    : { category, group: spendingCategoryGroup(category), amount };
}

export type CashFlowClass =
  | Readonly<{ class: "inflow"; group: CashFlowInflowGroup }>
  | Readonly<{ class: "outflow"; categories: readonly CashFlowCategoryShare[] }>
  /** Reduces the outflow of its categories. `refundOf` names the original it inherited them from. */
  | Readonly<{ class: "refund"; categories: readonly CashFlowCategoryShare[]; refundOf: string | null }>
  | Readonly<{ class: "not_counted"; reason: CashFlowNotCountedReason }>
  | Readonly<{ class: "unresolved" }>;

/** `categories` covers `amount`; a transfer out takes the whole amount into its own group. */
export function cashFlowClass(rule: CashFlowRule, amount: ExactAmount, categories: readonly CashFlowCategoryShare[], refundOf: string | null): CashFlowClass {
  if (rule.class === "outflow")
    return rule.group === "transfers_out"
      ? { class: "outflow", categories: [{ category: null, group: "transfers_out", amount: { coefficient: amount.coefficient, scale: amount.scale } }] }
      : { class: "outflow", categories };
  if (rule.class === "refund") return { class: "refund", categories, refundOf };
  return rule;
}

export type CashFlowTransaction = Readonly<{
  transactionId: string;
  /** `manual` marks a Manual Account transaction; its account id is the Manual Asset id. */
  source: "canonical" | "manual";
  accountId: string;
  /** The financial date: a card purchase's consume date, otherwise the effective date. */
  date: string;
  amount: ExactMoney;
  direction: "inflow" | "outflow";
  kind: CashFlowKind | null;
  cashFlow: CashFlowClass;
}>;

export type CashFlowAmount = Readonly<{ amount: ExactAmount; count: number }>;

export type CashFlowCurrencyTotals = Readonly<{
  currency: string;
  inflow: CashFlowAmount & Readonly<{ groups: readonly (CashFlowAmount & Readonly<{ group: CashFlowInflowGroup }>)[] }>;
  /** Net of refunds, so a group can fall below zero. */
  outflow: CashFlowAmount & Readonly<{ groups: readonly (CashFlowAmount & Readonly<{ group: CashFlowOutflowGroup }>)[] }>;
  unresolved: CashFlowAmount;
  notCounted: readonly (CashFlowAmount & Readonly<{ reason: CashFlowNotCountedReason }>)[];
}>;

type Bucket = { amount: ExactAmount; count: number };
const ZERO: ExactAmount = { coefficient: "0", scale: 0 };

function bump<K>(map: Map<K, Bucket>, key: K, amount: ExactAmount, sign: 1 | -1, counted = true): void {
  const prior = map.get(key) ?? { amount: ZERO, count: 0 };
  map.set(key, {
    amount: sign === 1 ? addExact(prior.amount, amount) : subtractExact(prior.amount, amount),
    count: prior.count + (counted ? 1 : 0),
  });
}

function read<K>(map: Map<K, Bucket>): readonly (CashFlowAmount & { key: K })[] {
  return [...map.entries()]
    .map(([key, bucket]) => ({ key, amount: normalizeExact(bucket.amount), count: bucket.count }))
    .sort((left, right) => String(left.key ?? "").localeCompare(String(right.key ?? "")));
}

function sum(entries: readonly CashFlowAmount[], count: number): CashFlowAmount {
  return { amount: normalizeExact(entries.reduce((total, entry) => addExact(total, entry.amount), ZERO)), count };
}

/** Per-currency totals; nothing is converted. */
export function cashFlowTotals(transactions: readonly CashFlowTransaction[]): readonly CashFlowCurrencyTotals[] {
  type Accumulator = {
    inflow: Map<CashFlowInflowGroup, Bucket>; inflowCount: number;
    outflow: Map<CashFlowOutflowGroup, Bucket>; outflowCount: number;
    unresolved: Map<"unresolved", Bucket>;
    notCounted: Map<CashFlowNotCountedReason, Bucket>;
  };
  const byCurrency = new Map<string, Accumulator>();
  for (const transaction of transactions) {
    const currency = normalizeCurrency(transaction.amount.currency);
    let totals = byCurrency.get(currency);
    if (!totals) {
      totals = { inflow: new Map(), inflowCount: 0, outflow: new Map(), outflowCount: 0, unresolved: new Map(), notCounted: new Map() };
      byCurrency.set(currency, totals);
    }
    const flow = transaction.cashFlow;
    switch (flow.class) {
      case "inflow":
        bump(totals.inflow, flow.group, transaction.amount, 1);
        totals.inflowCount += 1;
        break;
      case "outflow":
      case "refund": {
        const touched = new Set<CashFlowOutflowGroup>();
        for (const share of flow.categories) {
          bump(totals.outflow, share.group, share.amount, flow.class === "outflow" ? 1 : -1, !touched.has(share.group));
          touched.add(share.group);
        }
        totals.outflowCount += 1;
        break;
      }
      case "not_counted":
        bump(totals.notCounted, flow.reason, transaction.amount, 1);
        break;
      case "unresolved":
        bump(totals.unresolved, "unresolved", transaction.amount, 1);
        break;
    }
  }
  return [...byCurrency.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, totals]) => {
      const inflowGroups = read(totals.inflow).map(({ key, ...entry }) => ({ group: key, ...entry }));
      const outflowGroups = read(totals.outflow).map(({ key, ...entry }) => ({ group: key, ...entry }));
      const unresolved = read(totals.unresolved)[0];
      return {
        currency,
        inflow: { ...sum(inflowGroups, totals.inflowCount), groups: inflowGroups },
        outflow: { ...sum(outflowGroups, totals.outflowCount), groups: outflowGroups },
        unresolved: unresolved ? { amount: unresolved.amount, count: unresolved.count } : { amount: ZERO, count: 0 },
        notCounted: read(totals.notCounted).map(({ key, ...entry }) => ({ reason: key, ...entry })),
      };
    });
}
