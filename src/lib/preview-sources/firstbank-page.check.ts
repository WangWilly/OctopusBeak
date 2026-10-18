import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { FIRSTBANK_LOGIN_URL, playwrightFirstbankPage } from "./firstbank-page.ts";
import { blankPng } from "./preview-source-harness.ts";
import type { PreviewWorkflowContext } from "./workflow.ts";

const ORIGIN = "https://ibank.firstbank.com.tw";
const CAPTCHA = blankPng(60, 25);
const LOGIN_BUTTON = blankPng(200, 40);
const OVERVIEW = '<table><tr class="ResultHeader"><th>帳號</th><th>幣別</th><th>帳面餘額</th></tr><tr class="ResultContent"><td>123-45-678901</td><td>新臺幣</td><td>1,000</td></tr></table>';
const HISTORY = '<html><body><table><tr class="ResultHeader"><th>交易日期</th><th>支出金額</th><th>存入金額</th></tr></table></body></html>';

type LoginAnswer = "ok" | "multi-session" | "message" | "takeover-confirm";

const LOGIN_PAGE = `<html><body>
  <input id="loginCustIdFake"><input id="usrIdInput"><input id="pwd" type="password">
  <input id="vrfyCode" maxlength="4"><img src="/NetBank/code_verify1.jpg" id="code_verify">
  <img id="captchaLoginArea" usemap="#loginMap" src="/NetBank/loadloginArea.html">
  <map name="loginMap"><area shape="rect" coords="0,0,0,0" href="#"></map>
  <div id="login-msg" style="display:none"><div class="pop-out-title">登入失敗</div><div class="pop-content"></div></div>
  <script>
    const area = document.getElementById("captchaLoginArea");
    const ready = () => { document.querySelector("map area").coords = "120,5,190,35"; };
    if (area.complete) ready(); else area.addEventListener("load", ready);
    document.querySelector("map area").addEventListener("click", async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(["loginCustIdFake", "usrIdInput", "pwd", "vrfyCode"].map((id) => [id, document.getElementById(id).value]));
      const response = await fetch("/NetBank/login.html", { method: "POST", body: JSON.stringify({ ...values, hitX: Math.round(event.clientX - area.getBoundingClientRect().left) }) });
      const { answer } = await response.json();
      if (answer === "ok") location.href = "/NetBank/frame.html";
      if (answer === "multi-session") document.body.innerText = "MULTI_SESSION_LOGIN 您已成功登入";
      if (answer === "message") {
        document.querySelector("#login-msg .pop-content").textContent = "使用者代號或密碼錯誤";
        document.getElementById("login-msg").style.display = "block";
      }
      if (answer === "takeover-confirm" && confirm("是否登出前次連線並繼續登入？")) await fetch("/NetBank/forceLogin.html", { method: "POST" });
    });
  </script>
</body></html>`;

const FRAMESET = `<html><body><script>window.logout = () => fetch("/NetBank/logout.html", { method: "POST" });</script>
  <iframe name="main" src="/NetBank/1/01.jsp"></iframe></body></html>`;

const OVERVIEW_PAGE = `<html><body><div id="btnOpen"><a href="#" onclick="load(); return false;">存款</a></div><div id="out"></div>
  <script>function load() { fetch("/NetBank/ajax/acntReview1.html", { method: "POST" }).then((r) => r.text()).then((t) => { document.getElementById("out").innerHTML = t; }); }</script>
</body></html>`;

const QUERY_PAGE = `<html><body><form action="/NetBank/2/010103.html" method="post">
  <select name="acnt"><option value="">請選擇帳號</option><option value="A1">123-45-678901 薪轉</option><option value="A2">123-45-999999</option></select>
  <input id="txnStart" name="txnStart"><input id="txnEnd" name="txnEnd">
  <input type="button" id="searchBtn" value="查詢" onclick="this.form.submit()">
</form></body></html>`;

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

type Site = { requests: string[]; logins: unknown[]; queries: string[] };

async function withFixture<T>(answer: LoginAnswer, run: (context: PreviewWorkflowContext, site: Site) => Promise<T>): Promise<T> {
  const context = await browser.newContext();
  const site: Site = { requests: [], logins: [], queries: [] };
  const html = (body: string, headers: Record<string, string> = {}) => ({ contentType: "text/html; charset=utf-8", body, headers });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const { origin, pathname } = new URL(request.url());
    if (origin !== ORIGIN) return route.abort();
    site.requests.push(`${request.method()} ${pathname}`);
    switch (pathname) {
      case "/NetBank/index103.html": return route.fulfill(html(LOGIN_PAGE));
      case "/NetBank/code_verify1.jpg": return route.fulfill({ contentType: "image/png", body: CAPTCHA });
      case "/NetBank/loadloginArea.html": return route.fulfill({ contentType: "image/png", body: LOGIN_BUTTON });
      case "/NetBank/login.html":
        site.logins.push(JSON.parse(request.postData() ?? "null"));
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ answer }) });
      case "/NetBank/frame.html": return route.fulfill(html(FRAMESET));
      case "/NetBank/1/01.jsp": return route.fulfill(html('<html><body><div id="tFunc">首頁</div></body></html>'));
      case "/NetBank/1/acntReviewAll.html": return route.fulfill(html(OVERVIEW_PAGE));
      case "/NetBank/ajax/acntReview1.html": return route.fulfill(html(OVERVIEW, { date: "Thu, 15 Oct 2026 01:59:00 GMT" }));
      case "/NetBank/2/0101.html": return route.fulfill(html(QUERY_PAGE));
      case "/NetBank/2/010103.html":
        site.queries.push(request.postData() ?? "");
        return route.fulfill(html(HISTORY));
      case "/NetBank/logout.html":
      case "/NetBank/forceLogin.html":
        return route.fulfill(html(""));
      default: return route.abort();
    }
  });
  const workflowContext = {
    signal: new AbortController().signal,
    browser: { withPage: async (use: (page: Page) => Promise<unknown>) => use(await context.newPage()) },
  } as unknown as PreviewWorkflowContext;
  try {
    return await run(workflowContext, site);
  } finally {
    await context.close();
  }
}

const credentials = { idNumber: "A000000001", userCode: "user01", password: "secret-pass", captcha: "1234" };

test("the page driver signs in through the image-map button, captures the overview and history responses, and logs out", async () => {
  await withFixture("ok", async (context, site) => {
    await playwrightFirstbankPage(context, FIRSTBANK_LOGIN_URL, async (page) => {
      assert.deepEqual(await page.captchaImage(), CAPTCHA, "the code_verify1.jpg response bytes, already PNG");
      assert.deepEqual(await page.signIn(credentials), { kind: "signed-in" });
      const overview = await page.depositOverview();
      assert.deepEqual(overview, { endpoint: "/NetBank/ajax/acntReview1.html", status: 200, date: "Thu, 15 Oct 2026 01:59:00 GMT", text: OVERVIEW });
      const accounts = await page.queryAccounts();
      assert.deepEqual(accounts, [{ value: "A1", label: "123-45-678901 薪轉" }, { value: "A2", label: "123-45-999999" }], "the placeholder option is dropped");
      const history = await page.transactions(accounts[1]!, { start: "2026/08/01", end: "2026/10/15" });
      assert.equal(history.endpoint, "/NetBank/2/010103.html");
      assert.equal(history.text, HISTORY);
      await page.signOut();
    });
    assert.deepEqual(site.logins, [{ loginCustIdFake: "A000000001", usrIdInput: "user01", pwd: "secret-pass", vrfyCode: "1234", hitX: 155 }], "one click at the centre of the login area");
    assert.deepEqual(site.queries, ["acnt=A2&txnStart=2026%2F08%2F01&txnEnd=2026%2F10%2F15"]);
    assert.ok(site.requests.includes("POST /NetBank/logout.html"), "the frameset's own logout() ran");
  });
});

test("a MULTI_SESSION_LOGIN page, a login popup, and a takeover confirm each end sign-in without a takeover", async () => {
  const cases: Record<Exclude<LoginAnswer, "ok">, string> = {
    "multi-session": "MULTI_SESSION_LOGIN",
    message: "使用者代號或密碼錯誤",
    "takeover-confirm": "是否登出前次連線並繼續登入？",
  };
  for (const [answer, message] of Object.entries(cases) as [Exclude<LoginAnswer, "ok">, string][]) {
    await withFixture(answer, async (context, site) => {
      const outcome = await playwrightFirstbankPage(context, FIRSTBANK_LOGIN_URL, async (page) => {
        await page.captchaImage();
        return page.signIn(credentials);
      });
      assert.deepEqual(outcome, { kind: "refused", message }, answer);
      assert.equal(site.logins.length, 1, `${answer} submits once`);
      assert.ok(!site.requests.includes("POST /NetBank/forceLogin.html"), `${answer} never confirms a takeover`);
    });
  }
});
