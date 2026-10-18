import { constants, createCipheriv, createHash, publicEncrypt, randomUUID } from "node:crypto";
import type {
  PreviewAccount,
  PreviewCard,
  PreviewCreditAccount,
  PreviewCreditBasis,
  PreviewCreditCollection,
  PreviewPurchase,
  PreviewTransaction,
} from "../../ledger/pglite/preview-financial-data.ts";
import { browserHttp, type PreviewHttp, type PreviewHttpOpener, type PreviewImageDecoder } from "./browser-http.ts";
import { calibratedCaptchaSolver, MEGA_CAPTCHA_FAMILY } from "./preview-captcha.ts";
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
  MAX_CHALLENGES_PER_ROUND,
  observedAt,
  optionalText,
  parseSourceJson,
  record,
  records,
  requireDeviceRegistration,
  solveChallengeRound,
  taipeiMonthWindow,
  text,
  type PreviewCaptchaSolver,
  type SourceRecord,
} from "./source-kit.ts";
import type { PreviewWorkflowContext } from "./workflow.ts";

const ROOT = "https://mobile.megabank.com.tw/ixtein";
const START_URL = "https://mobile.megabank.com.tw/";
const ADAPTER = "/v2/adapters/ibmb/imp-pmb-adapter";
// Public MobileFirst client settings bundled in the Mega Android App 2.5.19, as all-set-tw recorded them (megabank/app-settings.ts).
const APPLICATION = "ibmb";
const APP_VERSION = "2.5.19";
const APP_DETAIL_VERSION = "20260910145043001";
const CLIENT_TOKEN = "6ab76a514fe045cbbc72c33184a7f29a"; // gitleaks:allow public App client setting
const CLIENT_PUBLIC_KEY = "30819F300D06092A864886F70D010101050003818D0030818902818100AE621997D8A310B859D46D613467382D8AEF928FC7401CB880FE4A0253909383DFB2B58DA366ED58AE8C7F5299D746BD812A255812BE5D85DC5984F94BD54AA3B91CD6B4DAF6401DE6A6AB03B473B2A300BF753BD4363CD385D49A2E4B13C4378C84357F5499CB4248B127EC339E4311F14A190E11DB287ADC7179AD599A7DF10203010001"; // gitleaks:allow public key
const DEVICE_SALT = "octopusbeak-mega-virtual-device-v1";
const MONTHS = 3;
const PAGE_SIZE = "20";
const MAX_TRANSACTION_PAGES = 20;
const SUCCESS_CODES = new Set(["0000", "1120"]);
const CAPTCHA_REJECTED = "0113";
const PERMISSION_DENIED = "SYS014";

const KEY = {
  idNumber: "PREVIEW_MEGA_DEPOSIT_ID_NUMBER",
  userCode: "PREVIEW_MEGA_DEPOSIT_USER_CODE",
  password: "PREVIEW_MEGA_DEPOSIT_PASSWORD",
} as const;

const DIRECTION = { D: "outflow", C: "inflow" } as const satisfies Record<string, PreviewTransaction["direction"]>;

export type MegaVirtualDevice = Readonly<{ deviceCode: string; deviceUKey: string; seed: string }>;

/**
 * The preview context has no persistence port, so the virtual device is a
 * pure function of the sign-in identifier: the same person presents the same
 * device on every run, as the App would.
 */
export function megaVirtualDevice(idNumber: string, userCode: string): MegaVirtualDevice {
  const uuid = (label: string) => {
    const hex = createHash("sha256").update(`${DEVICE_SALT}\u0000${label}\u0000${idNumber}|${userCode}`).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  return { deviceCode: uuid("deviceCode"), deviceUKey: uuid("deviceUKey"), seed: uuid("seed") };
}

export type MegaCipherToken = Readonly<{ SessionKey: string; RSAPublicKeyModulus: string; RSAPublicKeyExponent: string }>;

/**
 * Mega's E2EE login: the space-padded password under 3DES-CBC (zero IV) with
 * the per-login session key, prefixed by `ID|USERCODE/`, all under the RSA key
 * the e2ee response hands out (PKCS#1 v1.5), as lowercase hex without leading zeros.
 */
export function encryptMegaLogin(idNumber: string, userCode: string, password: string, token: MegaCipherToken): string {
  const { SessionKey: keyHex, RSAPublicKeyModulus: modulus, RSAPublicKeyExponent: exponent } = token;
  if (!/^[\da-fA-F]+$/u.test(keyHex) || ![32, 48].includes(keyHex.length) || !/^[\da-fA-F]+$/u.test(modulus) || !/^[\da-fA-F]+$/u.test(exponent))
    return fail("unexpected-response", "e2ee cipherToken keys are malformed");
  const sessionKey = Buffer.from(keyHex, "hex");
  const tripleDesKey = sessionKey.length === 16 ? Buffer.concat([sessionKey, sessionKey.subarray(0, 8)]) : sessionKey;
  const padded = password + " ".repeat((16 - (password.length % 16)) % 16);
  const des = createCipheriv("des-ede3-cbc", tripleDesKey, Buffer.alloc(8));
  const encrypted = Buffer.concat([des.update(padded, "utf8"), des.final()]);
  const evenHex = (hex: string) => (hex.length % 2 === 0 ? hex : `0${hex}`);
  const key = {
    kty: "RSA",
    n: Buffer.from(evenHex(modulus), "hex").toString("base64url"),
    e: Buffer.from(evenHex(exponent), "hex").toString("base64url"),
  };
  const plain = Buffer.concat([Buffer.from(`${idNumber}|${userCode}/`, "utf8"), encrypted]);
  return publicEncrypt({ key, format: "jwk", padding: constants.RSA_PKCS1_PADDING }, plain).toString("hex").replace(/^0+/u, "");
}

type Response = Readonly<{ body: SourceRecord; date: string | null }>;

function bankCode(body: SourceRecord): string {
  const code = typeof body.code === "string" ? body.code.trim() : "";
  return /^[A-Za-z0-9_-]{1,32}$/u.test(code) ? code : "unknown";
}

function rsData(body: SourceRecord, resource: string): SourceRecord {
  return record(body.rsData, `${resource}.rsData`);
}

function client(context: PreviewWorkflowContext, http: PreviewHttp, device: MegaVirtualDevice) {
  const startedAt = String(Date.parse(context.now()));
  let accessToken = "";
  let xAuthToken = "";
  let txnToken = startedAt;
  let highIpFar = false;

  async function request(path: string, endpoint: string, body: string, headers: Record<string, string>): Promise<Response> {
    const response = await http({
      method: "POST",
      url: `${ROOT}${path}`,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...headers,
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body,
    });
    const parsed = response.text === "" ? null : parseSourceJson(response.text, endpoint);
    context.preview.observe({ endpoint, status: response.status, body: parsed });
    if (response.status !== 200) return fail("unexpected-response", `${endpoint} HTTP ${response.status}`);
    const json = record(parsed, endpoint);
    if (response.headers["x-auth-token"]) xAuthToken = response.headers["x-auth-token"];
    const token = optionalText(json.token);
    if (token) txnToken = token;
    return { body: json, date: response.headers.date ?? null };
  }

  function signed(body: string, extra: Record<string, string> = {}): Record<string, string> {
    return { checksum: createHash("md5").update(body, "utf8").digest("hex"), deviceCode: device.deviceCode, ...extra };
  }

  async function resource(
    endpoint: string,
    path: string,
    rqData: Record<string, unknown>,
    page: Readonly<{ pageId: string; pageNo: string }> | null,
    checkCode = true,
  ): Promise<Response> {
    const trackingIxd = randomUUID();
    const body = JSON.stringify({
      ...page,
      deviceIxd: device.deviceCode,
      deviceUKey: device.deviceUKey,
      trackingIxd,
      txnIxd: "",
      model: "Desktop",
      platform: "Android",
      version: "16",
      network: "wifi",
      appVer: APP_VERSION,
      appDetailVer: APP_DETAIL_VERSION,
      clientNo: startedAt,
      clientTime: String(Date.parse(context.now())),
      token: txnToken,
      locale: "zh_TW",
      fromSys: "0",
      seed: device.seed,
      deviceToken: "",
      rqData,
      clientSysId: "NMB",
      deviceUniqueIxd: device.deviceCode,
      resource: path,
    });
    const response = await request(`${ADAPTER}/resource/${endpoint}`, path, body, signed(body, {
      "x-track-ixd": trackingIxd,
      ...(xAuthToken ? { "x-auth-token": xAuthToken } : {}),
    }));
    if (!checkCode) return response;
    const code = bankCode(response.body);
    if (SUCCESS_CODES.has(code)) return response;
    // all-set-tw observed SYS014 on queries after a sign-in flagged as remote; the App then asks for an SMS code.
    if (code === PERMISSION_DENIED && highIpFar) return requireDeviceRegistration(context, `${path} needs Mega's SMS verification for this device`);
    return fail("unexpected-response", `${path} code ${code}`);
  }

  return {
    resource,
    async oauth() {
      const form = new URLSearchParams({ grant_type: "client_credentials", scope: "PUBLIC", client_id: APPLICATION, client_secret: CLIENT_TOKEN });
      const response = await request("/oauth/token", "/oauth/token", form.toString(), { "Content-Type": "application/x-www-form-urlencoded" });
      accessToken = text(response.body.access_token, "/oauth/token.access_token");
    },
    async init() {
      const response = await request("/main/init", "/main/init", JSON.stringify({
        application: APPLICATION,
        deviceCode: device.deviceCode,
        deviceManufacturer: "Generic",
        deviceModel: "Desktop",
        devicePlatform: "Android",
        deviceVersion: "16",
        pclientTime: Date.parse(context.now()),
        randomNumber: "",
        clientPubk: CLIENT_PUBLIC_KEY,
      }), {});
      if (response.body.statusCode !== "0000") return fail("unexpected-response", "/main/init statusCode");
    },
    async adapterLogin() {
      const body = JSON.stringify({});
      await request(`${ADAPTER}/resource/login`, "resource/login", body, signed(body, { "x-track-ixd": randomUUID() }));
    },
    flagRemoteSignIn(value: boolean) { highIpFar = value; },
  };
}

type Client = ReturnType<typeof client>;

const LOGIN_PAGE = { pageId: "fco02003", pageNo: "login" } as const;

async function signIn(
  context: PreviewWorkflowContext,
  api: Client,
  decodeImage: PreviewImageDecoder,
  solve: PreviewCaptchaSolver,
  idNumber: string,
  userCode: string,
  password: string,
) {
  await api.oauth();
  await api.init();
  await api.resource("ixtein-pmbinit", "/fco/fco00001/initialize", {}, null);
  const answer = await solveChallengeRound(context, solve, async () => {
    const captcha = rsData((await api.resource("prelogin", "/fco/fco00001/captcha", {}, LOGIN_PAGE)).body, "captcha");
    const image = text(captcha.image, "captcha.image").replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/u, "");
    if (!/^[A-Za-z0-9+/=]+$/u.test(image)) return fail("unexpected-response", "captcha.image is not base64");
    const png = await decodeImage(Buffer.from(image, "base64")).catch(() => fail("unexpected-response", "captcha.image is not a decodable image"));
    return { image: png, charset: "digits", expectedLength: 5 };
  }, MAX_CHALLENGES_PER_ROUND);
  if (!/^\d{5}$/u.test(answer)) return fail("verification-rejected", "the CAPTCHA answer is not five digits");

  const e2ee = rsData((await api.resource("prelogin", "/fco/fco00001/e2ee", {}, LOGIN_PAGE)).body, "e2ee");
  const cipherText = text(e2ee.cipherToken, "e2ee.cipherToken");
  let parsed: unknown;
  try { parsed = JSON.parse(cipherText); } catch { return fail("unexpected-response", "e2ee.cipherToken is not JSON"); }
  const token = record(parsed, "e2ee.cipherToken");
  if (e2ee.isE2EE !== true) return fail("unexpected-response", "e2ee.isE2EE");
  const cipherToken = {
    SessionKey: text(token.SessionKey, "cipherToken.SessionKey"),
    RSAPublicKeyModulus: text(token.RSAPublicKeyModulus, "cipherToken.RSAPublicKeyModulus"),
    RSAPublicKeyExponent: text(token.RSAPublicKeyExponent, "cipherToken.RSAPublicKeyExponent"),
  };

  const login = await api.resource("prelogin", "/fco/fco02003/login", {
    memberType: "NB",
    cipherToken: cipherText,
    e2eeData: encryptMegaLogin(idNumber, userCode, password, cipherToken),
    isE2EE: true,
    pxdLength: password.length,
    isDeviceBinded: false,
    captchaCode: answer,
  }, LOGIN_PAGE, false);
  const code = bankCode(login.body);
  if (code === CAPTCHA_REJECTED) return fail("verification-rejected", `login code ${code}`);
  if (code !== "0000") return fail("sign-in-rejected", `login code ${code}`);
  const data = rsData(login.body, "login");
  return { secondFactor: data.secondFactorFlag === "Y", highIpFar: data.isHighIpFar === true };
}

function maskedName(value: unknown): string | null {
  return optionalText(value)?.replace(/\d{6,}/gu, "••••") ?? null;
}

type Deposit = Readonly<{ accountNo: string; currency: string; balance: string; name: string | null }>;

function deposits(list: readonly SourceRecord[]): readonly Deposit[] {
  const byKey = new Map<string, Deposit>();
  for (const [index, row] of list.entries()) {
    const field = `depositInfoList[${index}]`;
    const deposit = {
      accountNo: text(row.DRACT, `${field}.DRACT`),
      currency: currencyCode(row.DRCUR, `${field}.DRCUR`),
      balance: exactDecimal(row.AVLBA, `${field}.AVLBA`),
      name: maskedName(row.NAME),
    };
    const key = `${deposit.accountNo}:${deposit.currency}`;
    const previous = byKey.get(key);
    // all-set-tw sums repeated account/currency rows; what such rows mean is undocumented, so they are refused rather than merged.
    if (previous && JSON.stringify(previous) !== JSON.stringify(deposit)) return fail("unexpected-response", `${field} repeats an account and currency`);
    byKey.set(key, deposit);
  }
  return [...byKey.values()];
}

function transactionsFrom(list: readonly SourceRecord[], accountCurrency: string, occurrences: Map<string, number>, field: string): PreviewTransaction[] {
  return list.map((row, index) => {
    const at = `${field}[${index}]`;
    const code = text(row.DRCR, `${at}.DRCR`).toUpperCase();
    const direction = code === "D" || code === "C" ? DIRECTION[code] : fail("unexpected-response", `${at}.DRCR ${code} is not a documented debit/credit code`);
    const amount = exactDecimal(row.amount, `${at}.amount`);
    if (/^[+-]/u.test(amount)) return fail("unexpected-response", `${at}.amount is signed although DRCR carries the direction`);
    const postedAt = localDate(row.txDate, `${at}.txDate`);
    const description = optionalText(row.paymentItem);
    // serialNo/seq renumber within a day as new rows post (all-set-tw), so the key is content plus occurrence.
    const content = `${postedAt.value}:${code}:${amount}:${description ?? ""}`;
    const occurrence = occurrences.get(content) ?? 0;
    occurrences.set(content, occurrence + 1);
    return {
      sourceRowKey: `${content}#${occurrence}`,
      amount,
      currency: row.currency === undefined ? accountCurrency : currencyCode(row.currency, `${at}.currency`),
      direction,
      postedAt,
      description,
    };
  });
}

async function depositTransactions(api: Client, deposit: Deposit, window: Readonly<{ start: string; end: string }>): Promise<PreviewTransaction[]> {
  const rows: PreviewTransaction[] = [];
  const occurrences = new Map<string, number>();
  const seen = new Set<string>();
  let tsqName = "";
  for (let page = 0; ; page += 1) {
    if (page >= MAX_TRANSACTION_PAGES) return fail("incomplete-data", "fao01001 exceeded its page bound");
    const response = await api.resource("megapmb", "/fao/fao01001/query", {
      currency: deposit.currency,
      accountNo: deposit.accountNo,
      accountTitle: "",
      startDate: window.start.replaceAll("-", "/"),
      endDate: window.end.replaceAll("-", "/"),
      count: PAGE_SIZE,
      isDw: false,
      tsqName,
      isReturn: false,
    }, { pageId: "fao01001", pageNo: "query" });
    const data = rsData(response.body, "fao01001");
    rows.push(...transactionsFrom(records(data.list, "fao01001.list"), deposit.currency, occurrences, "fao01001.list"));
    if (data.tsqName !== undefined && typeof data.tsqName !== "string") return fail("incomplete-data", "fao01001.tsqName is not text");
    const next = optionalText(data.tsqName);
    if (!next) return rows;
    // all-set-tw stops when the cursor repeats; whether that means the end or a loop is unknown, so it fails.
    if (next === tsqName || seen.has(next)) return fail("incomplete-data", "fao01001 repeated its tsqName cursor");
    seen.add(next);
    tsqName = next;
  }
}

async function collectDeposits(api: Client, now: string): Promise<PreviewAccount[]> {
  const overview = await api.resource("megapmb", "/fco/fco10001/home", { type: "1", refresh: true }, { pageId: "fco10001", pageNo: "home" });
  const asOf = observedAt(overview.date, now);
  const window = taipeiMonthWindow(now, MONTHS);
  const accounts: PreviewAccount[] = [];
  for (const deposit of deposits(records(rsData(overview.body, "fco10001").depositInfoList, "fco10001.depositInfoList"))) {
    accounts.push({
      sourceAccountKey: `${deposit.accountNo}:${deposit.currency}`,
      displayLabel: `兆豐銀行 ${deposit.name ?? "存款"} ${deposit.currency} ${deposit.accountNo.slice(-4)}`,
      currency: deposit.currency,
      type: "depository",
      balances: [{ kind: "available", amount: deposit.balance, currency: deposit.currency, observedAt: asOf }],
      // all-set-tw queries fao01001 for NT-dollar accounts only; foreign-currency history is not documented.
      transactions: deposit.currency === "TWD" ? await depositTransactions(api, deposit, window) : [],
    });
  }
  return accounts;
}

const UNBILLED_MONTH = "999912";
const BILLING_MONTH = /^\d{4}(?:0[1-9]|1[0-2])$/u;

type StatementBasis = Extract<PreviewCreditBasis, { kind: "statement-minus-paid-plus-unbilled" }>;
type BillGroup = { billed: { month: string; total: string; paid: string }[]; unbilled: string[] };

/**
 * The used-credit basis per currency from the fco10007 overview: for each
 * ACCT_TYPE, the latest billed row's THIS_TTL_AMT and PAYMENT_AMT, plus the
 * 999912 row's THIS_TTL_AMT, summed over the currency's types. A type without
 * either row lacks an operand, so the product fails instead of reading zero.
 */
function creditBases(list: readonly SourceRecord[]): ReadonlyMap<string, StatementBasis> {
  const groups = new Map<string, Map<string, BillGroup>>();
  for (const [index, row] of list.entries()) {
    const field = `creditCardBillInfoList[${index}]`;
    const currency = currencyCode(row.CURR_CODE, `${field}.CURR_CODE`);
    const type = text(row.ACCT_TYPE, `${field}.ACCT_TYPE`);
    const month = text(row.ACCT_MON, `${field}.ACCT_MON`);
    const byType = groups.get(currency) ?? new Map<string, BillGroup>();
    const group = byType.get(type) ?? { billed: [], unbilled: [] };
    if (month === UNBILLED_MONTH) group.unbilled.push(exactDecimal(row.THIS_TTL_AMT, `${field}.THIS_TTL_AMT`));
    else if (BILLING_MONTH.test(month))
      group.billed.push({ month, total: exactDecimal(row.THIS_TTL_AMT, `${field}.THIS_TTL_AMT`), paid: exactDecimal(row.PAYMENT_AMT, `${field}.PAYMENT_AMT`) });
    else return fail("unexpected-response", `${field}.ACCT_MON is neither a billing month nor ${UNBILLED_MONTH}`);
    byType.set(type, group);
    groups.set(currency, byType);
  }
  const bases = new Map<string, StatementBasis>();
  for (const [currency, byType] of groups) {
    const statements: string[] = [];
    const paid: string[] = [];
    const unbilled: string[] = [];
    for (const [type, group] of byType) {
      const at = `fco10007 ${currency} ACCT_TYPE ${type}`;
      if (new Set(group.billed.map((bill) => bill.month)).size !== group.billed.length) return fail("unexpected-response", `${at} repeats a billing month`);
      if (group.unbilled.length > 1) return fail("unexpected-response", `${at} has more than one ${UNBILLED_MONTH} row`);
      const latest = group.billed.toSorted((left, right) => right.month.localeCompare(left.month))[0];
      if (!latest) return fail("incomplete-data", `${at} has no billed row, so its statement amount is unknown`);
      const pending = group.unbilled[0] ?? fail("incomplete-data", `${at} has no ${UNBILLED_MONTH} row, so its unbilled amount is unknown`);
      statements.push(latest.total);
      paid.push(latest.paid);
      unbilled.push(pending);
    }
    bases.set(currency, {
      kind: "statement-minus-paid-plus-unbilled",
      statementAmount: decimalSum(statements.map((amount) => [1, amount] as const)),
      paidAmount: decimalSum(paid.map((amount) => [1, amount] as const)),
      unbilledAmount: decimalSum(unbilled.map((amount) => [1, amount] as const)),
    });
  }
  return bases;
}

/** The card number is only a request value; the stored key is its digest. */
function cardKey(cardNo: string): string {
  return `card-${createHash("sha256").update(`octopusbeak-mega-card\u0000${cardNo}`).digest("hex").slice(0, 16)}`;
}

function cardsFrom(list: readonly SourceRecord[]): ReadonlyMap<string, PreviewCard> {
  const cards = new Map<string, PreviewCard>();
  for (const [index, row] of list.entries()) {
    const field = `fao01010.cardNumbers[${index}]`;
    const cardNo = text(row.cardNo, `${field}.cardNo`);
    const last4 = /(\d{4})$/u.exec(cardNo)?.[1] ?? fail("unexpected-response", `${field}.cardNo does not end in four digits`);
    if (!cards.has(cardNo)) cards.set(cardNo, { sourceCardKey: cardKey(cardNo), cardMask: `****-${last4}`, displayLabel: optionalText(row.cardName) });
  }
  return cards;
}

type PurchaseRow = Readonly<{ row: SourceRecord; cardNo: unknown; field: string }>;

/** fao01010/query nests each card's rows under a group's detailList; a group without one is itself a row. */
function purchaseRows(groups: readonly SourceRecord[]): readonly PurchaseRow[] {
  return groups.flatMap((group, index): PurchaseRow[] => {
    const field = `fao01010.detailList[${index}]`;
    if (group.detailList === undefined) return [{ row: group, cardNo: group.cardNo, field }];
    return records(group.detailList, `${field}.detailList`)
      .map((row, inner) => ({ row, cardNo: row.cardNo ?? group.cardNo, field: `${field}.detailList[${inner}]` }));
  });
}

function purchasesFrom(groups: readonly SourceRecord[], cards: ReadonlyMap<string, PreviewCard>): PreviewPurchase[] {
  const occurrences = new Map<string, number>();
  const purchases = purchaseRows(groups).map(({ row, cardNo, field }): PreviewPurchase => {
    const card = cards.get(text(cardNo, `${field}.cardNo`)) ?? fail("unexpected-response", `${field}.cardNo is not in fao01010.cardNumbers`);
    const amount = exactDecimal(row.destinationAmt, `${field}.destinationAmt`);
    if (isZeroDecimal(amount)) return fail("unexpected-response", `${field}.destinationAmt is zero`);
    const currency = currencyCode(row.destinationCurr, `${field}.destinationCurr`);
    const original = row.sourceAmt === undefined ? "" : exactDecimal(row.sourceAmt, `${field}.sourceAmt`);
    const originalCurrency = row.sourceCurr === undefined ? "" : currencyCode(row.sourceCurr, `${field}.sourceCurr`);
    const consumedAt = localDate(row.purchaseDate, `${field}.purchaseDate`);
    const month = text(row.acctMon, `${field}.acctMon`);
    if (month !== UNBILLED_MONTH && !BILLING_MONTH.test(month)) return fail("unexpected-response", `${field}.acctMon is neither a billing month nor ${UNBILLED_MONTH}`);
    const posted = row.postDate ?? row.accountDate;
    const description = optionalText(row.merchantChiName);
    // acctMon changes from 999912 to the billing month at billing, so it stays out of the key and the row is updated in place.
    const content = [card.sourceCardKey, consumedAt.value, originalCurrency, original, currency, amount, description ?? ""].join(":");
    const occurrence = occurrences.get(content) ?? 0;
    occurrences.set(content, occurrence + 1);
    return {
      sourceRowKey: `${content}#${occurrence}`,
      amount,
      currency,
      direction: "unknown",
      posting: {
        status: "posted",
        billing: month === UNBILLED_MONTH ? "unbilled" : "billed",
        postingDate: posted === undefined || posted === null ? null : localDate(posted, `${field}.postDate`).value.slice(0, 10),
      },
      consumedAt,
      sourceCardKey: card.sourceCardKey,
      statementKey: null,
      bankReference: null,
      description,
    };
  });
  // No debit/credit field is documented, so the sign is the direction only when the collection holds both signs.
  if (new Set(purchases.map((purchase) => purchase.amount.startsWith("-"))).size < 2) return purchases;
  return purchases.map((purchase) => ({ ...purchase, direction: purchase.amount.startsWith("-") ? "inflow" : "outflow" }));
}

async function collectCards(api: Client, now: string): Promise<PreviewCreditCollection | PreviewProductAbsence> {
  const overview = await api.resource("megapmb", "/fco/fco10007/home", {}, { pageId: "fco10007", pageNo: "home" });
  const bills = records(rsData(overview.body, "fco10007").creditCardBillInfoList, "fco10007.creditCardBillInfoList");
  if (bills.length === 0) return { absent: "not_held" };
  const asOf = observedAt(overview.date, now);
  const bases = creditBases(bills);
  const home = await api.resource("megapmb", "/fao/fao01010/home", {}, { pageId: "fao01010", pageNo: "home" });
  const cards = cardsFrom(records(rsData(home.body, "fao01010").cardNumbers, "fao01010.cardNumbers"));
  if (cards.size === 0) return fail("unexpected-response", "fco10007 lists card bills but fao01010 lists no card");
  const window = taipeiMonthWindow(now, MONTHS);
  const query = await api.resource("megapmb", "/fao/fao01010/query", {
    cardNo: "0",
    flag: "0",
    startDate: window.start.replaceAll("-", "/"),
    endDate: window.end.replaceAll("-", "/"),
  }, { pageId: "fao01010", pageNo: "query" });
  const purchases = purchasesFrom(records(rsData(query.body, "fao01010").detailList, "fao01010.detailList"), cards);
  const orphan = purchases.find((purchase) => !bases.has(purchase.currency));
  if (orphan) return fail("unexpected-response", `a ${orphan.currency} purchase has no ${orphan.currency} row in fco10007`);
  return {
    collectedAt: now,
    accounts: [...bases].map(([currency, basis]): PreviewCreditAccount => ({
      sourceAccountKey: `credit:${currency}`,
      displayLabel: `兆豐銀行 信用卡 ${currency}`,
      currency,
      creditLimit: null,
      cards: [...cards.values()],
      balances: [{
        amount: decimalSum([[1, basis.statementAmount], [-1, basis.paidAmount], [1, basis.unbilledAmount]]),
        currency,
        observedAt: asOf,
        basis,
      }],
      purchases: purchases.filter((purchase) => purchase.currency === currency),
      statements: [],
    })),
  };
}

export function createMegaSource(options: Readonly<{ http?: PreviewHttpOpener; solveCaptcha?: PreviewCaptchaSolver }> = {}): PreviewSource {
  const open = options.http ?? browserHttp;
  const solve = options.solveCaptcha ?? calibratedCaptchaSolver(MEGA_CAPTCHA_FAMILY);
  return {
    id: "mega-deposit",
    institution: PREVIEW_SOURCE_INSTITUTIONS["mega-deposit"],
    products: ["deposit", "credit_card"],
    displayName: { en: "Mega Bank deposits and credit cards (preview)", "zh-TW": "兆豐銀行存款與信用卡（預覽）" },
    searchAliases: ["Mega Bank", "Mega International Commercial Bank", "MegaBank", "兆豐", "兆豐銀行", "兆豐國際商業銀行"],
    credentialFields: [
      { key: KEY.idNumber, label: { en: "Taiwan ID number", "zh-TW": "身分證字號" }, input: "text", redaction: "partial" },
      { key: KEY.userCode, label: { en: "User code", "zh-TW": "使用者代號" }, input: "text", redaction: "partial" },
      { key: KEY.password, label: { en: "Password", "zh-TW": "登入密碼" }, input: "password", redaction: "full" },
    ],
    setupGuide: {
      summary: {
        en: "Preview source, never run against a live Mega Bank account. Its data may be incomplete or wrong. An on-device solver reads Mega Bank's numeric image CAPTCHA. When it cannot read five images in a row, the run stops before signing in.",
        "zh-TW": "預覽來源，從未以真實的兆豐銀行帳戶執行過，資料可能不完整或有誤。兆豐銀行的數字圖形驗證碼由裝置上的解題器辨識；連續五張都無法辨識時，執行會在登入前停止。",
      },
      requirements: [{ en: "A Mega Bank account with mobile banking sign-in.", "zh-TW": "可登入兆豐行動銀行的帳戶。" }],
      steps: [{ en: "Enter the ID number, user code, and password you use to sign in to Mega Bank mobile banking.", "zh-TW": "輸入登入兆豐行動銀行使用的身分證字號、使用者代號與登入密碼。" }],
      links: [{
        id: "mega-site",
        label: { en: "Mega Bank", "zh-TW": "兆豐銀行" },
        url: "https://www.megabank.com.tw/",
        allowedHosts: ["www.megabank.com.tw"],
      }],
    },
    sessionTakeoverNotice: {
      en: "Mega Bank may treat a sync as a second sign-in and end the session in the Mega Bank App. This is not yet confirmed.",
      "zh-TW": "兆豐銀行可能把同步視為重複登入，讓你的兆豐銀行 App 登出。此行為尚未確認。",
    },
    startUrl: START_URL,
    async run(context, input) {
      await context.event("authentication", "authentication-started");
      const idNumber = (input.credentials[KEY.idNumber] ?? "").trim().toUpperCase();
      const userCode = (input.credentials[KEY.userCode] ?? "").trim().toUpperCase();
      const password = input.credentials[KEY.password] ?? "";
      const device = megaVirtualDevice(idNumber, userCode);
      return open(context, { pageUrl: input.startUrl, stripOriginFor: "https://mobile.megabank.com.tw/*" }, async (http, decodeImage) => {
        const api = client(context, http, device);
        const gate = await signIn(context, api, decodeImage, solve, idNumber, userCode, password);
        try {
          await api.adapterLogin();
          if (gate.secondFactor) return await requireDeviceRegistration(context, "Mega login requires a second factor (secondFactorFlag Y)");
          api.flagRemoteSignIn(gate.highIpFar);
          await context.event("authentication", "authentication-completed");
          await context.event("collection", "collection-started");
          const collectedAt = context.now();
          const output = await context.preview.collect({
            deposit: async () => ({ collectedAt, accounts: await collectDeposits(api, collectedAt) }),
            credit_card: () => collectCards(api, collectedAt),
          });
          await context.event("collection", "collection-completed");
          return output;
        } finally {
          await api.resource("megapmb", "/fco/fco02011/logout", {}, null, false).catch(() => undefined);
        }
      });
    },
  };
}

export const MEGA_PREVIEW_SOURCE = createMegaSource();
