import { createHash } from "node:crypto";
import type { PreviewAccount, PreviewBalanceObservation, PreviewTransaction } from "../../ledger/pglite/preview-financial-data.ts";
import { SourceUnavailableError } from "../automation/source-access.ts";
import { FIRSTBANK_LOGIN_URL, playwrightFirstbankPage } from "./firstbank-page.ts";
import type { PreviewSource } from "./registry.ts";
import { PREVIEW_SOURCE_INSTITUTIONS } from "./source-id.ts";
import {
  currencyCode,
  exactDecimal,
  fail,
  isZeroDecimal,
  localDate,
  observedAt,
  refuseUnsupportedVerification,
  requireDeviceRegistration,
  solveChallengeRound,
  taipeiMonthWindow,
  type PreviewCaptchaSolver,
} from "./source-kit.ts";
import type { PreviewWorkflowContext } from "./workflow.ts";

const MONTHS = 3;
const CAPTCHA_LENGTH = 4;
// all-set-tw queries at most ten accounts; more than that is treated as a list this source cannot read whole.
const MAX_QUERY_ACCOUNTS = 10;
const OVERVIEW = "acntReview1";
const HISTORY = "010103";
const CURRENCY_ALIASES: Readonly<Record<string, string>> = {
  NTD: "TWD", "NT$": "TWD", "新臺幣": "TWD", "新台幣": "TWD", "臺幣": "TWD", "台幣": "TWD",
  "美元": "USD", "美金": "USD", "日圓": "JPY", "日元": "JPY", "日幣": "JPY", "歐元": "EUR", "人民幣": "CNY",
  "港幣": "HKD", "港元": "HKD", "澳幣": "AUD", "英鎊": "GBP", "加幣": "CAD", "加拿大幣": "CAD", "瑞士法郎": "CHF",
  "新加坡幣": "SGD", "紐幣": "NZD", "紐西蘭幣": "NZD", "南非幣": "ZAR", "瑞典幣": "SEK", "泰銖": "THB",
};

const KEY = {
  idNumber: "PREVIEW_FIRSTBANK_DEPOSIT_ID_NUMBER",
  userCode: "PREVIEW_FIRSTBANK_DEPOSIT_USER_CODE",
  password: "PREVIEW_FIRSTBANK_DEPOSIT_PASSWORD",
} as const;

/** One HTML response the site's own page loaded: the deposit overview or a transaction history. */
export type FirstbankCapture = Readonly<{ endpoint: string; status: number; date: string | null; text: string }>;

export type FirstbankSignInOutcome =
  | Readonly<{ kind: "signed-in" }>
  | Readonly<{ kind: "refused"; message: string }>
  | Readonly<{ kind: "no-outcome" }>;

export type FirstbankQueryAccount = Readonly<{ value: string; label: string }>;

export type FirstbankCredentials = Readonly<{ idNumber: string; userCode: string; password: string; captcha: string }>;

/** First Bank's web banking renders server-side HTML in frames, so the source drives the page and reads its responses. */
export type FirstbankPage = Readonly<{
  captchaImage(): Promise<Buffer>;
  signIn(credentials: FirstbankCredentials): Promise<FirstbankSignInOutcome>;
  depositOverview(): Promise<FirstbankCapture>;
  queryAccounts(): Promise<readonly FirstbankQueryAccount[]>;
  /** `start` and `end` are Taipei dates as YYYY/MM/DD. */
  transactions(account: FirstbankQueryAccount, range: Readonly<{ start: string; end: string }>): Promise<FirstbankCapture>;
  signOut(): Promise<void>;
}>;

export type FirstbankPageOpener = <T>(context: PreviewWorkflowContext, startUrl: string, use: (page: FirstbankPage) => Promise<T>) => Promise<T>;

const OTHER_SESSION = /MULTI_SESSION_LOGIN|重[複覆]登入|前次連線|duplicate login|previous log ?out|已登入.*無法操作|無法操作.*已登入|未正常登出|未完成.{0,6}登出|目前已有登入|使用者已登入|帳號已在.{0,12}登入/iu;

async function signInFailure(context: PreviewWorkflowContext, outcome: FirstbankSignInOutcome): Promise<never> {
  if (outcome.kind !== "refused") return fail("unexpected-response", "the sign-in outcome was not readable");
  const message = outcome.message;
  if (OTHER_SESSION.test(message)) return fail("session-conflict", "signed in elsewhere");
  if (/驗證碼|請正確的點擊登入按鈕/u.test(message)) return fail("verification-rejected", "CAPTCHA rejected");
  if (/簡訊|OTP|裝置綁定|裝置認證|約定/iu.test(message)) return requireDeviceRegistration(context, "First Bank asks to verify this device");
  if (/密碼|代號|身分證|統編|帳號密碼不符|錯誤次數/u.test(message)) return fail("sign-in-rejected", "credentials rejected");
  if (/維護/u.test(message)) throw new SourceUnavailableError();
  return fail("unexpected-response", "the sign-in message was not recognized");
}

type HtmlRow = Readonly<{ rowClass: string; cells: readonly string[] }>;

const ENTITIES: Readonly<Record<string, string>> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function plainText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/giu, (entity, decimal?: string, hex?: string, name?: string) =>
      decimal ? String.fromCodePoint(Number(decimal)) : hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : ENTITIES[name!.toLowerCase()] ?? entity)
    .replace(/[\s\u00a0\u3000]+/gu, " ")
    .trim();
}

function htmlRows(html: string): HtmlRow[] {
  return [...html.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/giu)].map(([, attributes = "", body = ""]) => ({
    rowClass: /\bclass\s*=\s*["']([^"']*)["']/iu.exec(attributes)?.[1]?.trim() ?? "",
    cells: [...body.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/giu)].map(([, cell = ""]) => plainText(cell)),
  }));
}

const isResultRow = (row: HtmlRow) => /(?:^|\s)ResultContent(?:\s|$)/iu.test(row.rowClass);
const isBlank = (value: string | undefined) => value === undefined || /^[\s\-—–－﹣]*$/u.test(value);
const NO_DATA = /查無(?:資料|符合)|無符合資料|沒有資料|no\s+data|no\s+records?/iu;
// Not observed on First Bank: any next-page or row-limit notice means the page shows a partial list.
const TRUNCATED = /下一頁|下頁|次頁|更多資料|超過\s*\d*\s*筆|僅(?:顯示|提供)\s*\d*\s*筆|next\s+page/iu;

const label = (cell: string) => cell.toLowerCase().replace(/[\s:：()（）【】「」、,./\\_-]+/gu, "");
const column = (labels: readonly string[], patterns: readonly RegExp[]) => {
  const index = labels.findIndex((candidate) => patterns.some((pattern) => pattern.test(candidate)));
  return index >= 0 ? index : undefined;
};

const ACCOUNT_RUN = /(?<!\d)\d[\d*Xx#\-\s]{4,}\d(?!\d)/gu;

/** The account number in a cell or option text, kept with its mask characters and without separators. */
function accountIdentity(value: string): string | null {
  const candidates = (value.match(ACCOUNT_RUN) ?? []).filter((run) => run.replace(/\D/gu, "").length >= 6);
  const longest = candidates.sort((left, right) => right.length - left.length)[0];
  return longest ? longest.replace(/[\s-]/gu, "").toUpperCase() : null;
}

function observeTable(context: PreviewWorkflowContext, capture: FirstbankCapture, expected: string): Readonly<{ rows: HtmlRow[]; text: string }> {
  const rows = htmlRows(capture.text);
  context.preview.observe({ endpoint: capture.endpoint, status: capture.status, body: { rows } });
  if (!capture.endpoint.includes(expected)) return fail("unexpected-response", `expected ${expected}, captured ${capture.endpoint}`);
  if (capture.status < 200 || capture.status >= 300) return fail("unexpected-response", `${expected} answered HTTP ${capture.status}`);
  const text = plainText(capture.text);
  if (TRUNCATED.test(text)) return fail("incomplete-data", `${expected} shows a next-page or row-limit notice`);
  return { rows, text };
}

/** Each header row with the result rows that follow it, up to the next header. */
function sections<T>(rows: readonly HtmlRow[], header: (labels: readonly string[]) => T | undefined): { header: T; rows: HtmlRow[] }[] {
  const found: { header: T; rows: HtmlRow[] }[] = [];
  for (const row of rows) {
    const parsed = header(row.cells.map(label));
    if (parsed !== undefined) found.push({ header: parsed, rows: [] });
    else found.at(-1)?.rows.push(row);
  }
  return found;
}

type OverviewHeader = Readonly<{ account: number; currency: number; balance: number; available: number | undefined; type: number | undefined }>;

function overviewHeader(labels: readonly string[]): OverviewHeader | undefined {
  const account = column(labels, [/帳號/, /帳戶號碼/, /^account(?:no|number)?(?:and)?(?:nickname)?$/]);
  const currency = column(labels, [/幣別/, /^currency$/, /^ccy$/]);
  const balance = column(labels, [/帳面餘額/, /存款餘額/, /^餘額$/, /ledger(?:book)?balance/, /bookbalance/, /^balance$/]);
  if (account === undefined || currency === undefined || balance === undefined) return undefined;
  return {
    account,
    currency,
    balance,
    available: column(labels, [/可用餘額/, /可動用/, /^available(?:balance)?$/]),
    type: column(labels, [/帳戶類別/, /帳戶類型/, /帳別/, /^accounttype$/, /accountcategory/]),
  };
}

type DepositEntry = Readonly<{
  identity: string;
  nickname: string | null;
  term: boolean;
  currency: string;
  balance: string;
  available: string | null;
}>;

function nicknameFrom(cell: string): string | null {
  const rest = cell.replace(ACCOUNT_RUN, " ").replace(/[()（）【】[\]：:|]/gu, " ").replace(/\s+/gu, " ").trim();
  return isBlank(rest) ? null : rest;
}

function depositEntries(rows: readonly HtmlRow[], text: string): DepositEntry[] {
  const found = sections(rows, overviewHeader);
  if (found.length === 0) return NO_DATA.test(text) ? [] : fail("unexpected-response", `${OVERVIEW} has no deposit table header`);
  const entries = new Map<string, DepositEntry>();
  for (const [sectionIndex, section] of found.entries()) {
    const { header } = section;
    for (const [rowIndex, row] of section.rows.entries()) {
      const field = `${OVERVIEW}.table[${sectionIndex}].row[${rowIndex}]`;
      const accountCell = row.cells[header.account] ?? "";
      const identity = accountIdentity(accountCell);
      if (identity === null) continue;
      const typeCell = header.type === undefined ? "" : row.cells[header.type] ?? "";
      if (/信用卡|金融卡|visa|master|credit/iu.test(typeCell)) continue;
      const currencyCell = row.cells[header.currency];
      const balanceCell = row.cells[header.balance];
      // all-set-tw: card rows carry the account but a dash for currency and balance.
      if (isBlank(currencyCell) && isBlank(balanceCell)) continue;
      const availableCell = header.available === undefined ? undefined : row.cells[header.available];
      const entry: DepositEntry = {
        identity,
        nickname: nicknameFrom(accountCell),
        term: /定存|定期|存單|time\s*deposit/iu.test(typeCell),
        currency: currencyCode(currencyCell, `${field}.currency`, CURRENCY_ALIASES),
        balance: exactDecimal(balanceCell, `${field}.balance`),
        available: isBlank(availableCell) ? null : exactDecimal(availableCell, `${field}.available`),
      };
      const key = `${identity}:${entry.currency}`;
      const previous = entries.get(key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) return fail("unexpected-response", `${OVERVIEW} repeats an account and currency with different content`);
      entries.set(key, entry);
    }
  }
  return [...entries.values()];
}

type HistoryHeader = Readonly<{
  date: number;
  debit: number | undefined;
  credit: number | undefined;
  amount: number | undefined;
  balance: number | undefined;
  currency: number | undefined;
  descriptions: readonly number[];
}>;

function historyHeader(labels: readonly string[]): HistoryHeader | undefined {
  const date = column(labels, [/交易日期/, /交易日/, /^日期$/, /transactiondate/, /txndate/, /^date$/]);
  if (date === undefined) return undefined;
  const debit = column(labels, [/支出/, /提款/, /^withdraw(?:al)?(?:amount)?$/, /^debit(?:amount)?$/]);
  const credit = column(labels, [/存入/, /^deposit(?:amount)?$/, /^credit(?:amount)?$/]);
  const amount = column(labels, [/交易金額/, /^金額$/, /transactionamount/, /^amount$/]);
  if (debit === undefined && credit === undefined && amount === undefined) return undefined;
  const descriptions = [
    column(labels, [/摘要/, /^summary$/, /^particulars?$/]),
    column(labels, [/備註/, /說明/, /^memo$/, /^remarks?$/, /^description$/]),
    column(labels, [/交易類別/, /^類別$/, /交易種類/, /transactiontype/]),
  ].filter((index): index is number => index !== undefined);
  return {
    date,
    debit,
    credit,
    amount,
    balance: column(labels, [/餘額/, /結餘/, /^balance$/]),
    currency: column(labels, [/幣別/, /^currency$/, /^ccy$/]),
    descriptions,
  };
}

/** First Bank shows dates as YYYY/MM/DD or the ROC year (115/10/03), optionally with a time. */
function firstbankDate(value: string | undefined, field: string) {
  const match = /^(\d{3,4})[/.-](\d{1,2})[/.-](\d{1,2})(.*)$/u.exec(value?.trim() ?? "");
  if (!match) return localDate(value, field);
  const [, year, month, day, rest] = match as unknown as [string, string, string, string, string];
  const gregorian = year.length === 3 ? String(Number(year) + 1911) : year;
  return localDate(`${gregorian}/${month.padStart(2, "0")}/${day.padStart(2, "0")}${rest}`, field);
}

type HistoryRow = Readonly<{ currency: string | null; transaction: Omit<PreviewTransaction, "currency"> }>;

function side(cell: string | undefined, field: string): string | null {
  if (isBlank(cell)) return null;
  const amount = exactDecimal(cell, field);
  return isZeroDecimal(amount) ? null : amount;
}

function historyRows(rows: readonly HtmlRow[], text: string, field: string): HistoryRow[] {
  const found = sections(rows, historyHeader);
  if (found.length === 0) return NO_DATA.test(text) ? [] : fail("unexpected-response", `${field} has no transaction table header`);
  const occurrences = new Map<string, number>();
  const parsed: HistoryRow[] = [];
  for (const [sectionIndex, section] of found.entries()) {
    const { header } = section;
    for (const [rowIndex, row] of section.rows.entries()) {
      if (!isResultRow(row)) continue;
      if (row.cells.length === 1 && NO_DATA.test(row.cells[0] ?? "")) continue;
      const rowField = `${field}.table[${sectionIndex}].row[${rowIndex}]`;
      const postedAt = firstbankDate(row.cells[header.date], `${rowField}.date`);
      const debit = header.debit === undefined ? null : side(row.cells[header.debit], `${rowField}.debit`);
      const credit = header.credit === undefined ? null : side(row.cells[header.credit], `${rowField}.credit`);
      let amount: string;
      let direction: PreviewTransaction["direction"];
      if (header.debit !== undefined || header.credit !== undefined) {
        if ((debit === null) === (credit === null)) return fail("unexpected-response", `${rowField} sets both or neither of the debit and credit columns`);
        amount = (credit ?? debit)!;
        direction = credit !== null ? "inflow" : "outflow";
      } else {
        amount = exactDecimal(row.cells[header.amount!], `${rowField}.amount`);
        direction = "unknown";
      }
      const currencyCell = header.currency === undefined ? undefined : row.cells[header.currency];
      const currency = isBlank(currencyCell) ? null : currencyCode(currencyCell, `${rowField}.currency`, CURRENCY_ALIASES);
      const balanceCell = header.balance === undefined ? undefined : row.cells[header.balance];
      const balance = isBlank(balanceCell) ? "" : exactDecimal(balanceCell, `${rowField}.balance`);
      const descriptions = [...new Set(header.descriptions.map((index) => row.cells[index]).filter((cell): cell is string => !isBlank(cell)))];
      // First Bank rows carry no transaction id, so the key is the row's content plus its occurrence order.
      const identity = [postedAt.value, direction, amount, currency ?? "", balance, ...descriptions].join("\u0000");
      const occurrence = (occurrences.get(identity) ?? 0) + 1;
      occurrences.set(identity, occurrence);
      parsed.push({
        currency,
        transaction: {
          sourceRowKey: `${postedAt.value.slice(0, 10)}:${createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 16)}:${occurrence}`,
          amount,
          direction,
          postedAt,
          description: descriptions.length > 0 ? descriptions.join(" · ") : null,
        },
      });
    }
  }
  return parsed;
}

function pageAccountIdentity(text: string): string | null {
  for (const match of text.matchAll(/(?:帳號|帳戶|account(?:\s*(?:no\.?|number))?)\s*[：:]?\s*([^\s，,；;|<]+)/giu)) {
    const identity = accountIdentity(match[1] ?? "");
    if (identity) return identity;
  }
  return null;
}

const slashDate = (date: string) => date.replaceAll("-", "/");

async function collect(context: PreviewWorkflowContext, page: FirstbankPage, collectedAt: string): Promise<PreviewAccount[]> {
  const overviewCapture = await page.depositOverview();
  const overview = observeTable(context, overviewCapture, OVERVIEW);
  const entries = depositEntries(overview.rows, overview.text);
  const options = await page.queryAccounts();
  if (options.length > MAX_QUERY_ACCOUNTS) return fail("incomplete-data", `the transaction query lists ${options.length} accounts, more than ${MAX_QUERY_ACCOUNTS}`);
  const queried = options.map((option, index) => {
    const identity = accountIdentity(option.label);
    if (identity === null || !entries.some((entry) => entry.identity === identity))
      return fail("unexpected-response", `transaction query account ${index} is not in the deposit overview`);
    return { option, identity };
  });
  const missing = entries.find((entry) => !entry.term && !queried.some((query) => query.identity === entry.identity));
  if (missing) return fail("incomplete-data", "a demand deposit account is missing from the transaction query list");

  const window = taipeiMonthWindow(collectedAt, MONTHS);
  const range = { start: slashDate(window.start), end: slashDate(window.end) };
  const transactions = new Map<DepositEntry, PreviewTransaction[]>();
  for (const [index, { option, identity }] of queried.entries()) {
    const field = `${HISTORY}[${index}]`;
    const history = observeTable(context, await page.transactions(option, range), HISTORY);
    const shown = pageAccountIdentity(history.text);
    if (shown !== null && shown !== identity) return fail("unexpected-response", `${field} shows another account than the one queried`);
    const candidates = entries.filter((entry) => entry.identity === identity);
    for (const [rowIndex, row] of historyRows(history.rows, history.text, field).entries()) {
      const currency = row.currency ?? (candidates.length === 1 ? candidates[0]!.currency : fail("missing-currency", `${field} row ${rowIndex} has no currency and its account holds several`));
      const entry = candidates.find((candidate) => candidate.currency === currency)
        ?? fail("unexpected-response", `${field} row ${rowIndex} is in a currency its account does not hold`);
      transactions.set(entry, [...transactions.get(entry) ?? [], { ...row.transaction, currency }]);
    }
  }

  const asOf = observedAt(overviewCapture.date, collectedAt);
  return entries.map((entry) => {
    const balances: PreviewBalanceObservation[] = [{ kind: "current", amount: entry.balance, currency: entry.currency, observedAt: asOf }];
    if (entry.available !== null) balances.push({ kind: "available", amount: entry.available, currency: entry.currency, observedAt: asOf });
    const kind = entry.term ? "term" : "demand";
    return {
      sourceAccountKey: `${kind}:${entry.identity}:${entry.currency}`,
      displayLabel: `第一銀行 ${entry.nickname ?? (entry.term ? "定存" : "存款")} ${entry.identity.slice(-4)}${entry.currency === "TWD" ? "" : ` ${entry.currency}`}`,
      currency: entry.currency,
      type: "depository",
      balances,
      transactions: transactions.get(entry) ?? [],
    };
  });
}

export function createFirstbankSource(options: Readonly<{ page?: FirstbankPageOpener; solveCaptcha?: PreviewCaptchaSolver }> = {}): PreviewSource {
  const open = options.page ?? playwrightFirstbankPage;
  return {
    id: "firstbank-deposit",
    institution: PREVIEW_SOURCE_INSTITUTIONS["firstbank-deposit"],
    products: ["deposit"],
    displayName: { en: "First Bank deposits (preview)", "zh-TW": "第一銀行存款（預覽）" },
    searchAliases: ["First Bank", "First Commercial Bank", "FCB", "第一銀行", "一銀", "第一商業銀行"],
    credentialFields: [
      { key: KEY.idNumber, label: { en: "Taiwan ID number", "zh-TW": "身分證字號" }, input: "text", redaction: "partial" },
      { key: KEY.userCode, label: { en: "User code", "zh-TW": "使用者代號" }, input: "text", redaction: "partial" },
      { key: KEY.password, label: { en: "Password", "zh-TW": "密碼" }, input: "password", redaction: "full" },
    ],
    setupGuide: {
      summary: {
        en: "Preview source, never run against a live First Bank account. Its data may be incomplete or wrong. First Bank's web sign-in needs an image CAPTCHA that no on-device solver supports yet, so runs stop at sign-in.",
        "zh-TW": "預覽來源，從未以真實的第一銀行帳戶執行過，資料可能不完整或有誤。第一銀行網路銀行登入需要圖形驗證碼，目前沒有裝置上的解題器支援，因此執行會在登入時停止。",
      },
      requirements: [{ en: "A First Bank iBank (個人網路銀行) login.", "zh-TW": "可登入第一銀行個人網路銀行的帳號。" }],
      steps: [{ en: "Enter the ID number, user code, and password you use to sign in to First Bank iBank.", "zh-TW": "輸入登入第一銀行個人網路銀行使用的身分證字號、使用者代號與密碼。" }],
      links: [{
        id: "firstbank-ibank",
        label: { en: "First Bank iBank", "zh-TW": "第一銀行個人網路銀行" },
        url: FIRSTBANK_LOGIN_URL,
        allowedHosts: ["ibank.firstbank.com.tw"],
      }],
    },
    sessionTakeoverNotice: {
      en: "First Bank allows one iBank sign-in at a time. A sync fails while you are signed in to iBank elsewhere, and after a sync you may need to wait before signing in again.",
      "zh-TW": "第一銀行個人網路銀行同一時間只允許一處登入。你在其他地方登入時同步會失敗，同步後也可能需要稍候才能再次登入。",
    },
    startUrl: FIRSTBANK_LOGIN_URL,
    async run(context, input) {
      await context.event("authentication", "authentication-started");
      const solve = options.solveCaptcha;
      if (!solve) return refuseUnsupportedVerification(context, "firstbank-image-captcha");
      return open(context, input.startUrl, async (page) => {
        try {
          const captcha = await solveChallengeRound(context, solve, async () =>
            ({ image: await page.captchaImage(), charset: "digits", expectedLength: CAPTCHA_LENGTH }), 1);
          const outcome = await page.signIn({
            idNumber: input.credentials[KEY.idNumber] ?? "",
            userCode: input.credentials[KEY.userCode] ?? "",
            password: input.credentials[KEY.password] ?? "",
            captcha,
          });
          if (outcome.kind !== "signed-in") return await signInFailure(context, outcome);
          await context.event("authentication", "authentication-completed");
          await context.event("collection", "collection-started");
          const collectedAt = context.now();
          const accounts = await collect(context, page, collectedAt);
          await context.event("collection", "collection-completed");
          return await context.preview.collect({ deposit: async () => ({ collectedAt, accounts }) });
        } finally {
          await page.signOut().catch(() => undefined);
        }
      });
    },
  };
}

export const FIRSTBANK_PREVIEW_SOURCE = createFirstbankSource();
