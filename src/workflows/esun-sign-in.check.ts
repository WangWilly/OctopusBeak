import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, errors, type Browser, type Page } from "playwright";
import {
  dialogListeners,
  DONE,
  delay,
  FAILED,
  failure,
  INTERRUPTED,
  recordedRun,
  STARTED,
  TAKEN,
  type Assist,
} from "./sign-in-check-harness.ts";
import { SignInError } from "./sign-in.ts";
import { authenticateEsunPage } from "./esun-credit-card-statements.ts";

const ENTRY_URL = "https://ebank.esunbank.com.tw/index.jsp";
const CREDENTIALS = { esun_user_id: "synthetic-user", esun_account: "synthetic-account", esun_password: "synthetic-password" };
const UNSUPPORTED = "signal:solver-challenge-unsupported";
const noStage: Assist = async () => assert.fail("E.SUN has no Verification stage");

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser.close();
});

/**
 * E.SUN's entry page at its real URL: the login form whose 登入 button runs
 * `script` (`show()` reveals the 信用卡 menu that marks a signed-in page,
 * `ask()` records confirm() answers, `takeover()` replaces the form with the
 * 確定登入 confirmation, whose click runs `window.afterTakeover`, and
 * `wall(text)` replaces it with a page that never signs in).
 */
async function withEsun(
  script: string,
  body: (page: Page) => Promise<void>,
  options: Readonly<{ signedIn?: boolean }> = {},
): Promise<void> {
  const page = await browser.newPage();
  try {
    await page.route("https://ebank.esunbank.com.tw/**", (route) => {
      void route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<form id="login" onsubmit="return false">
            <input name="id" /><input name="userName" /><input name="pxssword" type="password" />
            <button type="button" onclick="go()">登入</button>
          </form>
          <nav id="menu" ${options.signedIn ? "" : "hidden"}><a href="#">信用卡</a></nav>
          <div id="takeover" hidden>
            <p>您的帳號目前已在其他裝置登入</p>
            <button type="button" onclick="confirmTakeover()">確定登入</button>
          </div>
          <p id="wall" hidden></p>
          <script>
            window.answers = [];
            window.submits = 0;
            window.takeovers = 0;
            function show() { document.getElementById("menu").hidden = false; }
            function ask(message) { const answer = confirm(message); answers.push(answer); return answer; }
            function takeover() { document.getElementById("takeover").hidden = false; }
            function confirmTakeover() {
              takeovers += 1;
              document.getElementById("takeover").hidden = true;
              window.afterTakeover?.();
            }
            function wall(text) { const wall = document.getElementById("wall"); wall.textContent = text; wall.hidden = false; }
            function go() { submits += 1; document.getElementById("login").hidden = true; ${script} }
          </script>`,
      });
    });
    await page.goto(ENTRY_URL, { waitUntil: "domcontentloaded" });
    await body(page);
  } finally {
    await page.close();
  }
}

const read = <T>(page: Page, name: string) => page.evaluate((key) => (window as unknown as Record<string, T>)[key], name);
const signInEsun = (run: ReturnType<typeof recordedRun>, page: Page) => authenticateEsunPage(page, CREDENTIALS, run.context);

test("E.SUN signs in through the step and fills the three login fields", () =>
  withEsun("show()", async (page) => {
    const run = recordedRun(page, noStage);
    await signInEsun(run, page);
    assert.deepEqual(run.codes, [STARTED, DONE]);
    assert.equal(await read(page, "submits"), 1);
    assert.deepEqual(await page.locator("#login input").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)), [
      CREDENTIALS.esun_user_id,
      CREDENTIALS.esun_account,
      CREDENTIALS.esun_password,
    ]);
  }));

test("an existing E.SUN session skips the form", () =>
  withEsun("", async (page) => {
    const run = recordedRun(page, noStage);
    await signInEsun(run, page);
    assert.deepEqual(run.codes, [STARTED, DONE]);
    assert.equal(await read(page, "submits"), 0);
  }, { signedIn: true }));

test("an unknown E.SUN dialog is accepted while signing in and for the rest of the page's life", () =>
  withEsun(`if (ask("系統公告")) show()`, async (page) => {
    const run = recordedRun(page, noStage);
    await signInEsun(run, page);
    assert.deepEqual(run.codes, [STARTED, DONE]);
    assert.deepEqual(await read(page, "answers"), [true]);
    assert.equal(dialogListeners(page), 1);
    assert.equal(await page.evaluate(() => confirm("later")), true);
  }));

test("E.SUN confirms 確定登入 once, in place of the signed-in page, and reports the takeover", () =>
  withEsun("window.afterTakeover = show; takeover()", async (page) => {
    const run = recordedRun(page, noStage);
    await signInEsun(run, page);
    assert.deepEqual(run.codes, [STARTED, TAKEN, DONE]);
    assert.equal(await read(page, "takeovers"), 1);
  }));

test("after 確定登入, a slow E.SUN page gets the 60 s takeover window instead of the 15 s verification wall", () =>
  withEsun("window.afterTakeover = () => setTimeout(show, 17_000); takeover()", async (page) => {
    const run = recordedRun(page, noStage);
    await signInEsun(run, page);
    assert.deepEqual(run.codes, [STARTED, TAKEN, DONE]);
    assert.equal(await read(page, "takeovers"), 1);
  }));

test("a second E.SUN 確定登入 is not confirmed and ends the sign-in as an interruption", () =>
  withEsun("window.afterTakeover = () => setTimeout(takeover, 300); takeover()", async (page) => {
    const run = recordedRun(page, noStage);
    const error = await failure(signInEsun(run, page));
    assert.ok(error instanceof SignInError);
    assert.equal(error.reason, "takeover-repeated");
    assert.deepEqual(run.codes, [STARTED, TAKEN, INTERRUPTED]);
    assert.equal(run.classify(error), "authentication-dialog-interrupted");
    assert.equal(await read(page, "takeovers"), 1);
  }));

test("a page that is still not signed in after 15 s is classified as an unsupported verification wall", () =>
  withEsun(`wall("請輸入簡訊動態密碼")`, async (page) => {
    const run = recordedRun(page, noStage);
    const startedAt = Date.now();
    const error = await failure(signInEsun(run, page));
    assert.ok(Date.now() - startedAt >= 15_000, "the wall window is 15 s");
    assert.match(String(error), /not supported by the automatic solver/u);
    assert.deepEqual(run.codes, [STARTED, FAILED, "advanced esun-post-login-otp", UNSUPPORTED]);
    assert.equal(run.classify(error), "verification-configuration-failed");
    assert.equal(dialogListeners(page), 0);
  }));

test("a 確定登入 that stays on screen after its click is a sign-in timeout, not a verification wall", () =>
  withEsun("window.confirmTakeover = () => { takeovers += 1; }; takeover()", async (page) => {
    const run = recordedRun(page, noStage);
    const error = await failure(signInEsun(run, page));
    assert.ok(error instanceof errors.TimeoutError, String(error));
    assert.deepEqual(run.codes, [STARTED, FAILED]);
    assert.equal(run.classify(error), "authentication-timeout");
    assert.equal(await read(page, "takeovers"), 1);
  }));

test("an E.SUN page that never loads is a sign-in timeout, not a verification wall", () =>
  withEsun("", async (page) => {
    await page.route(ENTRY_URL, () => undefined);
    page.setDefaultNavigationTimeout(300);
    const run = recordedRun(page, noStage);
    const error = await failure(signInEsun(run, page));
    assert.ok(error instanceof errors.TimeoutError);
    assert.deepEqual(run.codes, [STARTED, FAILED]);
    assert.equal(run.classify(error), "authentication-timeout");
  }));

test("cancelling E.SUN's sign-in while the page loads or while it settles rejects with the run's reason", async () => {
  for (const at of ["fill", "poll"] as const) {
    await withEsun("", async (page) => {
      if (at === "fill") await page.route(ENTRY_URL, () => undefined);
      const run = recordedRun(page, noStage);
      const reason = new Error(`cancelled during ${at}`);
      const running = failure(signInEsun(run, page));
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
