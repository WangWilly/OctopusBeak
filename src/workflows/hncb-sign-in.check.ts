import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { FailureCodeError } from "../lib/automation/workflow-failures.ts";
import { HNCB_SOURCE } from "../lib/automation/server/sources/hncb.ts";
import {
  ASSISTED,
  assertUsable,
  dialogListeners,
  DONE,
  FAILED,
  failure,
  leavesEmpty,
  recordedRun,
  REQUESTED,
  STARTED,
  typesAnswer,
  type Assist,
} from "./sign-in-check-harness.ts";
import { hncbSignInPlan } from "./hncb-statements.ts";
import { signIn, SignInError } from "./sign-in.ts";

const ORIGIN = "https://netbank.hncb.com.tw";
const LOGIN_URL = `${ORIGIN}/netbank/servlet/TrxDispatcher?trx=com.lb.wibc.trx.Login&state=prompt&Recognition=private`;
const SIGNED_IN_URL = `${ORIGIN}/netbank/servlet/TrxDispatcher?trx=com.lb.wibc.trx.Main`;
const CREDENTIALS = { hncb_user_id: "synthetic-user", hncb_account: "synthetic-account", hncb_password: "synthetic-password" };
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser.close();
});

const js = JSON.stringify;

/**
 * HNCB at its real URLs: the login entry shows the form whose 登入 link
 * records the account field in sessionStorage and runs `script`, or, for a
 * retained session, the signed-in page with its 登出 link. `signedIn()` opens
 * that page.
 */
async function withHncb(
  script: string,
  body: (page: Page) => Promise<void>,
  options: Readonly<{ signedIn?: boolean }> = {},
): Promise<void> {
  const page = await browser.newPage();
  try {
    await page.route(`${ORIGIN}/**`, (route) => {
      const trx = new URL(route.request().url()).searchParams.get("trx");
      const html = trx === "com.lb.wibc.trx.Login" && !options.signedIn
        ? `<input id="USERIDTEXT" /><input id="NICKNAME" /><input id="password" type="password" />
          <input id="TrxCaptchaKey" style="width: 92px; height: 32px" />
          <img id="code_Cap" src="${PIXEL}" width="80" height="30" alt="HNCB CAPTCHA" />
          <ul><li id="WannaLogin"><a href="#" onclick="go(); return false;">登入</a></li></ul>
          <script>
            function signedIn() { location.href = ${js(SIGNED_IN_URL)}; }
            function go() {
              sessionStorage.submits = JSON.stringify([...JSON.parse(sessionStorage.submits ?? "[]"), document.getElementById("NICKNAME").value]);
              ${script}
            }
          </script>`
        : `<a href="/netbank/servlet/Logout">登出</a>`;
      void route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
    });
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    await body(page);
  } finally {
    await page.close();
  }
}

const submits = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.submits ?? "[]") as string[]);
const submitted = (page: Page) => page.waitForFunction(() => sessionStorage.submits !== undefined);
const solve = typesAnswer("#TrxCaptchaKey", "1234");
const signInHncb = (run: ReturnType<typeof recordedRun>, page: Page) =>
  signIn(run.context, page, HNCB_SOURCE, hncbSignInPlan(CREDENTIALS));

test("HNCB signs in through the step and keeps its own session probe", () =>
  withHncb("signedIn()", async (page) => {
    const run = recordedRun(page, solve);
    const signedIn = await signInHncb(run, page);
    assert.equal(signedIn.usedExistingSession, false);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, DONE]);
    assert.equal(page.url(), SIGNED_IN_URL);
    assert.equal(dialogListeners(page), 0);
    assert.ok(signedIn.assertSession);
    await signedIn.assertSession();
    await page.goto(LOGIN_URL);
    const lost = await failure(signedIn.assertSession());
    assert.ok(lost instanceof FailureCodeError);
    assert.equal(lost.errorCode, "authentication-failed");
  }));

test("HNCB refills an account field cleared during assistance before submitting", () =>
  withHncb("signedIn()", async (page) => {
    const clearsAccount: Assist = async (assisted, signal) => {
      await assisted.locator("#NICKNAME").fill("");
      return solve(assisted, signal);
    };
    const run = recordedRun(page, clearsAccount);
    await signInHncb(run, page);
    assert.deepEqual(await submits(page), [CREDENTIALS.hncb_account]);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, DONE]);
  }));

test("HNCB dismisses unrecognized dialogs and keeps waiting for the signed-in page", () =>
  withHncb(`sessionStorage.answer = String(confirm("系統維護公告")); alert("系統維護中"); signedIn()`, async (page) => {
    const run = recordedRun(page, solve);
    const signedIn = await signInHncb(run, page);
    assert.equal(signedIn.usedExistingSession, false);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, DONE]);
    assert.equal(page.url(), SIGNED_IN_URL);
    assert.equal(await page.evaluate(() => sessionStorage.answer), "false");
    await assertUsable(page);
  }));

test("cancelling HNCB while it waits for the signed-in page ends the sign-in at once", () =>
  withHncb("", async (page) => {
    const run = recordedRun(page, solve);
    const pending = signInHncb(run, page);
    await submitted(page);
    const reason = new Error("cancelled by the person");
    const cancelledAt = Date.now();
    run.controller.abort(reason);
    const error = await failure(pending);
    assert.equal(error, reason);
    assert.ok(Date.now() - cancelledAt < 1_000, "the sign-in ended within a second of cancellation");
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED]);
    assert.equal(run.classify(error), "cancelled");
    assert.equal(dialogListeners(page), 0);
  }));

test("an existing HNCB session skips the form and the stage", () =>
  withHncb("", async (page) => {
    const run = recordedRun(page, solve);
    const signedIn = await signInHncb(run, page);
    assert.equal(signedIn.usedExistingSession, true);
    assert.deepEqual(run.codes, [STARTED, DONE]);
    assert.equal(dialogListeners(page), 0);
  }, { signedIn: true }));

test("an empty HNCB CAPTCHA answer fails before the form is submitted", () =>
  withHncb("signedIn()", async (page) => {
    const run = recordedRun(page, leavesEmpty);
    const error = await failure(signInHncb(run, page));
    assert.ok(error instanceof SignInError);
    assert.equal(error.reason, "answer-missing");
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, FAILED]);
    assert.deepEqual(await submits(page), []);
  }));

test("HNCB declares no Session takeover and no rejection evidence", () => {
  assert.equal(HNCB_SOURCE.sessionTakeover, undefined);
  assert.equal(HNCB_SOURCE.workflow.verification?.rejection, undefined);
});
