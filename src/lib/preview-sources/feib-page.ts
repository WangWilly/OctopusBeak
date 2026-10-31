import type { Page, Request, Response } from "playwright";
import { decodeImageToPng } from "./browser-http.ts";
import type { FeibCapture, FeibPageOpener, FeibSignInOutcome } from "./feib-source.ts";
import { fail } from "./source-kit.ts";

const ORIGIN = "https://ebank.feib.com.tw";
export const FEIB_LOGIN_URL = `${ORIGIN}/netbank/html/pages/jsp/Logon/mainIndex6.jsp?loginpage=new`;
const DISPATCHER_PATH = "/netbank/servlet/TrxDispatcher";
const DISPATCHER = `${ORIGIN}${DISPATCHER_PATH}`;
const OVERVIEW_URL = `${DISPATCHER}?trx=com.lb.wibc.trx.Login&state=loginAFT&lgstatus=saving&menu_id=2-1-1`;
// Without default_acc_submit=1, so the menu link opens the query form without querying an account.
const QUERY_URL = `${DISPATCHER}?trx=com.lb.wibc.trx.SavAcctTxDtlInq&state=prompt&menu_id=2-1-3`;
// The reminder page's own 「下次登入再變更」 target. 「不變更」 (state=fix) would change the person's reminder setting.
const POSTPONE_URL = `${DISPATCHER}?trx=com.lb.wibc.trx.Login&state=loginAFT&lgstatus=total&menu_id=1-1-1`;
const LOGOUT_URL = `${DISPATCHER}?trx=com.lb.wibc.trx.Logout&state=verifyCard`;
const LOGIN_PATHS = ["/netbank/html/pages/jsp/Logon/", "/netbank/html/pages/indexNew.jsp"];
const PASSWORD_CHANGE_PATH = "/netbank/html/pages/jsp/SSLPwdChng/";
const CAPTCHA_PATH = /VerifyCodeServlet/iu;
const LOGOUT_LINK = 'a[href*="com.lb.wibc.trx.Logout"]';
const SIGNED_IN = /com\.lb\.wibc\.trx\.Logout/u;
// The personal tab's fields carry these names only while that tab is active.
const FIELDS = [
  { selector: "#cid0", name: "CUSTID", value: "idNumber" },
  { selector: "#uid0", name: "USERID", value: "userCode" },
  { selector: "#pad0", name: "LGNPWD", value: "password" },
  { selector: "#VERCODE0", name: null, value: "captcha" },
] as const;
const CAPTCHA_AREA = "vercode0area";
const PAGE_WAIT_MS = 30_000;
const SUBMIT_WAIT_MS = 20_000;
const OUTCOME_WAIT_MS = 45_000;
const OUTCOME_SETTLE_MS = 3_000;
const POLL_MS = 300;

type Seen = { captcha: Promise<Buffer | null> | null; loginPosts: number; readonly dialogs: string[] };

const pathOf = (url: string) => new URL(url).pathname;

/** The login POST is the only TrxDispatcher POST whose body says state=login; the CAPTCHA pre-check is a separate ajax call. */
const isLoginPost = (request: Request) =>
  request.method() === "POST" && pathOf(request.url()) === DISPATCHER_PATH && /(?:^|&)state=login(?:&|$)/u.test(request.postData() ?? "");

const isHistoryPost = (response: Response) =>
  response.request().method() === "POST" && pathOf(response.url()) === DISPATCHER_PATH
  && /(?:^|&)trx=com\.lb\.wibc\.trx\.SavAcctTxDtlInq(?:&|$)/u.test(response.request().postData() ?? "");

async function capture(response: Response | null, what: string): Promise<FeibCapture> {
  if (!response) return fail("unexpected-response", `${what} loaded no document`);
  const text = await response.text().catch(() => fail("unexpected-response", `${what} body was not readable`));
  return { status: response.status(), date: response.headers().date ?? null, text };
}

const open = async (page: Page, url: string, what: string) =>
  capture(await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_WAIT_MS }).catch(() => null), what);

async function waitForDialog(page: Page, seen: Seen, deadline: number): Promise<"dialog" | null> {
  while (Date.now() < deadline) {
    if (seen.dialogs.length > 0) return "dialog";
    await page.waitForTimeout(POLL_MS);
  }
  return null;
}

/** After the login POST: the signed-in page, the password-change reminder, or the message shown instead. */
async function signInOutcome(page: Page, seen: Seen): Promise<FeibSignInOutcome> {
  const deadline = Date.now() + OUTCOME_WAIT_MS;
  let settledSince: number | null = null;
  while (Date.now() < deadline) {
    const path = pathOf(page.url());
    if (!LOGIN_PATHS.some((prefix) => path.startsWith(prefix))) {
      const state = await page.evaluate((link) => ({
        ready: document.readyState === "complete",
        signedIn: document.querySelector(link) !== null,
        text: [...document.querySelectorAll(".inp-error-txt")].map((element) => element.textContent ?? "").join(" ")
          + ` ${(document.body?.innerText ?? "").slice(0, 4_000)}`,
      }), LOGOUT_LINK).catch(() => null);
      if (state?.signedIn) return { kind: path.startsWith(PASSWORD_CHANGE_PATH) ? "password-change-prompt" : "signed-in" };
      if (state?.ready) {
        settledSince ??= Date.now();
        if (Date.now() - settledSince >= OUTCOME_SETTLE_MS) return { kind: "refused", message: [...seen.dialogs, state.text].join(" ") };
      } else {
        settledSince = null;
      }
    }
    await page.waitForTimeout(POLL_MS);
  }
  return seen.dialogs.length > 0 ? { kind: "refused", message: seen.dialogs.join(" ") } : { kind: "no-outcome" };
}

/**
 * Unverified against the live site: selectors and flow follow all-set-tw's
 * FEIB connector and the public login page.
 */
export const playwrightFeibPage: FeibPageOpener = (context, startUrl, use) =>
  context.browser.withPage(async (page) => {
    const seen: Seen = { captcha: null, loginPosts: 0, dialogs: [] };
    page.on("dialog", (dialog) => {
      seen.dialogs.push(dialog.message());
      // Never confirm on the person's behalf.
      void (dialog.type() === "alert" ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
    });
    page.on("request", (request) => {
      if (isLoginPost(request)) seen.loginPosts += 1;
    });
    page.on("response", (response) => {
      if (new URL(response.url()).origin === ORIGIN && CAPTCHA_PATH.test(response.url()) && response.status() === 200)
        seen.captcha = response.body().catch(() => null);
    });
    await page.goto(startUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    return use({
      async captchaImage() {
        await page.waitForFunction(({ selectors, image }) => selectors.every((selector) => document.querySelector(selector) !== null)
          && (document.querySelector<HTMLImageElement>(image)?.complete ?? false),
        { selectors: [...FIELDS.map((field) => field.selector), "#submitbtn"], image: `#${CAPTCHA_AREA} img[data-role="vercode"]` },
        { timeout: PAGE_WAIT_MS }).catch(() => fail("unexpected-response", "the login page shows no login form"));
        const bytes = await seen.captcha ?? fail("unexpected-response", "the CAPTCHA image response was not observed");
        return decodeImageToPng(page, bytes).catch(() => fail("unexpected-response", "the CAPTCHA is not a decodable image"));
      },
      async signIn(credentials) {
        const filled = await page.evaluate(({ fields, values }) => {
          const inputs = fields.map((field) => [document.querySelector<HTMLInputElement>(field.selector), field] as const);
          if (inputs.some(([input, field]) => !input || (field.name !== null && input.getAttribute("name") !== field.name))) return false;
          for (const [input, field] of inputs) {
            input!.value = values[field.value];
            input!.dispatchEvent(new Event("input", { bubbles: true }));
            input!.dispatchEvent(new Event("change", { bubbles: true }));
          }
          return true;
        }, { fields: FIELDS, values: credentials });
        if (!filled) return fail("unexpected-response", "the login form fields were not found");
        seen.dialogs.length = 0;
        const posts = seen.loginPosts;
        // The submit handler pre-checks the CAPTCHA with a synchronous ajax call, so the click runs after evaluate returns.
        await page.evaluate(() => {
          const flag = window as Window & { feibSubmitDone?: boolean };
          flag.feibSubmitDone = false;
          for (const element of document.querySelectorAll(".inp-error")) element.classList.remove("inp-error");
          setTimeout(() => {
            document.querySelector<HTMLElement>("#submitbtn")?.click();
            flag.feibSubmitDone = true;
          }, 0);
        });
        const deadline = Date.now() + SUBMIT_WAIT_MS;
        while (seen.loginPosts === posts) {
          if (Date.now() >= deadline) return fail("unexpected-response", "the login page sent no sign-in request");
          const flagged = await page.evaluate(() => (window as Window & { feibSubmitDone?: boolean }).feibSubmitDone
            ? [...document.querySelectorAll(".inp-error")].map((element) => element.id).filter(Boolean)
            : []).catch(() => []);
          if (seen.loginPosts !== posts) break;
          if (flagged.length > 0) return { kind: flagged.every((id) => id === CAPTCHA_AREA) ? "captcha-rejected" : "fields-rejected" };
          await page.waitForTimeout(POLL_MS);
        }
        return signInOutcome(page, seen);
      },
      async postponePasswordChange() {
        await open(page, POSTPONE_URL, "the password-change postponement");
        return !pathOf(page.url()).startsWith(PASSWORD_CHANGE_PATH)
          && await page.evaluate((link) => document.querySelector(link) !== null, LOGOUT_LINK).catch(() => false);
      },
      depositOverview: () => open(page, OVERVIEW_URL, "the deposit overview"),
      async transactions(accountNo, range) {
        const prompt = await open(page, QUERY_URL, "the transaction query");
        if (prompt.status !== 200 || !SIGNED_IN.test(prompt.text)) return prompt;
        const state = await page.evaluate(({ account, start, end }) => {
          const select = document.querySelector<HTMLSelectElement>("#acct");
          const startInput = document.querySelector<HTMLInputElement>('input[name="sdate"]');
          const endInput = document.querySelector<HTMLInputElement>('input[name="edate"]');
          const check = document.querySelector<HTMLInputElement>('#inqForm input[name="check"]');
          const bank = window as Window & { checkData?: unknown; jQuery?: (element: unknown) => { change(): void } };
          if (!select || !startInput || !endInput || !check || typeof bank.checkData !== "function") return "form-changed";
          const option = [...select.options].find((candidate) => candidate.value.replace(/\D/gu, "") === account);
          if (!option) return "no-account";
          select.value = option.value;
          // The bank's change handler rebuilds the currency select for the account.
          if (bank.jQuery) bank.jQuery(select).change();
          else select.dispatchEvent(new Event("change", { bubbles: true }));
          const currency = document.querySelector<HTMLSelectElement>("#ccycd");
          if (currency) currency.value = "00";
          startInput.value = start;
          endInput.value = end;
          check.value = "false";
          return "ready";
        }, { account: accountNo, ...range });
        if (state === "no-account") return fail("unexpected-response", "the transaction query does not list an overview account");
        if (state !== "ready") return fail("unexpected-response", "the transaction query form changed");
        seen.dialogs.length = 0;
        const deadline = Date.now() + PAGE_WAIT_MS;
        const response = page.waitForResponse(isHistoryPost, { timeout: PAGE_WAIT_MS }).catch(() => null);
        await page.evaluate(() => {
          setTimeout(() => (window as Window & { checkData?: (mode: string) => void }).checkData?.("A"), 0);
        });
        const answer = await Promise.race([response, waitForDialog(page, seen, deadline)]);
        if (answer === "dialog") return fail("unexpected-response", "the transaction query was refused by the page's own check");
        return capture(answer, "the transaction query result");
      },
      async signOut() {
        await page.goto(LOGOUT_URL, { waitUntil: "domcontentloaded", timeout: PAGE_WAIT_MS }).catch(() => undefined);
      },
    });
  });
