import { constants, createCipheriv, createHash, createPublicKey, pbkdf2Sync, publicEncrypt, randomBytes, randomUUID } from "node:crypto";
import type {
  PreviewCard,
  PreviewCreditAccount,
  PreviewCreditBalance,
  PreviewCreditCollection,
  PreviewLocalDate,
  PreviewPurchase,
  PreviewStatement,
} from "../../ledger/pglite/preview-financial-data.ts";
import { ProductCollectionFatalError } from "../automation/product-collection.ts";
import type { PreviewHttp, PreviewHttpOpener } from "./browser-http.ts";
import { nodeHttp } from "./node-http.ts";
import type { PreviewProductAbsence } from "./product-collection.ts";
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
  requireDeviceRegistration,
  text,
  type SourceRecord,
} from "./source-kit.ts";
import type { PreviewWorkflowContext } from "./workflow.ts";

// Pinned App protocol (ADR 0044). See docs/research/2026-10-18-ctbc-app-transport-probe.md.
const IMP = "https://eb.ctbcbank.com/IMP";
const APPLICATION = "EBMW_Adapter";
const RESOURCE_ENDPOINT = `${IMP}/api/adapters/${APPLICATION}/resource/ebmwResource`;
export const CTBC_APP_VERSION = "5.2.26";
const WEB_VERSION = "(0812)";
const BUILD_DISPLAY = "AP3A.241005.015";
const USER_AGENT =
  `Mozilla/5.0 (Linux; Android 15; Pixel 8 Build/${BUILD_DISPLAY}; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.58 Mobile Safari/537.36`;
// The MobileFirst client credential shipped in the public Android package.
const PUBLIC_CLIENT_TOKEN = "2ae74c0ad7a14739a2aab7340616d70e";
const PIN_RSA_EXPONENT = "9719";
const PIN_RSA_MODULUS =
  "DF63FFC2F35068BA9A964D234C3400E6394148BC69DF0DD8257340747AD73BF8514C76254F5BEA223BFF76B63840034518E0FA0A1E1905129EC69203A0873A63E5238FFE538DBEFBB64F9318C0BEEF75595DE991E004213B7FE9DA62229BDA1722B45ABAF906F26CF6D88B5BE8F18C26FCA630C6813B0D370E64E1C8D80A790F936C064A5620BFA2C6EE4B5BB962F7703A258028D53923866E43C98C36758262D6DE9D02DECFD74B211E3233924D499B864E1CA86DF012EAFFC9933A0CD2E011843B772E53C6435F78A60437E82D1677664221D01F59797D28771B2AE207EAB00E8500AA2A4FB61FF330B59FC5B699A241D9A44139CF876A74F0DE180107D7DF";
const DEVICE_SALT = "octopusbeak-ctbc-card-virtual-device-v1";
const MAX_PAGES = 20;
const OK = "0000";

const RESOURCE = {
  login: "/twrbm-general/ot001/010",
  logout: "/twrbm-general/ot002/010",
  bills: "/twrbm-card/qu002/010",
  summary: "/twrbm-card/qu046/010",
  unbilledInit: "/twrbm-card/qu006/010",
  unbilled: "/twrbm-card/qu006/011",
  unbilledPage: "/twrbm-card/qu006/015",
  realtime: "/twrbm-card/qu041/010",
  realtimePage: "/twrbm-card/qu041/015",
} as const;

const KEY = {
  idNumber: "PREVIEW_CTBC_CREDIT_CARD_ID_NUMBER",
  userCode: "PREVIEW_CTBC_CREDIT_CARD_USER_CODE",
  password: "PREVIEW_CTBC_CREDIT_CARD_PASSWORD",
} as const;

const CURRENCY_ALIASES = { NTD: "TWD", "901": "TWD", "840": "USD", "392": "JPY", "978": "EUR" } as const;
const UPDATE_PROMPT = /更新至最新版本/u;
const VERIFICATION_CODES = new Set(["0526", "2802", "2911", "4002", "4050", "9015", "9030"]);
const NO_CARD_MESSAGE =
  /^(?:您)?(?:目前)?(?:(?:尚未|未|沒有|無)(?:持有|申辦|申請)?(?:本行)?信用卡|沒有(?:本行)?有效卡|非(?:本行)?(?:信用卡)?(?:持卡人|卡友)|非(?:本行)?信用卡客戶)(?=[，,。.!！；;]|$)/u;

type Response = Readonly<{ body: SourceRecord; date: string | null }>;

const PIN_KEY = createPublicKey({
  key: {
    kty: "RSA",
    n: Buffer.from(PIN_RSA_MODULUS, "hex").toString("base64url"),
    e: Buffer.from(PIN_RSA_EXPONENT, "hex").toString("base64url"),
  },
  format: "jwk",
});

function randomDigits(length: number, random: (size: number) => Buffer): string {
  return [...random(length)].map((byte) => String(byte % 10)).join("");
}

/**
 * The App 5.2.26 `makeEncryptPINClear` format: the value XOR-ed with random
 * digits, AES-256-CBC (zero IV) under a PBKDF2-SHA1 key from ten random
 * digits, and that key wrapped with CTBC's pinned RSA key (PKCS#1 v1.5).
 */
export function encryptCtbcPin(value: string, random: (size: number) => Buffer = randomBytes): string {
  if (value === "") return fail("sign-in-rejected", "a CTBC sign-in field is empty");
  const xorKey = randomDigits(value.length, random);
  const xorText = [...value].map((_, index) => String.fromCharCode(value.charCodeAt(index) ^ xorKey.charCodeAt(index))).join("");
  const clearText = `${String(value.length).padStart(2, "0")}${xorKey}${xorText}`;
  const aesKey = pbkdf2Sync(randomDigits(10, random), random(16), 1, 32, "sha1");
  const cipher = createCipheriv("aes-256-cbc", aesKey, Buffer.alloc(16));
  const encrypted = Buffer.concat([cipher.update(clearText, "utf8"), cipher.final()]).toString("hex");
  const wrapped = publicEncrypt({ key: PIN_KEY, padding: constants.RSA_PKCS1_PADDING }, aesKey).toString("hex");
  return `${encrypted}|${wrapped.padStart(512, "0")}`;
}

/**
 * The preview context has no persistence port, so the device code is a pure
 * function of the sign-in identifier: the same person presents the same
 * device on every run.
 */
export function ctbcDeviceCode(idNumber: string, userCode: string): string {
  const hex = createHash("sha256").update(`${DEVICE_SALT}\u0000${idNumber.toUpperCase()}|${userCode}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const hasText = (value: unknown) => typeof value === "string" && value.trim() !== "";
const optionalRecord = (value: unknown): SourceRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as SourceRecord : {};

function resultCode(body: SourceRecord): string {
  return optionalText(body.code) ?? optionalText(body.statusCode) ?? "";
}

function rejected(body: SourceRecord): boolean {
  const code = optionalText(body.code);
  const statusCode = optionalText(body.statusCode);
  return (code !== null && code !== OK) || (statusCode !== null && statusCode !== OK) || body.success === false;
}

function isVerificationFlagKey(key: string): boolean {
  return /^(?:need|require|required|pending|challenge).*(?:otp|verify|verification|binddevice|twostage)/iu.test(key)
    || /(?:otp|verify|verification|binddevice|twostage).*(?:required|pending|challenge)$/iu.test(key);
}

/** A login or query that CTBC interrupts for device binding, two-stage approval, OTP, or contact verification. */
function asksForVerification(body: SourceRecord): boolean {
  if (VERIFICATION_CODES.has(resultCode(body))) return true;
  const data = optionalRecord(body.rsData);
  const verify = optionalRecord(data.verifyData).verify;
  return data.isTwoStageLogin === true
    || data.needBindDevice === true
    || hasText(data.deviceBindBlackListCheckTimestamp)
    || hasText(data.verifySharedDeviceTimestamp)
    || verify === "11" || verify === "21"
    || Object.entries(data).some(([key, value]) => isVerificationFlagKey(key)
      && (value === true || /^(?:y|yes|required|pending|true|1)$/iu.test(typeof value === "string" ? value.trim() : "")));
}

function protocolOutdated(): never {
  throw new ProductCollectionFatalError("provider-protocol-outdated");
}

function client(context: PreviewWorkflowContext, http: PreviewHttp, deviceCode: string) {
  const deviceIxd = deviceCode.replaceAll("-", "");
  const clientNo = String(Date.parse(context.now()));
  let accessToken = "";
  let xAuthToken = "";
  let transactionToken = "mfpInit";
  let seed = "";
  let signedIn = false;

  const baseHeaders = (): Record<string, string> => ({
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    Authorization: `Bearer ${accessToken}`,
  });

  async function post(url: string, endpoint: string, headers: Record<string, string>, body: string): Promise<Response> {
    const response = await http({ method: "POST", url, headers, body });
    const parsed = response.text === "" ? null : parseSourceJson(response.text, endpoint);
    context.preview.observe({ endpoint, status: response.status, body: parsed });
    if (response.status !== 200) return fail("unexpected-response", `${endpoint} HTTP ${response.status}`);
    const next = response.headers["x-auth-token"];
    if (next) xAuthToken = next;
    const result = record(parsed, endpoint);
    if (UPDATE_PROMPT.test(`${optionalText(result.desc) ?? ""} ${optionalText(result.message) ?? ""}`)) protocolOutdated();
    return { body: result, date: response.headers.date ?? null };
  }

  function envelope(rqData: Record<string, unknown>, resource?: string): Record<string, unknown> {
    return {
      deviceIxd,
      trackingIxd: randomUUID(),
      txnIxd: "",
      model: "Google Pixel 8",
      platform: "Android",
      version: "15",
      network: "wifi",
      appVer: CTBC_APP_VERSION,
      clientNo,
      clientTime: String(Date.parse(context.now())),
      locale: "zh_TW",
      fromSys: "0",
      seed,
      deviceToken: "",
      buildDisplay: BUILD_DISPLAY,
      rqData,
      webVer: WEB_VERSION,
      ...(resource === undefined ? {} : { resource }),
      ...(transactionToken === "mfpInit" ? {} : { token: transactionToken }),
    };
  }

  async function postResource(endpoint: string, body: Record<string, unknown>, headers: Record<string, string>): Promise<Response> {
    const serialized = JSON.stringify(body);
    const response = await post(RESOURCE_ENDPOINT, endpoint, {
      ...baseHeaders(),
      checksum: createHash("sha256").update(serialized, "utf8").digest("hex"),
      deviceCode,
      ...headers,
    }, serialized);
    const next = optionalText(response.body.token);
    if (next) transactionToken = next;
    return response;
  }

  function resource(path: string, rqData: Record<string, unknown>): Promise<Response> {
    return postResource(path, envelope(rqData, path), {
      ...(transactionToken === "mfpInit" ? { "X-Requested-With": "MFPInit" } : {}),
      ...(signedIn ? {} : { "X-Request-Type": "preLogin" }),
      ...(xAuthToken ? { "x-auth-token": xAuthToken } : {}),
    });
  }

  return {
    async bootstrap() {
      const tokenUrl = `${IMP}/oauth/token?${new URLSearchParams({ grant_type: "client_credentials", scope: "PUBLIC", client_id: APPLICATION, client_secret: PUBLIC_CLIENT_TOKEN })}`;
      const oauth = await post(tokenUrl, "oauth/token", { ...baseHeaders(), "Content-Type": "application/x-www-form-urlencoded" }, "");
      accessToken = text(oauth.body.access_token, "oauth/token.access_token");
      const init = await post(`${IMP}/main/init`, "main/init", baseHeaders(), JSON.stringify({
        application: APPLICATION,
        deviceCode,
        deviceManufacturer: "Google",
        deviceModel: "Pixel 8",
        devicePlatform: "Android",
        deviceVersion: "15",
        pclientTime: Date.parse(context.now()),
        randomNumber: "",
        clientPubk: "",
      }));
      if (optionalText(init.body.statusCode) !== OK) return fail("unexpected-response", "main/init statusCode");
      const handshake = await postResource("ebmwResource handshakewb", envelope({}), { "X-Request-Type": "handshakewb" });
      if (handshake.body.success !== true) return fail("unexpected-response", "the handshake did not succeed");
      // The probe saw 0 for the pinned version and 2 for every older one.
      const validation = text(handshake.body.appVersionValidate, "handshake.appVersionValidate");
      if (validation !== "0") protocolOutdated();
      seed = optionalText(optionalRecord(handshake.body.rsData).seed) ?? "";
    },
    async login(idNumber: string, userCode: string, password: string) {
      const response = await resource(RESOURCE.login, {
        loginType: "PW",
        custId: idNumber,
        uniNo: "",
        bankIdNo: "",
        cardIdNo: "",
        isMvpApp: false,
        isCoverApp: false,
        custSeqFIDO: "",
        version: CTBC_APP_VERSION,
        twoStageVerify: true,
        userAgent: USER_AGENT,
        deviceBindBlackList: "Y",
        checkDeviceShare: "Y",
        userId: encryptCtbcPin(userCode),
        pin: encryptCtbcPin(password),
      });
      const data = optionalRecord(response.body.rsData);
      if (data.forcePwdChange !== undefined && data.forcePwdChange !== null) {
        signedIn = true;
        return fail("sign-in-rejected", "CTBC requires a password change in its App");
      }
      if (asksForVerification(response.body)) return requireDeviceRegistration(context, "CTBC asks for device, two-stage, or contact verification");
      // Confirming dupLoginCheckTimestamp would end the other session; a preview run never does.
      if (hasText(data.dupLoginCheckTimestamp)) return fail("session-conflict", "CTBC reports another signed-in session");
      if (rejected(response.body)) return fail("sign-in-rejected", `login code ${resultCode(response.body) || "missing"}`);
      signedIn = true;
    },
    async query(path: string, rqData: Record<string, unknown>, accept: (body: SourceRecord) => boolean = () => false): Promise<Response> {
      const response = await resource(path, rqData);
      if (accept(response.body)) return response;
      if (asksForVerification(response.body)) return fail("session-conflict", `${path} asks for verification after sign-in`);
      if (rejected(response.body)) return fail("unexpected-response", `${path} code ${resultCode(response.body) || "missing"}`);
      return response;
    },
    async logout() {
      if (!signedIn) return;
      signedIn = false;
      await resource(RESOURCE.logout, {});
    },
  };
}

type Api = ReturnType<typeof client>;

const isNoCardMessage = (value: unknown) =>
  typeof value === "string" && NO_CARD_MESSAGE.test(value.replace(/\s+/gu, "").replace(/^\d{4}[:：]/u, ""));

const truthyFlag = (value: unknown) => value === true || value === "Y";

function integer(value: unknown, field: string): number {
  const lexeme = typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/u.test(lexeme)) return fail("incomplete-data", `${field} is not an integer`);
  return Number(lexeme);
}

/** Every page of a card list. A paging flag or row count that does not add up fails instead of truncating. */
async function pagedItems(api: Api, first: string, next: string, rqData: Record<string, unknown>): Promise<SourceRecord[]> {
  const initial = record((await api.query(first, rqData)).body.rsData, `${first}.rsData`);
  const items = [...records(initial.allItems, `${first}.allItems`)];
  if (truthyFlag(initial.displayPaging)) {
    const pageSize = integer(initial.pageCount, `${first}.pageCount`);
    const total = integer(initial.totalRow, `${first}.totalRow`);
    if (pageSize === 0) return fail("incomplete-data", `${first}.pageCount is zero`);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    if (pages > MAX_PAGES) return fail("incomplete-data", `${first} has ${pages} pages`);
    for (let pageNum = 2; pageNum <= pages; pageNum += 1) {
      const page = record((await api.query(next, { pageNum })).body.rsData, `${next}.rsData`);
      items.push(...records(page.allItems, `${next}.allItems`));
    }
    if (items.length !== total) return fail("incomplete-data", `${first} returned ${items.length} of ${total} rows`);
  } else if (initial.totalRow !== undefined && integer(initial.totalRow, `${first}.totalRow`) !== items.length) {
    return fail("incomplete-data", `${first} returned ${items.length} of ${String(initial.totalRow)} rows`);
  }
  return items;
}

export type CtbcCardPayloads = Readonly<{
  bills: Response;
  /** The unbilled rows of every currency the unbilled query offers. */
  unbilled: ReadonlyMap<string, readonly SourceRecord[]>;
  realtime: readonly SourceRecord[];
}>;

async function collectPayloads(api: Api): Promise<CtbcCardPayloads | PreviewProductAbsence> {
  const bills = await api.query(RESOURCE.bills, {}, (body) => isNoCardMessage(body.message));
  if (isNoCardMessage(bills.body.message)) return { absent: "not_held" };
  const data = record(bills.body.rsData, `${RESOURCE.bills}.rsData`);
  const cardList = records(data.cardDataList, `${RESOURCE.bills}.cardDataList`);
  const billData = record(data.billData, `${RESOURCE.bills}.billData`);
  if (cardList.length === 0 && Object.keys(billData).length === 0) return { absent: "not_held" };
  // The App calls the summary before the lists; its fields have no confirmed meaning, so it is only observed.
  await api.query(RESOURCE.summary, {});
  const init = record((await api.query(RESOURCE.unbilledInit, {})).body.rsData, `${RESOURCE.unbilledInit}.rsData`);
  if (!Array.isArray(init.curOptions) && !Array.isArray(init.curDataList))
    return fail("unexpected-response", `${RESOURCE.unbilledInit} lists no currencies`);
  const options = [...(Array.isArray(init.curOptions) ? init.curOptions : []), ...(Array.isArray(init.curDataList) ? init.curDataList : [])];
  const currencies = [...new Set(options.map((option, index) =>
    currencyCode(record(option, `${RESOURCE.unbilledInit}.currencies[${index}]`).curCode, `${RESOURCE.unbilledInit}.currencies[${index}].curCode`, CURRENCY_ALIASES)))];
  const unbilled = new Map<string, readonly SourceRecord[]>();
  for (const currency of currencies)
    unbilled.set(currency, await pagedItems(api, RESOURCE.unbilled, RESOURCE.unbilledPage, { curCode: currency }));
  const realtime = await pagedItems(api, RESOURCE.realtime, RESOURCE.realtimePage, {});
  return { bills, unbilled, realtime };
}

/** Card dates are MMDDYY in bills and YYYYMMDD elsewhere; `000000` or any other text is no date. */
function cardDate(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  const compact = /^(\d{2})(\d{2})(\d{2})$/u.exec(raw);
  const candidate = compact ? `20${compact[3]}-${compact[1]}-${compact[2]}` : raw;
  if (!/^\d{4}[-/]?\d{2}[-/]?\d{2}$/u.test(candidate)) return null;
  try {
    return localDate(candidate, "card date").value;
  } catch {
    return null;
  }
}

function requiredCardDate(value: unknown, field: string): string {
  return cardDate(value) ?? fail("unexpected-response", `${field} is not a date`);
}

function billingPeriod(key: string, closingDate: string): string {
  const parts = /^(\d{3,4})[/-]?(\d{1,2})$/u.exec(key.trim());
  if (!parts) return closingDate.slice(0, 7);
  const year = Number(parts[1]) < 1911 ? Number(parts[1]) + 1911 : Number(parts[1]);
  const month = Number(parts[2]);
  if (month < 1 || month > 12) return fail("unexpected-response", `billing period ${key} is not a month`);
  return `${year}-${String(month).padStart(2, "0")}`;
}

function addDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** The day after the same day one month earlier, clamped to that month's last day. */
function dayAfterPreviousClosing(closingDate: string): string {
  const [year, month, day] = closingDate.split("-").map(Number) as [number, number, number];
  const lastDay = new Date(Date.UTC(year, month - 1, 0)).getUTCDate();
  const previous = new Date(Date.UTC(year, month - 2, Math.min(day, lastDay))).toISOString().slice(0, 10);
  return addDays(previous, 1);
}

type Bill = Readonly<{
  currency: string;
  period: string;
  closingDate: string;
  dueDate: string | null;
  summary: SourceRecord;
  field: string;
  rows: readonly SourceRecord[];
}>;

function bills(billData: SourceRecord): Bill[] {
  const result: Bill[] = [];
  for (const [currencyKey, periods] of Object.entries(billData)) {
    const currency = currencyCode(currencyKey, `billData.${currencyKey}`, CURRENCY_ALIASES);
    for (const [periodKey, group] of Object.entries(record(periods, `billData.${currencyKey}`))) {
      const field = `billData.${currencyKey}.${periodKey}`;
      const groupRecord = record(group, field);
      const summary = groupRecord.summary === undefined ? groupRecord : record(groupRecord.summary, `${field}.summary`);
      const closingDate = requiredCardDate(summary.billDt, `${field}.billDt`);
      result.push({
        currency,
        period: billingPeriod(periodKey, closingDate),
        closingDate,
        dueDate: cardDate(summary.pmtExpDt),
        summary,
        field,
        rows: groupRecord.bills === undefined ? [] : records(groupRecord.bills, `${field}.bills`),
      });
    }
  }
  const keys = result.map((bill) => `${bill.currency}:${bill.period}`);
  if (new Set(keys).size !== keys.length) return fail("unexpected-response", "billData repeats a currency and billing period");
  return result.sort((left, right) => left.currency.localeCompare(right.currency) || left.period.localeCompare(right.period));
}

function cardLast4(row: SourceRecord): string | null {
  for (const value of [row.cardNoSuffixFour, row.cardNo, row.fullCardNo]) {
    const digits = typeof value === "string" ? /(\d{4})\D*$/u.exec(value)?.[1] : undefined;
    if (digits) return digits;
  }
  return null;
}

const cardKey = (last4: string) => `card-${last4}`;

function cardsFrom(list: readonly SourceRecord[], rows: readonly SourceRecord[]): PreviewCard[] {
  const cards = new Map<string, PreviewCard>();
  for (const [index, card] of list.entries()) {
    const last4 = cardLast4(card) ?? fail("unexpected-response", `cardDataList[${index}] has no card number`);
    if (cards.has(cardKey(last4))) return fail("unexpected-response", `cardDataList repeats a card ending ${last4}`);
    const label = [optionalText(card.cardName), optionalText(card.positiveOrAttached)].filter((part) => part !== null).join(" ");
    cards.set(cardKey(last4), { sourceCardKey: cardKey(last4), cardMask: `****-${last4}`, displayLabel: label || null });
  }
  for (const row of rows) {
    const last4 = cardLast4(row);
    if (last4 !== null && !cards.has(cardKey(last4)))
      cards.set(cardKey(last4), { sourceCardKey: cardKey(last4), cardMask: `****-${last4}`, displayLabel: null });
  }
  return [...cards.values()];
}

function authorizationCode(value: unknown): string | null {
  const code = optionalText(value);
  return code === null || /^0+$/u.test(code) ? null : code;
}

type Draft = Omit<PreviewPurchase, "sourceRowKey" | "direction"> & Readonly<{ identity: string; prefix: string }>;

function draft(
  prefix: string,
  row: SourceRecord,
  field: string,
  values: Readonly<{ amount: string; currency: string; consumedAt: PreviewLocalDate; posting: PreviewPurchase["posting"]; statementKey: string | null; description: string | null }>,
): Draft {
  if (isZeroDecimal(values.amount)) return fail("malformed-amount", `${field} has a zero amount`);
  const last4 = cardLast4(row);
  const bankReference = authorizationCode(row.authCode);
  return {
    ...values,
    sourceCardKey: last4 === null ? null : cardKey(last4),
    bankReference,
    prefix,
    identity: [values.currency, values.consumedAt.value, values.amount, last4 ?? "", values.description ?? "", bankReference ?? ""].join("\u0000"),
  };
}

function consumeDate(row: SourceRecord, field: string): PreviewLocalDate {
  const date = cardDate(row.purchaseDt) ?? cardDate(row.postingDt) ?? fail("unexpected-response", `${field} has no purchase or posting date`);
  return { precision: "day", value: date };
}

function billedDrafts(bill: Bill): Draft[] {
  return bill.rows.map((row, index) => {
    const field = `${bill.field}.bills[${index}]`;
    const amount = bill.currency === "TWD" ? exactDecimal(row.ntAmt, `${field}.ntAmt`) : exactDecimal(row.foreignAmt, `${field}.foreignAmt`);
    return draft(`billed:${bill.period}`, row, field, {
      amount,
      currency: bill.currency,
      consumedAt: consumeDate(row, field),
      posting: { status: "posted", billing: "billed", postingDate: cardDate(row.postingDt) ?? cardDate(row.clearingDt) },
      statementKey: bill.period,
      description: optionalText(row.description) ?? optionalText(row.merchantChiName),
    });
  });
}

function unbilledDrafts(currency: string, rows: readonly SourceRecord[]): Draft[] {
  return rows.map((row, index) => {
    const field = `${RESOURCE.unbilled}[${currency}][${index}]`;
    const lexeme = row.purchaseAmt ?? row.ntAmt ?? row.txnAmt;
    return draft("unbilled", row, field, {
      amount: exactDecimal(lexeme, `${field}.purchaseAmt`),
      currency,
      consumedAt: consumeDate(row, field),
      posting: { status: "posted", billing: "unbilled", postingDate: cardDate(row.postingDt) },
      statementKey: null,
      description: optionalText(row.description) ?? optionalText(row.merchantChiName) ?? optionalText(row.merchName),
    });
  });
}

function realtimeDrafts(rows: readonly SourceRecord[]): Draft[] {
  return rows.map((row, index) => {
    const field = `${RESOURCE.realtime}[${index}]`;
    const currency = row.curCode === undefined
      ? row.isDoubleCoinCard === true ? fail("missing-currency", `${field} is a dual-currency card without a currency`) : "TWD"
      : currencyCode(row.curCode, `${field}.curCode`, CURRENCY_ALIASES);
    const consumedAt = hasText(row.txnDateTime)
      ? localDate(row.txnDateTime, `${field}.txnDateTime`)
      : { precision: "day" as const, value: requiredCardDate(row.txnDate, `${field}.txnDate`) };
    return draft("pending", row, field, {
      amount: exactDecimal(row.txnAmt, `${field}.txnAmt`),
      currency,
      consumedAt,
      posting: { status: "pending" },
      statementKey: null,
      description: optionalText(row.merchName),
    });
  });
}

/**
 * The direction comes from the sign only when the collection holds both
 * signs, as the CTBC section of preview-sources.md states; otherwise it is
 * unknown. Row keys are content hashes plus an occurrence count, because
 * CTBC sends no stable row id.
 */
function purchases(drafts: readonly Draft[]): PreviewPurchase[] {
  const bothSigns = drafts.some((row) => row.amount.startsWith("-")) && drafts.some((row) => !row.amount.startsWith("-"));
  const occurrences = new Map<string, number>();
  return drafts.map(({ identity, prefix, ...row }) => {
    const hash = createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 16);
    const key = `${prefix}:${hash}`;
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    return {
      ...row,
      sourceRowKey: `${key}:${occurrence}`,
      direction: bothSigns ? row.amount.startsWith("-") ? "inflow" : "outflow" : "unknown",
    };
  });
}

function statement(bill: Bill, previous: Bill | undefined): PreviewStatement | null {
  if (bill.dueDate === null) return null;
  const optional = (name: string) => bill.summary[name] === undefined || bill.summary[name] === null
    ? null
    : exactDecimal(bill.summary[name], `${bill.field}.${name}`);
  return {
    statementKey: bill.period,
    cycleStart: previous ? addDays(previous.closingDate, 1) : dayAfterPreviousClosing(bill.closingDate),
    cycleEnd: bill.closingDate,
    closingDate: bill.closingDate,
    dueDate: bill.dueDate,
    amount: exactDecimal(bill.summary.billAmt, `${bill.field}.billAmt`),
    currency: bill.currency,
    minimumPayment: optional("minPmtAmt"),
    billingPeriod: bill.period,
    paidAmount: optional("pmtAmt"),
    paid: null,
    noPaymentNeeded: null,
  };
}

/**
 * Used credit is the latest statement amount, minus what was paid on it,
 * plus every unbilled purchase in that currency. `adjust` has no operand in
 * the basis, so a nonzero adjustment fails instead of being dropped.
 */
function balance(bill: Bill, unbilled: readonly string[], observed: PreviewCreditBalance["observedAt"]): PreviewCreditBalance {
  const statementAmount = exactDecimal(bill.summary.billAmt, `${bill.field}.billAmt`);
  const paidAmount = exactDecimal(bill.summary.pmtAmt, `${bill.field}.pmtAmt`);
  const adjust = exactDecimal(bill.summary.adjust, `${bill.field}.adjust`);
  if (!isZeroDecimal(adjust)) return fail("unexpected-response", `${bill.field}.adjust is nonzero and the basis has no operand for it`);
  const unbilledAmount = decimalSum(unbilled.map((amount) => [1, amount] as const));
  return {
    amount: decimalSum([[1, statementAmount], [-1, paidAmount], [1, unbilledAmount]]),
    currency: bill.currency,
    observedAt: observed,
    basis: { kind: "statement-minus-paid-plus-unbilled", statementAmount, paidAmount, unbilledAmount },
  };
}

export function ctbcCreditCollection(payloads: CtbcCardPayloads, collectedAt: string): PreviewCreditCollection | PreviewProductAbsence {
  const data = record(payloads.bills.body.rsData, `${RESOURCE.bills}.rsData`);
  const allBills = bills(record(data.billData, `${RESOURCE.bills}.billData`));
  const unbilledRows = [...payloads.unbilled].flatMap(([currency, rows]) => unbilledDrafts(currency, rows));
  const rows = purchases([...allBills.flatMap(billedDrafts), ...unbilledRows, ...realtimeDrafts(payloads.realtime)]);
  const cards = cardsFrom(records(data.cardDataList, `${RESOURCE.bills}.cardDataList`), [
    ...allBills.flatMap((bill) => bill.rows), ...[...payloads.unbilled.values()].flat(), ...payloads.realtime,
  ]);
  const currencies = [...new Set([...allBills.map((bill) => bill.currency), ...rows.map((row) => row.currency)])].sort();
  if (currencies.length === 0) return { absent: "no_data" };
  const observed = observedAt(payloads.bills.date, collectedAt);
  const accounts = currencies.map((currency): PreviewCreditAccount => {
    const own = allBills.filter((bill) => bill.currency === currency);
    const latest = own.at(-1);
    const unbilled = unbilledRows.filter((row) => row.currency === currency).map((row) => row.amount);
    return {
      sourceAccountKey: currency,
      displayLabel: `中國信託信用卡${currency === "TWD" ? "" : ` (${currency})`}`,
      currency,
      creditLimit: null,
      cards,
      balances: latest ? [balance(latest, unbilled, observed)] : [],
      purchases: rows.filter((row) => row.currency === currency),
      statements: own.flatMap((bill, index) => statement(bill, own[index - 1]) ?? []),
    };
  });
  return { collectedAt, accounts };
}

export function createCtbcCardSource(options: Readonly<{ http?: PreviewHttpOpener }> = {}): PreviewSource {
  const open = options.http ?? nodeHttp;
  return {
    id: "ctbc-credit-card",
    institution: PREVIEW_SOURCE_INSTITUTIONS["ctbc-credit-card"],
    products: ["credit_card"],
    displayName: { en: "CTBC credit cards (preview)", "zh-TW": "中國信託信用卡（預覽）" },
    searchAliases: ["CTBC", "CTBC credit card", "中國信託", "中信", "中信信用卡"],
    credentialFields: [
      { key: KEY.idNumber, label: { en: "Taiwan ID number", "zh-TW": "身分證字號" }, input: "text", redaction: "partial" },
      { key: KEY.userCode, label: { en: "User code", "zh-TW": "使用者代號" }, input: "text", redaction: "partial" },
      { key: KEY.password, label: { en: "Password", "zh-TW": "網銀密碼" }, input: "password", redaction: "full" },
    ],
    setupGuide: {
      summary: {
        en: "Preview source, never run against a live CTBC account. Its data may be incomplete or wrong. It signs in through the CTBC mobile banking App protocol, separately from the verified CTBC deposit source, so it has its own sign-in details. CTBC may ask a new device to approve the sign-in in its App; the sync then stops instead of waiting.",
        "zh-TW": "預覽來源，從未以真實的中國信託帳戶執行過，資料可能不完整或有誤。它透過中國信託行動銀行 App 的協定登入，與已驗證的中國信託存款來源分開登入，因此有自己的登入資料。中國信託可能要求新裝置在 App 核准登入，這時同步會停止，不會等待。",
      },
      requirements: [{ en: "A CTBC account with online or mobile banking sign-in and a CTBC credit card.", "zh-TW": "可登入網路銀行或行動銀行、並持有中國信託信用卡的中國信託帳戶。" }],
      steps: [{ en: "Enter the ID number, user code, and password you use to sign in to CTBC online or mobile banking.", "zh-TW": "輸入登入中國信託網路銀行或行動銀行使用的身分證字號、使用者代號與密碼。" }],
      links: [{
        id: "ctbc-site",
        label: { en: "CTBC Bank", "zh-TW": "中國信託商業銀行" },
        url: "https://www.ctbcbank.com/",
        allowedHosts: ["www.ctbcbank.com"],
      }],
    },
    sessionTakeover: {
      notice: {
        en: "This source signs in separately from the verified CTBC deposit source. The two sign-ins, or this one and your CTBC App, may end each other's session; this is not yet confirmed. When CTBC reports another signed-in session, the sync stops instead of signing it out.",
        "zh-TW": "這個來源與已驗證的中國信託存款來源分開登入。兩者，或這個來源與你的中國信託 App，可能會讓對方的登入結束；此行為尚未確認。若中國信託回報已有其他登入，同步會停止，不會讓對方登出。",
      },
    },
    startUrl: `${IMP}/`,
    async run(context, input) {
      if (!input.products.includes("credit_card")) return context.preview.collect({});
      await context.event("authentication", "started", "authentication-started");
      return open(context, { pageUrl: input.startUrl }, async (http) => {
        const credentials = input.credentials;
        const api = client(context, http, ctbcDeviceCode(credentials[KEY.idNumber] ?? "", credentials[KEY.userCode] ?? ""));
        try {
          await api.bootstrap();
          await api.login(credentials[KEY.idNumber] ?? "", credentials[KEY.userCode] ?? "", credentials[KEY.password] ?? "");
          await context.event("authentication", "completed", "authentication-completed");
          return await context.preview.collect({
            credit_card: async () => {
              const collectedAt = context.now();
              const payloads = await collectPayloads(api);
              return "absent" in payloads ? payloads : ctbcCreditCollection(payloads, collectedAt);
            },
          });
        } finally {
          await api.logout().catch(() => undefined);
        }
      });
    },
  };
}

export const CTBC_CARD_PREVIEW_SOURCE = createCtbcCardSource();
