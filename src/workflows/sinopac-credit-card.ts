import { createHash } from "node:crypto";
import type { Page } from "playwright";
import type {
  PreviewCard,
  PreviewCreditAccount,
  PreviewCreditBalance,
  PreviewCreditCollection,
  PreviewDirection,
  PreviewPurchase,
  PreviewStatement,
} from "../ledger/pglite/preview-financial-data.ts";
import type { PreviewProductAbsence } from "../lib/preview-sources/product-collection.ts";
import {
  currencyCode,
  exactDecimal,
  fail,
  isZeroDecimal,
  localDate,
  observedAt,
  optionalText,
  parseSourceJson,
  record,
  records,
  text,
  unsignedDecimal,
  type SourceRecord,
} from "../lib/preview-sources/source-kit.ts";
import type { PreviewResponseObservation } from "../lib/preview-sources/workflow.ts";

const MMA_ORIGIN = "https://mma.sinopac.com";
export const SINOPAC_CARD_SUMMARY_PATH = "/ws/card/cardqry/ws_cardsum.ashx";
export const SINOCARD_SSO_PATH = "/SinoCard/api/security/sso";
export const SINOCARD_AUTH_PATH = "/SinoCard/api/security/auth";
export const SINOCARD_LATEST_TX_PATH = "/SinoCard/api/Accounting/LatestTx";
export const SINOCARD_OUTSTANDING_PATH = "/SinoCard/api/Accounting/OutstandingDetail";
export const SINOCARD_ACCOUNTING_PATH = "/SinoCard/api/accounting/accountinginfo";
const SINOCARD_PAGE_URL = `${MMA_ORIGIN}/SinoCard/Account/UnbilledTxInquiry`;
/** The desktop SinoCard SPA's `applicationName`; the mobile site sends `MWEB`. */
const SINOCARD_APPLICATION_NAME = "EWEB2";

export type SinopacCardResponse = Readonly<{ endpoint: string; status: number; date: string | null; text: string }>;

/** Same-origin requests from the signed-in MMA page. */
export type SinopacCardTransport = Readonly<{
  mma(path: string): Promise<SinopacCardResponse>;
  sinoCard(path: string, content: Readonly<Record<string, unknown>>, userId: string | null): Promise<SinopacCardResponse>;
}>;

export type SinopacCardCollectionInput = Readonly<{
  transport: SinopacCardTransport;
  collectedAt: string;
  observe: (response: PreviewResponseObservation) => void;
}>;

export function sinopacCardPageTransport(page: Page, signal: AbortSignal): SinopacCardTransport {
  const send = async (endpoint: string, init: Readonly<{ headers: Record<string, string>; body: string; referrer?: string }>) => {
    signal.throwIfAborted();
    if (new URL(page.url()).origin !== MMA_ORIGIN) fail("unexpected-response", "the signed-in page is not on the MMA origin");
    const response = await page.evaluate(async ({ url, init }) => {
      const reply = await fetch(url, { method: "POST", credentials: "same-origin", ...init });
      return { status: reply.status, date: reply.headers.get("date"), text: await reply.text() };
    }, { url: `${MMA_ORIGIN}${endpoint}`, init });
    signal.throwIfAborted();
    return { endpoint, ...response };
  };
  return {
    mma: (path) => send(path, {
      headers: {
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: "",
    }),
    sinoCard: (path, content, userId) => send(path, {
      headers: { Accept: "application/json, text/plain, */*", "Content-Type": "application/json" },
      referrer: SINOCARD_PAGE_URL,
      body: JSON.stringify({
        Content: content,
        Header: {
          ApplicationName: SINOCARD_APPLICATION_NAME,
          ...(userId === null ? {} : { UserID: userId }),
          ClientRefNo: crypto.randomUUID().replaceAll("-", ""),
          ClientTimestamp: new Date().toISOString(),
        },
      }),
    }),
  };
}

/** all-set-tw's explicit no-card wording; a missing bill or purchase list is not one. */
export function isSinopacNoCardMessage(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const message = value.replace(/\s+/gu, "").replace(/^\d{4}[:：]/u, "");
  return /^(?:您)?(?:目前)?(?:(?:尚未|未|沒有|無)(?:持有|申辦|申請)?(?:本行)?信用卡|沒有(?:本行)?有效卡|非(?:本行)?(?:信用卡)?(?:持卡人|卡友)|非(?:本行)?信用卡客戶)(?=[，,。.!！；;]|$)/u
    .test(message);
}

/** SinoPac's own `000` and the ISO 4217 numeric codes it sends, plus the Chinese names. */
const CURRENCY_ALIASES: Readonly<Record<string, string>> = {
  "000": "TWD", "901": "TWD", NTD: "TWD", "臺幣": "TWD", "台幣": "TWD", "新臺幣": "TWD", "新台幣": "TWD",
  "840": "USD", "美元": "USD", "392": "JPY", "日圓": "JPY", "日幣": "JPY", "978": "EUR", "歐元": "EUR",
  "826": "GBP", "036": "AUD", "124": "CAD", "344": "HKD", "156": "CNY", "702": "SGD", "756": "CHF",
  "554": "NZD", "410": "KRW", "764": "THB",
};

const sinopacCurrency = (value: unknown, field: string) => currencyCode(value, field, CURRENCY_ALIASES);

function readJson(response: SinopacCardResponse, observe: SinopacCardCollectionInput["observe"]): unknown {
  if (response.status !== 200) return fail("unexpected-response", `${response.endpoint} answered HTTP ${response.status}`);
  const body = parseSourceJson(response.text, response.endpoint);
  observe({ endpoint: response.endpoint, status: response.status, body });
  return body;
}

type Envelope = Readonly<{ header: string; message: string | null }>;

function mmaEnvelope(body: unknown, endpoint: string): Envelope {
  if (!Array.isArray(body) || body.length !== 1) return fail("unexpected-response", `${endpoint} is not a single envelope`);
  const envelope = record(body[0], endpoint);
  const header = text(envelope.Header, `${endpoint} Header`);
  const message = optionalText(envelope.Message);
  if (header === "TIMEOUT" || /尚未登入|登入逾時/u.test(message ?? "")) return fail("session-conflict", `${endpoint} reports the MMA session ended`);
  return { header, message };
}

function sinoCardResult(body: unknown, endpoint: string): SourceRecord {
  const payload = record(body, endpoint);
  if (payload.ResultCode !== "00") {
    return fail("unexpected-response", `${endpoint} ResultCode ${String(payload.ResultCode)}: ${optionalText(payload.ResultMessage) ?? "no message"}`);
  }
  return record(payload.Result, `${endpoint} Result`);
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

const last4 = (value: unknown): string | null => {
  const match = /(\d{4})\D*$/u.exec(typeof value === "string" ? value : "");
  return match ? match[1]! : null;
};

/** Exact `a + b + ...` over decimal lexemes; never passes through a float. */
export function sumDecimals(terms: readonly Readonly<{ value: string; negate?: boolean }>[]): string {
  const scale = Math.max(0, ...terms.map(({ value }) => value.split(".")[1]?.length ?? 0));
  const scaled = (value: string) => {
    const negative = value.startsWith("-");
    const [whole, fraction = ""] = value.replace(/^[+-]/u, "").split(".");
    const units = BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
    return negative ? -units : units;
  };
  const total = terms.reduce((sum, { value, negate }) => sum + (negate ? -scaled(value) : scaled(value)), 0n);
  const digits = (total < 0n ? -total : total).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale === 0 ? "" : `.${digits.slice(-scale)}`;
  return `${total < 0n ? "-" : ""}${whole}${fraction}`;
}

const isPositive = (value: string) => !isZeroDecimal(value) && !value.startsWith("-");

type PostedRow = Readonly<{
  currency: string;
  amount: string;
  consumedAt: ReturnType<typeof localDate>;
  postingDate: string | null;
  card: string | null;
  cardName: string | null;
  description: string | null;
}>;

type PendingRow = Readonly<{
  currency: string;
  amount: string;
  consumedAt: ReturnType<typeof localDate>;
  card: string | null;
  cardName: string | null;
  description: string | null;
}>;

function postedRows(detail: readonly SourceRecord[]): PostedRow[] {
  return detail.map((row, index) => {
    const field = `OutstandingDetail.Detail[${index}]`;
    const posting = optionalText(row.DEDATE);
    return {
      currency: sinopacCurrency(row.CurrencyCode, `${field}.CurrencyCode`),
      amount: exactDecimal(row.AMT, `${field}.AMT`),
      consumedAt: localDate(row.TXDATE, `${field}.TXDATE`),
      postingDate: posting === null ? null : localDate(posting, `${field}.DEDATE`).value.slice(0, 10),
      card: last4(row.CardLast4) ?? last4(row.CardNoLast4),
      cardName: optionalText(row.CARDNAME),
      description: optionalText(row.MEMO),
    };
  });
}

function pendingRows(items: readonly SourceRecord[]): PendingRow[] {
  return items.map((row, index) => {
    const field = `LatestTx.Items[${index}]`;
    if (row.AuthResult !== "Y") return fail("unexpected-response", `${field}.AuthResult is ${JSON.stringify(row.AuthResult)}, not an approved authorization`);
    const date = text(row.AuthDate, `${field}.AuthDate`);
    const time = optionalText(row.AuthTime);
    return {
      // LatestTx carries no currency field; SinoPac authorizes in NT dollars (all-set-tw).
      currency: row.CurrencyCode === undefined ? "TWD" : sinopacCurrency(row.CurrencyCode, `${field}.CurrencyCode`),
      amount: exactDecimal(row.AuthAmt, `${field}.AuthAmt`),
      consumedAt: localDate(time === null ? date : `${date} ${time}`, `${field}.AuthDate`),
      card: last4(row.CardNo),
      cardName: optionalText(row.CardName),
      description: optionalText(row.Memo),
    };
  });
}

/** Unbilled subtotals per currency, checked against the Detail rows they count. */
function unbilledSubtotals(subtotals: readonly SourceRecord[], posted: readonly PostedRow[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const [index, row] of subtotals.entries()) {
    const field = `OutstandingDetail.SubTotal[${index}]`;
    const currency = sinopacCurrency(row.CurrencyCode, `${field}.CurrencyCode`);
    if (result.has(currency)) return fail("unexpected-response", `${field} repeats ${currency}`);
    const count = typeof row.Count === "string" && /^\d+$/u.test(row.Count) ? Number(row.Count) : fail("incomplete-data", `${field}.Count is not a count`);
    const listed = posted.filter((item) => item.currency === currency).length;
    if (count !== listed) return fail("incomplete-data", `${field} counts ${count} rows but Detail lists ${listed} in ${currency}`);
    result.set(currency, exactDecimal(row.SubTotalAmt, `${field}.SubTotalAmt`));
  }
  for (const item of posted) {
    if (!result.has(item.currency)) return fail("incomplete-data", `OutstandingDetail.SubTotal has no ${item.currency} row for its Detail rows`);
  }
  return result;
}

type Bill = Readonly<{ currency: string; statement: string; paid: string; minimum: string | null }>;

function bills(rows: readonly SourceRecord[]): Bill[] {
  const seen = new Set<string>();
  return rows.map((row, index) => {
    const field = `accountinginfo.BillAmounts[${index}]`;
    const currency = sinopacCurrency(row.CurrencyCode ?? row.CurrencyName, `${field}.CurrencyCode`);
    if (seen.has(currency)) return fail("unexpected-response", `${field} repeats ${currency}`);
    seen.add(currency);
    const paid = typeof row.TotalPaymentAmt === "string" && row.TotalPaymentAmt.trim() === "-"
      // SinoCard's explicit marker for no payment posted to the current bill (all-set-tw, checked against the official page).
      ? "0"
      : exactDecimal(row.TotalPaymentAmt, `${field}.TotalPaymentAmt`);
    return {
      currency,
      statement: exactDecimal(row.CURRBAL, `${field}.CURRBAL`),
      paid,
      minimum: optionalText(row.DUEAMT) === null ? null : exactDecimal(row.DUEAMT, `${field}.DUEAMT`),
    };
  });
}

const DATE_LIKE = /^\d{4}[-/]?\d{2}[-/]?\d{2}$/u;

/** The day after the same date one month earlier: SinoPac closes monthly on a fixed day. */
function cycleStartFor(closingDate: string): string {
  const [year, month, day] = closingDate.split("-").map(Number) as [number, number, number];
  const lastOfPrevious = new Date(Date.UTC(year, month - 1, 0)).getUTCDate();
  const previous = new Date(Date.UTC(year, month - 2, Math.min(day, lastOfPrevious)));
  previous.setUTCDate(previous.getUTCDate() + 1);
  return previous.toISOString().slice(0, 10);
}

function withOccurrence<T>(rows: readonly T[], key: (row: T) => string): Array<T & { sourceRowKey: string }> {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const base = key(row);
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return { ...row, sourceRowKey: `${base}#${occurrence}` };
  });
}

/**
 * Collects SinoPac credit cards in the signed-in MMA session: the card
 * summary for the no-card signal, then the SinoCard SSO, approved
 * authorizations, unbilled posted purchases with their per-currency
 * subtotals, and the current bill per currency.
 */
export async function collectSinopacCreditCards(input: SinopacCardCollectionInput): Promise<PreviewCreditCollection | PreviewProductAbsence> {
  const { transport, observe, collectedAt } = input;
  const summary = mmaEnvelope(readJson(await transport.mma(SINOPAC_CARD_SUMMARY_PATH), observe), SINOPAC_CARD_SUMMARY_PATH);
  if (isSinopacNoCardMessage(summary.message)) return { absent: "not_held" };
  if (summary.header !== "SUCCESS") return fail("unexpected-response", `${SINOPAC_CARD_SUMMARY_PATH} Header ${summary.header}`);

  const sso = sinoCardResult(readJson(await transport.sinoCard(SINOCARD_SSO_PATH, {}, null), observe), SINOCARD_SSO_PATH);
  const customerId = text(sso.ID, `${SINOCARD_SSO_PATH} Result.ID`);
  sinoCardResult(readJson(await transport.sinoCard(SINOCARD_AUTH_PATH, {}, customerId), observe), SINOCARD_AUTH_PATH);

  const latestBody = readJson(await transport.sinoCard(SINOCARD_LATEST_TX_PATH, { ID: customerId }, customerId), observe);
  if (isSinopacNoCardMessage(record(latestBody, SINOCARD_LATEST_TX_PATH).ResultMessage)) return { absent: "not_held" };
  const latest = sinoCardResult(latestBody, SINOCARD_LATEST_TX_PATH);
  const outstanding = sinoCardResult(readJson(await transport.sinoCard(
    SINOCARD_OUTSTANDING_PATH,
    { IsExcludePaidUp: false, ID: customerId, DateYYYYMMDD: "" },
    customerId,
  ), observe), SINOCARD_OUTSTANDING_PATH);
  const accountingResponse = await transport.sinoCard(SINOCARD_ACCOUNTING_PATH, { ID: customerId }, customerId);
  const accounting = sinoCardResult(readJson(accountingResponse, observe), SINOCARD_ACCOUNTING_PATH);

  const pending = pendingRows(records(latest.Items, "LatestTx.Items"));
  const posted = postedRows(records(outstanding.Detail, "OutstandingDetail.Detail"));
  const unbilled = unbilledSubtotals(records(outstanding.SubTotal, "OutstandingDetail.SubTotal"), posted);
  const baseData = record(accounting.BaseData, "accountinginfo.BaseData");
  const closing = localDate(baseData.STMTDATE, "accountinginfo.BaseData.STMTDATE").value.slice(0, 10);
  const dueText = optionalText(baseData.DUEDATE);
  const dueDate = dueText !== null && DATE_LIKE.test(dueText) ? localDate(dueText, "accountinginfo.BaseData.DUEDATE").value.slice(0, 10) : null;
  const currentBills = bills(records(accounting.BillAmounts, "accountinginfo.BillAmounts"));
  const balanceAt = observedAt(accountingResponse.date, collectedAt);

  const nonZeroPosted = posted.filter((row) => !isZeroDecimal(row.amount));
  const signsCarryDirection = nonZeroPosted.length === posted.length
    && nonZeroPosted.some((row) => isPositive(row.amount))
    && nonZeroPosted.some((row) => row.amount.startsWith("-"));
  const postedDirection = (amount: string): PreviewDirection =>
    !signsCarryDirection ? "unknown" : isPositive(amount) ? "outflow" : "inflow";

  const postedPurchases = withOccurrence(nonZeroPosted, (row) =>
    ["posted", row.currency, row.consumedAt.value, row.amount, sha(row.description ?? "")].join("|"));
  const pendingPurchases = withOccurrence(pending.filter((row) => !isZeroDecimal(row.amount)), (row) =>
    ["pending", row.currency, row.consumedAt.value, row.amount, row.card ?? "", sha(row.description ?? "")].join("|"));

  const currencies = [...new Set([
    ...currentBills.map((bill) => bill.currency),
    ...unbilled.keys(),
    ...postedPurchases.map((row) => row.currency),
    ...pendingPurchases.map((row) => row.currency),
  ])].sort((left, right) => (left === "TWD" ? -1 : right === "TWD" ? 1 : left.localeCompare(right)));
  if (currencies.length === 0) return { absent: "no_data" };

  const accounts = currencies.map((currency): PreviewCreditAccount => {
    const ownPosted = postedPurchases.filter((row) => row.currency === currency);
    const ownPending = pendingPurchases.filter((row) => row.currency === currency);
    const cards = new Map<string, PreviewCard>();
    for (const row of [...ownPosted, ...ownPending]) {
      if (row.card !== null && !cards.has(row.card)) cards.set(row.card, { sourceCardKey: row.card, cardMask: `****${row.card}`, displayLabel: row.cardName });
    }
    const purchases: PreviewPurchase[] = [
      ...ownPending.map((row): PreviewPurchase => ({
        sourceRowKey: row.sourceRowKey,
        amount: row.amount,
        currency,
        direction: "unknown",
        posting: { status: "pending" },
        consumedAt: row.consumedAt,
        sourceCardKey: row.card,
        statementKey: null,
        bankReference: null,
        description: row.description,
      })),
      ...ownPosted.map((row): PreviewPurchase => {
        const direction = postedDirection(row.amount);
        return {
          sourceRowKey: row.sourceRowKey,
          amount: direction === "unknown" ? row.amount : unsignedDecimal(row.amount),
          currency,
          direction,
          posting: { status: "posted", billing: "unbilled", postingDate: row.postingDate },
          consumedAt: row.consumedAt,
          sourceCardKey: row.card,
          statementKey: null,
          bankReference: null,
          description: row.description,
        };
      }),
    ];
    const bill = currentBills.find((item) => item.currency === currency);
    // Every Detail currency has a SubTotal whose Count matched, so a currency without one has nothing unbilled.
    const unbilledAmount = unbilled.get(currency) ?? "0";
    const balances: PreviewCreditBalance[] = bill === undefined ? [] : [{
      amount: sumDecimals([{ value: bill.statement }, { value: bill.paid, negate: true }, { value: unbilledAmount }]),
      currency,
      observedAt: balanceAt,
      basis: { kind: "statement-minus-paid-plus-unbilled", statementAmount: bill.statement, paidAmount: bill.paid, unbilledAmount },
    }];
    const statements: PreviewStatement[] = bill === undefined || dueDate === null ? [] : [{
      statementKey: closing,
      cycleStart: cycleStartFor(closing),
      cycleEnd: closing,
      closingDate: closing,
      dueDate,
      amount: bill.statement,
      currency,
      minimumPayment: bill.minimum,
      billingPeriod: closing.slice(0, 7),
      paidAmount: bill.paid,
      paid: isPositive(bill.statement) ? !sumDecimals([{ value: bill.paid }, { value: bill.statement, negate: true }]).startsWith("-") : null,
      noPaymentNeeded: !isPositive(bill.statement),
    }];
    return {
      sourceAccountKey: `card:${currency}`,
      displayLabel: currency === "TWD" ? "永豐信用卡" : `永豐信用卡（${currency}）`,
      currency,
      creditLimit: null,
      cards: [...cards.values()].sort((left, right) => left.sourceCardKey.localeCompare(right.sourceCardKey)),
      balances,
      purchases,
      statements,
    };
  });
  return { collectedAt, accounts };
}
