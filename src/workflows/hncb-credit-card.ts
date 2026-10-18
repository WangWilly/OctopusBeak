import { createHash } from "node:crypto";
import type { Frame, Page } from "playwright";
import type {
  PreviewCard,
  PreviewCreditCollection,
  PreviewLocalDate,
  PreviewPurchase,
  PreviewStatement,
} from "../ledger/pglite/preview-financial-data.ts";
import type { PreviewProductAbsence } from "../lib/preview-sources/product-collection.ts";
import {
  currencyCode,
  decimalSum,
  exactDecimal,
  fail,
  isZeroDecimal,
  observedAt,
  taipeiDate,
} from "../lib/preview-sources/source-kit.ts";
import type { PreviewResponseObservation } from "../lib/preview-sources/workflow.ts";
import { parseHtmlTableMatrices } from "../lib/tabular-text.ts";

/** `CrdDetailInq` ranges: `0` is the current unbilled page, `1`-`3` the three latest statements. */
export const HNCB_CARD_RANGES = ["0", "1", "2", "3"] as const;
export type HncbCardRange = (typeof HNCB_CARD_RANGES)[number];

export type HncbCardPage = Readonly<{
  range: HncbCardRange;
  status: number;
  html: string;
  /** The response's HTTP `Date` header. */
  date: string | null;
  /** A native dialog the page raised while loading, if any. */
  dialog: string | null;
}>;

export type HncbCardPageReader = (range: HncbCardRange) => Promise<HncbCardPage>;

export type HncbCardCollectionOptions = Readonly<{
  now: string;
  observe?: (response: PreviewResponseObservation) => void;
}>;

export const HNCB_CARD_ACCOUNT_KEY = "credit-card:TWD";
const CURRENCY = "TWD";

type CardRow = Readonly<{
  consumedAt: PreviewLocalDate;
  postingDate: string | null;
  amount: string;
  currency: string;
  description: string | null;
  cardLast4: string | null;
}>;

type CurrentPage = Readonly<{ kind: "current"; unbilledAmount: string | null; creditLimit: string | null; rows: readonly CardRow[] }>;
type BillPage = Readonly<{
  kind: "bill";
  billingPeriod: string;
  statementAmount: string | null;
  paidAmount: string | null;
  minimumPayment: string | null;
  closingDate: string | null;
  dueDate: string | null;
  creditLimit: string | null;
  rows: readonly CardRow[];
}>;

/** all-set-tw's `isNoCreditCardMessage`: only a message that opens with a no-card statement. */
export function isHncbNoCreditCardMessage(value: string): boolean {
  const message = value.replace(/\s+/gu, "").replace(/^\d{4}[:：]/u, "");
  return /^(?:您)?(?:目前)?(?:(?:尚未|未|沒有|無)(?:持有|申辦|申請)?(?:本行)?信用卡|沒有(?:本行)?有效卡|非(?:本行)?(?:信用卡)?(?:持卡人|卡友)|非(?:本行)?信用卡客戶)(?=[，,。.!！；;]|$)/u.test(
    message,
  );
}

/** Each element's own text, so a no-card notice is read as a whole message. */
function textNodes(html: string): readonly string[] {
  return html
    .replace(/<(?:script|style)[^>]*>[\s\S]*?<\/(?:script|style)>/giu, " ")
    .split(/<[^>]+>/u)
    .map((part) => part.replace(/&nbsp;|&#160;/giu, " ").replace(/\s+/gu, " ").trim())
    .filter(Boolean);
}

const pageText = (html: string): string => textNodes(html).join(" ");

const AMOUNT_LEXEME = String.raw`([+-]?\s*[0-9][0-9,]*(?:\.[0-9]+)?)`;

function labelled(text: string, labels: readonly string[], field: string): string | null {
  for (const label of labels) {
    const match = new RegExp(`(?:${label})\\s*[：:]?\\s*(?:NT\\$|\\$|新[臺台]幣)?\\s*${AMOUNT_LEXEME}`, "u").exec(text);
    if (match) return exactDecimal(match[1]!.replace(/\s+/gu, ""), field);
  }
  return null;
}

const SOURCE_DATE = /^(\d{2,4})[/.-](\d{1,2})[/.-](\d{1,2})$/u;

function sourceDate(value: string): string | null {
  const match = SOURCE_DATE.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]) < 1900 ? Number(match[1]) + 1911 : Number(match[1]);
  const date = `${year}-${match[2]!.padStart(2, "0")}-${match[3]!.padStart(2, "0")}`;
  return new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date ? date : null;
}

function labelledDate(text: string, label: string): string | null {
  const match = new RegExp(`(?:${label})\\s*[：:]?\\s*([0-9]{2,4}[/.-][0-9]{1,2}[/.-][0-9]{1,2})`, "u").exec(text);
  return match ? sourceDate(match[1]!) : null;
}

function billingPeriod(text: string): string | null {
  const match = /帳單年月\s*[：:]?\s*(?:([0-9]{4})([0-9]{2})(?![0-9])|([0-9]{3,4})\s*[/年.-]\s*([0-9]{1,2}))/u.exec(text);
  if (!match) return null;
  const rawYear = Number(match[1] ?? match[3]);
  const year = rawYear < 1900 ? rawYear + 1911 : rawYear;
  const month = Number(match[2] ?? match[4]);
  if (month < 1 || month > 12) return fail("unexpected-response", "帳單年月 is not a month");
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * HNCB rows give `MM/DD` only. The year comes from the anchor month: a month
 * later than the anchor belongs to the previous year.
 */
function rowDate(value: string, anchor: string): string | null {
  const full = sourceDate(value);
  if (full) return full;
  const match = /^(\d{1,2})[/.-](\d{1,2})$/u.exec(value.trim());
  if (!match) return null;
  const [anchorYear, anchorMonth] = anchor.split("-").map(Number) as [number, number];
  const month = Number(match[1]);
  return sourceDate(`${month > anchorMonth ? anchorYear - 1 : anchorYear}/${match[1]}/${match[2]}`);
}

const cardLast4 = (value: string): string | null => /(?:\*{2,}|[xX]{2,}|[/-])\s*(\d{4})\s*$|^\s*(\d{4})\s*$/u.exec(value)?.slice(1).find(Boolean) ?? null;
const cardHeaderLast4 = (value: string): string | null => /\*{4,}\s*(\d{4})\b/u.exec(value)?.[1] ?? null;

type Columns = Readonly<{
  consume: number;
  post: number | null;
  description: number | null;
  card: number | null;
  amount: number;
  /** The fixed currency the amount column names, else the 幣別 column. */
  currency: Readonly<{ fixed: string } | { column: number } | { missing: true }>;
}>;

/** A header cell is short; a layout table's cell holding a whole nested table is not a header. */
const HEADER_CELL_MAX = 16;

function columnsOf(header: readonly string[]): Columns | null {
  const find = (pattern: RegExp) => {
    const index = header.findIndex((cell) => {
      const compact = cell.replace(/\s+/gu, "");
      return compact.length <= HEADER_CELL_MAX && pattern.test(compact);
    });
    return index < 0 ? null : index;
  };
  const consume = find(/消費日/u);
  if (consume === null) return null;
  const twdAmount = find(/(?:新)?[臺台]幣(?:入帳)?金額/u);
  const plainAmount = find(/^(?:消費|入帳)?金額$/u);
  const amount = twdAmount ?? plainAmount;
  if (amount === null) return fail("unexpected-response", "card table has no amount column");
  const currencyColumn = find(/^幣別$/u);
  return {
    consume,
    post: find(/入帳日/u),
    description: find(/說明|摘要|消費明細|商店/u),
    card: find(/卡號/u),
    amount,
    currency: twdAmount !== null ? { fixed: CURRENCY } : currencyColumn !== null ? { column: currencyColumn } : { missing: true },
  };
}

const SUMMARY_ROW = /小計|合計|總計|應繳總額|上期|本期/u;

function cardRows(html: string, anchor: string): readonly CardRow[] {
  const rows: CardRow[] = [];
  let tablesWithHeader = 0;
  for (const table of parseHtmlTableMatrices(html)) {
    const headerIndex = table.findIndex((row) => columnsOf(row) !== null);
    if (headerIndex < 0) continue;
    tablesWithHeader += 1;
    const columns = columnsOf(table[headerIndex]!)!;
    let currentCard: string | null = null;
    for (const raw of table.slice(headerIndex + 1)) {
      const row = raw.map((cell) => cell.replace(/\s+/gu, " ").trim());
      const consume = row[columns.consume] ?? "";
      const consumedOn = rowDate(consume, anchor);
      if (consumedOn === null) {
        const header = cardHeaderLast4(row.join(" "));
        if (header) {
          currentCard = header;
          continue;
        }
        if (SUMMARY_ROW.test(row.join(" ")) || row.every((cell) => cell === "" || cell === "-")) continue;
        return fail("unexpected-response", "card row has no consume date");
      }
      const amountCell = row[columns.amount] ?? "";
      const amount = exactDecimal(amountCell.replace(/\s+/gu, ""), "card row amount");
      if (isZeroDecimal(amount)) return fail("malformed-amount", "card row amount is zero");
      const currency = "fixed" in columns.currency
        ? columns.currency.fixed
        : "column" in columns.currency
          ? currencyCode(row[columns.currency.column], "card row 幣別", { NTD: "TWD", NT$: "TWD", 新臺幣: "TWD", 新台幣: "TWD", 台幣: "TWD", 臺幣: "TWD" })
          : fail("missing-currency", "card row amount names no currency");
      if (currency !== CURRENCY) return fail("unexpected-response", `card row billed in ${currency}, not ${CURRENCY}`);
      const postCell = columns.post === null ? "" : row[columns.post] ?? "";
      const postingDate = postCell === "" || postCell === "-" ? null : rowDate(postCell, anchor) ?? fail("unexpected-response", "card row 入帳日 is not a date");
      const cardCell = columns.card === null ? "" : row[columns.card] ?? "";
      rows.push({
        consumedAt: { precision: "day", value: consumedOn },
        postingDate,
        amount,
        currency,
        description: columns.description === null ? null : row[columns.description] || null,
        cardLast4: cardLast4(cardCell) ?? currentCard,
      });
    }
  }
  if (tablesWithHeader === 0) return fail("unexpected-response", "card page has no transaction table");
  return rows;
}

const PAGING = /下一頁|次頁|下頁|more\s*data/iu;

function checkedPage(page: HncbCardPage, options: HncbCardCollectionOptions): string {
  options.observe?.({ endpoint: `CrdDetailInq RANGE=${page.range}`, status: page.status, body: page.html });
  if (page.status !== 200) return fail("unexpected-response", `CrdDetailInq RANGE=${page.range} answered HTTP ${page.status}`);
  const text = pageText(page.html);
  if (PAGING.test(text)) return fail("incomplete-data", `CrdDetailInq RANGE=${page.range} has another page`);
  return text;
}

const NO_DATA = /查\s*無\s*(?:資\s*料|帳\s*單|符\s*合)|無\s*帳\s*單\s*資\s*料/u;

function currentPage(text: string, html: string, now: string): CurrentPage {
  return {
    kind: "current",
    unbilledAmount: labelled(text, ["本期未出帳(?:消費)?金額", "未出帳(?:消費)?(?:金額)?(?:合計|總額|總計)", "未出帳金額"], "未出帳金額"),
    creditLimit: labelled(text, ["信用額度"], "信用額度"),
    rows: NO_DATA.test(text) && !/消費日/u.test(text) ? [] : cardRows(html, taipeiDate(now).slice(0, 7)),
  };
}

function billPage(text: string, html: string): BillPage | null {
  const period = billingPeriod(text);
  if (period === null) {
    if (NO_DATA.test(text)) return null;
    return fail("unexpected-response", "statement page has no 帳單年月");
  }
  return {
    kind: "bill",
    billingPeriod: period,
    statementAmount: labelled(text, ["本期應繳總額", "本期應繳金額"], "本期應繳總額"),
    // A bare 已繳款金額 on a statement summary is the payment toward the
    // previous balance, already inside 本期應繳總額, so it is not this operand.
    paidAmount: labelled(text, ["本期已繳(?:款)?(?:金額|總額)"], "本期已繳金額"),
    minimumPayment: labelled(text, ["最低應繳金額"], "最低應繳金額"),
    closingDate: labelledDate(text, "帳單結帳日|結帳日"),
    dueDate: labelledDate(text, "繳款截止日"),
    creditLimit: labelled(text, ["信用額度"], "信用額度"),
    rows: cardRows(html, period),
  };
}

function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * A statement needs a cycle start, which HNCB does not print: it is the day
 * after the previous statement's closing date, so the oldest statement read
 * is not written.
 */
function statements(bills: readonly BillPage[]): readonly PreviewStatement[] {
  const ordered = [...bills].sort((left, right) => left.billingPeriod.localeCompare(right.billingPeriod));
  return ordered.flatMap((bill, index): PreviewStatement[] => {
    const previous = ordered[index - 1];
    if (!previous?.closingDate || !bill.closingDate || !bill.dueDate || bill.statementAmount === null) return [];
    return [{
      statementKey: bill.billingPeriod,
      cycleStart: nextDay(previous.closingDate),
      cycleEnd: bill.closingDate,
      closingDate: bill.closingDate,
      dueDate: bill.dueDate,
      amount: bill.statementAmount,
      currency: CURRENCY,
      minimumPayment: bill.minimumPayment,
      billingPeriod: bill.billingPeriod,
      paidAmount: bill.paidAmount,
      paid: null,
      noPaymentNeeded: null,
    }];
  });
}

function rowKey(row: CardRow, pending: boolean): string {
  const description = createHash("sha256").update(row.description ?? "").digest("hex").slice(0, 12);
  return [pending ? "pending" : "posted", row.cardLast4 ?? "-", row.consumedAt.value, row.postingDate ?? "-", row.amount, description].join(":");
}

/**
 * Collects HNCB's card portfolio as one NT-dollar credit account: the
 * current unbilled page and the three latest statements. The used credit is
 * the latest statement amount minus its paid amount plus the unbilled
 * amount; a missing operand fails the product.
 */
export async function collectHncbCreditCards(
  read: HncbCardPageReader,
  options: HncbCardCollectionOptions,
): Promise<PreviewCreditCollection | PreviewProductAbsence> {
  const first = await read("0");
  if (first.dialog !== null) {
    options.observe?.({ endpoint: "CrdDetailInq RANGE=0 dialog", status: first.status, body: first.dialog });
    if (isHncbNoCreditCardMessage(first.dialog)) return { absent: "not_held" };
    return fail("unexpected-response", "CrdDetailInq RANGE=0 raised a dialog");
  }
  const firstText = checkedPage(first, options);
  if (textNodes(first.html).some(isHncbNoCreditCardMessage)) return { absent: "not_held" };
  const current = currentPage(firstText, first.html, options.now);

  const bills: BillPage[] = [];
  for (const range of HNCB_CARD_RANGES.slice(1)) {
    const page = await read(range);
    if (page.dialog !== null) return fail("unexpected-response", `CrdDetailInq RANGE=${range} raised a dialog`);
    const bill = billPage(checkedPage(page, options), page.html);
    if (bill) bills.push(bill);
  }
  if (new Set(bills.map((bill) => bill.billingPeriod)).size !== bills.length)
    return fail("unexpected-response", "two statement pages name the same 帳單年月");

  const latest = [...bills].sort((left, right) => right.billingPeriod.localeCompare(left.billingPeriod))[0];
  if (!latest) return fail("unexpected-response", "no statement page names a 帳單年月");
  const statementAmount = latest.statementAmount ?? fail("unexpected-response", "latest statement has no 本期應繳總額");
  const paidAmount = latest.paidAmount ?? fail("unexpected-response", "latest statement has no paid amount");
  const unbilledAmount = current.unbilledAmount ?? fail("unexpected-response", "current page has no 未出帳金額");

  const tagged = [
    ...current.rows.map((row) => ({ row, pending: row.postingDate === null, statementKey: null })),
    ...bills.flatMap((bill) => bill.rows.map((row) => ({ row, pending: false, statementKey: bill.billingPeriod }))),
  ];
  const signs = new Set(tagged.map(({ row }) => row.amount.startsWith("-") ? "-" : "+"));
  const bothSigns = signs.size === 2;
  const occurrences = new Map<string, number>();
  const purchases = tagged.map(({ row, pending, statementKey }): PreviewPurchase => {
    const base = rowKey(row, pending);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return {
      sourceRowKey: `${base}#${occurrence}`,
      amount: row.amount,
      currency: row.currency,
      direction: bothSigns ? row.amount.startsWith("-") ? "inflow" : "outflow" : "unknown",
      posting: pending
        ? { status: "pending" }
        : { status: "posted", billing: statementKey === null ? "unbilled" : "billed", postingDate: row.postingDate },
      consumedAt: row.consumedAt,
      sourceCardKey: row.cardLast4 === null ? null : `card-${row.cardLast4}`,
      statementKey,
      bankReference: null,
      description: row.description,
    };
  });
  const cards = [...new Set(tagged.flatMap(({ row }) => row.cardLast4 === null ? [] : [row.cardLast4]))]
    .sort()
    .map((last4): PreviewCard => ({ sourceCardKey: `card-${last4}`, cardMask: `****${last4}`, displayLabel: null }));

  return {
    collectedAt: options.now,
    accounts: [{
      sourceAccountKey: HNCB_CARD_ACCOUNT_KEY,
      displayLabel: "華南銀行信用卡",
      currency: CURRENCY,
      creditLimit: latest.creditLimit ?? current.creditLimit,
      cards,
      balances: [{
        amount: decimalSum([[1, statementAmount], [-1, paidAmount], [1, unbilledAmount]]),
        currency: CURRENCY,
        observedAt: observedAt(first.date, options.now),
        basis: { kind: "statement-minus-paid-plus-unbilled", statementAmount, paidAmount, unbilledAmount },
      }],
      purchases,
      statements: statements(bills),
    }],
  };
}

const DISPATCHER = "/netbank/servlet/TrxDispatcher";

async function mainFrame(page: Page): Promise<Frame> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const frame = page.frame({ name: "main" });
    if (frame) return frame;
    await page.waitForTimeout(250);
  }
  return fail("unexpected-response", "HNCB main frame is missing");
}

/**
 * Reads one `CrdDetailInq` page in the signed-in frameset by posting the
 * same form all-set-tw posts into the `main` frame. Native dialogs are
 * dismissed and returned, never confirmed.
 */
export function playwrightHncbCardPages(page: Page): HncbCardPageReader {
  return async (range) => {
    const frame = await mainFrame(page);
    let dialog: string | null = null;
    const onDialog = (event: import("playwright").Dialog) => {
      dialog ??= event.message();
      void event.dismiss().catch(() => undefined);
    };
    page.on("dialog", onDialog);
    try {
      const navigation = frame.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => null);
      await frame.evaluate(({ action, fields }) => {
        const form = document.createElement("form");
        form.method = "POST";
        form.action = action;
        for (const [name, value] of Object.entries(fields)) {
          const input = document.createElement("input");
          input.type = "hidden";
          input.name = name;
          input.value = value;
          form.appendChild(input);
        }
        document.body.appendChild(form);
        setTimeout(() => form.submit(), 0);
      }, { action: DISPATCHER, fields: { trx: "com.lb.wibc.trx.CrdDetailInq", state: "result", TYPE: "001", RANGE: range } });
      const response = await navigation;
      if (dialog !== null) return { range, status: response?.status() ?? 200, html: "", date: null, dialog };
      if (!response) return fail("unexpected-response", `CrdDetailInq RANGE=${range} did not load`);
      const loaded = await mainFrame(page);
      return { range, status: response.status(), html: await loaded.content(), date: response.headers().date ?? null, dialog };
    } finally {
      page.off("dialog", onDialog);
    }
  };
}
