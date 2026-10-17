import { constants, createHash, createHmac, publicEncrypt } from "node:crypto";
import type { PreviewAccount, PreviewLocalDate, PreviewTransaction } from "../../ledger/pglite/preview-financial-data.ts";
import { browserHttp, type PreviewHttp, type PreviewHttpOpener } from "./browser-http.ts";
import type { PreviewSource } from "./registry.ts";
import { PREVIEW_SOURCE_INSTITUTIONS } from "./source-id.ts";
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
  taipeiMonthWindow,
  text,
  type SourceRecord,
} from "./source-kit.ts";
import type { PreviewWorkflowContext } from "./workflow.ts";

const API = "https://mbanking.skbank.com.tw";
const PATH = {
  appConfig: "/api/v1/Common/GetAppConfig",
  login: "/api/v2/Authentication/Login",
  userInformation: "/api/v1/Foundation/GetUserInformation",
  megaMenu: "/api/v1/Common/GetMegaMenuStatus",
  accountSummary: "/api/v1/Account/GetAccountSummary",
  foreignAccountSummary: "/api/v1/Account/GetForeignCurrencyAccountSummary",
  transactions: "/api/v1/Account/FetchTransactionDetails",
  foreignTransactions: "/api/v1/Account/FetchForeignCurrencyTransactionDetails",
  logout: "/api/v1/Authentication/Logout",
} as const;
const APP_VERSION = "5.8.5";
const DEVICE_INFO = "Android;15;Google-Pixel 8";
const DEVICE_ID_SALT = "octopusbeak-preview-skbank-device-v1";
const MONTHS = 3;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const SUCCESS = "0000";
const APP_VERSION_REJECTED = "MB433";
const NO_TRANSACTIONS = "查無資料";

const KEY = {
  idNumber: "PREVIEW_SKBANK_DEPOSIT_ID_NUMBER",
  alias: "PREVIEW_SKBANK_DEPOSIT_USER_ID",
  password: "PREVIEW_SKBANK_DEPOSIT_PASSWORD",
} as const;

type Envelope = Readonly<{ code: string; message: string; data: unknown; date: string | null }>;

type PublicKey = Readonly<{ modulus: string; exponent: string }>;

/**
 * The preview context has no persistence port, so the Device-Id the App
 * would store is derived from the sign-in identifiers: every run presents the
 * same device to SKBank without keeping state.
 */
export function skbankDeviceId(idNumber: string, alias: string): string {
  const hex = createHash("sha256").update(`${DEVICE_ID_SALT}\u0000${idNumber}\u0000${alias}`, "utf8").digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function base64UrlFromHex(hex: string): string {
  return Buffer.from(hex.length % 2 === 0 ? hex : `0${hex}`, "hex").toString("base64url");
}

function encryptRsaHex(value: string, key: PublicKey): string {
  const jwk = { kty: "RSA", n: base64UrlFromHex(key.modulus), e: base64UrlFromHex(key.exponent) };
  return publicEncrypt({ key: jwk, format: "jwk", padding: constants.RSA_PKCS1_PADDING }, Buffer.from(value, "utf8")).toString("hex");
}

/** The App signs the login payload with HMAC-SHA256 keyed by the hex SHA-256 of the ID number. */
export function skbankLoginBody(credentials: Readonly<{ idNumber: string; alias: string; password: string }>, key: PublicKey): string {
  const payload = {
    Alias: encryptRsaHex(credentials.alias, key),
    Channel: "InternetBankingMember",
    FidoToken: "",
    FidoVerifyNumber: "",
    Method: "General",
    NationalIdNumber: credentials.idNumber,
    Password: encryptRsaHex(credentials.password, key),
  };
  const secret = createHash("sha256").update(credentials.idNumber, "utf8").digest("hex");
  const signature = createHmac("sha256", secret).update(JSON.stringify({ Payload: payload }), "utf8").digest("base64");
  return JSON.stringify({ Payload: payload, Signature: signature });
}

function client(context: PreviewWorkflowContext, http: PreviewHttp, deviceId: string) {
  let token = "";
  async function send(method: "GET" | "POST", path: string, query?: Readonly<Record<string, string>>, body?: string): Promise<Envelope> {
    const url = new URL(path, API);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
    const response = await http({
      method,
      url: url.toString(),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
        "App-Version": APP_VERSION,
        "Device-Info": DEVICE_INFO,
        "Device-Id": deviceId,
        Authorization: `bearer ${token}`,
      },
      ...(body === undefined ? {} : { body }),
    });
    const parsed = response.text === "" ? null : parseSourceJson(response.text, path);
    context.preview.observe({ endpoint: path, status: response.status, body: parsed });
    if (response.status === 401 || response.status === 403) return fail("session-conflict", `${path} HTTP ${response.status}`);
    if (response.status !== 200) return fail("unexpected-response", `${path} HTTP ${response.status}`);
    const envelope = record(parsed, path);
    return {
      code: typeof envelope.ReturnCode === "string" ? envelope.ReturnCode : "",
      message: typeof envelope.ReturnMessage === "string" ? envelope.ReturnMessage.trim() : "",
      data: envelope.Data,
      date: response.headers.date ?? null,
    };
  }
  async function get(path: string, query?: Readonly<Record<string, string>>): Promise<Envelope> {
    const envelope = await send("GET", path, query);
    if (envelope.code !== SUCCESS) return fail("unexpected-response", `${path} ReturnCode ${envelope.code || "missing"}`);
    return envelope;
  }
  return {
    send,
    get,
    signedIn: () => token !== "",
    setToken(value: string) { token = value; },
  };
}

type Api = ReturnType<typeof client>;

async function publicKey(api: Api): Promise<PublicKey> {
  const config = await api.get(PATH.appConfig);
  const key = record(record(config.data, "GetAppConfig.Data").PublicKey, "GetAppConfig.PublicKey");
  const modulus = text(key.Module, "PublicKey.Module");
  const exponent = text(key.Exponent, "PublicKey.Exponent");
  if (!/^[0-9a-f]+$/iu.test(modulus) || !/^[0-9a-f]+$/iu.test(exponent)) return fail("unexpected-response", "PublicKey is not hex");
  return { modulus, exponent };
}

async function signIn(api: Api, credentials: Readonly<{ idNumber: string; alias: string; password: string }>): Promise<void> {
  const key = await publicKey(api);
  const login = await api.send("POST", PATH.login, undefined, skbankLoginBody(credentials, key));
  if (login.code === APP_VERSION_REJECTED) return fail("unexpected-response", `SKBank rejected App-Version ${APP_VERSION}`);
  if (login.code !== SUCCESS) return fail("sign-in-rejected", `SKBank login ReturnCode ${login.code || "missing"}`);
  api.setToken(text(record(login.data, "Login.Data").AccessToken, "Login.AccessToken"));
}

type DepositAccount = Readonly<{
  accountNumber: string;
  currency: string;
  timeDeposit: boolean;
  account: PreviewAccount;
}>;

function depositAccounts(envelope: Envelope, field: string, mode: "TWD" | "FX", collectedAt: string): DepositAccount[] {
  const data = record(envelope.data, `${field}.Data`);
  // all-set-tw treats a foreign summary without AccountList as "no foreign accounts".
  if (mode === "FX" && data.AccountList === undefined) return [];
  const asOf = observedAt(envelope.date, collectedAt);
  const accounts: DepositAccount[] = [];
  for (const [index, item] of records(data.AccountList, `${field}.AccountList`).entries()) {
    const itemField = `${field}.AccountList[${index}]`;
    const accountNumber = text(item.AccountNumber, `${itemField}.AccountNumber`);
    for (const [detailIndex, detail] of records(item.Details, `${itemField}.Details`).entries()) {
      const detailField = `${itemField}.Details[${detailIndex}]`;
      const currency = currencyCode(detail.CurrencyCode, `${detailField}.CurrencyCode`);
      if ((mode === "TWD") !== (currency === "TWD")) continue;
      const groups = Array.isArray(detail.DisplayGroup) ? detail.DisplayGroup : [];
      const timeDeposit = groups.includes("TimeDeposit") || item.ProductCode === "F500001";
      const balance = timeDeposit ? detail.TimeDepositBalance : detail.AccountBalance;
      const last4 = (optionalText(detail.AccountNumberDisplay) ?? accountNumber).replace(/\D/gu, "").slice(-4);
      const name = optionalText(item.Nickname) ?? optionalText(item.ProductFullName) ?? "存款";
      accounts.push({
        accountNumber,
        currency,
        timeDeposit,
        account: {
          sourceAccountKey: `${accountNumber}:${currency}`,
          displayLabel: `新光銀行 ${name}${last4 ? ` ${last4}` : ""}${currency === "TWD" ? "" : ` (${currency})`}`,
          currency,
          type: "depository",
          balances: [
            { kind: "current", amount: exactDecimal(balance, `${detailField}.${timeDeposit ? "TimeDepositBalance" : "AccountBalance"}`), currency, observedAt: asOf },
            ...(detail.AvailableBalance === undefined ? [] : [{
              kind: "available" as const,
              amount: exactDecimal(detail.AvailableBalance, `${detailField}.AvailableBalance`),
              currency,
              observedAt: asOf,
            }]),
          ],
          transactions: [],
        },
      });
    }
  }
  return accounts;
}

/** SKBank dates may use the ROC year (115/10/03) and unpadded parts, which `localDate` does not read. */
export function skbankDate(value: unknown, field: string): PreviewLocalDate {
  const raw = typeof value === "string" ? value.trim().replaceAll(".", "/") : "";
  const parts = /^(\d{2,4})\/(\d{1,2})\/(\d{1,2})(.*)$/u.exec(raw);
  if (!parts) return localDate(raw, field);
  const [, year, month, day, rest] = parts as unknown as [string, string, string, string, string];
  const gregorian = Number(year) < 1911 ? Number(year) + 1911 : Number(year);
  return localDate(`${gregorian}/${month.padStart(2, "0")}/${day.padStart(2, "0")}${rest}`, field);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^\d+$/u.test(value.trim())) return fail("incomplete-data", `${field} is not a count`);
  return Number(value.trim());
}

function transactionsFrom(details: readonly SourceRecord[], field: string, currency: string): PreviewTransaction[] {
  const occurrences = new Map<string, number>();
  return details.map((detail, index) => {
    const rowField = `${field}[${index}]`;
    const amount = exactDecimal(detail.Amount, `${rowField}.Amount`);
    const postedAt = skbankDate(detail.TransactionDate, `${rowField}.TransactionDate`);
    const memo = optionalText(detail.Memo);
    const remark = optionalText(detail.Remark);
    const summary = optionalText(detail.Summary);
    const balance = detail.Balance === undefined || detail.Balance === null ? "" : exactDecimal(detail.Balance, `${rowField}.Balance`);
    // SKBank rows carry no transaction id, so the key is the row's content plus its occurrence order.
    const identity = [postedAt.value, amount, balance, memo ?? "", remark ?? "", summary ?? ""].join("\u0000");
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    const descriptions = [memo, remark, summary].filter((entry) => entry !== null);
    return {
      sourceRowKey: `${postedAt.value.slice(0, 10)}:${createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 16)}:${occurrence}`,
      amount,
      currency,
      direction: "unknown",
      postedAt,
      description: descriptions.length > 0 ? [...new Set(descriptions)].join(" · ") : null,
    };
  });
}

async function transactionPages(api: Api, deposit: DepositAccount, range: Readonly<{ start: string; end: string }>): Promise<PreviewTransaction[]> {
  const foreign = deposit.currency !== "TWD";
  const path = foreign ? PATH.foreignTransactions : PATH.transactions;
  const details: SourceRecord[] = [];
  let totalCount: number | null = null;
  for (let page = 1; ; page += 1) {
    if (page > MAX_PAGES) return fail("incomplete-data", `${path} exceeded its page bound`);
    const query = {
      AccountNumber: deposit.accountNumber,
      BeginDate: range.start.replaceAll("-", "/"),
      EndDate: range.end.replaceAll("-", "/"),
      IsOrderByAsc: "true",
      Page: String(page),
      PageSize: String(PAGE_SIZE),
      ...(foreign ? { CurrencyCode: deposit.currency } : {}),
    };
    const envelope = await api.send("GET", path, query);
    if (envelope.code !== SUCCESS) {
      if (page === 1 && envelope.message === NO_TRANSACTIONS) return [];
      return fail(envelope.message === NO_TRANSACTIONS ? "incomplete-data" : "unexpected-response", `${path} page ${page} ReturnCode ${envelope.code || "missing"}`);
    }
    const data = record(envelope.data, `${path}.Data`);
    const pageDetails = records(data.Details, `${path}.Details`);
    const paging = record(data.Paging, `${path}.Paging`);
    const reportedTotal = nonNegativeInteger(paging.TotalCount, `${path}.Paging.TotalCount`);
    if (nonNegativeInteger(paging.Page, `${path}.Paging.Page`) !== page) return fail("incomplete-data", `${path} answered another page than ${page}`);
    if (totalCount !== null && reportedTotal !== totalCount) return fail("incomplete-data", `${path} TotalCount changed between pages`);
    totalCount = reportedTotal;
    details.push(...pageDetails);
    if (details.length > totalCount) return fail("incomplete-data", `${path} returned more rows than TotalCount`);
    if (details.length === totalCount) break;
    if (pageDetails.length === 0) return fail("incomplete-data", `${path} returned an empty page before TotalCount`);
  }
  return transactionsFrom(details, `${path}.Details`, deposit.currency);
}

async function collect(api: Api, collectedAt: string): Promise<PreviewAccount[]> {
  await api.get(PATH.userInformation);
  await api.get(PATH.megaMenu);
  const deposits = [
    ...depositAccounts(await api.get(PATH.accountSummary), "GetAccountSummary", "TWD", collectedAt),
    ...depositAccounts(await api.get(PATH.foreignAccountSummary), "GetForeignCurrencyAccountSummary", "FX", collectedAt),
  ];
  const keys = new Set<string>();
  for (const deposit of deposits) {
    if (keys.has(deposit.account.sourceAccountKey)) return fail("unexpected-response", "an account and currency repeat in the summary");
    keys.add(deposit.account.sourceAccountKey);
  }
  const range = taipeiMonthWindow(collectedAt, MONTHS);
  const accounts: PreviewAccount[] = [];
  for (const deposit of deposits) {
    accounts.push(deposit.timeDeposit
      ? deposit.account
      : { ...deposit.account, transactions: await transactionPages(api, deposit, range) });
  }
  return accounts;
}

export function createSkbankSource(options: Readonly<{ http?: PreviewHttpOpener }> = {}): PreviewSource {
  const open = options.http ?? browserHttp;
  return {
    id: "skbank-deposit",
    institution: PREVIEW_SOURCE_INSTITUTIONS["skbank-deposit"],
    product: "deposit",
    displayName: { en: "Shin Kong Bank deposits (preview)", "zh-TW": "新光銀行存款（預覽）" },
    searchAliases: ["Shin Kong Bank", "SKBank", "新光", "新光銀行"],
    credentialFields: [
      { key: KEY.idNumber, label: { en: "Taiwan ID number", "zh-TW": "身分證字號" }, input: "text", redaction: "partial" },
      { key: KEY.alias, label: { en: "User ID", "zh-TW": "使用者代號" }, input: "text", redaction: "partial" },
      { key: KEY.password, label: { en: "Online banking password", "zh-TW": "網銀密碼" }, input: "password", redaction: "full" },
    ],
    setupGuide: {
      summary: {
        en: "Preview source, never run against a live Shin Kong Bank account. Its data may be incomplete or wrong. It signs in through the Shin Kong Bank mobile banking API with your online banking credentials.",
        "zh-TW": "預覽來源，從未以真實的新光銀行帳戶執行過，資料可能不完整或有誤。它以你的網路銀行帳密，透過新光銀行行動銀行 API 登入。",
      },
      requirements: [{ en: "A Shin Kong Bank online banking account.", "zh-TW": "新光銀行網路銀行帳戶。" }],
      steps: [{ en: "Enter the ID number, user ID, and password you use to sign in to Shin Kong Bank online banking.", "zh-TW": "輸入登入新光銀行網路銀行使用的身分證字號、使用者代號與密碼。" }],
      links: [{
        id: "skbank-site",
        label: { en: "Shin Kong Bank", "zh-TW": "新光銀行" },
        url: "https://www.skbank.com.tw/",
        allowedHosts: ["www.skbank.com.tw"],
      }],
    },
    sessionTakeoverNotice: {
      en: "Shin Kong Bank may allow one mobile banking sign-in at a time. A sync may sign you out of the Shin Kong Bank App. This is not yet confirmed.",
      "zh-TW": "新光銀行行動銀行可能同一時間只允許一處登入，同步可能讓你的新光銀行 App 登出。此行為尚未確認。",
    },
    startUrl: `${API}/`,
    async run(context, input) {
      await context.event("authentication", "authentication-started");
      const credentials = {
        idNumber: (input.credentials[KEY.idNumber] ?? "").trim(),
        alias: input.credentials[KEY.alias] ?? "",
        password: input.credentials[KEY.password] ?? "",
      };
      const deviceId = skbankDeviceId(credentials.idNumber, credentials.alias);
      return open(context, { pageUrl: input.startUrl, stripOriginFor: "*mbanking.skbank.com.tw*" }, async (http) => {
        const api = client(context, http, deviceId);
        await signIn(api, credentials);
        await context.event("authentication", "authentication-completed");
        try {
          await context.event("collection", "collection-started");
          const collectedAt = context.now();
          const accounts = await collect(api, collectedAt);
          await context.event("collection", "collection-completed");
          return await context.preview.write({ collectedAt, accounts });
        } finally {
          if (api.signedIn()) await api.send("POST", PATH.logout).catch(() => undefined);
        }
      });
    },
  };
}

export const SKBANK_PREVIEW_SOURCE = createSkbankSource();
