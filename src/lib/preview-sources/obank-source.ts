import { constants, createHash, publicEncrypt, randomUUID } from "node:crypto";
import type { PreviewAccount, PreviewLocalDate, PreviewTransaction } from "../../ledger/pglite/preview-financial-data.ts";
import type { PreviewHttp, PreviewHttpOpener, PreviewImageDecoder } from "./browser-http.ts";
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
  refuseUnsupportedVerification,
  solveChallengeRound,
  taipeiMonthWindow,
  text,
  type PreviewCaptchaSolver,
  type SourceRecord,
} from "./source-kit.ts";
import type { PreviewWorkflowContext } from "./workflow.ts";

const ORIGIN = "https://www.o-bank.com";
const ROOT = `${ORIGIN}/ebank/ixtein`;
const ADAPTERS = `${ROOT}/v2/adapters/ebank`;
const WEB_PAGE = `${ORIGIN}/ebank/apps/services/www/ibmb/desktopbrowser/default/index.html`;
const MONTHS = 3;

const RESOURCE = {
  bootstrap: "common/CMN01003/010",
  loginPage: "fco/FCO02001/012",
  loginPageAudit: "common/CMN01004/010",
  captcha: "common/CMN01001/010",
  timeFactor: "common/EndToEnd/020",
  demandDeposits: "fao/FAO01012/010",
} as const;

const KEY = {
  idNumber: "PREVIEW_OBANK_DEPOSIT_ID_NUMBER",
  userCode: "PREVIEW_OBANK_DEPOSIT_USER_CODE",
  password: "PREVIEW_OBANK_DEPOSIT_PASSWORD",
} as const;

const CAPTCHA_MESSAGE = /captcha|驗證碼|magicNumber/iu;
const MULTIPLE_LOGIN = "3";

type Response = Readonly<{ body: SourceRecord; date: string | null }>;

function client(context: PreviewWorkflowContext, http: PreviewHttp) {
  const clientNo = String(Date.parse(context.now()));
  let accessToken = "";
  let token = "#";
  let transactionId = "";

  function baseHeaders(): Record<string, string> {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      Origin: ORIGIN,
      Referer: WEB_PAGE,
      "X-Requested-With": "XMLHttpRequest",
    };
  }

  async function send(method: "GET" | "POST", url: string, endpoint: string, headers: Record<string, string>, body?: string): Promise<Response> {
    const response = await http({ method, url, headers, ...(body === undefined ? {} : { body }) });
    const parsed = response.text === "" ? null : parseSourceJson(response.text, endpoint);
    context.preview.observe({ endpoint, status: response.status, body: parsed });
    if (response.status !== 200) return fail("unexpected-response", `${endpoint} HTTP ${response.status}`);
    return { body: record(parsed, endpoint), date: response.headers.date ?? null };
  }

  function metadata(rqData: Record<string, unknown>, currentTxn: string | null) {
    return {
      trackingPk: `${randomUUID().replaceAll("-", "")}${clientNo.slice(-4)}`,
      txnPk: transactionId,
      pk: "none",
      model: "Chrome",
      platform: "MacIntel",
      version: "151",
      network: "0",
      appVersion: "1.0",
      clientTime: String(Date.parse(context.now())),
      locale: "zh_TW",
      fromSysPk: "IB",
      token,
      clientNo,
      xDId: "",
      rqData,
      ...(currentTxn === null ? {} : { currentTxn }),
    };
  }

  async function adapter(procedure: string, payload: readonly unknown[], endpoint = `AuthenticationAdapter/${procedure}`): Promise<Response> {
    const body = JSON.stringify(payload);
    const response = await send("POST", `${ADAPTERS}/AuthenticationAdapter/${procedure}`, endpoint, {
      ...baseHeaders(),
      checksum: createHash("md5").update(body, "utf8").digest("hex"),
      "x-transaction-id": transactionId,
    }, body);
    const next = optionalText(response.body.token);
    if (next) token = next;
    return response;
  }

  function succeeded(response: Response, resource: string): Response {
    const { isSuccessful, statusCode } = response.body;
    if (isSuccessful === true && (statusCode === undefined || statusCode === "0000")) return response;
    const message = `${optionalText(response.body.statusDesc) ?? ""} ${JSON.stringify(response.body.validateError ?? null)}`;
    if (CAPTCHA_MESSAGE.test(message)) return fail("verification-rejected", `${resource} rejected the CAPTCHA`);
    return fail("unexpected-response", `${resource} statusCode ${typeof statusCode === "string" ? statusCode : "missing"}`);
  }

  async function resource(procedure: "sendAndReceive" | "sendAndReceiveNoSec", path: string, rqData: Record<string, unknown>, currentTxn: string | null) {
    const response = await adapter(procedure, [path, metadata(rqData, currentTxn)], path);
    return succeeded(response, path);
  }

  return {
    async bootstrap(): Promise<string> {
      await send("GET", `${ADAPTERS}/ChannelAdapter/getChannel`, "ChannelAdapter/getChannel", {
        Accept: "application/json",
        "Content-Type": "application/json",
        Referer: WEB_PAGE,
        "X-Requested-With": "XMLHttpRequest",
      });
      const oauth = await send("POST", `${ROOT}/oauth/token`, "oauth/token", {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      }, new URLSearchParams({ grant_type: "client_credentials", scope: "PUBLIC", client_id: "browser", client_secret: "browser" }).toString());
      accessToken = text(oauth.body.access_token, "oauth/token.access_token");
      const bootstrap = await resource("sendAndReceiveNoSec", RESOURCE.bootstrap, {}, null);
      const publicKey = text(record(record(bootstrap.body.rsData, `${RESOURCE.bootstrap}.rsData`).params, `${RESOURCE.bootstrap}.params`).e2e, `${RESOURCE.bootstrap}.params.e2e`);
      const challenge = await adapter("emptyLogin", [metadata({}, null)]);
      if (challenge.body.authStatus !== "required") return fail("unexpected-response", "emptyLogin.authStatus");
      token = "#";
      transactionId = randomUUID();
      await resource("sendAndReceiveNoSec", RESOURCE.loginPage, {}, "FCO02001");
      await resource("sendAndReceiveNoSec", RESOURCE.loginPageAudit, { type: "0", page: "FCO02001_010" }, "FCO02001");
      return publicKey;
    },
    async captcha(): Promise<Buffer> {
      const response = await resource("sendAndReceiveNoSec", RESOURCE.captcha, {}, "FCO02001");
      const image = text(record(response.body.rsData, `${RESOURCE.captcha}.rsData`).img, `${RESOURCE.captcha}.img`);
      const match = /^data:image\/[A-Za-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/u.exec(image);
      if (!match) return fail("unexpected-response", `${RESOURCE.captcha}.img is not a base64 image`);
      return Buffer.from(match[1]!, "base64");
    },
    /** Each value is sealed with its own server time factor, as the web login does. */
    async seal(publicKey: string, value: string): Promise<string> {
      const response = await resource("sendAndReceiveNoSec", RESOURCE.timeFactor, {}, null);
      const timeFactor = text(record(response.body.rsData, `${RESOURCE.timeFactor}.rsData`).timeFactor, `${RESOURCE.timeFactor}.timeFactor`);
      return encryptObankLoginValue(publicKey, value, timeFactor);
    },
    async login(rqData: Record<string, unknown>) {
      const response = await adapter("submitCredentials", [metadata(rqData, "FCO02001")]);
      const authStatus = optionalText(response.body.authStatus);
      if (authStatus !== null && authStatus !== "required") return;
      const rsData = record(response.body.rsData ?? {}, "submitCredentials.rsData");
      const resultType = optionalText(rsData.resultType);
      if (resultType === MULTIPLE_LOGIN) return fail("session-conflict", "O-Bank reports another signed-in session");
      if (resultType === "2" || resultType === "10") return fail("sign-in-rejected", `resultType ${resultType}`);
      if (CAPTCHA_MESSAGE.test(`${optionalText(response.body.statusDesc) ?? ""} ${JSON.stringify(response.body.validateError ?? null)}`))
        return fail("verification-rejected", "submitCredentials rejected the CAPTCHA");
      if (resultType === "1" || rsData.lockDownFlag === "Y") return fail("sign-in-rejected", "online banking is locked or unavailable");
      if (authStatus === "required") return fail("unexpected-response", "submitCredentials still requires authentication");
      succeeded(response, "submitCredentials");
    },
    secure: (path: string, rqData: Record<string, unknown>, currentTxn: string) => resource("sendAndReceive", path, rqData, currentTxn),
    async logout() {
      await send("GET", `${ADAPTERS}/BankingServicesAdapter/invalidateSession`, "BankingServicesAdapter/invalidateSession", baseHeaders());
    },
  };
}

type Api = ReturnType<typeof client>;

/** RSA PKCS#1 v1.5 over the value followed by the server time factor, base64. */
export function encryptObankLoginValue(publicKeyPem: string, value: string, timeFactor: string): string {
  try {
    return publicEncrypt({ key: publicKeyPem, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(`${value}${timeFactor}`, "utf8")).toString("base64");
  } catch {
    return fail("unexpected-response", "the login public key is not a usable RSA key");
  }
}

/** O-Bank dates may use the ROC year and unpadded parts, which `localDate` does not read. */
export function obankDate(value: unknown, field: string): PreviewLocalDate {
  const raw = typeof value === "string" ? value.trim() : "";
  const parts = /^(\d{2,4})[/.-](\d{1,2})[/.-](\d{1,2})(.*)$/u.exec(raw);
  if (!parts) return localDate(raw, field);
  const [, year, month, day, rest] = parts as unknown as [string, string, string, string, string];
  const gregorian = Number(year) < 1911 ? Number(year) + 1911 : Number(year);
  return localDate(`${gregorian}/${month.padStart(2, "0")}/${day.padStart(2, "0")}${rest}`, field);
}

type DemandItem = Readonly<{ itemNo: string; currency: string; account: PreviewAccount }>;

function demandItems(response: Response, now: string): DemandItem[] {
  const field = `${RESOURCE.demandDeposits}.rsData`;
  const rsData = record(response.body.rsData, field);
  const asOf = observedAt(response.date, now);
  const items: DemandItem[] = [];
  const seen = new Set<string>();
  for (const [groupIndex, group] of records(rsData.userAccounts, `${field}.userAccounts`).entries()) {
    const groupField = `${field}.userAccounts[${groupIndex}]`;
    const accountNo = optionalText(group.accountNo);
    for (const [itemIndex, item] of records(group.accountItems, `${groupField}.accountItems`).entries()) {
      const itemField = `${groupField}.accountItems[${itemIndex}]`;
      const itemNo = text(item.accountItemNo, `${itemField}.accountItemNo`);
      const currency = currencyCode(item.curr, `${itemField}.curr`);
      const key = `${itemNo}:${currency}`;
      if (seen.has(key)) return fail("unexpected-response", `${itemField} repeats an account item and currency`);
      seen.add(key);
      const name = optionalText(item.aliasName) ?? "存款帳戶";
      const last4 = (accountNo ?? itemNo).replace(/\D/gu, "").slice(-4);
      items.push({
        itemNo,
        currency,
        account: {
          sourceAccountKey: key,
          displayLabel: `王道銀行 ${name}${last4 ? ` ${last4}` : ""}${currency === "TWD" ? "" : ` (${currency})`}`,
          currency,
          type: "depository",
          balances: [
            { kind: "current", amount: exactDecimal(item.displayWorkBalNoCurr, `${itemField}.displayWorkBalNoCurr`), currency, observedAt: asOf },
            { kind: "available", amount: exactDecimal(item.displayActBalNoCurr, `${itemField}.displayActBalNoCurr`), currency, observedAt: asOf },
          ],
          transactions: [],
        },
      });
    }
  }
  if (items.length === 0) return fail("unexpected-response", `${field}.userAccounts lists no demand account`);
  return items;
}

function transactionsFrom(rows: readonly SourceRecord[], field: string, currency: string): PreviewTransaction[] {
  const occurrences = new Map<string, number>();
  return rows.map((row, index) => {
    const rowField = `${field}[${index}]`;
    const amount = exactDecimal(row.displayTxnAmount, `${rowField}.displayTxnAmount`);
    const postedAt = obankDate(row.txnDate, `${rowField}.txnDate`);
    const balance = row.displayClsBal === undefined || row.displayClsBal === null ? "" : exactDecimal(row.displayClsBal, `${rowField}.displayClsBal`);
    const descriptions = [optionalText(row.txnDesc), optionalText(row.displayMemo)].filter((entry) => entry !== null);
    // O-Bank rows carry no transaction id, so the key is the row's content plus its occurrence order.
    const identity = [postedAt.value, amount, balance, ...descriptions, optionalText(row.diplayAcct) ?? ""].join("\u0000");
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
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

async function itemTransactions(api: Api, item: DemandItem, window: Readonly<{ start: string; end: string }>): Promise<PreviewTransaction[]> {
  const startDate = window.start.replaceAll("-", "/");
  const endDate = window.end.replaceAll("-", "/");
  const response = await api.secure(RESOURCE.demandDeposits, {
    queryType: "customDisplay",
    startDate,
    endDate,
    subAccountItemNo: item.itemNo,
    curry: item.currency,
    initQuery: "N",
  }, "FAO01012");
  const field = `${RESOURCE.demandDeposits}.rsData`;
  const rsData = record(response.body.rsData, field);
  // The page echoes the queried range; a narrower answer means the bank cut the history short.
  for (const [name, requested] of [["startDate", startDate], ["endDate", endDate]] as const) {
    if (rsData[name] !== undefined && obankDate(rsData[name], `${field}.${name}`).value !== obankDate(requested, name).value)
      return fail("incomplete-data", `${field}.${name} differs from the requested range`);
  }
  if (rsData.curry !== undefined && currencyCode(rsData.curry, `${field}.curry`) !== item.currency)
    return fail("unexpected-response", `${field}.curry differs from the queried currency`);
  return transactionsFrom(records(rsData.despositTxnDetails, `${field}.despositTxnDetails`), `${field}.despositTxnDetails`, item.currency);
}

async function signIn(
  context: PreviewWorkflowContext,
  api: Api,
  decodeImage: PreviewImageDecoder,
  solve: PreviewCaptchaSolver,
  credentials: Readonly<Record<string, string>>,
) {
  const publicKey = await api.bootstrap();
  const answer = await solveChallengeRound(context, solve, async () => {
    const image = await api.captcha();
    const png = await decodeImage(image).catch(() => fail("unexpected-response", "the CAPTCHA is not a decodable image"));
    return { image: png, charset: "alphanumeric", expectedLength: 4 };
  }, 1);
  const uno = await api.seal(publicKey, credentials[KEY.userCode] ?? "");
  const sec = await api.seal(publicKey, credentials[KEY.password] ?? "");
  await api.login({
    no: credentials[KEY.idNumber] ?? "",
    uno,
    sec,
    captcha: answer,
    type: "0",
    // "1" would end the other session; a preview run never takes one over.
    force: "0",
    link: "link",
  });
}

export function createObankSource(options: Readonly<{ http?: PreviewHttpOpener; solveCaptcha?: PreviewCaptchaSolver }> = {}): PreviewSource {
  const open = options.http ?? nodeHttp;
  return {
    id: "obank-deposit",
    institution: PREVIEW_SOURCE_INSTITUTIONS["obank-deposit"],
    product: "deposit",
    displayName: { en: "O-Bank deposits (preview)", "zh-TW": "王道銀行存款（預覽）" },
    searchAliases: ["O-Bank", "OBank", "王道", "王道銀行"],
    credentialFields: [
      { key: KEY.idNumber, label: { en: "Taiwan ID number", "zh-TW": "身分證字號" }, input: "text", redaction: "partial" },
      { key: KEY.userCode, label: { en: "User code", "zh-TW": "使用者代號" }, input: "text", redaction: "partial" },
      { key: KEY.password, label: { en: "Password", "zh-TW": "網銀密碼" }, input: "password", redaction: "full" },
    ],
    setupGuide: {
      summary: {
        en: "Preview source, never run against a live O-Bank account. Its data may be incomplete or wrong. O-Bank's sign-in needs an image CAPTCHA that no on-device solver supports yet, so runs stop at sign-in.",
        "zh-TW": "預覽來源，從未以真實的王道銀行帳戶執行過，資料可能不完整或有誤。王道銀行登入需要圖形驗證碼，目前沒有裝置上的解題器支援，因此執行會在登入時停止。",
      },
      requirements: [{ en: "An O-Bank account with online banking sign-in.", "zh-TW": "可登入網路銀行的王道銀行帳戶。" }],
      steps: [{ en: "Enter the ID number, user code, and password you use to sign in to O-Bank online banking.", "zh-TW": "輸入登入王道銀行網路銀行使用的身分證字號、使用者代號與密碼。" }],
      links: [{
        id: "obank-site",
        label: { en: "O-Bank", "zh-TW": "王道銀行" },
        url: "https://www.o-bank.com/",
        allowedHosts: ["www.o-bank.com"],
      }],
    },
    sessionTakeoverNotice: {
      en: "O-Bank may allow one sign-in at a time. When you are signed in elsewhere, the sync stops instead of signing you out. This is not yet confirmed.",
      "zh-TW": "王道銀行可能同一時間只允許一處登入。若你已在其他地方登入，同步會停止，不會讓你登出。此行為尚未確認。",
    },
    startUrl: WEB_PAGE,
    async run(context, input) {
      await context.event("authentication", "authentication-started");
      const solve = options.solveCaptcha;
      if (!solve) return refuseUnsupportedVerification(context, "obank-image-captcha");
      return open(context, { pageUrl: input.startUrl }, async (http, decodeImage) => {
        const api = client(context, http);
        await signIn(context, api, decodeImage, solve, input.credentials);
        await context.event("authentication", "authentication-completed");
        try {
          await context.event("collection", "collection-started");
          const collectedAt = context.now();
          const list = await api.secure(RESOURCE.demandDeposits, { masterAccountNo: "", queryType: "before7Days", initQuery: "Y" }, "FAO01012");
          const window = taipeiMonthWindow(collectedAt, MONTHS);
          const accounts: PreviewAccount[] = [];
          for (const item of demandItems(list, collectedAt))
            accounts.push({ ...item.account, transactions: await itemTransactions(api, item, window) });
          await context.event("collection", "collection-completed");
          return await context.preview.write({ collectedAt, accounts });
        } finally {
          await api.logout().catch(() => undefined);
        }
      });
    },
  };
}

export const OBANK_PREVIEW_SOURCE = createObankSource();
