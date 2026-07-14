import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { acceptDuplicateLoginIfPresent } from "./esun-credit-card-statements.ts";

test("accepts a duplicate-login dialog that appears after submit", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<iframe name="iframe1"></iframe>');
    const frame = page.frame({ name: "iframe1" });
    assert(frame);
    await frame.setContent(`
      <script>
        setTimeout(() => {
          const dialog = document.createElement("div");
          dialog.className = "ui-dialog";
          dialog.innerHTML = '<button onclick="window.accepted = true">確定登入</button>';
          document.body.append(dialog);
        }, 50);
      </script>
    `);

    await acceptDuplicateLoginIfPresent(frame);
    await page.waitForTimeout(100);

    assert.equal(
      await frame.evaluate(
        () =>
          (window as typeof window & { accepted?: boolean }).accepted === true,
      ),
      true,
    );
  } finally {
    await browser.close();
  }
});
