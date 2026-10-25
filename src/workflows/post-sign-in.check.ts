import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { CaptchaProviderRejectedError } from "../lib/automation/captcha-rejection.ts";
import { POST_CAPTCHA_INPUT_SELECTOR } from "../lib/automation/post-captcha.ts";
import { POST_SOURCE } from "../lib/automation/server/sources/post.ts";
import { matchesRejectionDialog } from "../lib/automation/sign-in-prompt.ts";
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
  typesAnswer,
  type Assist,
} from "./sign-in-check-harness.ts";
import { signIn, SignInError } from "./sign-in.ts";
import { postSignInPlan } from "./post-statements.ts";

const HOME_URL = "https://ipost.post.gov.tw/pst/home.html";
const CAPTCHA_REJECTED = "圖形驗證錯誤";
const CREDENTIALS = { post_user_id: "synthetic-user", post_account: "synthetic-account", post_password: "synthetic-password" };
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
 * iPost's home page at its real URL: the ID login tab whose 登入 link runs
 * `script` (`show()` reveals the detail link that marks a signed-in page,
 * `ask()` records confirm() answers), the startup notice iPost opens over the
 * form, and the CAPTCHA image the stage needs.
 */
async function withPost(
  script: string,
  body: (page: Page) => Promise<void>,
  options: Readonly<{ signedIn?: boolean }> = {},
): Promise<void> {
  const page = await browser.newPage();
  try {
    await page.route("https://ipost.post.gov.tw/**", (route) => {
      void route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<div id="tab1">
            <input id="cifID" /><input id="userID_1_Input" /><input id="userPWD_1_Input" type="password" />
            <input name="captcha" style="width: 92px; height: 32px" />
            <div class="codes_img"><img src="${PIXEL}" style="width: 142px; height: 48px" alt="iPost CAPTCHA" /></div>
            <div class="loginbtn"><a href="#" onclick="go(); return false;">登入</a></div>
          </div>
          <a id="detail" class="btn_td_orange_dtl" href="#" ${options.signedIn ? "" : "hidden"}>帳戶明細</a>
          <button id="notice" type="button" class="css_btn_class" ng-click="closeBox()" onclick="this.remove()">關閉</button>
          <script>
            window.answers = [];
            window.submits = 0;
            function show() { document.getElementById("detail").hidden = false; }
            function ask(message) { const answer = confirm(message); answers.push(answer); return answer; }
            function go() { submits += 1; ${script} }
          </script>`,
      });
    });
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
    await body(page);
  } finally {
    await page.close();
  }
}

const answers = (page: Page) => page.evaluate(() => (window as unknown as { answers: boolean[] }).answers);
const submits = (page: Page) => page.evaluate(() => (window as unknown as { submits: number }).submits);
const solve = typesAnswer(POST_CAPTCHA_INPUT_SELECTOR, "1234");

test("iPost signs in through the step, closes the startup notice, and declares no session probe", () =>
  withPost("show()", async (page) => {
    const run = recordedRun(page, solve);
    const signedIn = await signIn(run.context, page, POST_SOURCE, postSignInPlan(CREDENTIALS));
    assert.deepEqual(signedIn, { usedExistingSession: false });
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, DONE]);
    assert.equal(await page.locator("#notice").count(), 0);
    assert.equal(await submits(page), 1);
    assert.equal(dialogListeners(page), 0);
  }));

test("the exact iPost CAPTCHA alert proves the rejection without signalling an interruption", () =>
  withPost(`alert(${js(CAPTCHA_REJECTED)})`, async (page) => {
    const run = recordedRun(page, solve);
    const error = await failure(signIn(run.context, page, POST_SOURCE, postSignInPlan(CREDENTIALS)));
    assert.ok(error instanceof CaptchaProviderRejectedError);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, REJECTION]);
    assert.equal(run.classify(error), "captcha-provider-rejected");
    await assertUsable(page);
    assert.equal(dialogListeners(page), 0);
  }));

test("an unrelated iPost alert is dismissed and ends the sign-in as a dialog interruption", () =>
  withPost(`alert("iPost login check"); document.body.dataset.after = "yes"`, async (page) => {
    const run = recordedRun(page, solve);
    const error = await failure(signIn(run.context, page, POST_SOURCE, postSignInPlan(CREDENTIALS)));
    assert.ok(error instanceof SignInError);
    assert.equal(error.reason, "dialog-interrupted");
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, INTERRUPTED]);
    assert.equal(run.classify(error), "authentication-dialog-interrupted");
    await assertUsable(page);
    assert.equal(await page.locator("body").getAttribute("data-after"), "yes");
  }));

test("a confirm with the iPost CAPTCHA wording is dismissed as an interruption", () =>
  withPost(`ask(${js(CAPTCHA_REJECTED)})`, async (page) => {
    const run = recordedRun(page, solve);
    const error = await failure(signIn(run.context, page, POST_SOURCE, postSignInPlan(CREDENTIALS)));
    assert.ok(error instanceof SignInError);
    assert.equal(error.reason, "dialog-interrupted");
    assert.deepEqual(await answers(page), [false]);
  }));

test("a CAPTCHA regenerated during assistance is never submitted", () =>
  withPost("show()", async (page) => {
    const regenerates: Assist = async (p) => {
      await p.evaluate(() => {
        const input = document.querySelector('input[name="captcha"]');
        input?.replaceWith(input.cloneNode());
      });
      return solve(p, new AbortController().signal);
    };
    const run = recordedRun(page, regenerates);
    const error = await failure(signIn(run.context, page, POST_SOURCE, postSignInPlan(CREDENTIALS)));
    assert.match(String(error), /changed during assistance/u);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, FAILED]);
    assert.equal(await submits(page), 0);
  }));

test("an existing iPost session skips the form and the stage", () =>
  withPost("", async (page) => {
    const run = recordedRun(page, solve);
    const signedIn = await signIn(run.context, page, POST_SOURCE, postSignInPlan(CREDENTIALS));
    assert.deepEqual(signedIn, { usedExistingSession: true });
    assert.deepEqual(run.codes, [STARTED, DONE]);
  }, { signedIn: true }));

test("an empty iPost CAPTCHA answer fails before the form is submitted", () =>
  withPost("show()", async (page) => {
    const run = recordedRun(page, leavesEmpty);
    const error = await failure(signIn(run.context, page, POST_SOURCE, postSignInPlan(CREDENTIALS)));
    assert.ok(error instanceof SignInError);
    assert.equal(error.reason, "answer-missing");
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, FAILED]);
    assert.equal(await submits(page), 0);
  }));

test("iPost's declared rejection matches only the exact alert", () => {
  const rejection = POST_SOURCE.workflow.verification?.rejection;
  assert.equal(matchesRejectionDialog(rejection, { type: "alert", message: CAPTCHA_REJECTED }), true);
  assert.equal(matchesRejectionDialog(rejection, { type: "alert", message: " 帳號或密碼錯誤 " }), false);
  assert.equal(matchesRejectionDialog(rejection, { type: "alert", message: "圖形驗證錯誤，帳號已鎖定" }), false);
  assert.equal(matchesRejectionDialog(rejection, { type: "confirm", message: CAPTCHA_REJECTED }), false);
});
