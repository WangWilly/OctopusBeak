import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { CTBC_SOURCE } from "../lib/automation/server/sources/ctbc.ts";
import {
  dialogListeners,
  DONE,
  delay,
  failure,
  INTERRUPTED,
  recordedRun,
  STARTED,
  TAKEN,
  type Assist,
} from "./sign-in-check-harness.ts";
import { signIn, SignInError } from "./sign-in.ts";
import { ctbcSignInPlan } from "./ctbc-statements.ts";

const LOGIN_URL = "https://www.ctbcbank.com/twrbc/twrbc-general/ot001/010";
const CREDENTIALS = { ctbc_user_id: "synthetic-user", ctbc_account: "synthetic-account", ctbc_password: "synthetic-password" };
const noStage: Assist = async () => assert.fail("CTBC has no Verification stage");

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser.close();
});

/**
 * CTBC's login page at its real URL: the form whose 登入 button runs `script`
 * (`show()` reveals the header logout button that marks a signed-in page,
 * `ask()` records confirm() answers, `takeover()` opens the 其他位置將會自動登出
 * prompt whose 確認登入 runs `window.afterTakeover`, `remind()` opens the
 * password-change reminder).
 */
async function withCtbc(
  script: string,
  body: (page: Page) => Promise<void>,
  options: Readonly<{ signedIn?: boolean }> = {},
): Promise<void> {
  const page = await browser.newPage();
  try {
    await page.route("https://www.ctbcbank.com/**", (route) => {
      void route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<form onsubmit="return false">
            <input type="text" /><input type="password" /><input type="password" />
            <button type="button" onclick="go()">登入</button>
          </form>
          <button id="btnHeaderLogout" type="button" ${options.signedIn ? "" : "hidden"}>登出</button>
          <div id="takeover" hidden>
            <p>您的帳號已在其他裝置使用中，繼續登入後其他位置將會自動登出</p>
            <button type="button" onclick="confirmTakeover()">確認登入</button>
          </div>
          <div id="reminder" hidden>
            <p>密碼變更提醒</p>
            <button type="button" onclick="this.parentElement.remove()">下次再提醒</button>
          </div>
          <script>
            window.answers = [];
            window.submits = 0;
            window.takeovers = 0;
            function show() { document.getElementById("btnHeaderLogout").hidden = false; }
            function ask(message) { const answer = confirm(message); answers.push(answer); return answer; }
            function takeover() { document.getElementById("takeover").hidden = false; }
            function confirmTakeover() {
              takeovers += 1;
              document.getElementById("takeover").hidden = true;
              window.afterTakeover?.();
            }
            function remind() { document.getElementById("reminder").hidden = false; }
            function go() { submits += 1; ${script} }
          </script>`,
      });
    });
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    await body(page);
  } finally {
    await page.close();
  }
}

const read = <T>(page: Page, name: string) => page.evaluate((key) => (window as unknown as Record<string, T>)[key], name);
const signInCtbc = (run: ReturnType<typeof recordedRun>, page: Page) =>
  signIn(run.context, page, CTBC_SOURCE, ctbcSignInPlan(CREDENTIALS));

test("CTBC signs in through the step, fills the form, and declares no session probe", () =>
  withCtbc("show()", async (page) => {
    const run = recordedRun(page, noStage);
    const signedIn = await signInCtbc(run, page);
    assert.deepEqual(signedIn, { usedExistingSession: false });
    assert.deepEqual(run.codes, [STARTED, DONE]);
    assert.equal(await read(page, "submits"), 1);
    assert.deepEqual(await page.locator("form input").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)), [
      CREDENTIALS.ctbc_user_id,
      CREDENTIALS.ctbc_account,
      CREDENTIALS.ctbc_password,
    ]);
  }));

test("a transient CTBC 202 is retried in the same page before the form is filled", () =>
  withCtbc("show()", async (page) => {
    const statuses: number[] = [];
    let busy = 1;
    await page.route(LOGIN_URL, (route) => {
      if (busy-- > 0) {
        statuses.push(202);
        void route.fulfill({ status: 202, contentType: "text/html", body: "<html><body></body></html>" });
      } else {
        statuses.push(200);
        void route.fallback();
      }
    });
    const run = recordedRun(page, noStage);
    await signInCtbc(run, page);
    assert.deepEqual(statuses, [202, 200]);
    assert.deepEqual(run.codes, [STARTED, DONE]);
  }));

test("an existing CTBC session skips the form", () =>
  withCtbc("", async (page) => {
    const run = recordedRun(page, noStage);
    const signedIn = await signInCtbc(run, page);
    assert.deepEqual(signedIn, { usedExistingSession: true });
    assert.deepEqual(run.codes, [STARTED, DONE]);
    assert.equal(await read(page, "submits"), 0);
    assert.equal(await page.locator("form input").first().inputValue(), "");
  }, { signedIn: true }));

test("an unknown CTBC dialog is accepted while signing in and for the rest of the page's life", () =>
  withCtbc(`if (ask("系統公告")) show()`, async (page) => {
    const run = recordedRun(page, noStage);
    await signInCtbc(run, page);
    assert.deepEqual(run.codes, [STARTED, DONE]);
    assert.deepEqual(await read(page, "answers"), [true]);
    assert.equal(dialogListeners(page), 1);
    assert.equal(await page.evaluate(() => confirm("later")), true);
  }));

test("CTBC confirms the 其他位置將會自動登出 prompt once and reports the takeover", () =>
  withCtbc("window.afterTakeover = show; takeover()", async (page) => {
    const run = recordedRun(page, noStage);
    await signInCtbc(run, page);
    assert.deepEqual(run.codes, [STARTED, TAKEN, DONE]);
    assert.equal(await read(page, "takeovers"), 1);
  }));

test("a second CTBC takeover prompt is not confirmed and ends the sign-in as an interruption", () =>
  withCtbc("window.afterTakeover = () => setTimeout(takeover, 300); takeover()", async (page) => {
    const run = recordedRun(page, noStage);
    const error = await failure(signInCtbc(run, page));
    assert.ok(error instanceof SignInError);
    assert.equal(error.reason, "takeover-repeated");
    assert.deepEqual(run.codes, [STARTED, TAKEN, INTERRUPTED]);
    assert.equal(run.classify(error), "authentication-dialog-interrupted");
    assert.equal(await read(page, "takeovers"), 1);
    assert.equal(dialogListeners(page), 0);
  }));

test("CTBC dismisses the password-change reminder with 下次再提醒 and still signs in", () =>
  withCtbc("remind(); show()", async (page) => {
    const run = recordedRun(page, noStage);
    await signInCtbc(run, page);
    assert.deepEqual(run.codes, [STARTED, DONE]);
    assert.equal(await page.locator("#reminder").count(), 0);
  }));

test("a reminder that appears just after the signed-in page is still dismissed", () =>
  withCtbc("show(); setTimeout(remind, 600)", async (page) => {
    const run = recordedRun(page, noStage);
    await signInCtbc(run, page);
    assert.deepEqual(run.codes, [STARTED, DONE]);
    assert.equal(await page.locator("#reminder").count(), 0);
  }));

test("cancelling CTBC's sign-in while the form opens or while it settles rejects with the run's reason", async () => {
  for (const at of ["fill", "poll"] as const) {
    await withCtbc("", async (page) => {
      if (at === "fill") await page.route(LOGIN_URL, (route) => void route.fulfill({ contentType: "text/html", body: "<p>載入中</p>" }));
      const run = recordedRun(page, noStage);
      const reason = new Error(`cancelled during ${at}`);
      const running = failure(signInCtbc(run, page));
      if (at === "fill") await delay(500);
      else await page.waitForFunction(() => (window as unknown as { submits: number }).submits === 1);
      run.controller.abort(reason);
      assert.equal(await running, reason, at);
      await delay(150);
      assert.deepEqual(run.codes, [STARTED], at);
      assert.equal(dialogListeners(page), 0, at);
    });
  }
});
