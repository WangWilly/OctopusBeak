import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { CaptchaProviderRejectedError } from "../lib/automation/captcha-rejection.ts";
import { ProductCollectionFatalError } from "../lib/automation/product-collection.ts";
import { YUANTA_SOURCE } from "../lib/automation/server/sources/yuanta.ts";
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
  TAKEN,
  type Assist,
} from "./sign-in-check-harness.ts";
import { signIn, SignInError } from "./sign-in.ts";
import { YUANTA_ENTRY_URL, yuantaBankSignInPlan } from "./yuanta-auth.ts";

const ORIGIN = "https://ebank.yuantabank.com.tw";
const LOGIN_URL = `${ORIGIN}/nib/login.jsp`;
const SHELL_URL = `${ORIGIN}/nib/shell.jsp?cid=synthetic-cid`;
const CAPTCHA_REJECTED = "驗證碼不正確，請重新輸入";
const CREDENTIALS = { yuanta_user_id: "synthetic-id", yuanta_account: "synthetic-account", yuanta_password: "synthetic-password" };
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser.close();
});

const js = JSON.stringify;

async function withYuanta(
  script: string,
  body: (page: Page, served: { relogins: number }) => Promise<void>,
  options: Readonly<{ afterRelogin?: string; signedIn?: boolean; reloginControl?: "text" | "image" }> = {},
): Promise<void> {
  const page = await browser.newPage();
  const served = { relogins: 0 };
  let signedIn = options.signedIn ?? false;
  const reloginControl = options.reloginControl === "image"
    ? `<img src="/nib/relogin.gif" width="80" height="24" alt="立即登入" />`
    : "立即登入";
  try {
    await page.route(`${ORIGIN}/**`, (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/nib/GOTP" || pathname === "/nib/relogin.gif") {
        void route.fulfill({ contentType: "image/gif", body: GIF });
        return;
      }
      if (pathname === "/nib/relogin.do") {
        served.relogins += 1;
        signedIn = true;
      }
      const html = pathname === "/nib/ibanc.jsp"
        ? `<iframe name="main" src="${signedIn ? SHELL_URL : LOGIN_URL}" width="800" height="600"></iframe>
          <script>window.noticeCloses = 0; window.submits = []; window.relogins = 0;</script>`
        : pathname === "/nib/login.jsp"
          ? `<div id="commonPopup"><a id="commonPopupLeftBtnImg" href="#" onclick="closeNotice(); return false;">我知道了</a></div>
            <div id="form">
              <input id="custidMask" /><input id="custid" type="hidden" />
              <input id="custnoInput" readonly /><input id="custcode" type="password" readonly />
              <input id="gcode" /><img src="/nib/GOTP" width="107" height="50" alt="CAPTCHA" />
              <a href="javascript:doPreLogin();">登入</a>
            </div>
            <div id="relogin" hidden><p>您的帳號目前已在其他地方登入</p><a id="reloginBT" href="javascript:relogin();">${reloginControl}</a></div>
            <script>
              function closeNotice() { parent.noticeCloses += 1; document.getElementById("commonPopup").hidden = true; }
              function maskID() {
                document.getElementById("custid").value = document.getElementById("custidMask").value;
                document.getElementById("custidMask").value = "**********";
                document.getElementById("commonPopup").hidden = false;
              }
              function signedIn() { location.href = ${js(SHELL_URL)}; }
              function askRelogin() {
                document.getElementById("form").hidden = true;
                document.getElementById("relogin").hidden = false;
              }
              function hideRelogin() { document.getElementById("relogin").hidden = true; }
              function relogin() { parent.relogins += 1; ${options.afterRelogin ?? ""} }
              function doPreLogin() { parent.submits.push(document.getElementById("custid").value); ${script} }
            </script>`
          : pathname === "/nib/shell.jsp"
            ? `<iframe name="fmenu" src="/nib/menu.jsp"></iframe><iframe name="fmain" src="/nib/tx/home"></iframe>`
            : pathname === "/nib/menu.jsp"
              ? `<a id="btnLogout" href="/nib/tx/logout">登出</a>`
              : pathname === "/nib/relogin.do"
                ? `<script>location.replace(${js(YUANTA_ENTRY_URL)})</script>`
                : "<p>首頁</p>";
      void route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
    });
    await page.goto(YUANTA_ENTRY_URL, { waitUntil: "load" });
    await body(page, served);
  } finally {
    await page.close();
  }
}

const loginFrame = (page: Page) => {
  const frame = page.frame({ name: "main" });
  assert.ok(frame, "the login frame is present");
  return frame;
};
const counters = (page: Page) => page.evaluate(() => {
  const { noticeCloses, submits, relogins } = window as unknown as { noticeCloses: number; submits: string[]; relogins: number };
  return { noticeCloses, submits, relogins };
});
const submits = async (page: Page) => (await counters(page)).submits;
const solve: Assist = async (page) => {
  await loginFrame(page).locator("#gcode").fill("123456");
  return "entered";
};
const signInYuanta = (run: ReturnType<typeof recordedRun>, page: Page) =>
  signIn(run.context, page, YUANTA_SOURCE, yuantaBankSignInPlan(CREDENTIALS));

test("Yuanta Bank signs in through the step, closes the notice twice, and keeps its own session probe", () =>
  withYuanta("signedIn()", async (page) => {
    const run = recordedRun(page, solve);
    const signedIn = await signInYuanta(run, page);
    assert.equal(signedIn.usedExistingSession, false);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, DONE]);
    assert.equal((await counters(page)).noticeCloses, 2);
    assert.deepEqual(await submits(page), [CREDENTIALS.yuanta_user_id]);
    assert.equal(dialogListeners(page), 0);
    assert.ok(signedIn.assertSession);
    await signedIn.assertSession();
    await loginFrame(page).goto(LOGIN_URL);
    const lost = await failure(signedIn.assertSession());
    assert.ok(lost instanceof ProductCollectionFatalError);
    assert.equal(lost.errorCode, "authentication-failed");
  }));

test("Yuanta Bank confirms the 立即登入 prompt once and reports the takeover", () =>
  withYuanta("askRelogin()", async (page) => {
    const run = recordedRun(page, solve);
    await signInYuanta(run, page);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, TAKEN, DONE]);
    assert.equal((await counters(page)).relogins, 1);
  }, { afterRelogin: "signedIn()" }));

test("a second Yuanta Bank 立即登入 prompt ends the sign-in as a repeated takeover", () =>
  withYuanta("askRelogin()", async (page) => {
    const run = recordedRun(page, solve);
    const error = await failure(signInYuanta(run, page));
    assert.ok(error instanceof SignInError);
    assert.equal(error.reason, "takeover-repeated");
    assert.equal((await counters(page)).relogins, 1);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, TAKEN, INTERRUPTED]);
    assert.equal(run.classify(error), "authentication-dialog-interrupted");
  }, { afterRelogin: "hideRelogin(); setTimeout(askRelogin, 200)" }));

test("Yuanta Bank confirms a #reloginBT that shows an image instead of 立即登入", () =>
  withYuanta("askRelogin()", async (page) => {
    const run = recordedRun(page, solve);
    await signInYuanta(run, page);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, TAKEN, DONE]);
    assert.equal((await counters(page)).relogins, 1);
  }, { afterRelogin: "signedIn()", reloginControl: "image" }));

test("a Yuanta Bank 立即登入 that reloads the whole page signs in once the reloaded page opens the shell", () =>
  withYuanta("askRelogin()", async (page, served) => {
    const run = recordedRun(page, solve);
    const signedIn = await signInYuanta(run, page);
    assert.equal(signedIn.usedExistingSession, false);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, TAKEN, DONE]);
    assert.equal(served.relogins, 1);
    assert.equal(page.url(), YUANTA_ENTRY_URL);
  }, { afterRelogin: `top.location.href = "/nib/relogin.do"` }));

test("the exact Yuanta Bank CAPTCHA alert proves the rejection", () =>
  withYuanta(`alert(${js(CAPTCHA_REJECTED)})`, async (page) => {
    const run = recordedRun(page, solve);
    const error = await failure(signInYuanta(run, page));
    assert.ok(error instanceof CaptchaProviderRejectedError);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, REJECTION]);
    assert.equal(run.classify(error), "captcha-provider-rejected");
    await assertUsable(page);
    assert.equal(dialogListeners(page), 0);
  }));

test("each recognized Yuanta Bank alert ends the sign-in with its own error and no provider text", async () => {
  const classes = [
    ["帳號或密碼錯誤，請重新輸入", "YuanTa login failed: the credentials were rejected."],
    ["您的帳戶已鎖定，請洽客服", "YuanTa login failed: account access was blocked."],
    ["您已在其他裝置登入", "YuanTa login failed: another active session was detected."],
  ] as const;
  for (const [message, expected] of classes) {
    await withYuanta(`alert(${js(message)})`, async (page) => {
      const run = recordedRun(page, solve);
      const error = await failure(signInYuanta(run, page));
      assert.ok(error instanceof Error);
      assert.equal(error.message, expected);
      assert.equal(error instanceof SignInError || error instanceof CaptchaProviderRejectedError, false);
      assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, FAILED]);
      assert.equal(run.classify(error), "authentication-failed");
      await assertUsable(page);
    });
  }
});

test("an unknown Yuanta Bank alert is dismissed and ends the sign-in as a dialog interruption", () =>
  withYuanta(`alert("系統維護中"); document.body.dataset.after = "yes"`, async (page) => {
    const run = recordedRun(page, solve);
    const error = await failure(signInYuanta(run, page));
    assert.ok(error instanceof SignInError);
    assert.equal(error.reason, "dialog-interrupted");
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, INTERRUPTED]);
    assert.equal(run.classify(error), "authentication-dialog-interrupted");
    await assertUsable(page);
    assert.equal(await loginFrame(page).locator("body").getAttribute("data-after"), "yes");
  }));

test("an existing Yuanta Bank session skips the form and the stage", () =>
  withYuanta("", async (page) => {
    const run = recordedRun(page, solve);
    const signedIn = await signInYuanta(run, page);
    assert.equal(signedIn.usedExistingSession, true);
    assert.deepEqual(run.codes, [STARTED, DONE]);
    assert.equal(dialogListeners(page), 0);
  }, { signedIn: true }));

test("an empty Yuanta Bank CAPTCHA answer fails before the form is submitted", () =>
  withYuanta("signedIn()", async (page) => {
    const run = recordedRun(page, leavesEmpty);
    const error = await failure(signInYuanta(run, page));
    assert.ok(error instanceof SignInError);
    assert.equal(error.reason, "answer-missing");
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, FAILED]);
    assert.deepEqual(await submits(page), []);
  }));

test("a Yuanta Bank sign-in the person finished during assistance is not submitted again", () =>
  withYuanta("signedIn()", async (page) => {
    const signsInDuringAssist: Assist = async (assisted, signal) => {
      await solve(assisted, signal);
      await loginFrame(assisted).evaluate(() => (window as unknown as { doPreLogin(): void }).doPreLogin());
      await assisted.frameLocator('[name="main"]').frameLocator('[name="fmenu"]').locator("#btnLogout").waitFor({ state: "attached" });
      return "entered";
    };
    const run = recordedRun(page, signsInDuringAssist);
    const signedIn = await signInYuanta(run, page);
    assert.equal(signedIn.usedExistingSession, false);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, DONE]);
    assert.deepEqual(await submits(page), [CREDENTIALS.yuanta_user_id]);
  }));

test("a Yuanta Bank sign-in the person submitted during assistance goes on to the relogin prompt without a second submit", () =>
  withYuanta("askRelogin()", async (page) => {
    const submitsDuringAssist: Assist = async (assisted, signal) => {
      await solve(assisted, signal);
      await loginFrame(assisted).evaluate(() => (window as unknown as { doPreLogin(): void }).doPreLogin());
      return "entered";
    };
    const run = recordedRun(page, submitsDuringAssist);
    await signInYuanta(run, page);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, TAKEN, DONE]);
    assert.deepEqual(await submits(page), [CREDENTIALS.yuanta_user_id]);
  }, { afterRelogin: "signedIn()" }));

test("Yuanta Bank's declared rejection matches only the exact alert, and its takeover prompt is a page prompt", () => {
  const rejection = YUANTA_SOURCE.workflow.verification?.rejection;
  assert.equal(matchesRejectionDialog(rejection, { type: "alert", message: CAPTCHA_REJECTED }), true);
  assert.equal(matchesRejectionDialog(rejection, { type: "alert", message: `${CAPTCHA_REJECTED}。` }), true);
  assert.equal(matchesRejectionDialog(rejection, { type: "confirm", message: CAPTCHA_REJECTED }), false);
  assert.equal(matchesRejectionDialog(rejection, { type: "alert", message: "驗證碼不正確，帳號已鎖定" }), false);
  assert.deepEqual(YUANTA_SOURCE.sessionTakeover?.prompt, {
    phase: "while-settling",
    frame: "main",
    selector: '#reloginBT, a:has-text("立即登入")',
    control: { selector: '#reloginBT, a:has-text("立即登入")', force: true },
  });
});
