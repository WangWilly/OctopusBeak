import type { Page } from "playwright";
import type { PreviewAccount, PreviewTransaction } from "../../ledger/pglite/preview-financial-data.ts";
import { SourceUnavailableError } from "../automation/source-access.ts";
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
  solveChallengeRound,
  text,
  type PreviewCaptchaSolver,
  type SourceRecord,
  uniqueTransactions,
} from "./source-kit.ts";
import type { PreviewWorkflowContext } from "./workflow.ts";
import { calibratedCaptchaSolver, RAKUTEN_CAPTCHA_FAMILY } from "./preview-captcha.ts";
import { decodeImageToPng } from "./browser-http.ts";

const LOGIN_URL = "https://www.rakuten-bank.com.tw/ebank/cgn/cgnot0001/010";
const CURRENT_MONTH_PATH = "/CTWQU0001/010";
const PAST_MONTH_PATH = "/CTWQU0001/011";
const MONTHS = 3;
const CAPTCHA_LENGTH = 4;
// CTWQU0001 is the 臺幣存款 (NT-dollar deposit) page's detail query and carries no
// currency field. A currency the source does send always wins.
const ENDPOINT_CURRENCY = "TWD";
const CURRENCY_FIELDS = ["currency", "cur", "curr", "ccy"] as const;

const KEY = {
  idNumber: "PREVIEW_RAKUTEN_DEPOSIT_ID_NUMBER",
  userId: "PREVIEW_RAKUTEN_DEPOSIT_USER_ID",
  password: "PREVIEW_RAKUTEN_DEPOSIT_PASSWORD",
} as const;

/** One API response as the web page decrypted it: the plaintext `{ statusCode, rsData }` envelope. */
export type RakutenCapture = Readonly<{ endpoint: string; status: number; date: string | null; text: string }>;

export type RakutenSignInOutcome =
  | Readonly<{ kind: "signed-in" }>
  | Readonly<{ kind: "refused"; message: string }>
  | Readonly<{ kind: "no-outcome" }>;

/**
 * Rakuten encrypts every API response with a session key and decrypts it in the
 * page, so the source drives the web page and reads what the page decrypted.
 */
export type RakutenPage = Readonly<{
  captchaImage(): Promise<Buffer>;
  signIn(credentials: Readonly<{ idNumber: string; userId: string; password: string; captcha: string }>): Promise<RakutenSignInOutcome>;
  /** 0 is the current month (CTWQU0001/010); n picks the month n back in the page's dropdown (CTWQU0001/011). */
  depositMonth(monthsBack: number): Promise<RakutenCapture>;
  signOut(): Promise<void>;
}>;

export type RakutenPageOpener = <T>(context: PreviewWorkflowContext, startUrl: string, use: (page: RakutenPage) => Promise<T>) => Promise<T>;

async function signInFailure(context: PreviewWorkflowContext, outcome: RakutenSignInOutcome): Promise<never> {
  if (outcome.kind !== "refused") return fail("unexpected-response", "the sign-in outcome was not readable");
  const message = outcome.message;
  if (/重複登入|其他裝置/u.test(message)) return fail("session-conflict", "signed in elsewhere");
  if (/晶片|裝置綁定|裝置認證|手機號碼|電子信箱|簡訊|OTP|約定條款/iu.test(message))
    return requireDeviceRegistration(context, "Rakuten asks to verify this device");
  if (/驗證碼/u.test(message)) return fail("verification-rejected", "CAPTCHA rejected");
  if (/密碼|代號|身分證|錯誤次數/u.test(message)) return fail("sign-in-rejected", "credentials rejected");
  if (/維護/u.test(message)) throw new SourceUnavailableError();
  return fail("unexpected-response", "the sign-in message was not recognized");
}

function sourceCurrency(holder: SourceRecord, field: string, fallback: string): string {
  const name = CURRENCY_FIELDS.find((candidate) => holder[candidate] !== undefined);
  return name === undefined ? fallback : currencyCode(holder[name], `${field}.${name}`, { NTD: "TWD" });
}

const comparableAccountNo = (value: string) => value.replace(/[\s-]/gu, "");

type Month = Readonly<{ accountNo: string; data: SourceRecord; date: string | null }>;

function monthFrom(context: PreviewWorkflowContext, capture: RakutenCapture, expected: string): Month {
  const envelope = parseSourceJson(capture.text, expected);
  context.preview.observe({ endpoint: capture.endpoint, status: capture.status, body: envelope });
  if (!capture.endpoint.endsWith(expected)) return fail("unexpected-response", `expected ${expected}, captured ${capture.endpoint}`);
  const { statusCode, rsData } = record(envelope, expected);
  if (statusCode !== "0000") return fail("unexpected-response", `${expected} statusCode ${String(statusCode)}`);
  const data = record(rsData, `${expected}.rsData`);
  return { accountNo: text(data.queryAccountNo, `${expected}.queryAccountNo`), data, date: capture.date };
}

function monthRows(month: Month, field: string): readonly SourceRecord[] {
  const display = record(month.data.display, `${field}.display`);
  const details = month.data.txDetails;
  if (display.noData === true && details == null) return [];
  const rows = records(details, `${field}.txDetails`);
  if (display.dataLimit === true) return fail("incomplete-data", `${field} reports dataLimit`);
  // all-set-tw observed dataEnd false on months without rows, so it marks truncation only with rows.
  if (rows.length > 0 && display.dataEnd !== true) return fail("incomplete-data", `${field} does not report dataEnd true`);
  return rows;
}

function transactionFrom(row: SourceRecord, field: string, currency: string): PreviewTransaction {
  const date = text(row.sysDate, `${field}.sysDate`);
  const time = optionalText(row.sysTime);
  const descriptions = [row.txDesc, row.memo].map(optionalText).filter((value) => value !== null);
  return {
    sourceRowKey: text(row.pk, `${field}.pk`),
    amount: exactDecimal(row.amt, `${field}.amt`),
    currency: sourceCurrency(row, field, currency),
    // amtSign is a boolean whose meaning all-set-tw could not confirm, so it is not a direction.
    direction: "unknown",
    postedAt: localDate(time ? `${date} ${time}` : date, `${field}.sysDate`),
    description: descriptions.length > 0 ? descriptions.join(" · ") : null,
  };
}

function depositAccount(months: readonly Month[], collectedAt: string): PreviewAccount {
  const [current] = months as [Month];
  const accountNo = current.accountNo;
  for (const month of months) {
    if (comparableAccountNo(month.accountNo) !== comparableAccountNo(accountNo))
      return fail("unexpected-response", "CTWQU0001 months query different accounts");
  }
  const entry = records(current.data.accounts, "CTWQU0001.accounts")
    .find((candidate) => typeof candidate.acctNo === "string" && comparableAccountNo(candidate.acctNo) === comparableAccountNo(accountNo));
  if (!entry) return fail("unexpected-response", "CTWQU0001.accounts lacks the queried account");
  const currency = sourceCurrency(entry, "CTWQU0001.accounts[queried]", ENDPOINT_CURRENCY);
  const rows = months.flatMap((month, index) => monthRows(month, `CTWQU0001[${index}]`)
    .map((row, rowIndex) => transactionFrom(row, `CTWQU0001[${index}].txDetails[${rowIndex}]`, currency)));
  return {
    sourceAccountKey: `twd-demand:${comparableAccountNo(accountNo)}`,
    displayLabel: `樂天國際銀行 臺幣活存 ${comparableAccountNo(accountNo).slice(-4)}`,
    currency,
    type: "depository",
    balances: [{
      kind: "current",
      amount: exactDecimal(entry.balance, "CTWQU0001.accounts[queried].balance"),
      currency,
      observedAt: observedAt(current.date, collectedAt),
    }],
    transactions: uniqueTransactions(rows, "pk"),
  };
}

type TapEntry = { path: string; status: number; date: string | null; text: string };
type TapWindow = { __octopusRakutenTap?: { last: Omit<TapEntry, "text">; entries: TapEntry[] } };

/** Runs in the page before its scripts: keeps the plaintext the page hands to JSON.parse after decrypting. */
function installResponseTap() {
  const w = window as unknown as TapWindow;
  if (w.__octopusRakutenTap) return;
  const store = { last: { path: "", status: 0, date: null as string | null }, entries: [] as TapEntry[] };
  w.__octopusRakutenTap = store;
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
    const path = new URL(String(args[1]), location.href).pathname;
    this.addEventListener("load", () => {
      store.last = { path, status: this.status, date: this.getResponseHeader("date") };
    });
    return (open as (...values: unknown[]) => void).apply(this, args);
  } as typeof XMLHttpRequest.prototype.open;
  const parse = JSON.parse;
  JSON.parse = function (source: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) {
    const result: unknown = parse.call(JSON, source, reviver as never);
    if (result !== null && typeof result === "object" && "statusCode" in result && "rsData" in result && store.entries.length < 50)
      store.entries.push({ ...store.last, text: source });
    return result;
  } as typeof JSON.parse;
}

const TAP_POLL_MS = 200;
const WAIT_MS = 8_000;

async function tapCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as TapWindow).__octopusRakutenTap?.entries.length ?? 0);
}

async function waitForCapture(page: Page, suffix: string, after: number): Promise<RakutenCapture> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const entry = await page.evaluate(({ suffix, after }) =>
      (window as unknown as TapWindow).__octopusRakutenTap?.entries.slice(after).find((item) => item.path.endsWith(suffix)) ?? null,
    { suffix, after });
    if (entry) return { endpoint: entry.path, status: entry.status, date: entry.date, text: entry.text };
    await page.waitForTimeout(TAP_POLL_MS);
  }
  return fail("unexpected-response", `no decrypted ${suffix} response`);
}

async function clickOutsideModal(page: Page, label: string | RegExp): Promise<boolean> {
  const target = page.locator("a, button").filter({ hasText: label }).filter({ hasNot: page.locator(".modal") });
  if (await target.count() === 0) return false;
  await target.first().click();
  return true;
}

function shiftMonth(label: string, back: number): string {
  const [year, month] = label.split("/").map(Number) as [number, number];
  const index = year * 12 + month - 1 - back;
  return `${Math.floor(index / 12)}/${String((index % 12) + 1).padStart(2, "0")}`;
}

async function visibleModalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    for (const modal of document.querySelectorAll<HTMLElement>(".modal")) {
      if (!modal.classList.contains("show") && getComputedStyle(modal).display === "none") continue;
      const combined = `${modal.querySelector(".modal-title")?.textContent ?? ""}\n${modal.querySelector(".txt_info")?.textContent ?? ""}`.trim();
      if (combined) return combined;
    }
    return "";
  });
}

/**
 * Unverified against the live site: selectors and flow follow all-set-tw's
 * Rakuten connector (commit d217135).
 */
export const playwrightRakutenPage: RakutenPageOpener = (context, startUrl, use) =>
  context.browser.withPage(async (page) => {
    let dialogMessage: string | null = null;
    page.on("dialog", (dialog) => {
      dialogMessage = dialog.message();
      // Never confirm on the user's behalf, such as "sign out the other device and continue?".
      void (dialog.type() === "alert" ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
    });
    await page.addInitScript(installResponseTap);
    await page.goto(startUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#captcha");
    let monthLabel: string | null = null;
    return use({
      async captchaImage() {
        const image = page.locator("div.pic_veri captcha-image img");
        await image.waitFor();
        const source = await image.getAttribute("src") ?? "";
        const match = /^data:[^;]+;base64,(.+)$/u.exec(source);
        if (!match) return fail("unexpected-response", "the CAPTCHA image is not a data URI");
        return decodeImageToPng(page, Buffer.from(match[1]!, "base64"))
          .catch(() => fail("unexpected-response", "the CAPTCHA is not a decodable image"));
      },
      async signIn(credentials) {
        await page.fill("#custNo", credentials.idNumber);
        await page.fill("#userNo", credentials.userId);
        await page.fill("#pcode", credentials.password);
        await page.fill("#captcha", credentials.captcha);
        dialogMessage = null;
        await page.click("div.login-box a.btn.btn-primary.w-100");
        const deadline = Date.now() + WAIT_MS;
        while (Date.now() < deadline) {
          if (page.url().includes("/ebank/chm/")) return { kind: "signed-in" };
          const message = dialogMessage ?? await visibleModalText(page);
          if (message) return { kind: "refused", message };
          await page.waitForTimeout(TAP_POLL_MS);
        }
        return { kind: "no-outcome" };
      },
      async depositMonth(monthsBack) {
        if (monthsBack === 0) {
          const before = await tapCount(page);
          await clickOutsideModal(page, /^\s*存款\s*$/u);
          if (!await clickOutsideModal(page, /^\s*臺幣存款\s*$/u)) return fail("unexpected-response", "no 臺幣存款 link");
          return waitForCapture(page, CURRENT_MONTH_PATH, before);
        }
        const toggle = page.locator("button").filter({ hasText: /\d{4}\/\d{2}\s*活存明細/u }).first();
        monthLabel ??= /(\d{4}\/\d{2})/u.exec(await toggle.innerText())?.[1] ?? null;
        if (!monthLabel) return fail("unexpected-response", "the month dropdown label is not readable");
        const before = await tapCount(page);
        await toggle.click();
        const target = shiftMonth(monthLabel, monthsBack);
        if (!await clickOutsideModal(page, new RegExp(`${target}\\s*活存明細`, "u"))) return fail("unexpected-response", `no ${target} option`);
        return waitForCapture(page, PAST_MONTH_PATH, before);
      },
      async signOut() {
        if (!await clickOutsideModal(page, /^\s*登出\s*$/u)) return;
        await page.locator(".modal.show .modal-footer").getByText("確認", { exact: true }).click({ timeout: 3_000 });
      },
    });
  });

export function createRakutenSource(options: Readonly<{ page?: RakutenPageOpener; solveCaptcha?: PreviewCaptchaSolver }> = {}): PreviewSource {
  const open = options.page ?? playwrightRakutenPage;
  return {
    id: "rakuten-deposit",
    institution: PREVIEW_SOURCE_INSTITUTIONS["rakuten-deposit"],
    products: ["deposit"],
    displayName: { en: "Rakuten International Commercial Bank deposits (preview)", "zh-TW": "樂天國際銀行存款（預覽）" },
    searchAliases: ["Rakuten", "Rakuten Bank", "樂天", "樂天銀行", "樂天國際銀行"],
    credentialFields: [
      { key: KEY.idNumber, label: { en: "Taiwan ID number", "zh-TW": "身分證字號" }, input: "text", redaction: "partial" },
      { key: KEY.userId, label: { en: "User code", "zh-TW": "使用者代號" }, input: "text", redaction: "partial" },
      { key: KEY.password, label: { en: "Password", "zh-TW": "密碼" }, input: "password", redaction: "full" },
    ],
    setupGuide: {
      summary: {
        en: "Preview source, never run against a live Rakuten Bank account. Its data may be incomplete or wrong. Login verification runs on this device; a challenge that cannot be verified ends the run.",
        "zh-TW": "預覽來源，從未以真實的樂天國際銀行帳戶執行過，資料可能不完整或有誤。登入驗證會在此裝置上執行，無法確認驗證碼時會結束執行。",
      },
      requirements: [{ en: "A Rakuten Bank account with web banking sign-in.", "zh-TW": "可用網路銀行登入的樂天國際銀行帳戶。" }],
      steps: [{ en: "Enter the ID number, user code, and password you use to sign in to Rakuten web banking.", "zh-TW": "輸入登入樂天網路銀行使用的身分證字號、使用者代號與密碼。" }],
      links: [{
        id: "rakuten-site",
        label: { en: "Rakuten International Commercial Bank", "zh-TW": "樂天國際銀行" },
        url: "https://www.rakuten-bank.com.tw/",
        allowedHosts: ["www.rakuten-bank.com.tw"],
      }],
    },
    sessionTakeoverNotice: {
      en: "Rakuten may allow one sign-in at a time. A sync may fail while you are signed in to the Rakuten App or another browser, and may sign the App out. This is not yet confirmed.",
      "zh-TW": "樂天國際銀行可能同一時間只允許一處登入。你在樂天 App 或其他瀏覽器登入時同步可能失敗，同步也可能讓 App 登出。此行為尚未確認。",
    },
    startUrl: LOGIN_URL,
    async run(context, input) {
      await context.event("authentication", "started", "authentication-started");
      const solve = options.solveCaptcha ?? calibratedCaptchaSolver(RAKUTEN_CAPTCHA_FAMILY);
      return open(context, input.startUrl, async (page) => {
        const captcha = await solveChallengeRound(context, solve, async () =>
          ({ image: await page.captchaImage(), charset: "alphanumeric", expectedLength: CAPTCHA_LENGTH }), 1);
        const outcome = await page.signIn({
          idNumber: input.credentials[KEY.idNumber] ?? "",
          userId: input.credentials[KEY.userId] ?? "",
          password: input.credentials[KEY.password] ?? "",
          captcha,
        });
        if (outcome.kind !== "signed-in") return signInFailure(context, outcome);
        await context.event("authentication", "completed", "authentication-completed");
        try {
          await context.event("collection", "started", "collection-started");
          const collectedAt = context.now();
          const months: Month[] = [];
          for (let back = 0; back < MONTHS; back += 1)
            months.push(monthFrom(context, await page.depositMonth(back), back === 0 ? CURRENT_MONTH_PATH : PAST_MONTH_PATH));
          const account = depositAccount(months, collectedAt);
          await context.event("collection", "completed", "collection-completed");
          return await context.preview.collect({ deposit: async () => ({ collectedAt, accounts: [account] }) });
        } finally {
          await page.signOut().catch(() => undefined);
        }
      });
    },
  };
}

export const RAKUTEN_PREVIEW_SOURCE = createRakutenSource();
