import assert from "node:assert/strict";
import test from "node:test";
import { launchCheckBrowser } from "../check-browser.fixtures.ts";
import { loadNextEsunTimelineResponse } from "../../../workflows/esun-credit-card-statements.ts";
import { frameScope } from "../../../workflows/frame-scope.ts";

const CANCELLED = new Error("synthetic cancellation");

test("E.SUN timeline still loads the next page when content grows after the first scroll", async () => {
  const browser = await launchCheckBrowser();
  try {
    const page = await browser.newPage();
    let requests = 0;
    await page.route("https://ebank.esunbank.com.tw/GW/**", async (route) => {
      requests += 1;
      await route.fulfill({ contentType: "application/json", body: "{}" });
    });
    await page.setContent(`
      <div class="timeline-query-continer" style="height:100px;overflow:auto">
        <div id="content" style="height:500px"></div>
      </div>
      <script>
        const container = document.querySelector('.timeline-query-continer');
        let growing = true;
        let requested = false;
        container.addEventListener('scroll', () => {
          if (growing) {
            growing = false;
            document.querySelector('#content').style.height = '800px';
            return;
          }
          if (!requested && container.scrollTop + container.clientHeight >= container.scrollHeight) {
            requested = true;
            fetch('https://ebank.esunbank.com.tw/GW/creditLastYear/getFilterResult', {method: 'POST'});
          }
        });
      </script>
    `);
    const response = await loadNextEsunTimelineResponse(frameScope(page, new AbortController().signal), 1_000);
    assert.equal(response.status(), 200);
    assert.equal(requests, 1);
  } finally {
    await browser.close();
  }
});

test("cancelling the run stops a timeline scroll still waiting for its container", async () => {
  const browser = await launchCheckBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent("<p>載入中</p>");
    const controller = new AbortController();
    setTimeout(() => controller.abort(CANCELLED), 300);
    const started = Date.now();
    await assert.rejects(
      loadNextEsunTimelineResponse(frameScope(page, controller.signal)),
      (error: unknown) => error === CANCELLED,
    );
    assert.ok(Date.now() - started < 2_000);

    await page.evaluate(() => {
      document.body.innerHTML = `
        <div class="timeline-query-continer" style="height:100px;overflow:auto">
          <div style="height:500px"></div>
        </div>`;
    });
    await page.waitForTimeout(500);
    const scrolled = await page.locator(".timeline-query-continer").evaluate((element) => element.scrollTop);
    assert.equal(scrolled, 0, "a scroll still pending after the abort would follow the bank's page after the run ended");
  } finally {
    await browser.close();
  }
});
