import type { Frame, Page, Response } from "playwright";
import { decodeImageToPng } from "./browser-http.ts";
import type { FirstbankCapture, FirstbankCardPages, FirstbankPageOpener, FirstbankQueryAccount, FirstbankSignInOutcome } from "./firstbank-source.ts";
import { fail } from "./source-kit.ts";

const ORIGIN = "https://ibank.firstbank.com.tw";
export const FIRSTBANK_LOGIN_URL = `${ORIGIN}/NetBank/index103.html`;
const OVERVIEW_URL = `${ORIGIN}/NetBank/1/acntReviewAll.html`;
const QUERY_URL = `${ORIGIN}/NetBank/2/0101.html`;
const FRAMESET_URL = `${ORIGIN}/NetBank/frame.html`;
const CARD_HOME_URL = `${ORIGIN}/NetBank/1/01.jsp`;
const CAPTCHA_PATH = "/netbank/code_verify1.jpg";
const OVERVIEW_PATH = /^\/netbank\/ajax\/acntreview1\.html$/u;
const HISTORY_PATH = /^\/netbank\/2\/010103(?:\.html?)?$/u;
const FRAMESET_PATH = /^\/netbank\/frame\.html$/u;
const CARD_HOME_PATH = /^\/netbank\/1\/01\.jsp$/u;
const CARD_QUERY_PATH = /^\/cmsweb\/common\/sendcmsqry\d{4}$/u;
const CARD_MEMBER_LOGOUT_PATH = /^\/cmsweb\/home\/logout$/u;
const BILL_DATES_PATH = /^\/cmsweb\/common\/sendcmsqry9999$/u;
// The service overview's own links: 帳單查詢 (F1632), 近期繳款 (F1633), 未出帳消費 (F1634).
const CARD_FUNCTIONS = [
  { func: "F1632", path: /^\/cmsweb\/common\/sendcmsqry0014$/u },
  { func: "F1633", path: /^\/cmsweb\/common\/sendcmsqry0006$/u },
  { func: "F1634", path: /^\/cmsweb\/common\/sendcmsqry0008$/u },
] as const;
const SIGNED_IN_MARKER = "#btnOpen, #tFunc";
const DEPOSIT_TRIGGER = "#btnOpen a, #overview-account a[onclick*=\"chgAcntReviewType('1')\"], a[href=\"#tab1\"]";
const QUERY_SELECT = 'select[name="acnt"]';
const POLL_MS = 250;
const PAGE_WAIT_MS = 20_000;
const SIGN_IN_WAIT_MS = 20_000;
const AUTO_LOAD_GRACE_MS = 2_000;
const CAPTURE_WAIT_MS = 30_000;
const LOGOUT_SETTLE_MS = 2_000;
// all-set-tw's recorder saw a little over 11 seconds from the card bridge page to CMSQRY0014.
const CARD_WAIT_MS = 30_000;
// After an empty CMSQRY9999 bill-date list the page sends no CMSQRY0014; a late one still gets this long.
const BILL_AFTER_DATES_MS = 5_000;
// all-set-tw merges several CMSQRY0006 responses, so later ones may still arrive after the last function answered.
const CARD_SETTLE_MS = 1_500;

type Recorded = Readonly<{ path: string; capture: Promise<FirstbankCapture | null> }>;

const lowerPath = (url: string) => new URL(url).pathname.split(";")[0]!.toLowerCase();
const isCardPath = (path: string) => CARD_QUERY_PATH.test(path) || CARD_MEMBER_LOGOUT_PATH.test(path);
// all-set-tw does not document the card member system's host, so card paths are accepted from any First Bank https host.
const isFirstbankHost = (url: URL) => url.protocol === "https:" && (url.hostname === "firstbank.com.tw" || url.hostname.endsWith(".firstbank.com.tw"));

function recordResponses(page: Page): { entries: Recorded[]; captcha: () => Promise<Buffer | null> | null } {
  const entries: Recorded[] = [];
  let captcha: Promise<Buffer | null> | null = null;
  page.on("response", (response: Response) => {
    const url = new URL(response.url());
    const path = lowerPath(response.url());
    if (url.origin !== ORIGIN && !(isFirstbankHost(url) && isCardPath(path))) return;
    if (path === CAPTCHA_PATH && response.status() === 200) {
      captcha = response.body().catch(() => null);
      return;
    }
    if (!OVERVIEW_PATH.test(path) && !HISTORY_PATH.test(path) && !isCardPath(path)) return;
    entries.push({
      path,
      capture: response.text().then(
        (text) => ({ endpoint: new URL(response.url()).pathname, status: response.status(), date: response.headers().date ?? null, text }),
        () => null,
      ),
    });
  });
  return { entries, captcha: () => captcha };
}

async function waitForCapture(page: Page, entries: readonly Recorded[], path: RegExp, after: number, timeout: number): Promise<FirstbankCapture | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const entry = entries.slice(after).find((candidate) => path.test(candidate.path));
    if (entry) return (await entry.capture) ?? fail("unexpected-response", `the ${entry.path} body was not readable`);
    await page.waitForTimeout(POLL_MS);
  }
  return null;
}

const framePath = (frame: Frame) => {
  try {
    return lowerPath(frame.url());
  } catch {
    return "";
  }
};

async function frameWhere(page: Page, test: (frame: Frame) => Promise<boolean>, timeout: number): Promise<Frame | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (!frame.isDetached() && await test(frame).catch(() => false)) return frame;
    }
    await page.waitForTimeout(POLL_MS);
  }
  return null;
}

const hasSelector = (selector: string) => async (frame: Frame) => (await frame.$(selector)) !== null;

async function signedIn(page: Page): Promise<boolean> {
  if (page.frames().some((frame) => FRAMESET_PATH.test(framePath(frame)))) return true;
  return (await frameWhere(page, hasSelector(SIGNED_IN_MARKER), 1)) !== null;
}

/** The frame that shows function pages: the signed-in home frame, or the first nested frame when the marker is on the top page. */
async function homeFrame(page: Page): Promise<Frame> {
  const marked = await frameWhere(page, hasSelector(SIGNED_IN_MARKER), PAGE_WAIT_MS) ?? fail("unexpected-response", "the signed-in page did not load");
  if (marked !== page.mainFrame()) return marked;
  return page.frames().find((frame) => frame !== marked && !frame.isDetached()) ?? marked;
}

async function openInFrame(page: Page, frame: Frame, url: string, path: RegExp, ready: string): Promise<Frame> {
  await frame.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_WAIT_MS }).catch(() => undefined);
  const target = await frameWhere(page, async (candidate) => path.test(framePath(candidate)) && await hasSelector(ready)(candidate), PAGE_WAIT_MS);
  return target ?? fail("unexpected-response", `${new URL(url).pathname} did not load`);
}

/** Visible popups the bank opens over the login page or a function page. */
async function popupMessage(page: Page): Promise<string | null> {
  for (const frame of page.frames()) {
    const message = await frame.evaluate(() => {
      const popup = document.querySelector<HTMLElement>("#login-msg");
      if (!popup || getComputedStyle(popup).display === "none" || popup.getBoundingClientRect().height <= 0) return "";
      return (popup.querySelector<HTMLElement>(".pop-content")?.innerText ?? "").replace(/\s+/gu, " ").trim();
    }).catch(() => "");
    if (message) return message;
  }
  return null;
}

async function bodyHas(page: Page, pattern: RegExp): Promise<boolean> {
  for (const frame of page.frames()) {
    const text = await frame.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    if (pattern.test(text)) return true;
  }
  return false;
}

/**
 * Clicks the bank's own sign-in notices: 仍要登入 for the maintenance window, 我是本人 for the
 * public-IP check, and 下次再說 for update reminders. None of them signs out another session.
 */
async function answerSignInNotices(page: Page): Promise<void> {
  for (const frame of page.frames()) {
    await frame.evaluate(() => {
      const visible = (element: HTMLElement | null): element is HTMLElement =>
        element !== null && getComputedStyle(element).display !== "none" && element.getBoundingClientRect().height > 0;
      for (const selector of ["#isLogIn", "#isMe", "#z7UpdateNoticePersonMsg a.btn-cancel"]) {
        const element = document.querySelector<HTMLElement>(selector);
        if (visible(element)) element.click();
      }
    }).catch(() => undefined);
  }
}

async function dismissNotices(frame: Frame): Promise<void> {
  await frame.evaluate(() => {
    const notice = [...document.querySelectorAll<HTMLElement>("#alertMsg a, div.mm-show a, a.btn-cancel, a.btn-ok")]
      .find((element) => getComputedStyle(element).display !== "none" && /我知道了|下次再說|關閉/u.test(element.innerText.replace(/\s+/gu, "")));
    notice?.click();
  }).catch(() => undefined);
}

async function typeInto(page: Page, selector: string, value: string): Promise<void> {
  const input = page.locator(selector);
  await input.fill("");
  await input.pressSequentially(value, { delay: 15 });
}

/** The login button is an image map whose area coordinates the page fills in after load. */
async function clickLoginArea(page: Page): Promise<void> {
  const handle = await page.waitForFunction(() => {
    const image = document.querySelector<HTMLImageElement>("#captchaLoginArea");
    const coords = (document.querySelector<HTMLAreaElement>('map[name="loginMap"] area')?.coords ?? "").split(",").map(Number);
    const [left = NaN, top = NaN, right = NaN, bottom = NaN] = coords;
    if (!image?.complete || image.naturalWidth <= 0 || !(right > left && bottom > top)) return null;
    const rect = image.getBoundingClientRect();
    return {
      x: rect.left + ((left + right) / 2 / image.naturalWidth) * rect.width,
      y: rect.top + ((top + bottom) / 2 / image.naturalHeight) * rect.height,
    };
  }, undefined, { timeout: PAGE_WAIT_MS }).catch(() => fail("unexpected-response", "the login button area did not load"));
  const point = await handle.jsonValue() as { x: number; y: number };
  await handle.dispose();
  await page.mouse.click(point.x, point.y);
}

const isMenuRuntime = () => typeof (window as Window & { getMenuObjById?: unknown }).getMenuObjById === "function";

/** Card functions need the signed-in frameset's menu runtime (all-set-tw); a lost frameset is reloaded, never the login page. */
async function ensureFrameset(page: Page): Promise<void> {
  if (await page.evaluate(isMenuRuntime).catch(() => false)) return;
  await page.goto(FRAMESET_URL, { waitUntil: "domcontentloaded", timeout: PAGE_WAIT_MS }).catch(() => undefined);
  await page.waitForFunction(isMenuRuntime, undefined, { timeout: PAGE_WAIT_MS })
    .catch(() => fail("unexpected-response", "the signed-in frameset did not load for the card functions"));
}

type CardHome = Readonly<{ frame: Frame; notice: null }> | Readonly<{ frame: null; notice: string }>;

/** The service overview with all three card links, or the message it shows instead of them. */
async function cardHome(page: Page, content: Frame): Promise<CardHome> {
  await content.goto(CARD_HOME_URL, { waitUntil: "domcontentloaded", timeout: PAGE_WAIT_MS }).catch(() => undefined);
  const funcs = CARD_FUNCTIONS.map(({ func }) => func);
  const deadline = Date.now() + PAGE_WAIT_MS;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (frame.isDetached() || frame === page.mainFrame() || !CARD_HOME_PATH.test(framePath(frame))) continue;
      const state = await frame.evaluate((wanted) => ({
        links: wanted.every((func) => document.querySelector(`a[data-func="${func}"]`) !== null),
        notice: [...document.querySelectorAll<HTMLElement>("#alertMsgContent, [role='alert']")]
          .filter((element) => element.getClientRects().length > 0)
          .map((element) => element.innerText.replace(/\s+/gu, " ").trim())
          .find((text) => text !== "") ?? null,
      }), funcs).catch(() => null);
      if (state?.links) return { frame, notice: null };
      if (state?.notice) return { frame: null, notice: state.notice };
    }
    await page.waitForTimeout(POLL_MS);
  }
  return fail("unexpected-response", "the card service overview did not show its card functions");
}

/**
 * Unverified against the live site: selectors and flow follow all-set-tw's
 * First Bank connector (commit f05dd30) and the public login page.
 */
export const playwrightFirstbankPage: FirstbankPageOpener = (context, startUrl, use) =>
  context.browser.withPage(async (page) => {
    let dialogMessage: string | null = null;
    page.on("dialog", (dialog) => {
      dialogMessage = dialog.message();
      // Never confirm on the user's behalf, such as "sign out the other session and continue?".
      void (dialog.type() === "alert" ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
    });
    const responses = recordResponses(page);
    let content: Frame | null = null;
    const contentFrame = async () => (content !== null && !content.isDetached() ? content : (content = await homeFrame(page)));
    await page.goto(startUrl, { waitUntil: "domcontentloaded" });
    return use({
      async captchaImage() {
        await page.waitForFunction(() => {
          const image = document.querySelector<HTMLImageElement>("#code_verify");
          return Boolean(image?.complete && image.naturalWidth > 0);
        }, undefined, { timeout: PAGE_WAIT_MS }).catch(() => fail("unexpected-response", "the login page shows no CAPTCHA image"));
        const bytes = await responses.captcha();
        if (!bytes) return fail("unexpected-response", "the CAPTCHA image response was not observed");
        return decodeImageToPng(page, bytes).catch(() => fail("unexpected-response", "the CAPTCHA is not a decodable image"));
      },
      async signIn(credentials): Promise<FirstbankSignInOutcome> {
        await typeInto(page, "#loginCustIdFake", credentials.idNumber);
        await typeInto(page, "#usrIdInput", credentials.userCode);
        await typeInto(page, "#pwd", credentials.password);
        await typeInto(page, "#vrfyCode", credentials.captcha);
        dialogMessage = null;
        await clickLoginArea(page);
        const deadline = Date.now() + SIGN_IN_WAIT_MS;
        while (Date.now() < deadline) {
          if (await bodyHas(page, /MULTI_SESSION_LOGIN/u)) return { kind: "refused", message: "MULTI_SESSION_LOGIN" };
          if (await signedIn(page)) return { kind: "signed-in" };
          const message = dialogMessage ?? await popupMessage(page);
          if (message) return { kind: "refused", message };
          await answerSignInNotices(page);
          await page.waitForTimeout(POLL_MS);
        }
        return { kind: "no-outcome" };
      },
      async depositOverview() {
        const before = responses.entries.length;
        const frame = await openInFrame(page, await contentFrame(), OVERVIEW_URL, /^\/netbank\/1\/acntreviewall\.html$/u, "body");
        const loaded = await waitForCapture(page, responses.entries, OVERVIEW_PATH, before, AUTO_LOAD_GRACE_MS);
        if (loaded) return loaded;
        await dismissNotices(frame);
        const trigger = frame.locator(DEPOSIT_TRIGGER).first();
        if (await trigger.count() === 0) return fail("unexpected-response", "the deposit overview has no deposit tab");
        await trigger.click();
        return await waitForCapture(page, responses.entries, OVERVIEW_PATH, before, CAPTURE_WAIT_MS)
          ?? fail("unexpected-response", "no acntReview1 response");
      },
      async queryAccounts(): Promise<readonly FirstbankQueryAccount[]> {
        const frame = await openInFrame(page, await contentFrame(), QUERY_URL, /^\/netbank\/2\/0101\.html$/u, QUERY_SELECT);
        await dismissNotices(frame);
        return frame.$$eval(`${QUERY_SELECT} option`, (options) => options
          .map((option) => ({ value: (option as HTMLOptionElement).value.trim(), label: (option.textContent ?? "").replace(/\s+/gu, " ").trim() }))
          .filter((option) => option.value !== "" && option.value !== "0" && !/請選擇|選擇帳號|please\s*select|select\s*account|^-+$/iu.test(option.label)));
      },
      async transactions(account, range) {
        const frame = await openInFrame(page, await contentFrame(), QUERY_URL, /^\/netbank\/2\/0101\.html$/u, QUERY_SELECT);
        await dismissNotices(frame);
        const filled = await frame.evaluate(({ start, end }) => {
          const set = (selector: string, value: string) => {
            const input = document.querySelector<HTMLInputElement>(selector);
            if (!input) return false;
            input.value = value;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
          };
          return set("#txnStart, [name=txnStart]", start) && set("#txnEnd, [name=txnEnd]", end);
        }, range);
        if (!filled) return fail("unexpected-response", "the transaction query has no date range inputs");
        const selected = await frame.selectOption(QUERY_SELECT, account.value);
        if (!selected.includes(account.value)) return fail("unexpected-response", "the transaction query account could not be selected");
        const before = responses.entries.length;
        // The search handler sends a synchronous verifyDV request, so the click is queued for after evaluate returns.
        const submitted = await frame.evaluate(() => {
          const search = document.querySelector<HTMLElement>("#searchBtn, input[name=showList]");
          if (search) setTimeout(() => search.click(), 0);
          return search !== null;
        });
        if (!submitted) return fail("unexpected-response", "the transaction query has no search button");
        return await waitForCapture(page, responses.entries, HISTORY_PATH, before, CAPTURE_WAIT_MS)
          ?? fail("unexpected-response", "no 010103 response");
      },
      async cardPages(): Promise<FirstbankCardPages> {
        const first = responses.entries.length;
        const cardEntries = () => responses.entries.slice(first).filter((entry) => isCardPath(entry.path));
        const memberLoggedOut = () => cardEntries().some((entry) => CARD_MEMBER_LOGOUT_PATH.test(entry.path));
        dialogMessage = null;
        let notice: string | null = null;
        await ensureFrameset(page);
        for (const { func, path } of CARD_FUNCTIONS) {
          const home = await cardHome(page, await contentFrame());
          if (home.notice !== null) {
            notice = home.notice;
            break;
          }
          const start = responses.entries.length;
          // The bank's handler may navigate the frame away mid-evaluate; the query it started is still awaited, never clicked twice.
          const clicked = await home.frame.evaluate((wanted) => {
            const link = document.querySelector<HTMLElement>(`a[data-func="${wanted}"]`);
            if (link) setTimeout(() => link.click(), 0);
            return link !== null;
          }, func).catch(() => true);
          if (!clicked) return fail("unexpected-response", `the card function ${func} is missing`);
          const answer = await cardAnswer(start, path, func === "F1632");
          if (answer === "stopped") break;
          if (answer === "timeout") return fail("incomplete-data", `the card function ${func} loaded no response`);
        }
        let seen = -1;
        while (seen !== cardEntries().length) {
          seen = cardEntries().length;
          await page.waitForTimeout(CARD_SETTLE_MS);
        }
        const captures = await Promise.all(cardEntries().map(async (entry) =>
          (await entry.capture) ?? fail("unexpected-response", `the ${entry.path} body was not readable`)));
        return { captures, notice: notice ?? dialogMessage };

        async function cardAnswer(start: number, path: RegExp, bill: boolean): Promise<"answered" | "stopped" | "timeout"> {
          const deadline = Date.now() + CARD_WAIT_MS;
          let datesAt: number | null = null;
          while (Date.now() < deadline) {
            const arrived = responses.entries.slice(start);
            if (arrived.some((entry) => path.test(entry.path))) return "answered";
            if (dialogMessage !== null || memberLoggedOut()) return "stopped";
            if (bill && datesAt === null && arrived.some((entry) => BILL_DATES_PATH.test(entry.path))) datesAt = Date.now();
            if (datesAt !== null && Date.now() - datesAt >= BILL_AFTER_DATES_MS) return "answered";
            await page.waitForTimeout(POLL_MS);
          }
          return "timeout";
        }
      },
      async signOut() {
        const frameset = page.frames().find((frame) => FRAMESET_PATH.test(framePath(frame)));
        if (!frameset) return;
        const invoked = await frameset.evaluate(() => {
          const logout = (window as Window & { logout?: () => void }).logout;
          if (typeof logout !== "function") return false;
          logout();
          return true;
        }).catch(() => false);
        if (invoked) await page.waitForTimeout(LOGOUT_SETTLE_MS);
      },
    });
  });
