import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { CaptchaProviderRejectedError } from "../lib/automation/captcha-rejection.ts";
import { FailureCodeError } from "../lib/automation/workflow-failures.ts";
import { FUBON_SOURCE } from "../lib/automation/server/sources/fubon.ts";
import { fubonSignInPlan } from "./fubon-all-statements.ts";
import { FubonLoginRefusedError, FubonLoginRejectedError } from "./fubon-auth.ts";
import {
  ASSISTED,
  assertUsable,
  delay,
  dialogListeners,
  DONE,
  FAILED,
  failure,
  INTERRUPTED,
  recordedRun,
  REJECTION,
  REQUESTED,
  STARTED,
  TAKEN,
  type Assist,
} from "./sign-in-check-harness.ts";
import { signIn, SignInError, type ShellPlan } from "./sign-in.ts";

const DUPLICATE = "錯誤代碼0212：已有其他裝置登入，是否繼續？";
const CREDENTIALS = { fubon_user_id: "synthetic-user", fubon_account: "synthetic-account", fubon_password: "synthetic-password" };
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser.close();
});

const js = JSON.stringify;

/**
 * The bank at its real URLs. The entry page holds the header frame `frame1`
 * (its 登入 link opens the form; its `loggedIn` global and logout link mark a
 * signed-in session, and every read of `loggedIn` is counted in `probes`) and
 * the login frame `txnFrame` (three password fields, the CAPTCHA and a 登入
 * button that runs `script`; without the CAPTCHA field when asked, so the
 * login document never becomes ready). `signedIn()` marks the header signed
 * in, `ask()` records confirm() answers, `reject()` and `refuse()` reveal the
 * bank's inline responses.
 */
async function withFubon(
  script: string,
  body: (page: Page) => Promise<void>,
  options: Readonly<{ captchaMissing?: boolean }> = {},
): Promise<void> {
  const page = await browser.newPage();
  try {
    await page.route("https://ebank.taipeifubon.com.tw/**", (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname.endsWith("/captchaImage")) {
        void route.fulfill({ contentType: "image/gif", body: PIXEL });
        return;
      }
      const html = pathname === "/B2C/common/Index.faces"
        ? `<iframe name="frame1" src="/B2C/common/header.faces"></iframe>
          <iframe name="txnFrame" src="/B2C/common/login.faces"></iframe>`
        : pathname === "/B2C/common/header.faces"
          ? `<a href="#">登入</a><a id="header_form:header_logout" href="#" hidden>登出</a>
            <script>
              window.probes = 0;
              let loggedIn = false;
              Object.defineProperty(window, "loggedIn", {
                get() { window.probes += 1; return loggedIn; },
                set(value) { loggedIn = value; },
              });
            </script>`
          : `<input type="password" /><input type="password" /><input type="password" />
            ${options.captchaMissing ? "" : `<input id="m1_userCaptcha" />`}
            <img src="/B2C/common/captchaImage?timestamp=1" width="100" height="40" />
            <button id="btnLogin2" type="button" onclick="go()">登入</button>
            <div id="rejected" hidden>0290 驗證碼輸入錯誤</div>
            <div id="refused" hidden>請輸入身分證字號<br />請輸入使用者代碼<br />請輸入使用者密碼</div>
            <script>
              window.answers = [];
              function ask(message) { const answer = confirm(message); answers.push(answer); return answer; }
              function signedIn() {
                const header = parent.frames["frame1"];
                header.loggedIn = true;
                header.document.getElementById("header_form:header_logout").hidden = false;
              }
              function reject() { document.getElementById("rejected").hidden = false; }
              function refuse() { document.getElementById("refused").hidden = false; }
              function go() { ${script} }
            </script>`;
      void route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
    });
    await body(page);
  } finally {
    await page.close();
  }
}

function frame(page: Page, name: "frame1" | "txnFrame") {
  const found = page.frame({ name });
  assert.ok(found, `the Fubon ${name} frame is missing`);
  return found;
}

const answers = (page: Page) => frame(page, "txnFrame").evaluate(() => (window as unknown as { answers: boolean[] }).answers);
const probes = (page: Page) => frame(page, "frame1").evaluate(() => (window as unknown as { probes: number }).probes);
const signOut = (page: Page) => frame(page, "frame1").evaluate(() => {
  (window as unknown as { loggedIn: boolean }).loggedIn = false;
  document.getElementById("header_form:header_logout")?.setAttribute("hidden", "");
});

const solve: Assist = async (page) => {
  await frame(page, "txnFrame").locator("#m1_userCaptcha").fill("123456");
  return "entered";
};

const plan = (run: ReturnType<typeof recordedRun>) =>
  fubonSignInPlan(CREDENTIALS, (stage) => run.context.verification.complete(stage));

/** The plan with `own` wrapped, so a check can see when Fubon's own sign-in settled. */
function observed(plan: ShellPlan): Readonly<{ plan: ShellPlan; settled: () => boolean }> {
  let settled = false;
  return {
    plan: { ...plan, own: (page, signal) => plan.own(page, signal).finally(() => { settled = true; }) },
    settled: () => settled,
  };
}

async function until(condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail("the condition did not hold in time");
    await delay(50);
  }
}

test("Fubon signs in through the step, confirms the 0212 takeover once and keeps its own session probe", () =>
  withFubon(`if (ask(${js(DUPLICATE)})) signedIn()`, async (page) => {
    const run = recordedRun(page, solve);
    const signedIn = await signIn(run.context, page, FUBON_SOURCE, plan(run));
    assert.equal(signedIn.usedExistingSession, false);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, TAKEN, DONE]);
    assert.deepEqual(await answers(page), [true]);
    assert.equal(dialogListeners(page), 0);
    assert.ok(signedIn.assertSession);
    await signedIn.assertSession();
    await signOut(page);
    const lost = await failure(signedIn.assertSession());
    assert.ok(lost instanceof FailureCodeError);
    assert.equal(lost.errorCode, "authentication-failed");
  }));

test("a second Fubon duplicate-login confirm is dismissed and ends the sign-in as an interruption", () =>
  withFubon(`ask(${js(DUPLICATE)}); ask(${js(DUPLICATE)})`, async (page) => {
    const run = recordedRun(page, solve);
    const error = await failure(signIn(run.context, page, FUBON_SOURCE, plan(run)));
    assert.ok(error instanceof SignInError, String(error));
    assert.equal(error.reason, "takeover-repeated");
    assert.deepEqual(await answers(page), [true, false]);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, TAKEN, INTERRUPTED]);
    assert.equal(run.classify(error), "authentication-dialog-interrupted");
    assert.equal(dialogListeners(page), 0);
  }));

test("a Fubon alert during the outcome window is accepted and rejects the sign-in by its sanitized code", () =>
  withFubon(`alert("登入失敗 errorCode0240 private-secret")`, async (page) => {
    const run = recordedRun(page, solve);
    const error = await failure(signIn(run.context, page, FUBON_SOURCE, plan(run)));
    assert.ok(error instanceof FubonLoginRejectedError, String(error));
    assert.equal(error.reason, "dialog-alert");
    assert.equal(error.errorCode, "0240");
    assert.doesNotMatch(String(error), /private-secret/u);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, FAILED]);
    assert.equal(run.classify(error), "authentication-failed");
    await assertUsable(page);
  }));

test("an unknown Fubon confirm is dismissed and rejects the sign-in without its text", () =>
  withFubon(`ask("請確認是否刪除這筆資料 private-secret")`, async (page) => {
    const run = recordedRun(page, solve);
    const error = await failure(signIn(run.context, page, FUBON_SOURCE, plan(run)));
    assert.ok(error instanceof FubonLoginRejectedError, String(error));
    assert.equal(error.reason, "unknown-confirm");
    assert.doesNotMatch(String(error), /private-secret/u);
    assert.deepEqual(await answers(page), [false]);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, FAILED]);
  }));

test("Fubon's inline 0290 response is a provider CAPTCHA rejection before the login-form grace runs out", () =>
  withFubon("reject()", async (page) => {
    const run = recordedRun(page, solve);
    const startedAt = Date.now();
    const error = await failure(signIn(run.context, page, FUBON_SOURCE, plan(run)));
    assert.ok(error instanceof CaptchaProviderRejectedError, String(error));
    assert.equal(error instanceof FubonLoginRefusedError, false);
    assert.ok(Date.now() - startedAt < 8_000, "the 0290 text ends the poll before the 10 s login-form grace");
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, REJECTION]);
    assert.equal(run.classify(error), "captcha-provider-rejected");
  }));

test("Fubon's three-empty-fields refusal stays a retryable CAPTCHA rejection", () =>
  withFubon("refuse()", async (page) => {
    const run = recordedRun(page, solve);
    const error = await failure(signIn(run.context, page, FUBON_SOURCE, plan(run)));
    assert.ok(error instanceof FubonLoginRefusedError, String(error));
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, REJECTION]);
    assert.equal(run.classify(error), "captcha-provider-rejected");
  }));

test("cancelling Fubon while the login document is not ready ends its own waits with the run's reason", () =>
  withFubon("", async (page) => {
    const run = recordedRun(page, solve);
    const own = observed(plan(run));
    const reason = new Error("cancelled while preparing the form");
    const running = failure(signIn(run.context, page, FUBON_SOURCE, own.plan));
    await until(() => page.frame({ name: "txnFrame" }) !== null);
    await delay(500);
    assert.equal(own.settled(), false);
    run.controller.abort(reason);
    assert.equal(await running, reason);
    await until(own.settled, 2_000);
    assert.deepEqual(run.codes, [STARTED]);
  }, { captchaMissing: true }));

test("cancelling Fubon during the outcome poll stops the poll and rejects with the run's reason", () =>
  withFubon("", async (page) => {
    const run = recordedRun(page, solve);
    const own = observed(plan(run));
    const reason = new Error("cancelled during the outcome poll");
    const running = failure(signIn(run.context, page, FUBON_SOURCE, own.plan));
    await until(() => run.codes.includes(ASSISTED));
    // The OTP look takes three seconds after submit; the outcome poll starts after it.
    await delay(3_500);
    assert.equal(own.settled(), false);
    run.controller.abort(reason);
    assert.equal(await running, reason);
    await until(own.settled);
    await delay(300);
    const probed = await probes(page);
    await delay(1_000);
    assert.equal(await probes(page), probed, "the outcome poll stopped reading the header frame");
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED]);
    assert.equal(dialogListeners(page), 0);
  }));
