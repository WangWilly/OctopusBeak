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

const FRAMESET = `<html><body><script>
  window.logout = () => fetch("/NetBank/logout.html", { method: "POST" });
  window.getMenuObjById = () => null;
</script><iframe name="main" src="/NetBank/1/01.jsp"></iframe></body></html>`;

// The card member system's host is synthetic: the driver accepts card paths from any First Bank host.
const CARD_ORIGIN = "https://card.firstbank.com.tw";
type CardMode = "cards" | "no-bill-dates" | "member-logout" | "no-card-notice" | "no-card-dialog";

const cardHomePage = (mode: CardMode) => mode === "no-card-notice"
  ? '<html><body><div id="tFunc">首頁</div><div id="alertMsgContent">您目前沒有本行信用卡</div></body></html>'
  : `<html><body><div id="tFunc">首頁</div><div style="display:none">
    <a data-func="F1632" href="#" onclick="${mode === "no-card-dialog" ? "alert('您目前沒有本行信用卡')" : `location.href='${CARD_ORIGIN}/cmsweb/Detail/BillingQuery'`}; return false;">帳單查詢</a>
    <a data-func="F1633" href="#" onclick="location.href='${CARD_ORIGIN}/cmsweb/Detail/Payment'; return false;">近期繳款</a>
    <a data-func="F1634" href="#" onclick="location.href='${CARD_ORIGIN}/cmsweb/Detail/Unbilled'; return false;">未出帳消費</a>
  </div></body></html>`;

const cardQueryPage = (...codes: readonly string[]) => `<html><body><script>(async () => {
  for (const code of ${JSON.stringify(codes)}) await fetch("/cmsweb/Common/sendCMSQRY" + code, { method: "POST" });
})();</script></body></html>`;

const cms = (code: string, content: unknown) => JSON.stringify({ HEAD: { MSGID: `CMSQRY${code}`, RETURNCODE: "0000" }, CONTENT: content });

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

async function withFixture<T>(answer: LoginAnswer, run: (context: PreviewWorkflowContext, site: Site) => Promise<T>, cards: CardMode = "cards"): Promise<T> {
  const context = await browser.newContext();
  const site: Site = { requests: [], logins: [], queries: [] };
  const html = (body: string, headers: Record<string, string> = {}) => ({ contentType: "text/html; charset=utf-8", body, headers });
  const json = (body: string) => ({ contentType: "application/json", body });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const { origin, pathname } = new URL(request.url());
    if (origin === CARD_ORIGIN) {
      site.requests.push(`${request.method()} card${pathname}`);
      switch (pathname) {
        case "/cmsweb/Detail/BillingQuery":
          return route.fulfill(html(cards === "member-logout" ? '<script>location.href = "/cmsweb/Home/Logout";</script>' : cardQueryPage("9999", ...(cards === "no-bill-dates" ? [] : ["0014"]))));
        case "/cmsweb/Detail/Payment": return route.fulfill(html(cardQueryPage("0006", "0006")));
        case "/cmsweb/Detail/Unbilled": return route.fulfill(html(cardQueryPage("0008")));
        case "/cmsweb/Home/Logout": return route.fulfill(html("<html><body>您已登出信用卡會員服務系統</body></html>"));
        case "/cmsweb/Common/sendCMSQRY9999": return route.fulfill(json(cms("9999", cards === "no-bill-dates" ? { ResultCount: "0", Result: "" } : { ResultCount: "1", Result: "2026/09/07" })));
        case "/cmsweb/Common/sendCMSQRY0014": return route.fulfill(json(cms("0014", { BillRecords: [] })));
        case "/cmsweb/Common/sendCMSQRY0006": return route.fulfill(json(cms("0006", { Records: [] })));
        case "/cmsweb/Common/sendCMSQRY0008": return route.fulfill(json(cms("0008", { Records: [] })));
        default: return route.abort();
      }
    }
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
      case "/NetBank/1/01.jsp": return route.fulfill(html(cardHomePage(cards)));
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
      const cards = await page.cardPages();
      assert.deepEqual(cards.captures.map(({ endpoint, status }) => [endpoint, status]), [
        ["/cmsweb/Common/sendCMSQRY9999", 200], ["/cmsweb/Common/sendCMSQRY0014", 200],
        ["/cmsweb/Common/sendCMSQRY0006", 200], ["/cmsweb/Common/sendCMSQRY0006", 200], ["/cmsweb/Common/sendCMSQRY0008", 200],
      ], "each card function's responses, from the card host, after the deposit pages in the same session");
      assert.equal(cards.captures[1]!.text, cms("0014", { BillRecords: [] }));
      assert.equal(cards.notice, null);
      await page.signOut();
    });
    assert.deepEqual(site.requests.filter((request) => request.startsWith("GET card/cmsweb/Detail")), [
      "GET card/cmsweb/Detail/BillingQuery", "GET card/cmsweb/Detail/Payment", "GET card/cmsweb/Detail/Unbilled",
    ], "each card link is clicked once, through the service overview's own handlers");
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

test("the card pages stop at an empty bill-date list, the card member logout, or a no-card message", async () => {
  const cases: Record<Exclude<CardMode, "cards">, readonly [readonly string[], string | null]> = {
    "no-bill-dates": [["/cmsweb/Common/sendCMSQRY9999", "/cmsweb/Common/sendCMSQRY0006", "/cmsweb/Common/sendCMSQRY0006", "/cmsweb/Common/sendCMSQRY0008"], null],
    "member-logout": [["/cmsweb/Home/Logout"], null],
    "no-card-notice": [[], "您目前沒有本行信用卡"],
    "no-card-dialog": [[], "您目前沒有本行信用卡"],
  };
  for (const [mode, [endpoints, notice]] of Object.entries(cases) as [Exclude<CardMode, "cards">, readonly [readonly string[], string | null]][]) {
    await withFixture("ok", async (context, site) => {
      const cards = await playwrightFirstbankPage(context, FIRSTBANK_LOGIN_URL, async (page) => {
        await page.captchaImage();
        await page.signIn(credentials);
        return page.cardPages();
      });
      assert.deepEqual(cards.captures.map((capture) => capture.endpoint), endpoints, mode);
      assert.equal(cards.notice, notice, mode);
      if (mode !== "no-bill-dates")
        assert.ok(!site.requests.some((request) => /Detail\/(?:Payment|Unbilled)/u.test(request)), `${mode} opens no further card function`);
    }, mode);
  }
});
