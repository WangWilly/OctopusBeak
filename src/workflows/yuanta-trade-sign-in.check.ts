import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { ExternalPrerequisiteUnavailableError } from "../lib/automation/external-prerequisite.ts";
import { YUANTA_TRADE_SOURCE } from "../lib/automation/server/sources/yuanta-trade.ts";
import { delay, dialogListeners, DONE, FAILED, failure, givesUp, recordedRun, STARTED } from "./sign-in-check-harness.ts";
import { signIn, type ShellPlan } from "./sign-in.ts";
import { YUANTA_TRADE_LOGIN_URL, yuantaTradeSignInPlan } from "./yuanta-trade-statements.ts";

const REPORT_URL = "https://global.yuanta.com.tw/NexusWebTrade/AssetReport/Stock";
const CREDENTIALS = {
  yuanta_trade_user_id: "synthetic-user",
  yuanta_trade_password: "synthetic-password",
  yuanta_trade_ca_path: "/synthetic/certificate.pfx",
  yuanta_trade_ca_password: "synthetic-certificate-password",
};

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser.close();
});

const js = JSON.stringify;

/**
 * Yuanta Securities at its real URLs: the OTP login page (ID and password
 * fields and a 登入 button that runs `script`, with the missing-ServiSign
 * notice when asked) and the asset report page, which shows the logout button
 * of a signed-in session or, when asked, only the disclaimer the sign-in must
 * accept first. `signedIn()` navigates to the report page.
 */
async function withYuanta(
  script: string,
  body: (page: Page) => Promise<void>,
  options: Readonly<{ startAt?: string; servisignMissing?: boolean; disclaimerOnly?: boolean }> = {},
): Promise<void> {
  const page = await browser.newPage();
  try {
    await page.route("https://global.yuanta.com.tw/**", (route) => {
      const { pathname } = new URL(route.request().url());
      const html = pathname === "/NexusWebTrade/Login/OTPLogin"
        ? `<input id="loginid" /><input id="loginPWD" type="password" />
          <button id="loginBtn" type="button" onclick="go()">登入</button>
          ${options.servisignMissing ? "<p>系統找不到安控元件</p>" : ""}
          <script>
            function signedIn() { location.href = ${js(REPORT_URL)}; }
            function go() { ${script} }
          </script>`
        : options.disclaimerOnly
          ? `<input id="checkDisclaimer" type="checkbox" /><button id="btnConfirm" type="button">確認</button>`
          : `<button id="btnLogout" type="button">登出</button>`;
      void route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
    });
    await page.goto(options.startAt ?? YUANTA_TRADE_LOGIN_URL, { waitUntil: "domcontentloaded" });
    await body(page);
  } finally {
    await page.close();
  }
}

const plan = (run: ReturnType<typeof recordedRun>) => yuantaTradeSignInPlan(CREDENTIALS, run.context);
const accepted = (page: Page) => page.evaluate(() => confirm("still signed in?"));

/** The plan with `own` wrapped, so a check can see when Yuanta Trade's own sign-in settled. */
function observed(plan: ShellPlan): Readonly<{ plan: ShellPlan; settled: () => boolean }> {
  let settled = false;
  return {
    plan: { ...plan, own: (page, signal) => plan.own(page, signal).finally(() => { settled = true; }) },
    settled: () => settled,
  };
}

async function until(condition: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() >= deadline) assert.fail("the condition did not hold in time");
    await delay(50);
  }
}

test("an existing Yuanta Trade session skips the sign-in and keeps accepting dialogs for the page's life", () =>
  withYuanta("", async (page) => {
    const run = recordedRun(page, givesUp);
    const signedIn = await signIn(run.context, page, YUANTA_TRADE_SOURCE, plan(run));
    assert.deepEqual(signedIn, { usedExistingSession: true });
    assert.deepEqual(run.codes, [STARTED, DONE]);
    assert.equal(dialogListeners(page), 1);
    assert.equal(await accepted(page), true);
  }, { startAt: REPORT_URL }));

test("Yuanta Trade signs in through the step, accepting the bank's dialogs during and after sign-in", () =>
  withYuanta(`if (confirm("提醒")) signedIn()`, async (page) => {
    const run = recordedRun(page, givesUp);
    const signedIn = await signIn(run.context, page, YUANTA_TRADE_SOURCE, plan(run));
    assert.deepEqual(signedIn, { usedExistingSession: false });
    assert.deepEqual(run.codes, [STARTED, DONE]);
    assert.equal(page.url(), REPORT_URL);
    assert.equal(dialogListeners(page), 1);
    assert.equal(await accepted(page), true);
  }));

test("a missing ServiSign component fails Yuanta Trade's sign-in inside the step's bracket", () =>
  withYuanta("signedIn()", async (page) => {
    const run = recordedRun(page, givesUp);
    const error = await failure(signIn(run.context, page, YUANTA_TRADE_SOURCE, plan(run)));
    assert.ok(error instanceof ExternalPrerequisiteUnavailableError, String(error));
    assert.equal(error.prerequisiteId, "yuanta-servisign");
    assert.deepEqual(run.codes, [STARTED, "failed servisign-unavailable", FAILED]);
    assert.equal(run.classify(error), "external-prerequisite-unavailable");
    assert.equal(dialogListeners(page), 0);
  }, { servisignMissing: true }));

test("cancelling Yuanta Trade while it waits for the signed-in page ends its own waits with the run's reason", () =>
  withYuanta("signedIn()", async (page) => {
    const run = recordedRun(page, givesUp);
    const own = observed(plan(run));
    const reason = new Error("cancelled while waiting for the logout button");
    const running = failure(signIn(run.context, page, YUANTA_TRADE_SOURCE, own.plan));
    await until(() => page.url() === REPORT_URL && page.locator("#checkDisclaimer").isChecked().catch(() => false));
    // The disclaimer click settles for 750 ms before the logout wait begins.
    await delay(1_000);
    assert.equal(own.settled(), false);
    run.controller.abort(reason);
    assert.equal(await running, reason);
    await until(own.settled, 2_000);
    assert.deepEqual(run.codes, [STARTED]);
    assert.equal(dialogListeners(page), 0);
  }, { disclaimerOnly: true }));
