import assert from "node:assert/strict";
import { chromium } from "playwright";
import { registerCathayTrustedDevice } from "./cathay-device-registration.ts";

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.route("https://www.cathaybk.com.tw/**", async (route) => {
    const signedIn = new URL(route.request().url()).pathname === "/OnlineBanking/Home";
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: signedIn ? `<a href="#">登出</a>` : `
        <input id="CustID" required>
        <input id="UserIdKeyin" required>
        <input id="PasswordKeyin" type="password" required>
        <button class="js-login" onclick="signIn()">登入</button>
        <div class="modal" style="display:none;position:fixed;inset:0;background:white;z-index:5">
          貼心提醒：可能已在其他瀏覽器或裝置上重複登入，抑或前次未正常登出。
          <button id="logout" onclick="count('logoutClicks');document.querySelector('.modal').style.display='none';document.querySelector('.modal').classList.remove('show');document.querySelectorAll('input').forEach(i=>i.value='')">登出</button>
        </div>
        <script>
          const count = (key) => sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) ?? 0) + 1));
          function signIn() {
            count('loginClicks');
            const filled = ["CustID", "UserIdKeyin", "PasswordKeyin"].every((id) => Boolean(document.getElementById(id).value));
            sessionStorage.setItem('fieldsPopulated', String(filled));
            location.href = '/OnlineBanking/Home';
          }
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
  const result = await registerCathayTrustedDevice(page, {
    credentials: {
      cathay_user_id: "fixture-user",
      cathay_account: "fixture-account",
      cathay_password: "fixture-password",
    },
    readCode: async () => assert.fail("a trusted device needs no code"),
    signal: new AbortController().signal,
  });
  assert.deepEqual(result, { kind: "already-trusted" });
  assert.deepEqual(await page.evaluate(() => ({
    logoutClicks: sessionStorage.getItem("logoutClicks"),
    loginClicks: sessionStorage.getItem("loginClicks"),
    fieldsPopulated: sessionStorage.getItem("fieldsPopulated"),
  })), { logoutClicks: "1", loginClicks: "1", fieldsPopulated: "true" }, "registration logs the duplicate session out once, then signs in");
} finally {
  await browser.close();
}
