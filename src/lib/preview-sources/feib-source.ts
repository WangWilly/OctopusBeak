import { createHash } from "node:crypto";
import type { PreviewAccount, PreviewTransaction } from "../../ledger/pglite/preview-financial-data.ts";
import { SourceUnavailableError } from "../automation/source-access.ts";
import { FEIB_LOGIN_URL, playwrightFeibPage } from "./feib-page.ts";
import { calibratedCaptchaSolver, FEIB_CAPTCHA_FAMILY } from "./preview-captcha.ts";
import type { PreviewSource } from "./registry.ts";
import { PREVIEW_SOURCE_INSTITUTIONS } from "./source-id.ts";
import {
  currencyCode,
  exactDecimal,
  fail,
  isZeroDecimal,
  localDate,
  observedAt,
  solveChallengeRound,
  taipeiMonthWindow,
  type PreviewCaptchaSolver,
  type PreviewFailureReason,
} from "./source-kit.ts";
import type { PreviewWorkflowContext } from "./workflow.ts";

const MONTHS = 3;
// FEIB's query page refuses a range longer than two months (its checkDate2).
const MAX_RANGE_MONTHS = 2;
const CAPTCHA_LENGTH = 6;
const OVERVIEW = "Login/loginAFT/saving";
const HISTORY = "SavAcctTxDtlInq";
const SIGNED_IN = /com\.lb\.wibc\.trx\.Logout/u;
const CURRENCY_ALIASES: Readonly<Record<string, string>> = {
  NTD: "TWD", "新臺幣": "TWD", "新台幣": "TWD", "臺幣": "TWD", "台幣": "TWD",
  "美金": "USD", "美元": "USD", "日圓": "JPY", "日幣": "JPY", "歐元": "EUR", "人民幣": "CNY", "港幣": "HKD",
  "澳幣": "AUD", "英鎊": "GBP", "加拿大幣": "CAD", "瑞士法郎": "CHF", "新加坡幣": "SGD", "紐西蘭幣": "NZD",
  "南非幣": "ZAR", "瑞典幣": "SEK", "泰銖": "THB",
};
// Not observed on FEIB: any next-page or row-limit notice means the page shows a partial list.
const TRUNCATED = /下一頁|下頁|次頁|更多資料|超過\s*\d*\s*筆|僅(?:顯示|提供)\s*\d*\s*筆/u;

const KEY = {
  idNumber: "PREVIEW_FEIB_DEPOSIT_ID_NUMBER",
  userCode: "PREVIEW_FEIB_DEPOSIT_USER_CODE",
  password: "PREVIEW_FEIB_DEPOSIT_PASSWORD",
} as const;

/** One HTML document the web bank served to the page. */
export type FeibCapture = Readonly<{ status: number; date: string | null; text: string }>;

export type FeibCredentials = Readonly<{ idNumber: string; userCode: string; password: string; captcha: string }>;

export type FeibSignInOutcome = Readonly<
  | { kind: "signed-in" }
  /** The annual password-change reminder replaced the signed-in home page. */
  | { kind: "password-change-prompt" }
  /** The page's own pre-check refused the CAPTCHA and sent no sign-in request. */
  | { kind: "captcha-rejected" }
  /** The page's own pre-check refused another field's format and sent no sign-in request. */
  | { kind: "fields-rejected" }
  | { kind: "refused"; message: string }
  | { kind: "no-outcome" }
>;

/** Both ends are Taipei dates as YYYY/MM/DD. */
export type FeibQueryRange = Readonly<{ start: string; end: string }>;

/**
 * FEIB's personal web bank renders server-side JSP pages and encrypts the
 * sign-in in its own script, so the source drives the page and reads the
 * documents it loads.
 */
export type FeibPage = Readonly<{
  captchaImage(): Promise<Buffer>;
  signIn(credentials: FeibCredentials): Promise<FeibSignInOutcome>;
  /** Follows 「下次登入再變更」 on the password-change reminder; false when no signed-in page follows. */
  postponePasswordChange(): Promise<boolean>;
  depositOverview(): Promise<FeibCapture>;
  transactions(accountNo: string, range: FeibQueryRange): Promise<FeibCapture>;
  signOut(): Promise<void>;
}>;

export type FeibPageOpener = <T>(context: PreviewWorkflowContext, startUrl: string, use: (page: FeibPage) => Promise<T>) => Promise<T>;

/** Ordered: a lock or credential message wins over a CAPTCHA mention in the same text. */
const SIGN_IN_MESSAGES: readonly (readonly [RegExp, PreviewFailureReason | "unavailable"])[] = [
  [/鎖定|停用|暫停使用|凍結|註銷|連續.{0,6}錯誤.{0,6}次/u, "sign-in-rejected"],
  [/(?:密碼|使用者代號|身[分份]證|統一編號|帳號).{0,12}(?:錯誤|有誤|不符|不正確|不存在|無效)/u, "sign-in-rejected"],
  [/重複登入|已登入|其他.{0,8}登入|登入中/u, "session-conflict"],
  [/驗證碼.{0,8}(?:錯誤|有誤|不符|不正確|逾時|失效|過期)/u, "verification-rejected"],
  [/系統維護|維護中|暫停服務|系統忙碌|稍後再試/u, "unavailable"],
];

async function completeSignIn(page: FeibPage, outcome: FeibSignInOutcome): Promise<void> {
  switch (outcome.kind) {
    case "signed-in":
      return;
    case "password-change-prompt":
      if (await page.postponePasswordChange()) return;
      return fail("sign-in-rejected", "FEIB asks for a password change that cannot be postponed");
    case "captcha-rejected":
      return fail("verification-rejected", "the login page refused the CAPTCHA before sign-in");
    case "fields-rejected":
      return fail("sign-in-rejected", "the login page refused the sign-in details' format before sign-in");
    case "no-outcome":
      return fail("unexpected-response", "the sign-in outcome is unknown");
    case "refused": {
      const message = outcome.message.replace(/\s+/gu, "");
      const reason = SIGN_IN_MESSAGES.find(([pattern]) => pattern.test(message))?.[1];
      if (reason === "unavailable") throw new SourceUnavailableError();
      return fail(reason ?? "unexpected-response", reason ? "FEIB refused the sign-in" : "the sign-in message was not recognized");
    }
  }
}

const ENTITIES: Readonly<Record<string, string>> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Comments, scripts, and selects (the 用途 column's options) never count as page content. */
const content = (html: string) =>
  html.replace(/<!--[\s\S]*?-->/gu, " ").replace(/<script\b[\s\S]*?<\/script>/giu, " ").replace(/<select\b[\s\S]*?<\/select>/giu, " ");

function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/gu, " ")
    .replace(/&(?:#(\d+)|([a-z]+));/giu, (entity, decimal?: string, name?: string) =>
      decimal ? String.fromCodePoint(Number(decimal)) : ENTITIES[name!.toLowerCase()] ?? entity)
    .replace(/[\s 　]+/gu, " ")
    .trim();
}

function htmlRows(html: string): string[][] {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)]
    .map(([, body = ""]) => [...body.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/giu)].map(([, cell = ""]) => plainText(cell)));
}

/** The rows after the first header row that names every label, with each label's column. */
function table<L extends string>(html: string, labels: readonly L[], optional: readonly L[] = []) {
  const rows = htmlRows(html);
  const headerAt = rows.findIndex((row) => labels.every((label) => row.includes(label)));
  if (headerAt < 0) return null;
  const header = rows[headerAt]!;
  const columns = Object.fromEntries([...labels, ...optional].map((label) => [label, header.indexOf(label)])) as Record<L, number>;
  return { columns, rows: rows.slice(headerAt + 1).filter((row) => row.length > 0) };
}

const isBlank = (cell: string | undefined) => cell === undefined || /^[\s\-—–－]*$/u.test(cell);
const digits = (value: string) => value.replace(/[０-９]/gu, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0)).replace(/\D/gu, "");

/** `NTD$12,345.67元` and `1,000.00` as exact lexemes. */
function feibAmount(cell: string | undefined, field: string): string {
  const bare = (cell ?? "").replace(/\s/gu, "").replace(/^(?:新臺幣|新台幣|臺幣|台幣)?(?:[A-Z]{2,3})?\$?/u, "").replace(/元$/u, "");
  return exactDecimal(bare, field);
}

/** FEIB shows YYYY/MM/DD; a three-digit year is the ROC year. */
function feibDate(cell: string | undefined, field: string) {
  const match = /^(\d{3,4})[/.-](\d{1,2})[/.-](\d{1,2})$/u.exec(cell?.trim() ?? "");
  if (!match) return fail("unexpected-response", `${field} is not a date`);
  const [, year, month, day] = match as unknown as [string, string, string, string];
  return localDate(`${year.length === 3 ? Number(year) + 1911 : year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`, field);
}

function signedInPage(context: PreviewWorkflowContext, capture: FeibCapture, endpoint: string): string {
  context.preview.observe({ endpoint, status: capture.status, body: { rows: htmlRows(content(capture.text)) } });
  if (capture.status < 200 || capture.status >= 300) return fail("unexpected-response", `${endpoint} answered HTTP ${capture.status}`);
  if (!SIGNED_IN.test(capture.text)) return fail("session-conflict", `${endpoint} shows no signed-in page`);
  return capture.text;
}

export type FeibDepositRow = Readonly<{ accountNo: string; typeName: string | null; currency: string; balance: string }>;

/** The 活期性存款 table of 我的存款; the 定期性存款 table after it is out of scope. */
export function feibDemandDeposits(html: string): FeibDepositRow[] {
  const page = content(html);
  const start = page.search(/<h2[^>]*>\s*活期性存款\s*<\/h2>/u);
  if (start < 0) return fail("unexpected-response", `${OVERVIEW} has no 活期性存款 section`);
  const end = page.slice(start).search(/<h2[^>]*>\s*定期性存款\s*<\/h2>/u);
  const found = table(page.slice(start, end < 0 ? undefined : start + end), ["帳號", "幣別", "帳戶餘額"], ["帳戶類別"]);
  if (!found) return fail("unexpected-response", `${OVERVIEW} has no demand deposit table`);
  const byKey = new Map<string, FeibDepositRow>();
  for (const [index, row] of found.rows.entries()) {
    const field = `${OVERVIEW}.row[${index}]`;
    const accountNo = digits(row[found.columns.帳號] ?? "");
    if (accountNo.length < 10 || accountNo.length > 16) return fail("unexpected-response", `${field} has no account number`);
    const typeCell = row[found.columns.帳戶類別];
    const entry: FeibDepositRow = {
      accountNo,
      typeName: isBlank(typeCell) ? null : typeCell!,
      currency: currencyCode(row[found.columns.幣別], `${field}.currency`, CURRENCY_ALIASES),
      balance: feibAmount(row[found.columns.帳戶餘額], `${field}.balance`),
    };
    const key = `${accountNo}:${entry.currency}`;
    const previous = byKey.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) return fail("unexpected-response", `${OVERVIEW} repeats an account with different content`);
    byKey.set(key, entry);
  }
  return [...byKey.values()];
}

const inputValue = (html: string, name: string) =>
  new RegExp(`<input\\b[^>]*\\bname=["']${name}["'][^>]*>`, "iu").exec(html)?.[0].match(/\bvalue\s*=\s*["']([^"']*)["']/iu)?.[1];

function selectedAccount(html: string): string | null {
  const options = /<select\b[^>]*\bid=["']acct["'][^>]*>([\s\S]*?)<\/select>/iu.exec(html)?.[1] ?? "";
  const all = [...options.matchAll(/<option\b([^>]*)>/giu)].map(([, attributes = ""]) => attributes);
  const chosen = all.find((attributes) => /\bselected\b/iu.test(attributes)) ?? all[0];
  const value = chosen === undefined ? null : /\bvalue\s*=\s*["']([^"']*)["']/iu.exec(chosen)?.[1];
  return value ? digits(value) : null;
}

/**
 * One 存款交易明細查詢 result for one NT-dollar account and range. The page
 * echoes the query, which must match; a query without a result table has no
 * transactions. Rows carry no id, so the key is the row's content plus its
 * occurrence order within the day.
 */
export function feibTransactions(html: string, accountNo: string, range: FeibQueryRange): PreviewTransaction[] {
  const page = content(html);
  if (!/name=["']inqForm["']/u.test(html) || !/com\.lb\.wibc\.trx\.SavAcctTxDtlInq/u.test(html))
    return fail("unexpected-response", `${HISTORY} is not the transaction query page`);
  if (selectedAccount(html) !== accountNo) return fail("unexpected-response", `${HISTORY} answered for another account`);
  if (inputValue(html, "sdate") !== range.start || inputValue(html, "edate") !== range.end)
    return fail("unexpected-response", `${HISTORY} answered for another range`);
  const text = plainText(page);
  if (TRUNCATED.test(text)) return fail("incomplete-data", `${HISTORY} shows a next-page or row-limit notice`);
  const shownAccount = /活存帳號\s*[:：]\s*([\d-]+)/u.exec(text)?.[1];
  const shownRange = /查詢期間\s*[:：]\s*(\d{4}\/\d{2}\/\d{2})\s*[~～]\s*(\d{4}\/\d{2}\/\d{2})/u.exec(text);
  if ((shownAccount !== undefined && digits(shownAccount) !== accountNo) || (shownRange && (shownRange[1] !== range.start || shownRange[2] !== range.end)))
    return fail("unexpected-response", `${HISTORY} result caption differs from the query`);
  const found = table(page, ["交易日期", "帳務日期", "摘要", "支出金額", "存入金額", "帳戶餘額", "備註"]);
  if (!found) return [];
  const occurrences = new Map<string, number>();
  return found.rows.map((row, index) => {
    const field = `${HISTORY}[${range.start}].row[${index}]`;
    const cell = (label: keyof typeof found.columns) => row[found.columns[label]];
    const side = (label: "支出金額" | "存入金額") => {
      if (isBlank(cell(label))) return null;
      const amount = feibAmount(cell(label), `${field}.${label}`);
      return isZeroDecimal(amount) ? null : amount;
    };
    const debit = side("支出金額");
    const credit = side("存入金額");
    if ((debit === null) === (credit === null)) return fail("unexpected-response", `${field} sets both or neither of 支出金額 and 存入金額`);
    const occurred = feibDate(cell("交易日期"), `${field}.交易日期`);
    const balance = isBlank(cell("帳戶餘額")) ? "" : feibAmount(cell("帳戶餘額"), `${field}.帳戶餘額`);
    const descriptions = [...new Set([cell("摘要"), cell("備註")].filter((value): value is string => !isBlank(value)))];
    const amount = (credit ?? debit)!;
    const direction = credit !== null ? "inflow" as const : "outflow" as const;
    const identity = [occurred.value, direction, amount, balance, ...descriptions].join("\u0000");
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    return {
      sourceRowKey: `${occurred.value}:${createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 16)}:${occurrence}`,
      amount,
      currency: "TWD",
      direction,
      postedAt: feibDate(cell("帳務日期"), `${field}.帳務日期`),
      description: descriptions.length > 0 ? descriptions.join(" · ") : null,
    };
  });
}

const slash = (date: string) => date.replaceAll("-", "/");
const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);

/**
 * The window as ranges FEIB accepts, newest first. A start may not be earlier
 * than the same day two months before the end; when that day does not exist
 * (2/30 before 4/30), the earliest start is the first of the next month.
 */
export function feibQueryRanges(window: Readonly<{ start: string; end: string }>): FeibQueryRange[] {
  const ranges: FeibQueryRange[] = [];
  let end = window.end;
  while (end >= window.start) {
    const [year, month, day] = end.split("-").map(Number) as [number, number, number];
    const lastDay = new Date(Date.UTC(year, month - 1 - MAX_RANGE_MONTHS + 1, 0)).getUTCDate();
    const earliest = isoDay(day <= lastDay ? Date.UTC(year, month - 1 - MAX_RANGE_MONTHS, day) : Date.UTC(year, month - MAX_RANGE_MONTHS, 1));
    const start = earliest > window.start ? earliest : window.start;
    ranges.push({ start: slash(start), end: slash(end) });
    end = isoDay(Date.parse(`${start}T00:00:00Z`) - 86_400_000);
  }
  return ranges;
}

async function collectDeposits(context: PreviewWorkflowContext, page: FeibPage, collectedAt: string): Promise<PreviewAccount[]> {
  const overview = await page.depositOverview();
  const rows = feibDemandDeposits(signedInPage(context, overview, OVERVIEW)).filter((row) => row.currency === "TWD");
  const ranges = feibQueryRanges(taipeiMonthWindow(collectedAt, MONTHS));
  const asOf = observedAt(overview.date, collectedAt);
  const accounts: PreviewAccount[] = [];
  for (const row of rows) {
    const transactions: PreviewTransaction[] = [];
    for (const range of ranges) {
      const history = signedInPage(context, await page.transactions(row.accountNo, range), HISTORY);
      transactions.push(...feibTransactions(history, row.accountNo, range));
    }
    accounts.push({
      sourceAccountKey: `${row.accountNo}:TWD`,
      displayLabel: `遠東商銀 ${row.typeName ?? "臺幣活存"} ${row.accountNo.slice(-4)}`,
      currency: "TWD",
      type: "depository",
      balances: [{ kind: "current", amount: row.balance, currency: "TWD", observedAt: asOf }],
      transactions,
    });
  }
  return accounts;
}

export function createFeibSource(options: Readonly<{ page?: FeibPageOpener; solveCaptcha?: PreviewCaptchaSolver }> = {}): PreviewSource {
  const open = options.page ?? playwrightFeibPage;
  return {
    id: "feib-deposit",
    institution: PREVIEW_SOURCE_INSTITUTIONS["feib-deposit"],
    products: ["deposit"],
    displayName: { en: "Far Eastern International Bank deposits (preview)", "zh-TW": "遠東商銀存款（預覽）" },
    searchAliases: ["FEIB", "Far Eastern International Bank", "Far Eastern Bank", "遠東商銀", "遠東銀行", "遠銀", "遠東國際商業銀行"],
    credentialFields: [
      { key: KEY.idNumber, label: { en: "Taiwan ID number", "zh-TW": "身分證字號" }, input: "text", redaction: "partial" },
      { key: KEY.userCode, label: { en: "User code", "zh-TW": "使用者代號" }, input: "text", redaction: "partial" },
      { key: KEY.password, label: { en: "Password", "zh-TW": "網銀密碼" }, input: "password", redaction: "full" },
    ],
    setupGuide: {
      summary: {
        en: "Preview source, never run against a live FEIB account. Its data may be incomplete or wrong. It collects NT-dollar demand deposit balances and three months of transactions. Its image verification is solved on your device; a challenge the on-device solver is not confident about ends the run without signing in.",
        "zh-TW": "預覽來源，從未以真實的遠東商銀帳戶執行過，資料可能不完整或有誤。它收集臺幣活期存款餘額與近三個月交易明細。圖形驗證在你的裝置上辨識；辨識信心不足時，該次執行會在登入前停止。",
      },
      requirements: [{ en: "An FEIB personal online-banking (個人網路銀行) login.", "zh-TW": "可登入遠東商銀個人網路銀行的帳號。" }],
      steps: [{
        en: "Enter the ID number, user code, and password you use to sign in to FEIB personal online banking. A rejected sign-in is never retried, because repeated wrong passwords lock the account.",
        "zh-TW": "輸入登入遠東商銀個人網路銀行使用的身分證字號、使用者代號與網銀密碼。登入被拒絕時不會重試，因為連續輸入錯誤密碼會停用帳號。",
      }],
      links: [{
        id: "feib-online-banking",
        label: { en: "FEIB personal online banking", "zh-TW": "遠東商銀個人網路銀行" },
        url: FEIB_LOGIN_URL,
        allowedHosts: ["ebank.feib.com.tw"],
      }],
    },
    sessionTakeover: {
      notice: {
        en: "When FEIB reports another signed-in online-banking session, the sync stops instead of signing it out. A sync signs itself out when it ends.",
        "zh-TW": "若遠東商銀回報已有其他網路銀行登入，同步會停止，不會讓對方登出。同步結束時會自行登出。",
      },
    },
    startUrl: FEIB_LOGIN_URL,
    async run(context, input) {
      await context.event("authentication", "started", "authentication-started");
      const solve = options.solveCaptcha ?? calibratedCaptchaSolver(FEIB_CAPTCHA_FAMILY);
      return open(context, input.startUrl, async (page) => {
        let submitted = false;
        try {
          const captcha = await solveChallengeRound(context, solve, async () =>
            ({ image: await page.captchaImage(), charset: "digits", expectedLength: CAPTCHA_LENGTH }), 1);
          submitted = true;
          await completeSignIn(page, await page.signIn({
            idNumber: (input.credentials[KEY.idNumber] ?? "").toUpperCase(),
            userCode: input.credentials[KEY.userCode] ?? "",
            password: input.credentials[KEY.password] ?? "",
            captcha,
          }));
          await context.event("authentication", "completed", "authentication-completed");
          await context.event("collection", "started", "collection-started");
          const collectedAt = context.now();
          const output = await context.preview.collect({
            deposit: async () => ({ collectedAt, accounts: await collectDeposits(context, page, collectedAt) }),
          });
          await context.event("collection", "completed", "collection-completed");
          return output;
        } finally {
          if (submitted) await page.signOut().catch(() => undefined);
        }
      });
    },
  };
}

export const FEIB_PREVIEW_SOURCE = createFeibSource();
