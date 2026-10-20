import { constants, publicEncrypt } from "node:crypto";
import type { PreviewAccount, PreviewTimeDeposit, PreviewTimeDepositCollection, PreviewTransaction } from "../../ledger/pglite/preview-financial-data.ts";
import { browserHttp, type PreviewHttp, type PreviewHttpOpener } from "./browser-http.ts";
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
  type PreviewCaptchaSolver,
  type SourceRecord,
  uniqueTransactions,
} from "./source-kit.ts";
import { nextbankAudioCaptchaSolver } from "./preview-captcha.ts";
import type { PreviewWorkflowContext } from "./workflow.ts";

const API = "https://api.nextbank.com.tw";
const WEB = "https://www.nextbank.com.tw/";
// The RSA public key of NextBank's web login, as all-set-tw recorded it (nextbank/api.ts).
const PASSWORD_RSA_MODULUS = "B65A34251E089C68D3A586D403D3A31362B8287AAB9C7BD8F90311185D823492D953EE917F261C148A5518F2745CA46148E481CE5718820A0BE208B8EE9D465628DC9F17893B315E986388507AA21B3A058CB6E7C5768746BE236D490BA76F29BF70D06A9B7FBFC8BF86FEC6D44BAA53C44CDACD5D8D3D2820BC776B3D31637094227D8B029941CF5BF7A20D86A7E5209961C111F92F3E10700429F386637B8A9A667348A2C7AC98BF60078101ACA1D4D772457E49411B4F7D94AC8EDA62EED196C4A943635E4227B5B86B5357D9939DDD66652DF99D6B1D82696708E41B8B9829E3D5558FA3F961674BA28D94508CBC7F87E4820E293790AFA0D4B2EEAC386B"; // gitleaks:allow public key
const MONTHS = 3;
const POCKET_PAGE_SIZE = 10;
const MAX_POCKET_PAGES = 1000;
// NextBank's CAPTCHA answer is five decimal digits, confirmed by the October
// 2026 calibration corpus (all 60 labels). The `isAudio: true` challenge comes
// back as `captchaAudio`, a list of five base64 clips, one spoken digit each;
// the audio solver transcribes each clip and maps it to a digit.
const CAPTCHA_LENGTH = 5;
// NextBank offers NT-dollar deposits only, and neither AllInOne nor PocketInfo
// carries a currency field. A currency the source does send always wins.
const ENDPOINT_CURRENCY = "TWD";

const KEY = {
  idNumber: "PREVIEW_NEXTBANK_DEPOSIT_ID_NUMBER",
  userId: "PREVIEW_NEXTBANK_DEPOSIT_USER_ID",
  password: "PREVIEW_NEXTBANK_DEPOSIT_PASSWORD",
} as const;

const SIGN_IN_REJECTED = new Set([
  "LOGIN_ERROR",
  "MEMBER_LOCKED",
  "ACCOUNT_CLOSED",
  "ACCOUNT_EMERGENTLY_CLOSED",
  "ACCOUNT_OPENING_IS_REVIEWING",
  "ACCOUNT_OPENING_IS_DECLINED",
]);

function errorFor(code: string): never {
  if (SIGN_IN_REJECTED.has(code) || /^CONTINUOUSLY_LOGIN_ERROR_\d+_TIMES$/u.test(code)) return fail("sign-in-rejected", code);
  if (code === "CAPTCHA_ERROR" || code === "CAPTCHA_EXPIRED") return fail("verification-rejected", code);
  if (code === "OTHER_DEVICE_LOGIN" || code === "ABNORMAL_LOGOUT") return fail("session-conflict", code);
  return fail("unexpected-response", `NextBank error ${code}`);
}

type Response = Readonly<{ data: SourceRecord; date: string | null }>;

function client(context: PreviewWorkflowContext, http: PreviewHttp) {
  let token: string | null = null;
  async function post(path: string, body: Record<string, unknown>, emptyData = false): Promise<Response> {
    const response = await http({
      method: "POST",
      url: `${API}${path}`,
      headers: {
        "Content-Type": "application/json",
        "X-NCB-Channel": "WEB",
        Channel: "WEB",
        ...(token ? { Acstkn: token } : {}),
      },
      body: JSON.stringify(body),
    });
    const parsed = response.text === "" ? null : parseSourceJson(response.text, path);
    context.preview.observe({ endpoint: path, status: response.status, body: parsed });
    if (response.status !== 200) return fail("unexpected-response", `${path} HTTP ${response.status}`);
    const envelope = record(parsed, path);
    if (envelope.success === false) return errorFor(text(record(envelope.error, `${path}.error`).errorCode, `${path}.errorCode`));
    if (envelope.success !== true) return fail("unexpected-response", `${path}.success`);
    const data = emptyData && envelope.data == null ? {} : record(envelope.data, `${path}.data`);
    return { data, date: response.headers.date ?? null };
  }
  return {
    post,
    setToken(value: string) { token = value; },
  };
}

export function encryptNextBankPassword(password: string): string {
  const key = { kty: "RSA", n: Buffer.from(PASSWORD_RSA_MODULUS, "hex").toString("base64url"), e: "AQAB" };
  return publicEncrypt({ key, format: "jwk", padding: constants.RSA_PKCS1_PADDING }, Buffer.from(password, "utf8"))
    .toString("hex")
    .toUpperCase();
}

function captchaAudioClips(value: unknown): readonly Buffer[] {
  if (!Array.isArray(value) || value.length === 0) return fail("unexpected-response", "Captcha.captchaAudio is not a non-empty list");
  return value.map((clip, index) => Buffer.from(text(clip, `Captcha.captchaAudio[${index}]`), "base64"));
}

function trades(page: SourceRecord, field: string): readonly SourceRecord[] {
  return records(page.trades, `${field}.trades`);
}

function transactionFrom(trade: SourceRecord, field: string, currency: string): PreviewTransaction | null {
  if (trade.tradeChannel === "UNBILLED") return null;
  const tradeId = text(trade.tradeID, `${field}.tradeID`);
  const detail = record(trade.detail, `${field}.detail`);
  const posted = detail.deductionDate ?? detail.txnDateTime ?? trade.tradeDateTime;
  const postedAt = localDate(posted, `${field}.date`);
  const occurred = localDate(detail.txnDateTime ?? trade.tradeDateTime ?? posted, `${field}.txnDateTime`);
  const descriptions = [detail.descript, detail.summary, detail.memo].map(optionalText).filter((value) => value !== null);
  return {
    sourceRowKey: `${occurred.value.slice(0, 10)}:${tradeId}`,
    amount: exactDecimal(trade.tradeAmount, `${field}.tradeAmount`),
    currency: trade.currency === undefined ? currency : currencyCode(trade.currency, `${field}.currency`),
    direction: "unknown",
    postedAt,
    description: descriptions.length > 0 ? [...new Set(descriptions)].join(" · ") : null,
  };
}

function sourceCurrency(value: unknown, field: string): string {
  return value === undefined ? ENDPOINT_CURRENCY : currencyCode(value, field);
}

function epochRange(start: string, end: string, now: string): Readonly<{ startDateTime: number; endDateTime: number }> {
  const startDateTime = Date.parse(`${start}T00:00:00+08:00`);
  const endOfDay = Date.parse(`${end}T00:00:00+08:00`) + 86_400_000 - 1;
  return { startDateTime, endDateTime: Math.min(endOfDay, Date.parse(now)) };
}

function monthRanges(now: string): readonly Readonly<{ start: string; end: string }>[] {
  const { start, end } = taipeiMonthWindow(now, MONTHS);
  const ranges: { start: string; end: string }[] = [];
  let cursor = start;
  while (cursor <= end) {
    const [year, month] = cursor.split("-").map(Number) as [number, number];
    const next = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
    const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    ranges.push({ start: cursor, end: last < end ? last : end });
    cursor = next;
  }
  return ranges;
}

async function mainAccount(api: ReturnType<typeof client>, now: string): Promise<PreviewAccount> {
  const overview = await api.post("/ap2/api/v2.1/membership/AllInOne", {});
  const main = record(overview.data.mainAccount, "AllInOne.mainAccount");
  const accountId = text(main.accountId, "mainAccount.accountId");
  const currency = sourceCurrency(main.currency, "mainAccount.currency");
  const asOf = observedAt(overview.date, now);
  const rows: (PreviewTransaction | null)[] = [];
  for (const range of monthRanges(now)) {
    const page = await api.post("/ap1/api/v3.0/AppMainPage/CurrentDepositDetail", epochRange(range.start, range.end, now));
    if (page.data.pageInfo !== undefined && record(page.data.pageInfo, "CurrentDepositDetail.pageInfo").hasNext !== false)
      return fail("incomplete-data", "CurrentDepositDetail reports more pages");
    rows.push(...trades(page.data, "CurrentDepositDetail").map((trade, index) =>
      transactionFrom(trade, `CurrentDepositDetail.trades[${index}]`, currency)));
  }
  return {
    sourceAccountKey: `main:${accountId}`,
    displayLabel: `將來銀行 主帳戶 ${accountId.slice(-4)}`,
    currency,
    type: "depository",
    balances: [
      { kind: "current", amount: exactDecimal(main.workingBalance, "mainAccount.workingBalance"), currency, observedAt: asOf },
      { kind: "available", amount: exactDecimal(main.availableBalance, "mainAccount.availableBalance"), currency, observedAt: asOf },
    ],
    transactions: uniqueTransactions(rows, "tradeID"),
  };
}

async function demandPocket(api: ReturnType<typeof client>, pocket: SourceRecord, field: string, asOf: ReturnType<typeof observedAt>): Promise<PreviewAccount> {
  const accNo = text(pocket.accNo, `${field}.accNo`);
  const currency = sourceCurrency(pocket.currency, `${field}.currency`);
  const rows: (PreviewTransaction | null)[] = [];
  const seenCursors = new Set<string>();
  let paging = { pageToken: "", startTradeID: "", pageSize: POCKET_PAGE_SIZE };
  for (let pageNumber = 0; ; pageNumber += 1) {
    if (pageNumber >= MAX_POCKET_PAGES) return fail("incomplete-data", "GetPocketTxDetail exceeded its page bound");
    const page = await api.post("/ap1/api/v1.0/demandDeposit/GetPocketTxDetail", { accNo, paging });
    const pageTrades = trades(page.data, "GetPocketTxDetail");
    rows.push(...pageTrades.map((trade, index) => transactionFrom(trade, `GetPocketTxDetail.trades[${index}]`, currency)));
    const info = record(page.data.pageInfo, "GetPocketTxDetail.pageInfo");
    if (typeof info.hasNext !== "boolean") return fail("incomplete-data", "GetPocketTxDetail.pageInfo.hasNext is not a boolean");
    if (!info.hasNext) break;
    if (pageTrades.length === 0) return fail("incomplete-data", "GetPocketTxDetail reports more pages after an empty page");
    paging = {
      pageToken: text(info.pageToken, "pageInfo.pageToken"),
      startTradeID: text(info.lastTradeID, "pageInfo.lastTradeID"),
      pageSize: POCKET_PAGE_SIZE,
    };
    const cursor = `${paging.pageToken}\u0000${paging.startTradeID}`;
    if (seenCursors.has(cursor)) return fail("incomplete-data", "GetPocketTxDetail repeated a page cursor");
    seenCursors.add(cursor);
  }
  return {
    sourceAccountKey: `pocket:${accNo}`,
    displayLabel: `將來銀行 ${optionalText(pocket.name) ?? "活存口袋"}`,
    currency,
    type: "depository",
    balances: [{ kind: "current", amount: exactDecimal(pocket.amount, `${field}.amount`), currency, observedAt: asOf }],
    transactions: uniqueTransactions(rows, "tradeID"),
  };
}

type PocketList = Readonly<{ pockets: readonly SourceRecord[]; termTotal: unknown; asOf: ReturnType<typeof observedAt> }>;

async function pocketList(api: ReturnType<typeof client>, now: string): Promise<PocketList> {
  const response = await api.post("/ap1/api/v3.0/AppMainPage/PocketInfo", {});
  const pockets = records(response.data.pocketDetails, "PocketInfo.pocketDetails");
  for (const [index, pocket] of pockets.entries())
    if (pocket.depositType !== "DEPOSIT" && pocket.depositType !== "TERMDEPOSIT") return fail("unexpected-response", `PocketInfo.pocketDetails[${index}].depositType`);
  return { pockets, termTotal: response.data.termDepositTotalAmount, asOf: observedAt(response.date, now) };
}

async function demandPockets(api: ReturnType<typeof client>, list: PocketList): Promise<PreviewAccount[]> {
  const accounts: PreviewAccount[] = [];
  for (const [index, pocket] of list.pockets.entries())
    if (pocket.depositType === "DEPOSIT") accounts.push(await demandPocket(api, pocket, `PocketInfo.pocketDetails[${index}]`, list.asOf));
  return accounts;
}

type TermPocket = Readonly<{ arrngId: string; name: string | null; currency: string; amount: string }>;

function termPocket(pocket: SourceRecord, field: string): TermPocket {
  return {
    arrngId: text(pocket.arrngId, `${field}.arrngId`),
    name: optionalText(pocket.name),
    currency: sourceCurrency(pocket.currency, `${field}.currency`),
    amount: exactDecimal(pocket.amount, `${field}.amount`),
  };
}

async function termDeposit(api: ReturnType<typeof client>, pocket: TermPocket, asOf: ReturnType<typeof observedAt>): Promise<PreviewTimeDeposit> {
  const detail = await api.post("/ap1/api/v2.3/termdeposit/GetTermDepositDetail", { arrngId: pocket.arrngId });
  const end = detail.data.endDate;
  return {
    // The v1 deposit product wrote term pockets under this key, so the same row moves to time_deposit.
    sourceAccountKey: `term:${pocket.arrngId}`,
    displayLabel: `將來銀行 ${pocket.name ?? "定存口袋"}`,
    currency: pocket.currency,
    balances: [{ kind: "current", amount: pocket.amount, currency: pocket.currency, observedAt: asOf }],
    principal: pocket.amount,
    interestRate: null,
    maturityDate: end === undefined || end === null || end === "" ? null : localDate(end, "GetTermDepositDetail.endDate").value.slice(0, 10),
  };
}

/**
 * PocketInfo is one unpaged list. It is complete when its term-deposit total
 * equals the exact sum of the term pockets it lists, as all-set-tw reconciles.
 */
async function termPockets(api: ReturnType<typeof client>, list: PocketList, collectedAt: string): Promise<PreviewTimeDepositCollection> {
  const pockets = list.pockets.flatMap((pocket, index) =>
    pocket.depositType === "TERMDEPOSIT" ? [termPocket(pocket, `PocketInfo.pocketDetails[${index}]`)] : []);
  if (list.termTotal === undefined || list.termTotal === null) return fail("incomplete-data", "PocketInfo has no termDepositTotalAmount");
  const total = exactDecimal(list.termTotal, "PocketInfo.termDepositTotalAmount");
  if (new Set(pockets.map((pocket) => pocket.currency)).size > 1)
    return fail("incomplete-data", "term pockets in several currencies cannot be reconciled with termDepositTotalAmount");
  if (!isZeroDecimal(decimalSum([...pockets.map((pocket) => [1, pocket.amount] as const), [-1, total]])))
    return fail("incomplete-data", "term pockets do not add up to termDepositTotalAmount");
  const deposits: PreviewTimeDeposit[] = [];
  for (const pocket of pockets) deposits.push(await termDeposit(api, pocket, list.asOf));
  return { collectedAt, completeness: "complete", deposits };
}

export function createNextBankSource(options: Readonly<{ http?: PreviewHttpOpener; solveCaptcha?: PreviewCaptchaSolver }> = {}): PreviewSource {
  const open = options.http ?? browserHttp;
  return {
    id: "nextbank-deposit",
    institution: PREVIEW_SOURCE_INSTITUTIONS["nextbank-deposit"],
    products: ["deposit", "time_deposit"],
    displayName: { en: "Next Bank deposits (preview)", "zh-TW": "將來銀行存款（預覽）" },
    searchAliases: ["Next Bank", "NextBank", "將來", "將來銀行"],
    credentialFields: [
      { key: KEY.idNumber, label: { en: "Taiwan ID number", "zh-TW": "身分證字號" }, input: "text", redaction: "partial" },
      { key: KEY.userId, label: { en: "User code", "zh-TW": "使用者代碼" }, input: "text", redaction: "partial" },
      { key: KEY.password, label: { en: "Password", "zh-TW": "密碼" }, input: "password", redaction: "full" },
    ],
    setupGuide: {
      summary: {
        en: "Preview source, never run against a live Next Bank account. Its data may be incomplete or wrong. Next Bank's sign-in CAPTCHA is solved from its spoken audio with the on-device speech recogniser, and the run stops at sign-in when it cannot read the clip.",
        "zh-TW": "預覽來源，從未以真實的將來銀行帳戶執行過，資料可能不完整或有誤。將來銀行登入的驗證碼以語音播放，由裝置上的語音辨識器解題；無法辨識時，執行會在登入時停止。",
      },
      requirements: [{ en: "A Next Bank account with web sign-in.", "zh-TW": "可用網頁登入的將來銀行帳戶。" }],
      steps: [{ en: "Enter the ID number, user code, and password you use to sign in to Next Bank.", "zh-TW": "輸入登入將來銀行使用的身分證字號、使用者代碼與密碼。" }],
      links: [{
        id: "nextbank-site",
        label: { en: "Next Bank", "zh-TW": "將來銀行" },
        url: "https://www.nextbank.com.tw/",
        allowedHosts: ["www.nextbank.com.tw"],
      }],
    },
    sessionTakeoverNotice: {
      en: "Next Bank may allow one sign-in at a time. A sync may sign you out of the Next Bank App. This is not yet confirmed.",
      "zh-TW": "將來銀行可能同一時間只允許一處登入，同步可能讓你的將來銀行 App 登出。此行為尚未確認。",
    },
    startUrl: WEB,
    async run(context, input) {
      await context.event("authentication", "authentication-started");
      const solve = options.solveCaptcha ?? nextbankAudioCaptchaSolver();
      return open(context, { pageUrl: input.startUrl }, async (http) => {
        const api = client(context, http);
        const challenge = await api.post("/ap2/open/common/v1.0/Captcha", { isAudio: true });
        const answer = await solveChallengeRound(context, solve, async () => ({
          audio: captchaAudioClips(challenge.data.captchaAudio),
          expectedLength: CAPTCHA_LENGTH,
        }), 1);
        const login = await api.post("/ap2/api/v1.1/membership/CaptchaLogin", {
          identity: input.credentials[KEY.idNumber] ?? "",
          userId: Buffer.from(input.credentials[KEY.userId] ?? "", "utf8").toString("base64"),
          passwd: encryptNextBankPassword(input.credentials[KEY.password] ?? ""),
          captchaResult: answer,
          captchaUuid: text(challenge.data.uuid, "Captcha.uuid"),
          idgateId: "",
          isAbnormalLogout: false,
        });
        api.setToken(text(login.data.acstkn, "CaptchaLogin.acstkn"));
        await context.event("authentication", "authentication-completed");
        try {
          const collectedAt = context.now();
          let pockets: Promise<PocketList> | null = null;
          const list = () => pockets ??= pocketList(api, collectedAt);
          return await context.preview.collect({
            deposit: async () => ({ collectedAt, accounts: [await mainAccount(api, collectedAt), ...await demandPockets(api, await list())] }),
            time_deposit: async () => termPockets(api, await list(), collectedAt),
          });
        } finally {
          await api.post("/ap2/api/v1.0/membership/Logout", {}, true).catch(() => undefined);
        }
      });
    },
  };
}

export const NEXTBANK_PREVIEW_SOURCE = createNextBankSource();
