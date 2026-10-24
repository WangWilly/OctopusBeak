import type { PreviewAccount, PreviewTransaction } from "../../ledger/pglite/preview-financial-data.ts";
import type { PreviewHttp } from "./browser-http.ts";
import {
  KGIBANK_CAPTCHA_MESSAGE as CAPTCHA_MESSAGE,
  KGIBANK_CREDENTIAL_MESSAGE as CREDENTIAL_MESSAGE,
  KGIBANK_GATEWAY_PATH,
  KGIBANK_TOKEN_PATH,
  kgibankBrowserSession,
} from "./kgibank-login-form.ts";
import type { PreviewSource } from "./registry.ts";
import { PREVIEW_SOURCE_INSTITUTIONS } from "./source-id.ts";
import { calibratedCaptchaSolver, KGIBANK_CAPTCHA_FAMILY } from "./preview-captcha.ts";
import {
  currencyCode,
  exactDecimal,
  fail,
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
} from "./source-kit.ts";
import type { PreviewWorkflowContext } from "./workflow.ts";

const ORIGIN = "https://ib.kgibank.com.tw";
const LOGIN_URL = `${ORIGIN}/ibank/`;
const LOGOUT_PATH = "/gateway/prod-oidc/Account/AccountLogout/Logout";
const ACCOUNTS_PATH = `${KGIBANK_GATEWAY_PATH}Deposit/TwdDemandDepositDetail/AcctQuery`;
const TRANSACTIONS_PATH = `${KGIBANK_GATEWAY_PATH}Deposit/TwdDemandDepositDetail/TxnQuery`;
const MONTHS = 3;
// TwdDemandDepositDetail is KGI's NT-dollar demand deposit service and carries
// no currency field, so its contract fixes TWD. A currency the source does send wins.
const NT_DOLLAR_ENDPOINT_CURRENCY = "TWD";
const CURRENCY_FIELDS = ["currency", "curCode", "currCode", "ccy"] as const;
const CURRENCY_ALIASES: Readonly<Record<string, string>> = { NTD: "TWD", "新臺幣": "TWD", "新台幣": "TWD", "臺幣": "TWD", "台幣": "TWD" };
const MORE_FLAGS = ["hasMore", "hasNext", "hasNextPage", "isMore", "moreData"] as const;
const COUNT_FIELDS = ["totalCount", "totalRecords", "total"] as const;
const CURSOR_FIELDS = ["nextKey", "nextPageKey", "continuationToken"] as const;

const KEY = {
  idNumber: "PREVIEW_KGIBANK_DEPOSIT_ID_NUMBER",
  userCode: "PREVIEW_KGIBANK_DEPOSIT_USER_CODE",
  password: "PREVIEW_KGIBANK_DEPOSIT_PASSWORD",
} as const;

export type KgibankCredentials = Readonly<{ idNumber: string; userCode: string; password: string }>;

/** What the login page showed first after a submit or a takeover confirmation. */
export type KgibankLoginSignal = Readonly<
  | { kind: "token"; status: number; text: string }
  | { kind: "message"; text: string; tokenRequested: boolean }
  | { kind: "timeout" }
>;

/**
 * KGI's Ionic login page builds the `connect/token` request in its own script,
 * so sign-in only works by driving the form. The form never submits a second
 * time on its own: every submit or confirmation is a call the source makes.
 */
export type KgibankLoginForm = Readonly<{
  captcha(): Promise<PreviewCaptchaChallenge>;
  submit(credentials: KgibankCredentials, captcha: string): Promise<KgibankLoginSignal>;
  /** Clicks 「繼續登入」 as the person would; null when the page shows no such button. */
  confirmTakeover(): Promise<KgibankLoginSignal | null>;
  /** The authorization headers the page's own gateway requests carried after sign-in; null when none arrived. */
  authHeaders(): Promise<Readonly<Record<string, string>> | null>;
}>;

export type KgibankSessionOpener = <T>(
  context: PreviewWorkflowContext,
  startUrl: string,
  use: (session: Readonly<{ http: PreviewHttp; form: KgibankLoginForm }>) => Promise<T>,
) => Promise<T>;

function tokenBody(context: PreviewWorkflowContext, signal: Extract<KgibankLoginSignal, { kind: "token" }>): SourceRecord | null {
  let parsed: unknown = null;
  try {
    parsed = signal.text.trim() === "" ? null : parseSourceJson(signal.text, KGIBANK_TOKEN_PATH);
  } catch {
    parsed = null;
  } finally {
    context.preview.observe({ endpoint: KGIBANK_TOKEN_PATH, status: signal.status, body: parsed });
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as SourceRecord : null;
}

/**
 * Three wrong passwords lock a KGI account, so every outcome here ends the
 * sign-in: nothing is resubmitted. Only a CAPTCHA message shown before
 * `connect/token` was requested counts as a CAPTCHA failure.
 */
async function signIn(context: PreviewWorkflowContext, form: KgibankLoginForm, solve: PreviewCaptchaSolver, credentials: KgibankCredentials) {
  const answer = await solveChallengeRound(context, solve, () => form.captcha(), 1);
  let signal = await form.submit(credentials, answer);
  let tookOver = false;
  for (;;) {
    if (signal.kind === "timeout") return fail("unexpected-response", "the login outcome is unknown: no token response or page message");
    if (signal.kind === "message") {
      if (CREDENTIAL_MESSAGE.test(signal.text)) return fail("sign-in-rejected", "credentials rejected");
      if (CAPTCHA_MESSAGE.test(signal.text) && !signal.tokenRequested) return fail("verification-rejected", "captcha rejected");
      return fail("unexpected-response", "unrecognized login message");
    }
    const body = tokenBody(context, signal);
    if (body?.isSSOExsit === true) {
      if (tookOver) return fail("session-conflict", "connect/token still reports another session after takeover");
      tookOver = true;
      signal = await form.confirmTakeover() ?? fail("unexpected-response", "connect/token reports another session but 繼續登入 is not shown");
      continue;
    }
    if (signal.status === 200) return;
    if (signal.status >= 400 && signal.status < 500) return fail("sign-in-rejected", `connect/token HTTP ${signal.status}`);
    return fail("unexpected-response", `the login outcome is unknown: connect/token HTTP ${signal.status}`);
  }
}

type Gateway = Readonly<{
  get(path: string, query?: Readonly<Record<string, string>>): Promise<Readonly<{ payload: SourceRecord; date: string | null }>>;
  logout(): Promise<void>;
}>;

function gateway(context: PreviewWorkflowContext, http: PreviewHttp, authHeaders: Readonly<Record<string, string>>): Gateway {
  const headers = () => ({ ...authHeaders, accept: "application/json", "x-c-localtime": context.now() });
  return {
    async get(path, query) {
      const response = await http({
        method: "GET",
        url: `${ORIGIN}${path}${query ? `?${new URLSearchParams(query)}` : ""}`,
        headers: headers(),
        credentials: "include",
      });
      let parsed: unknown = null;
      try {
        parsed = parseSourceJson(response.text, path);
      } finally {
        context.preview.observe({ endpoint: path, status: response.status, body: parsed });
      }
      if (response.status === 401 || response.status === 403) return fail("session-conflict", `${path} HTTP ${response.status}`);
      if (response.status < 200 || response.status >= 300) return fail("unexpected-response", `${path} HTTP ${response.status}`);
      return { payload: record(parsed, path), date: response.headers.date ?? null };
    },
    async logout() {
      const response = await http({ method: "POST", url: `${ORIGIN}${LOGOUT_PATH}`, headers: headers(), credentials: "include" });
      context.preview.observe({ endpoint: LOGOUT_PATH, status: response.status, body: null });
    },
  };
}

/** Items of a gateway list, refused when any paging or truncation field says more exist. */
function completeItems(payload: SourceRecord, path: string): readonly SourceRecord[] {
  const items = records(payload.items, `${path}.items`);
  for (const flag of MORE_FLAGS) {
    const value = payload[flag];
    if (value === undefined || value === null || value === false || value === "N" || value === "false") continue;
    if (value === true || value === "Y" || value === "true") return fail("incomplete-data", `${path}.${flag} says more items exist`);
    return fail("unexpected-response", `${path}.${flag} is not a flag`);
  }
  for (const field of COUNT_FIELDS) {
    const value = payload[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || !/^\d+$/u.test(value)) return fail("unexpected-response", `${path}.${field} is not a count`);
    if (Number(value) !== items.length) return fail("incomplete-data", `${path}.${field} differs from the items returned`);
  }
  for (const field of CURSOR_FIELDS) {
    if (optionalText(payload[field]) !== null) return fail("incomplete-data", `${path}.${field} points to another page`);
  }
  return items;
}

function sourceCurrency(entry: SourceRecord, field: string, fallback: string): string {
  const name = CURRENCY_FIELDS.find((candidate) => entry[candidate] !== undefined && entry[candidate] !== null);
  return name === undefined ? fallback : currencyCode(entry[name], `${field}.${name}`, CURRENCY_ALIASES);
}

const accountDigits = (value: unknown, field: string) => {
  const digits = text(value, field).replace(/\D/gu, "");
  return digits === "" ? fail("unexpected-response", `${field} has no digits`) : digits;
};

function transactions(items: readonly SourceRecord[], accountNo: string, currency: string): PreviewTransaction[] {
  const occurrences = new Map<string, number>();
  return items.map((item, index) => {
    const field = `TxnQuery.items[${index}]`;
    if (item.acctNo !== undefined && accountDigits(item.acctNo, `${field}.acctNo`) !== accountNo)
      return fail("unexpected-response", `${field}.acctNo differs from the queried account`);
    const occurred = localDate(item.txnDateTime, `${field}.txnDateTime`);
    if (occurred.precision !== "second") return fail("unexpected-response", `${field}.txnDateTime has no seconds`);
    const amount = exactDecimal(item.txnAmt, `${field}.txnAmt`);
    const balanceAfter = item.acctBal === undefined || item.acctBal === null ? "" : exactDecimal(item.acctBal, `${field}.acctBal`);
    const identity = `${accountNo}:${occurred.value}:${amount}:${balanceAfter}`;
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    const effective = optionalText(item.effectDateTime);
    const descriptions = [...new Set([optionalText(item.txnTypeName), optionalText(item.desc)].filter((value) => value !== null))];
    return {
      sourceRowKey: `${identity}:${occurrence}`,
      amount,
      currency: sourceCurrency(item, field, currency),
      direction: "unknown",
      postedAt: effective === null ? occurred : { precision: "day", value: localDate(effective, `${field}.effectDateTime`).value.slice(0, 10) },
      description: descriptions.length > 0 ? descriptions.join(" · ") : null,
    };
  });
}

async function collect(api: Gateway, collectedAt: string): Promise<PreviewAccount[]> {
  const listed = await api.get(ACCOUNTS_PATH);
  const entries = completeItems(listed.payload, ACCOUNTS_PATH);
  if (entries.length === 0) return fail("unexpected-response", "AcctQuery lists no NT-dollar demand account");
  const asOf = observedAt(listed.date, collectedAt);
  const window = taipeiMonthWindow(collectedAt, MONTHS);
  const seen = new Set<string>();
  const accounts: PreviewAccount[] = [];
  for (const [index, entry] of entries.entries()) {
    const field = `AcctQuery.items[${index}]`;
    const accountNo = accountDigits(entry.acctNo, `${field}.acctNo`);
    if (seen.has(accountNo)) return fail("unexpected-response", `${field}.acctNo repeats`);
    seen.add(accountNo);
    const currency = sourceCurrency(entry, field, NT_DOLLAR_ENDPOINT_CURRENCY);
    const current = exactDecimal(entry.acctBal, `${field}.acctBal`);
    const available = entry.availBal === undefined || entry.availBal === null || entry.availBal === "" ? null : exactDecimal(entry.availBal, `${field}.availBal`);
    const history = await api.get(TRANSACTIONS_PATH, {
      acctNo: accountNo,
      startDate: `${window.start}T00:00:00.000+08:00`,
      endDate: `${window.end}T23:59:59.999+08:00`,
      refresh: "true",
    });
    const name = optionalText(entry.acctNickName) ?? optionalText(entry.acctTypeName) ?? "臺幣活存";
    accounts.push({
      sourceAccountKey: `${accountNo}:${currency}`,
      displayLabel: `凱基銀行 ${name} ${accountNo.slice(-4)}`,
      currency,
      type: "depository",
      balances: [
        { kind: "current", amount: current, currency, observedAt: asOf },
        ...available === null ? [] : [{ kind: "available" as const, amount: available, currency, observedAt: asOf }],
      ],
      transactions: transactions(completeItems(history.payload, TRANSACTIONS_PATH), accountNo, currency),
    });
  }
  return accounts;
}

export function createKgibankSource(options: Readonly<{
  open?: KgibankSessionOpener;
  solveCaptcha?: PreviewCaptchaSolver;
}> = {}): PreviewSource {
  const open = options.open ?? kgibankBrowserSession;
  return {
    id: "kgibank-deposit",
    institution: PREVIEW_SOURCE_INSTITUTIONS["kgibank-deposit"],
    products: ["deposit"],
    displayName: { en: "KGI Bank deposits (preview)", "zh-TW": "凱基銀行存款（預覽）" },
    searchAliases: ["KGI", "KGI Bank", "凱基", "凱基銀行", "凱基商業銀行"],
    credentialFields: [
      { key: KEY.idNumber, label: { en: "Taiwan ID number", "zh-TW": "身分證字號" }, input: "text", redaction: "partial" },
      { key: KEY.userCode, label: { en: "User code", "zh-TW": "使用者代號" }, input: "text", redaction: "partial" },
      { key: KEY.password, label: { en: "Password", "zh-TW": "網銀密碼" }, input: "password", redaction: "full" },
    ],
    setupGuide: {
      summary: {
        en: "Preview source, never run against a live KGI Bank account. Its data may be incomplete or wrong. Its image verification runs on your device; an unaccepted challenge stops the run before sign-in.",
        "zh-TW": "預覽來源，從未以真實的凱基銀行帳戶執行過，資料可能不完整或有誤。圖形驗證在你的裝置上執行；辨識未通過時，執行會在登入前停止。",
      },
      requirements: [{ en: "A KGI Bank online-banking (網路銀行) login.", "zh-TW": "可登入凱基網路銀行的帳號。" }],
      steps: [{
        en: "Enter the ID number, user code, and password you use to sign in to KGI online banking. Three wrong passwords lock the account, so a rejected sign-in is never retried.",
        "zh-TW": "輸入登入凱基網路銀行使用的身分證字號、使用者代號與網銀密碼。連續三次密碼錯誤會停用帳號，因此登入被拒絕時不會重試。",
      }],
      links: [{
        id: "kgibank-online-banking",
        label: { en: "KGI online banking", "zh-TW": "凱基網路銀行" },
        url: LOGIN_URL,
        allowedHosts: ["ib.kgibank.com.tw"],
      }],
    },
    sessionTakeoverNotice: {
      en: "KGI Bank allows one sign-in per ID. A sync signs you out of the KGI App and any other KGI online-banking session, then signs itself out when it ends.",
      "zh-TW": "凱基銀行同一身分證只允許一處登入。同步會讓你登出凱基 App 與其他凱基網路銀行的登入，並在結束時自行登出。",
    },
    startUrl: LOGIN_URL,
    async run(context, input) {
      await context.event("authentication", "started", "authentication-started");
      const solve = options.solveCaptcha ?? calibratedCaptchaSolver(KGIBANK_CAPTCHA_FAMILY);
      return open(context, input.startUrl, async ({ http, form }) => {
        let submitted = false;
        let api = gateway(context, http, {});
        try {
          await signIn(context, {
            ...form,
            submit: (credentials, captcha) => {
              submitted = true;
              return form.submit(credentials, captcha);
            },
          }, solve, {
            idNumber: input.credentials[KEY.idNumber] ?? "",
            userCode: input.credentials[KEY.userCode] ?? "",
            password: input.credentials[KEY.password] ?? "",
          });
          const headers = await form.authHeaders();
          if (!headers?.authorization || !headers["ocp-apim-subscription-key"])
            return fail("unexpected-response", "the signed-in page sent no gateway authorization headers");
          api = gateway(context, http, headers);
          await context.event("authentication", "completed", "authentication-completed");
          await context.event("collection", "started", "collection-started");
          const collectedAt = context.now();
          const accounts = await collect(api, collectedAt);
          await context.event("collection", "completed", "collection-completed");
          return await context.preview.collect({ deposit: async () => ({ collectedAt, accounts }) });
        } finally {
          if (submitted) await api.logout().catch(() => undefined);
        }
      });
    },
  };
}

export const KGIBANK_PREVIEW_SOURCE = createKgibankSource();
