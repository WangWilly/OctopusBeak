import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, errors, type Browser, type Page } from "playwright";
import { ProductCollectionFatalError } from "../lib/automation/product-collection.ts";
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
import { SignInError, type FormPlan } from "./sign-in.ts";
import { CATHAY_BANK_ENTRY_URL } from "./cathay-login.ts";
import { cathaySignInPlan, signInCathayForApp } from "./cathay-statements.ts";

const HOME_URL = "https://www.cathaybk.com.tw/OnlineBanking/Home";
const CREDENTIALS = { cathay_user_id: "synthetic-user", cathay_account: "synthetic-account", cathay_password: "synthetic-password" };
const noStage: Assist = async () => assert.fail("Cathay has no Verification stage");

const READY = "advanced authentication-login-form-ready";
const ANNOUNCEMENTS = "advanced authentication-login-announcements-dismissed";
const FIELDS = "advanced authentication-login-fields-entered";
const SUBMITTING = "advanced authentication-login-submit-started";
const SUBMITTED = "advanced authentication-login-submitted";
const FILLED = [ANNOUNCEMENTS, FIELDS];
const SUBMIT = [SUBMITTING, SUBMITTED];

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser.close();
});

type Fixture = Readonly<{
  duplicate?: "once" | "every-fill";
  trustPrompt?: boolean;
  startAt?: string;
}>;

/**
 * Cathay's entry and signed-in pages at their real URLs. The login button
 * runs `script`: `home()` opens the signed-in page, `otp()` shows the
 * one-time-code wall. A `duplicate` session opens the 貼心提醒 modal after the
 * password is typed; its 登出 closes it and clears the form. Counts live in
 * sessionStorage so they survive the navigation to the signed-in page.
 */
async function withCathay(
  script: string,
  body: (page: Page, served: { entries: number }) => Promise<void>,
  fixture: Fixture = {},
): Promise<void> {
  const page = await browser.newPage();
  const served = { entries: 0 };
  const count = `const count = (key) => sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) ?? 0) + 1));`;
  try {
    await page.route("https://www.cathaybk.com.tw/**", (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/MyBank/") {
        served.entries += 1;
        void route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<input id="CustID"><input id="UserIdKeyin"><input id="PasswordKeyin" type="password">
            <button class="js-login" type="button" onclick="go()">登入</button>
            <div class="modal" id="duplicate" style="display:none;position:fixed;inset:0;background:white">
              <h4>貼心提醒</h4>
              <p>可能已在其他瀏覽器或裝置上重複登入，抑或前次未正常登出。</p>
              <button type="button" onclick="logOut()">登出</button>
            </div>
            <section hidden id="otp"><button id="js-otp-send" type="button">發送簡訊驗證碼</button></section>
            <script>
              ${count}
              let prompted = 0;
              document.getElementById("PasswordKeyin").addEventListener("input", () => {
                if (${JSON.stringify(fixture.duplicate ?? null)} === null) return;
                if (${JSON.stringify(fixture.duplicate)} === "once" && prompted > 0) return;
                prompted += 1;
                setTimeout(() => {
                  const modal = document.getElementById("duplicate");
                  modal.style.display = "block";
                  modal.classList.add("show");
                }, 30);
              });
              function logOut() {
                count("logouts");
                const modal = document.getElementById("duplicate");
                modal.style.display = "none";
                modal.classList.remove("show");
                document.querySelectorAll("input").forEach((input) => { input.value = ""; });
              }
              function home() { location.href = "/OnlineBanking/Home"; }
              function otp() { document.getElementById("otp").hidden = false; }
              function go() {
                count("logins");
                const filled = ["CustID", "UserIdKeyin", "PasswordKeyin"].every((id) => document.getElementById(id).value !== "");
                sessionStorage.setItem("filledAtSubmit", String(filled));
                ${script}
              }
            </script>`,
        });
      } else if (pathname === "/OnlineBanking/Home") {
        void route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<a href="#">登出</a>
            ${fixture.trustPrompt ? `<div role="dialog" id="trust">
              <p>信任這台裝置？</p>
              <button type="button" onclick="skip()">暫時不用</button>
              <button type="button">加入信任裝置</button>
            </div>` : ""}
            <script>
              ${count}
              function skip() { count("trustSkips"); document.getElementById("trust").remove(); }
            </script>`,
        });
      } else {
        void route.fulfill({ status: 404, body: "" });
      }
    });
    await page.goto(fixture.startAt ?? CATHAY_BANK_ENTRY_URL, { waitUntil: "domcontentloaded" });
    served.entries = 0;
    await body(page, served);
  } finally {
    await page.close();
  }
}

const stored = (page: Page, key: string) => page.evaluate((name) => sessionStorage.getItem(name), key);
const planFor = (run: ReturnType<typeof recordedRun>): FormPlan => cathaySignInPlan(CREDENTIALS, run.context.event);
const signInCathay = (run: ReturnType<typeof recordedRun>, page: Page, plan = planFor(run)) =>
  signInCathayForApp(run.context, page, plan);

test("Cathay signs in through the step, reports each form step, and declares no session probe", () =>
  withCathay("home()", async (page, served) => {
    const run = recordedRun(page, noStage);
    await signInCathay(run, page);
    assert.deepEqual(run.codes, [STARTED, READY, ...FILLED, ...SUBMIT, DONE]);
    assert.equal(page.url(), HOME_URL);
    assert.equal(await stored(page, "logins"), "1");
    assert.equal(await stored(page, "filledAtSubmit"), "true");
    assert.equal(served.entries, 1);
  }));

test("an existing Cathay session skips the form", () =>
  withCathay("", async (page, served) => {
    const run = recordedRun(page, noStage);
    await signInCathay(run, page);
    assert.deepEqual(run.codes, [STARTED, DONE]);
    assert.equal(served.entries, 0);
  }, { startAt: HOME_URL }));

test("an unknown Cathay dialog is accepted while signing in and for the rest of the page's life", () =>
  withCathay(`if (confirm("系統公告")) home()`, async (page) => {
    const run = recordedRun(page, noStage);
    await signInCathay(run, page);
    assert.deepEqual(run.codes, [STARTED, READY, ...FILLED, ...SUBMIT, DONE]);
    assert.equal(page.url(), HOME_URL);
    assert.equal(dialogListeners(page), 1);
    assert.equal(await page.evaluate(() => confirm("later")), true);
  }));

test("Cathay logs the duplicate session out once before submitting and fills the form again in place", () =>
  withCathay("home()", async (page, served) => {
    const run = recordedRun(page, noStage);
    await signInCathay(run, page);
    assert.deepEqual(run.codes, [STARTED, READY, ...FILLED, TAKEN, ...FILLED, ...SUBMIT, DONE]);
    assert.equal(await stored(page, "logouts"), "1");
    assert.equal(await stored(page, "logins"), "1");
    assert.equal(await stored(page, "filledAtSubmit"), "true");
    assert.equal(served.entries, 1, "the refill does not reload the entry page");
  }, { duplicate: "once" }));

test("a duplicate-session modal that returns after the refill ends the sign-in as an interruption", () =>
  withCathay("home()", async (page) => {
    const run = recordedRun(page, noStage);
    const error = await failure(signInCathay(run, page));
    assert.ok(error instanceof SignInError);
    assert.equal(error.reason, "takeover-repeated");
    assert.deepEqual(run.codes, [STARTED, READY, ...FILLED, TAKEN, ...FILLED, INTERRUPTED]);
    assert.equal(run.classify(error), "authentication-dialog-interrupted");
    assert.equal(await stored(page, "logouts"), "1");
    assert.equal(await stored(page, "logins"), null);
  }, { duplicate: "every-fill" }));

test("Cathay's one-time-code wall ends the sign-in as device-registration-required", () =>
  withCathay("otp()", async (page) => {
    const run = recordedRun(page, noStage);
    const error = await failure(signInCathay(run, page));
    assert.ok(error instanceof ProductCollectionFatalError);
    assert.equal(error.errorCode, "device-registration-required");
    assert.deepEqual(run.codes, [STARTED, READY, ...FILLED, ...SUBMIT, "advanced device-registration-required", FAILED]);
    assert.equal(run.classify(error), "device-registration-required");
  }));

test("Cathay skips the trust-device prompt on the signed-in page", () =>
  withCathay("home()", async (page) => {
    const run = recordedRun(page, noStage);
    await signInCathay(run, page);
    assert.deepEqual(run.codes, [STARTED, READY, ...FILLED, ...SUBMIT, DONE]);
    assert.equal(await stored(page, "trustSkips"), "1");
    assert.equal(await page.getByText("信任這台裝置？").count(), 0);
  }, { trustPrompt: true }));

test("a Cathay entry page that never loads is a sign-in timeout, not a failed verification", () =>
  withCathay("", async (page) => {
    await page.route(CATHAY_BANK_ENTRY_URL, () => undefined);
    page.setDefaultNavigationTimeout(300);
    const run = recordedRun(page, noStage);
    const error = await failure(signInCathay(run, page));
    assert.ok(error instanceof errors.TimeoutError);
    assert.deepEqual(run.codes, [STARTED, FAILED]);
    assert.equal(run.classify(error), "authentication-timeout");
  }));

test("a Cathay sign-in that never settles after submit fails verification", () =>
  withCathay("", async (page) => {
    const run = recordedRun(page, noStage);
    const error = await failure(signInCathay(run, page, { ...planFor(run), timeoutMs: 1_000 }));
    assert.ok(error instanceof ProductCollectionFatalError);
    assert.equal(error.errorCode, "verification-failed");
    assert.deepEqual(run.codes, [STARTED, READY, ...FILLED, ...SUBMIT, FAILED, "advanced authentication-sign-in-unconfirmed"]);
    assert.equal(run.classify(error), "verification-failed");
  }));

test("cancelling Cathay's sign-in while the form opens or while it settles rejects with the run's reason", async () => {
  for (const at of ["fill", "poll"] as const) {
    await withCathay("", async (page) => {
      if (at === "fill") await page.route(CATHAY_BANK_ENTRY_URL, (route) => void route.fulfill({ contentType: "text/html", body: "<p>載入中</p>" }));
      const run = recordedRun(page, noStage);
      const reason = new Error(`cancelled during ${at}`);
      const running = failure(signInCathay(run, page));
      if (at === "fill") await delay(500);
      else while (!run.codes.includes(SUBMITTED)) await delay(50);
      run.controller.abort(reason);
      assert.equal(await running, reason, at);
      const before = [...run.codes];
      await delay(1_500);
      assert.deepEqual(run.codes, before, `${at}: nothing after abort`);
      assert.deepEqual(run.codes, at === "fill" ? [STARTED] : [STARTED, READY, ...FILLED, ...SUBMIT], at);
      assert.equal(dialogListeners(page), 0, at);
    });
  }
});
