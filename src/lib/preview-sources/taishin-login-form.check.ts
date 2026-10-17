import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { blankPng } from "./preview-source-harness.ts";
import { taishinBrowserSession } from "./taishin-login-form.ts";
import type { PreviewWorkflowContext } from "./workflow.ts";

const ORIGIN = "https://my.taishinbank.com.tw";
const START_URL = `${ORIGIN}/TIBNetBank/svc/rwd/index.html`;
const CAPTCHA = blankPng(120, 36);

const LOGIN_FRAME = `<html><body>
  <label for="cid">身分證字號</label><input id="cid">
  <label for="uid">使用者代碼</label><input id="uid">
  <label for="pwd">使用者密碼</label><input id="pwd" type="password">
  <input id="code" placeholder="請輸入驗證碼" maxlength="6" inputmode="numeric">
  <img class="_field_item__verify-code" src="/TIBNetBank/svc/web/shuffle/NonSessionShuffle?TOKEN=t1">
  <button id="login">登入網銀</button>
  <div class="js-popup" id="message"><div class="_popup_text"></div></div>
  <div class="js-popup" id="popupLoginChangePwd"><div class="_popup_text">請變更您的密碼</div><button data-action="hide">下次再說</button></div>
  <script>
    document.getElementById("login").addEventListener("click", async () => {
      const values = Object.fromEntries(["cid", "uid", "pwd", "code"].map((id) => [id, document.getElementById(id).value]));
      const response = await fetch("/TIBNetBank/svc/web/login/login", { method: "POST", body: JSON.stringify(values) });
      const { message } = await response.json();
      if (message) {
        document.querySelector("#message ._popup_text").textContent = message;
        document.getElementById("message").classList.add("active");
        return;
      }
      const reminder = document.getElementById("popupLoginChangePwd");
      reminder.classList.add("active");
      reminder.querySelector("button").addEventListener("click", () => reminder.classList.remove("active"));
    });
  </script>
</body></html>`;

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

type Site = { logins: unknown[]; reminderOpen: () => Promise<boolean> };

async function withFixture<T>(loginMessage: string | null, run: (context: PreviewWorkflowContext, site: Site) => Promise<T>): Promise<T> {
  const context = await browser.newContext();
  const logins: unknown[] = [];
  let page: Page | null = null;
  await context.route("**/*", async (route) => {
    const request = route.request();
    const { origin, pathname } = new URL(request.url());
    if (origin !== ORIGIN) return route.abort();
    if (pathname === "/TIBNetBank/svc/rwd/index.html") {
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: '<html><body><iframe src="/TIBNetBank/svc/rwd/login.html"></iframe></body></html>' });
    }
    if (pathname === "/TIBNetBank/svc/rwd/login.html") return route.fulfill({ contentType: "text/html; charset=utf-8", body: LOGIN_FRAME });
    if (pathname === "/TIBNetBank/svc/web/shuffle/NonSessionShuffle") return route.fulfill({ contentType: "image/png", body: CAPTCHA });
    if (pathname === "/TIBNetBank/svc/web/login/login" && request.method() === "POST") {
      logins.push(JSON.parse(request.postData() ?? "null"));
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(loginMessage ? { message: loginMessage } : {}) });
    }
    return route.abort();
  });
  const workflowContext = {
    signal: new AbortController().signal,
    browser: { withPage: async (use: (page: Page) => Promise<unknown>) => use(page = await context.newPage()) },
  } as unknown as PreviewWorkflowContext;
  const reminderOpen = () => page!.frames().at(-1)!.evaluate(() => document.getElementById("popupLoginChangePwd")!.classList.contains("active"));
  try {
    return await run(workflowContext, { logins, reminderOpen });
  } finally {
    await context.close();
  }
}

const credentials = { idNumber: "A000000001", userCode: "user01", password: "secret-pass" };

test("the form driver reads the CAPTCHA bytes the page loaded, fills every field, submits once, and closes the password reminder", async () => {
  await withFixture(null, async (context, site) => {
    const outcome = await taishinBrowserSession(context, START_URL, async ({ form }) => {
      const challenge = await form.captcha();
      assert.deepEqual(challenge.image, CAPTCHA, "the NonSessionShuffle response bytes, unchanged");
      assert.equal(challenge.charset, "digits");
      assert.equal(challenge.expectedLength, 6, "the CAPTCHA input's maxlength");
      return form.submit(credentials, "123456");
    });
    assert.equal(outcome, null);
    assert.deepEqual(site.logins, [{ cid: "A000000001", uid: "user01", pwd: "secret-pass", code: "123456" }]);
    assert.equal(await site.reminderOpen(), false);
  });
});

test("a login message from the page is returned as the dialog text after one submission", async () => {
  await withFixture("圖形驗證碼錯誤，請重新輸入", async (context, site) => {
    const outcome = await taishinBrowserSession(context, START_URL, async ({ form }) => {
      await form.captcha();
      return form.submit(credentials, "654321");
    });
    assert.equal(outcome, "圖形驗證碼錯誤，請重新輸入");
    assert.equal(site.logins.length, 1);
  });
});
