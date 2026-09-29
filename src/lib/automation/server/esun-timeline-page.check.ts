import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { loadNextEsunTimelineResponse } from "../../../workflows/esun-credit-card-statements.ts";

test("E.SUN timeline still loads the next page when content grows after the first scroll", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    let requests = 0;
    await page.route("https://timeline.example/**", async (route) => {
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
            fetch('https://timeline.example/GW/creditLastYear/getFilterResult', {method: 'POST'});
          }
        });
      </script>
    `);
    const response = await loadNextEsunTimelineResponse(page, undefined, 1_000);
    assert.equal(response.status(), 200);
    assert.equal(requests, 1);
  } finally {
    await browser.close();
  }
});
