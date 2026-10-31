import { constants, createCipheriv, createHash, createPublicKey, publicEncrypt, randomInt, type KeyObject } from "node:crypto";
import type { PreviewAccount, PreviewTransaction } from "../../ledger/pglite/preview-financial-data.ts";
import { ProviderProtocolOutdatedError } from "../automation/source-access.ts";
import type { PreviewHttp, PreviewHttpOpener } from "./browser-http.ts";
import { nodeHttp } from "./node-http.ts";
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
  requireDeviceRegistration,
  taipeiMonthWindow,
  text,
  type SourceRecord,
} from "./source-kit.ts";
import type { PreviewWorkflowContext } from "./workflow.ts";

// ADR 0083: the Android App's JSON API. Only sign-in is encrypted.
const ORIGIN = "https://newnewbank.ubot.com.tw";
const SERVICE = `${ORIGIN}/NNBank/svc/`;
const REFERER = `${ORIGIN}/nnbank/`;

/** ADR 0083: the App this source presents, updated deliberately when the bank refuses it, never guessed. */
export const NEWNEWBANK_APP = {
  appVer: "4.6.0",
  deviceModel: "google-husky",
  deviceOSVer: "Android15",
  userAgent: "Mozilla/5.0 (Linux; Android 15; google-husky Build/AP3A.241005.015) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
} as const;

const API = {
  passwordKey: "NNBCM000007",
  requestKeys: "NNBCM000011",
  login: "NNBI010101",
  logout: "NNBI010103",
  summary: "NNBN020101",
  transactions: "NNBN010201",
} as const;

const MONTHS = 3;
const MAX_SPLIT_DEPTH = 8;
const OK = "0000";
const LOGIN_ACCEPTED = new Set([OK, "NS161", "NS164"]);
const CREDENTIAL_CODES = new Set(["NS169", "NS168", "NM92"]);
const SESSION_LOST_CODES = new Set(["NS888", "NS02", "NS03"]);
// Not documented: no refusal of an App version has been observed, so its wording is a guess.
const APP_OUTDATED = /請(?:先)?(?:更新|升級)|(?:版本|版號).{0,6}(?:過舊|過低|不符|不支援|已停用)|最新版本/u;
const CREDENTIAL_MESSAGE = /密碼|代號|使用者/u;
const NO_DATA = /查無/u;
const DEVICE_ID = /^[0-9a-f]{64}$/u;
const NT_DOLLAR_CURRENCY = "TWD";
const CURRENCY_FIELDS = ["Currency", "CurrencyEnglish", "Ccy"] as const;
const CURRENCY_ALIASES: Readonly<Record<string, string>> = { NTD: "TWD", "新臺幣": "TWD", "新台幣": "TWD", "臺幣": "TWD", "台幣": "TWD" };
/** TraType is the documented direction field; any other value fails the row. */
const TRADE_TYPES: Readonly<Record<string, Readonly<{ amount: "Expenditure" | "Income"; direction: "outflow" | "inflow" }>>> = {
  "1": { amount: "Expenditure", direction: "outflow" },
  "2": { amount: "Income", direction: "inflow" },
};

export const NEWNEWBANK_KEY = {
  idNumber: "PREVIEW_NEWNEWBANK_DEPOSIT_ID_NUMBER",
  userCode: "PREVIEW_NEWNEWBANK_DEPOSIT_USER_CODE",
  password: "PREVIEW_NEWNEWBANK_DEPOSIT_PASSWORD",
  deviceId: "PREVIEW_NEWNEWBANK_DEPOSIT_DEVICE_ID",
} as const;

export type NewnewbankEnvelope = Readonly<{ status: number; code: string; message: string; body: SourceRecord; date: string | null }>;

/** How the bank answered `NNBI010101`; each verdict has exactly one outcome. */
export type NewnewbankLoginVerdict = "signed-in" | "credentials-rejected" | "complete-in-app" | "app-outdated" | "unknown";

const halfWidth = (value: string) =>
  value.replace(/[！-～]/gu, (character) => String.fromCharCode(character.charCodeAt(0) - 0xfee0)).replace(/　/gu, " ").trim();

/** The App sends the upper-cased national ID with an `A` suffix as `sid`. */
export function newnewbankSid(idNumber: string): string {
  const id = halfWidth(idNumber).toUpperCase();
  return id.endsWith("A") ? id : `${id}A`;
}

/** `PublicKey` arrives as base64 PKCS#1 DER and `k1` as base64 SPKI DER; either is read as both. */
function rsaKey(base64: string, field: string): KeyObject {
  const der = Buffer.from(base64.replace(/\s+/gu, ""), "base64");
  for (const type of ["pkcs1", "spki"] as const) {
    try {
      return createPublicKey({ key: der, format: "der", type });
    } catch {
      continue;
    }
  }
  return fail("unexpected-response", `${field} is not an RSA public key`);
}

const rsaEncrypt = (key: KeyObject, value: string) =>
  publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(value, "utf8")).toString("base64");

/** `miMa`: the password encrypted with the `NNBCM000007` key (RSA PKCS#1 v1.5). */
export function encryptNewnewbankPassword(password: string, publicKey: string): string {
  return rsaEncrypt(rsaKey(publicKey, `${API.passwordKey}.PublicKey`), halfWidth(password));
}

const randomDigits = (length: number) => Array.from({ length }, () => String(randomInt(10))).join("");

/**
 * The App's `reqec` body: `p1` is the JSON text, PKCS#7-padded, under
 * AES-128-OFB with the `k2` key and a 16-digit IV; `p2` is that IV under the
 * `k1` RSA key. OFB never pads on its own, so the padding is added first.
 */
export function encryptNewnewbankRequest(
  payload: Readonly<Record<string, unknown>>,
  k1: string,
  k2: string,
  iv: string = randomDigits(16),
): Readonly<{ p1: string; p2: string }> {
  const aesKey = Buffer.from(k2.replace(/\s+/gu, ""), "base64");
  if (aesKey.length !== 16) return fail("unexpected-response", `${API.requestKeys}.k2 is not an AES-128 key`);
  const plain = Buffer.from(JSON.stringify(payload), "utf8");
  const padding = 16 - (plain.length % 16);
  const cipher = createCipheriv("aes-128-ofb", aesKey, Buffer.from(iv, "utf8")).setAutoPadding(false);
  const p1 = Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.alloc(padding, padding)])), cipher.final()]).toString("base64");
  return { p1, p2: rsaEncrypt(rsaKey(k1, `${API.requestKeys}.k1`), iv) };
}

export function newnewbankLoginVerdict(envelope: NewnewbankEnvelope): NewnewbankLoginVerdict {
  if (APP_OUTDATED.test(envelope.message)) return "app-outdated";
  if (envelope.code === "NS090") return "complete-in-app";
  if (envelope.status >= 400 || CREDENTIAL_CODES.has(envelope.code)) return "credentials-rejected";
  if (!LOGIN_ACCEPTED.has(envelope.code)) return CREDENTIAL_MESSAGE.test(envelope.message) ? "credentials-rejected" : "unknown";
  const flags = typeof envelope.body.FlagList === "object" && envelope.body.FlagList !== null ? envelope.body.FlagList as SourceRecord : {};
  if (optionalText(flags.MissingUserFlag) === "2" || optionalText(flags.KycFlag)?.toUpperCase() === "Y") return "complete-in-app";
  return "signed-in";
}

async function signInFailure(context: PreviewWorkflowContext, verdict: Exclude<NewnewbankLoginVerdict, "signed-in">): Promise<never> {
  switch (verdict) {
    case "credentials-rejected":
      return fail("sign-in-rejected", "New New Bank rejected the sign-in details");
    case "complete-in-app":
      return requireDeviceRegistration(context, "New New Bank asks the person to complete identity or profile verification in its App");
    case "app-outdated":
      throw new ProviderProtocolOutdatedError();
    case "unknown":
      return fail("unexpected-response", "the sign-in answer was not recognized");
  }
}

function envelopeOf(context: PreviewWorkflowContext, api: string, response: Readonly<{ status: number; headers: Readonly<Record<string, string>>; text: string }>): NewnewbankEnvelope {
  let parsed: unknown = null;
  try {
    parsed = parseSourceJson(response.text, api);
  } finally {
    context.preview.observe({ endpoint: api, status: response.status, body: parsed });
  }
  const root = record(parsed, api);
  const result = typeof root.ResCode === "object" && root.ResCode !== null ? root.ResCode as SourceRecord : root;
  const body = root.ResBody === undefined || root.ResBody === null ? {} : record(root.ResBody, `${api}.ResBody`);
  return {
    status: response.status,
    code: optionalText(result.RtnCode) ?? "",
    message: optionalText(result.RtnDesc) ?? optionalText(result.RtnMsg) ?? optionalText(root.RtnMsg) ?? "",
    body,
    date: response.headers.date ?? null,
  };
}

type Client = Readonly<{
  signIn(credentials: Readonly<{ idNumber: string; userCode: string; password: string; deviceId: string }>): Promise<void>;
  query(api: string, body: Readonly<Record<string, unknown>>): Promise<NewnewbankEnvelope>;
  logout(): Promise<void>;
}>;

function client(context: PreviewWorkflowContext, http: PreviewHttp): Client {
  let ssid: string | null = null;
  const post = async (api: string, body: Readonly<Record<string, unknown>>) => {
    const response = await http({
      method: "POST",
      url: `${SERVICE}${api}`,
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json;charset=UTF-8",
        "User-Agent": NEWNEWBANK_APP.userAgent,
        Origin: ORIGIN,
        Referer: REFERER,
        ...ssid === null ? {} : { Authorization: ssid },
      },
      body: JSON.stringify(body),
      credentials: "include",
    });
    ssid = optionalText(response.headers.ssid) ?? ssid;
    return envelopeOf(context, api, response);
  };
  const required = async (api: string, body: Readonly<Record<string, unknown>> = {}) => {
    const envelope = await post(api, body);
    if (envelope.status === 401 || envelope.status === 403 || SESSION_LOST_CODES.has(envelope.code))
      return fail("session-conflict", `${api} reports the session ended`);
    if (envelope.status < 200 || envelope.status >= 300) return fail("unexpected-response", `${api} HTTP ${envelope.status}`);
    return envelope;
  };
  return {
    async signIn(credentials) {
      const passwordKey = await required(API.passwordKey);
      if (passwordKey.code !== OK) return fail("unexpected-response", `${API.passwordKey} answered ${passwordKey.code}`);
      const requestKeys = await required(API.requestKeys);
      if (requestKeys.code !== OK) return fail("unexpected-response", `${API.requestKeys} answered ${requestKeys.code}`);
      const login = await post(API.login, encryptNewnewbankRequest({
        sid: newnewbankSid(credentials.idNumber),
        nickName: halfWidth(credentials.userCode),
        miMa: encryptNewnewbankPassword(credentials.password, text(passwordKey.body.PublicKey, `${API.passwordKey}.PublicKey`)),
        serial: "",
        deviceUuid: credentials.deviceId,
        appVer: NEWNEWBANK_APP.appVer,
        deviceModel: NEWNEWBANK_APP.deviceModel,
        deviceOSVer: NEWNEWBANK_APP.deviceOSVer,
      }, text(requestKeys.body.k1, `${API.requestKeys}.k1`), text(requestKeys.body.k2, `${API.requestKeys}.k2`)));
      const verdict = newnewbankLoginVerdict(login);
      if (verdict !== "signed-in") return signInFailure(context, verdict);
      if (ssid === null) return fail("unexpected-response", `${API.login} returned no ssid`);
    },
    query: required,
    async logout() {
      if (ssid !== null) await post(API.logout, {});
    },
  };
}

const compact = (date: string) => date.replaceAll("-", "");
const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);

/**
 * TraDate and TraDateTime as Taipei local dates. The App mixes Gregorian and
 * ROC years: `2026-10-16`, `115/10/16`, `1151016`, `20261016`, `01151016`.
 */
export function newnewbankDate(value: unknown, field: string) {
  const raw = halfWidth(typeof value === "string" ? value : "");
  const match = /^(?:(\d{3,4})[./-](\d{1,2})[./-](\d{1,2})|(\d{7,8}))(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/u.exec(raw);
  if (!match) return fail("unexpected-response", `${field} is not a date`);
  const [, year, month, day, packed, hour, minute, second] = match;
  let parts: readonly [string, string, string];
  if (packed === undefined) parts = [year!, month!, day!];
  else if (packed.length === 7 || packed.startsWith("0")) parts = [packed.slice(-7, -4), packed.slice(-4, -2), packed.slice(-2)];
  else parts = [packed.slice(0, 4), packed.slice(4, 6), packed.slice(6)];
  const gregorian = parts[0].length <= 3 ? String(Number(parts[0]) + 1911) : parts[0];
  const time = hour === undefined ? "" : ` ${hour.padStart(2, "0")}:${minute}${second === undefined ? "" : `:${second}`}`;
  return localDate(`${gregorian}-${parts[1].padStart(2, "0")}-${parts[2].padStart(2, "0")}${time}`, field);
}

/**
 * Every `NNBN010201` row of the window. `WarnCode` `MFOB` means the range
 * holds more rows than one answer carries, so the range is halved; a range
 * that cannot be halved further fails rather than keep a partial list.
 */
async function transactionRows(api: Client, start: string, end: string, depth = 0): Promise<SourceRecord[]> {
  const envelope = await api.query(API.transactions, { beginDate: compact(start), endDate: compact(end) });
  if (envelope.code !== OK) return NO_DATA.test(envelope.message) ? [] : fail("unexpected-response", `${API.transactions} answered ${envelope.code}`);
  if (optionalText(envelope.body.WarnCode) === "MFOB") {
    if (start >= end || depth >= MAX_SPLIT_DEPTH) return fail("incomplete-data", `${API.transactions} reports more rows than one answer for ${start}..${end}`);
    const days = Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000);
    const middle = isoDay(Date.parse(start) + Math.floor(days / 2) * 86_400_000);
    return [
      ...await transactionRows(api, start, middle, depth + 1),
      ...await transactionRows(api, isoDay(Date.parse(middle) + 86_400_000), end, depth + 1),
    ];
  }
  return [...records(envelope.body.Details, `${API.transactions}.Details`)];
}

function sourceCurrency(entry: SourceRecord, field: string): string {
  const name = CURRENCY_FIELDS.find((candidate) => optionalText(entry[candidate]) !== null);
  return name === undefined ? NT_DOLLAR_CURRENCY : currencyCode(entry[name], `${field}.${name}`, CURRENCY_ALIASES);
}

export function newnewbankTransactions(rows: readonly SourceRecord[], currency: string): PreviewTransaction[] {
  const occurrences = new Map<string, number>();
  return rows.map((row, index) => {
    const field = `${API.transactions}.Details[${index}]`;
    const type = TRADE_TYPES[optionalText(row.TraType) ?? ""] ?? fail("unexpected-response", `${field}.TraType is neither 1 nor 2`);
    const amount = exactDecimal(row[type.amount], `${field}.${type.amount}`).replace(/^-/u, "");
    const posted = newnewbankDate(row.TraDate, `${field}.TraDate`);
    const at = optionalText(row.TraDateTime) === null ? posted : newnewbankDate(row.TraDateTime, `${field}.TraDateTime`);
    const balance = optionalText(row.Balance) === null ? "" : exactDecimal(row.Balance, `${field}.Balance`);
    const descriptions = [...new Set([optionalText(row.TraSum), optionalText(row.PS)].filter((value) => value !== null))];
    const identity = [at.value, type.direction, amount, balance, ...descriptions].join("\u0000");
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    return {
      sourceRowKey: `${posted.value}:${createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 16)}:${occurrence}`,
      amount,
      currency: sourceCurrency(row, field) === currency ? currency : fail("unexpected-response", `${field} is in another currency than its account`),
      direction: type.direction,
      postedAt: posted,
      description: descriptions.length > 0 ? descriptions.join(" · ") : null,
    };
  });
}

async function collectDeposits(api: Client, collectedAt: string): Promise<PreviewAccount[]> {
  const summary = await api.query(API.summary, {});
  if (summary.code !== OK) return fail("unexpected-response", `${API.summary} answered ${summary.code}`);
  const accountNo = text(summary.body.Account, `${API.summary}.Account`).replace(/\D/gu, "");
  if (accountNo.length < 8) return fail("unexpected-response", `${API.summary}.Account has no account number`);
  const currency = sourceCurrency(summary.body, API.summary);
  const asOf = observedAt(summary.date, collectedAt);
  const current = exactDecimal(summary.body.AccountBal, `${API.summary}.AccountBal`);
  const available = optionalText(summary.body.AvailableBal) === null ? null : exactDecimal(summary.body.AvailableBal, `${API.summary}.AvailableBal`);
  const window = taipeiMonthWindow(collectedAt, MONTHS);
  return [{
    sourceAccountKey: `${accountNo}:${currency}`,
    displayLabel: `New New Bank 數位帳戶 ${accountNo.slice(-4)}`,
    currency,
    type: "depository",
    balances: [
      { kind: "current", amount: current, currency, observedAt: asOf },
      ...available === null ? [] : [{ kind: "available" as const, amount: available, currency, observedAt: asOf }],
    ],
    transactions: newnewbankTransactions(await transactionRows(api, window.start, window.end), currency),
  }];
}

export function createNewnewbankSource(options: Readonly<{ http?: PreviewHttpOpener }> = {}): PreviewSource {
  const open = options.http ?? nodeHttp;
  return {
    id: "newnewbank-deposit",
    institution: PREVIEW_SOURCE_INSTITUTIONS["newnewbank-deposit"],
    products: ["deposit"],
    displayName: { en: "Union Bank New New Bank deposits (preview)", "zh-TW": "聯邦銀行 New New Bank 存款（預覽）" },
    searchAliases: ["New New Bank", "NNB", "Union Bank", "Union Bank of Taiwan", "UBOT", "聯邦", "聯邦銀行", "聯邦商業銀行", "新新銀行"],
    credentialFields: [
      { key: NEWNEWBANK_KEY.idNumber, label: { en: "Taiwan ID number", "zh-TW": "身分證字號" }, input: "text", redaction: "partial" },
      { key: NEWNEWBANK_KEY.userCode, label: { en: "User code", "zh-TW": "使用者代號" }, input: "text", redaction: "partial" },
      { key: NEWNEWBANK_KEY.password, label: { en: "Password", "zh-TW": "使用者密碼" }, input: "password", redaction: "full" },
    ],
    deviceIdentityKey: NEWNEWBANK_KEY.deviceId,
    setupGuide: {
      summary: {
        en: "Preview source, never run against a live New New Bank account. Its data may be incomplete or wrong. It signs in through the New New Bank App protocol as a separate device and collects the NT-dollar digital account balance and three months of transactions.",
        "zh-TW": "預覽來源，從未以真實的 New New Bank 帳戶執行過，資料可能不完整或有誤。它以 New New Bank App 的協定、作為另一台裝置登入，收集臺幣數位帳戶餘額與近三個月交易明細。",
      },
      requirements: [{ en: "A Union Bank New New Bank digital account that signs in to the New New Bank App.", "zh-TW": "可登入 New New Bank App 的聯邦銀行 New New Bank 數位帳戶。" }],
      steps: [
        {
          en: "Enter the ID number, user code, and password you use to sign in to the New New Bank App. A rejected sign-in is never retried.",
          "zh-TW": "輸入登入 New New Bank App 使用的身分證字號、使用者代號與使用者密碼。登入被拒絕時不會重試。",
        },
        {
          en: "The first sign-in comes from a new device. If New New Bank asks for identity or profile verification, complete it in the New New Bank App, then sync again.",
          "zh-TW": "第一次登入會被視為新裝置。若 New New Bank 要求身分或基本資料驗證，請在 New New Bank App 完成後再同步。",
        },
      ],
      links: [{
        id: "newnewbank-site",
        label: { en: "Union Bank New New Bank", "zh-TW": "聯邦銀行 New New Bank" },
        url: "https://newnewbank.ubot.com.tw/",
        allowedHosts: ["newnewbank.ubot.com.tw"],
      }],
    },
    sessionTakeover: {
      notice: {
        en: "Whether a sync signs you out of the New New Bank App is unconfirmed. A sync signs itself out when it ends.",
        "zh-TW": "同步是否會讓你登出 New New Bank App 尚未確認。同步結束時會自行登出。",
      },
    },
    startUrl: `${ORIGIN}/nnbank/`,
    async run(context, input) {
      if (!input.products.includes("deposit")) return context.preview.collect({});
      const deviceId = input.credentials[NEWNEWBANK_KEY.deviceId] ?? "";
      if (!DEVICE_ID.test(deviceId)) return fail("sign-in-rejected", "no device identity is stored with the sign-in details");
      await context.event("authentication", "started", "authentication-started");
      return open(context, { pageUrl: input.startUrl }, async (http) => {
        const api = client(context, http);
        try {
          await api.signIn({
            idNumber: input.credentials[NEWNEWBANK_KEY.idNumber] ?? "",
            userCode: input.credentials[NEWNEWBANK_KEY.userCode] ?? "",
            password: input.credentials[NEWNEWBANK_KEY.password] ?? "",
            deviceId,
          });
          await context.event("authentication", "completed", "authentication-completed");
          await context.event("collection", "started", "collection-started");
          const collectedAt = context.now();
          const output = await context.preview.collect({ deposit: async () => ({ collectedAt, accounts: await collectDeposits(api, collectedAt) }) });
          await context.event("collection", "completed", "collection-completed");
          return output;
        } finally {
          await api.logout().catch(() => undefined);
        }
      });
    },
  };
}

export const NEWNEWBANK_PREVIEW_SOURCE = createNewnewbankSource();
