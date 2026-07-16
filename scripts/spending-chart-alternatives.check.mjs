import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(new URL("../docs/prototypes/spending-chart-alternatives.html", import.meta.url).href);

  assert.equal(await page.locator("[data-concept]").count(), 3);
  assert.doesNotMatch(await page.locator("body").innerText(), /(?:6|12|24) months/i);

  const overview = page.locator('[data-concept="overview"]');
  const beforeMonth = await overview.getAttribute("data-selected-month");
  await overview.locator("[data-month]").nth(2).click();
  assert.notEqual(await overview.getAttribute("data-selected-month"), beforeMonth);

  const timeline = page.locator('[data-concept="timeline"]');
  const beforeScroll = await timeline.getAttribute("data-scroll-index");
  await timeline.locator('[data-action="next"]').click();
  assert.notEqual(await timeline.getAttribute("data-scroll-index"), beforeScroll);

  const focus = page.locator('[data-concept="focus-context"]');
  const beforeWindow = await focus.getAttribute("data-window-start");
  await focus.locator('[data-action="window-next"]').click();
  assert.notEqual(await focus.getAttribute("data-window-start"), beforeWindow);
} finally {
  await browser.close();
}
