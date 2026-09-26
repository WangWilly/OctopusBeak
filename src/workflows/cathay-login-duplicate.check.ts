import assert from "node:assert/strict";
import { chromium } from "playwright";
import { fillLoginForm } from "./cathay-statements.ts";

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(500);
  await page.route("https://www.cathaybk.com.tw/MyBank/", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `
        <input id="CustID" required>
        <input id="UserIdKeyin" required>
        <input id="PasswordKeyin" type="password" required>
        <button class="js-login" onclick="window.loginClicks++">登入</button>
        <div class="modal" style="display:none;position:fixed;inset:0;background:white;z-index:5">
          貼心提醒：可能已在其他瀏覽器或裝置上重複登入，抑或前次未正常登出。
          <button id="logout" onclick="window.logoutClicks++;document.querySelector('.modal').style.display='none';document.querySelector('.modal').classList.remove('show');document.querySelectorAll('input').forEach(i=>i.value='')">登出</button>
        </div>
        <script>
          window.loginClicks = 0;
          window.logoutClicks = 0;
          let shown = false;
          document.querySelector('#PasswordKeyin').addEventListener('input', () => {
            if (shown) return;
            shown = true;
            setTimeout(() => {
              const modal = document.querySelector('.modal');
              modal.style.display = 'block';
              modal.classList.add('show');
            }, 30);
          });
        </script>
      `,
    });
  });
  const events: string[] = [];
  await fillLoginForm(page, {
    cathay_user_id: "fixture-user",
    cathay_account: "fixture-account",
    cathay_password: "fixture-password",
  }, async (code) => { events.push(code); });
  assert.deepEqual(await page.evaluate(() => ({
    logoutClicks: (window as unknown as { logoutClicks: number }).logoutClicks,
    loginClicks: (window as unknown as { loginClicks: number }).loginClicks,
    fieldsPopulated: ["CustID", "UserIdKeyin", "PasswordKeyin"]
      .every((id) => Boolean((document.getElementById(id) as HTMLInputElement).value)),
  })), { logoutClicks: 1, loginClicks: 1, fieldsPopulated: true });
  assert.ok(events.includes("authentication-duplicate-session-cleared"));
} finally {
  await browser.close();
}
