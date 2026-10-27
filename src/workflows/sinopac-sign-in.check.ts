import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { CaptchaProviderRejectedError } from "../lib/automation/captcha-rejection.ts";
import { FailureCodeError } from "../lib/automation/workflow-failures.ts";
import { SINOPAC_SOURCE } from "../lib/automation/server/sources/sinopac.ts";
import { matchesRejectionDialog, matchesTakeoverDialog } from "../lib/automation/sign-in-prompt.ts";
import { SINOPAC_CAPTCHA_INPUT_SELECTOR } from "../lib/automation/sinopac-captcha.ts";
import { SourceUnavailableError } from "../lib/automation/source-access.ts";
import {
  ASSISTED,
  assertUsable,
  dialogListeners,
  DONE,
  FAILED,
  failure,
  INTERRUPTED,
  leavesEmpty,
  recordedRun,
  REJECTION,
  REQUESTED,
  STARTED,
  TAKEN,
  typesAnswer,
} from "./sign-in-check-harness.ts";
import { signIn, SignInError } from "./sign-in.ts";
import { SINOPAC_LOGIN_URL, sinopacSignInPlan } from "./sinopac-statements.ts";

const DUPLICATE = "您可能重複登入，或上次的使用未依照正常程序登出，如確定登入，系統將強制關閉他處登入狀態。";
const REJECTED = "驗證碼失效或輸入錯誤，請重新輸入。";
const SIGNED_IN_URL = "https://mma.sinopac.com/mma/bank/home.aspx";
const SERVICE_ERROR_URL = "https://mma.sinopac.com/Errors/GenericErrorPage.aspx";
const CREDENTIALS = { sinopac_user_id: "synthetic-user", sinopac_account: "synthetic-account", sinopac_password: "synthetic-password" };
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
 * MMA served at its real URLs: the login form whose button runs `script`
 * (`signedIn()` navigates to the signed-in page, `ask()` records confirm()
 * answers), the signed-in page with its logout link and, when asked, the
 * password-expiry notice, and the generic error page.
 */
async function withSinopac(
  script: string,
  body: (page: Page) => Promise<void>,
  options: Readonly<{ startAt?: string; passwordExpiryNotice?: boolean }> = {},
): Promise<void> {
  const page = await browser.newPage();
  try {
    await page.route("https://mma.sinopac.com/**", (route) => {
      const { pathname } = new URL(route.request().url());
      const html = pathname === "/MemberPortal/Member/MMALogin.aspx"
        ? `<form id="aspnetForm">
            <input class="selectable" /><input class="selectable" /><input class="selectable" type="password" />
            <input id="ctl00_sino_keyword3" /><img id="imgCode" width="120" height="40" src="${PIXEL}" />
            <input id="MMA_Login" type="button" value="登入" onclick="go()" />
          </form>
          <script>
            window.answers = [];
            function ask(message) { const answer = confirm(message); answers.push(answer); return answer; }
            function signedIn() { location.href = ${js(SIGNED_IN_URL)}; }
            function go() { ${script} }
          </script>`
        : pathname === "/Errors/GenericErrorPage.aspx"
          ? "本功能暫時無法提供服務，請稍後再試 !"
          : `<a id="user-logout" href="/MemberPortal/Member/MMALogout.aspx">登出</a>
            ${options.passwordExpiryNotice ? `<a id="notice" href="#" onclick="this.remove(); return false;">延用舊密碼</a>` : ""}`;
      void route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
    });
    await page.goto(options.startAt ?? SINOPAC_LOGIN_URL, { waitUntil: "domcontentloaded" });
    await body(page);
  } finally {
    await page.close();
  }
}

const answers = (page: Page) => page.evaluate(() => (window as unknown as { answers: boolean[] }).answers);
const solve = typesAnswer(SINOPAC_CAPTCHA_INPUT_SELECTOR, "123456");

test("SinoPac signs in through the step and keeps its own session probe", () =>
  withSinopac("signedIn()", async (page) => {
    const run = recordedRun(page, solve);
    const signedIn = await signIn(run.context, page, SINOPAC_SOURCE, sinopacSignInPlan(CREDENTIALS));
    assert.equal(signedIn.usedExistingSession, false);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, DONE]);
    assert.equal(page.url(), SIGNED_IN_URL);
    assert.ok(signedIn.assertSession);
    await signedIn.assertSession();
    await page.goto(SINOPAC_LOGIN_URL);
    const lost = await failure(signedIn.assertSession());
    assert.ok(lost instanceof FailureCodeError);
    assert.equal(lost.errorCode, "authentication-failed");
    assert.equal(dialogListeners(page), 0);
  }));

test("SinoPac confirms the duplicate sign-in prompt once and reports the takeover", () =>
  withSinopac(`if (ask(${js(DUPLICATE)})) signedIn()`, async (page) => {
    const run = recordedRun(page, solve);
    await signIn(run.context, page, SINOPAC_SOURCE, sinopacSignInPlan(CREDENTIALS));
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, TAKEN, DONE]);
    assert.equal(page.url(), SIGNED_IN_URL);
  }));

test("SinoPac confirms the takeover once, then proves the CAPTCHA rejection", () =>
  withSinopac(`if (ask(${js(DUPLICATE)})) alert(${js(REJECTED)})`, async (page) => {
    const run = recordedRun(page, solve);
    const error = await failure(signIn(run.context, page, SINOPAC_SOURCE, sinopacSignInPlan(CREDENTIALS)));
    assert.ok(error instanceof CaptchaProviderRejectedError);
    assert.deepEqual(await answers(page), [true]);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, TAKEN, REJECTION]);
    assert.equal(run.classify(error), "captcha-provider-rejected");
    assert.equal(dialogListeners(page), 0);
  }));

test("a second SinoPac duplicate sign-in prompt is dismissed and ends the sign-in as an interruption", () =>
  withSinopac(`ask(${js(DUPLICATE)}); ask(${js(DUPLICATE)})`, async (page) => {
    const run = recordedRun(page, solve);
    const error = await failure(signIn(run.context, page, SINOPAC_SOURCE, sinopacSignInPlan(CREDENTIALS)));
    assert.ok(error instanceof SignInError);
    assert.equal(error.reason, "takeover-repeated");
    assert.deepEqual(await answers(page), [true, false]);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, TAKEN, INTERRUPTED]);
    assert.equal(run.classify(error), "authentication-dialog-interrupted");
  }));

test("the exact SinoPac CAPTCHA alert alone proves the rejection", () =>
  withSinopac(`alert(${js(REJECTED)})`, async (page) => {
    const run = recordedRun(page, solve);
    const error = await failure(signIn(run.context, page, SINOPAC_SOURCE, sinopacSignInPlan(CREDENTIALS)));
    assert.ok(error instanceof CaptchaProviderRejectedError);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, REJECTION]);
    await assertUsable(page);
  }));

test("an unrecognized SinoPac dialog is a dialog interruption, never a CAPTCHA retry", () =>
  withSinopac(`alert("帳號已被鎖定")`, async (page) => {
    const run = recordedRun(page, solve);
    const error = await failure(signIn(run.context, page, SINOPAC_SOURCE, sinopacSignInPlan(CREDENTIALS)));
    assert.ok(error instanceof SignInError);
    assert.equal(error.reason, "dialog-interrupted");
    assert.equal(error instanceof CaptchaProviderRejectedError, false);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, INTERRUPTED]);
    assert.equal(run.classify(error), "authentication-dialog-interrupted");
  }));

test("SinoPac's generic error page ends the sign-in as source-unavailable without waiting for the deadline", () =>
  withSinopac(`location.href = ${js(SERVICE_ERROR_URL)}`, async (page) => {
    const run = recordedRun(page, solve);
    const startedAt = Date.now();
    const error = await failure(signIn(run.context, page, SINOPAC_SOURCE, sinopacSignInPlan(CREDENTIALS)));
    assert.ok(error instanceof SourceUnavailableError);
    assert.ok(Date.now() - startedAt < 5_000);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, FAILED]);
    assert.equal(run.classify(error), "source-unavailable");
  }));

test("SinoPac dismisses the password-expiry notice after sign-in and still reports a signed-in page", () =>
  withSinopac("signedIn()", async (page) => {
    const run = recordedRun(page, solve);
    await signIn(run.context, page, SINOPAC_SOURCE, sinopacSignInPlan(CREDENTIALS));
    assert.equal(await page.locator("#notice").count(), 0);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, DONE]);
  }, { passwordExpiryNotice: true }));

test("an existing SinoPac session skips the form and the stage", () =>
  withSinopac("", async (page) => {
    const run = recordedRun(page, solve);
    const signedIn = await signIn(run.context, page, SINOPAC_SOURCE, sinopacSignInPlan(CREDENTIALS));
    assert.equal(signedIn.usedExistingSession, true);
    assert.deepEqual(run.codes, [STARTED, DONE]);
  }, { startAt: SIGNED_IN_URL }));

test("an empty SinoPac CAPTCHA answer fails before the form is submitted", () =>
  withSinopac("signedIn()", async (page) => {
    const run = recordedRun(page, leavesEmpty);
    const error = await failure(signIn(run.context, page, SINOPAC_SOURCE, sinopacSignInPlan(CREDENTIALS)));
    assert.ok(error instanceof SignInError);
    assert.equal(error.reason, "answer-missing");
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, FAILED]);
    assert.equal(page.url(), SINOPAC_LOGIN_URL);
  }));

test("SinoPac's declared prompts match only the exact bank wording", () => {
  const takeover = SINOPAC_SOURCE.sessionTakeover?.prompt;
  const notice = DUPLICATE.replace(/。$/u, "");
  assert.equal(matchesTakeoverDialog(takeover, { type: "confirm", message: notice }), true);
  assert.equal(matchesTakeoverDialog(takeover, { type: "confirm", message: `${notice}。` }), true);
  assert.equal(matchesTakeoverDialog(takeover, { type: "alert", message: notice }), false);
  assert.equal(matchesTakeoverDialog(takeover, { type: "confirm", message: `${notice}，並變更密碼` }), false);
  assert.equal(matchesTakeoverDialog(takeover, { type: "confirm", message: "系統將強制關閉他處登入狀態" }), false);

  const rejection = SINOPAC_SOURCE.workflow.verification?.rejection;
  assert.equal(matchesRejectionDialog(rejection, { type: "alert", message: REJECTED }), true);
  assert.equal(matchesRejectionDialog(rejection, { type: "alert", message: "驗證碼失效或輸入錯誤，請再次輸入" }), false);
  assert.equal(matchesRejectionDialog(rejection, { type: "confirm", message: REJECTED }), false);
});
