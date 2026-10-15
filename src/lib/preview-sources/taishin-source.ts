import type { PreviewAccount, PreviewTransaction } from "../../ledger/pglite/preview-financial-data.ts";
import { browserHttp, type PreviewHttp, type PreviewHttpOpener } from "./browser-http.ts";
import type { PreviewSource } from "./registry.ts";
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
  refuseUnsupportedVerification,
  taipeiMonthWindow,
  text,
  type PreviewCaptchaChallenge,
  type PreviewCaptchaSolver,
  type SourceRecord,
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
 * any dialog the page raised (null when none). No production driver exists yet.
 */
export type TaishinLoginForm = Readonly<{
  captcha(): Promise<PreviewCaptchaChallenge>;
  submit(credentials: TaishinCredentials, captcha: string): Promise<string | null>;
}>;

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

function uniqueTransactions(rows: readonly PreviewTransaction[]): PreviewTransaction[] {
  const byKey = new Map<string, PreviewTransaction>();
  for (const row of rows) {
    const previous = byKey.get(row.sourceRowKey);
    if (previous && JSON.stringify(previous) !== JSON.stringify(row)) return fail("unexpected-response", "a row key repeats with different content");
    byKey.set(row.sourceRowKey, row);
  }
  return [...byKey.values()];
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
      transactions: uniqueTransactions(rows.map((row, rowIndex) => twdTransaction(row, `rb0102.userList[${rowIndex}]`, currency))),
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
      transactions: uniqueTransactions(rows.map((row, index) => fxTransaction(row, `rb0802.TRANS_DETAILS[${index}]`, currency))),
    });
  }
  return accounts;
}

async function signIn(api: Client, form: TaishinLoginForm, solve: PreviewCaptchaSolver, context: PreviewWorkflowContext, credentials: TaishinCredentials) {
  const answer = await solve(context, await form.captcha());
  const dialog = await form.submit(credentials, answer);
  if (dialog !== null) classifyLoginDialog(dialog);
  const path = "/web/common/sessioncheck";
  const session = (await api.raw(path, {})).payload;
  if (session.RESULT === "EXPIRED" || optionalText(session.DBSESSIONID) === null) fail("unexpected-response", "the login outcome is unknown: sessioncheck shows no session");
}

export function createTaishinSource(options: Readonly<{
  http?: PreviewHttpOpener;
  solveCaptcha?: PreviewCaptchaSolver;
  loginForm?: TaishinLoginForm;
}> = {}): PreviewSource {
  const open = options.http ?? browserHttp;
  return {
    id: "taishin-deposit",
    institution: "bank-812",
    product: "deposit",
    displayName: { en: "Taishin Bank deposits (preview)", "zh-TW": "台新銀行存款（預覽）" },
    searchAliases: ["Taishin", "Taishin Bank", "台新", "台新銀行", "Richart"],
    credentialFields: [
      { key: KEY.idNumber, label: { en: "Taiwan ID number", "zh-TW": "身分證字號" }, input: "text", redaction: "partial" },
      { key: KEY.userCode, label: { en: "User code", "zh-TW": "使用者代碼" }, input: "text", redaction: "partial" },
      { key: KEY.password, label: { en: "Password", "zh-TW": "使用者密碼" }, input: "password", redaction: "full" },
    ],
    setupGuide: {
      summary: {
        en: "Preview source, never run against a live Taishin account. Its data may be incomplete or wrong. Taishin's online-banking sign-in needs an image CAPTCHA that no on-device solver supports yet, so runs stop at sign-in.",
        "zh-TW": "預覽來源，從未以真實的台新銀行帳戶執行過，資料可能不完整或有誤。台新網路銀行登入需要圖形驗證碼，目前沒有裝置上的解題器支援，因此執行會在登入時停止。",
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
    sessionTakeoverNotice: {
      en: "Taishin online banking may allow one session at a time. A sync may fail while you are signed in elsewhere, or may end your Taishin or Richart App session. This is not yet confirmed.",
      "zh-TW": "台新網路銀行可能同一時間只允許一處登入。你在其他地方登入時同步可能失敗，也可能讓台新或 Richart App 登出。此行為尚未確認。",
    },
    startUrl: RWD_URL,
    async run(context, input) {
      await context.event("authentication", "authentication-started");
      const { solveCaptcha: solve, loginForm: form } = options;
      if (!solve || !form) return refuseUnsupportedVerification(context, "taishin-image-captcha");
      return open(context, { pageUrl: input.startUrl }, async (http) => {
        const api = client(context, http);
        await signIn(api, form, solve, context, {
          idNumber: input.credentials[KEY.idNumber] ?? "",
          userCode: input.credentials[KEY.userCode] ?? "",
          password: input.credentials[KEY.password] ?? "",
        });
        await context.event("authentication", "authentication-completed");
        await context.event("collection", "collection-started");
        const collectedAt = context.now();
        const accounts = [...await twdAccounts(api, collectedAt), ...await fxAccounts(api, collectedAt)];
        await context.event("collection", "collection-completed");
        return await context.preview.write({ collectedAt, accounts });
      });
    },
  };
}

export const TAISHIN_PREVIEW_SOURCE = createTaishinSource();
