import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { LINEBANK_SOURCE } from "../lib/automation/server/sources/linebank.ts";
import {
  assertUsable,
  dialogListeners,
  DONE,
  FAILED,
  failure,
  givesUp,
  recordedRun,
  STARTED,
} from "./sign-in-check-harness.ts";
import { linebankSignInPlan } from "./linebank-statements.ts";
import { signIn } from "./sign-in.ts";

const ORIGIN = "https://accessibility.linebank.com.tw";
const LOGIN_URL = `${ORIGIN}/login`;
const HOME_URL = `${ORIGIN}/`;
const CREDENTIALS = { linebank_user_id: "synthetic-id", linebank_account: "synthetic-user", linebank_password: "synthetic-password" };

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser.close();
});

/**
 * LINE Bank's accessible site at its real URLs: the login form whose submit
 * button records the entered ID in sessionStorage and runs `script`, and the
 * signed-in home page with its transaction link and `notices` approved
 * alertdialogs. `signedIn()` opens the home page.
 */
async function withLineBank(
  script: string,
  body: (page: Page) => Promise<void>,
  options: Readonly<{ startAt?: string; notices?: number; submitButtons?: number }> = {},
): Promise<void> {
  const page = await browser.newPage();
  try {
    await page.route(`${ORIGIN}/**`, (route) => {
      const { pathname } = new URL(route.request().url());
      const button = `<button type="button" onclick="go()">登入友善網路銀行</button>`;
      const notice = `<div role="alertdialog" aria-label="公告"><p>系統公告</p><button type="button" onclick="this.parentElement.remove()">確定</button></div>`;
      const html = pathname === "/login"
        ? `<input id="nationalId" /><input id="userId" /><input id="pw" type="password" />
          ${button.repeat(options.submitButtons ?? 1)}
          <script>
            function signedIn() { location.href = "/"; }
            function go() {
              sessionStorage.submits = JSON.stringify([...JSON.parse(sessionStorage.submits ?? "[]"), document.getElementById("nationalId").value]);
              ${script}
            }
          </script>`
        : `<a href="/transaction">帳戶交易明細查詢</a>${notice.repeat(options.notices ?? 0)}`;
      void route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
    });
    await page.goto(options.startAt ?? LOGIN_URL, { waitUntil: "domcontentloaded" });
    await body(page);
  } finally {
    await page.close();
  }
}

const submits = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.submits ?? "[]") as string[]);
const visibleNotices = (page: Page) => page.getByRole("alertdialog").count();
const signInLineBank = (run: ReturnType<typeof recordedRun>, page: Page) =>
  signIn(run.context, page, LINEBANK_SOURCE, linebankSignInPlan(CREDENTIALS));

test("LINE Bank signs in through the step without a stage and declares no session probe", () =>
  withLineBank("signedIn()", async (page) => {
    const run = recordedRun(page, givesUp);
    const signedIn = await signInLineBank(run, page);
    assert.deepEqual(signedIn, { usedExistingSession: false });
    assert.deepEqual(run.codes, [STARTED, DONE]);
    assert.deepEqual(await submits(page), [CREDENTIALS.linebank_user_id]);
    assert.equal(page.url(), HOME_URL);
    assert.equal(dialogListeners(page), 0);
  }));

test("LINE Bank closes its one approved alertdialog while the sign-in settles", () =>
  withLineBank("signedIn()", async (page) => {
    const run = recordedRun(page, givesUp);
    await signInLineBank(run, page);
    assert.equal(await visibleNotices(page), 0);
    assert.deepEqual(run.codes, [STARTED, DONE]);
  }, { notices: 1 }));

test("two LINE Bank alertdialogs at once fail the sign-in", () =>
  withLineBank("signedIn()", async (page) => {
    const run = recordedRun(page, givesUp);
    const error = await failure(signInLineBank(run, page));
    assert.match(String(error), /exactly one visible alert dialog/u);
    assert.equal(await visibleNotices(page), 2);
    assert.deepEqual(run.codes, [STARTED, FAILED]);
    assert.equal(run.classify(error), "authentication-failed");
  }, { notices: 2 }));

test("LINE Bank dismisses unrecognized browser dialogs and keeps waiting for the signed-in page", () =>
  withLineBank(`sessionStorage.answer = String(confirm("系統維護公告")); alert("系統維護中"); signedIn()`, async (page) => {
    const run = recordedRun(page, givesUp);
    await signInLineBank(run, page);
    assert.deepEqual(run.codes, [STARTED, DONE]);
    assert.equal(await page.evaluate(() => sessionStorage.answer), "false");
    await assertUsable(page);
  }));

test("LINE Bank refuses to submit unless exactly one submit button is visible", () =>
  withLineBank("signedIn()", async (page) => {
    const run = recordedRun(page, givesUp);
    const error = await failure(signInLineBank(run, page));
    assert.match(String(error), /exactly one submit button/u);
    assert.deepEqual(await submits(page), []);
    assert.deepEqual(run.codes, [STARTED, FAILED]);
  }, { submitButtons: 2 }));

test("an existing LINE Bank session skips the form", () =>
  withLineBank("", async (page) => {
    const run = recordedRun(page, givesUp);
    const signedIn = await signInLineBank(run, page);
    assert.deepEqual(signedIn, { usedExistingSession: true });
    assert.deepEqual(run.codes, [STARTED, DONE]);
    assert.equal(dialogListeners(page), 0);
  }, { startAt: HOME_URL }));

test("LINE Bank declares no Session takeover and no Verification stage", () => {
  assert.equal(LINEBANK_SOURCE.sessionTakeover, undefined);
  assert.equal(LINEBANK_SOURCE.workflow.verification, undefined);
});
