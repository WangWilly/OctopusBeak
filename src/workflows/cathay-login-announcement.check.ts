import assert from "node:assert/strict";
import { chromium } from "playwright";
import { fillLoginForm } from "./cathay-statements.ts";

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(2_000);
  await page.route("https://www.cathaybk.com.tw/MyBank/", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `
        <input id="CustID" required>
        <input id="UserIdKeyin" required>
        <input id="PasswordKeyin" type="password" required>
        <button class="js-login" onclick="window.loginClicks++">登入</button>
        <div class="modal fade show" style="display:block;position:fixed;inset:0;background:white;z-index:5">
          <section style="display:none"><h4>系統維護公告 (1/2)</h4></section>
          <section><h4>系統維護公告 (2/2)</h4></section>
          <button>下一則</button>
          <button type="button" class="close" data-dismiss="modal" aria-label="Close"
            onclick="window.closeClicks++;const m=document.querySelector('.modal');m.classList.remove('show');m.style.display='none'"><span>&times;</span></button>
        </div>
        <script>window.loginClicks = 0; window.closeClicks = 0;</script>
      `,
    });
  });
  await fillLoginForm(page, {
    cathay_user_id: "fixture-user",
    cathay_account: "fixture-account",
    cathay_password: "fixture-password",
  });
  assert.deepEqual(
    await page.evaluate(() => ({
      loginClicks: (window as unknown as { loginClicks: number }).loginClicks,
      closeClicks: (window as unknown as { closeClicks: number }).closeClicks,
    })),
    { loginClicks: 1, closeClicks: 1 },
    "a maintenance announcement whose first heading is hidden is closed before signing in",
  );
} finally {
  await browser.close();
}

const lateBrowser = await chromium.launch();
try {
  const page = await lateBrowser.newPage();
  page.setDefaultTimeout(2_000);
  await page.route("https://www.cathaybk.com.tw/MyBank/", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `
        <input id="CustID" required>
        <input id="UserIdKeyin" required>
        <input id="PasswordKeyin" type="password" required>
        <button class="js-login" onclick="window.loginClicks++">登入</button>
        <div class="modal fade" style="display:none;position:fixed;inset:0;background:white;z-index:5">
          <h4>系統維護公告 (1/1)</h4>
          <button type="button" class="close" data-dismiss="modal" aria-label="Close"
            onclick="window.closeClicks++;const m=document.querySelector('.modal');m.classList.remove('show');m.style.display='none'"><span>&times;</span></button>
        </div>
        <script>
          window.loginClicks = 0; window.closeClicks = 0;
          document.querySelector('#PasswordKeyin').addEventListener('input', () => setTimeout(() => {
            const m = document.querySelector('.modal'); m.style.display = 'block'; m.classList.add('show');
          }, 1_800));
        </script>
      `,
    });
  });
  await fillLoginForm(page, {
    cathay_user_id: "fixture-user",
    cathay_account: "fixture-account",
    cathay_password: "fixture-password",
  });
  assert.deepEqual(
    await page.evaluate(() => ({
      loginClicks: (window as unknown as { loginClicks: number }).loginClicks,
      closeClicks: (window as unknown as { closeClicks: number }).closeClicks,
    })),
    { loginClicks: 1, closeClicks: 1 },
    "an announcement that appears after the fields are filled is closed before the sign-in click",
  );
} finally {
  await lateBrowser.close();
}
