import { createHash } from "node:crypto";
import { amountKey } from "./source-id.ts";
import type {
  PreviewAccount,
  PreviewCard,
  PreviewCreditAccount,
  PreviewCreditCollection,
  PreviewLocalDate,
  PreviewPurchase,
  PreviewStatement,
  PreviewTransaction,
} from "../../ledger/pglite/preview-financial-data.ts";
import type { PreviewHttp } from "./browser-http.ts";
import type { PreviewProductAbsence } from "./product-collection.ts";
import { calibratedCaptchaSolver, TAISHIN_CAPTCHA_FAMILY } from "./preview-captcha.ts";
import { taishinBrowserSession } from "./taishin-login-form.ts";
import type { PreviewSource } from "./registry.ts";
import { PREVIEW_SOURCE_INSTITUTIONS } from "./source-id.ts";
import {
  currencyCode,
  decimalSum,
  exactDecimal,
  fail,
  isZeroDecimal,
  localDate,
  observedAt,
  optionalText,
  parseSourceJson,
  record,
  records,
  solveChallengeRound,
  taipeiMonthWindow,
  text,
  type PreviewCaptchaChallenge,
  type PreviewCaptchaSolver,
  type SourceRecord,
  uniqueTransactions,
} from "./source-kit.ts";
import type { PreviewWorkflowContext } from "./workflow.ts";

const ORIGIN = "https://my.taishinbank.com.tw";
const RWD_URL = `${ORIGIN}/TIBNetBank/svc/rwd/index.html`;
const ROOT = "/TIBNetBank/svc";
const MONTHS = 3;
// The web1 (RB01xx) pages are Taishin's NT-dollar account pages and carry no
// currency field, so their contract fixes TWD. A currency the source does send wins.
const NT_DOLLAR_ENDPOINT_CURRENCY = "TWD";
const CURRENCY_ALIASES: Readonly<Record<string, string>> = {
  NTD: "TWD", "新臺幣": "TWD", "新台幣": "TWD", "臺幣": "TWD", "台幣": "TWD",
  "美元": "USD", "美金": "USD", "日圓": "JPY", "日幣": "JPY", "歐元": "EUR", "人民幣": "CNY",
  "港幣": "HKD", "澳幣": "AUD", "英鎊": "GBP", "加幣": "CAD", "瑞士法郎": "CHF", "新加坡幣": "SGD",
  "紐幣": "NZD", "南非幣": "ZAR", "瑞典幣": "SEK", "泰銖": "THB",
  "840": "USD", "392": "JPY", "978": "EUR", "156": "CNY", "344": "HKD", "036": "AUD", "826": "GBP",
  "124": "CAD", "756": "CHF", "702": "SGD", "554": "NZD", "710": "ZAR", "752": "SEK", "764": "THB",
};

const KEY = {
  idNumber: "PREVIEW_TAISHIN_DEPOSIT_ID_NUMBER",
  userCode: "PREVIEW_TAISHIN_DEPOSIT_USER_CODE",
  password: "PREVIEW_TAISHIN_DEPOSIT_PASSWORD",
} as const;

export type TaishinCredentials = Readonly<{ idNumber: string; userCode: string; password: string }>;

/**
 * Taishin's website builds the login request in its own page script, so sign-in
 * only works by driving the RWD login form. This seam is that form: it reads the
 * CAPTCHA image the page shows and submits the filled form, returning the text of
 * any dialog the page raised (null when none).
 */
export type TaishinLoginForm = Readonly<{
  captcha(): Promise<PreviewCaptchaChallenge>;
  submit(credentials: TaishinCredentials, captcha: string): Promise<string | null>;
}>;

export type TaishinSessionOpener = <T>(
  context: PreviewWorkflowContext,
  startUrl: string,
  use: (session: Readonly<{ http: PreviewHttp; form: TaishinLoginForm }>) => Promise<T>,
) => Promise<T>;

const CREDENTIAL_FIELD = "(?:密碼|使用者代(?:號|碼)|身分證(?:字號)?|統一編號)";
const FAILURE = "(?:錯誤|有誤|不正確|無效)";

function classifyLoginDialog(dialog: string): never {
  if (new RegExp(`驗證碼.{0,30}${FAILURE}|${FAILURE}.{0,30}驗證碼`, "u").test(dialog)) fail("verification-rejected", "captcha rejected");
  if (new RegExp(`${CREDENTIAL_FIELD}.{0,30}${FAILURE}|${FAILURE}.{0,30}${CREDENTIAL_FIELD}`, "u").test(dialog))
    fail("sign-in-rejected", "credentials rejected");
  if (/USER\s*正在線上.*無法登入/iu.test(dialog)) fail("session-conflict", "another online-banking session is active");
  return fail("unexpected-response", "unrecognized login dialog");
}

type Response = Readonly<{ payload: SourceRecord; date: string | null }>;

function client(context: PreviewWorkflowContext, http: PreviewHttp) {
  async function raw(path: string, body: Record<string, unknown> | ""): Promise<Response> {
    const response = await http({
      method: "POST",
      url: `${ORIGIN}${ROOT}${path}`,
      headers: {
        Accept: "application/json, text/plain, */*",
        // The official axios helper sends a parameterless call as an empty form body.
        "Content-Type": body === "" ? "application/x-www-form-urlencoded" : "application/json",
      },
      body: body === "" ? "" : JSON.stringify(body),
      credentials: "same-origin",
    });
    let parsed: unknown = null;
    try {
      parsed = parseSourceJson(response.text, path);
    } finally {
      context.preview.observe({ endpoint: path, status: response.status, body: parsed });
    }
    if (response.status !== 200) return fail("unexpected-response", `${path} HTTP ${response.status}`);
    return { payload: record(parsed, path), date: response.headers.date ?? null };
  }
  async function post(path: string, body: Record<string, unknown> | ""): Promise<Response> {
    const response = await raw(path, body);
    const { RESULT, error } = response.payload;
    if (RESULT === "EXPIRED" || RESULT === "RESUME") return fail("session-conflict", `${path} session expired`);
    if (error != null && error !== false && error !== "") {
      const detail = typeof error === "string" ? error : optionalText(record(error, `${path}.error`).message) ?? "";
      if (/請重新登入|登入逾時/u.test(detail)) return fail("session-conflict", `${path} session expired`);
      return fail("unexpected-response", `${path} returned an error`);
    }
    return response;
  }
  return { raw, post };
}

type Client = ReturnType<typeof client>;

function twdData(response: Response, path: string): unknown {
  if (response.payload.RESULT !== "NORMAL") return fail("unexpected-response", `${path}.RESULT is not NORMAL`);
  return response.payload.OUTPUTDATA;
}

function fxData(response: Response, path: string): unknown {
  if (response.payload.error !== null) return fail("unexpected-response", `${path}.error is not null`);
  return response.payload.data;
}

function accountIdentity(value: string): string {
  return value.replace(/[\s-]/gu, "");
}

function sameAccount(left: unknown, right: string): boolean {
  return typeof left === "string" && accountIdentity(left) === accountIdentity(right);
}

function plainText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return optionalText(value.replace(/<br\s*\/?\s*>/giu, " ").replace(/<[^>]*>/gu, "").replace(/&nbsp;|&#160;/giu, " "));
}

/** A side of a strict in/out column pair: "-", blank, or zero means the side is empty. */
function columnSide(value: unknown, field: string): string | null {
  if (value === "-" || (typeof value === "string" && value.trim() === "")) return null;
  const amount = exactDecimal(value, field);
  return isZeroDecimal(amount) ? null : amount;
}

function directed(inValue: unknown, outValue: unknown, field: string): Pick<PreviewTransaction, "amount" | "direction"> {
  const inflow = columnSide(inValue, `${field}.in`);
  const outflow = columnSide(outValue, `${field}.out`);
  if ((inflow === null) === (outflow === null)) return fail("unexpected-response", `${field} must set exactly one of its in/out columns`);
  return inflow !== null ? { amount: inflow, direction: "inflow" } : { amount: outflow!, direction: "outflow" };
}

function count(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^\d{1,6}$/u.test(value.trim())) return fail("unexpected-response", `${field} is not a count`);
  return Number(value);
}

const DAY_MS = 86_400_000;
const compact = (day: string) => day.replaceAll("-", "");
const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/**
 * RB0102 answers a range with in/out counts; a list shorter than their sum is
 * truncated. Split the range and requery, and fail when a single day stays short.
 */
async function twdRows(api: Client, account: string, start: string, end: string): Promise<readonly SourceRecord[]> {
  const path = "/web1/rb0102/query";
  const data = record(twdData(await api.post(path, { account, start: compact(start), end: compact(end) }), path), `${path}.OUTPUTDATA`);
  const rows = records(data.userList, `${path}.userList`);
  if (count(data.inNo, `${path}.inNo`) + count(data.outNo, `${path}.outNo`) === rows.length) return rows;
  if (start === end) return fail("incomplete-data", `${path} lists fewer rows than its counts for one day`);
  const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS);
  const middle = shiftDay(start, Math.floor(days / 2));
  return [...await twdRows(api, account, start, middle), ...await twdRows(api, account, shiftDay(middle, 1), end)];
}

function twdTransaction(row: SourceRecord, field: string, currency: string): PreviewTransaction {
  const procSeq = text(row.procSeq, `${field}.procSeq`);
  const occurred = localDate(row.sysdate, `${field}.sysdate`);
  const descriptions = [plainText(row.memo), plainText(row.message)].filter((value) => value !== null);
  exactDecimal(row.newbal, `${field}.newbal`);
  return {
    // Padded so a JSON-number procSeq and its seven-digit string form give one key.
    sourceRowKey: `${occurred.value.slice(0, 10)}:${procSeq.padStart(7, "0")}`,
    ...directed(row.txnamtIn, row.txnamtOut, field),
    currency,
    postedAt: localDate(row.dateNew, `${field}.dateNew`),
    description: descriptions.length > 0 ? descriptions.join(" · ") : null,
  };
}

function sourceCurrency(value: unknown, field: string): string {
  return value === undefined ? NT_DOLLAR_ENDPOINT_CURRENCY : currencyCode(value, field, CURRENCY_ALIASES);
}

async function twdAccounts(api: Client, now: string): Promise<PreviewAccount[]> {
  const listPath = "/web1/rb0100/query";
  const listed = records(record(twdData(await api.post(listPath, ""), listPath), `${listPath}.OUTPUTDATA`).SavingAccount, `${listPath}.SavingAccount`);
  if (listed.length === 0) return [];
  const optionsPath = "/web1/rb0102/listaccount";
  const options = records(twdData(await api.post(optionsPath, {}), optionsPath), `${optionsPath}.OUTPUTDATA`);
  const window = taipeiMonthWindow(now, MONTHS);
  const accounts: PreviewAccount[] = [];
  for (const [index, entry] of listed.entries()) {
    const field = `SavingAccount[${index}]`;
    const accountNo = text(entry.accountNo, `${field}.accountNo`);
    const currency = sourceCurrency(entry.currency, `${field}.currency`);
    if (!options.some((option) => sameAccount(option.value, accountNo))) return fail("unexpected-response", `${field} is missing from rb0102/listaccount`);
    const balancePath = "/web1/rb0101/query";
    const balanceResponse = await api.post(balancePath, { account: accountNo });
    const label = `台新銀行 ${optionalText(entry.accountTypeName) ?? "臺幣活存"} ${accountIdentity(accountNo).slice(-4)}`;
    const asOf = observedAt(balanceResponse.date, now);
    // EBF0015: online banking lists the account but cannot query it, such as a
    // securities settlement account. Keep the RB0100 balance and skip its details.
    if (balanceResponse.payload.RESULT !== "NORMAL" && typeof balanceResponse.payload.ERRORMSG === "string"
      && balanceResponse.payload.ERRORMSG.trim().startsWith("(EBF0015)")) {
      accounts.push({
        sourceAccountKey: `${accountIdentity(accountNo)}:${currency}`,
        displayLabel: label,
        currency,
        type: "depository",
        balances: [{ kind: "current", amount: exactDecimal(entry.balance, `${field}.balance`), currency, observedAt: asOf }],
        transactions: [],
      });
      continue;
    }
    const balance = record(twdData(balanceResponse, balancePath), `${balancePath}.OUTPUTDATA`);
    const rows = await twdRows(api, accountNo, window.start, window.end);
    accounts.push({
      sourceAccountKey: `${accountIdentity(accountNo)}:${currency}`,
      displayLabel: label,
      currency,
      type: "depository",
      balances: [
        { kind: "current", amount: exactDecimal(balance.balance, `${balancePath}.balance`), currency, observedAt: asOf },
        ...balance.availbalance == null ? [] : [
          { kind: "available" as const, amount: exactDecimal(balance.availbalance, `${balancePath}.availbalance`), currency, observedAt: asOf },
        ],
      ],
      transactions: uniqueTransactions(rows.map((row, rowIndex) => twdTransaction(row, `rb0102.userList[${rowIndex}]`, currency)), "row key"),
    });
  }
  return accounts;
}

function fxTransaction(row: SourceRecord, field: string, currency: string): PreviewTransaction {
  const rowCurrency = currencyCode(row.CCY_CODE, `${field}.CCY_CODE`, CURRENCY_ALIASES);
  if (rowCurrency !== currency) return fail("unexpected-response", `${field}.CCY_CODE does not match the queried currency`);
  const occurred = localDate(row.TRANSACTION_DATE_TIME_DSC, `${field}.TRANSACTION_DATE_TIME_DSC`);
  const movement = directed(row.DEPAMT, row.DRWAMT, field);
  const balance = exactDecimal(row.ACCT_BAL, `${field}.ACCT_BAL`);
  return {
    // RB0802 rows carry no sequence number; the balance after the row tells apart same-time rows.
    sourceRowKey: `${occurred.value}:${movement.direction}:${movement.amount}:${balance}`,
    ...movement,
    currency: rowCurrency,
    postedAt: localDate(row.TX_DATE, `${field}.TX_DATE`),
    description: plainText(row.REMARKS),
  };
}

async function fxAccounts(api: Client, now: string): Promise<PreviewAccount[]> {
  const listPath = "/web2/rb0800/getRB08000100Data";
  const listed = record(fxData(await api.post(listPath, ""), listPath), `${listPath}.data`).FCS_ACCOUNT;
  const groups = records(Array.isArray(listed) ? listed : Object.values(record(listed, `${listPath}.FCS_ACCOUNT`)), `${listPath}.FCS_ACCOUNT`);
  const queued = groups.flatMap((group, index) => {
    const field = `FCS_ACCOUNT[${index}]`;
    const details = records(group.FCS_ACCOUNT_DETAIL, `${field}.FCS_ACCOUNT_DETAIL`).filter((detail, detailIndex) => {
      if (typeof detail.CURRENCY_CODE === "string" && detail.CURRENCY_CODE.trim() !== "") return true;
      // A placeholder row without a currency is a sub-account not yet opened; it may only be empty.
      const balance = detail.BALANCE === "" || detail.BALANCE === undefined ? "0" : exactDecimal(detail.BALANCE, `${field}.BALANCE`);
      if (!isZeroDecimal(balance)) return fail("missing-currency", `${field}.FCS_ACCOUNT_DETAIL[${detailIndex}] has a balance but no currency`);
      return false;
    });
    return details.map((detail) => ({ group, detail, field, accountNo: text(group.ACCOUNT_NO, `${field}.ACCOUNT_NO`) }));
  });
  if (queued.length === 0) return [];
  const optionsPath = "/web2/rb0812/getRB08120100Options";
  const options = record(fxData(await api.post(optionsPath, ""), optionsPath), `${optionsPath}.data`);
  const accountOptions = records(options.ACCOUNT_OPTION, `${optionsPath}.ACCOUNT_OPTION`);
  const window = taipeiMonthWindow(now, MONTHS);
  const accounts: PreviewAccount[] = [];
  for (const { group, detail, field, accountNo } of queued) {
    const option = accountOptions.find((candidate) => sameAccount(candidate.value, accountNo));
    if (!option) return fail("unexpected-response", `${field} is missing from the RB0812 account options`);
    if (detail.ACCOUNT_NO !== undefined && !sameAccount(detail.ACCOUNT_NO, accountNo)) return fail("unexpected-response", `${field} detail account differs from its group`);
    const requestCcyCode = text(detail.CURRENCY_CODE, `${field}.CURRENCY_CODE`);
    const currency = currencyCode(requestCcyCode, `${field}.CURRENCY_CODE`, CURRENCY_ALIASES);
    const balancePath = "/web2/rb0800/getRB08000100QueryRealtimeBalance";
    const balanceResponse = await api.post(balancePath, {
      requestAccount: optionalText(detail.ACCOUNT_NO) ?? accountNo,
      requestAccountAlias: optionalText(detail.ACCOUNT_ALIAS) ?? "",
      requestCcyCode,
    });
    const balances = records(fxData(balanceResponse, balancePath), `${balancePath}.data`);
    if (balances.length !== 1 || !sameAccount(balances[0]!.ACCT_NO, accountNo)
      || currencyCode(balances[0]!.CURRENCY_CODE, `${balancePath}.CURRENCY_CODE`, CURRENCY_ALIASES) !== currency)
      return fail("unexpected-response", `${balancePath} does not match the queried account and currency`);
    const detailPath = "/web2/rb0802/getRB08020100ForeignTranDetail";
    const transactions = record(fxData(await api.post(detailPath, {
      requestAcctNo: text(option.value, `${optionsPath}.value`),
      requestCurrency: requestCcyCode,
      requestStartDate: compact(window.start),
      requestEndDate: compact(window.end),
      requestDateType: "I",
      nextNextWorkDay: optionalText(options.NEXT_NEXT_WORK_DAY) ?? "",
      requestEmail: optionalText(options.EMAIL) ?? "",
      rb0802OrderType: typeof options.RB0802_ORDER_TYPE === "string" ? options.RB0802_ORDER_TYPE : "0",
    }), detailPath), `${detailPath}.data`).TRANS_DETAILS;
    // The official page treats an empty TRANS_DETAILS object as no transactions.
    const rows = Array.isArray(transactions) || Object.keys(record(transactions, `${detailPath}.TRANS_DETAILS`)).length > 0
      ? records(transactions, `${detailPath}.TRANS_DETAILS`)
      : [];
    accounts.push({
      sourceAccountKey: `${accountIdentity(accountNo)}:${currency}`,
      displayLabel: `台新銀行 ${optionalText(group.ACCOUNT_NAME) ?? "外幣活存"} ${accountIdentity(accountNo).slice(-4)} ${currency}`,
      currency,
      type: "depository",
      balances: [{ kind: "current", amount: exactDecimal(balances[0]!.BALANCE, `${balancePath}.BALANCE`), currency, observedAt: observedAt(balanceResponse.date, now) }],
      transactions: uniqueTransactions(rows.map((row, index) => fxTransaction(row, `rb0802.TRANS_DETAILS[${index}]`, currency)), "row key"),
    });
  }
  return accounts;
}

const CARD_PATH = {
  summary: "/web4/rb0708rwd/doXTPA",
  bill: "/web4/rb0708rwd/init",
  overview: "/web4/rb0760/getCardOverviewData",
  realtime: "/web4/rb0708rwd/queryRealTime",
  unbilled: "/web4/rb0708rwd/qryUnposted",
} as const;
const CARD_ORGS = ["001", "055", "100"] as const;
// Statement, overview, realtime column [3], and showRB0712_SUBTOTAL are NT-dollar
// figures (org 001 is the NT-dollar ledger). None of them carries a currency field.
const CARD_STATEMENT_CURRENCY = "TWD";
const BILL_MONTHS = 4;
const NO_CONSUMPTION = "(CRXTIKE004)無消費資料";

class NoCreditCard extends Error {}

/** Only a message that opens by saying the person holds no card; never an application hint. */
function isNoCreditCardMessage(message: string): boolean {
  return /^(?:您)?(?:目前)?(?:(?:尚未|未|沒有|無)(?:持有|申辦|申請)?(?:本行)?信用卡|沒有(?:本行)?有效卡|非(?:本行)?(?:信用卡)?(?:持卡人|卡友)|非(?:本行)?信用卡客戶)(?=[，,。.!！；;]|$)/u
    .test(message.replace(/\s+/gu, "").replace(/^\d{4}[:：]/u, ""));
}

function errorMessage(error: unknown): string | null {
  if (error === null || error === undefined || error === false || error === "") return null;
  if (typeof error === "string") return error.trim();
  if (typeof error === "object" && !Array.isArray(error)) return optionalText((error as SourceRecord).message) ?? "";
  return String(error);
}

/** A web4 `{ error, value }` envelope. `null` is the explicit no-consumption answer, where allowed. */
async function cardCall(api: Client, path: string, body: Record<string, unknown> | "", noConsumption = false) {
  const response = await api.raw(path, body);
  if (response.payload.RESULT === "EXPIRED" || response.payload.RESULT === "RESUME") return fail("session-conflict", `${path} session expired`);
  const message = errorMessage(response.payload.error);
  if (message !== null) {
    if (/請重新登入|登入逾時/u.test(message)) return fail("session-conflict", `${path} session expired`);
    if (isNoCreditCardMessage(message)) throw new NoCreditCard();
    if (noConsumption && message === NO_CONSUMPTION) return { value: null, date: response.date };
    return fail("unexpected-response", `${path} returned an error`);
  }
  return { value: record(response.payload.value, `${path}.value`), date: response.date };
}

/** A card cell lexeme: tags such as `<font>` are stripped, and an accounting `(12.50)` is negative. */
function cardAmount(value: unknown, field: string): string {
  const cell = typeof value === "string" ? value.replace(/<[^>]*>/gu, "").trim() : value;
  const negative = typeof cell === "string" ? /^\((.+)\)$/u.exec(cell) : null;
  return negative ? `-${exactDecimal(negative[1], field).replace(/^-/u, "")}` : exactDecimal(cell, field);
}

function dayOf(value: unknown, field: string): string {
  return localDate(value, field).value.slice(0, 10);
}

function cardOf(name: unknown): PreviewCard | null {
  const label = plainText(name);
  const last4 = label === null ? undefined : /(?:末四碼\s*[:：]?\s*|[*xX])(\d{4})\D*$/u.exec(label)?.[1];
  if (label === null || last4 === undefined) return null;
  return { sourceCardKey: last4, cardMask: `****${last4}`, displayLabel: label.replace(/\d(?:[ -]?\d){7,}/gu, (run) => `****${run.replace(/\D/gu, "").slice(-4)}`) };
}

type Period = Readonly<{ year: number; month: number }>;
const periodLabel = ({ year, month }: Period) => `${year}-${String(month).padStart(2, "0")}`;

function sourcePeriod(value: unknown, field: string): string {
  const match = /^(\d{4})[/-]?(\d{1,2})$/u.exec(text(value, field));
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) return fail("unexpected-response", `${field} is not a billing period`);
  return `${match[1]}-${match[2]!.padStart(2, "0")}`;
}

/** A purchase before its key and direction, which depend on the whole collection. */
type CardRow = Readonly<{
  feed: "pending" | "unbilled" | "billed";
  card: PreviewCard | null;
  consumedAt: PreviewLocalDate;
  postingDate: string | null;
  amount: string;
  currency: string;
  /** The text that keys the row; realtime keeps column [2] while it displays column [6]. */
  identity: string;
  description: string | null;
  statementKey: string | null;
}>;

type Bill = Readonly<{ period: string; value: SourceRecord }>;

async function readBill(api: Client, org: string, period: Period): Promise<Bill | null> {
  const { value } = await cardCall(api, CARD_PATH.bill, {
    org, byear: String(period.year), bmonth: String(period.month).padStart(2, "0"), cardHolderFlagSelected: "1", cardNo: "",
  });
  // The page answers a month without a statement with an empty showAccoutnYM.
  if (optionalText(value!.showAccoutnYM) === null) return null;
  const billed = sourcePeriod(value!.showAccoutnYM, "bill.showAccoutnYM");
  if (billed !== periodLabel(period)) return fail("unexpected-response", `the ${periodLabel(period)} bill reports period ${billed}`);
  return { period: billed, value: value! };
}

function billRows(bill: Bill): CardRow[] {
  const field = `bill[${bill.period}]`;
  return records(bill.value.newAcctDetailList ?? [], `${field}.newAcctDetailList`).flatMap((group, groupIndex) =>
    records(group.detail, `${field}.newAcctDetailList[${groupIndex}].detail`).map((detail, index) => {
      const at = `${field}.newAcctDetailList[${groupIndex}].detail[${index}]`;
      const description = plainText(detail.showOutDesc);
      return {
        feed: "billed" as const,
        card: cardOf(group.order),
        consumedAt: localDate(detail.showOutTXNDate, `${at}.showOutTXNDate`),
        postingDate: detail.showOutPostDate === undefined || detail.showOutPostDate === "" ? null : dayOf(detail.showOutPostDate, `${at}.showOutPostDate`),
        amount: cardAmount(detail.showOutAmt, `${at}.showOutAmt`),
        currency: currencyCode(detail.showOutCurrency, `${at}.showOutCurrency`, CURRENCY_ALIASES),
        identity: description ?? "",
        description,
        statementKey: bill.period,
      };
    }));
}

function realtimeRows(value: SourceRecord | null): CardRow[] {
  if (value === null) return [];
  const path = CARD_PATH.realtime;
  return records(value.fmtRealTxListMap, `${path}.fmtRealTxListMap`).flatMap((group, groupIndex) => {
    const card = cardOf(group.cardname);
    const rows = group.txlist;
    if (!Array.isArray(rows)) return fail("unexpected-response", `${path}.fmtRealTxListMap[${groupIndex}].txlist is not a list`);
    return rows.flatMap((row: unknown, index): CardRow[] => {
      const at = `${path}.fmtRealTxListMap[${groupIndex}].txlist[${index}]`;
      if (!Array.isArray(row) || row.length < 7) return fail("unexpected-response", `${at} is not a seven-column row`);
      // The official page counts only an exact 成功; 未成功, declined, and cancelled rows are no spending.
      if (typeof row[5] !== "string" || row[5].trim() !== "成功") return [];
      const time = optionalText(row[1]);
      return [{
        feed: "pending",
        card,
        consumedAt: localDate(time === null ? row[0] : `${text(row[0], `${at}[0]`)} ${time}`, `${at}[0..1]`),
        postingDate: null,
        amount: cardAmount(row[3], `${at}[3]`),
        currency: CARD_STATEMENT_CURRENCY,
        identity: plainText(row[2]) ?? "",
        description: plainText(row[6]) ?? plainText(row[2]),
        statementKey: null,
      }];
    });
  });
}

function unbilledRows(value: SourceRecord | null): CardRow[] {
  if (value === null) return [];
  const path = CARD_PATH.unbilled;
  const groups = Array.isArray(value.unpostedTx) && value.unpostedTx.length === 0 ? {} : record(value.unpostedTx, `${path}.unpostedTx`);
  return Object.entries(groups).flatMap(([key, entry]) => {
    const field = `${path}.unpostedTx[${key}]`;
    const group = record(entry, field);
    const message = errorMessage(group.ErrMsg);
    if (message === NO_CONSUMPTION) return [];
    if (message !== null) return fail("incomplete-data", `${field} could not be read`);
    const currency = currencyCode(/^(?:\d{3})?([A-Z]{3})$/u.exec(key)?.[1], `${field} key`);
    return records(group.data, `${field}.data`).flatMap((cardGroup, groupIndex) => {
      const card = cardOf(cardGroup.cardname);
      const rows = cardGroup.txlist;
      if (!Array.isArray(rows)) return fail("unexpected-response", `${field}.data[${groupIndex}].txlist is not a list`);
      return rows.map((row: unknown, index): CardRow => {
        const at = `${field}.data[${groupIndex}].txlist[${index}]`;
        if (!Array.isArray(row) || row.length < 8) return fail("unexpected-response", `${at} is not an eight-column row`);
        if (optionalText(row[7]) !== null && currencyCode(row[7], `${at}[7]`, CURRENCY_ALIASES) !== currency)
          return fail("unexpected-response", `${at}[7] does not match its currency group`);
        const description = plainText(row[2]);
        return {
          feed: "unbilled",
          card,
          consumedAt: localDate(row[0], `${at}[0]`),
          postingDate: dayOf(row[1], `${at}[1]`),
          amount: cardAmount(row[3], `${at}[3]`),
          currency,
          identity: description ?? "",
          description,
          statementKey: null,
        };
      });
    });
  });
}

const rowIdentity = (row: CardRow) =>
  [row.card?.sourceCardKey ?? "-", row.consumedAt.value.slice(0, 10), row.currency, amountKey(row.amount), row.identity].join("\u0000");

/** A row the latest bill already lists is the same purchase, not a second one, so its unbilled copy is dropped. */
function withoutBilledCopies(unbilled: readonly CardRow[], billed: readonly CardRow[]): CardRow[] {
  const remaining = new Map<string, number>();
  for (const row of billed) remaining.set(rowIdentity(row), (remaining.get(rowIdentity(row)) ?? 0) + 1);
  return unbilled.filter((row) => {
    const left = remaining.get(rowIdentity(row)) ?? 0;
    if (left === 0) return true;
    remaining.set(rowIdentity(row), left - 1);
    return false;
  });
}

/**
 * Keys and directions need the whole collection: identical rows take an
 * occurrence count, and the sign gives the direction only when both signs occur.
 */
function purchases(rows: readonly CardRow[]): { row: CardRow; purchase: PreviewPurchase }[] {
  // A zero row moves no money (such as a card-verification authorization), and the store refuses it.
  const moving = rows.filter((row) => !isZeroDecimal(row.amount));
  const signed = moving.some((row) => row.amount.startsWith("-")) && moving.some((row) => !row.amount.startsWith("-"));
  const occurrences = new Map<string, number>();
  return moving.map((row) => {
    const base = [row.feed, row.statementKey ?? "-", row.card?.sourceCardKey ?? "-", row.consumedAt.value, row.currency, amountKey(row.amount),
      createHash("sha256").update(row.identity).digest("hex").slice(0, 12)].join(":");
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    return {
      row,
      purchase: {
        sourceRowKey: `${base}:${occurrence}`,
        amount: row.amount,
        currency: row.currency,
        direction: signed ? row.amount.startsWith("-") ? "inflow" : "outflow" : "unknown",
        posting: row.feed === "pending" ? { status: "pending" } : { status: "posted", billing: row.feed, postingDate: row.postingDate },
        consumedAt: row.consumedAt,
        sourceCardKey: row.card?.sourceCardKey ?? null,
        statementKey: row.statementKey,
        bankReference: null,
        description: row.description,
      },
    };
  });
}

function previousPeriod(period: string): string {
  const [year, month] = period.split("-").map(Number) as [number, number];
  return month === 1 ? `${year - 1}-12` : periodLabel({ year, month: month - 1 });
}

/** A statement needs the previous month's closing date for its cycle start, and a due date that is a date. */
function statement(bill: Bill, previous: Bill | undefined, paidAmount: string | null): PreviewStatement | null {
  const field = `bill[${bill.period}]`;
  const closingDate = dayOf(bill.value.showStmtDate, `${field}.showStmtDate`);
  const due = optionalText(bill.value.showDueDate);
  if (previous === undefined || due === null || !/^\d{4}[-/]?\d{1,2}[-/]?\d{1,2}$/u.test(due)) return null;
  return {
    statementKey: bill.period,
    cycleStart: shiftDay(dayOf(previous.value.showStmtDate, `bill[${previous.period}].showStmtDate`), 1),
    cycleEnd: closingDate,
    closingDate,
    dueDate: dayOf(due, `${field}.showDueDate`),
    amount: cardAmount(bill.value.showCbalance, `${field}.showCbalance`),
    currency: CARD_STATEMENT_CURRENCY,
    minimumPayment: optionalText(bill.value.showMinPay) === null ? null : cardAmount(bill.value.showMinPay, `${field}.showMinPay`),
    billingPeriod: bill.period,
    paidAmount,
    paid: null,
    noPaymentNeeded: null,
  };
}

async function creditCards(api: Client, collectedAt: string): Promise<PreviewCreditCollection | PreviewProductAbsence> {
  try {
    return await readCreditCards(api, collectedAt);
  } catch (error) {
    if (error instanceof NoCreditCard) return { absent: "not_held" };
    throw error;
  }
}

async function readCreditCards(api: Client, collectedAt: string): Promise<PreviewCreditCollection> {
  const summary = (await cardCall(api, CARD_PATH.summary, {})).value!;
  const org = CARD_ORGS.find((candidate) => summary[candidate] !== null && typeof summary[candidate] === "object");
  if (org === undefined) return fail("unexpected-response", `${CARD_PATH.summary} lists no card ledger`);
  const ledger = record(summary[org], `${CARD_PATH.summary}.${org}`);
  const lastStatement = /^(\d{4})(\d{2})\d{2}$/u.exec(text(ledger["OUT-DTE-LST-STMT"], `${CARD_PATH.summary}.OUT-DTE-LST-STMT`));
  if (!lastStatement) return fail("unexpected-response", `${CARD_PATH.summary}.OUT-DTE-LST-STMT is not a date`);
  const months = Array.from({ length: BILL_MONTHS }, (_, index) => {
    const date = new Date(Date.UTC(Number(lastStatement[1]), Number(lastStatement[2]) - 1 - index, 1));
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
  });

  // The official page opens the current bill and the overview before the purchase lists.
  const current = await readBill(api, org, months[0]!);
  if (current === null) return fail("unexpected-response", `no bill for the last statement month ${periodLabel(months[0]!)}`);
  const overview = (await cardCall(api, CARD_PATH.overview, {})).value!;
  const paying = record(record(overview.carInfoList, `${CARD_PATH.overview}.carInfoList`)[org], `${CARD_PATH.overview}.carInfoList.${org}`);
  const overviewPeriod = sourcePeriod(`${text(paying.BillYear, "BillYear")}/${text(paying.BillMon, "BillMon")}`, `${CARD_PATH.overview}.BillYear/BillMon`);
  if (overviewPeriod !== current.period) return fail("unexpected-response", `the payment overview is for ${overviewPeriod}, not the current bill ${current.period}`);
  const statementAmount = cardAmount(paying.StmtBalance, `${CARD_PATH.overview}.StmtBalance`);
  const paidAmount = cardAmount(paying.LstPymtAmt, `${CARD_PATH.overview}.LstPymtAmt`);
  if (paidAmount.startsWith("-")) return fail("unexpected-response", `${CARD_PATH.overview}.LstPymtAmt is negative`);

  const realtime = await cardCall(api, CARD_PATH.realtime, "", true);
  const unbilled = await cardCall(api, CARD_PATH.unbilled, "", true);
  const subtotal = unbilled.value?.showRB0712_SUBTOTAL;
  if (subtotal === undefined || subtotal === null || subtotal === "")
    return fail("unexpected-response", `${CARD_PATH.unbilled}.showRB0712_SUBTOTAL is missing`);
  const unbilledAmount = subtotal === NO_CONSUMPTION ? "0" : cardAmount(subtotal, `${CARD_PATH.unbilled}.showRB0712_SUBTOTAL`);

  const bills = [current];
  for (const month of months.slice(1)) {
    const bill = await readBill(api, org, month);
    if (bill !== null) bills.push(bill);
  }
  const billed = bills.flatMap(billRows);
  const rows = [...realtimeRows(realtime.value), ...withoutBilledCopies(unbilledRows(unbilled.value), billed), ...billed];
  const statements = bills.flatMap((bill) => {
    const previous = bills.find((candidate) => candidate.period === previousPeriod(bill.period));
    const written = statement(bill, previous, bill === current ? paidAmount : null);
    return written === null ? [] : [written];
  });

  // Unbilled foreign-currency groups are not in the NT-dollar subtotal, so each is its own account with no known used credit.
  const accountOf = (row: CardRow) => row.feed === "unbilled" ? row.currency : CARD_STATEMENT_CURRENCY;
  const keyed = purchases(rows);
  const currencies = [CARD_STATEMENT_CURRENCY, ...new Set(rows.map(accountOf).filter((code) => code !== CARD_STATEMENT_CURRENCY))];
  return {
    collectedAt,
    accounts: currencies.map((currency): PreviewCreditAccount => {
      const accountPurchases = keyed.filter(({ row }) => accountOf(row) === currency).map(({ purchase }) => purchase);
      const cards = new Map(rows.filter((row) => accountOf(row) === currency)
        .flatMap((row) => row.card === null ? [] : [[row.card.sourceCardKey, row.card] as const]));
      const account = { sourceAccountKey: `cards:${currency}`, currency, cards: [...cards.values()], purchases: accountPurchases };
      if (currency !== CARD_STATEMENT_CURRENCY)
        return { ...account, displayLabel: `台新銀行 信用卡 ${currency}`, creditLimit: null, balances: [], statements: [] };
      return {
        ...account,
        displayLabel: "台新銀行 信用卡",
        creditLimit: ledger["OUT-CRLIMIT-PERM"] === undefined ? null : cardAmount(ledger["OUT-CRLIMIT-PERM"], `${CARD_PATH.summary}.OUT-CRLIMIT-PERM`),
        balances: [{
          amount: decimalSum([[1, statementAmount], [-1, paidAmount], [1, unbilledAmount]]),
          currency,
          observedAt: observedAt(unbilled.date, collectedAt),
          basis: { kind: "statement-minus-paid-plus-unbilled", statementAmount, paidAmount, unbilledAmount },
        }],
        statements,
      };
    }),
  };
}

async function signIn(api: Client, form: TaishinLoginForm, solve: PreviewCaptchaSolver, context: PreviewWorkflowContext, credentials: TaishinCredentials) {
  const answer = await solveChallengeRound(context, solve, () => form.captcha(), 1);
  const dialog = await form.submit(credentials, answer);
  if (dialog !== null) classifyLoginDialog(dialog);
  if (!await hasSession(api)) fail("unexpected-response", "the login outcome is unknown: sessioncheck shows no session");
}

async function hasSession(api: Client): Promise<boolean> {
  const session = (await api.raw("/web/common/sessioncheck", {})).payload;
  return session.RESULT !== "EXPIRED" && optionalText(session.DBSESSIONID) !== null;
}

async function assertSession(api: Client): Promise<void> {
  if (!await hasSession(api)) fail("session-conflict", "sessioncheck shows the session ended");
}

export function createTaishinSource(options: Readonly<{
  open?: TaishinSessionOpener;
  solveCaptcha?: PreviewCaptchaSolver;
}> = {}): PreviewSource {
  const open = options.open ?? taishinBrowserSession;
  const solve = options.solveCaptcha ?? calibratedCaptchaSolver(TAISHIN_CAPTCHA_FAMILY);
  return {
    id: "taishin-deposit",
    institution: PREVIEW_SOURCE_INSTITUTIONS["taishin-deposit"],
    products: ["deposit", "credit_card"],
    displayName: { en: "Taishin Bank deposits and credit cards (preview)", "zh-TW": "台新銀行存款與信用卡（預覽）" },
    searchAliases: ["Taishin", "Taishin Bank", "台新", "台新銀行", "Richart"],
    credentialFields: [
      { key: KEY.idNumber, label: { en: "Taiwan ID number", "zh-TW": "身分證字號" }, input: "text", redaction: "partial" },
      { key: KEY.userCode, label: { en: "User code", "zh-TW": "使用者代碼" }, input: "text", redaction: "partial" },
      { key: KEY.password, label: { en: "Password", "zh-TW": "使用者密碼" }, input: "password", redaction: "full" },
    ],
    setupGuide: {
      summary: {
        en: "Preview source, never run against a live Taishin account. Its data may be incomplete or wrong. An on-device solver reads Taishin's image CAPTCHA. When it cannot read the image, the run stops before signing in.",
        "zh-TW": "預覽來源，從未以真實的台新銀行帳戶執行過，資料可能不完整或有誤。台新網路銀行的圖形驗證碼由裝置上的解題器辨識；無法辨識時，執行會在登入前停止。",
      },
      requirements: [{ en: "A Taishin online-banking (網路銀行) login.", "zh-TW": "可登入台新網路銀行的帳號。" }],
      steps: [{ en: "Enter the ID number, user code, and password you use to sign in to Taishin online banking.", "zh-TW": "輸入登入台新網路銀行使用的身分證字號、使用者代碼與使用者密碼。" }],
      links: [{
        id: "taishin-online-banking",
        label: { en: "Taishin online banking", "zh-TW": "台新網路銀行" },
        url: RWD_URL,
        allowedHosts: ["my.taishinbank.com.tw"],
      }],
    },
    sessionTakeover: {
      notice: {
        en: "Taishin online banking may allow one session at a time. A sync may fail while you are signed in elsewhere, or may end your Taishin or Richart App session. This is not yet confirmed.",
        "zh-TW": "台新網路銀行可能同一時間只允許一處登入。你在其他地方登入時同步可能失敗，也可能讓台新或 Richart App 登出。此行為尚未確認。",
      },
    },
    startUrl: RWD_URL,
    async run(context, input) {
      await context.event("authentication", "started", "authentication-started");
      return open(context, input.startUrl, async ({ http, form }) => {
        const api = client(context, http);
        await signIn(api, form, solve, context, {
          idNumber: input.credentials[KEY.idNumber] ?? "",
          userCode: input.credentials[KEY.userCode] ?? "",
          password: input.credentials[KEY.password] ?? "",
        });
        await context.event("authentication", "completed", "authentication-completed");
        await context.event("collection", "started", "collection-started");
        const collectedAt = context.now();
        const output = await context.preview.collect({
          deposit: async () => ({ collectedAt, accounts: [...await twdAccounts(api, collectedAt), ...await fxAccounts(api, collectedAt)] }),
          credit_card: () => creditCards(api, collectedAt),
        }, { assertSession: () => assertSession(api) });
        await context.event("collection", "completed", "collection-completed");
        return output;
      });
    },
  };
}

export const TAISHIN_PREVIEW_SOURCE = createTaishinSource();
