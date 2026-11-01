import { isPersonalCategoryCode, type PersonalCategoryCode } from "../../ledger/canonical/personal-category-codes.ts";
import { addExact, negateExact, type ExactAmount } from "../shared-money/exact-money.ts";

/**
 * Manual Assets (ADR 0087): what a person enters by hand, kept outside
 * canonical financial data. This module has no runtime imports beyond pure
 * helpers, so the renderer validates a form with the same parser the worker
 * applies at the RPC boundary.
 */

export const MANUAL_ASSET_CATEGORY_IDS = ["cash", "house", "insurance", "vehicle", "labor_pension", "other"] as const;
export type ManualAssetCategory = (typeof MANUAL_ASSET_CATEGORY_IDS)[number];

export const MANUAL_VALUATION_SOURCE_IDS = [
  "counted",
  "own_estimate",
  "actual_price_registration",
  "appraisal_report",
  "purchase_price",
  "insurer_statement",
  "used_vehicle_quote",
  "bli_statement",
  "market_quote",
] as const;
export type ManualValuationSource = (typeof MANUAL_VALUATION_SOURCE_IDS)[number];

export type ManualAssetCategoryRule = Readonly<{
  /** The valuation sources a person may choose for this category, in menu order. */
  sources: readonly ManualValuationSource[];
  /** A valuation older than this many months shows as stale; `null` never goes stale. */
  freshnessMonths: number | null;
  /** Only a Manual Account takes person-entered transactions. */
  recordsTransactions: boolean;
}>;

export const MANUAL_ASSET_CATEGORIES: Readonly<Record<ManualAssetCategory, ManualAssetCategoryRule>> = Object.freeze({
  cash: { sources: ["counted"], freshnessMonths: null, recordsTransactions: true },
  house: {
    sources: ["own_estimate", "actual_price_registration", "appraisal_report", "purchase_price"],
    freshnessMonths: 12,
    recordsTransactions: false,
  },
  insurance: { sources: ["insurer_statement", "own_estimate"], freshnessMonths: 12, recordsTransactions: false },
  vehicle: { sources: ["used_vehicle_quote", "own_estimate", "purchase_price"], freshnessMonths: 6, recordsTransactions: false },
  labor_pension: { sources: ["bli_statement", "own_estimate"], freshnessMonths: 12, recordsTransactions: false },
  other: { sources: ["own_estimate", "market_quote", "purchase_price"], freshnessMonths: 12, recordsTransactions: false },
});

/** An exact non-negative decimal lexeme such as `"1234.50"`, never a number. */
export type ManualAmount = string;
/** A local calendar date, `YYYY-MM-DD`. */
export type ManualDate = string;

export type ManualAsset = Readonly<{
  id: string;
  category: ManualAssetCategory;
  name: string;
  currency: string;
  /** From this date the asset counts toward nothing; its history before stays. */
  endedOn: ManualDate | null;
  createdAt: string;
}>;

/** One dated value. For a Manual Account, a `counted` valuation is the end-of-day balance of its date. */
export type ManualValuation = Readonly<{
  valuedOn: ManualDate;
  amount: ManualAmount;
  source: ManualValuationSource;
  note: string | null;
}>;

export type ManualTransactionKind = "purchase" | "receipt" | "transfer";

type TransactionCore = Readonly<{
  occurredOn: ManualDate;
  /** Always positive; the kind and direction give the sign. */
  amount: ManualAmount;
  note: string | null;
}>;

export type ManualTransactionDetail =
  | Readonly<{ kind: "purchase"; personalCategory: PersonalCategoryCode | null }>
  | Readonly<{ kind: "receipt" }>
  | Readonly<{ kind: "transfer"; direction: "out" | "in"; transferId: string; counterpartAccountId: string }>;

export type ManualTransaction = Readonly<{ id: string; accountId: string }> & TransactionCore & ManualTransactionDetail;

/** A transaction as a person enters it on one Manual Account; a transfer names the other side. */
export type ManualTransactionInput = TransactionCore & (
  | Readonly<{ kind: "purchase"; personalCategory: PersonalCategoryCode | null }>
  | Readonly<{ kind: "receipt" }>
  | Readonly<{ kind: "transfer"; direction: "out" | "in"; counterpartAccountId: string }>
);

export type ManualAssetCommand =
  | Readonly<{
    kind: "createAsset";
    category: ManualAssetCategory;
    name: string;
    currency: string;
    firstValuation: ManualValuation;
  }>
  | Readonly<{ kind: "renameAsset"; assetId: string; name: string }>
  | Readonly<{ kind: "endAsset"; assetId: string; endedOn: ManualDate | null }>
  | Readonly<{ kind: "deleteAsset"; assetId: string }>
  | Readonly<{ kind: "upsertValuation"; assetId: string; valuation: ManualValuation }>
  | Readonly<{ kind: "deleteValuation"; assetId: string; valuedOn: ManualDate }>
  | Readonly<{ kind: "addTransaction"; accountId: string; transaction: ManualTransactionInput }>
  | Readonly<{ kind: "updateTransaction"; transactionId: string; transaction: ManualTransactionInput }>
  | Readonly<{ kind: "deleteTransaction"; transactionId: string }>
  | Readonly<{ kind: "deleteAllManualAssets" }>;

/** Which rule refused a command; the renderer turns each into a message. */
export const MANUAL_ASSET_REJECTION_CODES = [
  "invalid_command",
  "invalid_name",
  "invalid_currency",
  "invalid_amount",
  "amount_not_positive",
  "invalid_date",
  "invalid_note",
  "invalid_choice",
  "source_not_offered",
  "category_only_for_purchase",
  "future_date",
  "asset_not_found",
  "valuation_not_found",
  "transaction_not_found",
  "not_manual_account",
  "transfer_same_account",
  "transfer_currency_mismatch",
  "dated_after_end",
  "ends_before_existing_row",
  "last_valuation",
] as const;
export type ManualAssetRejectionCode = (typeof MANUAL_ASSET_REJECTION_CODES)[number];

/** A refused command is an expected outcome, returned rather than thrown so its code crosses every IPC hop. */
export type ManualAssetCommandResult =
  | Readonly<{ ok: true; revision: number; assetId?: string; transactionId?: string }>
  | Readonly<{ ok: false; code: ManualAssetRejectionCode }>;

export class ManualAssetRejected extends Error {
  readonly code: ManualAssetRejectionCode;
  constructor(code: ManualAssetRejectionCode, message: string) {
    super(message);
    this.name = "ManualAssetRejected";
    this.code = code;
  }
}

export const rejectManual = (code: ManualAssetRejectionCode, message: string): never => {
  throw new ManualAssetRejected(code, message);
};
const reject = rejectManual;

const AMOUNT = /^\d+(?:\.\d+)?$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_TEXT = 200;

export function isManualDate(value: unknown): value is ManualDate {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function record(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return reject("invalid_command", `${field} is not an object`);
  return value as Readonly<Record<string, unknown>>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") return reject("invalid_name", `${field} is missing`);
  if (value.length > MAX_TEXT) return reject("invalid_name", `${field} is longer than ${MAX_TEXT} characters`);
  return value.trim();
}

function optionalNote(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return reject("invalid_note", "note is not text");
  if (value.length > MAX_TEXT) return reject("invalid_note", `note is longer than ${MAX_TEXT} characters`);
  return value.trim() === "" ? null : value.trim();
}

function id(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "" || value.length > 64) return reject("invalid_command", `${field} is not an id`);
  return value;
}

function date(value: unknown, field: string): ManualDate {
  return isManualDate(value) ? value : reject("invalid_date", `${field} is not a YYYY-MM-DD date`);
}

function amount(value: unknown, field: string, positive: boolean): ManualAmount {
  if (typeof value !== "string" || !AMOUNT.test(value)) return reject("invalid_amount", `${field} is not an exact non-negative decimal`);
  if (positive && /^0+(?:\.0+)?$/u.test(value)) return reject("amount_not_positive", `${field} is not positive`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  return allowed.includes(value as T) ? value as T : reject("invalid_choice", `${field} is not one of ${allowed.join(", ")}`);
}

function valuation(value: unknown): ManualValuation {
  const input = record(value, "valuation");
  return {
    valuedOn: date(input.valuedOn, "valuedOn"),
    amount: amount(input.amount, "valuation amount", false),
    source: oneOf(input.source, MANUAL_VALUATION_SOURCE_IDS, "valuation source"),
    note: optionalNote(input.note),
  };
}

function transactionInput(value: unknown): ManualTransactionInput {
  const input = record(value, "transaction");
  const core = {
    occurredOn: date(input.occurredOn, "occurredOn"),
    amount: amount(input.amount, "transaction amount", true),
    note: optionalNote(input.note),
  };
  const kind = oneOf(input.kind, ["purchase", "receipt", "transfer"] as const, "transaction kind");
  if (kind === "purchase") {
    const category = input.personalCategory ?? null;
    if (category !== null && !isPersonalCategoryCode(category)) reject("invalid_choice", "personalCategory is not a Personal Category code");
    return { ...core, kind, personalCategory: category as PersonalCategoryCode | null };
  }
  if (input.personalCategory !== undefined && input.personalCategory !== null)
    reject("category_only_for_purchase", "only a purchase takes a Personal Category");
  if (kind === "receipt") return { ...core, kind };
  return {
    ...core,
    kind,
    direction: oneOf(input.direction, ["out", "in"] as const, "transfer direction"),
    counterpartAccountId: id(input.counterpartAccountId, "counterpartAccountId"),
  };
}

/** Rejects a valuation source the category does not offer. */
export function assertSourceAllowed(category: ManualAssetCategory, source: ManualValuationSource): void {
  if (!MANUAL_ASSET_CATEGORIES[category].sources.includes(source))
    reject("source_not_offered", `valuation source ${source} is not offered for ${category}`);
}

/**
 * The shape rules of a command, applied at the RPC boundary before it reaches
 * the store. Rules that depend on stored rows (an asset's category or end
 * date, a transfer's counterpart) are checked when the command runs.
 */
export function parseManualAssetCommand(value: unknown): ManualAssetCommand {
  const input = record(value, "command");
  switch (input.kind) {
    case "createAsset": {
      const category = oneOf(input.category, MANUAL_ASSET_CATEGORY_IDS, "category");
      const firstValuation = valuation(input.firstValuation);
      assertSourceAllowed(category, firstValuation.source);
      const currency = typeof input.currency === "string" && CURRENCY.test(input.currency)
        ? input.currency
        : reject("invalid_currency", "currency is not an ISO 4217 code");
      return { kind: "createAsset", category, name: text(input.name, "name"), currency, firstValuation };
    }
    case "renameAsset":
      return { kind: "renameAsset", assetId: id(input.assetId, "assetId"), name: text(input.name, "name") };
    case "endAsset":
      return {
        kind: "endAsset",
        assetId: id(input.assetId, "assetId"),
        endedOn: input.endedOn === null ? null : date(input.endedOn, "endedOn"),
      };
    case "deleteAsset":
      return { kind: "deleteAsset", assetId: id(input.assetId, "assetId") };
    case "upsertValuation":
      return { kind: "upsertValuation", assetId: id(input.assetId, "assetId"), valuation: valuation(input.valuation) };
    case "deleteValuation":
      return { kind: "deleteValuation", assetId: id(input.assetId, "assetId"), valuedOn: date(input.valuedOn, "valuedOn") };
    case "addTransaction":
      return { kind: "addTransaction", accountId: id(input.accountId, "accountId"), transaction: transactionInput(input.transaction) };
    case "updateTransaction":
      return {
        kind: "updateTransaction",
        transactionId: id(input.transactionId, "transactionId"),
        transaction: transactionInput(input.transaction),
      };
    case "deleteTransaction":
      return { kind: "deleteTransaction", transactionId: id(input.transactionId, "transactionId") };
    case "deleteAllManualAssets":
      return { kind: "deleteAllManualAssets" };
    default:
      return reject("invalid_command", "command kind is unknown");
  }
}

/** Rejects a command dated after `today`: a valuation, a transaction, or an end date. */
export function assertNotFuture(command: ManualAssetCommand, today: ManualDate): void {
  const dates = command.kind === "createAsset" ? [command.firstValuation.valuedOn]
    : command.kind === "upsertValuation" ? [command.valuation.valuedOn]
    : command.kind === "endAsset" ? (command.endedOn === null ? [] : [command.endedOn])
    : command.kind === "addTransaction" || command.kind === "updateTransaction" ? [command.transaction.occurredOn]
    : [];
  if (dates.some((day) => day > today)) reject("future_date", "the date is after today");
}

export function exactFromManualAmount(value: ManualAmount): ExactAmount {
  const [whole, fraction = ""] = value.split(".");
  return { coefficient: BigInt(`${whole}${fraction}`).toString(), scale: fraction.length };
}

/** The signed effect of one transaction on its account's balance. */
export function signedTransactionAmount(transaction: Pick<ManualTransaction, "amount"> & ManualTransactionDetail): ExactAmount {
  const exact = exactFromManualAmount(transaction.amount);
  const inflow = transaction.kind === "receipt" || (transaction.kind === "transfer" && transaction.direction === "in");
  return inflow ? exact : negateExact(exact);
}

export type ManualBalancePoint = Readonly<{ date: ManualDate; exact: ExactAmount }>;

/**
 * The asset's value on every date it changed, oldest first. A valuation sets
 * the value on its date. On a Manual Account the latest count on or before a
 * date is that day's closing balance, so only transactions dated after it
 * move the balance; a transaction before the first count has no balance to
 * move. A gap between a count and the recorded transactions stays a gap.
 */
export function manualBalancePoints(
  category: ManualAssetCategory,
  valuations: readonly Pick<ManualValuation, "valuedOn" | "amount">[],
  transactions: readonly (Pick<ManualTransaction, "occurredOn" | "amount"> & ManualTransactionDetail)[],
): ManualBalancePoint[] {
  const counts = [...valuations].sort((left, right) => left.valuedOn.localeCompare(right.valuedOn));
  if (!MANUAL_ASSET_CATEGORIES[category].recordsTransactions)
    return counts.map((entry) => ({ date: entry.valuedOn, exact: exactFromManualAmount(entry.amount) }));
  const first = counts[0];
  if (!first) return [];
  const dates = [...new Set([
    ...counts.map((entry) => entry.valuedOn),
    ...transactions.map((entry) => entry.occurredOn).filter((day) => day > first.valuedOn),
  ])].sort();
  return dates.map((day) => {
    const count = counts.findLast((entry) => entry.valuedOn <= day)!;
    const exact = transactions
      .filter((entry) => entry.occurredOn > count.valuedOn && entry.occurredOn <= day)
      .reduce((sum, entry) => addExact(sum, signedTransactionAmount(entry)), exactFromManualAmount(count.amount));
    return { date: day, exact };
  });
}

/** Whole calendar months from `from` to `to`, counting a month only once its day is reached. */
export function monthsBetween(from: ManualDate, to: ManualDate): number {
  const [fromYear, fromMonth, fromDay] = from.split("-").map(Number) as [number, number, number];
  const [toYear, toMonth, toDay] = to.split("-").map(Number) as [number, number, number];
  const months = (toYear - fromYear) * 12 + (toMonth - fromMonth) - (toDay < fromDay ? 1 : 0);
  return Math.max(0, months);
}

/** A valuation older than the category's freshness period; a Manual Account's count never goes stale. */
export function manualValuationStale(category: ManualAssetCategory, valuedOn: ManualDate, today: ManualDate): boolean {
  const freshness = MANUAL_ASSET_CATEGORIES[category].freshnessMonths;
  return freshness !== null && monthsBetween(valuedOn, today) >= freshness;
}
