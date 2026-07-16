import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(new URL("../docs/prototypes/spending-chart-alternatives.html", import.meta.url).href);

  const prototype = page.locator('[data-prototype="brush-pan-zoom"]');
  assert.equal(await prototype.count(), 1);
  assert.equal(await prototype.getAttribute("data-mode"), "overview");
  assert.equal(await prototype.getAttribute("data-domain-start"), "0");
  assert.equal(await prototype.getAttribute("data-domain-end"), "29");

  const plot = prototype.locator("[data-plot]");
  const box = await plot.boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3 + 4, box.y + box.height * 0.5);
  await page.mouse.up();
  assert.equal(await plot.locator("[data-brush-overlay]").getAttribute("hidden"), "");
  assert.equal(await plot.evaluate(element => element.classList.contains("dragging")), false);

  await page.mouse.down();
  await plot.dispatchEvent("pointercancel");
  assert.equal(await plot.locator("[data-brush-overlay]").getAttribute("hidden"), "");
  assert.equal(await plot.evaluate(element => element.classList.contains("dragging")), false);
  await page.mouse.up();

  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5);
  await page.mouse.down();
  await plot.dispatchEvent("pointerup", {
    clientX: box.x + box.width * 0.82,
    clientY: box.y + box.height * 0.5,
    pointerId: 1
  });
  await page.mouse.up();
  assert.equal(await prototype.getAttribute("data-mode"), "detail");

  const brushedStart = await prototype.getAttribute("data-domain-start");
  await prototype.locator('[data-action="pan-left"]').click();
  assert.notEqual(await prototype.getAttribute("data-domain-start"), brushedStart);
  await prototype.locator('[data-action="reset"]').click();
  assert.equal(await prototype.getAttribute("data-domain-start"), "0");
  assert.equal(await prototype.getAttribute("data-domain-end"), "29");

  assert.match(await plot.getAttribute("aria-label"), /arrow.*pan.*plus.*minus.*zoom.*home.*reset/i);
  await plot.focus();
  await page.keyboard.press("Shift+=");
  const keyboardStart = await prototype.getAttribute("data-domain-start");
  await page.keyboard.press("ArrowLeft");
  assert.notEqual(await prototype.getAttribute("data-domain-start"), keyboardStart);
  await page.keyboard.press("ArrowRight");
  assert.equal(await prototype.getAttribute("data-domain-start"), keyboardStart);
  await page.keyboard.press("Shift+=");
  await page.keyboard.press("Shift+=");
  assert.equal(await prototype.getAttribute("data-mode"), "detail");
  const detailWidth = Number(await prototype.getAttribute("data-domain-end")) - Number(await prototype.getAttribute("data-domain-start")) + 1;
  await page.keyboard.press("-");
  const zoomedOutWidth = Number(await prototype.getAttribute("data-domain-end")) - Number(await prototype.getAttribute("data-domain-start")) + 1;
  assert.ok(zoomedOutWidth > detailWidth);
  await page.keyboard.press("Home");
  assert.equal(await prototype.getAttribute("data-domain-start"), "0");
  assert.equal(await prototype.getAttribute("data-domain-end"), "29");
  assert.equal(await prototype.getAttribute("data-mode"), "overview");
  assert.doesNotMatch(await page.locator("body").innerText(), /(?:6|12|24) months/i);
} finally {
  await browser.close();
}
