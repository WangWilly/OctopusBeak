import { compareExact, moneyTotals, type ExactAmount, type MoneyTotal } from "../shared-money/exact-money.ts";
import { MAX_CATEGORIZATION_TARGETS } from "../financial/page-actions.ts";
import type { SpendingClassifyQueueItem } from "./model.ts";

/**
 * Pure views over the classification inbox's queue: the by-time and
 * by-merchant orders, the search filter, and the purchase set each apply
 * scope names. A merchant key groups rows for display only; it is never
 * stored and never becomes a categorization rule (User categorization scope).
 */

export type ClassifyMerchantGroup = Readonly<{
  key: string;
  /** The group's most common title. */
  displayName: string | null;
  count: number;
  totals: readonly MoneyTotal[];
  /** Newest first, as byTime orders them. */
  purchaseIds: readonly string[];
}>;

export type ClassifyApplyScope =
  | Readonly<{ kind: "one"; purchaseId: string }>
  | Readonly<{ kind: "merchant"; key: string }>
  | Readonly<{ kind: "search"; query: string }>;

/** The ids one action carries, newest first, and how many the cap left for another action. */
export type ClassifyApplyTargets = Readonly<{ purchaseIds: readonly string[]; overflow: number }>;

/** Payment channels that prefix the merchant in bank descriptions, such as 「LINE Pay－全聯福利中心」. */
const CHANNEL_PREFIX = /^(?:line ?pay|街口(?:支付)?|全支付|px ?pay|apple ?pay|google ?pay|samsung ?pay|悠遊付|台灣 ?pay|pi ?拍錢包|歐付寶|icash ?pay|paypal)[\s\-*:/_|]+/u;

/** Chains whose bank text and invoice seller name differ: the first prefix that matches names the group. */
const CHAIN_ALIASES: readonly (readonly [string, readonly string[]])[] = [
  ["全聯", ["全聯"]],
  ["7-eleven", ["統一超商", "7-eleven", "7-11", "seven-eleven"]],
  ["全家", ["全家便利", "familymart"]],
  ["星巴克", ["統一星巴克", "星巴克", "starbucks"]],
  ["家樂福", ["家樂福", "carrefour"]],
  ["好市多", ["好市多", "costco"]],
  ["萊爾富", ["萊爾富", "hi-life"]],
];

function normalizedText(value: string | null): string {
  return (value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

/** Applies a rewrite only when it leaves something behind. */
function unlessEmpty(value: string, rewritten: string): string {
  const trimmed = rewritten.trim();
  return trimmed === "" ? value : trimmed;
}

/** The chain a text names exactly, such as 「7-11」, or null when it says more or names none. */
function chainNamedBy(text: string): string | null {
  return CHAIN_ALIASES.find(([name, prefixes]) => name === text || prefixes.includes(text))?.[0] ?? null;
}

/**
 * The grouping key of a purchase title: NFKC-folded (full-width to
 * half-width) and lower-cased, without a payment-channel prefix, a company
 * form, or a branch or store number, and with known chains named once.
 * A deposit description 「摘要 · 備註」 keys on its 備註, the payee; its
 * 摘要 only names the transaction type, such as 金融卡消費 or 全國繳費.
 * A rule never cuts text it cannot name as a branch: two merchants wrongly
 * merged get one category, two keys for one merchant only cost a row.
 * An empty title has the empty key, which groups nothing.
 */
export function merchantKey(title: string | null): string {
  const text = normalizedText(title);
  const parts = text.split(/\s*[·・]\s*/u).filter((part) => part !== "");
  if (parts.length < 2) return payeeKey(text);
  const note = parts.at(-1)!;
  // A 備註 of only a reference number names no payee; the whole text keeps the purchase apart.
  return /\p{L}/u.test(note) ? payeeKey(note) : parts.join(" · ");
}

function payeeKey(text: string): string {
  let key = text;
  for (let previous = ""; previous !== key;) {
    previous = key;
    key = unlessEmpty(key, key.replace(CHANNEL_PREFIX, ""));
  }
  key = unlessEmpty(key, key.replace(/(?:股份)?有限公司.*$/u, ""));
  for (const [name, prefixes] of CHAIN_ALIASES) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) return name;
  }
  // 「鼎泰豐－信義店」, 「7-eleven 松江門市」: a separated trailing branch name.
  key = unlessEmpty(key, key.replace(/[\s\-–—_*#/|(]+[\p{Script=Han}\p{N}a-z]{1,10}(?:門市|分店|店|營業所|分公司)\)?$/u, ""));
  // 「全聯福利中心松江店」: a branch glued to a store-type word.
  key = unlessEmpty(key, key.replace(/^(.+?(?:中心|超商|商店|超市|藥局|藥妝|量販|百貨|商場|賣場))\p{Script=Han}{1,6}(?:門市|分店|店)$/u, "$1"));
  // 「cafe 123」, 「shop #0042」: a trailing store number.
  return unlessEmpty(key, key.replace(/(?<=\D)[\s#\-_]*(?:no\.?\s*)?\d+$/u, ""));
}

/** Newest first: by date, then by the recorded time of day, a date-only purchase after the timed ones that day. */
function compareTime(left: SpendingClassifyQueueItem, right: SpendingClassifyQueueItem): number {
  if (left.date !== right.date) return left.date < right.date ? 1 : -1;
  const leftTime = left.details.time ?? "", rightTime = right.details.time ?? "";
  if (leftTime !== rightTime) return leftTime < rightTime ? 1 : -1;
  return left.purchaseId < right.purchaseId ? -1 : left.purchaseId > right.purchaseId ? 1 : 0;
}

/** One row per purchase, newest first. */
export function byTime(items: readonly SpendingClassifyQueueItem[]): readonly SpendingClassifyQueueItem[] {
  return Object.freeze([...items].sort(compareTime));
}

function groupKey(item: SpendingClassifyQueueItem): string {
  const key = merchantKey(item.title);
  // A purchase without a title shares a merchant with no other purchase.
  return key === "" ? `purchase:${item.purchaseId}` : key;
}

function mostCommonTitle(items: readonly SpendingClassifyQueueItem[]): string | null {
  const counts = new Map<string, number>();
  for (const item of items) {
    const title = item.title?.trim();
    if (title) counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  const [best] = [...counts.entries()].sort(([leftTitle, leftCount], [rightTitle, rightCount]) =>
    rightCount - leftCount || leftTitle.length - rightTitle.length || (leftTitle < rightTitle ? -1 : 1));
  return best?.[0] ?? null;
}

/** One row per merchant key, the group with the latest purchase first; its members newest first. */
export function byMerchant(items: readonly SpendingClassifyQueueItem[]): readonly ClassifyMerchantGroup[] {
  const members = new Map<string, SpendingClassifyQueueItem[]>();
  // Walking newest first, groups enter the map in order of their latest purchase.
  for (const item of byTime(items)) {
    const key = groupKey(item);
    const list = members.get(key);
    if (list) list.push(item);
    else members.set(key, [item]);
  }
  const groups = [...members.entries()].map(([key, list]): ClassifyMerchantGroup => Object.freeze({
    key,
    displayName: mostCommonTitle(list),
    count: list.length,
    totals: moneyTotals(list.flatMap((item) => item.amount ? [item.amount] : [])),
    purchaseIds: Object.freeze(list.map((item) => item.purchaseId)),
  }));
  return Object.freeze(groups);
}

const SEARCH_AMOUNT = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/u;

function searchAmount(query: string): ExactAmount | null {
  if (!SEARCH_AMOUNT.test(query)) return null;
  const [whole = "", fraction = ""] = query.replaceAll(",", "").split(".");
  return { coefficient: BigInt(`${whole}${fraction}`).toString(), scale: fraction.length };
}

/**
 * Whether a row answers the search box: its title holds the text, the query
 * is exactly a chain's name and the row belongs to the chain (so 「7-11」
 * finds 統一超商), or its amount equals a numeric query. A query that says
 * more than a chain's name, such as a branch, matches by its text alone, so
 * 「apply to all results」 never reaches past what the user typed. A blank
 * query matches every row.
 */
export function matches(item: SpendingClassifyQueueItem, query: string): boolean {
  const text = normalizedText(query);
  if (text === "") return true;
  if (normalizedText(item.title).includes(text)) return true;
  const chain = chainNamedBy(text);
  if (chain !== null && merchantKey(item.title) === chain) return true;
  const amount = searchAmount(text);
  return amount !== null && item.amount !== null && compareExact(item.amount, amount) === 0;
}

/** At most one action's worth of ids, in the order given, and how many are left for another. */
export function capped(purchaseIds: readonly string[]): ClassifyApplyTargets {
  return Object.freeze({
    purchaseIds: Object.freeze(purchaseIds.slice(0, MAX_CATEGORIZATION_TARGETS)),
    overflow: Math.max(0, purchaseIds.length - MAX_CATEGORIZATION_TARGETS),
  });
}

/**
 * The purchases one apply names, from the queue as it stands. A purchase no
 * longer queued resolves to nothing, and so does a blank search: 「apply to
 * all results」 needs a search to name its results.
 */
export function applyTargets(items: readonly SpendingClassifyQueueItem[], scope: ClassifyApplyScope): ClassifyApplyTargets {
  switch (scope.kind) {
    case "one":
      return capped(items.some((item) => item.purchaseId === scope.purchaseId) ? [scope.purchaseId] : []);
    case "merchant":
      return capped(byMerchant(items).find((group) => group.key === scope.key)?.purchaseIds ?? []);
    case "search":
      if (normalizedText(scope.query) === "") return capped([]);
      return capped(byTime(items).filter((item) => matches(item, scope.query)).map((item) => item.purchaseId));
  }
}
