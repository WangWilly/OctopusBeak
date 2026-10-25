import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import { recordedRun } from "./sign-in-check-harness.ts";
import { cathaySignInPlan, signInCathayForApp } from "./cathay-statements.ts";

const CREDENTIALS = {
  cathay_user_id: "fixture-user",
  cathay_account: "fixture-account",
  cathay_password: "fixture-password",
};
const COUNT = `const count = (key) => sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) ?? 0) + 1));`;

/** Serves `loginBody` as Cathay's entry page; its 登入 opens a signed-in page, and counts survive that navigation. */
async function signInPast(page: Page, loginBody: string): Promise<Readonly<{ loginClicks: string | null; closeClicks: string | null }>> {
  page.setDefaultTimeout(2_000);
  await page.route("https://www.cathaybk.com.tw/**", async (route) => {
    const signedIn = new URL(route.request().url()).pathname === "/OnlineBanking/Home";
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: signedIn
        ? `<a href="#">登出</a>`
        : `<input id="CustID" required>
          <input id="UserIdKeyin" required>
          <input id="PasswordKeyin" type="password" required>
          <button class="js-login" onclick="count('loginClicks'); location.href = '/OnlineBanking/Home'">登入</button>
          ${loginBody}
          <script>${COUNT}</script>`,
    });
  });
  const run = recordedRun(page, async () => assert.fail("Cathay has no Verification stage"));
  await signInCathayForApp(run.context, page, cathaySignInPlan(CREDENTIALS, run.context.event));
  return await page.evaluate(() => ({
    loginClicks: sessionStorage.getItem("loginClicks"),
    closeClicks: sessionStorage.getItem("closeClicks"),
  }));
}

const browser = await chromium.launch();
try {
  assert.deepEqual(
    await signInPast(await browser.newPage(), `
      <div class="modal fade show" style="display:block;position:fixed;inset:0;background:white;z-index:5">
        <section style="display:none"><h4>系統維護公告 (1/2)</h4></section>
        <section><h4>系統維護公告 (2/2)</h4></section>
        <button>下一則</button>
        <button type="button" class="close" data-dismiss="modal" aria-label="Close"
          onclick="count('closeClicks');const m=document.querySelector('.modal');m.classList.remove('show');m.style.display='none'"><span>&times;</span></button>
      </div>`),
    { loginClicks: "1", closeClicks: "1" },
    "a maintenance announcement whose first heading is hidden is closed before signing in",
  );

  assert.deepEqual(
    await signInPast(await browser.newPage(), `
      <div class="modal fade" style="display:none;position:fixed;inset:0;background:white;z-index:5">
        <h4>系統維護公告 (1/1)</h4>
        <button type="button" class="close" data-dismiss="modal" aria-label="Close"
          onclick="count('closeClicks');const m=document.querySelector('.modal');m.classList.remove('show');m.style.display='none'"><span>&times;</span></button>
      </div>
      <script>
        document.querySelector('#PasswordKeyin').addEventListener('input', () => setTimeout(() => {
          const m = document.querySelector('.modal'); m.style.display = 'block'; m.classList.add('show');
        }, 1_800));
      </script>`),
    { loginClicks: "1", closeClicks: "1" },
    "an announcement that appears after the fields are filled is closed before the sign-in click",
  );
} finally {
  await browser.close();
}
