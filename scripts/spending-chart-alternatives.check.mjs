import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
await server.listen();
await server.watcher.close();
const address = server.httpServer?.address();
assert.ok(address && typeof address === "object");
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`http://127.0.0.1:${address.port}/spending-chart-study`);
  await page.locator("[data-study]").first().waitFor();

  assert.equal(await page.locator("[data-study]").count(), 3);
  for (const id of ["brush", "pan-zoom", "brush-pan-zoom"]) {
    assert.ok(await page.locator(`[data-study="${id}"] svg.lc-layout-svg`).count() > 0);
  }

  const brush = page.locator('[data-study="brush"] .lc-brush-context');
  await brush.scrollIntoViewIfNeeded();
  const brushBox = await brush.boundingBox();
  assert.ok(brushBox);
  await page.mouse.move(brushBox.x + brushBox.width * 0.2, brushBox.y + brushBox.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(brushBox.x + brushBox.width * 0.5, brushBox.y + brushBox.height * 0.5);
  await page.mouse.up();
  await page.locator('[data-study="brush"] .lc-brush-range').waitFor();
  assert.equal(await page.locator('[data-study="brush"] .lc-brush-range').count(), 1);

  const panZoom = page.locator('[data-study="pan-zoom"] [data-interaction="pan-zoom"]');
  await panZoom.locator('[data-action="zoom-in"]').click();
  await page.waitForFunction(() => Number(
    document.querySelector('[data-study="pan-zoom"] [data-interaction="pan-zoom"]')
      ?.getAttribute("data-transform-scale"),
  ) > 1);
  assert.ok(Number(await panZoom.getAttribute("data-transform-scale")) > 1);

  const combined = page.locator('[data-study="brush-pan-zoom"] .lc-brush-context');
  await combined.scrollIntoViewIfNeeded();
  const combinedBox = await combined.boundingBox();
  assert.ok(combinedBox);
  await page.mouse.move(combinedBox.x + combinedBox.width * 0.2, combinedBox.y + combinedBox.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(combinedBox.x + combinedBox.width * 0.55, combinedBox.y + combinedBox.height * 0.5);
  await page.mouse.up();
  const combinedChart = page.locator('[data-study="brush-pan-zoom"] [data-interaction="brush-pan-zoom"]');
  await page.waitForFunction(() => Number(
    document.querySelector('[data-study="brush-pan-zoom"] [data-interaction="brush-pan-zoom"]')
      ?.getAttribute("data-transform-scale"),
  ) > 1);
  assert.ok(Number(await combinedChart.getAttribute("data-transform-scale")) > 1);
  await combinedChart.locator('[data-action="reset"]').click();
  await page.waitForFunction(() => Number(
    document.querySelector('[data-study="brush-pan-zoom"] [data-interaction="brush-pan-zoom"]')
      ?.getAttribute("data-transform-scale"),
  ) === 1);
  assert.equal(Number(await combinedChart.getAttribute("data-transform-scale")), 1);
} finally {
  await browser.close();
  await server.close();
}
